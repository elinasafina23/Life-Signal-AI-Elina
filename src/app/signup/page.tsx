// app/signup/page.tsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";

import { auth, db } from "@/firebase";
import {
  createUserWithEmailAndPassword,
  updateProfile,
  sendEmailVerification,
} from "firebase/auth";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";

const passwordValidation = z
  .string()
  .min(8, { message: "Password must be at least 8 characters long." })
  .regex(/[a-z]/, { message: "Password must contain at least one lowercase letter." })
  .regex(/[A-Z]/, { message: "Password must contain at least one uppercase letter." })
  .regex(/[0-9]/, { message: "Password must contain at least one number." })
  .regex(/[^a-zA-Z0-9]/, { message: "Password must contain at least one special character." });

const signupSchema = z
  .object({
    name: z.string().min(2, { message: "Name must be at least 2 characters." }),
    email: z.string().email({ message: "Please enter a valid email." }),
    password: passwordValidation,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export default function SignupPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { toast } = useToast();

  // Role + return location
  const role = (params.get("role") || "user").toLowerCase(); // "caregiver" | "user"
  const rawNext = params.get("next") || "/";

  // Sanitize "next" to avoid open redirects (allow only same-site relative paths)
  const next = useMemo(() => (rawNext.startsWith("/") ? rawNext : "/"), [rawNext]);

  // Continue URL for email verification to return to your app
  const continueUrl = useMemo(() => {
    const base = typeof window === "undefined" ? "" : window.location.origin;
    return `${base}/verify-email?role=${encodeURIComponent(role)}`;
  }, [role]);

  const [passwordStrength, setPasswordStrength] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<z.infer<typeof signupSchema>>({
    resolver: zodResolver(signupSchema),
    defaultValues: { name: "", email: "", password: "", confirmPassword: "" },
  });

  const calculatePasswordStrength = (password: string) => {
    let score = 0;
    if (password.length >= 8) score++;
    if (/[a-z]/.test(password)) score++;
    if (/[A-Z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[^a-zA-Z0-9]/.test(password)) score++;
    return (score / 5) * 100;
  };

  const password = form.watch("password");
  useEffect(() => setPasswordStrength(calculatePasswordStrength(password)), [password]);

  const onSubmit = async (values: z.infer<typeof signupSchema>) => {
    try {
      setIsSubmitting(true);

      // 1) Create auth user
      const cred = await createUserWithEmailAndPassword(
        auth,
        values.email.trim().toLowerCase(),
        values.password
      );

      // 2) Set display name (optional)
      await updateProfile(cred.user, { displayName: values.name });

      // 3) Create/merge Firestore profile and store the role
      await setDoc(
        doc(db, "users", cred.user.uid),
        {
          uid: cred.user.uid,
          name: values.name,
          email: (cred.user.email || "").toLowerCase(),
          role, // persist role for routing/authorization later
          createdAt: serverTimestamp(),
        },
        { merge: true }
      );

      // 4) Send verification email with a return URL back to your app
      try {
        await sendEmailVerification(cred.user, {
          url: continueUrl, // brings them back to /verify-email after clicking
          handleCodeInApp: true,
        });
      } catch {
        // Ignore failures; user can resend from /verify-email later
      }

      // 5) Post-signup routing
      if (role === "caregiver") {
        // IMPORTANT: if the caregiver came from an invite accept link,
        // we must send them BACK to that page so it can create the link doc.
        // We honor ?next=... when present (e.g., /caregiver/accept?invite=...&token=...)
        router.replace(next || "/emergency-dashboard");
      } else {
        // Main users: take them to verify flow (it will redirect to /dashboard after verification)
        router.push(
          `/verify-email?email=${encodeURIComponent(values.email)}&role=user&next=${encodeURIComponent(
            next || "/"
          )}`
        );
      }
    } catch (err: any) {
      console.error(err);
      const code = err?.code as string | undefined;
      let message = "Something went wrong. Please try again.";
      if (code === "auth/email-already-in-use") message = "That email is already registered.";
      else if (code === "auth/invalid-email") message = "Invalid email address.";
      else if (code === "auth/weak-password") message = "Password is too weak.";
      toast({ title: "Signup failed", description: message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <Header />
      <main className="flex-grow flex items-center justify-center p-4">
        <Card className="w-full max-w-lg shadow-xl">
          <CardHeader className="text-center">
            <CardTitle className="text-3xl font-headline">Create Your Account</CardTitle>
            <CardDescription>
              {role === "caregiver"
                ? "You’re signing up as a caregiver."
                : "Join LifeSignal AI to stay safe and connected."}
            </CardDescription>
          </CardHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)}>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Full Name</FormLabel>
                      <FormControl>
                        <Input placeholder="John Doe" {...field} disabled={isSubmitting} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email Address</FormLabel>
                      <FormControl>
                        <Input type="email" placeholder="you@example.com" {...field} disabled={isSubmitting} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Password</FormLabel>
                      <FormControl>
                        <Input type="password" placeholder="••••••••" {...field} disabled={isSubmitting} />
                      </FormControl>
                      {password && <Progress value={passwordStrength} className="mt-2 h-2" />}
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="confirmPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Confirm Password</FormLabel>
                      <FormControl>
                        <Input type="password" placeholder="••••••••" {...field} disabled={isSubmitting} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>

              <CardFooter className="flex-col gap-4">
                <Button type="submit" className="w-full text-lg py-6" disabled={isSubmitting}>
                  {isSubmitting ? "Creating…" : "Create Account"}
                </Button>

                <p className="text-center text-sm text-muted-foreground">
                  Already have an account?{" "}
                  <Link
                    href={`/login?role=${encodeURIComponent(role)}&next=${encodeURIComponent(next)}`}
                    className="font-semibold text-primary hover:underline"
                  >
                    Sign In
                  </Link>
                </p>
              </CardFooter>
            </form>
          </Form>
        </Card>
      </main>
      <Footer />
    </div>
  );
}
