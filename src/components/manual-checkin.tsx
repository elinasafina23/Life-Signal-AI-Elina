// src/components/manual-checkin.tsx
"use client";

import { useState } from "react";
import { auth, db } from "@/firebase";
import {
  addDoc,
  collection,
  doc,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";

type Status = "safe" | "missed" | "unknown";

interface ManualCheckInProps {
  status: Status;
  /** Optional: show a spinner/message while writing */
  onCheckedIn?: () => void;
}

/**
 * ManualCheckIn
 * - Appends a check-in to the flat `/checkins` collection
 * - Also denormalizes the latest time onto `/users/{uid}.lastCheckinAt`
 * - Named export to match `import { ManualCheckIn } from "@/components/manual-checkin"`
 */
export function ManualCheckIn({ status, onCheckedIn }: ManualCheckInProps) {
  const [loading, setLoading] = useState(false);

  const handleCheckIn = async () => {
    try {
      setLoading(true);

      const user = auth.currentUser;
      if (!user) return;
      const uid = user.uid;

      // 1) Append to history (flat collection)
      await addDoc(collection(db, "checkins"), {
        userId: uid,
        createdAt: serverTimestamp(), // Firestore Timestamp
        status: "OK",                 // or whatever status you want to store
        source: "manual",
      });

      // 2) Denormalize latest time for cheap dashboard reads
      await setDoc(
        doc(db, "users", uid),
        { lastCheckinAt: serverTimestamp() },
        { merge: true }
      );

      onCheckedIn?.();
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
    <button
      onClick={handleCheckIn}
      disabled={loading}
      className={`${base} ${variant}`}
      aria-busy={loading}
    >
      {label}
    </button>
  );
}
