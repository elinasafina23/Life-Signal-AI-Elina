"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Loader2, CheckCircle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";

/**
 * This component handles the invitation acceptance flow.
 * It reads the token from the URL, calls the backend API to accept the invite,
 * and handles success/error states.
 */
export default function AcceptInvitePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const token = searchParams.get("token");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setErrorMessage("Invitation token is missing or invalid.");
      return;
    }

    const acceptInvite = async () => {
      try {
        const response = await fetch("/api/emergency-contact/accept", {
          method: "POST",
          credentials: "include", // ✅ IMPORTANT: sends session cookie after signup/login
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });

        const data = await response.json();

        // If the API says we must authenticate first, go to signup.
        // Pass all the necessary context: role, invite, token, AND the main user's UID.
        if (data?.requiresAuth) {
          const nextUrl = `/emergency-contact/accept?token=${encodeURIComponent(token)}`;
          const mainUserUid = data.mainUser?.uid;

          if (!mainUserUid) {
            throw new Error("API response did not include the main user ID.");
          }

          const signupParams = new URLSearchParams({
            role: "emergency-contact",
            inviteId: data.inviteId,
            token: token,
            mainUserUid: mainUserUid,
            next: nextUrl,
          });

          router.replace(`/signup?${signupParams.toString()}`);
          return; // ⛔ stop here; we’ll finish acceptance after signup
        }

        if (!response.ok) {
          throw new Error(data.error || "Failed to accept invitation.");
        }

        setStatus("success");
        toast({
          title: "Invitation Accepted!",
          description: "You are now linked as an emergency contact.",
          variant: "default",
        });

        // Redirect to the emergency dashboard after a short delay
        setTimeout(() => {
          router.push("/emergency-dashboard");
        }, 3000);
      } catch (error: any) {
        setStatus("error");
        setErrorMessage(error.message || "An unexpected error occurred during acceptance.");
        toast({
          title: "Acceptance Failed",
          description: error.message || "Please check the link or contact the main user.",
          variant: "destructive",
        });
      }
    };

    acceptInvite();
  }, [token, router, toast]);

  const renderContent = () => {
    switch (status) {
      case "loading":
        return (
          <Alert className="max-w-md mx-auto">
            <Loader2 className="h-4 w-4 animate-spin" />
            <AlertTitle>Processing Invitation</AlertTitle>
            <AlertDescription>
              Validating your emergency contact token. Please wait...
            </AlertDescription>
          </Alert>
        );
      case "success":
        return (
          <Alert variant="default" className="max-w-md mx-auto bg-green-500 text-white">
            <CheckCircle className="h-4 w-4" />
            <AlertTitle>Success!</AlertTitle>
            <AlertDescription>
              Invitation accepted. Redirecting you to the dashboard shortly.
              <div className="mt-4">
                <Link href="/emergency-dashboard" passHref>
                  <Button variant="secondary" className="w-full">Go to Dashboard Now</Button>
                </Link>
              </div>
            </AlertDescription>
          </Alert>
        );
      case "error":
        return (
          <Alert variant="destructive" className="max-w-md mx-auto">
            <XCircle className="h-4 w-4" />
            <AlertTitle>Acceptance Failed</AlertTitle>
            <AlertDescription>
              {errorMessage || "An unknown error occurred."}
              <div className="mt-4">
                <Link href="/login" passHref>
                  <Button variant="secondary" className="w-full">Go to Login</Button>
                </Link>
              </div>
            </AlertDescription>
          </Alert>
        );
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full">
        <h1 className="text-center text-3xl font-bold mb-8">Emergency Contact Invitation</h1>
        {renderContent()}
      </div>
    </div>
  );
}
