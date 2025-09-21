// src/components/StatusCard.tsx
"use client"; // This component renders on the client (Next.js App Router)

import * as React from "react";

/** Allowed status values your UI understands. */
export type StatusType = "safe" | "missed" | "unknown";

/** Props the card needs from its parent. */
export interface StatusCardProps {
  /** Current status of the main user. */
  status: StatusType;
  /** When the next check-in is scheduled (null if not known). */
  nextCheckIn: Date | null;
  /** Human-friendly countdown string (e.g., "12m 03s left"). */
  timeLeft: string;
  /** Most recent check-in time (optional so old usage doesn’t break). */
  lastCheckIn?: Date | null;
}

/**
 * StatusCard
 *  - Shows current status (Safe / Missed / Unknown)
 *  - Optionally shows last and next check-in times
 *  - Uses aria-live to announce status changes for accessibility
 */
export function StatusCard({
  status,
  nextCheckIn,
  timeLeft,
  lastCheckIn = null,
}: StatusCardProps) {
  /**
   * Format a Date into a short, readable string.
   * Example: "Jan 3, 5:24 PM"
   * NOTE: We guard against invalid Dates just in case.
   */
  const formatTime = (date: Date) => {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  /** Small helpers to keep JSX clean. */
  const hasNext = nextCheckIn instanceof Date && !Number.isNaN(nextCheckIn?.getTime?.());
  const hasLast = lastCheckIn instanceof Date && !Number.isNaN(lastCheckIn?.getTime?.());

  return (
    // role="status" + aria-live helps assistive tech announce updates as they happen.
    <div
      className="p-4 bg-white rounded-2xl shadow-md"
      role="status"
      aria-live="polite"
    >
      {/* Card heading */}
      <h2 className="text-xl font-bold mb-2">Status</h2>

      {/* Unknown: nothing scheduled or no check-ins yet */}
      {status === "unknown" && (
        <p className="text-gray-600">❓ No check-ins yet.</p>
      )}

      {/* Safe: we show last check-in and the upcoming one with countdown */}
      {status === "safe" && (
        <>
          <p className="text-green-600 font-semibold">✅ You’re safe</p>

          {hasLast && (
            <p className="text-sm text-gray-600">
              Last check-in: {formatTime(lastCheckIn!)}
            </p>
          )}

          {hasNext && (
            <p className="text-sm text-gray-600">
              Next check-in: {formatTime(nextCheckIn!)}
              {/* Only show parentheses if we actually have a timeLeft string */}
              {timeLeft ? ` (${timeLeft})` : ""}
            </p>
          )}
        </>
      )}

      {/* Missed: nextCheckIn here represents the deadline that was missed */}
      {status === "missed" && (
        <>
          <p className="text-red-600 font-semibold">⚠️ Check-in missed</p>

          {hasLast && (
            <p className="text-sm text-gray-600">
              Last check-in: {formatTime(lastCheckIn!)}
            </p>
          )}

          {hasNext && (
            <p className="text-sm text-gray-600">
              Last was due: {formatTime(nextCheckIn!)}
            </p>
          )}
        </>
      )}
    </div>
  );
}
