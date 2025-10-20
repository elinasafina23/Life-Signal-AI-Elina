// src/app/dashboard/page.tsx
// This file implements the main dashboard page for the LifeSignal AI application.
// It serves as the central hub for the primary user, providing features like:
// - SOS triggering
// - Manual check-ins and setting check-in intervals
// - Monitoring check-in status (Safe, Missed)
// - Managing location sharing consent and status
// - Interacting with Emergency Contacts (calling, sending voice messages)
// - Accessing the AI assistant
// - Updating personal phone number
// It uses Firebase (Auth, Firestore) for data and authentication, and Shadcn UI for components.
// It also integrates with browser APIs for geolocation and push notifications.
"use client"; // Client component so we can use hooks, browser APIs

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

// --- Firestore (realtime + updates used elsewhere on the page) ---
import {
  onSnapshot,
  doc,
  Timestamp,
  setDoc,
  updateDoc,
  serverTimestamp,
  deleteField,
  Firestore,
} from "firebase/firestore";
// --- Firestore (query helpers used for latest contact voice message in dialog) ---
import { collection, getDocs, limit, orderBy, query as fsQuery } from "firebase/firestore";

import { onAuthStateChanged } from "firebase/auth";
import { useRouter } from "next/navigation";
import { auth, db } from "@/firebase";

import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { VoiceCheckIn } from "@/components/voice-check-in";
import { AskAiAssistant } from "@/components/ask-ai-assistant";
import { EmergencyContacts } from "@/components/emergency-contact";
import { useSosDialer } from "@/hooks/useSosDialer";

// Emergency services catalog
import {
  DEFAULT_EMERGENCY_SERVICE_COUNTRY,
  EmergencyServiceCountryCode,
  getEmergencyService,
} from "@/constants/emergency-services";

// shadcn/ui components
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";

// Icons
import {
  Siren,
  CheckCircle2,
  PhoneCall,
  Clock,
  Mic,
  Mail,
  Phone,
  Play,
  Pause,
  Settings,
} from "lucide-react";

// Role helper
import { normalizeRole } from "@/lib/roles";

// Push device registration
import { registerDevice } from "@/lib/useFcmToken";

// Phone helpers
import { isValidE164Phone, sanitizePhone } from "@/lib/phone";

// ---- Types for emergency contacts stored on user doc ----
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

// ---- Subset of user doc we consume on this page ----
interface UserDoc {
  lastCheckinAt?: Timestamp;
  checkinInterval?: number | string;
  locationSharing?: boolean;
  sosTriggeredAt?: Timestamp;
  role?: string;
  locationShareReason?: LocationShareReason | null;
  locationSharedAt?: Timestamp;
  missedNotifiedAt?: Timestamp | null;
  emergencyContacts?: EmergencyContactsData;
  phone?: string;
}

// ---- Local UI types ----
type Status = "safe" | "missed" | "unknown";
type LocationShareReason = "sos" | "escalation";

// Voice quick message target
type VoiceMessageTarget = {
  name: string;
  email?: string | null;
  phone?: string | null;
};

// Contact dialog types
type ContactKind = "primary" | "secondary";
type ContactDialogState = {
  open: boolean;
  kind: ContactKind | null;
  name: string;
  phone: string | null;
  email: string | null;
};

type LatestVoiceFromContact =
  | {
      audioUrl: string;
      createdAt: Date | null;
      transcript?: string;
    }
  | null;

// ---- Routes, helpers, constants ----
const EMERGENCY_DASH = "/emergency-dashboard"; // Route used if an EC tries to open this page
const toEpochMinutes = (ms: number) => Math.floor(ms / 60000); // Helper to compute dueAtMin

const HOURS_OPTIONS = [1, 2, 3, 6, 10, 12, 18, 24] as const; // Allowed check-in intervals (hrs)
const LOCATION_SHARE_COOLDOWN_MS = 60_000; // Throttle repeated shares
const GEO_PERMISSION_DENIED = 1;
const GEO_POSITION_UNAVAILABLE = 2;
const GEO_TIMEOUT = 3;

// ---- Normalizers ----
const normalizeEmail = (value?: string | null) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

// ---- Styling tokens ----
const PRIMARY_CARD_BASE_CLASSES =
  "flex overflow-hidden min-h-[18rem] flex-col shadow-lg transition-shadow hover:shadow-xl";
const PRIMARY_CARD_HEADER_CLASSES = "space-y-3 text-center";
const PRIMARY_CARD_TITLE_CLASSES = "text-3xl font-headline font-semibold";
const PRIMARY_CARD_DESCRIPTION_CLASSES = "text-lg text-muted-foreground";

// ---- Map Geolocation errors to friendly text ----
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
    }
  }
  if (typeof maybeGeo.message === "string" && maybeGeo.message.trim()) return maybeGeo.message;
  return defaultMessage;
}

// ---- Check browser permission without prompting ----
async function ensureGeoAllowed(): Promise<true | false | "prompt"> {
  if (typeof window === "undefined") return false;
  if (!("geolocation" in navigator)) return false;

  const navAny = navigator as any;
  if (!navAny.permissions?.query) return true; // No Permissions API → assume ok
  try {
    const status: PermissionStatus = await navAny.permissions.query({
      name: "geolocation" as any,
    });
    if (status.state === "granted") return true;
    if (status.state === "prompt") return "prompt";
    return false;
  } catch {
    return true;
  }
}

// ---- Helper to call your server to place Telnyx call ----
async function triggerServerTelnyxCall(params: {
  to?: string;
  mainUserUid?: string;
  emergencyContactUid?: string;
}) {
  const url = "/api/sos/call-server";
  let authHeader: Record<string, string> = {};
  try {
    const token = await auth.currentUser?.getIdToken();
    if (token) authHeader = { Authorization: `Bearer ${token}` };
  } catch {}
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader },
    body: JSON.stringify({ reason: "sos", ...params }),
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) throw new Error(data?.error || "Server failed to place Telnyx call");
  return data;
}

// ======================= PAGE =======================
export default function DashboardPage() {
  const router = useRouter();
  const { toast } = useToast();

  // ---- Check-in state ----
  const [lastCheckIn, setLastCheckIn] = useState<Date | null>(null);
  const [intervalMinutes, setIntervalMinutes] = useState<number>(12 * 60);
  const [status, setStatus] = useState<Status>("unknown");
  const [timeLeft, setTimeLeft] = useState<string>("");

  // ---- Location sharing state ----
  const [locationSharing, setLocationSharing] = useState<boolean | null>(null);
  const [locationShareReason, setLocationShareReason] = useState<LocationShareReason | null>(null);
  const [locationSharedAt, setLocationSharedAt] = useState<Date | null>(null);
  const [escalationActiveAt, setEscalationActiveAt] = useState<Date | null>(null);
  const [locationMutationPending, setLocationMutationPending] = useState(false);
  const [clearingLocation, setClearingLocation] = useState(false);
  const [sharingLocation, setSharingLocation] = useState(false);

  // ---- Auth + role gate ----
  const [roleChecked, setRoleChecked] = useState(false);
  const [userDocLoaded, setUserDocLoaded] = useState(false);

  // ---- Emergency service + contacts shown on the page ----
  const [emergencyServiceCountry, setEmergencyServiceCountry] =
    useState<EmergencyServiceCountryCode>(DEFAULT_EMERGENCY_SERVICE_COUNTRY);
  const [primaryEmergencyContactPhone, setPrimaryEmergencyContactPhone] = useState<string | null>(null);
  const [primaryEmergencyContactEmail, setPrimaryEmergencyContactEmail] = useState<string | null>(null);
  const [primaryEmergencyContactName, setPrimaryEmergencyContactName] = useState<string>("Emergency Contact 1");
  const [secondaryEmergencyContactPhone, setSecondaryEmergencyContactPhone] = useState<string | null>(null);
  const [secondaryEmergencyContactEmail, setSecondaryEmergencyContactEmail] = useState<string | null>(null);
  const [secondaryEmergencyContactName, setSecondaryEmergencyContactName] = useState<string>("Emergency Contact 2");

  // ---- Main user's own phone field (right column settings) ----
  const [savedPhone, setSavedPhone] = useState<string>("");
  const [phoneDraft, setPhoneDraft] = useState<string>("");
  const [phoneSaving, setPhoneSaving] = useState(false);

  // ---- Voice quick message dialog (top of page) ----
  const [voiceMessageTarget, setVoiceMessageTarget] = useState<VoiceMessageTarget | null>(null);
  const [quickVoiceDialogOpen, setQuickVoiceDialogOpen] = useState(false);

  // ---- IDs & Refs ----
  const [mainUserUid, setMainUserUid] = useState<string | null>(null);
  const userDocUnsubRef = useRef<(() => void) | null>(null);
  const userRef = useRef<ReturnType<typeof doc> | null>(null);
  const autoCheckInTriggeredRef = useRef(false);
  const lastLocationShareRef = useRef<{ reason: LocationShareReason; ts: number } | null>(null);
  const prevEscalationActiveRef = useRef(false);

  // ---- Contact Dialog (tiles → pop-out) ----
  const [contactDialog, setContactDialog] = useState<ContactDialogState>({
    open: false,
    kind: null,
    name: "",
    phone: null,
    email: null,
  });
  const [latestVoiceFromContact, setLatestVoiceFromContact] = useState<LatestVoiceFromContact>(null);
  const latestAudioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlayingLatest, setIsPlayingLatest] = useState(false);

  // ---- Foreground push notifications ----
  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      const { isSupported, getMessaging, onMessage } = await import("firebase/messaging");
      if (!(await isSupported())) return;
      const { initializeApp, getApps } = await import("firebase/app");
      const apps = getApps();
      const app = apps.length
        ? apps[0]
        : initializeApp({
            apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
            authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
            projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
            messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID!,
            appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
          });
      const messaging = getMessaging(app);
      unsub = onMessage(messaging, async (payload) => {
        const reg = await navigator.serviceWorker.ready;
        const title = payload.notification?.title || payload.data?.title || "Notification";
        const body = payload.notification?.body || payload.data?.body || "";
        const url = payload.fcmOptions?.link || payload.data?.url || "/";
        reg.showNotification(title, { body, data: { url } });
      });
    })();
    return () => unsub?.();
  }, []);

  // ---- Auth + user doc subscription (role-gated) ----
  useEffect(() => {
    const offAuth = onAuthStateChanged(auth, async (user) => {
      // Cleanup previous doc listener
      userDocUnsubRef.current?.();
      userDocUnsubRef.current = null;

      // Signed out → reset local state
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

      // Signed in → subscribe to user doc
      setMainUserUid(user.uid);
      const uref = doc(db, "users", user.uid);
      userRef.current = uref;
      setUserDocLoaded(false);
      autoCheckInTriggeredRef.current = false;

      // Ensure doc exists
      await setDoc(uref, { createdAt: serverTimestamp() }, { merge: true });

      // Realtime subscription
      const unsub = onSnapshot(uref, (snap) => {
        if (!snap.exists()) {
          setRoleChecked(true);
          setUserDocLoaded(true);
          return;
        }
        const data = snap.data() as UserDoc;

        // Role gate
        setRoleChecked(true);
        const r = normalizeRole(data.role);
        if (r === "emergency_contact") {
          router.replace(EMERGENCY_DASH);
          return;
        }

        // Check-in state
        setLastCheckIn(data.lastCheckinAt instanceof Timestamp ? data.lastCheckinAt.toDate() : null);

        // Interval
        const rawInt = data.checkinInterval;
        const parsed =
          typeof rawInt === "string" ? parseInt(rawInt, 10) : typeof rawInt === "number" ? rawInt : NaN;
        if (!Number.isNaN(parsed) && parsed > 0) setIntervalMinutes(parsed);

        // Location consent
        setLocationSharing(typeof data.locationSharing === "boolean" ? data.locationSharing : null);

        // Share reason + timestamps
        const shareReason = data.locationShareReason;
        setLocationShareReason(shareReason === "sos" || shareReason === "escalation" ? shareReason : null);
        setLocationSharedAt(
          data.locationSharedAt instanceof Timestamp ? data.locationSharedAt.toDate() : null,
        );
        setEscalationActiveAt(
          data.missedNotifiedAt instanceof Timestamp ? data.missedNotifiedAt.toDate() : null,
        );

        // Phone field (right column)
        const storedPhone = typeof data.phone === "string" ? sanitizePhone(data.phone) : "";
        setPhoneDraft((prev) => {
          const prevSan = sanitizePhone(prev);
          if (!prevSan) return storedPhone; // empty → load from DB
          if (prevSan === storedPhone) return storedPhone; // same → keep normalized
          return prev; // otherwise preserve local edits
        });
        setSavedPhone(storedPhone);

        // Emergency contacts block
        const contacts = data.emergencyContacts;
        if (contacts) {
          const service = getEmergencyService(contacts.emergencyServiceCountry);
          setEmergencyServiceCountry(service.code);

          const first = (contacts.contact1_firstName || "").trim();
          const last = (contacts.contact1_lastName || "").trim();
          setPrimaryEmergencyContactName([first, last].filter(Boolean).join(" ") || "Emergency Contact 1");
          setPrimaryEmergencyContactPhone(
            contacts.contact1_phone ? sanitizePhone(contacts.contact1_phone) || null : null,
          );
          const primaryEmail = normalizeEmail(contacts.contact1_email);
          setPrimaryEmergencyContactEmail(primaryEmail || null);

          const first2 = (contacts.contact2_firstName || "").trim();
          const last2 = (contacts.contact2_lastName || "").trim();
          setSecondaryEmergencyContactName(
            [first2, last2].filter(Boolean).join(" ") || "Emergency Contact 2",
          );
          setSecondaryEmergencyContactPhone(
            contacts.contact2_phone ? sanitizePhone(contacts.contact2_phone) || null : null,
          );
          const secondaryEmail = normalizeEmail(contacts.contact2_email);
          setSecondaryEmergencyContactEmail(secondaryEmail || null);
        } else {
          // Reset when empty
          setEmergencyServiceCountry(DEFAULT_EMERGENCY_SERVICE_COUNTRY);
          setPrimaryEmergencyContactName("Emergency Contact 1");
          setPrimaryEmergencyContactPhone(null);
          setPrimaryEmergencyContactEmail(null);
          setSecondaryEmergencyContactName("Emergency Contact 2");
          setSecondaryEmergencyContactPhone(null);
          setSecondaryEmergencyContactEmail(null);
        }

        setUserDocLoaded(true);
      });

      userDocUnsubRef.current = unsub;
    });

    return () => {
      offAuth();
      userDocUnsubRef.current?.();
      userDocUnsubRef.current = null;
    };
  }, [router]);

  // ---- Register device for push (main user only) ----
  useEffect(() => {
    if (!roleChecked || !mainUserUid) return;
    registerDevice(mainUserUid, "primary");
  }, [roleChecked, mainUserUid]);

  // ---- Derived: next check-in time ----
  const nextCheckIn = useMemo(() => {
    if (!lastCheckIn) return null;
    return new Date(lastCheckIn.getTime() + intervalMinutes * 60 * 1000);
  }, [lastCheckIn, intervalMinutes]);

  // ---- Emergency service selection object ----
  const emergencyService = useMemo(
    () => getEmergencyService(emergencyServiceCountry),
    [emergencyServiceCountry],
  );

  // ---- Dial helper ----
  const handleDialEmergencyContact = useCallback((phone: string | null) => {
    if (!phone || typeof window === "undefined") return;
    window.location.href = `tel:${phone}`;
  }, []);

  // ---- Countdown + status ----
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
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [nextCheckIn]);

  // ---- Date pretty-printer used in several places ----
  const formatWhen = (d: Date | null) => {
    if (!d) return "—";
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    const isYesterday =
      d.getFullYear() === y.getFullYear() &&
      d.getMonth() === y.getMonth() &&
      d.getDate() === y.getDate();
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (sameDay) return `Today at ${time}`;
    if (isYesterday) return `Yesterday at ${time}`;
    return `${d.toLocaleDateString()} ${time}`;
  };

  // ---- Clear last shared location from Firestore ----
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

  // ---- Location capture result type ----
  type CaptureLocationResult =
    | { status: "shared"; location: string }
    | { status: "skipped" }
    | { status: "throttled" };

  // ---- Try to capture device location (with throttle + permission UX) ----
  const captureLocation = useCallback(
    async (
      reason: LocationShareReason,
      options: { silentIfDisabled?: boolean } = {},
    ): Promise<CaptureLocationResult> => {
      if (locationSharing === false) {
        if (!options.silentIfDisabled) {
          toast({
            title: "Location sharing disabled",
            description:
              "Enable location sharing in settings to send your location during SOS alerts.",
            variant: "destructive",
          });
        }
        return { status: "skipped" };
      }
      if (typeof window === "undefined" || !("geolocation" in navigator)) {
        toast({
          title: "Location unavailable",
          description:
            "Your device does not support location services. Try another device.",
          variant: "destructive",
        });
        return { status: "skipped" };
      }
      const perm = await ensureGeoAllowed();
      if (perm === false) {
        toast({
          title: "Location denied in browser",
          description:
            "Please enable location access for this site in your browser settings.",
          variant: "destructive",
        });
        return { status: "skipped" };
      }
      const last = lastLocationShareRef.current;
      const throttled =
        reason !== "sos" &&
        last &&
        last.reason === reason &&
        Date.now() - last.ts < LOCATION_SHARE_COOLDOWN_MS;
      if (throttled) return { status: "throttled" };

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
    [locationSharing, toast],
  );

  // ---- Persist a shared location ----
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
    [captureLocation, toast],
  );

  // ---- Enable/disable location consent ----
  const enableLocationSharing = useCallback(async () => {
    const ref = userRef.current;
    if (!ref)
      return toast({
        title: "Not signed in",
        description: "Please log in again.",
        variant: "destructive",
      });
    if (typeof window === "undefined" || !("geolocation" in navigator))
      return toast({
        title: "Location unavailable",
        description: "This device doesn't support location services.",
        variant: "destructive",
      });

    setLocationMutationPending(true);
    try {
      const perm = await ensureGeoAllowed();
      if (perm === false)
        return toast({
          title: "Location denied in browser",
          description:
            "Enable location access for this site in your browser settings.",
          variant: "destructive",
        });
      if (perm === "prompt") {
        await new Promise<GeolocationPosition>((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 15000,
          }),
        );
      }
      await updateDoc(ref, { locationSharing: true });
      setLocationSharing(true);
      toast({
        title: "Location sharing enabled",
        description: "We only share it during alerts.",
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

  const disableLocationSharing = useCallback(async () => {
    const ref = userRef.current;
    if (!ref)
      return toast({
        title: "Not signed in",
        description: "Please log in again.",
        variant: "destructive",
      });
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
        description: "Cleared the last shared location.",
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

  const handleClearSharedLocation = useCallback(async () => {
    if (!locationShareReason) return;
    setClearingLocation(true);
    try {
      await clearSharedLocation();
      toast({
        title: "Location cleared",
        description: "Removed from the emergency dashboard.",
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

  // ---- SOS flow ----
  const triggerSos = useCallback(async () => {
    const ref = userRef.current;
    if (!ref)
      return toast({
        title: "Not signed in",
        description: "Please log in again.",
        variant: "destructive",
      });

    const locationResult = await captureLocation("sos");
    const updates: Record<string, any> = { sosTriggeredAt: serverTimestamp() };
    if (locationResult.status === "shared") {
      updates.location = locationResult.location;
      updates.locationShareReason = "sos";
      updates.locationSharedAt = serverTimestamp();
    }
    let locationSaved = locationResult.status === "shared";

    try {
      await updateDoc(ref, updates);
    } catch (error: any) {
      toast({
        title: "SOS alert not recorded",
        description: error?.message ?? "Try again.",
        variant: "destructive",
      });
      locationSaved = false;
    }

    if (locationSaved) {
      lastLocationShareRef.current = { reason: "sos", ts: Date.now() };
      setLocationShareReason("sos");
      setLocationSharedAt(new Date());
      toast({ title: "Location shared", description: "Sent with your SOS alert." });
    }

    if (primaryEmergencyContactPhone) {
      try {
        await triggerServerTelnyxCall({
          to: primaryEmergencyContactPhone,
          mainUserUid: mainUserUid ?? undefined,
        });
      } catch (err: any) {
        toast({
          title: "Emergency contact call failed",
          description: err?.message ?? "Couldn’t start the Telnyx call.",
          variant: "destructive",
        });
      }
    } else {
      toast({
        title: "Emergency contact number missing",
        description: `Add a phone number for ${
          primaryEmergencyContactName || "your emergency contact"
        }.`,
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

  // ---- SOS press-and-hold binding ----
  const { bind, holding, progress } = useSosDialer({
    phoneNumber: emergencyService.dial,
    contactName: `Emergency services (${emergencyService.dial})`,
    holdToActivateMs: 1500,
    confirm: true,
    onActivate: () => {
      void triggerSos();
    },
  });
  const ready = (progress ?? 0) >= 0.999;
  const phoneDirty = sanitizePhone(phoneDraft) !== savedPhone;

  // ---- Auto share/clear on escalation begin/end ----
  useEffect(() => {
    const wasActive = prevEscalationActiveRef.current;
    const isActive = Boolean(escalationActiveAt);
    if (isActive && !wasActive) void shareLocation("escalation", { silentIfDisabled: true });
    else if (!isActive && wasActive) {
      clearSharedLocation().catch((e) =>
        console.error("Failed to clear shared location after escalation", e),
      );
    }
    prevEscalationActiveRef.current = isActive;
  }, [escalationActiveAt, shareLocation, clearSharedLocation]);

  // ---- Manual check-in ----
  const handleCheckIn = useCallback(
    async ({ showToast = true }: { showToast?: boolean } = {}) => {
      try {
        if (!userRef.current) throw new Error("Not signed in");
        const intervalMin =
          Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 720;
        const dueAtMin = toEpochMinutes(Date.now()) + intervalMin;

        setLastCheckIn(new Date()); // Optimistic
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
          } catch {}
        }

        if (showToast)
          toast({
            title: "Checked In!",
            description: "Your status has been updated to 'OK'.",
          });
      } catch (e: any) {
        toast({
          title: "Check-in failed",
          description: e?.message ?? "Please try again.",
          variant: "destructive",
        });
        throw e;
      }
    },
    [clearSharedLocation, intervalMinutes, locationShareReason, toast],
  );

  // ---- Voice check-in (modal) → after submit, also check in ----
  const handleVoiceCheckInComplete = useCallback(async () => {
    await handleCheckIn({ showToast: false });
    setVoiceMessageTarget(null);
    setQuickVoiceDialogOpen(false);
  }, [handleCheckIn]);

  // ---- Choose which contact to send a quick voice to (opens the voice modal) ----
  const handleVoiceMessageContact = useCallback(
    (contact: "primary" | "secondary") => {
      const isPrimary = contact === "primary";
      const name = isPrimary ? primaryEmergencyContactName : secondaryEmergencyContactName;
      const phone = isPrimary ? primaryEmergencyContactPhone : secondaryEmergencyContactPhone;
      const email = isPrimary ? primaryEmergencyContactEmail : secondaryEmergencyContactEmail;

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

  // ---- One-time auto check-in after auth+doc are ready ----
  useEffect(() => {
    if (autoCheckInTriggeredRef.current) return;
    if (!roleChecked || !mainUserUid || !userDocLoaded || !userRef.current) return;
    autoCheckInTriggeredRef.current = true;
    handleCheckIn({ showToast: false }).catch(() => {
      autoCheckInTriggeredRef.current = false;
    });
  }, [handleCheckIn, mainUserUid, roleChecked, userDocLoaded]);

  // ---- Map minutes → select value ----
  const selectedHours = useMemo(() => {
    const h = Math.round(intervalMinutes / 60);
    const isValid = HOURS_OPTIONS.some((opt) => opt === h);
    return isValid ? String(h) : "12";
  }, [intervalMinutes]);

  // ---- Persist check-in interval ----
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
        description: `Every ${hours} hours.`,
      });
    } catch (e: any) {
      toast({
        title: "Update failed",
        description: e?.message ?? "Please try again.",
        variant: "destructive",
      });
    }
  };

  // ---- Save main user's phone ----
  const handlePhoneSave = useCallback(async () => {
    if (!userRef.current)
      return toast({
        title: "Not signed in",
        description: "Please log in again.",
        variant: "destructive",
      });
    const sanitized = sanitizePhone(phoneDraft);
    if (sanitized && !isValidE164Phone(sanitized)) {
      return toast({
        title: "Invalid phone number",
        description: "Use format like +15551234567.",
        variant: "destructive",
      });
    }
    setPhoneSaving(true);
    try {
      await updateDoc(
        userRef.current,
        sanitized
          ? { phone: sanitized, updatedAt: serverTimestamp() }
          : { phone: deleteField(), updatedAt: serverTimestamp() },
      );
      setSavedPhone(sanitized);
      setPhoneDraft(sanitized);
      toast({
        title: "Phone number updated",
        description: sanitized
          ? "Emergency contacts will call this number."
          : "Phone number removed.",
      });
    } catch (error: any) {
      toast({
        title: "Update failed",
        description: error?.message ?? "Please try again.",
        variant: "destructive",
      });
    } finally {
      if (
        typeof document !== "undefined" &&
        document.activeElement instanceof HTMLElement
      ) {
        document.activeElement.blur();
      }
      setPhoneSaving(false);
    }
  }, [phoneDraft, toast]);

  const handlePhoneReset = useCallback(() => setPhoneDraft(savedPhone), [savedPhone]);

  // ---- NEW: Open/Close contact dialog + fetch latest voice from contact ----
  const openContactDialog = useCallback(
    async (kind: ContactKind) => {
      const isPrimary = kind === "primary";
      const name = isPrimary ? primaryEmergencyContactName : secondaryEmergencyContactName;
      const phone = isPrimary ? primaryEmergencyContactPhone : secondaryEmergencyContactPhone;
      const email = isPrimary ? primaryEmergencyContactEmail : secondaryEmergencyContactEmail;
      const normalizedEmail = normalizeEmail(email);

      setContactDialog({ open: true, kind, name, phone, email });

      // Optional: best-effort fetch of the latest voice message from this contact to the main user.
      if (!mainUserUid || !normalizedEmail) {
        setLatestVoiceFromContact(null);
        return;
      }
      try {
        const q = fsQuery(
          collection(db, `users/${mainUserUid}/contactVoiceMessages`),
          orderBy("createdAt", "desc"),
          limit(20),
        );
        const snap = await getDocs(q);
        if (snap.empty) {
          setLatestVoiceFromContact(null);
        } else {
          const match = snap.docs
            .map((doc) => doc.data() as any)
            .find((docData) => {
              const fromEmail = normalizeEmail(docData?.fromEmail);
              return fromEmail && fromEmail === normalizedEmail;
            });

          if (!match) {
            setLatestVoiceFromContact(null);
            return;
          }

          setLatestVoiceFromContact({
            audioUrl:
              typeof match?.audioUrl === "string" && match.audioUrl.trim()
                ? match.audioUrl
                : typeof match?.audioDataUrl === "string"
                ? match.audioDataUrl
                : "",
            createdAt: match?.createdAt?.toDate ? match.createdAt.toDate() : null,
            transcript: typeof match?.transcript === "string" ? match.transcript : undefined,
          });
        }
      } catch (e) {
        console.warn("Latest voice fetch failed:", e);
        setLatestVoiceFromContact(null);
      }
    },
    [
      db,
      mainUserUid,
      primaryEmergencyContactEmail,
      primaryEmergencyContactName,
      primaryEmergencyContactPhone,
      secondaryEmergencyContactEmail,
      secondaryEmergencyContactName,
      secondaryEmergencyContactPhone,
    ],
  );

  const closeContactDialog = useCallback(() => {
    setContactDialog((s) => ({ ...s, open: false }));
    setLatestVoiceFromContact(null);
    try {
      latestAudioRef.current?.pause();
      if (latestAudioRef.current) latestAudioRef.current.currentTime = 0;
    } catch {}
    setIsPlayingLatest(false);
  }, []);

  // ---- Avoid flashing UI before role check finishes ----
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

  // ======================= RENDER =======================
  return (
    <>
      {/* Voice quick message dialog (existing feature) */}
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

      {/* Contact actions dialog opened from the tiles */}
      <Dialog
        open={contactDialog.open}
        onOpenChange={(open) => {
          if (!open) closeContactDialog();
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader className="space-y-1.5">
            <DialogTitle>Contact details</DialogTitle>
            <DialogDescription>
              Quick actions for {contactDialog.name || "this contact"}.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 text-left">
            {/* Basics */}
            <div className="rounded-md border p-3">
              <p className="text-base font-semibold">{contactDialog.name || "—"}</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <div className="flex items-center gap-2 text-sm">
                  <Phone className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate">{contactDialog.phone || "No phone"}</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate">{contactDialog.email || "No email"}</span>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                onClick={() => handleDialEmergencyContact(contactDialog.phone)}
                disabled={!contactDialog.phone}
                className="w-full"
              >
                Call
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  handleVoiceMessageContact(
                    contactDialog.kind === "primary" ? "primary" : "secondary",
                  )
                }
                disabled={!contactDialog.phone && !contactDialog.email}
                className="w-full"
              >
                <Mic className="mr-2 h-4 w-4" aria-hidden />
                Voice
              </Button>
            </div>

            {/* Latest voice from this contact (if found) */}
            {latestVoiceFromContact ? (
              <div className="rounded-md border p-3">
                <p className="text-sm font-semibold">
                  Latest message from {contactDialog.name}
                </p>
                {latestVoiceFromContact.transcript && (
                  <p className="mt-1 text-sm text-muted-foreground italic">
                    “{latestVoiceFromContact.transcript}”
                  </p>
                )}
                {latestVoiceFromContact.createdAt && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Received {formatWhen(latestVoiceFromContact.createdAt)}
                  </p>
                )}
                <div className="mt-3 flex items-center gap-3">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={async () => {
                      const a = latestAudioRef.current;
                      if (!a) return;
                      try {
                        if (a.paused) {
                          await a.play();
                          setIsPlayingLatest(true);
                        } else {
                          a.pause();
                          a.currentTime = 0;
                          setIsPlayingLatest(false);
                        }
                      } catch {
                        setIsPlayingLatest(false);
                      }
                    }}
                  >
                    {isPlayingLatest ? (
                      <>
                        <Pause className="mr-2 h-4 w-4" /> Stop
                      </>
                    ) : (
                      <>
                        <Play className="mr-2 h-4 w-4" /> Play
                      </>
                    )}
                  </Button>
                  {/* hidden audio tag */}
                  <audio
                    ref={latestAudioRef}
                    src={latestVoiceFromContact.audioUrl || undefined}
                    preload="metadata"
                    className="hidden"
                    onEnded={() => setIsPlayingLatest(false)}
                    onPause={() => setIsPlayingLatest(false)}
                  />
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No recent voice message from this contact.
              </p>
            )}

            {/* Shortcut to manage contact details */}
            <div className="pt-2">
              <Button
                variant="ghost"
                className="gap-2"
                onClick={() => {
                  router.push("/emergency-settings");
                }}
              >
                <Settings className="h-4 w-4" /> Edit contact details
              </Button>
            </div>
          </div>

          <div className="flex justify-end pt-1">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Close
              </Button>
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>

      {/* Page chrome + content */}
      <div className="flex flex-col min-h-screen bg-secondary overflow-x-hidden">
        <Header />
        <main className="flex-grow container mx-auto px-4 pt-24 sm:pt-8 pb-8">
          <h1 className="text-3xl md:text-4xl font-headline font-bold mb-6">Your Dashboard</h1>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-6">
            {/* Primary column (main cards) */}
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 auto-rows-[minmax(18rem,_auto)] lg:col-span-1 xl:col-span-7">
              {/* SOS card */}
              <Card className={`${PRIMARY_CARD_BASE_CLASSES} border border-destructive bg-destructive/10 text-center`}>
                <CardHeader className={PRIMARY_CARD_HEADER_CLASSES}>
                  <CardTitle className={`${PRIMARY_CARD_TITLE_CLASSES} text-destructive`}>Emergency SOS</CardTitle>
                  <CardDescription className={`${PRIMARY_CARD_DESCRIPTION_CLASSES} font-medium text-destructive/80 break-words`}>
                    Tap only in a real emergency. We will dial {emergencyService.dial} for {emergencyService.label}.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col items-center justify-center gap-5">
                  <div className="flex flex-col items-center gap-3" aria-live="polite">
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
                      <div
                        className="absolute inset-0 rounded-full"
                        style={{
                          background: `conic-gradient(#ef4444 ${(progress || 0) * 360}deg, rgba(239,68,68,0.15) 0deg)`,
                          WebkitMask: "radial-gradient(circle 48px at center, transparent 47px, black 48px)",
                          mask: "radial-gradient(circle 48px at center, transparent 47px, black 48px)",
                          transition: "background 80ms linear",
                        }}
                      />
                      <Button
                        {...bind}
                        aria-label={ready ? `Release to call ${emergencyService.dial}` : `Hold to call ${emergencyService.dial}`}
                        variant="destructive"
                        size="lg"
                        className={`relative z-[1] h-24 w-24 md:h-28 md:w-28 rounded-full text-2xl shadow-lg transition-transform ${
                          holding ? "opacity-90" : "hover:scale-105"
                        }`}
                      >
                        <Siren className="h-12 w-12" />
                      </Button>
                    </div>
                    <p className="text-lg font-medium text-destructive/80 break-words text-center">
                      {holding ? (ready ? `Release to call ${emergencyService.dial}` : "Keep holding…") : `Hold 1.5s to call ${emergencyService.dial}`}
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* Check-in card */}
              <Card className={`${PRIMARY_CARD_BASE_CLASSES} text-center`}>
                <CardHeader className={PRIMARY_CARD_HEADER_CLASSES}>
                  <CardTitle className={PRIMARY_CARD_TITLE_CLASSES}>Check-in</CardTitle>
                  <CardDescription className={PRIMARY_CARD_DESCRIPTION_CLASSES}>Let your contacts know you’re safe.</CardDescription>
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

              {/* Status overview */}
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
                      <dd className={`text-lg font-semibold ${status === "missed" ? "text-destructive" : "text-primary"}`}>
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
                        {locationSharing === null ? "—" : locationSharing ? "Enabled" : "Disabled"}
                      </dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>

              {/* Voice Update card (broadcast) */}
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
                    /**
                     * IMPORTANT:
                     * Voice Update card should BROADCAST to both contacts.
                     * To ensure that, we pass targetContact={null} here.
                     * The targeted (single-contact) send happens only from the modal opened via tiles.
                     */
                    <VoiceCheckIn
                      onCheckIn={handleVoiceCheckInComplete}
                      targetContact={null}
                      onClearTarget={() => setVoiceMessageTarget(null)}
                    />
                  )}
                </CardContent>
              </Card>

              {/* Emergency Contacts tiles (click → pop-out dialog above) */}
              <Card className={`${PRIMARY_CARD_BASE_CLASSES} text-center`}>
                <CardHeader className={`${PRIMARY_CARD_HEADER_CLASSES} items-center`}>
                  <PhoneCall className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
                  <CardTitle className={PRIMARY_CARD_TITLE_CLASSES}>Emergency Contacts</CardTitle>
                  <CardDescription className={PRIMARY_CARD_DESCRIPTION_CLASSES}>
                    Tap a contact to see call & voice options.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-6">
                  <div className="grid gap-4 sm:grid-cols-2">
                    {/* Primary tile */}
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-28 rounded-xl border text-left flex flex-col items-start justify-center px-4"
                      onClick={() => openContactDialog("primary")}
                    >
                      <span className="text-lg font-semibold">
                        {primaryEmergencyContactName}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {primaryEmergencyContactPhone ||
                          primaryEmergencyContactEmail ||
                          "No details yet"}
                      </span>
                    </Button>

                    {/* Secondary tile */}
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-28 rounded-xl border text-left flex flex-col items-start justify-center px-4"
                      onClick={() => openContactDialog("secondary")}
                    >
                      <span className="text-lg font-semibold">
                        {secondaryEmergencyContactName}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {secondaryEmergencyContactPhone ||
                          secondaryEmergencyContactEmail ||
                          "No details yet"}
                      </span>
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Ask AI card */}
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
                  {/* Phone settings */}
                  <section className="space-y-3">
                    <div className="space-y-2">
                      <Label htmlFor="main-user-phone">Your mobile phone</Label>
                      <Input
                        id="main-user-phone"
                        placeholder="+15551234567"
                        value={phoneDraft}
                        onChange={(e) => setPhoneDraft(e.target.value)}
                        disabled={phoneSaving}
                        inputMode="tel"
                      />
                      <p className="text-xs text-muted-foreground">
                        Include country code. We’ll auto-format for emergency contacts.
                      </p>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row">
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

                  {/* Interval settings */}
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

                  {/* Location sharing settings */}
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
                        Last shared for{" "}
                        {locationShareReason === "sos" ? "an SOS alert" : "an escalation"}
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
                      <p className="text-xs text-muted-foreground">
                        Sharing your current location…
                      </p>
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
