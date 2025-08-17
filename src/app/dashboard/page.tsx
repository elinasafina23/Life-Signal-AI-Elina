
"use client";

import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Siren, CheckCircle2, Timer, Clock } from "lucide-react";
import { VoiceCheckIn } from "@/components/voice-check-in";
import { useToast } from "@/hooks/use-toast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmergencyContacts } from "@/components/emergency-contacts";


export default function DashboardPage() {
    const { toast } = useToast();

    const handleCheckIn = () => {
        toast({
            title: "Checked In!",
            description: "Your status has been updated to 'OK'.",
        });
    };

    const handleSOS = () => {
        toast({
            title: "SOS Alert Sent!",
            description: "Your emergency contacts have been notified.",
            variant: "destructive",
        });
    }

    const handleIntervalChange = (value: string) => {
        toast({
            title: "Check-in Interval Updated",
            description: `Your check-in interval has been set to every ${value} hours.`,
        });
    }

  return (
    <div className="flex flex-col min-h-screen bg-secondary">
      <Header />
      <main className="flex-grow container mx-auto px-4 py-8">
        <h1 className="text-3xl md:text-4xl font-headline font-bold mb-6">Your Dashboard</h1>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card className="text-center bg-destructive/10 border-destructive shadow-lg hover:shadow-xl transition-shadow">
                <CardHeader>
                    <CardTitle className="text-3xl font-headline text-destructive">Emergency SOS</CardTitle>
                    <CardDescription className="text-destructive/80">
                        Tap only in a real emergency.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Button onClick={handleSOS} variant="destructive" size="lg" className="h-32 w-32 rounded-full text-2xl shadow-lg hover:scale-105 transition-transform">
                        <Siren className="h-16 w-16" />
                    </Button>
                </CardContent>
            </Card>

            <Card className="text-center shadow-lg hover:shadow-xl transition-shadow">
                 <CardHeader>
                    <CardTitle className="text-3xl font-headline">Manual Check-in</CardTitle>
                    <CardDescription>
                        Let your contacts know you're safe.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Button onClick={handleCheckIn} size="lg" className="h-32 w-32 rounded-full text-2xl shadow-lg bg-green-500 hover:bg-green-600">
                        <CheckCircle2 className="h-16 w-16" />
                    </Button>
                </CardContent>
            </Card>
            
            <Card className="shadow-lg">
                <CardHeader className="flex flex-row items-center justify-between">
                    <div>
                        <CardTitle className="text-2xl font-headline">Set Interval</CardTitle>
                        <CardDescription>Choose your check-in frequency.</CardDescription>
                    </div>
                     <Clock className="h-8 w-8 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                   <Select onValueChange={handleIntervalChange} defaultValue="12">
                       <SelectTrigger className="w-full text-lg">
                           <SelectValue placeholder="Select interval" />
                       </SelectTrigger>
                       <SelectContent>
                           <SelectItem value="6">Every 6 hours</SelectItem>
                           <SelectItem value="10">Every 10 hours</SelectItem>
                           <SelectItem value="12">Every 12 hours</SelectItem>
                           <SelectItem value="18">Every 18 hours</SelectItem>
                           <SelectItem value="24">Every 24 hours</SelectItem>
                       </SelectContent>
                   </Select>
                </CardContent>
            </Card>

            <Card className="shadow-lg">
                <CardHeader className="flex flex-row items-center justify-between">
                    <div>
                        <CardTitle className="text-2xl font-headline">Status</CardTitle>
                        <CardDescription>Your latest activity.</CardDescription>
                    </div>
                     <Timer className="h-8 w-8 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                    <p className="text-lg">Last Check-in: <span className="font-bold text-primary">Today at 9:15 AM</span></p>
                    <p className="text-lg">Next scheduled check-in: <span className="font-bold text-primary">Today at 9:15 PM</span></p>
                    <p className="text-lg">Location Sharing: <span className="font-bold text-green-500">Enabled</span></p>
                </CardContent>
            </Card>

            <div className="md:col-span-2">
                <EmergencyContacts />
            </div>
          </div>

          <div className="lg:col-span-1">
            <VoiceCheckIn />
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
