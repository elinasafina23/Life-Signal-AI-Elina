import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function PrivacyPage() {
  return (
    <div className="flex flex-col min-h-screen bg-background">
      <Header />
      <main className="flex-grow container mx-auto px-4 py-12 md:py-16">
        <Card className="max-w-4xl mx-auto">
          <CardHeader>
            <CardTitle className="text-3xl font-headline">Privacy Policy</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6 text-muted-foreground">
            <div>
              <h3 className="font-bold text-xl text-foreground mb-2">1. Information We Collect</h3>
              <p>We collect information you provide during sign-up, such as your name, email, and the details of your emergency contacts. For users, we also collect check-in data, voice recordings for analysis, and location data if you provide consent.</p>
            </div>
            <div>
              <h3 className="font-bold text-xl text-foreground mb-2">2. How We Use Your Information</h3>
              <p>Your information is used solely to provide and improve our services. This includes sending check-in reminders, alerting emergency contacts, and analyzing voice data to ensure your well-being. We do not sell your personal data to third parties.</p>
            </div>
            <div>
              <h3 className="font-bold text-xl text-foreground mb-2">3. Data Sharing</h3>
              <p>We only share your information with your designated emergency contacts in the event of an SOS or missed check-in. Location data is only shared if you have explicitly granted permission and only during an alert.</p>
            </div>
             <div>
              <h3 className="font-bold text-xl text-foreground mb-2">4. Data Security</h3>
              <p>We use industry-standard security measures, including encryption and secure cloud infrastructure, to protect your data. Access is strictly controlled to ensure that only authorized individuals can view your information.</p>
            </div>
             <div>
              <h3 className="font-bold text-xl text-foreground mb-2">5. Your Consent</h3>
              <p>By using LifeSignal AI, you consent to our Privacy Policy. You can revoke location sharing consent at any time through the app's settings. You have the right to request access to or deletion of your personal data.</p>
            </div>
             <div>
              <h3 className="font-bold text-xl text-foreground mb-2">6. Changes to This Policy</h3>
              <p>We may update our Privacy Policy from time to time. We will notify you of any changes by posting the new policy on this page. We advise you to review this page periodically for any changes.</p>
            </div>
          </CardContent>
        </Card>
      </main>
      <Footer />
    </div>
  );
}
