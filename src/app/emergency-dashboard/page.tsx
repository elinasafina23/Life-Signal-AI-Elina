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

// Push registration + roles
import { registerDevice } from "@/lib/useFcmToken";
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
  firstName?: string;
  lastName?: string;
  avatar?: string;
  lastCheckinAt?: Timestamp;
  checkinInterval?: number | string; // minutes
  sosTriggeredAt?: Timestamp;
  location?: string;
  role?: string;
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

  const unsubsRef = useRef<Record<string, () => void>>({});

  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      Object.values(unsubsRef.current).forEach((fn) => fn());
      unsubsRef.current = {};
      setMainUsers([]);
      setUid(null);

      if (!user) {
        setLoading(false);
        router.replace(
          `/login?role=emergency_contact&next=${encodeURIComponent("/emergency-dashboard")}`
        );
        return;
      }

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

      setUid(user.uid);
      setLoading(false);

      const linksQuery = query(
        collectionGroup(db, "emergency_contact"),
        where("uid", "==", user.uid)
      );

      unsubsRef.current.links = onSnapshot(linksQuery, (linksSnap) => {
        const nextMainUserIds = new Set<string>();

        linksSnap.forEach((linkDoc) => {
          const mainUserUid = linkDoc.ref.parent.parent?.id;
          if (mainUserUid) {
            nextMainUserIds.add(mainUserUid);
          }
        });

        Object.keys(unsubsRef.current).forEach((k) => {
          if (k !== "links" && !nextMainUserIds.has(k)) {
            unsubsRef.current[k]();
            delete unsubsRef.current[k];
          }
        });

        nextMainUserIds.forEach((mainUserId) => {
          if (unsubsRef.current[mainUserId]) return;

          const userDocRef = doc(db, "users", mainUserId);
          unsubsRef.current[mainUserId] = onSnapshot(
            userDocRef,
            (userDocSnap) => {
              const userData = userDocSnap.data() as MainUserDoc;
              let updatedCard: MainUserCard;

              if (userDocSnap.exists() && userData) {
                const name = `${userData.firstName || ""} ${userData.lastName || ""}`.trim() || "Main User";
                
                const last = userData.lastCheckinAt instanceof Timestamp ? userData.lastCheckinAt.toDate() : undefined;
                const rawInt = userData.checkinInterval;
                const intervalMin = typeof rawInt === "number" ? rawInt : (rawInt ? parseInt(String(rawInt), 10) : 12 * 60);

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
                  mainUserUid: mainUserId,
                  name,
                  avatar: userData.avatar || "https://placehold.co/100x100.png",
                  initials: initialsOf(name),
                  status,
                  lastCheckIn: formatWhen(last),
                  location: userData.location || "",
                };
              } else {
                updatedCard = {
                  mainUserUid: mainUserId,
                  name: "User Not Found",
                  initials: "UA",
                  avatar: "https://placehold.co/100x100.png",
                };
              }

              setMainUsers((prev) => {
                const map = new Map(prev.map((u) => [u.mainUserUid, u]));
                map.set(mainUserId, updatedCard);
                return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
              });
            },
            (error) => {
              console.error(`[Emergency Dashboard] User doc listen failed for ${mainUserId}:`, error);
              setMainUsers((prev) => {
                const map = new Map(prev.map((u) => [u.mainUserUid, u]));
                map.set(mainUserId, {
                  mainUserUid: mainUserId,
                  name: "User Load Error",
                  initials: "UA",
                  status: "Inactive",
                });
                return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
              });
            }
          );
        });
      });
    });

    return () => {
      unsubAuth();
      Object.values(unsubsRef.current).forEach((fn) => fn());
      unsubsRef.current = {};
    };
  }, [router]);

  useEffect(() => {
    if (!uid) return;
    registerDevice(uid, "emergency");
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