"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function Header() {
  const pathname = usePathname();
  const isAuthPage = pathname === "/login" || pathname === "/signup";
  const isAppPage = pathname.startsWith('/dashboard') || pathname.startsWith('/emergency-dashboard');

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
             <Button asChild variant="ghost">
              <Link href="/">Logout</Link>
            </Button>
          )}
        </nav>
      </div>
    </header>
  );
}
