// app/caregiver/accept/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { auth, db } from "@/firebase";
import { doc, getDoc, setDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";
import { Button } from "@/components/ui/button";

function normalizeEmail(e?: string | null) {
  const v = (e || "").trim().toLowerCase();
  const [local = "", domain = ""] = v.split("@");
  if (domain === "gmail.com" || domain === "googlemail.com") {
    const clean = local.split("+")[0].replace(/\./g, "");
    return `${clean}@gmail.com`;
  }
  return v;
}

export default function CaregiverAcceptPage() {
  const params = useSearchParams();
  const router = useRouter();

  const inviteId = params.get("invite") || "";
  const tokenFromLink = params.get("token") || "";
  const [status, setStatus] = useState("Checking invite…");

  // so we can return here after signup if needed
  const returnUrl = useMemo(() => {
    if (typeof window === "undefined") return "/caregiver/accept";
    return `${window.location.pathname}${window.location.search}`;
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!inviteId || !tokenFromLink) {
        setStatus("Invalid invite link.");
        return;
      }

      // Must be signed in; send to caregiver signup (include role=caregiver)
      if (!user) {
        router.replace(`/signup?role=caregiver&next=${encodeURIComponent(returnUrl)}`);
        return;
      }

      // No email verification gate for caregivers (per your flow)

      try {
        // 1) read invite
        const inviteRef = doc(db, "invites", inviteId);
        const snap = await getDoc(inviteRef);
        if (!snap.exists()) {
          setStatus("Invite not found.");
          return;
        }
        const inv = snap.data() as any;

        // 2) validate token + status
        if (inv.status !== "pending") {
          setStatus("Invite already used or revoked.");
          return;
        }
        if (inv.token && inv.token !== tokenFromLink) {
          setStatus("Invite token mismatch.");
          return;
        }

        // 3) email must match invited email (normalized)
        const invitedEmail = normalizeEmail(inv.caregiverEmail);
        const signedInEmail = normalizeEmail(user.email || "");
        if (!invitedEmail) {
          setStatus("Invite is missing the recipient email. Please contact support.");
          return;
        }
        if (invitedEmail !== signedInEmail) {
          setStatus("This invite was sent to a different email address.");
          router.replace(`/signup?role=caregiver&next=${encodeURIComponent(returnUrl)}`);
          return;
        }

        // 4) create caregiver link ONCE (include extra fields you want to display)
        const caregiverRef = doc(db, "users", inv.userId, "caregivers", user.uid);
        await setDoc(caregiverRef, {
          caregiverEmail: signedInEmail,
          inviteId,
          token: inv.token,          // required by your rules
          userId: inv.userId,        // helpful for dashboard
          patientName: inv.patientName || "", // optional (populate when creating invite)
          createdAt: serverTimestamp(),
        });

        // 5) mark invite accepted
        await updateDoc(inviteRef, {
          status: "accepted",
          acceptedAt: serverTimestamp(),
          token: inv.token,
        });

        setStatus("Invite accepted! Redirecting…");
        router.replace("/emergency-dashboard"); // caregiver landing
      } catch (e: any) {
        console.error(e);
        setStatus("Missing or insufficient permissions. Make sure you’re signed in with the invited email.");
      }
    });

    return () => unsub();
  }, [inviteId, tokenFromLink, returnUrl, router]);

  return (
    <main className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full space-y-3 text-center">
        <h1 className="text-2xl font-semibold">Accept Invitation</h1>
        <p>{status}</p>
        <div className="flex justify-center">
          <Button onClick={() => router.replace("/")}>Go Home</Button>
        </div>
      </div>
    </main>
  );
}
