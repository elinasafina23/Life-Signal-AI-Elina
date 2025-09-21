// app/emergency-dashboard/page.tsx
"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "@/firebase";

// Firestore
import {
  collectionGroup,
  onSnapshot,
  query,
  where,
  doc,
  getDoc,
  Timestamp,
  type Unsubscribe,
  type Query as FsQuery,
  type QuerySnapshot,
  type DocumentData,
} from "firebase/firestore";

import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { MapPin, Phone, MessageSquare, Settings as SettingsIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Centered popup dialog
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

// Push registration + roles
import { registerDevice } from "@/lib/useFcmToken";
import { normalizeRole } from "@/lib/roles";

// ---------------------- Types ----------------------
export type Status = "OK" | "Inactive" | "SOS";

export type MainUserCard = {
  mainUserUid: string;
  name: string;
  avatar?: string;
  initials: string;
  status?: Status;
  lastCheckIn?: string;
  location?: string; // address or "lat,lng"
  colorClass: string;
};

export type MainUserDoc = {
  firstName?: string;
  lastName?: string;
  avatar?: string;
  lastCheckinAt?: Timestamp;
  checkinInterval?: number | string;
  sosTriggeredAt?: Timestamp;
  location?: string; // address or "lat,lng"
  role?: string;
  dueAtMin?: number; // materialized next deadline (minutes since epoch)
};

// ---------------------- Helpers ----------------------
const userColors = [
  "bg-red-200",
  "bg-blue-200",
  "bg-green-200",
  "bg-yellow-200",
  "bg-purple-200",
  "bg-pink-200",
];

function initialsAndColor(name = "") {
  const initials =
    name
      .split(" ")
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "UA";

  const colorIndex =
    name.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0) % userColors.length;

  return { initials, colorClass: userColors[colorIndex] };
}

function getStatusVariant(status?: string) {
  switch (status) {
    case "OK":
      return "default";
    case "Inactive":
      return "secondary";
    case "SOS":
      return "destructive";
    default:
      return "outline";
  }
}

function formatWhen(d?: Date | null) {
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
}

function getMapImage(location?: string) {
  const FALLBACK = {
    src: "/images/map-fallback-600x300.png",
    alt: "Map placeholder",
  } as const;

  if (!location) return FALLBACK;

  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!key) return FALLBACK;

  const q = encodeURIComponent(location.trim());
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${q}&zoom=13&size=600x300&maptype=roadmap&markers=color:red|${q}&key=${key}`;

  return { src: url, alt: `Map of ${location}` } as const;
}

// ---------------------- Page ----------------------
export default function EmergencyDashboardPage() {
  const router = useRouter();
  const { toast } = useToast();

  const [mainUsers, setMainUsers] = useState<MainUserCard[]>([]);
  const [loading, setLoading] = useState(true);

  // ✅ renamed to the canonical contact id
  const [emergencyContactUid, setEmergencyContactUid] = useState<string | null>(null);

  // centered popup when location is missing
  const [noLocationUser, setNoLocationUser] = useState<MainUserCard | null>(null);

  // keep all active unsubscribers here
  const unsubsRef = useRef<Record<string, Unsubscribe>>({});

  useEffect(() => {
    const LINKS_KEY = "links";

    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      // clean up any previous listeners
      Object.values(unsubsRef.current).forEach((fn) => fn());
      unsubsRef.current = {};
      setMainUsers([]);
      setEmergencyContactUid(null);

      if (!user) {
        setLoading(false);
        router.replace(
          `/login?role=emergency_contact&next=${encodeURIComponent("/emergency-dashboard")}`
        );
        return;
      }

      // gate by role using your users/{uid}.role
      try {
        const meSnap = await getDoc(doc(db, "users", user.uid));
        const myRole = normalizeRole(meSnap.exists() ? (meSnap.data() as any).role : undefined);
        if (myRole !== "emergency_contact") {
          router.replace("/dashboard");
          return;
        }
      } catch {
        router.replace(
          `/login?role=emergency_contact&next=${encodeURIComponent("/emergency-dashboard")}`
        );
        return;
      }

      setEmergencyContactUid(user.uid);
      setLoading(false);

      // ✅ New canonical link query:
      // users/{mainUserUid}/emergency_contact/{linkDoc} where emergencyContactUid == current user.uid
      const linksByEmergencyContactUid = query(
        collectionGroup(db, "emergency_contact"),
        where("emergencyContactUid", "==", user.uid)
      );

      function wireLinksListener(q: FsQuery<DocumentData>, key: string) {
        unsubsRef.current[key] = onSnapshot(q, (linksSnap: QuerySnapshot<DocumentData>) => {
          // gather all main user IDs referenced by the link snapshot(s)
          const nextMainUserIds = new Set<string>(
            Object.keys(unsubsRef.current).filter((k) => k !== LINKS_KEY)
          );

          linksSnap.forEach((linkDoc) => {
            // users/{MAIN_UID}/emergency_contact/{...}
            const mainUserUid = linkDoc.ref.parent.parent?.id;
            if (mainUserUid) nextMainUserIds.add(mainUserUid);
          });

          // remove listeners for unlinked users
          Object.keys(unsubsRef.current).forEach((k) => {
            if (k === LINKS_KEY) return;
            if (!nextMainUserIds.has(k)) {
              unsubsRef.current[k](); // unsubscribe
              delete unsubsRef.current[k];
            }
          });

          // ensure we are listening to each linked main user doc
          nextMainUserIds.forEach((mainUserId) => {
            if (unsubsRef.current[mainUserId]) return;

            const userDocRef = doc(db, "users", mainUserId);
            unsubsRef.current[mainUserId] = onSnapshot(
              userDocRef,
              (userDocSnap) => {
                const userData = (userDocSnap.data() as MainUserDoc) || undefined;

                const name =
                  `${userData?.firstName || ""} ${userData?.lastName || ""}`.trim() ||
                  "Main User";
                const displayName = `${userData?.firstName || ""} ${
                  userData?.lastName?.[0] || ""
                }`.trim();
                const { initials, colorClass } = initialsAndColor(name);

                const last =
                  userData?.lastCheckinAt instanceof Timestamp
                    ? userData.lastCheckinAt.toDate()
                    : undefined;

                const rawInt = userData?.checkinInterval;
                const intervalMin =
                  typeof rawInt === "number" ? rawInt : parseInt(String(rawInt ?? ""), 10) || 12 * 60;

                // ✅ prefer dueAtMin from backend if present
                const dueAtMin = Number((userData as any)?.dueAtMin);
                const nowMin = Math.floor(Date.now() / 60000);

                let status: Status = "OK";
                if (userData?.sosTriggeredAt instanceof Timestamp) {
                  status = "SOS";
                } else if (Number.isFinite(dueAtMin)) {
                  status = nowMin >= dueAtMin ? "Inactive" : "OK";
                } else if (last) {
                  const nextDue = last.getTime() + intervalMin * 60 * 1000;
                  status = Date.now() > nextDue ? "Inactive" : "OK";
                } else {
                  status = "Inactive";
                }

                const updatedCard: MainUserCard = {
                  mainUserUid: mainUserId,
                  name: displayName || name,
                  avatar: userData?.avatar,
                  initials,
                  colorClass,
                  status,
                  lastCheckIn: formatWhen(last),
                  location: userData?.location || "",
                };

                setMainUsers((prev) => {
                  const map = new Map(prev.map((u) => [u.mainUserUid, u]));
                  map.set(mainUserId, updatedCard);
                  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
                });
              },
              (error) => {
                console.error(`[Emergency Dashboard] User doc listen failed for ${mainUserId}:`, error);
                const { initials, colorClass } = initialsAndColor("User Load Error");
                setMainUsers((prev) => {
                  const map = new Map(prev.map((u) => [u.mainUserUid, u]));
                  map.set(mainUserId, {
                    mainUserUid: mainUserId,
                    name: "User Load Error",
                    initials,
                    colorClass,
                    status: "Inactive",
                  });
                  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
                });
              }
            );
          });

          // drop any cards that are no longer linked
          setMainUsers((prev) => {
            const valid = new Set(Object.keys(unsubsRef.current).filter((k) => k !== LINKS_KEY));
            return prev.filter((u) => valid.has(u.mainUserUid));
          });
        });
      }

      wireLinksListener(linksByEmergencyContactUid as FsQuery<DocumentData>, LINKS_KEY);
    });

    return () => {
      // cleanup on unmount
      unsubAuth();
      Object.values(unsubsRef.current).forEach((fn) => fn());
      unsubsRef.current = {};
    };
  }, [router]);

  // ensure this contact device is registered to receive pushes
  useEffect(() => {
    if (!emergencyContactUid) return;
    registerDevice(emergencyContactUid, "emergency"); // keep your signature
  }, [emergencyContactUid]);

  const handleAcknowledge = (userName: string) => {
    toast({
      title: "Alert Acknowledged",
      description: `You are now handling the alert for ${userName}.`,
    });
  };

  // Open Google Maps if we have a location; otherwise show centered popup.
  const handleViewOnMap = (user: MainUserCard) => {
    const loc = (user.location || "").trim();
    if (!loc) {
      setNoLocationUser(user);
      return;
    }
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc)}`;
    window.open(mapsUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="flex flex-col min-h-screen bg-secondary">
      <Header />
      <main className="flex-grow container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl md:text-4xl font-headline font-bold">
            Emergency Contact Dashboard
          </h1>
          {emergencyContactUid && (
            <Button variant="outline" onClick={() => router.push("/emergency-settings")}>
              <SettingsIcon className="h-5 w-5 mr-2" />
              Settings
            </Button>
          )}
        </div>

        {loading && <p>Loading your people…</p>}
        {!loading && mainUsers.length === 0 && (
          <p className="opacity-70">No linked users yet. Ask them to send you an invite.</p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {mainUsers.map((p) => {
            const map = getMapImage(p.location);
            return (
              <Card
                key={p.mainUserUid}
                className={`shadow-lg hover:shadow-xl transition-shadow ${
                  p.status === "SOS" ? "border-destructive bg-destructive/10" : ""
                }`}
              >
                <CardHeader className="flex flex-row items-center gap-4">
                  <Avatar className="h-16 w-16">
                    <AvatarImage src={p.avatar || ""} alt={p.name} />
                    <AvatarFallback className={`${p.colorClass} text-foreground`}>
                      {p.initials}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <CardTitle className="text-2xl font-headline">{p.name}</CardTitle>
                    <CardDescription>
                      {p.lastCheckIn ? `Last check-in: ${p.lastCheckIn}` : "—"}
                    </CardDescription>
                  </div>
                </CardHeader>

                <CardContent className="space-y-4">
                  <div className="flex justify-between items-center">
                    <p className="font-semibold">Status:</p>
                    <Badge variant={getStatusVariant(p.status)} className="text-md px-3 py-1">
                      {p.status || "—"}
                    </Badge>
                  </div>

                  <div className="relative h-40 w-full rounded-lg overflow-hidden border">
                    <Image
                      src={map.src}
                      alt={map.alt}
                      fill
                      sizes="(max-width: 768px) 100vw, 33vw"
                      style={{ objectFit: "cover" }}
                    />
                    <div className="absolute inset-0 bg-black/20 flex items-center justify-center">
                      <Button
                        variant="secondary"
                        onClick={() => handleViewOnMap(p)}
                        aria-label={`View ${p.name} on map`}
                      >
                        <MapPin className="mr-2 h-4 w-4" />
                        View on Map
                      </Button>
                    </div>
                  </div>
                </CardContent>

                <CardFooter className="grid grid-cols-2 gap-2">
                  <Button variant="outline">
                    <Phone className="mr-2 h-4 w-4" />
                    Call
                  </Button>
                  <Button variant="outline">
                    <MessageSquare className="mr-2 h-4 w-4" />
                    Message
                  </Button>
                  {p.status === "SOS" && (
                    <Button className="col-span-2" onClick={() => handleAcknowledge(p.name)}>
                      Acknowledge Alert
                    </Button>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </main>
      <Footer />

      {/* Centered popup when location is missing */}
      <Dialog open={!!noLocationUser} onOpenChange={(open) => !open && setNoLocationUser(null)}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Location unavailable</DialogTitle>
            <DialogDescription>
              {noLocationUser
                ? `${noLocationUser.name} disabled location sharing or hasn’t shared a location yet.`
                : ""}
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </div>
  );
}
