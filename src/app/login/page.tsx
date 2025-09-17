// app/login/page.tsx
"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
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

import { auth, db } from "@/firebase";
import { signInWithEmailAndPassword } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { useState } from "react";
import { normalizeRole, Role } from "@/lib/roles";

const loginSchema = z.object({
  email: z.string().email({ message: "Please enter a valid email address." }),
  password: z.string().min(1, { message: "Password is required." }),
});

// A utility function that determines the correct next page, sanitizing the URL.
function safeNext(n: string | null | undefined, fallbackRole: Role) {
  // Only allow redirects to same-site paths.
  if (n && n.startsWith("/")) return n;
  // Redirect to the default dashboard based on the inferred role from the URL.
  return fallbackRole === "emergency_contact" ? "/emergency-dashboard" : "/dashboard";
}

// A utility function to fetch the user's actual role from Firestore.
async function fetchActualRole(uid: string, fallback: Role): Promise<Role> {
  try {
    // Fetches the user document from Firestore.
    const snap = await getDoc(doc(db, "users", uid));
    // Extracts the role from the document data.
    const r = snap.exists() ? (snap.data() as any).role : undefined;
    // Returns the normalized role or a fallback.
    return normalizeRole(r) ?? fallback;
  } catch {
    return fallback;
  }
}

export default function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Retrieves query parameters from the URL.
  const roleFromUrl: Role = normalizeRole(params.get("role")) ?? "main_user";
  const token = params.get("token") || "";
  const explicitNext = params.get("next");

  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  // A helper function to create a server-side session cookie for API routes.
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

  // A helper function to automatically accept an invite token if one exists.
  const maybeAutoAcceptInvite = async () => {
    if (!token) return;
    try {
      await fetch("/api/emergency_contact/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token }),
      });
    } catch {
      // Ignore errors; the verify-email or accept page can handle it.
    }
  };

  const onSubmit = async (values: z.infer<typeof loginSchema>) => {
    try {
      setIsSubmitting(true);

      // 1. Sign in the user with Firebase Auth. This is the first step.
      const { user } = await signInWithEmailAndPassword(
        auth,
        values.email.trim().toLowerCase(),
        values.password
      );

      // 2. Authorize API routes by setting a session cookie. This is critical for server-side operations.
      await setSessionCookie();

      // 3. Immediately redirect the user based on the inferred role from the URL.
      // This is the key change to solve the delay.
      const destination = safeNext(explicitNext, roleFromUrl);
      router.replace(destination);

      // 4. (Asynchronous operation) Display a success toast notification.
      toast({
        title: "Login Successful",
        description: `Welcome back, ${user.email ?? "user"}!`,
      });

      // 5. (Asynchronous operation) Attempt to auto-accept the invite.
      // This happens *after* the redirect to ensure the page loads quickly.
      await maybeAutoAcceptInvite();

    } catch (err: any) {
      // Error handling for login failures.
      const code = err?.code as string | undefined;
      let message = "Something went wrong. Please try again.";
      if (code === "auth/invalid-email") message = "Invalid email address.";
      else if (code === "auth/user-not-found" || code === "auth/wrong-password")
        message = "Incorrect email or password.";
      else if (code === "auth/too-many-requests")
        message = "Too many attempts. Please wait and try again.";
      toast({ title: "Login failed", description: message, variant: "destructive" });
    } finally {
      // Always stop the submitting state to re-enable the form.
      setIsSubmitting(false);
    }
  };

  // Precomputes the link to the signup page.
  const signupNext = safeNext(explicitNext, roleFromUrl);

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
                    href={`/signup?role=${encodeURIComponent(
                      roleFromUrl
                    )}&next=${encodeURIComponent(
                      signupNext
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