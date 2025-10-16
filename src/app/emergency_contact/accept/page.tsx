// src/app/emergency_contact/accept/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "@/firebase";
import { doc, getDoc } from "firebase/firestore";

import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { normalizeRole } from "@/lib/roles";

export default function AcceptInvitePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  // Read invite + token from query (?invite=...&token=...)
  const inviteId = searchParams.get("invite") || searchParams.get("inviteId") || "";
  const token = searchParams.get("token") || "";

  // Local UI state
  const [step, setStep] = useState<"checking-auth" | "accepting" | "done" | "error">("checking-auth");
  const [errorMsg, setErrorMsg] = useState<string>("");

  // Build the canonical "next" URL so signup can bounce back here
  const nextUrl = useMemo(() => {
    // reconstruct the current route including query string
    const query = new URLSearchParams();
    if (inviteId) query.set("invite", inviteId);
    if (token) query.set("token", token);
    return `/emergency_contact/accept${query.toString() ? `?${query.toString()}` : ""}`;
  }, [inviteId, token]);

  useEffect(() => {
    // Guard: need at least one of inviteId or token
    if (!inviteId && !token) {
      setStep("error");
      setErrorMsg("This invitation link is missing required parameters.");
      return;
    }

    // 1) Check auth; if not authed → send to signup and bounce back here
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setStep("checking-auth");
        router.replace(`/signup?role=emergency_contact&next=${encodeURIComponent(nextUrl)}`);
        return;
      }

      // 2) Confirm role == emergency_contact; otherwise route them away
      try {
        const meSnap = await getDoc(doc(db, "users", user.uid));
        const myRole = normalizeRole(meSnap.exists() ? (meSnap.data() as any).role : undefined);

        if (myRole !== "emergency_contact") {
          // If they’re a main user or something else, send them to main dashboard
          router.replace("/dashboard");
          return;
        }
      } catch {
        // If we can’t read the role, be conservative and send them through signup again
        router.replace(`/signup?role=emergency_contact&next=${encodeURIComponent(nextUrl)}`);
        return;
      }

      // 3) We’re signed in as an emergency contact → accept the invite via API
      setStep("accepting");
      try {
        const res = await fetch("/api/emergency_contact/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // server route accepts either token or inviteId; we send both if present
          body: JSON.stringify({ token, inviteId }),
        });

        const data = await res.json().catch(() => ({} as any));

        if (!res.ok || data?.error) {
          // Common cases
          if (res.status === 401) {
            // no valid session cookie → force signup again
            router.replace(`/signup?role=emergency_contact&next=${encodeURIComponent(nextUrl)}`);
            return;
          }
          if (res.status === 403) {
            router.replace("/dashboard");
            return;
          }

          // Invite expired or mismatch etc.
          const message =
            data?.error ||
            (res.status === 410
              ? "This invitation has expired. Ask the main user to send a new one."
              : "We couldn’t accept this invitation.");
          setErrorMsg(message);
          setStep("error");
          return;
        }

        // 4) Success → send them to the Emergency Dashboard
        setStep("done");
        toast({ title: "Linked!", description: "You’ve been connected to the main user." });
        router.replace("/emergency-dashboard");
      } catch (e: any) {
        setErrorMsg(e?.message ?? "Accept failed. Please try again.");
        setStep("error");
      }
    });

    return () => unsub();
  }, [router, nextUrl, inviteId, token, toast]);

  return (
    <div className="flex min-h-screen flex-col bg-secondary">
      <Header />
      <main className="container mx-auto flex flex-1 items-center justify-center px-4 py-12">
        <Card className="w-full max-w-lg shadow-lg">
          <CardHeader>
            <CardTitle className="text-2xl font-headline">Accept Invitation</CardTitle>
            <CardDescription>
              Link this account as an emergency contact, then you’ll be redirected to your dashboard.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            {step === "checking-auth" && (
              <div className="flex items-center gap-3 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                <span>Checking your sign-in…</span>
              </div>
            )}

            {step === "accepting" && (
              <div className="flex items-center gap-3 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                <span>Linking your account…</span>
              </div>
            )}

            {step === "done" && (
              <div className="flex items-center gap-3 text-green-600">
                <CheckCircle2 className="h-5 w-5" aria-hidden />
                <span>Success! Redirecting to your dashboard…</span>
              </div>
            )}

            {step === "error" && (
              <>
                <div className="flex items-start gap-3 text-destructive">
                  <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" aria-hidden />
                  <p className="leading-relaxed">{errorMsg || "Something went wrong."}</p>
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button variant="default" onClick={() => router.replace(nextUrl)}>
                    Try again
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      router.replace(`/signup?role=emergency_contact&next=${encodeURIComponent(nextUrl)}`)
                    }
                  >
                    Sign in
                  </Button>
                  <Button variant="ghost" onClick={() => router.replace("/")}>
                    Home
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </main>
      <Footer />
    </div>
  );
}
