export function sanitizePhone(raw: string | null | undefined): string {
  if (typeof raw !== "string") {
    return "";
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }

  let normalized = trimmed.replace(/[^\d+]/g, "");
  normalized = normalized.startsWith("+")
    ? `+${normalized.slice(1).replace(/\+/g, "")}`
    : normalized.replace(/\+/g, "");

  return normalized;
}

export function isValidE164Phone(raw: string | null | undefined): boolean {
  const sanitized = sanitizePhone(raw);
  if (!sanitized) {
    return false;
  }

  return /^\+[1-9]\d{7,14}$/.test(sanitized);
}
