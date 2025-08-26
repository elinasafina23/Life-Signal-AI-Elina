// app/emergency-dashboard/page.tsx
"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "@/firebase";

// Firestore: collectionGroup + field filter (NO documentId())
import { collectionGroup, onSnapshot, query, where } from "firebase/firestore";

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

type PatientCard = {
  patientUid: string;
  name: string;
  avatar?: string;
  initials: string;
  status?: "OK" | "Inactive" | "SOS";
  lastCheckIn?: string;
  location?: string;
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

export default function EmergencyDashboardPage() {
  const router = useRouter();
  const { toast } = useToast();

  const [patients, setPatients] = useState<PatientCard[]>([]);
  const [loading, setLoading] = useState(true);

  // Keep latest Firestore unsubscribe so we can clean up correctly
  const unsubRef = useRef<null | (() => void)>(null);

  useEffect(() => {
    // Listen for auth state
    const unsubAuth = onAuthStateChanged(auth, (user) => {
      // If we had a previous snapshot listener, stop it
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }

      if (!user) {
        router.replace("/login?role=caregiver");
        return;
      }

      // ✅ Correct query:
      // Find all /users/{mainUid}/caregivers/* where the subdoc field "uid" matches current caregiver
      // NOTE: Ensure your link doc includes: { uid: caregiverUid, userId: mainUid, patientName, ... }
      const q = query(collectionGroup(db, "caregivers"), where("uid", "==", user.uid));

      const unsub = onSnapshot(
        q,
        (snap) => {
          const rows: PatientCard[] = snap.docs.map((d) => {
            const data = d.data() as any;

            // Prefer an explicit userId field on the link; fallback to parent doc id
            const patientUid = data.userId || d.ref.parent.parent?.id || "unknown";
            const name = data.patientName || "Patient";

            return {
              patientUid,
              name,
              initials: initialsOf(name),
              avatar: data.patientAvatar || "https://placehold.co/100x100.png",
              status: data.status || "OK",
              lastCheckIn: data.lastCheckIn || "",
              location: data.location || "",
            };
          });

          setPatients(rows);
          setLoading(false);
        },
        (err) => {
          console.error("[Caregiver Dashboard] Firestore onSnapshot error:", err);
          setLoading(false);
        }
      );

      // Save unsubscribe so we can clean it up on user change / unmount
      unsubRef.current = unsub;
    });

    return () => {
      if (unsubRef.current) unsubRef.current();
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
          Caregiver Dashboard
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
