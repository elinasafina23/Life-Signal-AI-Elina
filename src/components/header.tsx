"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { auth } from "@/firebase";

export function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const isAuthPage = pathname === "/login" || pathname === "/signup";
  const isAppPage = pathname.startsWith('/dashboard') || pathname.startsWith('/emergency-dashboard');

  const handleLogout = async () => {
    try {
      await signOut(auth);
      await fetch("/api/auth/session", {
        method: "DELETE",
        credentials: "include",
      });
    } catch (error) {
      console.error("Failed to log out", error);
    } finally {
      router.push("/login");
    }
  };

  return (
    <header className="py-4 px-4 md:px-6 bg-background/80 backdrop-blur-sm sticky top-0 z-50 border-b">
      <div className="container mx-auto flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <ShieldCheck className="h-8 w-8 text-primary" />
          <span className="text-xl font-bold text-foreground">LifeSignal AI</span>
        </Link>
        <nav className="flex items-center gap-2">
          {!isAppPage && (
            <Button asChild variant={isAuthPage ? "default" : "ghost"}>
              <Link href="/login">Login / Sign Up</Link>
            </Button>
          )}
          {isAppPage && (
           
            <Button variant="ghost" onClick={handleLogout}>
              Logout
            </Button>
          )}
        </nav>
      </div>
    </header>
  );
}