// src/lib/roles.ts

/**
 * Canonical roles used across the app.
 * Keep this list as the single source of truth.
 */
export const ROLES = ['main_user', 'emergency_contact'] as const;

/**
 * TypeScript union type of the canonical roles above.
 * Example: const r: Role = 'main_user'
 */
export type Role = (typeof ROLES)[number];

/**
 * A lookup table that maps many human/URL variants to a canonical role.
 * This lets us accept inputs like "main-user", "user", "caregiver", etc.
 */
const alias: Record<string, Role> = {
  // Main user
  main_user: 'main_user',
  'main-user': 'main_user',
  'main user': 'main_user',
  user: 'main_user',
  mainUser: 'main_user',

  // Emergency contact
  emergency_contact: 'emergency_contact',
  'emergency-contact': 'emergency_contact',
  'emergency contact': 'emergency_contact',
  caregiver: 'emergency_contact',
  carer: 'emergency_contact',
  contact: 'emergency_contact',
};

/**
 * Normalize an arbitrary string into a canonical Role.
 * - Returns 'main_user' | 'emergency_contact' for known inputs
 * - Returns null for unknown/empty inputs
 *
 * We:
 *  1) lowercase the input,
 *  2) trim whitespace,
 *  3) convert spaces/dashes to underscores,
 *  4) look it up in the alias table.
 */
export function normalizeRole(input?: string | null): Role | null {
  if (!input) return null;
  const key = input.toLowerCase().trim().replace(/[\s-]+/g, '_');
  return alias[key] ?? null;
}

/**
 * Convenience helpers for quick checks.
 * These accept any string (or null) and compare after normalization.
 */
export const isMainUserRole = (r?: string | null) =>
  normalizeRole(r) === 'main_user';

export const isEmergencyContactRole = (r?: string | null) =>
  normalizeRole(r) === 'emergency_contact';
