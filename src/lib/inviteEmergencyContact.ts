// src/lib/inviteEmergencyContact.ts
"use client";

/** ---- Types ---- */
export type InviteRelation = "primary" | "secondary" | string;

export interface InviteInput {
  name?: string;
  email: string;
  phone?: string;      // optional; must be E.164 if provided
  relation?: InviteRelation;
}

export interface InviteResponse {
  ok: boolean;
  inviteId?: string;
  acceptUrl?: string;
  verifyContinue?: string;
  emergencyContactId?: string;
  [k: string]: unknown;
}

/** ---- Lightweight validators (UI should already enforce these) ---- */
const isEmail = (v?: string) =>
  !!v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

/** Telnyx-friendly E.164: + and 7–14 more digits (8–15 digits total). */
const isE164 = (v?: string) =>
  !!v && /^\+[1-9]\d{7,14}$/.test(v.trim());

/** Keep one leading + and digits only; drop spaces/dashes/parens. */
function sanitizePhone(raw?: string) {
  if (!raw) return raw;
  const trimmed = raw.trim();
  let s = trimmed.replace(/[^\d+]/g, "");
  s = s[0] === "+" ? ("+" + s.slice(1).replace(/\+/g, "")) : s.replace(/\+/g, "");
  return s;
}

/**
 * Client helper that calls the server route.
 * The server (Admin SDK) writes to Firestore and mail, bypassing security rules.
 *
 * @param input - Contact info; phone is optional but must be E.164 if present.
 * @param opts  - Optional signal/timeout overrides
 */
export async function inviteEmergencyContact(
  input: InviteInput,
  opts?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<InviteResponse> {
  // --- Basic validation (defense in depth; UI should validate too) ---
  if (!isEmail(input.email)) {
    throw new Error("Please provide a valid email address.");
  }

  const sanitizedPhone = sanitizePhone(input.phone);
  if (sanitizedPhone && !isE164(sanitizedPhone)) {
    throw new Error("Phone must include country code (E.164), e.g. +15551234567.");
  }

  // --- Timeout handling ---
  const controller = new AbortController();
  const signals: AbortSignal[] = [];
  if (opts?.signal) signals.push(opts.signal);
  signals.push(controller.signal);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = Math.max(0, opts?.timeoutMs ?? 15000);
  if (timeoutMs) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const payload: Record<string, unknown> = {
      name: (input.name || "").trim() || undefined,
      email: input.email.trim(),
      relation: input.relation || undefined,
      // only include phone if present & valid
      ...(sanitizedPhone ? { phone: sanitizedPhone } : {}),
    };

    const res = await fetch("/api/emergency_contact/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
      signal: signals.length === 1 ? signals[0] : controller.signal,
    });

    // Try to parse JSON either way for richer errors
    let data: InviteResponse | { error?: string } = {};
    try {
      data = (await res.json()) as any;
    } catch {
      // ignore parse error; we'll synthesize a message below
    }

    if (!res.ok) {
      const msg =
        (data as any)?.error ||
        `Invite failed (${res.status}${res.statusText ? `: ${res.statusText}` : ""})`;
      throw new Error(msg);
    }

    return (data as InviteResponse) ?? { ok: true };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error("Invite request timed out. Please try again.");
    }
    throw new Error(err?.message || "Invite failed");
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
