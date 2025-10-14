// app/login/page.tsx
"use client"; // This page uses React hooks and browser-only APIs, so it's a Client Component.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter,
} from "@/components/ui/card";
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff } from "lucide-react";

import { auth, db } from "@/firebase";
import { signInWithEmailAndPassword } from "firebase/auth";
import { normalizeRole, Role } from "@/lib/roles";
import { doc, getDoc } from "firebase/firestore";

/* -------------------------------------------------------------------------- */
/*                                   SCHEMA                                   */
/* -------------------------------------------------------------------------- */
// Simple login schema: email must be valid, password must be non-empty.
const loginSchema = z.object({
  email: z.string().email({ message: "Please enter a valid email address." }),
  password: z.string().min(1, { message: "Password is required." }),
});

/* -------------------------------------------------------------------------- */
/*                                   HELPERS                                  */
/* -------------------------------------------------------------------------- */
// Route constants (kept inline to match the rest of your codebase).
const EMERGENCY_DASH = "/emergency-dashboard";
const MAIN_DASH = "/dashboard";
const SET_SESSION_API = "/api/auth/session";
const ACCEPT_INVITE_API = "/api/emergency_contact/accept";

/**
 * safeNext: sanitize a provided "next" path.
 * - Only allow same-origin relative paths that START with "/".
 * - Treat "/" specially as "no next" (fall back by role), mirroring signup/verify-email semantics.
 */
function safeNext(n: string | null | undefined, fallbackRole: Role): string {
  if (n && n.startsWith("/")) {
    // Normalize "/" → use role-based default instead of pushing to site root.
    if (n === "/") return fallbackRole === "emergency_contact" ? EMERGENCY_DASH : MAIN_DASH;
    return n;
  }
  // No acceptable next given → default by role.
  return fallbackRole === "emergency_contact" ? EMERGENCY_DASH : MAIN_DASH;
}

/**
 * setSessionCookieFast: create/refresh the server session cookie from the current ID token.
 * - Fire-and-forget call with keepalive so it can complete after navigation.
 */
async function setSessionCookieFast() {
  const u = auth.currentUser;
  if (!u) return;
  const idToken = await u.getIdToken(true);
  fetch(SET_SESSION_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ idToken }),
    keepalive: true, // Continue even if user navigates away immediately.
  }).catch(() => {});
}

/**
 * maybeAutoAcceptInvite: if an invite token is present, POST it to the accept endpoint.
 * - Fire-and-forget (we'll call it after setSessionCookieFast to avoid 401s).
 */
async function maybeAutoAcceptInvite(token: string | null) {
  if (!token) return;
  fetch(ACCEPT_INVITE_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ token }),
    keepalive: true,
  }).catch(() => {});
}

/* -------------------------------------------------------------------------- */
/*                                  COMPONENTS                                */
/* -------------------------------------------------------------------------- */
// Wrapper component with Suspense fallback for better UX on slow devices.
export default function LoginPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <LoginPageContent />
    </Suspense>
  );
}

function LoginPageContent() {
  const router = useRouter();                // Programmatic navigation.
  const params = useSearchParams();          // Read URL query params.
  const { toast } = useToast();              // Toast notifications.

  const [isSubmitting, setIsSubmitting] = useState(false); // Disable UI during submit.
  const [showPassword, setShowPassword] = useState(false); // Toggle password visibility.

  // Role hint from the URL; strictly limited to "main_user" | "emergency_contact".
  const roleFromUrl: Role = normalizeRole(params.get("role")) ?? "main_user";

  // Optional invite token for emergency-contact flows.
  const token = params.get("token");

  // Raw explicit next from query; will be sanitized via safeNext.
  const explicitNext = params.get("next");

  // Compute a destination candidate once (based on URL role).
  // The final destination will be recomputed after we resolve the user's Firestore role.
  const initialDestination = useMemo(
    () => safeNext(explicitNext, roleFromUrl),
    [explicitNext, roleFromUrl]
  );

  // (Reserved for analytics or side-effects; matching other pages' pattern.)
  useEffect(() => {
    // No prefetch: App Router router does not provide router.prefetch().
  }, [initialDestination]);

  // Hook up react-hook-form with zod validation.
  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  /**
   * onSubmit: main login flow
   * 1) Sign in with Firebase Auth.
   * 2) Resolve role from Firestore (so dashboard choice is accurate).
   * 3) Build the final destination using the resolved role and sanitized next.
   * 4) Fire-and-forget: set session cookie, then accept invite (sequentially to avoid 401 race).
   * 5) Redirect immediately.
   */
  const onSubmit = async (values: z.infer<typeof loginSchema>) => {
    try {
      setIsSubmitting(true);

      // 1) Sign in the user with Firebase Auth.
      const { user } = await signInWithEmailAndPassword(
        auth,
        values.email.trim().toLowerCase(),
        values.password
      );

      // 2) Resolve the user's role from Firestore (fallback to URL role if unavailable).
      let resolvedRole: Role = roleFromUrl;
      try {
        const profileRef = doc(db, "users", user.uid);
        const profileSnap = await getDoc(profileRef);
        const roleFromProfile = normalizeRole(
          profileSnap.exists() ? (profileSnap.data() as any).role : undefined
        );
        if (roleFromProfile) {
          resolvedRole = roleFromProfile; // Use server-sourced truth when available.
        }
      } catch (error) {
        // If Firestore fails, stick with the role from the URL.
        console.error("Failed to resolve user role", error);
      }

      // 3) Compute the final destination using sanitized next + resolved role.
      const finalDestination = safeNext(explicitNext, resolvedRole);

      // 4) Fire-and-forget background tasks, but chain to reduce 401s on invite acceptance.
      void (async () => {
        try {
          await setSessionCookieFast(); // Give the cookie a head start.
        } catch {}
        await maybeAutoAcceptInvite(token); // Then attempt invite acceptance.
      })();

      // 5) Redirect the user right away.
      router.replace(finalDestination);

      // Friendly toast (doesn't block redirect).
      toast({
        title: "Login Successful",
        description: `Welcome back, ${user.email ?? "user"}!`,
      });
    } catch (err: any) {
      // Map Firebase Auth errors into user-friendly messages.
      const code = err?.code as string | undefined;
      let message = "Something went wrong. Please try again.";
      if (code === "auth/invalid-email") message = "Invalid email address.";
      else if (code === "auth/user-disabled") message = "This account has been disabled.";
      else if (code === "auth/user-not-found" || code === "auth/wrong-password")
        message = "Incorrect email or password.";
      else if (code === "auth/too-many-requests")
        message = "Too many attempts. Please wait and try again.";

      toast({ title: "Login failed", description: message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Build the Signup link: preserve role + sanitized "next" + optional invite token.
  // We pass initialDestination (already sanitized) to maintain a consistent post-signup path.
  const signupHref = `/signup?role=${encodeURIComponent(
    roleFromUrl
  )}&next=${encodeURIComponent(initialDestination)}${token ? `&token=${encodeURIComponent(token)}` : ""}`;

  /* -------------------------------------------------------------------------- */
  /*                                    UI                                      */
  /* -------------------------------------------------------------------------- */
  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* Shared site header */}
      <Header />
      <main className="flex-grow flex items-center justify-center p-4">
        <Card className="w-full max-w-md shadow-xl">
          {/* Card header with role-sensitive description */}
          <CardHeader className="text-center">
            <CardTitle className="text-3xl font-headline">Welcome Back!</CardTitle>
            <CardDescription>
              {roleFromUrl === "emergency_contact"
                ? "Sign in as an emergency contact"
                : "Sign in to continue to LifeSignal AI"}
            </CardDescription>
          </CardHeader>

          {/* Form wrapper (react-hook-form) */}
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)}>
              <CardContent className="space-y-4">
                {/* Email field */}
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
                          autoComplete="email"      // Helps password managers.
                          inputMode="email"         // Mobile keyboards show @ and .com.
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Password field with show/hide toggle */}
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Password</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Input
                            type={showPassword ? "text" : "password"}
                            placeholder="••••••••"
                            {...field}
                            disabled={isSubmitting}
                            autoComplete="current-password" // Browser can autofill.
                          />
                          {/* Toggle button is purely client-side; accessible label provided. */}
                          <button
                            type="button"
                            onClick={() => setShowPassword((prev) => !prev)}
                            className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground hover:text-foreground"
                            aria-label={showPassword ? "Hide password" : "Show password"}
                          >
                            {showPassword ? (
                              <EyeOff className="h-5 w-5" aria-hidden="true" />
                            ) : (
                              <Eye className="h-5 w-5" aria-hidden="true" />
                            )}
                          </button>
                        </div>
                      </FormControl>
                      <FormMessage />
                      {/* Forgot password link (route assumed to exist). */}
                      <div className="text-right mt-2">
                        <Link
                          href="/forgot-password"
                          className="text-sm font-semibold text-primary hover:underline"
                        >
                          Forgot Password?
                        </Link>
                      </div>
                    </FormItem>
                  )}
                />
              </CardContent>

              {/* Submit + alternate path */}
              <CardFooter className="flex flex-col gap-4">
                <Button type="submit" className="w-full text-lg py-6" disabled={isSubmitting}>
                  {isSubmitting ? "Signing in..." : "Sign In"}
                </Button>

                <p className="text-center text-sm text-muted-foreground">
                  New to LifeSignal?{" "}
                  <Link href={signupHref} className="font-semibold text-primary hover:underline">
                    Create an account
                  </Link>
                </p>
              </CardFooter>
            </form>
          </Form>
        </Card>
      </main>
      {/* Shared site footer */}
      <Footer />
    </div>
  );
}
