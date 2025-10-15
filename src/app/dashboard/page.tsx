// src/app/dashboard/page.tsx
"use client"; // ➊ Mark this file as a client component (uses browser APIs/hooks)

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"; // ➋ React + hooks
import { // ➌ Firestore functions used for realtime and updates
  onSnapshot,
  doc,
  Timestamp,
  setDoc,
  updateDoc,
  serverTimestamp,
  deleteField,
} from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth"; // ➍ Auth state observer
import { useRouter } from "next/navigation"; // ➎ Router (App Router)
import { auth, db } from "@/firebase"; // ➏ Client Firebase (Auth + Firestore)

import { Header } from "@/components/header"; // ➐ Top nav
import { Footer } from "@/components/footer"; // ➑ Footer
import { VoiceCheckIn } from "@/components/voice-check-in"; // ➒ Voice recording widget
import { AskAiAssistant } from "@/components/ask-ai-assistant"; // ➓ Ask-AI widget
import { EmergencyContacts } from "@/components/emergency-contact"; // ⓫ EC panel
import { useSosDialer } from "@/hooks/useSosDialer"; // ⓬ Press-and-hold SOS dialer
import { // ⓭ Emergency numbers lookup
  DEFAULT_EMERGENCY_SERVICE_COUNTRY,
  EmergencyServiceCountryCode,
  getEmergencyService,
} from "@/constants/emergency-services";

// shadcn/ui
import { Button } from "@/components/ui/button"; // ⓮ Buttons
import { Input } from "@/components/ui/input"; // ⓯ Input
import { Label } from "@/components/ui/label"; // ⓰ Label
import { // ⓱ Card primitives
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { // ⓲ Select primitives
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { // ⓳ Dialog primitives
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator"; // ⓴ Divider
import { useToast } from "@/hooks/use-toast"; // ㉑ Toast notifications

// icons
import { Siren, CheckCircle2, PhoneCall, Clock, Mic } from "lucide-react"; // ㉒ Icons

// roles
import { normalizeRole } from "@/lib/roles"; // ㉓ Role alias normalizer

// push device registration
import { registerDevice } from "@/lib/useFcmToken"; // ㉔ FCM device registration
import { isValidE164Phone, sanitizePhone } from "@/lib/phone"; // ㉕ Phone helpers

// ㉖ Shape for the embedded emergency contacts block stored on user doc
interface EmergencyContactsData {
  contact1_firstName?: string;
  contact1_lastName?: string;
  contact1_email?: string;
  contact1_phone?: string;
  emergencyServiceCountry?: EmergencyServiceCountryCode;
  contact2_firstName?: string;
  contact2_lastName?: string;
  contact2_email?: string;
  contact2_phone?: string;
}

// ㉗ User document shape (subset)
interface UserDoc {
  lastCheckinAt?: Timestamp;
  checkinInterval?: number | string; // minutes
  locationSharing?: boolean;
  sosTriggeredAt?: Timestamp;
  role?: string;
  locationShareReason?: LocationShareReason | null;
  locationSharedAt?: Timestamp;
  missedNotifiedAt?: Timestamp | null;
  emergencyContacts?: EmergencyContactsData;
  phone?: string;
}

// ㉘ Local types for UI state
type Status = "safe" | "missed" | "unknown";
type LocationShareReason = "sos" | "escalation";

type VoiceMessageTarget = {
  name: string;
  email?: string | null;
  phone?: string | null;
};

// ㉙ Route alias for emergency dashboard (kept aligned with roles)
const EMERGENCY_DASH = "/emergency-dashboard";

// ㉚ Helper to compute minutes since epoch for dueAtMin
const toEpochMinutes = (ms: number) => Math.floor(ms / 60000);

// ㉛ Selectable check-in hours
const HOURS_OPTIONS = [1, 2, 3, 6, 10, 12, 18, 24] as const;
// ㉜ Throttle sharing identical reasons
const LOCATION_SHARE_COOLDOWN_MS = 60_000;
// ㉝ Geolocation error codes
const GEO_PERMISSION_DENIED = 1;
const GEO_POSITION_UNAVAILABLE = 2;
const GEO_TIMEOUT = 3;

// ㉞ Base classes used by most primary cards
//     - add `overflow-hidden` so inner elements never spill outside on resize
//     - remove hard aspect locking on small screens to avoid tall cards
const PRIMARY_CARD_BASE_CLASSES =
  "flex overflow-hidden min-h-[18rem] flex-col shadow-lg transition-shadow hover:shadow-xl";
// ㉟ Shared header text styles
const PRIMARY_CARD_HEADER_CLASSES = "space-y-3 text-center";
// ㊱ Large title style
const PRIMARY_CARD_TITLE_CLASSES = "text-3xl font-headline font-semibold";
// ㊲ Description style
const PRIMARY_CARD_DESCRIPTION_CLASSES = "text-lg text-muted-foreground";

// ㊳ Convert Geolocation errors to friendly copy
function describeGeoError(error: unknown) {
  const defaultMessage =
    "We couldn't access your current location. Please enable location services and try again.";

  if (!error || typeof error !== "object") return defaultMessage;

  const maybeGeo = error as { code?: number; message?: string };
  if (typeof maybeGeo.code === "number") {
    switch (maybeGeo.code) {
      case GEO_PERMISSION_DENIED:
        return "Location permission was denied. Please enable it in your browser settings and try again.";
      case GEO_POSITION_UNAVAILABLE:
        return "Your device couldn't determine your location. Try moving somewhere with a clearer signal and try again.";
      case GEO_TIMEOUT:
        return "Locating you took too long. Try again from an area with better reception.";
      default:
        break;
    }
  }

  if (typeof maybeGeo.message === "string" && maybeGeo.message.trim().length > 0) {
    return maybeGeo.message;
  }

  return defaultMessage;
}

/**
 * ㊴ Check geolocation permission without prompting.
 *     Returns true | "prompt" | false
 */
async function ensureGeoAllowed(): Promise<true | false | "prompt"> {
  if (typeof window === "undefined") return false; // SSR guard
  if (!("geolocation" in navigator)) return false; // API missing

  const navAny = navigator as any;
  if (!navAny.permissions?.query) return true; // No Permissions API → assume ok

  try {
    const status: PermissionStatus = await navAny.permissions.query(
      { name: "geolocation" as PermissionName }
    );
    if (status.state === "granted") return true; // granted
    if (status.state === "prompt") return "prompt"; // will prompt on call
    return false; // denied
  } catch {
    return true; // fail-open to avoid blocking
  }
}

/** ㊵ Call your Cloud Function via a Next.js proxy (hides origin + CORS). */
async function triggerServerTelnyxCall(params: {
  to?: string;                 // optional; omit to let server look up ACTIVE EC
  mainUserUid?: string;
  emergencyContactUid?: string;
}) {
  const url = "/api/sos/call-server"; // Proxy endpoint

  // Try to attach a Firebase ID token for server verification (optional).
  let authHeader: Record<string, string> = {};
  try {
    const token = await auth.currentUser?.getIdToken();
    if (token) authHeader = { Authorization: `Bearer ${token}` };
  } catch {
    /* non-fatal */
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader },
    body: JSON.stringify({ reason: "sos", ...params }),
    cache: "no-store",
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || "Server failed to place Telnyx call");
  }
  return data;
}

// ㊶ Main page component
export default function DashboardPage() {
  const router = useRouter(); // ㊷ Router for redirects
  const { toast } = useToast(); // ㊸ Toast API

  // ㊹ User state (check-in)
  const [lastCheckIn, setLastCheckIn] = useState<Date | null>(null);
  const [intervalMinutes, setIntervalMinutes] = useState<number>(12 * 60); // default 12h
  const [status, setStatus] = useState<Status>("unknown");
  const [timeLeft, setTimeLeft] = useState<string>("");

  // ㊺ Location sharing state
  const [locationSharing, setLocationSharing] = useState<boolean | null>(null);
  const [locationShareReason, setLocationShareReason] = useState<LocationShareReason | null>(null);
  const [locationSharedAt, setLocationSharedAt] = useState<Date | null>(null);
  const [escalationActiveAt, setEscalationActiveAt] = useState<Date | null>(null);
  const [locationMutationPending, setLocationMutationPending] = useState(false);
  const [clearingLocation, setClearingLocation] = useState(false);
  const [sharingLocation, setSharingLocation] = useState(false);

  // ㊻ Auth/role state
  const [roleChecked, setRoleChecked] = useState(false);
  const [userDocLoaded, setUserDocLoaded] = useState(false);

  // ㊼ Emergency service + contacts state
  const [emergencyServiceCountry, setEmergencyServiceCountry] =
    useState<EmergencyServiceCountryCode>(DEFAULT_EMERGENCY_SERVICE_COUNTRY);
  const [primaryEmergencyContactPhone, setPrimaryEmergencyContactPhone] =
    useState<string | null>(null);
  const [primaryEmergencyContactEmail, setPrimaryEmergencyContactEmail] =
    useState<string | null>(null);
  const [primaryEmergencyContactName, setPrimaryEmergencyContactName] =
    useState<string>("Emergency Contact 1");
  const [secondaryEmergencyContactPhone, setSecondaryEmergencyContactPhone] =
    useState<string | null>(null);
  const [secondaryEmergencyContactEmail, setSecondaryEmergencyContactEmail] =
    useState<string | null>(null);
  const [secondaryEmergencyContactName, setSecondaryEmergencyContactName] =
    useState<string>("Emergency Contact 2");

  // ㊽ Phone settings
  const [savedPhone, setSavedPhone] = useState<string>("");
  const [phoneDraft, setPhoneDraft] = useState<string>("");
  const [phoneSaving, setPhoneSaving] = useState(false);

  // ㊾ Voice quick message target/dialog
  const [voiceMessageTarget, setVoiceMessageTarget] =
    useState<VoiceMessageTarget | null>(null);
  const [quickVoiceDialogOpen, setQuickVoiceDialogOpen] = useState(false);

  // ㊿ Main user UID (for downstream calls)
  const [mainUserUid, setMainUserUid] = useState<string | null>(null);

  // 51 Refs to manage subscriptions/throttles
  const userDocUnsubRef = useRef<(() => void) | null>(null);
  const userRef = useRef<ReturnType<typeof doc> | null>(null);
  const autoCheckInTriggeredRef = useRef(false);
  const lastLocationShareRef = useRef<{ reason: LocationShareReason; ts: number } | null>(null);
  const prevEscalationActiveRef = useRef(false);

  // 52 Foreground push notifications while app is open
  useEffect(() => {
    let unsub: (() => void) | undefined;

    (async () => {
      const { isSupported, getMessaging, onMessage } = await import("firebase/messaging");
      if (!(await isSupported())) return; // Skip if unsupported

      const { initializeApp, getApps } = await import("firebase/app");
      const apps = getApps();
      const app = apps.length // Reuse existing client app or init a lightweight one
        ? apps[0]
        : initializeApp({
            apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
            authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
            projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
            messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID!,
            appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
          });

      const messaging = getMessaging(app);

      // Listen to foreground messages and show native notifications
      unsub = onMessage(messaging, async (payload) => {
        const reg = await navigator.serviceWorker.ready;
        const title = payload.notification?.title || payload.data?.title || "Notification";
        const body = payload.notification?.body || payload.data?.body || "";
        const url = payload.fcmOptions?.link || payload.data?.url || "/";
        reg.showNotification(title, { body, data: { url } });
      });
    })();

    return () => unsub?.(); // Cleanup listener
  }, []);

  // 53 Auth + user document subscription (role gate + user state)
  useEffect(() => {
    const offAuth = onAuthStateChanged(auth, async (user) => {
      // Stop previous Firestore subscription, if any
      if (userDocUnsubRef.current) {
        userDocUnsubRef.current();
        userDocUnsubRef.current = null;
      }

      // If signed out → reset local state
      if (!user) {
        userRef.current = null;
        setMainUserUid(null);
        setLastCheckIn(null);
        setIntervalMinutes(12 * 60);
        setStatus("unknown");
        setTimeLeft("");
        setLocationSharing(null);
        setRoleChecked(true);
        setUserDocLoaded(false);
        autoCheckInTriggeredRef.current = false;
        setSavedPhone("");
        setPhoneDraft("");
        setPhoneSaving(false);
        setPrimaryEmergencyContactName("Emergency Contact 1");
        setPrimaryEmergencyContactPhone(null);
        setPrimaryEmergencyContactEmail(null);
        setSecondaryEmergencyContactName("Emergency Contact 2");
        setSecondaryEmergencyContactPhone(null);
        setSecondaryEmergencyContactEmail(null);
        setVoiceMessageTarget(null);
        return;
      }

      // When signed in → subscribe to user doc
      setMainUserUid(user.uid);
      const uref = doc(db, "users", user.uid);
      userRef.current = uref;
      setUserDocLoaded(false);
      autoCheckInTriggeredRef.current = false;

      await setDoc(uref, { createdAt: serverTimestamp() }, { merge: true }); // ensure doc exists

      const unsub = onSnapshot(uref, (snap) => {
        if (!snap.exists()) {
          setRoleChecked(true);
          setUserDocLoaded(true);
          return;
        }
        const data = snap.data() as UserDoc;

        setRoleChecked(true); // mark before possible redirect to avoid flicker

        // Role gate: emergency contacts should not see this dashboard
        const r = normalizeRole(data.role);
        if (r === "emergency_contact") {
          router.replace(EMERGENCY_DASH);
          return;
        }

        // Check-in state
        if (data.lastCheckinAt instanceof Timestamp) {
          setLastCheckIn(data.lastCheckinAt.toDate());
        } else {
          setLastCheckIn(null);
        }

        // Interval parsing (string or number)
        const rawInt = data.checkinInterval;
        const parsed =
          typeof rawInt === "string"
            ? parseInt(rawInt, 10)
            : typeof rawInt === "number"
            ? rawInt
            : NaN;
        if (!Number.isNaN(parsed) && parsed > 0) setIntervalMinutes(parsed);

        // Location consent
        if (typeof data.locationSharing === "boolean") {
          setLocationSharing(data.locationSharing);
        }

        // Last share reason
        const shareReason = data.locationShareReason;
        if (shareReason === "sos" || shareReason === "escalation") {
          setLocationShareReason(shareReason);
        } else {
          setLocationShareReason(null);
        }

        // Timestamps to Date
        if (data.locationSharedAt instanceof Timestamp) {
          setLocationSharedAt(data.locationSharedAt.toDate());
        } else {
          setLocationSharedAt(null);
        }

        if (data.missedNotifiedAt instanceof Timestamp) {
          setEscalationActiveAt(data.missedNotifiedAt.toDate());
        } else {
          setEscalationActiveAt(null);
        }

        // Phone field
        const storedPhone =
          typeof data.phone === "string" ? sanitizePhone(data.phone) : "";
          setPhoneDraft((prev) => {
            const prevSan = sanitizePhone(prev);
            // If the field is empty on load, populate from DB
            if (!prevSan) return storedPhone;
            // If it already matches DB (e.g., after save), normalize it
            if (prevSan === storedPhone) return storedPhone;
            // Otherwise, preserve the user's unsaved local edits
            return prev;
          });

        // Emergency contacts snapshot → extract key fields
        const contacts = data.emergencyContacts as EmergencyContactsData | undefined;
        if (contacts) {
          const service = getEmergencyService(contacts.emergencyServiceCountry);
          setEmergencyServiceCountry(service.code);

          const first =
            typeof contacts.contact1_firstName === "string"
              ? contacts.contact1_firstName.trim()
              : "";
          const last =
            typeof contacts.contact1_lastName === "string"
              ? contacts.contact1_lastName.trim()
              : "";
          const displayName = [first, last].filter(Boolean).join(" ");
          setPrimaryEmergencyContactName(displayName || "Emergency Contact 1");

          const phone =
            typeof contacts.contact1_phone === "string"
              ? sanitizePhone(contacts.contact1_phone)
              : "";
          setPrimaryEmergencyContactPhone(phone || null);
          const email =
            typeof contacts.contact1_email === "string"
              ? contacts.contact1_email.trim()
              : "";
          setPrimaryEmergencyContactEmail(email || null);

          const secondFirst =
            typeof contacts.contact2_firstName === "string"
              ? contacts.contact2_firstName.trim()
              : "";
          const secondLast =
            typeof contacts.contact2_lastName === "string"
              ? contacts.contact2_lastName.trim()
              : "";
          const secondDisplayName = [secondFirst, secondLast].filter(Boolean).join(" ");
          setSecondaryEmergencyContactName(
            secondDisplayName || "Emergency Contact 2"
          );

          const secondPhone =
            typeof contacts.contact2_phone === "string"
              ? sanitizePhone(contacts.contact2_phone)
              : "";
          setSecondaryEmergencyContactPhone(secondPhone || null);
          const secondEmail =
            typeof contacts.contact2_email === "string"
              ? contacts.contact2_email.trim()
              : "";
          setSecondaryEmergencyContactEmail(secondEmail || null);
        } else {
          // Reset when no contacts populated
          setEmergencyServiceCountry(DEFAULT_EMERGENCY_SERVICE_COUNTRY);
          setPrimaryEmergencyContactName("Emergency Contact 1");
          setPrimaryEmergencyContactPhone(null);
          setPrimaryEmergencyContactEmail(null);
          setSecondaryEmergencyContactName("Emergency Contact 2");
          setSecondaryEmergencyContactPhone(null);
          setSecondaryEmergencyContactEmail(null);
        }

        setUserDocLoaded(true); // mark loaded
      });

      userDocUnsubRef.current = unsub;
    });

    return () => {
      offAuth(); // stop auth observer
      if (userDocUnsubRef.current) {
        userDocUnsubRef.current();
        userDocUnsubRef.current = null;
      }
    };
  }, [router]);

  // 54 Register device for push when we know we’re the main user
  useEffect(() => {
    if (!roleChecked || !mainUserUid) return;
    registerDevice(mainUserUid, "primary");
  }, [roleChecked, mainUserUid]);

  // 55 Compute next scheduled check-in from last + interval
  const nextCheckIn = useMemo(() => {
    if (!lastCheckIn) return null;
    return new Date(lastCheckIn.getTime() + intervalMinutes * 60 * 1000);
  }, [lastCheckIn, intervalMinutes]);

  // 56 Emergency service info from selected country
  const emergencyService = useMemo(
    () => getEmergencyService(emergencyServiceCountry),
    [emergencyServiceCountry]
  );

  // 57 Helper to open the dialer for a contact phone
  const handleDialEmergencyContact = useCallback((phone: string | null) => {
    if (!phone) return;
    if (typeof window === "undefined") return;
    window.location.href = `tel:${phone}`;
  }, []);

  // 58 Countdown timer + status derivation
  useEffect(() => {
    if (!nextCheckIn) {
      setStatus("unknown");
      setTimeLeft("");
      return;
    }

    const formatTimeLeft = (ms: number) => {
      const totalSeconds = Math.floor(ms / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      const s = String(seconds).padStart(2, "0");
      if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m ${s}s left`;
      return `${minutes}m ${s}s left`;
    };

    const tick = () => {
      const now = new Date();
      const diff = nextCheckIn.getTime() - now.getTime();
      const clamped = Math.max(0, diff);
      if (clamped === 0) {
        setStatus("missed");
        setTimeLeft("Overdue");
      } else {
        setStatus("safe");
        setTimeLeft(formatTimeLeft(clamped));
      }
    };

    tick(); // initial
    const id = setInterval(tick, 1000); // every second
    return () => clearInterval(id); // cleanup
  }, [nextCheckIn]);

  // 59 Format “when” helper for dates
  const formatWhen = (d: Date | null) => {
    if (!d) return "—";
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday =
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate();

    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (sameDay) return `Today at ${time}`;
    if (isYesterday) return `Yesterday at ${time}`;
    return `${d.toLocaleDateString()} ${time}`;
  };

  // 60 Clear last shared location and reason
  const clearSharedLocation = useCallback(async () => {
    const ref = userRef.current;
    if (!ref) throw new Error("Not signed in");

    await updateDoc(ref, {
      location: deleteField(),
      locationShareReason: deleteField(),
      locationSharedAt: deleteField(),
      sosTriggeredAt: deleteField(),
    });

    lastLocationShareRef.current = null;
    setLocationShareReason(null);
    setLocationSharedAt(null);
  }, []);

  // 61 Result type for captureLocation
  type CaptureLocationResult =
    | { status: "shared"; location: string }
    | { status: "skipped" }
    | { status: "throttled" };

  // 62 Attempt to capture device location with throttling + permission UX
  const captureLocation = useCallback(
    async (
      reason: LocationShareReason,
      options: { silentIfDisabled?: boolean } = {}
    ): Promise<CaptureLocationResult> => {
      if (locationSharing === false) {
        if (!options.silentIfDisabled) {
          toast({
            title: "Location sharing disabled",
            description: "Enable location sharing in settings to send your location during SOS alerts.",
            variant: "destructive",
          });
        }
        return { status: "skipped" };
      }

      if (typeof window === "undefined" || !("geolocation" in navigator)) {
        toast({
          title: "Location unavailable",
          description:
            "Your device does not support location services. Try another device to share your location.",
          variant: "destructive",
        });
        return { status: "skipped" };
      }

      const perm = await ensureGeoAllowed();
      if (perm === false) {
        toast({
          title: "Location denied in browser",
          description: "Please enable location access for this site in your browser settings.",
          variant: "destructive",
        });
        return { status: "skipped" };
      }

      const last = lastLocationShareRef.current;
      const shouldThrottle =
        reason !== "sos" &&
        last &&
        last.reason === reason &&
        Date.now() - last.ts < LOCATION_SHARE_COOLDOWN_MS;
      if (shouldThrottle) {
        return { status: "throttled" };
      }

      setSharingLocation(true);

      try {
        const position = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: 15_000,
          });
        });

        const { latitude, longitude } = position.coords;
        const locationString = `${latitude.toFixed(6)},${longitude.toFixed(6)}`;

        return { status: "shared", location: locationString };
      } catch (error) {
        toast({
          title: "Location sharing failed",
          description: describeGeoError(error),
          variant: "destructive",
        });
        return { status: "skipped" };
      } finally {
        setSharingLocation(false);
      }
    },
    [locationSharing, toast]
  );

  // 63 Persist a shared location and show toasts
  const shareLocation = useCallback(
    async (reason: LocationShareReason, opts?: { silentIfDisabled?: boolean }) => {
      const ref = userRef.current;
      if (!ref) {
        toast({
          title: "Not signed in",
          description: "Please log in again to share your location.",
          variant: "destructive",
        });
        return false;
      }

      const result = await captureLocation(reason, opts);
      if (result.status === "throttled") return true;
      if (result.status !== "shared") return false;

      try {
        await updateDoc(ref, {
          location: result.location,
          locationShareReason: reason,
          locationSharedAt: serverTimestamp(),
        });

        lastLocationShareRef.current = { reason, ts: Date.now() };
        setLocationShareReason(reason);
        setLocationSharedAt(new Date());

        toast({
          title: "Location shared",
          description:
            reason === "sos"
              ? "We sent your current location with your SOS alert."
              : "We shared your current location with your emergency contacts for this escalation.",
        });

        return true;
      } catch (error) {
        toast({
          title: "Location sharing failed",
          description: describeGeoError(error),
          variant: "destructive",
        });
        return false;
      }
    },
    [captureLocation, toast]
  );

  // 64 Enable consent (ensures permission flow first)
  const enableLocationSharing = useCallback(async () => {
    const ref = userRef.current;
    if (!ref) {
      toast({
        title: "Not signed in",
        description: "Please log in again to update your location preferences.",
        variant: "destructive",
      });
      return;
    }

    if (typeof window === "undefined" || !("geolocation" in navigator)) {
      toast({
        title: "Location unavailable",
        description:
          "This device doesn't support location services. Try enabling location on another device.",
        variant: "destructive",
      });
      return;
    }

    setLocationMutationPending(true);

    try {
      const perm = await ensureGeoAllowed();
      if (perm === false) {
        toast({
          title: "Location denied in browser",
          description: "Enable location access for this site in your browser settings.",
          variant: "destructive",
        });
        return;
      }

      if (perm === "prompt") {
        await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 15_000,
          });
        });
      }

      await updateDoc(ref, { locationSharing: true });
      setLocationSharing(true);
      toast({
        title: "Location sharing enabled",
        description: "We only share your location during an SOS alert or escalation.",
      });
    } catch (error) {
      toast({
        title: "Location permission needed",
        description: describeGeoError(error),
        variant: "destructive",
      });
    } finally {
      setLocationMutationPending(false);
    }
  }, [toast]);

  // 65 Disable consent and clear stored location
  const disableLocationSharing = useCallback(async () => {
    const ref = userRef.current;
    if (!ref) {
      toast({
        title: "Not signed in",
        description: "Please log in again to update your location preferences.",
        variant: "destructive",
      });
      return;
    }

    setLocationMutationPending(true);

    try {
      await updateDoc(ref, {
        locationSharing: false,
        location: deleteField(),
        locationShareReason: deleteField(),
        locationSharedAt: deleteField(),
      });

      lastLocationShareRef.current = null;
      setLocationSharing(false);
      setLocationShareReason(null);
      setLocationSharedAt(null);

      toast({
        title: "Location sharing disabled",
        description: "We turned off location sharing and cleared the last shared location.",
      });
    } catch (error: any) {
      toast({
        title: "Unable to update location settings",
        description: error?.message ?? "Please try again.",
        variant: "destructive",
      });
    } finally {
      setLocationMutationPending(false);
    }
  }, [toast]);

  // 66 Clear last shared location action
  const handleClearSharedLocation = useCallback(async () => {
    if (!locationShareReason) return;

    setClearingLocation(true);
    try {
      await clearSharedLocation();
      toast({
        title: "Location cleared",
        description: "We removed your last shared location from the emergency dashboard.",
      });
    } catch (error: any) {
      toast({
        title: "Unable to clear location",
        description: error?.message ?? "Please try again.",
        variant: "destructive",
      });
    } finally {
      setClearingLocation(false);
    }
  }, [clearSharedLocation, locationShareReason, toast]);

  // 67 SOS flow (capture location → record → server call)
  const triggerSos = useCallback(async () => {
    const ref = userRef.current;
    if (!ref) {
      toast({
        title: "Not signed in",
        description: "Please log in again before using SOS.",
        variant: "destructive",
      });
      return;
    }

    const locationResult = await captureLocation("sos");
    const updates: Record<string, any> = { sosTriggeredAt: serverTimestamp() };
    const shouldPersistLocation = locationResult.status === "shared";
    if (shouldPersistLocation) {
      updates.location = locationResult.location;
      updates.locationShareReason = "sos";
      updates.locationSharedAt = serverTimestamp();
    }

    let locationSaved = shouldPersistLocation;

    try {
      await updateDoc(ref, updates);
    } catch (error: any) {
      console.error("Failed to record SOS trigger", error);
      toast({
        title: "SOS alert not recorded",
        description: error?.message ?? "We couldn't notify your contacts. Please try again.",
        variant: "destructive",
      });
      locationSaved = false;
    }

    if (locationSaved) {
      lastLocationShareRef.current = { reason: "sos", ts: Date.now() };
      setLocationShareReason("sos");
      setLocationSharedAt(new Date());
      toast({
        title: "Location shared",
        description: "We sent your current location with your SOS alert.",
      });
    }

    // Attempt server-side call to primary EC (if phone exists)
    if (primaryEmergencyContactPhone) {
      try {
        await triggerServerTelnyxCall({
          to: primaryEmergencyContactPhone,
          mainUserUid: mainUserUid ?? undefined,
        });
      } catch (err: any) {
        console.error("Server Telnyx call failed", err);
        toast({
          title: "Emergency contact call failed",
          description:
            err?.message ??
            "We couldn’t start the Telnyx call to your emergency contact.",
          variant: "destructive",
        });
      }
    } else {
      toast({
        title: "Emergency contact number missing",
        description: `Add a phone number for ${
          primaryEmergencyContactName || "your emergency contact"
        } to automatically call them during SOS alerts.`,
        variant: "destructive",
      });
    }
  }, [
    captureLocation,
    toast,
    mainUserUid,
    primaryEmergencyContactPhone,
    primaryEmergencyContactName,
  ]);

  // 68 Bind press-and-hold SOS dial behavior
  const { bind, holding, progress } = useSosDialer({
    phoneNumber: emergencyService.dial,
    contactName: `Emergency services (${emergencyService.dial})`,
    holdToActivateMs: 1500,
    confirm: true,
    onActivate: triggerSos,
  });

  // 69 Derived flags
  const ready = (progress ?? 0) >= 0.999;
  const phoneDirty = sanitizePhone(phoneDraft) !== savedPhone;

  // 70 Auto share on escalation start; clear when resolved
  useEffect(() => {
    const wasActive = prevEscalationActiveRef.current;
    const isActive = Boolean(escalationActiveAt);

    if (isActive && !wasActive) {
      void shareLocation("escalation", { silentIfDisabled: true });
    } else if (!isActive && wasActive) {
      clearSharedLocation().catch((error) => {
        console.error("Failed to clear shared location after escalation resolved", error);
      });
    }

    prevEscalationActiveRef.current = isActive;
  }, [escalationActiveAt, shareLocation, clearSharedLocation]);

  // 71 Manual check-in handler (also clears shared location)
  const handleCheckIn = useCallback(
    async ({ showToast = true }: { showToast?: boolean } = {}) => {
      try {
        if (!userRef.current) throw new Error("Not signed in");

        const intervalMin =
          Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 720;

        const dueAtMin = toEpochMinutes(Date.now()) + intervalMin;

        setLastCheckIn(new Date()); // optimistic UI

        await updateDoc(userRef.current, {
          checkinEnabled: true,
          lastCheckinAt: serverTimestamp(),
          dueAtMin,
          missedNotifiedAt: null,
          sosTriggeredAt: deleteField(),
        });

        if (locationShareReason) {
          try {
            await clearSharedLocation();
          } catch (error) {
            console.error("Failed to clear shared location after check-in", error);
          }
        }

        if (showToast) {
          toast({
            title: "Checked In!",
            description: "Your status has been updated to 'OK'.",
          });
        }
      } catch (e: any) {
        toast({
          title: "Check-in failed",
          description: e?.message ?? "Please try again.",
          variant: "destructive",
        });
        throw e;
      }
    },
    [clearSharedLocation, intervalMinutes, locationShareReason, toast]
  );

  // 72 Voice quick check-in completion → run regular check-in
  const handleVoiceCheckInComplete = useCallback(async () => {
    await handleCheckIn({ showToast: false });
    setVoiceMessageTarget(null);
    setQuickVoiceDialogOpen(false);
  }, [handleCheckIn]);

  // 73 Pick which contact to send a voice message to
  const handleVoiceMessageContact = useCallback(
    (contact: "primary" | "secondary") => {
      const isPrimary = contact === "primary";
      const name = isPrimary
        ? primaryEmergencyContactName
        : secondaryEmergencyContactName;
      const phone = isPrimary
        ? primaryEmergencyContactPhone
        : secondaryEmergencyContactPhone;
      const email = isPrimary
        ? primaryEmergencyContactEmail
        : secondaryEmergencyContactEmail;

      if (!phone && !email) {
        toast({
          title: "Add contact details",
          description:
            "Provide a phone number or email to send them a voice message.",
          variant: "destructive",
        });
        return;
      }

      setVoiceMessageTarget({
        name,
        phone: phone || undefined,
        email: email || undefined,
      });
      setQuickVoiceDialogOpen(true);
    },
    [
      primaryEmergencyContactEmail,
      primaryEmergencyContactName,
      primaryEmergencyContactPhone,
      secondaryEmergencyContactEmail,
      secondaryEmergencyContactName,
      secondaryEmergencyContactPhone,
      toast,
    ],
  );

  // 74 One-time auto check-in after auth+doc are ready (idempotent)
  useEffect(() => {
    if (autoCheckInTriggeredRef.current) return;
    if (!roleChecked || !mainUserUid || !userDocLoaded || !userRef.current) return;

    autoCheckInTriggeredRef.current = true;
    handleCheckIn({ showToast: false }).catch(() => {
      autoCheckInTriggeredRef.current = false;
    });
  }, [handleCheckIn, mainUserUid, roleChecked, userDocLoaded]);

  // 75 Map interval minutes → select value
  const selectedHours = useMemo(() => {
    const h = Math.round(intervalMinutes / 60);
    const isValidOption = HOURS_OPTIONS.some((option) => option === h);
    return isValidOption ? String(h) : "12";
  }, [intervalMinutes]);

  // 76 Persist interval change and recompute dueAtMin
  const handleIntervalChange = async (value: string) => {
    const hours = parseInt(value, 10);
    const minutes = hours * 60;
    try {
      setIntervalMinutes(minutes);
      if (!userRef.current) throw new Error("Not signed in");

      const baseMs = lastCheckIn?.getTime?.() ?? Date.now();
      const newDueAtMin = toEpochMinutes(baseMs) + minutes;

      await updateDoc(userRef.current, {
        checkinInterval: minutes,
        dueAtMin: newDueAtMin,
      });

      toast({
        title: "Check-in Interval Updated",
        description: `Your check-in interval has been set to every ${hours} hours.`,
      });
    } catch (e: any) {
      toast({
        title: "Update failed",
        description: e?.message ?? "Please try again.",
        variant: "destructive",
      });
    }
  };

  // 77 Save phone number (explicit click only) with visual un-press reset
  const handlePhoneSave = useCallback(async () => {
    if (!userRef.current) {
      toast({
        title: "Not signed in",
        description: "Please log in again to update your phone number.",
        variant: "destructive",
      });
      return;
    }

    const sanitized = sanitizePhone(phoneDraft);
    if (sanitized && !isValidE164Phone(sanitized)) {
      toast({
        title: "Invalid phone number",
        description: "Use international format like +15551234567.",
        variant: "destructive",
      });
      return;
    }

    setPhoneSaving(true);
    try {
      if (sanitized) {
        await updateDoc(userRef.current, {
          phone: sanitized,
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(userRef.current, {
          phone: deleteField(),
          updatedAt: serverTimestamp(),
        });
      }

      setSavedPhone(sanitized);
      setPhoneDraft(sanitized);
      toast({
        title: "Phone number updated",
        description: sanitized
          ? "Emergency contacts will call this number from their dashboard."
          : "Phone number removed. Add one to enable Call links.",
      });
    } catch (error: any) {
      console.error("Failed to update phone", error);
      toast({
        title: "Update failed",
        description: error?.message ?? "Please try again.",
        variant: "destructive",
      });
    } finally {
      // Ensure button returns to its normal color after press
      if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      setPhoneSaving(false);
    }
  }, [phoneDraft, toast]);

  // 78 Reset phone draft
  const handlePhoneReset = useCallback(() => {
    setPhoneDraft(savedPhone);
  }, [savedPhone]);

  // 79 Prevent flashing dashboard before role check finishes
  if (!roleChecked) {
    return (
      <div className="flex flex-col min-h-screen bg-secondary overflow-x-hidden">
        <Header />
        <main className="flex-grow container mx-auto px-4 pt-24 sm:pt-8 pb-8">
          <Card className="shadow-lg">
            <CardHeader>
              <CardTitle className="text-2xl font-headline">Loading…</CardTitle>
              <CardDescription>Preparing your dashboard.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-24 animate-pulse bg-muted rounded" />
            </CardContent>
          </Card>
        </main>
        <Footer />
      </div>
    );
  }

  // 80 Main UI
  return (
    <>
      {/* Voice quick message dialog (modal) */}
      <Dialog
        open={quickVoiceDialogOpen}
        onOpenChange={(open) => {
          setQuickVoiceDialogOpen(open);
          if (!open) setVoiceMessageTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader className="space-y-1.5">
            <DialogTitle>Send a voice update</DialogTitle>
            <DialogDescription>
              {voiceMessageTarget
                ? `Record a quick update for ${voiceMessageTarget.name}.`
                : "Record a quick voice message for your emergency contacts."}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <VoiceCheckIn
              onCheckIn={handleVoiceCheckInComplete}
              targetContact={voiceMessageTarget}
              onClearTarget={() => setVoiceMessageTarget(null)}
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* Page chrome + content */}
      <div className="flex flex-col min-h-screen bg-secondary overflow-x-hidden">
        <Header />
        {/* extra top padding on mobile prevents overlap with fixed header */}
        <main className="flex-grow container mx-auto px-4 pt-24 sm:pt-8 pb-8">
          <h1 className="text-3xl md:text-4xl font-headline font-bold mb-6">Your Dashboard</h1>

          {/* Outer grid: 1 col on mobile, 2 cols on large, 12 cols on xl for side column */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-6">
            {/* Primary column (cards grid). 
                - auto-rows min height avoids overly tall mobile cards
                - we removed aspect-square on small to fix overflow on narrow widths */}
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 auto-rows-[minmax(18rem,_auto)] lg:col-span-1 xl:col-span-7">
              {/* SOS card (unchanged position) */}
              <Card className={`${PRIMARY_CARD_BASE_CLASSES} border border-destructive bg-destructive/10 text-center`}>
                <CardHeader className={PRIMARY_CARD_HEADER_CLASSES}>
                  <CardTitle className={`${PRIMARY_CARD_TITLE_CLASSES} text-destructive`}>
                    Emergency SOS
                  </CardTitle>
                  <CardDescription className={`${PRIMARY_CARD_DESCRIPTION_CLASSES} font-medium text-destructive/80 break-words`}>
                    Tap only in a real emergency. We will dial {emergencyService.dial} for {emergencyService.label}.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col items-center justify-center gap-5">
                  <div className="flex flex-col items-center gap-3" aria-live="polite">
                    {/* Responsive ring + button sizes to prevent overflow */}
                    <div
                      className="relative grid place-items-center h-32 w-32 md:h-40 md:w-40"
                      aria-label={
                        holding
                          ? ready
                            ? `Release to call ${emergencyService.dial}`
                            : `Holding… ${Math.round((progress ?? 0) * 100)} percent`
                          : `Hold 1.5 seconds to call ${emergencyService.dial}`
                      }
                    >
                      {/* Ring */}
                      <div
                        className="absolute inset-0 rounded-full"
                        style={{
                          background: `conic-gradient(#ef4444 ${(progress || 0) * 360}deg, rgba(239,68,68,0.15) 0deg)`,
                          WebkitMask:
                            "radial-gradient(circle 48px at center, transparent 47px, black 48px)",
                          mask:
                            "radial-gradient(circle 48px at center, transparent 47px, black 48px)",
                          transition: "background 80ms linear",
                        }}
                      />
                      {/* Button */}
                      <Button
                        {...bind}
                        aria-label={
                          ready
                            ? `Release to call ${emergencyService.dial}`
                            : `Hold to call ${emergencyService.dial}`
                        }
                        variant="destructive"
                        size="lg"
                        className={`relative z-[1] h-24 w-24 md:h-28 md:w-28 rounded-full text-2xl shadow-lg transition-transform ${
                          holding ? "opacity-90" : "hover:scale-105"
                        }`}
                      >
                        <Siren className="h-12 w-12" />
                      </Button>
                    </div>

                    {/* Helper caption */}
                    <p className="text-lg font-medium text-destructive/80 break-words text-center">
                      {holding
                        ? ready
                          ? `Release to call ${emergencyService.dial}`
                          : "Keep holding…"
                        : `Hold 1.5s to call ${emergencyService.dial}`}
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* Check-in card (unchanged position) */}
              <Card className={`${PRIMARY_CARD_BASE_CLASSES} text-center`}>
                <CardHeader className={PRIMARY_CARD_HEADER_CLASSES}>
                  <CardTitle className={PRIMARY_CARD_TITLE_CLASSES}>Check-in</CardTitle>
                  <CardDescription className={PRIMARY_CARD_DESCRIPTION_CLASSES}>
                    Let your contacts know you’re safe.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col items-center justify-center gap-8 text-center">
                  <div className="flex flex-col items-center gap-4">
                    <Button
                      onClick={() => handleCheckIn()}
                      size="lg"
                      className="h-28 w-28 md:h-32 md:w-32 rounded-full text-2xl shadow-lg bg-green-500 hover:bg-green-600"
                    >
                      <CheckCircle2 className="h-14 w-14 md:h-16 md:w-16" />
                    </Button>
                    <p className="text-2xl font-semibold text-muted-foreground">
                      Press the button to check in.
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* Status Overview (unchanged position) */}
              <Card className={`${PRIMARY_CARD_BASE_CLASSES} text-left`}>
              <CardHeader className={`${PRIMARY_CARD_HEADER_CLASSES} items-center`}>
  <Clock className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
  <CardTitle className={PRIMARY_CARD_TITLE_CLASSES}>Status Overview</CardTitle>
  <CardDescription className={PRIMARY_CARD_DESCRIPTION_CLASSES}>
    Keep tabs on your latest check-in and countdown.
  </CardDescription>
</CardHeader>


                <CardContent className="flex flex-1 flex-col justify-center">
                                  <dl className="grid gap-4 text-base sm:grid-cols-2">
                                                      <div className="space-y-1">
                                                                            <dt className="text-sm text-muted-foreground">Last check-in</dt>
                                                                                                  <dd className="text-lg font-semibold text-primary">{formatWhen(lastCheckIn)}</dd>
                                                                                                                      </div>
                                                                                                                                          <div className="space-y-1">
                                                                                                                                                                <dt className="text-sm text-muted-foreground">Next scheduled check-in</dt>
                                                                                                                                                                                      <dd className="text-lg font-semibold text-primary">{formatWhen(nextCheckIn)}</dd>
                                                                                                                                                                                                          </div>
                                                                                                                                                                                                                              <div className="space-y-1">
                                                                                                                                                                                                                                                    <dt className="text-sm text-muted-foreground">Countdown</dt>
                                                                                                                                                                                                                                                                          <dd
                                                                                                                                                                                                                                                                                                  className={`text-lg font-semibold ${
                                                                                                                                                                                                                                                                                                                            status === "missed" ? "text-destructive" : "text-primary"
                                                                                                                                                                                                                                                                                                                                                    }`}
                                                                                                                                                                                                                                                                                                                                                                          >
                                                                                                                                                                                                                                                                                                                                                                                                  {timeLeft || "—"}
                                                                                                                                                                                                                                                                                                                                                                                                                        </dd>
                                                                                                                                                                                                                                                                                                                                                                                                                                            </div>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                <div className="space-y-1">
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      <dt className="text-sm text-muted-foreground">Status</dt>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            <dd
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    className={`text-lg font-semibold ${
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              status === "safe"
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          ? "text-green-600"
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      : status === "missed"
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  ? "text-destructive"
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              : "text-muted-foreground"
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      }`}
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            >
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    {status.toUpperCase()}
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          </dd>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              </div>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  <div className="space-y-1 sm:col-span-2">
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        <dt className="text-sm text-muted-foreground">Location sharing</dt>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              <dd
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      className={`text-lg font-semibold ${
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                locationSharing === true
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            ? "text-green-600"
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        : locationSharing === false
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    ? "text-destructive"
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                : "text-muted-foreground"
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        }`}
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              >
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      {locationSharing === null
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                ? "—"
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          : locationSharing
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    ? "Enabled"
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              : "Disabled"}
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    </dd>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        </div>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          </dl>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          </CardContent>
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        </Card>

              {/* Voice Update card — MOVED here (into Ask AI’s old spot) */}
              <Card id="voice-update-card" className={`${PRIMARY_CARD_BASE_CLASSES} text-center`}>
                <CardHeader className={`${PRIMARY_CARD_HEADER_CLASSES} items-center`}>
                  <Mic className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
                  <CardTitle className={PRIMARY_CARD_TITLE_CLASSES}>Voice Update</CardTitle>
                  <CardDescription className={`${PRIMARY_CARD_DESCRIPTION_CLASSES} break-words`}>
                    Hold to record a quick message that we analyze and share with your emergency contacts.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
                  {quickVoiceDialogOpen ? (
                    <p className="max-w-md text-base text-muted-foreground">
                      The quick voice message window is open. Finish or close it to use this recorder.
                    </p>
                  ) : (
                    <VoiceCheckIn
                      onCheckIn={handleVoiceCheckInComplete}
                      targetContact={voiceMessageTarget}
                      onClearTarget={() => setVoiceMessageTarget(null)}
                    />
                  )}
                </CardContent>
              </Card>

              {/* Emergency contact quick calls (unchanged) */}
              <Card className={`${PRIMARY_CARD_BASE_CLASSES} text-center`}>
                <CardHeader className={`${PRIMARY_CARD_HEADER_CLASSES} items-center`}>
                  <PhoneCall className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
                  <CardTitle className={PRIMARY_CARD_TITLE_CLASSES}>Emergency Contacts</CardTitle>
                  <CardDescription className={PRIMARY_CARD_DESCRIPTION_CLASSES}>
                    Call your emergency contacts instantly when you need a quick check-in.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-6">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="rounded-lg border p-4">
                      <p className="text-xl font-semibold">{primaryEmergencyContactName}</p>
                      <p className="text-sm text-muted-foreground break-words">
                        {primaryEmergencyContactPhone || "Add a phone number to enable calling."}
                      </p>
                      <div className="mt-3 flex flex-col gap-2">
                        <Button
                          onClick={() => handleDialEmergencyContact(primaryEmergencyContactPhone)}
                          disabled={!primaryEmergencyContactPhone}
                          className="w-full"
                        >
                          Call
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => handleVoiceMessageContact("primary")}
                          disabled={!primaryEmergencyContactPhone && !primaryEmergencyContactEmail}
                          className="w-full"
                        >
                          <Mic className="mr-2 h-4 w-4" aria-hidden />
                          Voice
                        </Button>
                      </div>
                    </div>
                    <div className="rounded-lg border p-4">
                      <p className="text-xl font-semibold">{secondaryEmergencyContactName}</p>
                      <p className="text-sm text-muted-foreground break-words">
                        {secondaryEmergencyContactPhone || "Add a phone number to enable calling."}
                      </p>
                      <div className="mt-3 flex flex-col gap-2">
                        <Button
                          onClick={() => handleDialEmergencyContact(secondaryEmergencyContactPhone)}
                          disabled={!secondaryEmergencyContactPhone}
                          className="w-full"
                        >
                          Call
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => handleVoiceMessageContact("secondary")}
                          disabled={!secondaryEmergencyContactPhone && !secondaryEmergencyContactEmail}
                          className="w-full"
                        >
                          <Mic className="mr-2 h-4 w-4" aria-hidden />
                          Voice
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Ask AI card — MOVED down into Voice Update’s old spot */}
              <Card className={`${PRIMARY_CARD_BASE_CLASSES} border-2 border-primary/30 text-center`}>
                <CardHeader className={PRIMARY_CARD_HEADER_CLASSES}>
                  <CardTitle className={PRIMARY_CARD_TITLE_CLASSES}>Ask AI</CardTitle>
                  <CardDescription className={`${PRIMARY_CARD_DESCRIPTION_CLASSES} break-words`}>
                    Get instant guidance and let AI share a tone summary with your contacts.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col justify-center gap-6 text-center">
                  <AskAiAssistant />
                </CardContent>
              </Card>
            </div>

            {/* Secondary column with settings + EC management */}
            <div className="space-y-6 lg:col-span-1 xl:col-span-4 xl:col-start-9">
              <EmergencyContacts />

              <Card className="p-4 shadow-lg">
                <CardHeader className="pb-4">
                  <CardTitle className="text-2xl font-headline">Your Settings</CardTitle>
                  <CardDescription>
                    Manage how you stay connected with your emergency contacts.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <section className="space-y-3">
                    <div>
                      <h3 className="text-lg font-semibold"></h3>
                      <p className="text-sm text-muted-foreground"></p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="main-user-phone">Your mobile phone</Label>
                      <Input
                        id="main-user-phone"
                        placeholder="+15551234567"
                        value={phoneDraft}
                        onChange={(event) => setPhoneDraft(event.target.value)}
                        disabled={phoneSaving}
                        inputMode="tel"
                      />
                      <p className="text-xs text-muted-foreground">
                        Include country code. We’ll auto-format for emergency contacts.
                      </p>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      {/* Ensure button only acts on explicit click and returns to normal visual state */}
                      <Button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={handlePhoneSave}
                        disabled={phoneSaving || !phoneDirty}
                        className="sm:flex-1"
                      >
                        {phoneSaving ? "Saving…" : "Save number"}
                      </Button>

                      <Button
                        type="button"
                        variant="outline"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={handlePhoneReset}
                        disabled={phoneSaving || !phoneDirty}
                      >
                        Cancel
                      </Button>
                    </div>
                  </section>

                  <Separator />

                  <section className="space-y-3">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <h3 className="text-lg font-semibold">Set Interval</h3>
                        <p className="text-sm text-muted-foreground">
                          Choose your check-in frequency.
                        </p>
                      </div>
                      <Clock className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <Select onValueChange={handleIntervalChange} value={selectedHours}>
                      <SelectTrigger className="w-full text-lg">
                        <SelectValue placeholder="Select interval" />
                      </SelectTrigger>
                      <SelectContent>
                        {HOURS_OPTIONS.map((h) => (
                          <SelectItem key={h} value={String(h)}>{`Every ${h} hours`}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-sm text-muted-foreground">
                      Current interval: {Math.floor(intervalMinutes / 60)}h {intervalMinutes % 60}m
                    </p>
                  </section>

                  <Separator />

                  <section className="space-y-3">
                    <div>
                      <h3 className="text-lg font-semibold">Location Sharing</h3>
                      <p className="text-sm text-muted-foreground">
                        Share your location only when an alert is active.
                      </p>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      We only send your location when you press SOS or when an escalation begins.
                    </p>
                    <div className="flex items-center justify-between text-lg">
                      <span className="font-semibold">Consent</span>
                      <span
                        className={`font-bold ${
                          locationSharing === true
                            ? "text-green-600"
                            : locationSharing === false
                            ? "text-destructive"
                            : "text-muted-foreground"
                        }`}
                      >
                        {locationSharing === null ? "—" : locationSharing ? "Enabled" : "Disabled"}
                      </span>
                    </div>
                    {locationShareReason ? (
                      <p className="text-sm text-muted-foreground">
                        Last shared for {locationShareReason === "sos" ? "an SOS alert" : "an escalation"}
                        {locationSharedAt ? ` (${formatWhen(locationSharedAt)})` : ""}.
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {locationSharing === true
                          ? "Your location stays hidden until an SOS alert or escalation occurs."
                          : "Turn this on to optionally send your location during SOS alerts or escalations."}
                      </p>
                    )}
                    {locationSharing ? (
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Button onClick={disableLocationSharing} disabled={locationMutationPending}>
                          {locationMutationPending ? "Disabling…" : "Disable & Clear"}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={handleClearSharedLocation}
                          disabled={clearingLocation || locationMutationPending || !locationShareReason}
                        >
                          {clearingLocation ? "Clearing…" : "Clear last share"}
                        </Button>
                      </div>
                    ) : (
                      <Button onClick={enableLocationSharing} disabled={locationMutationPending}>
                        {locationMutationPending ? "Enabling…" : "Enable location sharing"}
                      </Button>
                    )}
                    {sharingLocation && (
                      <p className="text-xs text-muted-foreground">Sharing your current location…</p>
                    )}
                  </section>
                </CardContent>
              </Card>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    </>
  );
}
