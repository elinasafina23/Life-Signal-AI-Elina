"use client";

import * as React from "react";

export type StatusType = "safe" | "missed" | "unknown";

export interface StatusCardProps {
  status: StatusType;
  nextCheckIn: Date | null;
  timeLeft: string;
  /** Last actual check-in time from Firestore (converted to Date) */
  lastCheckIn?: Date | null; // optional so existing usages don’t break
}

export function StatusCard({
  status,
  nextCheckIn,
  timeLeft,
  lastCheckIn = null,
}: StatusCardProps) {
  const formatTime = (date: Date) =>
    date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  return (
    <div className="p-4 bg-white rounded-2xl shadow-md">
      <h2 className="text-xl font-bold mb-2">Status</h2>

      {status === "unknown" && (
        <p className="text-gray-600">❓ No check-ins yet.</p>
      )}

      {status === "safe" && (
        <>
          <p className="text-green-600 font-semibold">✅ You’re safe</p>

          {lastCheckIn && (
            <p className="text-sm text-gray-600">
              Last check-in: {formatTime(lastCheckIn)}
            </p>
          )}

          {nextCheckIn && (
            <p className="text-sm text-gray-600">
              Next check-in: {formatTime(nextCheckIn)} ({timeLeft})
            </p>
          )}
        </>
      )}

      {status === "missed" && (
        <>
          <p className="text-red-600 font-semibold">⚠️ Check-in missed</p>

          {lastCheckIn && (
            <p className="text-sm text-gray-600">
              Last check-in: {formatTime(lastCheckIn)}
            </p>
          )}

          {nextCheckIn && (
            <p className="text-sm text-gray-600">
              Last was due: {formatTime(nextCheckIn)}
            </p>
          )}
        </>
      )}
    </div>
  );
}
