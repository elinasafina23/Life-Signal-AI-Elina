export const EMERGENCY_SERVICE_COUNTRY_VALUES = [
  "US",
  "CA",
  "MX",
  "BR",
  "GB",
  "EU",
  "AU",
  "NZ",
  "IN",
] as const;

export type EmergencyServiceCountryCode =
  (typeof EMERGENCY_SERVICE_COUNTRY_VALUES)[number];

interface EmergencyServiceDetails {
  label: string;
  dial: string;
}

const EMERGENCY_SERVICE_DETAILS: Record<
  EmergencyServiceCountryCode,
  EmergencyServiceDetails
> = {
  US: { label: "United States / Canada", dial: "911" },
  CA: { label: "Canada", dial: "911" },
  MX: { label: "Mexico", dial: "911" },
  BR: { label: "Brazil", dial: "190" },
  GB: { label: "United Kingdom", dial: "999" },
  EU: { label: "European Union", dial: "112" },
  AU: { label: "Australia", dial: "000" },
  NZ: { label: "New Zealand", dial: "111" },
  IN: { label: "India", dial: "112" },
};

export const EMERGENCY_SERVICE_OPTIONS =
  EMERGENCY_SERVICE_COUNTRY_VALUES.map((code) => ({
    code,
    ...EMERGENCY_SERVICE_DETAILS[code],
  }));

export const DEFAULT_EMERGENCY_SERVICE_COUNTRY: EmergencyServiceCountryCode = "US";

export function getEmergencyService(
  country?: string | null
): EmergencyServiceDetails & { code: EmergencyServiceCountryCode } {
  const normalized = (country || "").toUpperCase() as EmergencyServiceCountryCode;
  if (EMERGENCY_SERVICE_DETAILS[normalized]) {
    return { code: normalized, ...EMERGENCY_SERVICE_DETAILS[normalized] };
  }
  return {
    code: DEFAULT_EMERGENCY_SERVICE_COUNTRY,
    ...EMERGENCY_SERVICE_DETAILS[DEFAULT_EMERGENCY_SERVICE_COUNTRY],
  };
}
