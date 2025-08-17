import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function AboutPage() {
  return (
    <div className="flex flex-col min-h-screen bg-background">
      <Header />
      <main className="flex-grow container mx-auto px-4 py-12 md:py-16">
        <Card className="max-w-4xl mx-auto">
          <CardHeader>
            <CardTitle className="text-3xl font-headline">About LifeSignal AI</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-lg text-muted-foreground">
            <p>
              LifeSignal AI was born from a simple yet powerful idea: everyone deserves to feel safe and connected, no matter their age or living situation. We live in a world where distances can separate families, and individuals, especially the elderly and children, can feel vulnerable. Our mission is to bridge that gap with technology that is both intelligent and incredibly easy to use.
            </p>
            <p>
              Our application is designed as a digital safety net. It's for the daughter who worries about her elderly father living alone, for the parents waiting for their child to get home from school, and for anyone who values an extra layer of security in their daily life.
            </p>
            <p>
              We've focused on creating a user-friendly experience with large, clear buttons and a simple interface, making it accessible to all. The core of LifeSignal AI is its proactive check-in system. Users can easily confirm they're safe with a tap or a voice message. If a check-in is missed, our system automatically and calmly escalates alerts to designated emergency contacts.
            </p>
             <p>
              The addition of AI-powered voice analysis is what sets us apart. We go beyond simple check-ins by analyzing the user's tone and speech patterns for subtle signs of distress, ensuring that help is on the way even when a person can't explicitly ask for it.
            </p>
            <p>
              We are committed to privacy and security. Your data is yours, and we ensure it is protected and only shared with the contacts you designate. Thank you for trusting LifeSignal AI to be a part of your family's safety plan.
            </p>
          </CardContent>
        </Card>
      </main>
      <Footer />
    </div>
  );
}
