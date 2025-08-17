"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { useToast } from "@/hooks/use-toast";

import { auth } from "@/firebase"; // <-- your firebase.ts
import { signInWithEmailAndPassword } from "firebase/auth";
import { useState } from "react";

const loginSchema = z.object({
  email: z.string().email({ message: "Please enter a valid email address." }),
  password: z.string().min(1, { message: "Password is required." }),
});

export default function LoginPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = async (values: z.infer<typeof loginSchema>) => {
    try {
      setIsSubmitting(true);
      const { user } = await signInWithEmailAndPassword(auth, values.email, values.password);
      toast({ title: "Login Successful", description: `Welcome back, ${user.email ?? "user"}!` });
      router.push("/dashboard");
    } catch (err: any) {
      // Friendly error messages
      const code = err?.code as string | undefined;
      let message = "Something went wrong. Please try again.";
      if (code === "auth/invalid-email") message = "Invalid email address.";
      else if (code === "auth/user-not-found" || code === "auth/wrong-password") message = "Incorrect email or password.";
      else if (code === "auth/too-many-requests") message = "Too many attempts. Please wait and try again.";
      toast({ title: "Login failed", description: message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <Header />
      <main className="flex-grow flex items-center justify-center p-4">
        <Card className="w-full max-w-md shadow-xl">
          <CardHeader className="text-center">
            <CardTitle className="text-3xl font-headline">Welcome Back!</CardTitle>
            <CardDescription>Sign in to continue to LifeSignal AI</CardDescription>
          </CardHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)}>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input type="email" placeholder="your@email.com" {...field} disabled={isSubmitting} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Password</FormLabel>
                      <FormControl>
                        <Input type="password" placeholder="••••••••" {...field} disabled={isSubmitting} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
              <CardFooter className="flex flex-col gap-4">
                <Button type="submit" className="w-full text-lg py-6" disabled={isSubmitting}>
                  {isSubmitting ? "Signing in..." : "Sign In"}
                </Button>
                <p className="text-center text-sm text-muted-foreground">
                  New to LifeSignal?{" "}
                  <Link href="/signup" className="font-semibold text-primary hover:underline">
                    Create an account
                  </Link>
                </p>
              </CardFooter>
            </form>
          </Form>
        </Card>
      </main>
      <Footer />
    </div>
  );
}
