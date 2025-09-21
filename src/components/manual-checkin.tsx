// src/components/manual-checkin.tsx
"use client"; // This component runs in the browser (Next.js App Router)

/* ---------------- React ---------------- */
import { useState } from "react"; // Local state for loading/error UI

/* ---------------- Firebase ---------------- */
import { auth, db } from "@/firebase"; // Your initialized client SDKs
import {
  addDoc,          // Create a brand-new document with a random ID
  collection,      // Get a reference to a collection
  doc,             // Get a reference to a specific document
  getDoc,          // Read a single document once
  serverTimestamp, // Let Firestore write the server time
  setDoc,          // Create/merge fields on a specific document
} from "firebase/firestore";

/* ---------------- Roles ---------------- */
import { normalizeRole } from "@/lib/roles"; // Normalizes strings to "main_user" | "emergency_contact"

/* ---------------- Types ---------------- */
type Status = "safe" | "missed" | "unknown"; // What the dashboard currently thinks

interface ManualCheckInProps {
  status: Status;             // Current status coming from parent (affects button look/label)
  onCheckedIn?: () => void;   // Optional callback once the write succeeds
}

/** Small helper: convert milliseconds → whole minutes since epoch (drops seconds). */
const toEpochMinutes = (ms: number) => Math.floor(ms / 60000);

/**
 * ManualCheckIn
 *
 * What it does when you click:
 *  1) Appends a check-in record to the flat collection /checkins (for history/analytics).
 *  2) Updates /users/{mainUserUid}:
 *     - lastCheckinAt: server time
 *     - dueAtMin: when the next check-in is due (minutes since epoch)
 *     - checkinEnabled: true (so the scheduler knows to include this user)
 *     - missedNotifiedAt: cleared (so we don’t keep showing “missed”)
 *
 * Safety rails:
 *  - If the signed-in account is an EMERGENCY CONTACT, we block this action.
 *    Only MAIN USERS can check in.
 */
export function ManualCheckIn({ status, onCheckedIn }: ManualCheckInProps) {
  const [loading, setLoading] = useState(false);      // True while we’re writing to Firestore
  const [errorMsg, setErrorMsg] = useState<string | null>(null); // Error message (if any)

  /** Click handler for the big “Check In” button. */
  const handleCheckIn = async () => {
    setErrorMsg(null);   // Clear any old error
    try {
      setLoading(true);  // Disable the button and show a spinner state

      // 1) Make sure the user is signed in.
      const user = auth.currentUser;                    // Firebase Auth’s current user
      if (!user) throw new Error("You must be signed in to check in."); // Guard
      const mainUserUid = user.uid;                     // Canonical ID for the main user

      // 2) Read this user’s profile to get their role and interval.
      const userRef = doc(db, "users", mainUserUid);    // Doc path: users/{mainUserUid}
      const snap = await getDoc(userRef);               // Read once
      const data = snap.data() || {};                   // Use empty object if doc missing

      // 3) Block EMERGENCY CONTACTS from checking in.
      //    We normalize the role to be safe against casing/undefined.
      const role = normalizeRole((data as any).role);
      if (role === "emergency_contact") {
        throw new Error("Emergency contacts cannot perform check-ins.");
      }

      // 4) Determine the current check-in interval in MINUTES.
      //    Fallback to 12h (720 min) if missing/invalid.
      const raw = Number((data as any).checkinInterval);
      const intervalMin = Number.isFinite(raw) && raw > 0 ? raw : 720;

      // 5) Append one row to a flat history collection for analytics/audits.
      //    We now store the field as mainUserUid (consistent naming).
      await addDoc(collection(db, "checkins"), {
        mainUserUid,               // who checked in (main user)
        createdAt: serverTimestamp(), // when (server time)
        status: "OK",              // your app can add other values later
        source: "manual",          // this was a manual click
      });

      // 6) Update the user’s current state:
      //    - lastCheckinAt: now (server side)
      //    - dueAtMin: next deadline for the scheduler (minutes since epoch)
      //    - checkinEnabled: true → scheduler will include this user
      //    - missedNotifiedAt: null → clear any old “missed” notification marker
      const now = Date.now();                      // Current client time (ms)
      const dueAtMin = toEpochMinutes(now) + intervalMin; // Next due time in minutes

      await setDoc(
        userRef,                                    // users/{mainUserUid}
        {
          checkinEnabled: true,                     // opt-in to scheduled checks
          lastCheckinAt: serverTimestamp(),         // authoritative “last check-in” time
          dueAtMin,                                 // next due time in minutes since epoch
          missedNotifiedAt: null,                   // clear any previous missed flag
        },
        { merge: true }                             // Don’t overwrite unrelated fields
      );

      // 7) Let the parent know we’re done (optional).
      onCheckedIn?.();
    } catch (e: any) {
      // Surface a friendly error to the UI and log the raw error for debugging.
      setErrorMsg(e?.message || "Failed to check in.");
      console.error(e);
    } finally {
      // Re-enable the button (success or fail).
      setLoading(false);
    }
  };

  /* ---------------- Button look/label driven by current status ---------------- */
  const base =
    "w-40 h-40 rounded-full text-white text-xl font-bold flex items-center justify-center transition-colors duration-300"; // big round CTA
  const variant =
    status === "safe"
      ? "bg-green-500 hover:bg-green-600"                    // already safe → green
      : status === "missed"
      ? "bg-blue-500 hover:bg-blue-600 animate-pulse"        // overdue → attention
      : "bg-blue-400 hover:bg-blue-500";                     // unknown → neutral blue

  const label =
    loading
      ? "..."                                                // writing…
      : status === "safe"
      ? "✅ Safe"                                            // already checked in
      : status === "missed"
      ? "Check In Now"                                       // overdue → call to action
      : "Check In";                                          // neutral

  /* ---------------- Render ---------------- */
  return (
    <div className="flex flex-col items-center gap-3">
      <button
        onClick={handleCheckIn}          // Run the logic above
        disabled={loading}               // Prevent double-click while saving
        className={`${base} ${variant}`} // Visual style
        aria-busy={loading}              // Accessibility: screen readers know it’s busy
      >
        {label}
      </button>

      {/* If an error occurred, show it below the button. */}
      {errorMsg && (
        <p role="alert" className="text-sm text-red-600">
          {errorMsg}
        </p>
      )}
    </div>
  );
}
