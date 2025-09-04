// src/lib/roles.ts
export const ROLES = ['main_user', 'emergency_contact'] as const;
export type Role = (typeof ROLES)[number];

// Map aliases -> canonical value
const alias: Record<string, Role> = {
  main_user: 'main_user',
  'main-user': 'main_user',
  'main user': 'main_user',
  user: 'main_user',
  mainUser: 'main_user',

  emergency_contact: 'emergency_contact',
  'emergency-contact': 'emergency_contact',
  'emergency contact': 'emergency_contact',
  caregiver: 'emergency_contact',
  carer: 'emergency_contact',
  contact: 'emergency_contact',
};

export function normalizeRole(input?: string | null): Role | null {
  if (!input) return null;
  // unify separators so "emergency-contact" / "emergency contact" become "emergency_contact"
  const key = input.toLowerCase().trim().replace(/[\s-]+/g, '_');
  return alias[key] ?? null;
}

export const isMainUserRole = (r?: string | null) =>
  normalizeRole(r) === 'main_user';

export const isEmergencyContactRole = (r?: string | null) =>
  normalizeRole(r) === 'emergency_contact';
