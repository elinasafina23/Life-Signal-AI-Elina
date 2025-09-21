"use client";

import { useState } from "react";
import { auth, db } from "@/firebase";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";

type Status = "safe" | "missed" | "unknown";

interface ManualCheckInProps {
  status: Status;
  /** Optional: fires after a successful write */
  onCheckedIn?: () => void;
}

/** Convert ms epoch to whole minutes (drops seconds). */
const toEpochMinutes = (ms: number) => Math.floor(ms / 60000);

/**
 * ManualCheckIn
 * - Appends a check-in to /checkins
 * - Updates /users/{uid}.lastCheckinAt
 * - Maintains /users/{uid}.dueAtMin so the scheduler can query only due users
 * - 🚫 Guards against emergency-contact accounts writing check-in fields
 */
export function ManualCheckIn({ status, onCheckedIn }: ManualCheckInProps) {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleCheckIn = async () => {
    setErrorMsg(null);
    try {
      setLoading(true);

      const user = auth.currentUser;
      if (!user) throw new Error("You must be signed in to check in.");
      const uid = user.uid;

      // Read user to get interval and account type
      const userRef = doc(db, "users", uid);
      const snap = await getDoc(userRef);
      const data = snap.data() || {};

      // 🚫 Guard: emergency-contact accounts cannot check in
      if (data.accountType === "contact") {
        throw new Error("This account is an emergency contact and cannot check in.");
      }

      // Interval (fallback: 12h = 720 minutes)
      const intervalMin =
        Number(data.checkinInterval) > 0 ? Number(data.checkinInterval) : 720;

      // 1) Append to history (flat collection)
      await addDoc(collection(db, "checkins"), {
        userId: uid,
        createdAt: serverTimestamp(), // Firestore Timestamp
        status: "OK",                 // customize if you track other states
        source: "manual",
      });

      // 2) Update latest time + keep dueAtMin current for the scheduler
      const now = Date.now();
      const dueAtMin = toEpochMinutes(now) + intervalMin;

      await setDoc(
        userRef,
        {
          checkinEnabled: true,             // ensures the scheduler includes this user
          lastCheckinAt: serverTimestamp(), // canonical "last check-in" time
          dueAtMin,                         // minutes since epoch when next check-in is due
          // optional: clear any "missed" flag on the user
          missedNotifiedAt: null,
        },
        { merge: true }
      );

      onCheckedIn?.();
    } catch (e: any) {
      setErrorMsg(e?.message || "Failed to check in.");
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  // Dynamic button styles
  const base =
    "w-40 h-40 rounded-full text-white text-xl font-bold flex items-center justify-center transition-colors duration-300";
  const variant =
    status === "safe"
      ? "bg-green-500 hover:bg-green-600"
      : status === "missed"
      ? "bg-blue-500 hover:bg-blue-600 animate-pulse"
      : "bg-blue-400 hover:bg-blue-500";

  const label =
    loading ? "..." : status === "safe" ? "✅ Safe" : status === "missed" ? "Check In Now" : "Check In";

  return (
    <div className="flex flex-col items-center gap-3">
      <button
        onClick={handleCheckIn}
        disabled={loading}
        className={`${base} ${variant}`}
        aria-busy={loading}
      >
        {label}
      </button>
      {errorMsg && (
        <p role="alert" className="text-sm text-red-600">
          {errorMsg}
        </p>
      )}
    </div>
  );
}
