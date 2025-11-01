import { Header } from "@/components/header";
import { Footer } from "@/components/footer";

export default function PrivacyPolicyPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="container mx-auto flex-grow px-4 py-12">
        <h1 className="text-4xl font-bold mb-6">Privacy Policy</h1>
        <p className="text-sm text-gray-500 mb-8">Last Updated: October 27, 2025</p>

        <section className="space-y-6">
          <h2 className="text-2xl font-semibold border-b pb-2">1. Introduction</h2>
          <p>
            Welcome to Life Signal AI. We are committed to protecting your privacy and handling your data in an open and transparent manner. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our application.
          </p>

          <h2 className="text-2xl font-semibold border-b pb-2">2. Data We Collect</h2>
          <ul className="list-disc list-inside space-y-2 ml-4">
            <li><strong>Personal Identification Information:</strong> Name, email address, phone number, and Firebase User ID.</li>
            <li><strong>Health and Status Data:</strong> Check-in times, status (OK, Inactive, SOS), and voice message transcripts/analysis (mood, anomaly detection).</li>
            <li><strong>Location Data:</strong> GPS coordinates, collected only when an SOS is triggered or during an escalation event, and only with explicit user consent.</li>
            <li><strong>Emergency Contact Information:</strong> Names, emails, and phone numbers of your designated emergency contacts.</li>
          </ul>
          <p className="font-semibold text-red-600">
            Explicit consent is required for the collection and processing of sensitive data, such as location and voice analysis.
          </p>

          <h2 className="text-2xl font-semibold border-b pb-2">3. How We Use Your Data</h2>
          <p>
            Your data is used primarily to provide and improve the Life Signal AI service:
          </p>
          <ul className="list-disc list-inside space-y-2 ml-4">
            <li>To monitor your well-being and detect potential anomalies.</li>
            <li>To alert your emergency contacts in case of an SOS event or prolonged inactivity.</li>
            <li>To allow emergency contacts to view your status on the emergency dashboard.</li>
            <li>For internal analytics and service improvement.</li>
          </ul>

          <h2 className="text-2xl font-semibold border-b pb-2">4. Sharing Your Data</h2>
          <p>
            We only share your data as necessary to provide the service:
          </p>
          <ul className="list-disc list-inside space-y-2 ml-4">
            <li><strong>With Emergency Contacts:</strong> Your status, last check-in, and location (if consented and triggered) are shared with your designated emergency contacts via the emergency dashboard.</li>
            <li><strong>Service Providers:</strong> We use third-party services (e.g., Firebase, email providers) to operate the application. These providers are bound by confidentiality agreements.</li>
          </ul>

          <h2 className="text-2xl font-semibold border-b pb-2">5. Your Rights and Consent</h2>
          <p>
            You have the right to access, correct, or delete your personal data. You can manage your consent for data sharing (e.g., location) in the application settings at any time.
          </p>
        </section>
      </main>
      <Footer />
    </div>
  );
}
