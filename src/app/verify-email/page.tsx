// app/verify-email/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { auth, db } from "@/firebase";
import { sendEmailVerification, applyActionCode } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { Button } from "@/components/ui/button";
import { normalizeRole, Role } from "@/lib/roles";

const ACCEPT_API = "/api/emergency_contact/accept";
const EMERGENCY_DASH = "/emergency-dashboard";
const MAIN_DASH = "/dashboard";

// Resolve role from URL if present; else from Firestore; else default to main_user
async function resolveRole(uid: string, roleParam: string | null): Promise<Role> {
  const fromUrl = normalizeRole(roleParam);
  if (fromUrl) return fromUrl;

  try {
    const snap = await getDoc(doc(db, "users", uid));
    const role = snap.exists() ? (snap.data() as any).role : undefined;
    return normalizeRole(role) ?? "main_user";
  } catch {
    return "main_user";
  }
}

// Create/refresh the server session cookie from the current Firebase ID token
async function ensureSessionCookie(): Promise<boolean> {
  const u = auth.currentUser;
  if (!u) return false;
  try {
    const idToken = await u.getIdToken(true);
    const res = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ idToken }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export default function VerifyEmailPage() {
  const params = useSearchParams();
  const router = useRouter();

  // carried via links
  const roleParam = normalizeRole(params.get("role")) ?? "main_user"; // 'main_user' | 'emergency_contact'
  const nextParam = params.get("next") || "";
  const emailParam = params.get("email") || "";
  const token = params.get("token") || ""; // invite token (optional)

  // if the verification email opened this page directly
  const mode = params.get("mode");
  const oobCode = params.get("oobCode");

  // returned from Firebase hosted page "Continue"
  const fromHosted = params.get("fromHosted") === "1";

  const email = emailParam || auth.currentUser?.email || "";

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [isVerified, setIsVerified] = useState(false);

  // continue URL for (re)send actions — include role/next/token
  const continueUrl = useMemo(() => {
    const base = typeof window === "undefined" ? "" : window.location.origin;
    const qs = new URLSearchParams({
      role: roleParam,
      fromHosted: "1",
      ...(nextParam ? { next: nextParam } : {}),
      ...(token ? { token } : {}),
    }).toString();
    return `${base}/verify-email?${qs}`;
  }, [roleParam, nextParam, token]);

  // destination after success
  const desiredDestination = (role: Role) =>
    nextParam || (role === "emergency_contact" ? EMERGENCY_DASH : MAIN_DASH);

  // Try to accept the invite token (only for emergency_contact flows)
  const tryAcceptInvite = async (): Promise<boolean> => {
    if (!token) return true; // nothing to do

    // helper to call API
    const attempt = () =>
      fetch(ACCEPT_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token }),
      });

    try {
      // make sure server session cookie exists before first attempt
      await ensureSessionCookie();

      let res = await attempt();

      // Retry once on 401 after forcing a fresh session cookie
      if (res.status === 401 && auth.currentUser) {
        const ok = await ensureSessionCookie();
        if (ok) res = await attempt();
      }

      if (res.ok) return true;

      if (res.status === 401) {
        // unauthenticated → send to login with role/token/next
        router.replace(
          `/login?role=emergency_contact&next=${encodeURIComponent(
            desiredDestination("emergency_contact")
          )}&token=${encodeURIComponent(token)}&verified=1`
        );
        return false;
      }

      if (res.status === 403) {
        // wrong role/email → go to accept page which shows sign-out flow
        router.replace(`/emergency_contact/accept?token=${encodeURIComponent(token)}`);
        return false;
      }

      // Other errors (e.g., expired 410 / used 409)
      try {
        const { error } = await res.json();
        setStatus(error || "Invite acceptance failed.");
      } catch {
        setStatus("Invite acceptance failed.");
      }
      return false;
    } catch {
      setStatus("Network error while accepting the invite.");
      return false;
    }
  };

  // 1) apply code or honor hosted return
  // 2) accept invite (if token & emergency_contact)
  // 3) redirect
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
          setIsVerified(false);
          setStatus("");
          return;
        }

        if (auth.currentUser) {
          // Make sure server session cookie exists for API calls
          await ensureSessionCookie();

          await auth.currentUser.reload();
          const role = await resolveRole(auth.currentUser.uid, params.get("role"));
          if (role === "emergency_contact") {
            const ok = await tryAcceptInvite();
            if (!ok) return; // redirected to login or accept page or showed an error
          }
          router.replace(desiredDestination(role));
          return;
        }

        // not signed in — send to login with next (and token if present)
        const destIfSigned = desiredDestination(roleParam);
        router.replace(
          `/login?role=${encodeURIComponent(roleParam)}&next=${encodeURIComponent(destIfSigned)}${
            token ? `&token=${encodeURIComponent(token)}` : ""
          }&verified=1`
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, oobCode, fromHosted]);

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
        await ensureSessionCookie();
        const role = await resolveRole(u.uid, params.get("role"));
        if (role === "emergency_contact") {
          const ok = await tryAcceptInvite();
          if (!ok) return;
        }
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
        url: continueUrl,
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
            <Button onClick={refresh} disabled={busy}>
              Refresh
            </Button>
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
