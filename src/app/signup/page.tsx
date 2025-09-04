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

import { normalizeRole, Role } from "@/lib/roles";

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

  // Role + optional invite token
  const role: Role = normalizeRole(params.get("role")) ?? "main_user";
  const token = params.get("token") || null;

  // Sanitize "next": allow same-site paths only; treat "/" as unset
  const rawNext = params.get("next");
  const next = useMemo(() => {
    const n = rawNext && rawNext.startsWith("/") ? rawNext : "";
    return n === "/" ? "" : n;
  }, [rawNext]);

  // Base origin for action code settings
  const appOrigin =
    typeof window === "undefined"
      ? process.env.NEXT_PUBLIC_APP_ORIGIN || ""
      : window.location.origin;

  // Continue URL for email verification; include role/fromHosted and only meaningful params
  const continueUrl = useMemo(() => {
    const q = new URLSearchParams({
      role,
      fromHosted: "1",
      ...(next ? { next } : {}),
      ...(token ? { token } : {}),
    }).toString();
    return `${appOrigin}/verify-email?${q}`;
  }, [appOrigin, role, next, token]);

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

      // 2) Set display name
      await updateProfile(cred.user, { displayName: values.name });

      // 3) Create/merge Firestore profile with canonical role
      await setDoc(
        doc(db, "users", cred.user.uid),
        {
          uid: cred.user.uid,
          name: values.name,
          email: (cred.user.email || "").toLowerCase(),
          role, // 'main_user' | 'emergency_contact'
          createdAt: serverTimestamp(),
        },
        { merge: true }
      );

      // 4) Send verification email (hosted flow returns to /verify-email)
      try {
        await sendEmailVerification(cred.user, {
          url: continueUrl,
          handleCodeInApp: true,
        });
      } catch (e) {
        console.warn("sendEmailVerification failed:", e);
      }

      // 5) Route to verify-email; include next/token only when present
      router.push(
        `/verify-email?email=${encodeURIComponent(values.email)}&role=${encodeURIComponent(role)}${
          next ? `&next=${encodeURIComponent(next)}` : ""
        }${token ? `&token=${encodeURIComponent(token)}` : ""}`
      );
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
              {role === "emergency_contact"
                ? "You’re signing up as an emergency contact."
                : "Create your main user account."}
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
                    href={`/login?role=${encodeURIComponent(role)}${
                      next ? `&next=${encodeURIComponent(next)}` : ""
                    }${token ? `&token=${encodeURIComponent(token)}` : ""}`}
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
