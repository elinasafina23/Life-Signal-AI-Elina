// src/lib/resendEmergencyContact.ts
"use client";

import type { InviteInput, InviteResponse, InviteRelation } from "./inviteEmergencyContact";

/** ---- Lightweight validators (same spirit as invite) ---- */
const isEmail = (v?: string) =>
  !!v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

/**
 * Resend an invite for an existing emergency contact.
 * Server route: /api/emergency_contact/invite/resend
 *
 * Mirrors the timeout/error handling style of inviteEmergencyContact.
 */
export async function resendEmergencyContact(
  input: Pick<InviteInput, "email" | "name" | "relation">,
  opts?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<InviteResponse> {
  // --- Basic validation (defense in depth) ---
  if (!isEmail(input.email)) {
    throw new Error("Please provide a valid email address.");
  }

  // --- Timeout handling (same pattern as invite) ---
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
      relation: (input.relation as InviteRelation) || undefined,
      role: "emergency_contact",
    };

    const res = await fetch("/api/emergency_contact/invite/resend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
      signal: signals.length === 1 ? signals[0] : controller.signal,
    });

    let data: InviteResponse | { error?: string } = {};
    try {
      data = (await res.json()) as any;
    } catch {
      // ok if server returns empty body; we’ll synthesize below
    }

    if (!res.ok) {
      const msg =
        (data as any)?.error ||
        `Resend failed (${res.status}${res.statusText ? `: ${res.statusText}` : ""})`;
      throw new Error(msg);
    }

    return (data as InviteResponse) ?? { ok: true };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error("Resend request timed out. Please try again.");
    }
    throw new Error(err?.message || "Resend failed");
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
