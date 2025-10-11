const NON_DIGIT_REGEX = /[^\d]/g;

type PhoneLike = string | number | null | undefined;

function normalizePhoneForLink(phone: PhoneLike) {
  if (phone == null) return null;

  const trimmed = String(phone).trim();
  if (!trimmed) return null;

  const hasPlus = trimmed.startsWith("+");
  const digitsOnly = trimmed.replace(NON_DIGIT_REGEX, "");
  if (!digitsOnly) return null;

  return hasPlus ? `+${digitsOnly}` : digitsOnly;
}

function buildHref(protocol: "tel" | "sms", phone: PhoneLike) {
  const normalized = normalizePhoneForLink(phone);
  return normalized ? `${protocol}:${normalized}` : null;
}

export function getTelHref(phone: PhoneLike) {
  return buildHref("tel", phone);
}

export function getSmsHref(phone: PhoneLike) {
  return buildHref("sms", phone);
}
