// app/dashboard/page.tsx
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  onSnapshot,
  doc,
  Timestamp,
  setDoc,
  updateDoc,
  serverTimestamp,
} from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";
import { useRouter } from "next/navigation";
import { auth, db } from "@/firebase";

import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { VoiceCheckIn } from "@/components/voice-check-in";
import { EmergencyContacts } from "@/components/emergency-contact";

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

// ✅ device registration (primary role for this dashboard)
import { registerDevice } from "@/lib/useFcmToken";

interface UserDoc {
  lastCheckinAt?: Timestamp;
  checkinInterval?: number | string; // minutes
  locationSharing?: boolean;
  sosTriggeredAt?: Timestamp;
  role?: string;
}

type Status = "safe" | "missed" | "unknown";

export default function DashboardPage() {
  const router = useRouter();
  const { toast } = useToast();

  const [lastCheckIn, setLastCheckIn] = useState<Date | null>(null);
  const [intervalMinutes, setIntervalMinutes] = useState<number>(12 * 60); // default 12h
  const [status, setStatus] = useState<Status>("unknown");
  const [timeLeft, setTimeLeft] = useState<string>("");
  const [locationSharing, setLocationSharing] = useState<boolean | null>(null);
  const [roleChecked, setRoleChecked] = useState(false);
  const [uid, setUid] = useState<string | null>(null);

  const userDocUnsubRef = useRef<(() => void) | null>(null);
  const userRef = useRef<ReturnType<typeof doc> | null>(null);

// Show OS banner even when the tab is focused
useEffect(() => {
  let unsub: (() => void) | undefined;

  (async () => {
    const { isSupported, getMessaging, onMessage } = await import('firebase/messaging');
    if (!(await isSupported())) return;

    // reuse your initialized app via dynamic import of your firebase module
    const { initializeApp, getApps } = await import('firebase/app');
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
      const title = payload.notification?.title || payload.data?.title || 'Notification';
      const body  = payload.notification?.body  || payload.data?.body  || '';
      const url   = payload.fcmOptions?.link    || payload.data?.url    || '/';
      reg.showNotification(title, { body, data: { url } });
    });
  })();

  return () => unsub?.();
}, []);




  // Auth + Firestore subscription
  useEffect(() => {
    const offAuth = onAuthStateChanged(auth, async (user) => {
      // clean old listener
      if (userDocUnsubRef.current) {
        userDocUnsubRef.current();
        userDocUnsubRef.current = null;
      }

      if (!user) {
        userRef.current = null;
        setUid(null);
        setLastCheckIn(null);
        setIntervalMinutes(12 * 60);
        setStatus("unknown");
        setTimeLeft("");
        setLocationSharing(null);
        setRoleChecked(true);
        return;
      }

      setUid(user.uid);
      const uref = doc(db, "users", user.uid);
      userRef.current = uref;

      // Ensure doc exists so later updates don't fail
      await setDoc(uref, { createdAt: serverTimestamp() }, { merge: true });

      const unsub = onSnapshot(uref, (snap) => {
        if (!snap.exists()) {
          setRoleChecked(true);
          return;
        }
        const data = snap.data() as UserDoc;

        // Gate by role: emergency contacts aren't allowed here
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
        if (!Number.isNaN(parsed) && parsed > 0) {
          setIntervalMinutes(parsed);
        }

        if (typeof data.locationSharing === "boolean") {
          setLocationSharing(data.locationSharing);
        }
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

  // ✅ Register this device for push in the main dashboard (role: "primary")
  useEffect(() => {
    if (!roleChecked || !uid) return;
    // Only run registration when we're definitively on the primary dashboard
    // (If you also use role in UI state, you could gate it further.)
    registerDevice(uid, "primary"); // stores token under users/{uid}/devices/{deviceId} with role: "primary"
  }, [roleChecked, uid]);

  // Derived next check-in time
  const nextCheckIn = useMemo(() => {
    if (!lastCheckIn) return null;
    return new Date(lastCheckIn.getTime() + intervalMinutes * 60 * 1000);
  }, [lastCheckIn, intervalMinutes]);

  // Countdown + status
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

  // ---- UI helpers & actions ----
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

  const handleCheckIn = async () => {
    try {
      if (!userRef.current) throw new Error("Not signed in");
      // optimistic UI
      setLastCheckIn(new Date());
      await updateDoc(userRef.current, {
        lastCheckinAt: serverTimestamp(),
      });
      toast({ title: "Checked In!", description: "Your status has been updated to 'OK'." });
    } catch (e: any) {
      toast({
        title: "Check-in failed",
        description: e?.message ?? "Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleSOS = async () => {
    try {
      if (!userRef.current) throw new Error("Not signed in");
    await updateDoc(userRef.current, {
        sosTriggeredAt: serverTimestamp(),
      });
      toast({
        title: "SOS Alert Sent!",
        description: "Your emergency contacts have been notified.",
        variant: "destructive",
      });
    } catch (e: any) {
      toast({
        title: "Unable to send SOS",
        description: e?.message ?? "Please try again.",
        variant: "destructive",
      });
    }
  };

  const HOURS_OPTIONS = [1, 2, 3, 6, 10, 12, 18, 24] as const;
  const selectedHours = useMemo(() => {
    const h = Math.round(intervalMinutes / 60);
    return HOURS_OPTIONS.includes(h as any) ? String(h) : "12";
  }, [intervalMinutes]);

  const handleIntervalChange = async (value: string) => {
    const hours = parseInt(value, 10);
    const minutes = hours * 60;
    try {
      setIntervalMinutes(minutes);
      if (!userRef.current) throw new Error("Not signed in");
      await updateDoc(userRef.current, { checkinInterval: minutes });
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

  // Don't flash dashboard before we confirm role
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
                <CardDescription className="text-destructive/80">Tap only in a real emergency.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  onClick={handleSOS}
                  variant="destructive"
                  size="lg"
                  className="h-32 w-32 rounded-full text-2xl shadow-lg hover:scale-105 transition-transform"
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
                  onClick={handleCheckIn}
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

            {/* Contacts */}
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
                <VoiceCheckIn />
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
