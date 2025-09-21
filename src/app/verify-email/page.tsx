// app/verify-email/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { auth, db } from "@/firebase";
import { sendEmailVerification, applyActionCode } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { Button } from "@/components/ui/button";
import { normalizeRole, Role } from "@/lib/roles";

/* ---------------- Constants used for redirects ---------------- */
const ACCEPT_API = "/api/emergency_contact/accept"; // server route to accept inviter’s token
const EMERGENCY_DASH = "/emergency-dashboard";      // destination for emergency contacts
const MAIN_DASH = "/dashboard";                     // destination for main users

/* ---------------- Helpers ---------------- */

/**
 * Get the user’s role, with precedence:
 * 1) ?role= in the URL (if present and valid),
 * 2) users/{uid}.role in Firestore,
 * 3) fallback "main_user".
 */
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

/**
 * Create or refresh the server session cookie from the client’s ID token.
 * Returns true if the cookie was set successfully.
 */
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

/* ---------------- Page Component ---------------- */
export default function VerifyEmailPage() {
  const params = useSearchParams();     // read URL query params
  const router = useRouter();           // programmatic navigation

  // Role hint from the URL; default to "main_user" if not set/invalid.
  const roleParam = normalizeRole(params.get("role")) ?? "main_user";
  // Optional “take me here after done” path.
  const nextParam = params.get("next") || "";
  // Optional email to display on screen (if the link carried it).
  const emailParam = params.get("email") || "";
  // Optional invite token for emergency-contact flows.
  const token = params.get("token") || "";

  // If the Firebase “action link” opened this page directly, these are set:
  const mode = params.get("mode");     // should be "verifyEmail" for our flow
  const oobCode = params.get("oobCode"); // one-time verification code

  // If the user clicked “Continue” from Firebase’s hosted page, we get this flag.
  const fromHosted = params.get("fromHosted") === "1";

  // Prefer email from the URL, otherwise from current user (if any).
  const email = emailParam || auth.currentUser?.email || "";

  // UI state for spinners / messages.
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [isVerified, setIsVerified] = useState(false);

  /**
   * Build the “continue URL” that Firebase uses in the verification email.
   * We include role/next/token so the user lands back here with the right context.
   */
  const continueUrl = useMemo(() => {
    const base = typeof window === "undefined" ? "" : window.location.origin;
    const qs = new URLSearchParams({
      role: roleParam,
      fromHosted: "1",           // mark that this came back from Firebase hosted page
      ...(nextParam ? { next: nextParam } : {}),
      ...(token ? { token } : {}),
    }).toString();
    return `${base}/verify-email?${qs}`;
  }, [roleParam, nextParam, token]);

  /** Choose where to go after successful verification based on role (or nextParam if present). */
  const desiredDestination = (role: Role) =>
    nextParam || (role === "emergency_contact" ? EMERGENCY_DASH : MAIN_DASH);

  /**
   * Try to accept an emergency-contact invite token.
   * - Ensures the session cookie exists (so the API is authorized)
   * - Retries once on 401
   * - Redirects to login/accept pages as needed
   * Returns true if everything’s OK and we can continue; false if we navigated away.
   */
  const tryAcceptInvite = async (): Promise<boolean> => {
    if (!token) return true; // Nothing to accept.

    const attempt = () =>
      fetch(ACCEPT_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token }),
      });

    try {
      await ensureSessionCookie();      // make sure cookie is present
      let res = await attempt();        // first attempt

      // If cookie wasn’t ready → try once more after forcing a refresh.
      if (res.status === 401 && auth.currentUser) {
        const ok = await ensureSessionCookie();
        if (ok) res = await attempt();
      }

      if (res.ok) return true;

      // Unauthenticated → go to login (preserve token + desired next).
      if (res.status === 401) {
        router.replace(
          `/login?role=emergency_contact&next=${encodeURIComponent(
            desiredDestination("emergency_contact")
          )}&token=${encodeURIComponent(token)}&verified=1`
        );
        return false;
      }

      // Authenticated but wrong account/email → show accept page (has sign-out flow).
      if (res.status === 403) {
        router.replace(`/emergency_contact/accept?token=${encodeURIComponent(token)}`);
        return false;
      }

      // Other server errors (expired/used/etc.) → show a message.
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

  /**
   * Lifecycle:
   * 1) If we have a Firebase action code (?mode=verifyEmail&oobCode=...), apply it.
   * 2) Or if we came back from the hosted page (?fromHosted=1), treat as verified.
   * 3) Ensure the cookie, resolve role, maybe accept invite, then redirect.
   * 4) If not signed in, send to login carrying role/next/token.
   */
  useEffect(() => {
    const run = async () => {
      setBusy(true);
      try {
        // Case A: we have a code → apply verification immediately.
        if (mode === "verifyEmail" && oobCode) {
          setStatus("Verifying your email…");
          await applyActionCode(auth, oobCode);
          setIsVerified(true);
          setStatus("Your email has been verified. Redirecting…");
        }
        // Case B: returned from Firebase hosted page that already verified.
        else if (fromHosted) {
          setIsVerified(true);
          setStatus("Your email has been verified. Redirecting…");
        }
        // Neither? Show the “send / resend” UI.
        else {
          setIsVerified(false);
          setStatus("");
          return;
        }

        // If the user is signed in, we can get role + accept invite (if any) + redirect.
        if (auth.currentUser) {
          await ensureSessionCookie();                     // authorize API calls
          await auth.currentUser.reload();                 // make sure emailVerified is current
          const role = await resolveRole(auth.currentUser.uid, params.get("role"));
          if (role === "emergency_contact") {
            const ok = await tryAcceptInvite();
            if (!ok) return;                               // we navigated away inside tryAcceptInvite
          }
          router.replace(desiredDestination(role));
          return;
        }

        // Not signed in → go to login and keep all context.
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
    // We intentionally only react to these inputs; eslint disabled to avoid ref churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, oobCode, fromHosted]);

  /** Manual “Refresh” button: re-check emailVerified, then finish flow. */
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

  /** “Resend” button: sends a new verification email with continueUrl back to this page. */
  const resend = async () => {
    try {
      setBusy(true);
      const u = auth.currentUser;
      if (!u) {
        setStatus("Not signed in. Please sign in again.");
        return;
      }
      await sendEmailVerification(u, {
        url: continueUrl,          // where the “Verify” button brings them back
        handleCodeInApp: true,     // we handle the code here
      });
      setStatus(`Verification email sent to ${u.email}. Check inbox/spam.`);
    } catch (err) {
      console.error(err);
      setStatus("Could not send the email. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- UI ---------------- */
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
