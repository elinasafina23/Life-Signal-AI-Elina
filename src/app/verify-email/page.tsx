"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { auth, db } from "@/firebase";
import {
  sendEmailVerification,
  applyActionCode,
} from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { Button } from "@/components/ui/button";

async function resolveRole(uid: string, roleParam: string | null) {
  if (roleParam && (roleParam === "caregiver" || roleParam === "user")) {
    return roleParam;
  }
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

  const roleParam = (params.get("role") || "").toLowerCase() || null;
  const emailParam = params.get("email");
  const mode = params.get("mode");
  const oobCode = params.get("oobCode");

  const email = emailParam || auth.currentUser?.email || "";
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  // Where we want Firebase to send users back after they click the link
  const continueUrl = useMemo(() => {
    const base = typeof window === "undefined" ? "" : window.location.origin;
    // Keep role in the URL so we can route correctly after verification
    const role = roleParam ?? "user";
    return `${base}/verify-email?role=${encodeURIComponent(role)}`;
  }, [roleParam]);

  // If the page is opened from the email link, complete the verification immediately.
  useEffect(() => {
    const verifyFromLink = async () => {
      // We only handle the link if Firebase sent us back here with the code.
      if (mode !== "verifyEmail" || !oobCode) return;

      try {
        setBusy(true);
        setStatus("Verifying your email…");
        await applyActionCode(auth, oobCode);

        // Reload the current user if already signed in (optional)
        if (auth.currentUser) {
          await auth.currentUser.reload();
        }

        const u = auth.currentUser;
        if (u && u.emailVerified) {
          setStatus("Verified! Redirecting…");
          const role = await resolveRole(u.uid, roleParam);
          router.replace(role === "caregiver" ? "/emergency-dashboard" : "/dashboard");
        } else {
          // If they weren’t signed in during verification, send them to login.
          setStatus("Email verified! Please sign in.");
          router.replace(`/login?role=${roleParam ?? "user"}`);
        }
      } catch (err: any) {
        console.error(err);
        setStatus("Verification link is invalid or expired. Click Resend to get a new one.");
      } finally {
        setBusy(false);
      }
    };

    void verifyFromLink();
  }, [mode, oobCode, roleParam, router]);

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
        setStatus("Verified! Redirecting…");
        const role = await resolveRole(u.uid, roleParam);
        router.replace(role === "caregiver" ? "/emergency-dashboard" : "/dashboard");
      } else {
        setStatus("Still not verified. Check your inbox/spam, then click Refresh.");
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

      // Action Code Settings ensure the email link returns to THIS page.
      const actionCodeSettings = {
        url: continueUrl,
        handleCodeInApp: true,
      };

      await sendEmailVerification(u, actionCodeSettings);
      setStatus(`Verification email sent to ${u.email}. Check inbox/spam.`);
    } catch (err: any) {
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

        <p>
          We’ll send a verification link to{" "}
          <strong>{email || "your email address"}</strong>.
        </p>

        <div className="flex gap-2">
          <Button onClick={refresh} disabled={busy}>Refresh</Button>
          <Button variant="secondary" onClick={resend} disabled={busy}>
            Resend
          </Button>
        </div>

        <p className="text-sm">{status}</p>
        <p className="text-sm text-muted-foreground">
          If you didn’t receive the email, please wait at least 1 minute before clicking Resend.
        </p>
      </div>
    </main>
  );
}
