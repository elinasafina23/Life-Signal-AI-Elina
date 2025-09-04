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
  Timestamp,
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
import { MapPin, Phone, MessageSquare } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ✅ import device registration (with role tagging)
import { registerDevice } from "@/lib/useFcmToken";
// (Optional) if you store role on emergency-contact users, you can gate/redirect:
import { normalizeRole } from "@/lib/roles";

type Status = "OK" | "Inactive" | "SOS";

type MainUserCard = {
  mainUserUid: string;
  name: string;
  avatar?: string;
  initials: string;
  status?: Status;
  lastCheckIn?: string;
  location?: string;
};

type MainUserDoc = {
  lastCheckinAt?: Timestamp;
  checkinInterval?: number | string; // minutes
  sosTriggeredAt?: Timestamp;
  location?: string;
  role?: string; // optional if you mirror role here
};

function initialsOf(name = "") {
  return (
    name
      .split(" ")
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "UA"
  );
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

export default function EmergencyDashboardPage() {
  const router = useRouter();
  const { toast } = useToast();

  const [mainUsers, setMainUsers] = useState<MainUserCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [uid, setUid] = useState<string | null>(null);

  // keep latest Firestore unsubscribes (links + per-user by id)
  const unsubsRef = useRef<Record<string, () => void>>({});

  // cache the latest link info so user-doc listeners always merge with fresh base data
  const linkInfoRef = useRef<
    Record<string, { name: string; avatar?: string; location?: string }>
  >({});

  // gate: only clear loading after the first links snapshot arrives
  const firstLinksSnapSeenRef = useRef(false);

  useEffect(() => {
    // Main auth subscription
    const unsubAuth = onAuthStateChanged(auth, (user) => {
      // clean up all old listeners
      Object.values(unsubsRef.current).forEach((unsub) => unsub());
      unsubsRef.current = {};
      linkInfoRef.current = {};
      firstLinksSnapSeenRef.current = false;
      setMainUsers([]);
      setLoading(true);
      setUid(null);

      if (!user) {
        router.replace(
          `/login?role=emergency_contact&next=${encodeURIComponent("/emergency-dashboard")}`
        );
        return;
      }

      setUid(user.uid); // will trigger device registration effect below

      // --- Main subscription ---
      // Listen for all links where this user is the emergency contact.
      // NOTE: ensure your subcollection id matches exactly (e.g., "emergency_contacts" vs "emergency_contact")
      const linksQuery = query(
        collectionGroup(db, "emergency_contact"),
        where("uid", "==", user.uid)
      );

      unsubsRef.current.links = onSnapshot(
        linksQuery,
        (linksSnap) => {
          firstLinksSnapSeenRef.current = true;

          const nextMainUserIds = new Set<string>();
          const nextLinkInfo: Record<string, { name: string; avatar?: string; location?: string }> =
            {};

          linksSnap.forEach((linkDoc) => {
            const data = linkDoc.data() as any;

            // Prefer explicit mainUserId; fallback to parent user id if structured that way.
            const parentId = linkDoc.ref.parent.parent?.id || "";
            const mainUserUid: string = data.mainUserId || parentId;
            if (!mainUserUid) return;

            const name: string = data.mainUserName || "Main User";
            const avatar: string | undefined = data.mainUserAvatar;
            const location: string | undefined = data.location;

            nextMainUserIds.add(mainUserUid);
            nextLinkInfo[mainUserUid] = { name, avatar, location };
          });

          // Rebuild link cache to include only current ids (removes stale)
          const rebuilt: Record<string, { name: string; avatar?: string; location?: string }> = {};
          nextMainUserIds.forEach((id) => {
            rebuilt[id] = nextLinkInfo[id] || linkInfoRef.current[id] || { name: "Main User" };
          });
          linkInfoRef.current = rebuilt;

          // Unsubscribe from main users who are no longer linked
          Object.keys(unsubsRef.current).forEach((subId) => {
            if (subId !== "links" && !nextMainUserIds.has(subId)) {
              unsubsRef.current[subId]();
              delete unsubsRef.current[subId];
            }
          });

          // Seed/update UI from link info immediately
          setMainUsers((prev) => {
            const map = new Map(prev.map((u) => [u.mainUserUid, u]));
            nextMainUserIds.forEach((id) => {
              const link = linkInfoRef.current[id];
              const existing = map.get(id);
              const name = link?.name || existing?.name || "Main User";
              map.set(id, {
                mainUserUid: id,
                name,
                avatar: link?.avatar || existing?.avatar || "https://placehold.co/100x100.png",
                initials: initialsOf(name),
                status: existing?.status,
                lastCheckIn: existing?.lastCheckIn,
                location: link?.location ?? existing?.location ?? "",
              });
            });
            // remove cards for users no longer linked
            Array.from(map.keys()).forEach((id) => {
              if (!nextMainUserIds.has(id)) map.delete(id);
            });
            return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
          });

          if (nextMainUserIds.size === 0) {
            setLoading(false);
            return;
          }

          // Subscribe to each linked main user's doc for live status
          nextMainUserIds.forEach((mainUserId) => {
            if (unsubsRef.current[mainUserId]) return;

            const userDocRef = doc(db, "users", mainUserId);
            unsubsRef.current[mainUserId] = onSnapshot(
              userDocRef,
              (userDocSnap) => {
                const link = linkInfoRef.current[mainUserId] || { name: "Main User" };
                const baseName = link.name;
                const baseCard: MainUserCard = {
                  mainUserUid: mainUserId,
                  name: baseName,
                  avatar: link.avatar || "https://placehold.co/100x100.png",
                  initials: initialsOf(baseName),
                  location: link.location || "",
                };

                let updatedCard = { ...baseCard };

                if (userDocSnap.exists()) {
                  const userData = userDocSnap.data() as MainUserDoc;
                  const last =
                    userData.lastCheckinAt instanceof Timestamp
                      ? userData.lastCheckinAt.toDate()
                      : undefined;

                  const rawInt = userData.checkinInterval;
                  const intervalMin =
                    typeof rawInt === "number"
                      ? rawInt
                      : rawInt
                      ? parseInt(String(rawInt), 10)
                      : 12 * 60;

                  let status: Status = "OK";
                  if (userData.sosTriggeredAt instanceof Timestamp) {
                    status = "SOS";
                  } else if (last) {
                    const nextDue = last.getTime() + intervalMin * 60 * 1000;
                    if (Date.now() > nextDue) status = "Inactive";
                  } else {
                    status = "Inactive";
                  }

                  updatedCard = {
                    ...baseCard,
                    status,
                    lastCheckIn: formatWhen(last),
                    location: userData.location || baseCard.location,
                  };

                  // (Optional) If the main user doc carries a role and it's "primary", we keep as-is.
                  // If somehow this emergency user has "primary" role, you could redirect them:
                  // const role = normalizeRole(userData.role);
                  // if (role === "primary") router.replace("/dashboard");
                }

                setMainUsers((prev) => {
                  const map = new Map(prev.map((u) => [u.mainUserUid, u]));
                  const existing = map.get(mainUserId);
                  map.set(mainUserId, { ...existing, ...updatedCard });
                  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
                });

                setLoading(false);
              },
              (error) => {
                console.error("[Emergency Dashboard] User doc listen failed:", error);
                setLoading(false);
              }
            );
          });

          setLoading(false);
        },
        (error) => {
          console.error("[Emergency Dashboard] Main links query failed:", error);
          setLoading(false);
        }
      );
    });

    return () => {
      unsubAuth();
      Object.values(unsubsRef.current).forEach((unsub) => unsub());
      unsubsRef.current = {};
      linkInfoRef.current = {};
      firstLinksSnapSeenRef.current = false;
    };
  }, [router]);

  // ✅ Register THIS device for push on the emergency dashboard
  useEffect(() => {
    if (!uid) return;
    registerDevice(uid, "emergency"); // users/{uid}/devices/{deviceId} with role = "emergency"
  }, [uid]);

  const handleAcknowledge = (userName: string) => {
    toast({
      title: "Alert Acknowledged",
      description: `You are now handling the alert for ${userName}.`,
    });
  };

  return (
    <div className="flex flex-col min-h-screen bg-secondary">
      <Header />
      <main className="flex-grow container mx-auto px-4 py-8">
        <h1 className="text-3xl md:text-4xl font-headline font-bold mb-6">
          Emergency Contact Dashboard
        </h1>

        {loading && <p>Loading your people…</p>}
        {!loading && mainUsers.length === 0 && (
          <p className="opacity-70">No linked users yet. Ask them to send you an invite.</p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {mainUsers.map((p) => (
            <Card
              key={p.mainUserUid}
              className={`shadow-lg hover:shadow-xl transition-shadow ${
                p.status === "SOS" ? "border-destructive bg-destructive/10" : ""
              }`}
            >
              <CardHeader className="flex flex-row items-center gap-4">
                <Avatar className="h-16 w-16">
                  <AvatarImage src={p.avatar || ""} alt={p.name} />
                  <AvatarFallback>{p.initials}</AvatarFallback>
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
                    src="https://placehold.co/400x200.png"
                    alt="Map view"
                    fill
                    style={{ objectFit: "cover" }}
                  />
                  <div className="absolute inset-0 bg-black/20 flex items-center justify-center">
                    <Button variant="secondary">
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
          ))}
        </div>
      </main>
      <Footer />
    </div>
  );
}
