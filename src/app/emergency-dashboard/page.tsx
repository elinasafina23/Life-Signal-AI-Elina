"use client";

import Image from "next/image";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { MapPin, Phone, MessageSquare } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const users = [
  {
    name: "Eleanor Vance",
    avatar: "https://placehold.co/100x100.png",
    initials: "EV",
    status: "OK",
    lastCheckIn: "Today, 4:30 PM",
    location: "123 Maple St, Springfield",
  },
  {
    name: "Arthur Pendelton",
    avatar: "https://placehold.co/100x100.png",
    initials: "AP",
    status: "Inactive",
    lastCheckIn: "Yesterday, 8:00 PM",
    location: "456 Oak Ave, Shelbyville",
  },
  {
    name: "Beatrice Miller",
    avatar: "https://placehold.co/100x100.png",
    initials: "BM",
    status: "SOS",
    lastCheckIn: "Today, 6:15 PM",
    location: "789 Pine Ln, Capital City",
  },
];

const getStatusVariant = (status: string) => {
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
};

export default function EmergencyDashboardPage() {
    const { toast } = useToast();

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
        <h1 className="text-3xl md:text-4xl font-headline font-bold mb-6">Caregiver Dashboard</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {users.map((user) => (
            <Card key={user.name} className={`shadow-lg hover:shadow-xl transition-shadow ${user.status === 'SOS' ? 'border-destructive bg-destructive/10' : ''}`}>
              <CardHeader className="flex flex-row items-center gap-4">
                <Avatar className="h-16 w-16">
                  <AvatarImage src={user.avatar} alt={user.name} data-ai-hint="portrait person" />
                  <AvatarFallback>{user.initials}</AvatarFallback>
                </Avatar>
                <div>
                  <CardTitle className="text-2xl font-headline">{user.name}</CardTitle>
                  <CardDescription>Last check-in: {user.lastCheckIn}</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                 <div className="flex justify-between items-center">
                    <p className="font-semibold">Status:</p>
                    <Badge variant={getStatusVariant(user.status)} className="text-md px-3 py-1">{user.status}</Badge>
                </div>
                <div className="relative h-40 w-full rounded-lg overflow-hidden border">
                    <Image src="https://placehold.co/400x200.png" layout="fill" objectFit="cover" alt="Map view of user's location" data-ai-hint="map location"/>
                    <div className="absolute inset-0 bg-black/20 flex items-center justify-center">
                        <Button variant="secondary"><MapPin className="mr-2 h-4 w-4"/>View on Map</Button>
                    </div>
                </div>
              </CardContent>
              <CardFooter className="grid grid-cols-2 gap-2">
                <Button variant="outline"><Phone className="mr-2 h-4 w-4"/>Call</Button>
                <Button variant="outline"><MessageSquare className="mr-2 h-4 w-4"/>Message</Button>
                {user.status === 'SOS' && (
                    <Button className="col-span-2" onClick={() => handleAcknowledge(user.name)}>
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
