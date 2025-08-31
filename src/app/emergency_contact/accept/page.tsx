// app/emergency_contact/accept/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth } from "@/firebase";
import { Button } from "@/components/ui/button";

const ACCEPT_API = "/api/emergency_contact/accept";
const SELF_PATH = "/emergency_contact/accept";
const EMERGENCY_DASH = "/emergency-dashboard";

async function setSessionCookie() {
  const u = auth.currentUser;
  if (!u) return false;
  const idToken = await u.getIdToken(true);
  const res = await fetch("/api/auth/session", {
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

  const inviteId = params.get("invite") || "";
  const token = params.get("token") || "";
  const [status, setStatus] = useState("Checking invite…");
  const [showSignOut, setShowSignOut] = useState(false);

  // So we can return here after signup/login if needed
  const returnUrl = useMemo(() => {
    if (typeof window === "undefined") return SELF_PATH;
    return `${window.location.pathname}${window.location.search}`;
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      // Require at least one identifier (token or invite)
      if (!token && !inviteId) {
        setStatus("Invalid invite link.");
        return;
      }

      // Not signed in? → go to signup as emergency_contact
      if (!user) {
        router.replace(
          `/signup?role=emergency_contact&next=${encodeURIComponent(returnUrl)}${
            token ? `&token=${encodeURIComponent(token)}` : ""
          }`
        );
        return;
      }

      // Ensure server session cookie exists before hitting the API
      await setSessionCookie();

      // Try to accept
      const tryAccept = async () => {
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

        // If 401, the cookie may not be set yet (or expired). Try once more.
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
          // Still unauthenticated → send to login as emergency_contact
          setStatus("Please sign in to accept the invite.");
          router.replace(
            `/login?role=emergency_contact&next=${encodeURIComponent(returnUrl)}${
              token ? `&token=${encodeURIComponent(token)}` : ""
            }`
          );
          return;
        }

        // 403: logged in but wrong role/email; ask to sign out and try again
        if (res.status === 403) {
          setShowSignOut(true);
          setStatus(
            "You’re signed in with an account that cannot accept this invite. Please sign out and sign in with the invited email."
          );
          return;
        }

        // Other errors: show message from server if present
        let msg = "Accept failed";
        try {
          const { error } = await res.json();
          if (error) msg = error;
        } catch {}
        setStatus(msg);
      };

      try {
        await tryAccept();
      } catch (e) {
        console.error(e);
        setStatus("Something went wrong while accepting the invite.");
      }
    });

    return () => unsub();
  }, [inviteId, token, returnUrl, router]);

  const handleSignOut = async () => {
    await signOut(auth);
    router.replace(
      `/login?role=emergency_contact&next=${encodeURIComponent(returnUrl)}${
        token ? `&token=${encodeURIComponent(token)}` : ""
      }`
    );
  };

  return (
    <main className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full space-y-3 text-center">
        <h1 className="text-2xl font-semibold">Accept Invitation</h1>
        <p>{status}</p>
        <div className="flex gap-2 justify-center">
          {showSignOut && (
            <Button variant="destructive" onClick={handleSignOut}>
              Sign out
            </Button>
          )}
          <Button onClick={() => router.replace("/")}>Go Home</Button>
        </div>
      </div>
    </main>
  );
}
