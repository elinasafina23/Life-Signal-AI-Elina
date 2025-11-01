import { Header } from "@/components/header";
import { Footer } from "@/components/footer";

export default function TermsOfServicePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="container mx-auto flex-grow px-4 py-12">
        <h1 className="text-4xl font-bold mb-6">Terms of Service</h1>
        <p className="text-sm text-gray-500 mb-8">Last Updated: October 27, 2025</p>

        <section className="space-y-6">
          <h2 className="text-2xl font-semibold border-b pb-2">1. Acceptance of Terms</h2>
          <p>
            By accessing or using the Life Signal AI application (the "Service"), you agree to be bound by these Terms of Service ("Terms"). If you disagree with any part of the terms, you may not access the Service.
          </p>

          <h2 className="text-2xl font-semibold border-b pb-2">2. Description of Service</h2>
          <p>
            Life Signal AI is a well-being monitoring application designed to track user activity, check-in status, and, with explicit consent, location data, to alert designated emergency contacts in case of a potential emergency (SOS) or prolonged inactivity.
          </p>

          <h2 className="text-2xl font-semibold border-b pb-2">3. User Responsibilities</h2>
          <ul className="list-disc list-inside space-y-2 ml-4">
            <li>You are responsible for maintaining the confidentiality of your account and password.</li>
            <li>You must ensure that the emergency contact information you provide is accurate and up-to-date.</li>
            <li>You acknowledge that the Service is a monitoring tool and not a substitute for emergency services (e.g., 911 or local emergency numbers).</li>
          </ul>

          <h2 className="text-2xl font-semibold border-b pb-2">4. Data and Privacy</h2>
          <p>
            Your use of the Service is also governed by our Privacy Policy, which is incorporated into these Terms by reference. By using the Service, you consent to the collection and use of your information as described in the Privacy Policy.
          </p>

          <h2 className="text-2xl font-semibold border-b pb-2">5. Consent for Data Sharing</h2>
          <p>
            You understand and agree that by enabling certain features (e.g., location sharing), you are providing explicit consent for your data to be shared with your emergency contacts as described in the application's settings and Privacy Policy. You can revoke this consent at any time through the application settings.
          </p>
        </section>
      </main>
      <Footer />
    </div>
  );
}
