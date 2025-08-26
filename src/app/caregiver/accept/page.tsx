// app/caregiver/accept/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { auth, db } from "@/firebase";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
} from "firebase/firestore";
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
        router.replace(
          `/signup?role=caregiver&next=${encodeURIComponent(returnUrl)}`
        );
        return;
      }

      try {
        // 1) Read invite
        const inviteRef = doc(db, "invites", inviteId);
        const snap = await getDoc(inviteRef);
        if (!snap.exists()) {
          setStatus("Invite not found.");
          return;
        }
        const inv = snap.data() as any;

        // 2) Validate token + status
        if (inv.status !== "pending") {
          setStatus("Invite already used or revoked.");
          return;
        }
        if (inv.token && inv.token !== tokenFromLink) {
          setStatus("Invite token mismatch.");
          return;
        }

        // 3) Email must match invited email (normalized)
        const invitedEmail = normalizeEmail(inv.caregiverEmail);
        const signedInEmail = normalizeEmail(user.email || "");
        if (!invitedEmail) {
          setStatus(
            "Invite is missing the recipient email. Please contact support."
          );
          return;
        }
        if (invitedEmail !== signedInEmail) {
          setStatus(
            "This invite was sent to a different email address. Please sign in with the invited email."
          );
          router.replace(
            `/signup?role=caregiver&next=${encodeURIComponent(returnUrl)}`
          );
          return;
        }

        // 4) Enrich from the main user's profile (optional)
        const mainUid = inv.userId as string;
        const caregiverUid = user.uid;

        let patientName = inv.patientName || "";
        let patientAvatar = "";
        try {
          const mainRef = doc(db, "users", mainUid);
          const mainSnap = await getDoc(mainRef);
          if (mainSnap.exists()) {
            const m = mainSnap.data() as any;
            patientName = patientName || m.displayName || m.name || "";
            patientAvatar = m.photoURL || m.avatar || "";
          }
        } catch {
          // ok if this fails—link will still be created
        }

        // 5) Create/merge the caregiver link the dashboard expects:
        //    Path: /users/{mainUid}/caregivers/{caregiverUid}
        //    REQUIRED FIELD for dashboard: uid (caregiver uid)
        const linkRef = doc(db, "users", mainUid, "caregivers", caregiverUid);
        const linkSnap = await getDoc(linkRef);

        if (!linkSnap.exists()) {
          await setDoc(linkRef, {
            uid: caregiverUid, // <-- Dashboard filters on this field
            caregiverEmail: signedInEmail,
            inviteId,
            token: inv.token, // keep if your rules require it
            userId: mainUid,
            patientName: patientName || "",
            patientAvatar: patientAvatar || "",
            createdAt: serverTimestamp(),
          });
        } else {
          await updateDoc(linkRef, {
            uid: caregiverUid, // ensure it's present
            caregiverEmail: signedInEmail,
            token: inv.token,
            userId: mainUid,
            patientName: patientName || "",
            patientAvatar: patientAvatar || "",
            updatedAt: serverTimestamp(),
          });
        }

        // 6) Mark invite accepted
        await updateDoc(inviteRef, {
          status: "accepted",
          acceptedAt: serverTimestamp(),
          acceptedBy: caregiverUid,
          token: inv.token,
        });

        setStatus("Invite accepted! Redirecting…");
        router.replace("/emergency-dashboard"); // caregiver landing
      } catch (e: any) {
        console.error(e);
        setStatus(
          "Missing or insufficient permissions. Make sure you’re signed in with the invited email."
        );
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
