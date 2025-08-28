// app/verify-email/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { auth, db } from "@/firebase";
import { sendEmailVerification, applyActionCode } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { Button } from "@/components/ui/button";

async function resolveRole(uid: string, roleParam: string | null) {
  if (roleParam && (roleParam === "caregiver" || roleParam === "user")) return roleParam;
  try {
    const snap = await getDoc(doc(db, "users", uid));
    const role = snap.exists() ? (snap.data() as any).role : undefined;
    return role === "caregiver" ? "caregiver" : "user";
  } catch {
    return "user";
  }
}

export default function VerifyEmailPage() {
  const params = useSearchParams();
  const router = useRouter();

  // Inputs carried through links
  const roleParam = (params.get("role") || "user").toLowerCase(); // "user" | "caregiver"
  const nextParam = params.get("next") || ""; // optional
  const emailParam = params.get("email") || "";

  // If the verification email opened this page directly
  const mode = params.get("mode");
  const oobCode = params.get("oobCode");

  // If the user came back from Firebase hosted page "Continue"
  const fromHosted = params.get("fromHosted") === "1";

  const email = emailParam || auth.currentUser?.email || "";

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [isVerified, setIsVerified] = useState(false);

  // Build the continueUrl for any (re)send actions from this page
  const continueUrl = useMemo(() => {
    const base = typeof window === "undefined" ? "" : window.location.origin;
    const qs = new URLSearchParams({
      role: roleParam,
      fromHosted: "1",
      ...(nextParam ? { next: nextParam } : {}),
    }).toString();
    return `${base}/verify-email?${qs}`;
  }, [roleParam, nextParam]);

  // Decide destination after success
  const desiredDestination = (role: string) => {
    const fallback = role === "caregiver" ? "/emergency-dashboard" : "/dashboard";
    return nextParam || fallback;
  };

  // 1) Apply code or honor hosted return  2) Redirect appropriately
  useEffect(() => {
    const run = async () => {
      setBusy(true);
      try {
        if (mode === "verifyEmail" && oobCode) {
          setStatus("Verifying your email…");
          await applyActionCode(auth, oobCode);
          setIsVerified(true);
          setStatus("Your email has been verified. Redirecting…");
        } else if (fromHosted) {
          setIsVerified(true);
          setStatus("Your email has been verified. Redirecting…");
        } else {
          // Not verified yet (user just opened /verify-email directly)
          setIsVerified(false);
          setStatus("");
          return;
        }

        // Try to route signed-in users straight to their destination
        try {
          if (auth.currentUser) {
            await auth.currentUser.reload();
            const u = auth.currentUser;
            const role = await resolveRole(u?.uid || "", roleParam);
            const dest = desiredDestination(role);
            router.replace(dest);
            return;
          }
        } catch {
          // ignore and fall through to login redirect
        }

        // Not signed in—send to login with next
        const destIfSigned = desiredDestination(roleParam);
        router.replace(
          `/login?role=${encodeURIComponent(roleParam)}&next=${encodeURIComponent(destIfSigned)}&verified=1`
        );
      } catch (err) {
        console.error(err);
        setIsVerified(false);
        setStatus("Verification link is invalid or expired. Click Resend to get a new one.");
      } finally {
        setBusy(false);
      }
    };
    void run();
  }, [mode, oobCode, fromHosted, roleParam, nextParam, router]);

  // Optional helpers if the user is signed in and needs to refresh/resend
  const refresh = async () => {
    try {
      setBusy(true);
      const u = auth.currentUser;
      if (!u) {
        setStatus("Not signed in. Please sign in again.");
        return;
      }
      await u.reload();
      if (u.emailVerified) {
        const role = await resolveRole(u.uid, roleParam);
        router.replace(desiredDestination(role));
      } else {
        setStatus("Still not verified. Check your inbox and try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    try {
      setBusy(true);
      const u = auth.currentUser;
      if (!u) {
        setStatus("Not signed in. Please sign in again.");
        return;
      }
      await sendEmailVerification(u, {
        url: continueUrl, // includes &fromHosted=1 and carries ?next=
        handleCodeInApp: true,
      });
      setStatus(`Verification email sent to ${u.email}. Check inbox/spam.`);
    } catch (err) {
      console.error(err);
      setStatus("Could not send the email. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full space-y-4">
        <h1 className="text-2xl font-semibold">Verify your email</h1>

        {isVerified ? (
          <p>Your email has been verified. Redirecting…</p>
        ) : (
          <p>
            We’ll send a verification link to{" "}
            <strong>{email || "your email address"}</strong>.
          </p>
        )}

        {!isVerified && (
          <div className="flex gap-2">
            <Button onClick={refresh} disabled={busy}>Refresh</Button>
            <Button variant="secondary" onClick={resend} disabled={busy}>
              Resend
            </Button>
          </div>
        )}

        {!isVerified && (
          <>
            <p className="text-sm">{status}</p>
            <p className="text-sm text-muted-foreground">
              If you didn’t receive the email, please wait at least 1 minute before clicking Resend.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
