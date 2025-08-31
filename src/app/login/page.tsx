// app/login/page.tsx
"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
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
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { useToast } from "@/hooks/use-toast";

import { auth } from "@/firebase";
import { signInWithEmailAndPassword } from "firebase/auth";
import { useState } from "react";
import { normalizeRole, Role } from "@/lib/roles";

const loginSchema = z.object({
  email: z.string().email({ message: "Please enter a valid email address." }),
  password: z.string().min(1, { message: "Password is required." }),
});

function safeNext(n: string | null | undefined, role: Role) {
  if (n && n.startsWith("/")) return n; // same-site only
  return role === "emergency_contact" ? "/emergency-dashboard" : "/dashboard";
}

export default function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const role: Role = normalizeRole(params.get("role")) ?? "main_user";
  const token = params.get("token") || ""; // optional invite token
  const next = safeNext(params.get("next"), role);

  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const setSessionCookie = async () => {
    const u = auth.currentUser;
    if (!u) return;
    const idToken = await u.getIdToken(true);
    const res = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ idToken }),
    });
    if (!res.ok) throw new Error("Failed to set session");
  };

  const maybeAutoAcceptInvite = async () => {
    if (role !== "emergency_contact" || !token) return;
    try {
      await fetch("/api/emergency_contact/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token }),
      });
    } catch {
      // non-fatal: they can still accept from verify-email or accept page
    }
  };

  const onSubmit = async (values: z.infer<typeof loginSchema>) => {
    try {
      setIsSubmitting(true);

      const { user } = await signInWithEmailAndPassword(
        auth,
        values.email.trim().toLowerCase(),
        values.password
      );

      // 🔐 Mint server session cookie so API routes are authorized
      await setSessionCookie();

      // Optional: if they arrived with an invite token, accept it now
      await maybeAutoAcceptInvite();

      toast({
        title: "Login Successful",
        description: `Welcome back, ${user.email ?? "user"}!`,
      });

      router.replace(next);
    } catch (err: any) {
      const code = err?.code as string | undefined;
      let message = "Something went wrong. Please try again.";
      if (code === "auth/invalid-email") message = "Invalid email address.";
      else if (code === "auth/user-not-found" || code === "auth/wrong-password")
        message = "Incorrect email or password.";
      else if (code === "auth/too-many-requests")
        message = "Too many attempts. Please wait and try again.";
      toast({ title: "Login failed", description: message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <Header />
      <main className="flex-grow flex items-center justify-center p-4">
        <Card className="w-full max-w-md shadow-xl">
          <CardHeader className="text-center">
            <CardTitle className="text-3xl font-headline">Welcome Back!</CardTitle>
            <CardDescription>
              {role === "emergency_contact"
                ? "Sign in as an emergency contact"
                : "Sign in to continue to LifeSignal AI"}
            </CardDescription>
          </CardHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)}>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input
                          type="email"
                          placeholder="your@email.com"
                          {...field}
                          disabled={isSubmitting}
                        />
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
                        <Input
                          type="password"
                          placeholder="••••••••"
                          {...field}
                          disabled={isSubmitting}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
              <CardFooter className="flex flex-col gap-4">
                <Button type="submit" className="w-full text-lg py-6" disabled={isSubmitting}>
                  {isSubmitting ? "Signing in..." : "Sign In"}
                </Button>
                <p className="text-center text-sm text-muted-foreground">
                  New to LifeSignal?{" "}
                  <Link
                    href={`/signup?role=${encodeURIComponent(role)}&next=${encodeURIComponent(
                      next
                    )}${token ? `&token=${encodeURIComponent(token)}` : ""}`}
                    className="font-semibold text-primary hover:underline"
                  >
                    Create an account
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
