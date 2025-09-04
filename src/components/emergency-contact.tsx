// src/components/emergency-contact.tsx
"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc, setDoc, deleteField } from "firebase/firestore";
import { auth, db } from "@/firebase";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogTrigger, DialogFooter, DialogClose
} from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { User, Phone, Mail, Pencil } from "lucide-react";

// ✅ Use the drop-in client helper that ONLY creates invite docs/emails
import { inviteEmergencyContact as sendInvite } from "@/lib/inviteEmergencyContact";

// ---------- Validation ----------
const nameValidation = z
  .string()
  .min(1, { message: "Name is required" })
  .regex(/^[\p{L}\s'-]+$/u, { message: "Only letters, spaces, hyphens, apostrophes." });

const phoneValidation = z
  .string()
  .min(1, { message: "Phone number is required" })
  .regex(/^\+?[1-9]\d{6,14}$/, { message: "Invalid phone number format." });

const emergencyContactsSchema = z.object({
  contact1_name: nameValidation,
  contact1_email: z.string().email({ message: "Invalid email address." }),
  contact1_phone: phoneValidation,

  contact2_name: z.string().optional().or(z.literal("")),
  contact2_email: z.string().email({ message: "Invalid email address." }).optional().or(z.literal("")),
  contact2_phone: z.string().regex(/^\+?[1-9]\d{1,14}$/, { message: "Invalid phone number format." }).optional().or(z.literal("")),
})
.refine(v => {
  const any = !!(v.contact2_name || v.contact2_email || v.contact2_phone);
  const all = !!(v.contact2_name && v.contact2_email && v.contact2_phone);
  return !any || all;
}, { message: "Provide all fields for Contact 2 or leave them all blank." });

type EmergencyContactsFormValues = z.infer<typeof emergencyContactsSchema>;

const initialContacts: EmergencyContactsFormValues = {
  contact1_name: "",
  contact1_email: "",
  contact1_phone: "",
  contact2_name: "",
  contact2_email: "",
  contact2_phone: "",
};

export function EmergencyContacts() {
  const { toast } = useToast();
  const [uid, setUid] = useState<string | null>(null);
  const [contacts, setContacts] = useState<EmergencyContactsFormValues>(initialContacts);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [loaded, setLoaded] = useState(false); // prevents flash before Firestore load

  // UI state for resend button
  const [resending, setResending] = useState<string | null>(null); // holds the email currently resending

  const form = useForm<EmergencyContactsFormValues>({
    resolver: zodResolver(emergencyContactsSchema),
    defaultValues: contacts,
  });

  // Load from Firestore
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setUid(null);
        setContacts(initialContacts);
        setLoaded(true);
        return;
      }
      setUid(user.uid);

      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        const data = snap.data() as any;
        const saved = data?.emergencyContacts;
        if (saved) {
          setContacts({
            contact1_name: saved.contact1_name ?? "",
            contact1_email: saved.contact1_email ?? "",
            contact1_phone: saved.contact1_phone ?? "",
            contact2_name: saved.contact2_name ?? "",
            contact2_email: saved.contact2_email ?? "",
            contact2_phone: saved.contact2_phone ?? "",
          });
        } else {
          setContacts(initialContacts);
        }
      } catch (e) {
        console.error("Failed to load emergency contacts:", e);
      } finally {
        setLoaded(true);
      }
    });
    return () => unsub();
  }, []);

  // When dialog opens, reset to latest
  useEffect(() => {
    if (isDialogOpen) form.reset(contacts);
  }, [isDialogOpen, contacts, form]);

  // Save + auto-invite on new/changed emails
  const onSubmit = async (data: EmergencyContactsFormValues) => {
    if (!uid) {
      toast({ title: "Not signed in", description: "Please sign in to save.", variant: "destructive" });
      setIsDialogOpen(false);
      return;
    }

    // Trim all fields
    const c1 = {
      contact1_name: data.contact1_name.trim(),
      contact1_email: data.contact1_email.trim(),
      contact1_phone: data.contact1_phone.trim(),
    };
    const c2 = {
      contact2_name: data.contact2_name?.trim() ?? "",
      contact2_email: data.contact2_email?.trim() ?? "",
      contact2_phone: data.contact2_phone?.trim() ?? "",
    };
    const c2Empty = !c2.contact2_name && !c2.contact2_email && !c2.contact2_phone;

    try {
      // 1) Save contacts in the user profile doc
      if (c2Empty) {
        await setDoc(
          doc(db, "users", uid),
          {
            emergencyContacts: {
              ...c1,
              contact2_name: deleteField(),
              contact2_email: deleteField(),
              contact2_phone: deleteField(),
            },
          },
          { merge: true }
        );
        setContacts({ ...c1, contact2_name: "", contact2_email: "", contact2_phone: "" });
      } else {
        await setDoc(
          doc(db, "users", uid),
          { emergencyContacts: { ...c1, ...c2 } },
          { merge: true }
        );
        setContacts({ ...c1, ...c2 });
      }

      // 2) Send invite emails only when the email changed or is new
      const invitePromises: Promise<any>[] = [];

      // Contact 1
      const prevC1 = contacts.contact1_email?.trim().toLowerCase() || "";
      const nextC1 = c1.contact1_email.toLowerCase();
      if (!prevC1 || prevC1 !== nextC1) {
        invitePromises.push(
          sendInvite({
            name: c1.contact1_name,
            email: c1.contact1_email,
            relation: "primary",
          })
        );
      }

      // Contact 2
      if (!c2Empty && c2.contact2_email) {
        const prevC2 = contacts.contact2_email?.trim().toLowerCase() || "";
        const nextC2 = c2.contact2_email.toLowerCase();
        if (!prevC2 || prevC2 !== nextC2) {
          invitePromises.push(
            sendInvite({
              name: c2.contact2_name,
              email: c2.contact2_email,
              relation: "secondary",
            })
          );
        }
      }

      if (invitePromises.length) {
        await Promise.all(invitePromises);
        toast({
          title: "Invites sent",
          description: "We emailed your emergency contact(s) an invitation.",
        });
      } else {
        toast({ title: "Saved", description: "Emergency contacts updated successfully." });
      }

      setIsDialogOpen(false);
    } catch (e: any) {
      console.error("Save failed:", e);
      toast({ title: "Save failed", description: e?.message ?? String(e), variant: "destructive" });
    }
  };

  // Manual resend handler — calls the same client helper to rotate a fresh invite
  const handleResend = async (email?: string | null) => {
    const target = (email || "").trim();
    if (!target) {
      toast({ title: "Missing email", description: "Add an email first, then try again.", variant: "destructive" });
      return;
    }
    try {
      setResending(target.toLowerCase());

      // Determine which contact we're resending for to set relation/name
      const isC1 = target.toLowerCase() === (contacts.contact1_email || "").toLowerCase();
      const relation = isC1 ? "primary" : "secondary";
      const name = isC1 ? contacts.contact1_name : contacts.contact2_name;

      await sendInvite({ email: target, name, relation });
      toast({ title: "Invite sent", description: `We sent a new invite to ${target}.` });
    } catch (e: any) {
      toast({ title: "Could not resend", description: e?.message ?? "Please try again.", variant: "destructive" });
    } finally {
      setResending(null);
    }
  };

  // Only show Contact 2 if it has any data
  const hasContact2 =
    !!contacts.contact2_name?.trim() ||
    !!contacts.contact2_email?.trim() ||
    !!contacts.contact2_phone?.trim();

  if (!loaded) {
    return (
      <Card className="shadow-lg">
        <CardHeader>
          <CardTitle className="text-2xl font-headline">Emergency Contacts</CardTitle>
          <CardDescription>Loading…</CardDescription>
        </CardHeader>
        <CardContent><div className="h-20 animate-pulse bg-muted rounded" /></CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-lg">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-2xl font-headline">Emergency Contacts</CardTitle>
          <CardDescription>Your designated points of contact.</CardDescription>
        </div>

        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="icon" aria-label="Edit emergency contacts">
              <Pencil className="h-4 w-4" />
            </Button>
          </DialogTrigger>

          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Edit Emergency Contacts</DialogTitle>
            </DialogHeader>

            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <div className="space-y-4 border p-4 rounded-lg">
                  <FormLabel className="font-bold">Emergency Contact 1</FormLabel>

                  <FormField control={form.control} name="contact1_name" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl><Input placeholder="Jane Doe" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <FormField control={form.control} name="contact1_email" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl><Input type="email" placeholder="jane@example.com" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <FormField control={form.control} name="contact1_phone" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone</FormLabel>
                      <FormControl><Input type="tel" placeholder="+15551234567" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>

                <div className="space-y-4 border p-4 rounded-lg">
                  <FormLabel className="font-bold">Emergency Contact 2 (Optional)</FormLabel>

                  <FormField control={form.control} name="contact2_name" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl><Input placeholder="John Doe" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <FormField control={form.control} name="contact2_email" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl><Input type="email" placeholder="john@example.com" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <FormField control={form.control} name="contact2_phone" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone</FormLabel>
                      <FormControl><Input type="tel" placeholder="+15557654321" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>

                <DialogFooter>
                  <DialogClose asChild><Button type="button" variant="secondary">Cancel</Button></DialogClose>
                  <Button type="submit">Save changes</Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Contact 1 display + resend */}
        <div className="space-y-2">
          <h4 className="font-semibold">Contact 1</h4>
          <div className="flex items-center gap-3 text-muted-foreground">
            <User className="h-5 w-5" />
            <span>{contacts.contact1_name || "—"}</span>
          </div>
          <div className="flex items-center gap-3 text-muted-foreground">
            <Mail className="h-5 w-5" />
            <span>{contacts.contact1_email || "—"}</span>
          </div>
          <div className="flex items-center gap-3 text-muted-foreground">
            <Phone className="h-5 w-5" />
            <span>{contacts.contact1_phone || "—"}</span>
          </div>
          {!!contacts.contact1_email && (
            <div className="pt-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleResend(contacts.contact1_email)}
                disabled={resending === contacts.contact1_email.toLowerCase()}
              >
                {resending === contacts.contact1_email.toLowerCase() ? "Sending…" : "Resend invite"}
              </Button>
            </div>
          )}
        </div>

        {/* Contact 2 display + resend (only if present) */}
        {hasContact2 && (
          <div className="space-y-2 border-t pt-4">
            <h4 className="font-semibold">Contact 2</h4>
            <div className="flex items-center gap-3 text-muted-foreground">
              <User className="h-5 w-5" />
              <span>{contacts.contact2_name}</span>
            </div>
            <div className="flex items-center gap-3 text-muted-foreground">
              <Mail className="h-5 w-5" />
              <span>{contacts.contact2_email}</span>
            </div>
            <div className="flex items-center gap-3 text-muted-foreground">
              <Phone className="h-5 w-5" />
              <span>{contacts.contact2_phone}</span>
            </div>
            {!!contacts.contact2_email && (
              <div className="pt-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleResend(contacts.contact2_email)}
                  disabled={resending === contacts.contact2_email.toLowerCase()}
                >
                  {resending === contacts.contact2_email.toLowerCase() ? "Sending…" : "Resend invite"}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
