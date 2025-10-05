// app/login/page.tsx
"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
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

/* ---------------- Schema ---------------- */
// Validate the form with zod (email + non-empty password).
const loginSchema = z.object({
  email: z.string().email({ message: "Please enter a valid email address." }),
  password: z.string().min(1, { message: "Password is required." }),
});

/* ---------------- Helpers ---------------- */
// Only allow same-origin next links; otherwise fall back by role.
function safeNext(n: string | null | undefined, fallbackRole: Role) {
  if (n && n.startsWith("/")) return n;
  return fallbackRole === "emergency_contact" ? "/emergency-dashboard" : "/dashboard";
}

// Start creating a server session cookie; we purposely don't await it
// so we can redirect immediately (client SDK keeps working meanwhile).
async function setSessionCookieFast() {
  const u = auth.currentUser;
  if (!u) return;
  const idToken = await u.getIdToken(true);
  fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ idToken }),
    keepalive: true, // helps if we navigate away instantly
  }).catch(() => {});
}

// If this login came from an invite link, we can accept it in the background
// after redirect. This does not block navigation.
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

export default function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { toast } = useToast();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Read query params for role, invite token, and explicit next path.
  const roleFromUrl: Role = normalizeRole(params.get("role")) ?? "main_user";
  const token = params.get("token");
  const explicitNext = params.get("next");

  // Compute the destination once (memoized) so we don't recompute on every render.
  const destination = useMemo(
    () => safeNext(explicitNext, roleFromUrl),
    [explicitNext, roleFromUrl]
  );

  // (Optional) You can keep this effect empty or add analytics; we removed
  // router.prefetch() because App Router's useRouter() doesn't expose it.
  useEffect(() => {
    // No-op: prefetch removed to avoid TypeScript errors.
  }, [destination]);

  // Hook up react-hook-form with our zod schema.
  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  // Main submit handler.
  const onSubmit = async (values: z.infer<typeof loginSchema>) => {
    try {
      setIsSubmitting(true);

      // 1) Sign in with Firebase Auth (await only this).
      const { user } = await signInWithEmailAndPassword(
        auth,
        values.email.trim().toLowerCase(),
        values.password
      );

      // 2) Resolve the user's actual role from Firestore so we can pick the
      //     correct destination. This prevents emergency contacts from
      //     flashing the main dashboard before their Firestore listener
      //     redirects them away.
      let resolvedRole: Role = roleFromUrl;
      try {
        const profileRef = doc(db, "users", user.uid);
        const profileSnap = await getDoc(profileRef);
        const roleFromProfile = normalizeRole(
          profileSnap.exists() ? (profileSnap.data() as any).role : undefined
        );
        if (roleFromProfile) {
          resolvedRole = roleFromProfile;
        }
      } catch (error) {
        // Ignore Firestore errors — we'll fall back to the role from the URL.
        console.error("Failed to resolve user role", error);
      }

      const finalDestination = safeNext(explicitNext, resolvedRole);

      // 3) Fire-and-forget the session cookie creation + invite acceptance.
      void setSessionCookieFast();
      void maybeAutoAcceptInvite(token);

      // 4) Redirect immediately (no waiting).
      router.replace(finalDestination);

      // 5) Friendly toast (doesn't block the redirect).
      toast({
        title: "Login Successful",
        description: `Welcome back, ${user.email ?? "user"}!`,
      });
    } catch (err: any) {
      // Map common auth errors to friendly messages.
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

  // Build the signup link (preserves role + next + invite token).
  const signupHref = `/signup?role=${encodeURIComponent(
    roleFromUrl
  )}&next=${encodeURIComponent(destination)}${token ? `&token=${encodeURIComponent(token)}` : ""}`;

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <Header />
      <main className="flex-grow flex items-center justify-center p-4">
        <Card className="w-full max-w-md shadow-xl">
          <CardHeader className="text-center">
            <CardTitle className="text-3xl font-headline">Welcome Back!</CardTitle>
            <CardDescription>
              {roleFromUrl === "emergency_contact"
                ? "Sign in as an emergency contact"
                : "Sign in to continue to LifeSignal AI"}
            </CardDescription>
          </CardHeader>

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
                          autoComplete="email"
                          inputMode="email"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Password field */}
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
                            autoComplete="current-password"
                          />
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
      <Footer />
    </div>
  );
}
