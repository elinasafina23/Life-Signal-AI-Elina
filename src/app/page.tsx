import Link from "next/link";
import Image from "next/image";
import { ShieldCheck, HeartPulse, UserCheck, BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";

export default function Home() {
  return (
    <div className="flex flex-col min-h-screen bg-background">
      <Header />
      <main className="flex-grow">
        <section className="container mx-auto px-4 py-12 md:py-24 text-center">
          <ShieldCheck className="mx-auto h-16 w-16 text-primary mb-4" />
          <h1 className="text-4xl md:text-6xl font-headline font-bold mb-4">
            Your Personal Safety Net
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground max-w-3xl mx-auto mb-8">
            LifeSignal AI provides peace of mind for you and your loved ones. Smart, simple,
            and reliable safety for everyone.
          </p>
          <div className="flex flex-col md:flex-row justify-center gap-6 mb-10">
  
  {/* SIgnup Buttons */}
  <Button
    asChild
    size="lg"
    className="text-lg py-8 px-14 min-w-[260px]" 
  >
    <Link href="/signup">User Sign Up</Link>
  </Button>

  {/* Smaller secondary button */}
  <Button
    asChild
    size="lg"
    className="text-lg py-8 px-14 min-w-[260px]" 
    variant="secondary"
  >
   <Link href="/signup/emergency-contact">Emergency Contact Sign Up</Link>
  </Button>
</div>
          
        </section>

        <section className="bg-secondary py-16 md:py-24">
          <div className="container mx-auto px-4">
            <h2 className="text-3xl md:text-4xl font-headline font-bold text-center mb-12">
              How It Works
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
              <Card className="text-center">
                <CardHeader>
                  <UserCheck className="mx-auto h-12 w-12 text-accent mb-4" />
                  <CardTitle>Easy Check-ins</CardTitle>
                  <CardDescription>
                    Confirm you're okay with a single tap or a simple voice message. Quick,
                    easy, and reassuring.
                  </CardDescription>
                </CardHeader>
              </Card>
              <Card className="text-center">
                <CardHeader>
                  <HeartPulse className="mx-auto h-12 w-12 text-accent mb-4" />
                  <CardTitle>Smart Alerts</CardTitle>
                  <CardDescription>
                    If you miss a check-in, we'll notify your emergency contacts, providing
                    them with your last known status.
                  </CardDescription>
                </CardHeader>
              </Card>
              <Card className="text-center">
                <CardHeader>
                  <BellRing className="mx-auto h-12 w-12 text-accent mb-4" />
                  <CardTitle>Instant SOS</CardTitle>
                  <CardDescription>
                    In an emergency, press the SOS button to immediately alert your contacts
                    with your location.
                  </CardDescription>
                </CardHeader>
              </Card>
              <Card className="text-center">
                <CardHeader>
                  <ShieldCheck className="mx-auto h-12 w-12 text-accent mb-4" />
                  <CardTitle>AI Voice Analysis</CardTitle>
                  <CardDescription>
                    Our advanced AI analyzes voice check-ins to detect subtle signs of
                    distress, adding an extra layer of security.
                  </CardDescription>
                </CardHeader>
              </Card>
            </div>
          </div>
        </section>

        <section className="container mx-auto px-4 py-16 md:py-24">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl md:text-4xl font-headline font-bold mb-4">
                Peace of Mind for Everyone
              </h2>
              <p className="text-muted-foreground mb-6">
                Whether for elderly parents living alone, children on their way home from
                school, or anyone needing an extra layer of safety, LifeSignal AI is designed
                to be accessible and easy to use for all age groups.
              </p>
              <Button asChild size="lg" variant="outline">
                <Link href="/about">Learn More</Link>
              </Button>
            </div>
            <div className="rounded-lg overflow-hidden shadow-lg">
              <Image
                src="https://placehold.co/600x400.png"
                alt="Family using the app"
                width={600}
                height={400}
                className="w-full h-auto"
                data-ai-hint="family smiling"
              />
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
