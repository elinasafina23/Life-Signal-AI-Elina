// app/emergency-dashboard/page.tsx
"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
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

import { normalizeRole } from "@/lib/roles";

type Status = "OK" | "Inactive" | "SOS";

type PatientCard = {
  patientUid: string;
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
  lastLocationText?: string; // optional, if you store it
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

  const [patients, setPatients] = useState<PatientCard[]>([]);
  const [loading, setLoading] = useState(true);

  // keep latest Firestore unsubscribes
  const linksUnsubRef = useRef<null | (() => void)>(null);
  const perPatientUnsubsRef = useRef<Record<string, () => void>>({});

  useEffect(() => {
    // Auth gate + role gate
    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      // cleanup old listeners
      if (linksUnsubRef.current) {
        linksUnsubRef.current();
        linksUnsubRef.current = null;
      }
      // cleanup per-patient listeners
      Object.values(perPatientUnsubsRef.current).forEach((f) => f());
      perPatientUnsubsRef.current = {};

      if (!user) {
        router.replace(
          `/login?role=emergency_contact&next=${encodeURIComponent("/emergency-dashboard")}`
        );
        return;
      }

      // role check: only emergency_contact allowed here
      // (read user doc once via getDoc could work; we’ll piggyback on links query too)
      // If you want a strict role check, uncomment this block to fetch role first:
      // const uref = doc(db, "users", user.uid);
      // const usnap = await getDoc(uref);
      // const role = normalizeRole(usnap.data()?.role);
      // if (role !== "emergency_contact") { router.replace("/dashboard"); return; }

      // Query all links where this user is the emergency contact:
      // Path pattern: /users/{mainUid}/emergency_contact/{emergencyUid}
      const qLinks = query(
        collectionGroup(db, "emergency_contact"),
        where("uid", "==", user.uid)
      );

      linksUnsubRef.current = onSnapshot(
        qLinks,
        (snap) => {
          // Build base cards from link docs
          const next: Record<string, PatientCard> = {};
          const seenPatientIds: string[] = [];

          snap.docs.forEach((d) => {
            const data = d.data() as any;
            const patientUid = data.userId || d.ref.parent.parent?.id || "";
            if (!patientUid) return;

            const name = data.mainUserName || data.patientName || "Patient";
            const avatar = data.mainUserAvatar || "";
            next[patientUid] = {
              patientUid,
              name,
              avatar: avatar || "https://placehold.co/100x100.png",
              initials: initialsOf(name),
              status: "OK", // will be refined by per-patient doc
              lastCheckIn: "—",
              location: data.location || "",
            };
            seenPatientIds.push(patientUid);
          });

          // Unsubscribe removed patients
          Object.keys(perPatientUnsubsRef.current).forEach((id) => {
            if (!seenPatientIds.includes(id)) {
              perPatientUnsubsRef.current[id]();
              delete perPatientUnsubsRef.current[id];
            }
          });

          // Subscribe to each patient’s main user doc to derive status
          seenPatientIds.forEach((pid) => {
            if (perPatientUnsubsRef.current[pid]) return; // already listening
            const uref = doc(db, "users", pid);
            perPatientUnsubsRef.current[pid] = onSnapshot(
              uref,
              (usnap) => {
                const base = next[pid] || { patientUid: pid, name: "Patient", initials: "PT" };
                if (!usnap.exists()) {
                  // keep base card
                  setPatients((prev) => {
                    const map = new Map(prev.map((p) => [p.patientUid, p]));
                    map.set(pid, base);
                    return Array.from(map.values());
                  });
                  return;
                }

                const udata = usnap.data() as MainUserDoc;
                const last = udata.lastCheckinAt instanceof Timestamp ? udata.lastCheckinAt.toDate() : undefined;
                const rawInt = udata.checkinInterval;
                const intervalMin =
                  typeof rawInt === "number"
                    ? rawInt
                    : typeof rawInt === "string"
                    ? parseInt(rawInt, 10)
                    : 12 * 60; // default 12h

                // derive status
                let status: Status = "OK";
                if (udata.sosTriggeredAt instanceof Timestamp) {
                  status = "SOS";
                } else if (last) {
                  const nextDue = last.getTime() + intervalMin * 60 * 1000;
                  if (Date.now() > nextDue) status = "Inactive";
                } else {
                  // no check-ins yet → treat as Inactive to surface attention
                  status = "Inactive";
                }

                const location = udata.lastLocationText || base.location;

                const updated: PatientCard = {
                  ...base,
                  status,
                  lastCheckIn: formatWhen(last),
                  location,
                };

                setPatients((prev) => {
                  const map = new Map(prev.map((p) => [p.patientUid, p]));
                  map.set(pid, updated);
                  // also ensure we include any cards from the latest links snapshot (next)
                  Object.values(next).forEach((row) => {
                    if (!map.has(row.patientUid)) map.set(row.patientUid, row);
                  });
                  // stable order by name
                  return Array.from(map.values()).sort((a, b) =>
                    a.name.localeCompare(b.name)
                  );
                });
              },
              (err) => {
                console.error("[Emergency Dashboard] user doc listen error:", err);
              }
            );
          });

          // Seed UI quickly with link info while per-patient listeners attach
          setPatients((prev) => {
            const map = new Map(prev.map((p) => [p.patientUid, p]));
            Object.values(next).forEach((row) => {
              if (!map.has(row.patientUid)) map.set(row.patientUid, row);
            });
            return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
          });

          setLoading(false);
        },
        (err) => {
          console.error("[Emergency Dashboard] links onSnapshot error:", err);
          setLoading(false);
        }
      );
    });

    return () => {
      if (linksUnsubRef.current) {
        linksUnsubRef.current();
        linksUnsubRef.current = null;
      }
      Object.values(perPatientUnsubsRef.current).forEach((f) => f());
      perPatientUnsubsRef.current = {};
      unsubAuth();
    };
  }, [router]);

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
        {!loading && patients.length === 0 && (
          <p className="opacity-70">
            No linked users yet. Ask them to send you an invite.
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {patients.map((p) => (
            <Card
              key={p.patientUid}
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
