// app/signup/page.tsx
"use client"; // Marks this as a Next.js Client Component (required for hooks & browser APIs)

import React, { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod"; // Zod for schema validation

// Shared layout components
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";

// UI components (from your shadcn/ui library)
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
import { useToast } from "@/hooks/use-toast"; // Custom toast hook

// Firebase imports
import { auth, db } from "@/firebase";
import {
  createUserWithEmailAndPassword,
  updateProfile,
  sendEmailVerification,
} from "firebase/auth";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";

// Helpers for roles and phone formatting
import { normalizeRole, type Role } from "@/lib/roles";
import { isValidE164Phone, sanitizePhone } from "@/lib/phone";

/* -------------------------------------------------------------------------- */
/*                                PASSWORD RULES                              */
/* -------------------------------------------------------------------------- */
// Define password strength & composition policy
const passwordValidation = z
  .string()
  .min(8, { message: "Password must be at least 8 characters long." })
  .regex(/[a-z]/, { message: "Password must contain at least one lowercase letter." })
  .regex(/[A-Z]/, { message: "Password must contain at least one uppercase letter." })
  .regex(/[0-9]/, { message: "Password must contain at least one number." })
  .regex(/[^a-zA-Z0-9]/, { message: "Password must contain at least one special character." });

/* -------------------------------------------------------------------------- */
/*                                SIGNUP SCHEMA                               */
/* -------------------------------------------------------------------------- */
// Defines and validates all signup fields using Zod
const signupSchema = z
  .object({
    firstName: z.string().min(2, { message: "First name must be at least 2 characters." }),
    lastName: z.string().min(2, { message: "Last name must be at least 2 characters." }),
    email: z.string().email({ message: "Please enter a valid email." }),
    // Preprocess phone number to sanitize before validating (must include +country code)
    phone: z.preprocess(
      (v) => (typeof v === "string" ? sanitizePhone(v) : v),
      z
        .string()
        .min(1, { message: "Phone number is required." })
        .refine((value) => isValidE164Phone(value), {
          message: "Enter a valid phone number including country code, e.g. +15551234567.",
        })
    ),
    password: passwordValidation, // Apply password policy
    confirmPassword: z.string(), // For password confirmation
  })
  // Cross-field validation: password === confirmPassword
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

/* -------------------------------------------------------------------------- */
/*                              HELPER FUNCTIONS                              */
/* -------------------------------------------------------------------------- */
// Fire-and-forget session cookie so API calls can use auth without reload
async function setSessionCookieFast() {
  const u = auth.currentUser;
  if (!u) return;
  const idToken = await u.getIdToken(true); // Refresh token
  fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ idToken }),
    keepalive: true, // Keeps running even if user leaves the page
  }).catch(() => {});
}

// If sign-up was triggered by an invite token, auto-accept in the background
async function maybeAutoAcceptInvite(token: string | null) {
  if (!token) return;
  fetch("/api/emergency_contact/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ token }),
    keepalive: true,
  }).catch(() => {});
}

/* -------------------------------------------------------------------------- */
/*                                 COMPONENTS                                 */
/* -------------------------------------------------------------------------- */
// Wrapper with suspense to handle Next.js searchParams streaming
export default function SignupPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <SignupPageContent />
    </Suspense>
  );
}

// Main Signup Component
function SignupPageContent() {
  const router = useRouter(); // Next.js navigation
  const params = useSearchParams(); // URL params
  const { toast } = useToast(); // Toast handler

  // Extract & normalize role from query (default to "main_user")
  const role: Role = normalizeRole(params.get("role")) ?? "main_user";
  const token = params.get("token") || null; // Optional invite token

  // "next" param (used for redirect after login)
  const rawNext = params.get("next");
  const next = useMemo(() => {
    const n = rawNext && rawNext.startsWith("/") ? rawNext : "";
    return n === "/" ? "" : n; // Clean "/" → ""
  }, [rawNext]);

  // Get origin for building verify URL
  const origin =
    typeof window !== "undefined"
      ? window.location.origin
      : process.env.NEXT_PUBLIC_APP_ORIGIN || "";

  // Build continueUrl for Firebase email verification link
  const continueUrl = useMemo(() => {
    const q = new URLSearchParams({
      role,
      fromHosted: "1",
      ...(next ? { next } : {}),
      ...(token ? { token } : {}),
    }).toString();
    return `${origin}/verify-email?${q}`;
  }, [origin, role, next, token]);

  // Local state for password meter & loading spinner
  const [passwordStrength, setPasswordStrength] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // React Hook Form setup with Zod validation
  const form = useForm<z.infer<typeof signupSchema>>({
    resolver: zodResolver(signupSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
      password: "",
      confirmPassword: "",
    },
  });

  // Password strength calculator (0–100%)
  const calculatePasswordStrength = (password: string) => {
    let score = 0;
    if (password.length >= 8) score++;
    if (/[a-z]/.test(password)) score++;
    if (/[A-Z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[^a-zA-Z0-9]/.test(password)) score++;
    return (score / 5) * 100;
  };

  // Update strength meter live
  const watchedPassword = form.watch("password");
  useEffect(() => setPasswordStrength(calculatePasswordStrength(watchedPassword)), [watchedPassword]);

  /* ---------------------------------------------------------------------- */
  /*                               SUBMIT LOGIC                             */
  /* ---------------------------------------------------------------------- */
  const onSubmit = async (values: z.infer<typeof signupSchema>) => {
    try {
      setIsSubmitting(true);

      const sanitizedPhone = sanitizePhone(values.phone); // Normalize phone

      // 1️⃣ Create Firebase Auth user
      const cred = await createUserWithEmailAndPassword(
        auth,
        values.email.trim().toLowerCase(),
        values.password
      );

      // 2️⃣ Update displayName ("First Last")
      const displayName = [values.firstName.trim(), values.lastName.trim()]
        .filter(Boolean)
        .join(" ");
      await updateProfile(cred.user, { displayName });

      // 3️⃣ Save profile to Firestore
      await setDoc(
        doc(db, "users", cred.user.uid),
        {
          mainUserUid: cred.user.uid,
          firstName: values.firstName.trim(),
          lastName: values.lastName.trim(),
          role,
          email: cred.user.email ?? values.email.trim().toLowerCase(),
          phone: sanitizedPhone,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      // 4️⃣ Send verification email (Firebase-hosted link)
      try {
        await sendEmailVerification(cred.user, {
          url: continueUrl,
          handleCodeInApp: true,
        });
      } catch (e) {
        console.warn("sendEmailVerification failed:", e);
      }

      // 5️⃣ Background: set cookie, handle invite (non-blocking)
      void (async () => {
        try {
          await setSessionCookieFast();
        } catch {}
        await maybeAutoAcceptInvite(token);
      })();

      // 6️⃣ Redirect to verify-email page
      router.push(
        `/verify-email?email=${encodeURIComponent(values.email)}&role=${encodeURIComponent(role)}${
          next ? `&next=${encodeURIComponent(next)}` : ""
        }${token ? `&token=${encodeURIComponent(token)}` : ""}`
      );
    } catch (err: any) {
      // Handle Firebase errors cleanly
      console.error(err);
      const code = err?.code as string | undefined;
      let message = "Something went wrong. Please try again.";
      switch (code) {
        case "auth/email-already-in-use":
          message = "That email is already registered.";
          break;
        case "auth/invalid-email":
          message = "Invalid email address.";
          break;
        case "auth/weak-password":
          message = "Password is too weak.";
          break;
        case "auth/operation-not-allowed":
          message = "Email/password sign up is disabled.";
          break;
        case "auth/too-many-requests":
          message = "Too many attempts. Please try again later.";
          break;
      }
      toast({ title: "Signup failed", description: message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  /* ---------------------------------------------------------------------- */
  /*                                 RENDER                                 */
  /* ---------------------------------------------------------------------- */
  return (
    <div className="flex flex-col min-h-screen bg-background">
      <Header /> {/* Shared header component */}
      <main className="flex-grow flex items-center justify-center p-4">
        <Card className="w-full max-w-lg shadow-xl">
          {/* ---- Card Header ---- */}
          <CardHeader className="text-center">
            <CardTitle className="text-3xl font-headline">Create Your Account</CardTitle>
            <CardDescription>
              {role === "emergency_contact"
                ? "You’re signing up as an emergency contact."
                : "Create your main user account."}
            </CardDescription>
          </CardHeader>

          {/* ---- Form ---- */}
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)}>
              <CardContent className="space-y-4">
                {/* First Name */}
                <FormField
                  control={form.control}
                  name="firstName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>First Name</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="John"
                          {...field}
                          disabled={isSubmitting}
                          autoComplete="given-name"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Last Name */}
                <FormField
                  control={form.control}
                  name="lastName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Last Name</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Doe"
                          {...field}
                          disabled={isSubmitting}
                          autoComplete="family-name"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Email */}
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email Address</FormLabel>
                      <FormControl>
                        <Input
                          type="email"
                          placeholder="you@example.com"
                          {...field}
                          disabled={isSubmitting}
                          autoComplete="email"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Phone (must include country code) */}
                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Mobile Phone (with country code)</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="+15551234567"
                          {...field}
                          disabled={isSubmitting}
                          autoComplete="tel"
                        />
                      </FormControl>
                      <p className="text-xs text-muted-foreground">
                        Must include your country code (e.g. +1). Used for emergency calls.
                      </p>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Password */}
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
                          autoComplete="new-password"
                        />
                      </FormControl>
                      {/* Strength meter */}
                      {field.value && <Progress value={passwordStrength} className="mt-2 h-2" />}
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Confirm Password */}
                <FormField
                  control={form.control}
                  name="confirmPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Confirm Password</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          placeholder="••••••••"
                          {...field}
                          disabled={isSubmitting}
                          autoComplete="new-password"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>

              {/* ---- Footer ---- */}
              <CardFooter className="flex-col gap-4">
                {/* Submit button */}
                <Button type="submit" className="w-full text-lg py-6" disabled={isSubmitting}>
                  {isSubmitting ? "Creating…" : "Create Account"}
                </Button>

                {/* Login link */}
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
      <Footer /> {/* Shared footer component */}
    </div>
  );
}
