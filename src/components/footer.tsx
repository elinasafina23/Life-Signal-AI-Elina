import Link from "next/link";

export function Footer() {
  return (
    <footer className="py-6 px-4 md:px-6 bg-background border-t">
      <div className="container mx-auto flex flex-col md:flex-row items-center justify-between text-sm text-muted-foreground">
        <p>&copy; {new Date().getFullYear()} LifeSignal AI. All rights reserved.</p>
        <div className="flex items-center gap-4 mt-4 md:mt-0">
          <Link href="/about" className="hover:text-foreground transition-colors">
            About
          </Link>
          <Link href="/privacy-policy" className="hover:text-foreground transition-colors">
            Privacy Policy
          </Link>
          <Link href="/terms-of-service" className="hover:text-foreground transition-colors">
            Terms of Service
          </Link>
        </div>
      </div>
    </footer>
  );
}