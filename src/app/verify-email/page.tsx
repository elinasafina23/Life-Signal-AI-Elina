// src/app/verify-email/page.tsx
"use client";

import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { auth, db } from "@/firebase";
import { sendEmailVerification } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { Button } from "@/components/ui/button";

async function resolveRole(uid: string, roleParam: string | null) {
  if (roleParam && (roleParam === "caregiver" || roleParam === "user")) {
    return roleParam;
  }
  // Fallback: read from Firestore profile
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

  const emailParam = params.get("email");
  const roleParam = (params.get("role") || "").toLowerCase() || null;

  const email = emailParam || auth.currentUser?.email || "";
  const [status, setStatus] = useState("");

  const refresh = async () => {
    const u = auth.currentUser;
    if (!u) {
      setStatus("Not signed in. Please sign in again.");
      return;
    }
    await u.reload();
    if (u.emailVerified) {
      setStatus("Verified! Redirecting…");
      const role = await resolveRole(u.uid, roleParam);
      if (role === "caregiver") {
        router.replace("/emergency-dashboard");
      } else {
        router.replace("/dashboard");
      }
    } else {
      setStatus("Still not verified. Check your inbox/spam, then click Refresh.");
    }
  };

  const resend = async () => {
    const u = auth.currentUser;
    if (!u) {
      setStatus("Not signed in. Please sign in again.");
      return;
    }
    await sendEmailVerification(u);
    setStatus(`Verification email sent to ${u.email}.`);
  };

  return (
    <main className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full space-y-4">
        <h1 className="text-2xl font-semibold">Verify your email</h1>
        <p>
          We sent a verification link to <strong>{email}</strong>.
        </p>
        <div className="flex gap-2">
          <Button onClick={refresh}>Refresh</Button>
          <Button variant="secondary" onClick={resend}>
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
