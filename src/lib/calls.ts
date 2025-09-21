// src/lib/calls.ts

/**
 * Shape of the request your API expects.
 * You can provide either a `token` (from the email link) OR an explicit `inviteId`.
 */
export type AcceptEmergencyInviteInput = {
  token?: string;          // e.g. "...?token=abcdef"
  inviteId?: string;       // alternatively: known invite doc id
};

/**
 * What the API returns on success.
 * We standardized on `mainUserUid` everywhere.
 */
export type AcceptEmergencyInviteOutput = {
  ok: true;
  mainUserUid: string;             // the main user you’re now linked to
  alreadyAccepted?: boolean;       // optional: true if you had accepted before
};

/**
 * Small helper to turn a non-2xx fetch() into a readable Error with a message.
 */
async function raiseForBadResponse(res: Response): Promise<never> {
  let message = `Request failed (${res.status})`;
  try {
    const data = await res.json();
    if (data?.error) message = data.error as string;
  } catch {
    // ignore JSON parse errors; keep default message
  }
  throw new Error(message);
}

/**
 * Accept an emergency-contact invite by calling your API route.
 *
 * - Sends the browser session cookie (credentials: 'include')
 * - Supports quick navigations (keepalive: true)
 * - Throws a friendly Error if the server responds with an error
 */
export async function acceptEmergencyInvite(
  input: AcceptEmergencyInviteInput
): Promise<AcceptEmergencyInviteOutput> {
  // Basic guard: caller must pass at least one identifier
  if (!input.token && !input.inviteId) {
    throw new Error("Provide an invite token or inviteId.");
  }

  const res = await fetch("/api/emergency_contact/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",         // include __session cookie
    body: JSON.stringify(input),
    // If the caller redirects right after calling this, keepalive helps the
    // request still complete in the background (best-effort).
    keepalive: true,
  });

  if (!res.ok) {
    await raiseForBadResponse(res);
  }

  // Success → return the parsed, typed payload
  const data = (await res.json()) as AcceptEmergencyInviteOutput;

  // (Optional) Light sanity check to help catch backend mismatches during dev
  if (!data?.ok || !data?.mainUserUid) {
    throw new Error("Unexpected response from server.");
  }

  return data;
}
