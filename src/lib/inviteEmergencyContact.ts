// src/lib/inviteEmergencyContact.ts
"use client";

/**
 * Client helper that calls the server route.
 * Server (Admin SDK) writes to Firestore and mail, bypassing security rules.
 */
export async function inviteEmergencyContact(input: {
  name?: string;
  email: string;
  phone?: string;     // ignored by server unless you added support
  relation?: string;  // e.g. "primary", "secondary"
}) {
  const res = await fetch("/api/emergency_contact/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || "Invite failed");
  }
  // data: { ok, inviteId, acceptUrl, verifyContinue, emergencyContactId, ... }
  return data;
}
