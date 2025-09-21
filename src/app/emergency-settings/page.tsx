// app/emergency-settings/page.tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "@/firebase";
import { doc, getDoc } from "firebase/firestore";
import { normalizeRole } from "@/lib/roles";
import EmergencyContactSettingsDialog from "@/components/EmergencyContactSettingsDialog";

export default function EmergencySettingsPage() {
  const router = useRouter();

  // ✅ canonical id for the signed-in emergency contact
  const [emergencyContactUid, setEmergencyContactUid] = useState<string | null>(null);

  // open dialog on page load
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace(
          `/login?role=emergency_contact&next=${encodeURIComponent("/emergency-settings")}`
        );
        return;
      }

      // ✅ gate access by role
      try {
        const meSnap = await getDoc(doc(db, "users", user.uid));
        const myRole = normalizeRole(meSnap.exists() ? (meSnap.data() as any).role : undefined);
        if (myRole !== "emergency_contact") {
          router.replace("/dashboard");
          return;
        }
      } catch {
        router.replace(
          `/login?role=emergency_contact&next=${encodeURIComponent("/emergency-settings")}`
        );
        return;
      }

      setEmergencyContactUid(user.uid);
    });

    return () => unsub();
  }, [router]);

  return (
    <div className="min-h-screen bg-secondary">
      {emergencyContactUid && (
        <EmergencyContactSettingsDialog
          // ✅ renamed prop to canonical name
          emergencyContactUid={emergencyContactUid}
          open={open}
          onOpenChange={(v) => {
            setOpen(v);
            if (!v) router.push("/emergency-dashboard");
          }}
        />
      )}
    </div>
  );
}
