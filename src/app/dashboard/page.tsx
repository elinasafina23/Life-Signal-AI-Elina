// app/dashboard/page.tsx
"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  onSnapshot,
  doc,
  Timestamp,
  setDoc,
  updateDoc,
  serverTimestamp,
  deleteField,
} from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";
import { useRouter } from "next/navigation";
import { auth, db } from "@/firebase";

import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { VoiceCheckIn } from "@/components/voice-check-in";
import { EmergencyContacts } from "@/components/emergency-contact";
import { useSosDialer } from "@/hooks/useSosDialer";

// shadcn/ui
import { Button } from "@/components/ui/button";
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
import { useToast } from "@/hooks/use-toast";

// icons
import { Siren, CheckCircle2, Timer, Clock } from "lucide-react";

// roles
import { normalizeRole } from "@/lib/roles";

// push device registration
import { registerDevice } from "@/lib/useFcmToken";

interface UserDoc {
  lastCheckinAt?: Timestamp;
  checkinInterval?: number | string; // minutes
  locationSharing?: boolean;
  sosTriggeredAt?: Timestamp;
  role?: string;
  locationShareReason?: LocationShareReason | null;
  locationSharedAt?: Timestamp;
  missedNotifiedAt?: Timestamp | null;
}

type Status = "safe" | "missed" | "unknown";

type LocationShareReason = "sos" | "escalation";

// helper to compute minutes-since-epoch
const toEpochMinutes = (ms: number) => Math.floor(ms / 60000);

const HOURS_OPTIONS = [1, 2, 3, 6, 10, 12, 18, 24] as const;
const LOCATION_SHARE_COOLDOWN_MS = 60_000;
const GEO_PERMISSION_DENIED = 1;
const GEO_POSITION_UNAVAILABLE = 2;
const GEO_TIMEOUT = 3;

function describeGeoError(error: unknown) {
  const defaultMessage =
    "We couldn't access your current location. Please enable location services and try again.";

  if (!error || typeof error !== "object") {
    return defaultMessage;
  }

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

export default function DashboardPage() {
  const router = useRouter();
  const { toast } = useToast();

  const [lastCheckIn, setLastCheckIn] = useState<Date | null>(null);
  const [intervalMinutes, setIntervalMinutes] = useState<number>(12 * 60); // default 12h
  const [status, setStatus] = useState<Status>("unknown");
  const [timeLeft, setTimeLeft] = useState<string>("");
  const [locationSharing, setLocationSharing] = useState<boolean | null>(null);
  const [locationShareReason, setLocationShareReason] = useState<LocationShareReason | null>(
    null
  );
  const [locationSharedAt, setLocationSharedAt] = useState<Date | null>(null);
  const [escalationActiveAt, setEscalationActiveAt] = useState<Date | null>(null);
  const [locationMutationPending, setLocationMutationPending] = useState(false);
  const [clearingLocation, setClearingLocation] = useState(false);
  const [sharingLocation, setSharingLocation] = useState(false);
  const [roleChecked, setRoleChecked] = useState(false);
  const [userDocLoaded, setUserDocLoaded] = useState(false);

  // 👇 renamed to mainUserUid for clarity
  const [mainUserUid, setMainUserUid] = useState<string | null>(null);

  const userDocUnsubRef = useRef<(() => void) | null>(null);
  const userRef = useRef<ReturnType<typeof doc> | null>(null);
  const autoCheckInTriggeredRef = useRef(false);
  const lastLocationShareRef = useRef<{ reason: LocationShareReason; ts: number } | null>(null);
  const prevEscalationActiveRef = useRef(false);
  const hasAutoClearedOnActiveRef = useRef(false);

  // Handle push notifications while app is open
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

  // 🔑 Auth + Firestore subscription
  useEffect(() => {
    const offAuth = onAuthStateChanged(auth, async (user) => {
      if (userDocUnsubRef.current) {
        userDocUnsubRef.current();
        userDocUnsubRef.current = null;
      }

      if (!user) {
        userRef.current = null;
        setMainUserUid(null); // reset UID
        setLastCheckIn(null);
        setIntervalMinutes(12 * 60);
        setStatus("unknown");
        setTimeLeft("");
        setLocationSharing(null);
        setRoleChecked(true);
        setUserDocLoaded(false);
        autoCheckInTriggeredRef.current = false;
        return;
      }

      setMainUserUid(user.uid); // store main user UID
      const uref = doc(db, "users", user.uid);
      userRef.current = uref;
      setUserDocLoaded(false);
      autoCheckInTriggeredRef.current = false;

      await setDoc(uref, { createdAt: serverTimestamp() }, { merge: true });

      const unsub = onSnapshot(uref, (snap) => {
        if (!snap.exists()) {
          setRoleChecked(true);
          setUserDocLoaded(true);
          return;
        }
        const data = snap.data() as UserDoc;

        // 🚫 Prevent emergency contacts from seeing this dashboard
        const r = normalizeRole(data.role);
        if (r === "emergency_contact") {
          router.replace("/emergency-dashboard");
          return;
        }

        setRoleChecked(true);

        if (data.lastCheckinAt instanceof Timestamp) {
          setLastCheckIn(data.lastCheckinAt.toDate());
        } else {
          setLastCheckIn(null);
        }

        const rawInt = data.checkinInterval;
        const parsed =
          typeof rawInt === "string"
            ? parseInt(rawInt, 10)
            : typeof rawInt === "number"
            ? rawInt
            : NaN;
        if (!Number.isNaN(parsed) && parsed > 0) setIntervalMinutes(parsed);

        if (typeof data.locationSharing === "boolean") {
          setLocationSharing(data.locationSharing);
        }

        const shareReason = data.locationShareReason;
        if (shareReason === "sos" || shareReason === "escalation") {
          setLocationShareReason(shareReason);
        } else {
          setLocationShareReason(null);
        }

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

        setUserDocLoaded(true);
      });

      userDocUnsubRef.current = unsub;
    });

    return () => {
      offAuth();
      if (userDocUnsubRef.current) {
        userDocUnsubRef.current();
        userDocUnsubRef.current = null;
      }
    };
  }, [router]);

  // Register device for push under this main user
  useEffect(() => {
    if (!roleChecked || !mainUserUid) return;
    registerDevice(mainUserUid, "primary");
  }, [roleChecked, mainUserUid]);

  // Compute next check-in time
  const nextCheckIn = useMemo(() => {
    if (!lastCheckIn) return null;
    return new Date(lastCheckIn.getTime() + intervalMinutes * 60 * 1000);
  }, [lastCheckIn, intervalMinutes]);

  // Countdown + status updater
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

  // --- UI helpers ---
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
    hasAutoClearedOnActiveRef.current = false;
    setLocationShareReason(null);
    setLocationSharedAt(null);
  }, []);

  const shareLocation = useCallback(
    async (reason: LocationShareReason) => {
      if (locationSharing === false) {
        toast({
          title: "Location sharing disabled",
          description: "Enable location sharing first so we can send your SOS location.",
          variant: "destructive",
        });
        return false;
      }

      const ref = userRef.current;
      if (!ref) return false;

      if (typeof window === "undefined" || !("geolocation" in navigator)) {
        toast({
          title: "Location unavailable",
          description:
            "Your device does not support location services. Try another device to share your location.",
          variant: "destructive",
        });
        return false;
      }

      const last = lastLocationShareRef.current;
      if (last && last.reason === reason && Date.now() - last.ts < LOCATION_SHARE_COOLDOWN_MS) {
        return true;
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

        await updateDoc(ref, {
          location: locationString,
          locationShareReason: reason,
          locationSharedAt: serverTimestamp(),
        });

        lastLocationShareRef.current = { reason, ts: Date.now() };
        hasAutoClearedOnActiveRef.current = false;
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
      } finally {
        setSharingLocation(false);
      }
    },
    [locationSharing, toast]
  );

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
      await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15_000,
        });
      });

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

  // 🚨 SOS dialer (press & hold → confirm → call)
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

    try {
      await updateDoc(ref, { sosTriggeredAt: serverTimestamp() });
    } catch (error: any) {
      console.error("Failed to record SOS trigger", error);
      toast({
        title: "SOS alert not recorded",
        description: error?.message ?? "We couldn't notify your contacts. Please try again.",
        variant: "destructive",
      });
    }

    await shareLocation("sos");
  }, [shareLocation, toast]);

  const { bind, holding } = useSosDialer({
    phoneNumber: "+78473454308", // TODO: make configurable
    contactName: "Mom",
    holdToActivateMs: 1500,
    confirm: true,
    onActivate: triggerSos,
  });

  useEffect(() => {
    const wasActive = prevEscalationActiveRef.current;
    const isActive = Boolean(escalationActiveAt);

    if (!isActive && wasActive) {
      clearSharedLocation().catch((error) => {
        console.error("Failed to clear shared location after escalation resolved", error);
      });
    }

    prevEscalationActiveRef.current = isActive;
  }, [escalationActiveAt, clearSharedLocation]);

  // Automatically clear any previously shared location as soon as the
  // dashboard is opened or refreshed. This ensures we only share when the
  // user explicitly triggers SOS.
  useEffect(() => {
    if (!userDocLoaded) return;
    if (!locationShareReason) return;
    if (hasAutoClearedOnActiveRef.current) return;

    // If a location share happened in this session we don't want to clear it
    // immediately. That share will set the ref below.
    if (lastLocationShareRef.current?.reason === locationShareReason) {
      return;
    }

    hasAutoClearedOnActiveRef.current = true;

    clearSharedLocation().catch((error) => {
      console.error("Failed to clear shared location when user became active", error);
    });
  }, [clearSharedLocation, locationShareReason, userDocLoaded]);

  // ✅ Manual check-in
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

  useEffect(() => {
    if (autoCheckInTriggeredRef.current) return;
    if (!roleChecked || !mainUserUid || !userDocLoaded || !userRef.current) return;

    autoCheckInTriggeredRef.current = true;
    handleCheckIn({ showToast: false }).catch(() => {
      autoCheckInTriggeredRef.current = false;
    });
  }, [handleCheckIn, mainUserUid, roleChecked, userDocLoaded]);

  // Update interval + recompute dueAtMin
  const selectedHours = useMemo(() => {
    const h = Math.round(intervalMinutes / 60);
    const isValidOption = HOURS_OPTIONS.some((option) => option === h);
    return isValidOption ? String(h) : "12";
  }, [intervalMinutes]);

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

  // Prevent flashing dashboard before role check
  if (!roleChecked) {
    return (
      <div className="flex flex-col min-h-screen bg-secondary">
        <Header />
        <main className="flex-grow container mx-auto px-4 py-8">
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

  // --- UI ---
  return (
    <div className="flex flex-col min-h-screen bg-secondary">
      <Header />
      <main className="flex-grow container mx-auto px-4 py-8">
        <h1 className="text-3xl md:text-4xl font-headline font-bold mb-6">Your Dashboard</h1>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column */}
          <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* SOS */}
            <Card className="text-center bg-destructive/10 border-destructive shadow-lg hover:shadow-xl transition-shadow">
              <CardHeader>
                <CardTitle className="text-3xl font-headline text-destructive">Emergency SOS</CardTitle>
                <CardDescription className="text-destructive/80">
                  Tap only in a real emergency.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  {...bind}
                  aria-label="Call Mom"
                  variant="destructive"
                  size="lg"
                  className={`h-32 w-32 rounded-full text-2xl shadow-lg transition-transform ${
                    holding ? "opacity-90" : "hover:scale-105"
                  }`}
                >
                  <Siren className="h-16 w-16" />
                </Button>
              </CardContent>
            </Card>

            {/* Manual Check-in */}
            <Card className="text-center shadow-lg hover:shadow-xl transition-shadow">
              <CardHeader>
                <CardTitle className="text-3xl font-headline">Manual Check-in</CardTitle>
                <CardDescription>Let your emergency contacts know you're safe.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  onClick={() => handleCheckIn()}
                  size="lg"
                  className="h-32 w-32 rounded-full text-2xl shadow-lg bg-green-500 hover:bg-green-600"
                >
                  <CheckCircle2 className="h-16 w-16" />
                </Button>
              </CardContent>
            </Card>

            {/* Interval */}
            <Card className="shadow-lg">
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-2xl font-headline">Set Interval</CardTitle>
                  <CardDescription>Choose your check-in frequency.</CardDescription>
                </div>
                <Clock className="h-8 w-8 text-muted-foreground" />
              </CardHeader>
              <CardContent>
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
                <p className="mt-2 text-sm text-muted-foreground">
                  Current interval: {Math.floor(intervalMinutes / 60)}h {intervalMinutes % 60}m
                </p>
              </CardContent>
            </Card>

            {/* Status */}
            <Card className="shadow-lg">
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-2xl font-headline">Status</CardTitle>
                  <CardDescription>Your latest activity.</CardDescription>
                </div>
                <Timer className="h-8 w-8 text-muted-foreground" />
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-lg">
                  Last Check-in:{" "}
                  <span className="font-bold text-primary">{formatWhen(lastCheckIn)}</span>
                </p>
                <p className="text-lg">
                  Next scheduled check-in:{" "}
                  <span className="font-bold text-primary">{formatWhen(nextCheckIn)}</span>
                </p>
                <p className="text-lg">
                  Countdown:{" "}
                  <span
                    className={
                      status === "missed" ? "font-bold text-destructive" : "font-bold text-primary"
                    }
                  >
                    {timeLeft || "—"}
                  </span>
                </p>
                <p className="text-lg">
                  Status:{" "}
                  <span
                    className={
                      status === "safe"
                        ? "font-bold text-green-600"
                        : status === "missed"
                        ? "font-bold text-destructive"
                        : "font-bold text-muted-foreground"
                    }
                  >
                    {status.toUpperCase()}
                  </span>
                </p>
                <p className="text-lg">
                  Location Sharing:{" "}
                  <span
                    className={
                      locationSharing === true
                        ? "font-bold text-green-600"
                        : locationSharing === false
                        ? "font-bold text-destructive"
                        : "font-bold text-muted-foreground"
                    }
                  >
                    {locationSharing === null ? "—" : locationSharing ? "Enabled" : "Disabled"}
                  </span>
                </p>
              </CardContent>
            </Card>

            <Card className="shadow-lg">
              <CardHeader>
                <CardTitle className="text-2xl font-headline">Location Sharing</CardTitle>
                <CardDescription>Share your location only when an alert is active.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-left">
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
                      disabled={
                        clearingLocation || locationMutationPending || !locationShareReason
                      }
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
              </CardContent>
            </Card>

            {/* Emergency Contacts */}
            <div className="md:col-span-2">
              <EmergencyContacts />
            </div>
          </div>

          {/* Right column */}
          <div className="lg:col-span-1">
            <Card className="p-4 shadow-lg">
              <CardHeader>
                <CardTitle className="text-2xl font-headline">Voice Check-in</CardTitle>
                <CardDescription>Say “I'm OK” to check in.</CardDescription>
              </CardHeader>
              <CardContent>
                <VoiceCheckIn onCheckIn={handleCheckIn} />
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}