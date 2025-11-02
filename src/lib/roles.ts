// src/lib/roles.ts

/**
 * Canonical roles used across the app.
 * Keep this list as the single source of truth.
 */
export const ROLES = ['main_user', 'emergency-contact'] as const;

/**
 * TypeScript union type of the canonical roles above.
 * Example: const r: Role = 'main_user'
 */
export type Role = (typeof ROLES)[number];

/**
 * A lookup table that maps many human/URL variants to a canonical role.
 * Keys here must be in the same normalized form produced by normalizeRole():
 * - lowercased
 * - trimmed
 * - spaces/dashes -> underscores
 * - camelCase split to snake_case
 */
const alias: Record<string, Role> = {
  // Main user
  main_user: 'main_user',
  user: 'main_user',

  // Emergency contact
  emergency_contact: 'emergency-contact',
  'emergency-contact': 'emergency-contact', // included in case a pre-normalized value is passed
  caregiver: 'emergency-contact',
  carer: 'emergency-contact',
  contact: 'emergency-contact',
  ec: 'emergency-contact',
};

/**
 * Normalize an arbitrary string into a canonical Role.
 * - Returns 'main_user' | 'emergency-contact' for known inputs
 * - Returns null for unknown/empty inputs
 *
 * Steps:
 *  1) insert underscores between camelCase boundaries
 *  2) lowercase
 *  3) trim
 *  4) convert spaces/dashes to underscores
 */
export function normalizeRole(input?: string | null): Role | null {
  if (!input) return null;

  // 1) split camelCase: "mainUser" -> "main_User"
  const camelSplit = input.replace(/([a-z])([A-Z])/g, '$1_$2');

  // 2..4) lower, trim, spaces/dashes -> underscores
  const key = camelSplit.toLowerCase().trim().replace(/[\s-]+/g, '_');

  return alias[key] ?? null;
}

/**
 * Convenience helpers for quick checks.
 * These accept any string (or null) and compare after normalization.
 */
export const isMainUserRole = (r?: string | null) =>
  normalizeRole(r) === 'main_user';

export const isEmergencyContactRole = (r?: string | null) =>
  normalizeRole(r) === 'emergency-contact';
