// app/emergency_contact/accept/page.tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth } from "@/firebase";
import { Button } from "@/components/ui/button";

/** Server endpoints we call */
const ACCEPT_API = "/api/emergency_contact/accept";
const SESSION_API = "/api/auth/session";

/** Routes we navigate to */
const SELF_PATH = "/emergency_contact/accept";
const EMERGENCY_DASH = "/emergency-dashboard";

/** Create the secure server session cookie from the client ID token */
async function setSessionCookie(): Promise<boolean> {
  const u = auth.currentUser;
  if (!u) return false;
  const idToken = await u.getIdToken(true);
  const res = await fetch(SESSION_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ idToken }),
  });
  return res.ok;
}

export default function EmergencyContactAcceptPage() {
  const params = useSearchParams();
  const router = useRouter();

  // Extract required params safely
  const inviteId = (params.get("invite") || "").trim();
  const token = (params.get("token") || "").trim();

  const [status, setStatus] = useState("Checking invite…");
  const [showSignOut, setShowSignOut] = useState(false);
  const [busy, setBusy] = useState(false); // prevent double submits

  // We keep a ref to avoid re-running accept flow twice while auth flips
  const ranOnceRef = useRef(false);

  /**
   * Where the user should return after login/signup.
   * We reconstruct the exact current path+query so the flow is resumable.
   */
  const returnUrl = useMemo(() => {
    if (typeof window === "undefined") return SELF_PATH;
    return `${window.location.pathname}${window.location.search}`;
  }, []);

  useEffect(() => {
    // Guard: must have token OR inviteId or we cannot proceed
    if (!token && !inviteId) {
      setStatus("Invalid invite link.");
      return;
    }

    const unsub = onAuthStateChanged(auth, async (user) => {
      // Make sure we don't run the accept flow twice during rapid auth changes
      if (ranOnceRef.current) return;
      ranOnceRef.current = true;

      // Not signed in → send to signup (as emergency_contact) and bounce back to this page
      if (!user) {
        setStatus("Please sign in to accept the invite…");
        router.replace(
          `/signup?role=emergency_contact&next=${encodeURIComponent(returnUrl)}${
            token ? `&token=${encodeURIComponent(token)}` : ""
          }`
        );
        return;
      }

      // Ensure server session cookie exists before calling our API
      await setSessionCookie();

      // Try to accept the invite (single-flight)
      const doAccept = async () => {
        setBusy(true);
        setStatus("Linking your account…");

        const body: Record<string, string> = {};
        if (token) body.token = token;
        if (inviteId) body.inviteId = inviteId;

        const res = await fetch(ACCEPT_API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
        });

        if (res.ok) {
          setStatus("Invite accepted! Redirecting…");
          router.replace(EMERGENCY_DASH);
          return;
        }

        // If unauthenticated, cookie may not be set yet → try once more
        if (res.status === 401) {
          const ok = await setSessionCookie();
          if (ok) {
            const retry = await fetch(ACCEPT_API, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify(body),
            });
            if (retry.ok) {
              setStatus("Invite accepted! Redirecting…");
              router.replace(EMERGENCY_DASH);
              return;
            }
          }
          setStatus("Please sign in to accept the invite.");
          router.replace(
            `/login?role=emergency_contact&next=${encodeURIComponent(returnUrl)}${
              token ? `&token=${encodeURIComponent(token)}` : ""
            }`
          );
          return;
        }

        // If your /accept route enforces verified emails, it may return 403 + EMAIL_NOT_VERIFIED
        if (res.status === 403) {
          let msg = "You’re signed in with an account that cannot accept this invite.";
          try {
            const { error, verifyRequired } = await res.json();
            if (error === "EMAIL_NOT_VERIFIED" || verifyRequired) {
              msg =
                "Please verify your email address, then return to this link to complete acceptance.";
            } else {
              // Wrong role or wrong email case: show sign-out button
              setShowSignOut(true);
              msg =
                "You’re signed in with an account that cannot accept this invite. Please sign out and sign in with the invited email.";
            }
          } catch {
            // fall back to generic
            setShowSignOut(true);
          }
          setStatus(msg);
          setBusy(false);
          return;
        }

        // Generic error: show message from server if present
        let msg = "Accept failed";
        try {
          const { error } = await res.json();
          if (error) msg = error;
        } catch {}
        setStatus(msg);
        setBusy(false);
      };

      try {
        await doAccept();
      } catch (e) {
        console.error(e);
        setStatus("Something went wrong while accepting the invite.");
        setBusy(false);
      }
    });

    return () => unsub();
  }, [inviteId, token, returnUrl, router]);

  const handleSignOut = async () => {
    setBusy(true);
    try {
      await signOut(auth);
    } finally {
      setBusy(false);
      router.replace(
        `/login?role=emergency_contact&next=${encodeURIComponent(returnUrl)}${
          token ? `&token=${encodeURIComponent(token)}` : ""
        }`
      );
    }
  };

  return (
    <main className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full space-y-3 text-center">
        <h1 className="text-2xl font-semibold">Accept Invitation</h1>
        <p className="text-muted-foreground">{status}</p>
        <div className="flex gap-2 justify-center">
          {showSignOut && (
            <Button variant="destructive" onClick={handleSignOut} disabled={busy}>
              {busy ? "Signing out…" : "Sign out"}
            </Button>
          )}
          <Button onClick={() => router.replace("/")} disabled={busy}>
            Go Home
          </Button>
        </div>
      </div>
    </main>
  );
}
