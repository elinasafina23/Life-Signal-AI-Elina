// src/components/emergency-contact.tsx
"use client"; // This file runs in the browser (not on the server).

/* ---------------- React ---------------- */
import { useEffect, useState } from "react";

/* ---------------- Firebase ---------------- */
// Auth: listen for sign-in / sign-out so we know who the main user is.
import { onAuthStateChanged } from "firebase/auth";
// Firestore: read/write the signed-in user's document.
import { doc, getDoc, setDoc, deleteField } from "firebase/firestore";
import { auth, db } from "@/firebase";

/* ---------------- Forms & Validation ---------------- */
// React Hook Form handles form state. Zod validates the fields.
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

/* ---------------- UI kit ---------------- */
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogTrigger, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { User, Phone, Mail, Pencil } from "lucide-react";

/* ---------------- Invites ---------------- */
// Helper that creates an invite (writes Firestore + sends email).
import { inviteEmergencyContact as sendInvite } from "@/lib/inviteEmergencyContact";

/* ============================================================================
   Validation (Zod)
   ========================================================================== */

// First/last name rules: letters, spaces, hyphens, apostrophes. Required.
const namePartValidation = z
  .string()
  .min(1, { message: "This field is required" })
  .regex(/^[\p{L}\s'-]+$/u, { message: "Only letters, spaces, hyphens, apostrophes." });

// Phone: simple E.164-style check: optional leading +, 7–15 digits, no leading 0.
const phoneValidation = z
  .string()
  .min(1, { message: "Phone number is required" })
  .regex(/^\+?[1-9]\d{6,14}$/, { message: "Invalid phone number format." });

// Contact 2 phone can be blank; if present, must be valid.
const optionalPhoneValidation = z
  .string()
  .regex(/^\+?[1-9]\d{1,14}$/, { message: "Invalid phone number format." });

// Schema describing the dialog form.
const emergencyContactsSchema = z
  .object({
    // Contact 1 (required)
    contact1_firstName: namePartValidation,
    contact1_lastName:  namePartValidation,
    contact1_email:     z.string().email({ message: "Invalid email address." }),
    contact1_phone:     phoneValidation,

    // Contact 2 (optional — either fill ALL its fields, or leave all blank)
    contact2_firstName: z.string().optional().or(z.literal("")),
    contact2_lastName:  z.string().optional().or(z.literal("")),
    contact2_email:     z.string().email({ message: "Invalid email address." }).optional().or(z.literal("")),
    contact2_phone:     optionalPhoneValidation.optional().or(z.literal("")),
  })
  .refine((v) => {
    const any =
      !!(v.contact2_firstName || v.contact2_lastName || v.contact2_email || v.contact2_phone);
    const all =
      !!(v.contact2_firstName && v.contact2_lastName && v.contact2_email && v.contact2_phone);
    return !any || all; // valid if none or all are filled
  }, { message: "Provide all fields for Contact 2 or leave them all blank." });

type EmergencyContactsFormValues = z.infer<typeof emergencyContactsSchema>;

// What we show before Firestore loads.
const initialContacts: EmergencyContactsFormValues = {
  contact1_firstName: "",
  contact1_lastName:  "",
  contact1_email:     "",
  contact1_phone:     "",
  contact2_firstName: "",
  contact2_lastName:  "",
  contact2_email:     "",
  contact2_phone:     "",
};

/* ============================================================================
   Small helpers
   ========================================================================== */

// Join first + last into a nice display name.
function fullName(first?: string, last?: string) {
  const f = (first || "").trim();
  const l = (last  || "").trim();
  const joined = [f, l].filter(Boolean).join(" ");
  return joined || "—";
}

// Normalize emails for comparisons.
const normEmail = (e?: string | null) => (e || "").trim().toLowerCase();

/* ============================================================================
   Component
   ========================================================================== */

export function EmergencyContacts() {
  const { toast } = useToast();

  // The signed-in **main user** uid (this is your canonical mainUserUid).
  const [uid, setUid] = useState<string | null>(null);

  // What we display on the card (kept in sync with Firestore).
  const [contacts, setContacts] = useState<EmergencyContactsFormValues>(initialContacts);

  // Dialog open/closed state.
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  // When false, we show a small skeleton instead of empty UI.
  const [loaded, setLoaded] = useState(false);

  // Which email is being re-sent right now (to disable its button).
  const [resending, setResending] = useState<string | null>(null);

  // React Hook Form instance seeded with whatever we’re showing.
  const form = useForm<EmergencyContactsFormValues>({
    resolver: zodResolver(emergencyContactsSchema),
    defaultValues: contacts,
  });

  /* ---------------- Load Firestore on auth change ---------------- */
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        // Signed out → clear everything.
        setUid(null);
        setContacts(initialContacts);
        setLoaded(true);
        return;
      }

      // Signed in → remember their uid (this is the mainUserUid).
      setUid(user.uid);

      try {
        // Load the user's document (where we store emergencyContacts object).
        const snap = await getDoc(doc(db, "users", user.uid));
        const data = snap.data() as any;
        const saved = data?.emergencyContacts;

        if (saved) {
          // Legacy support: if old "contactX_name" exists, split into first/last.
          const splitName = (name?: string) => {
            const s = (name || "").trim();
            if (!s) return { first: "", last: "" };
            const parts = s.split(/\s+/);
            if (parts.length === 1) return { first: parts[0], last: "" };
            const last = parts.pop() || "";
            return { first: parts.join(" "), last };
          };

          const legacyC1 = splitName(saved.contact1_name);
          const legacyC2 = splitName(saved.contact2_name);

          const next: EmergencyContactsFormValues = {
            contact1_firstName: saved.contact1_firstName ?? legacyC1.first ?? "",
            contact1_lastName:  saved.contact1_lastName  ?? legacyC1.last  ?? "",
            contact1_email:     saved.contact1_email     ?? "",
            contact1_phone:     saved.contact1_phone     ?? "",
            contact2_firstName: saved.contact2_firstName ?? legacyC2.first ?? "",
            contact2_lastName:  saved.contact2_lastName  ?? legacyC2.last  ?? "",
            contact2_email:     saved.contact2_email     ?? "",
            contact2_phone:     saved.contact2_phone     ?? "",
          };

          setContacts(next);
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

  // Keep the form fields in sync with whatever we’re showing when the dialog opens.
  useEffect(() => {
    if (isDialogOpen) form.reset(contacts);
  }, [isDialogOpen, contacts, form]);

  /* ---------------- Save handler (also sends invites) ---------------- */
  const onSubmit = async (data: EmergencyContactsFormValues) => {
    if (!uid) {
      toast({ title: "Not signed in", description: "Please sign in to save.", variant: "destructive" });
      setIsDialogOpen(false);
      return;
    }

    // Trim all fields.
    const c1 = {
      contact1_firstName: data.contact1_firstName.trim(),
      contact1_lastName:  data.contact1_lastName.trim(),
      contact1_email:     data.contact1_email.trim(),
      contact1_phone:     data.contact1_phone.trim(),
    };
    const c2 = {
      contact2_firstName: data.contact2_firstName?.trim() ?? "",
      contact2_lastName:  data.contact2_lastName?.trim() ?? "",
      contact2_email:     data.contact2_email?.trim() ?? "",
      contact2_phone:     data.contact2_phone?.trim() ?? "",
    };

    // If ALL contact 2 fields are blank, we’ll remove them from Firestore.
    const c2Empty = !c2.contact2_firstName && !c2.contact2_lastName && !c2.contact2_email && !c2.contact2_phone;

    try {
      // 1) Write to Firestore under users/{mainUserUid}.emergencyContacts
      if (c2Empty) {
        await setDoc(
          doc(db, "users", uid),
          {
            emergencyContacts: {
              ...c1,
              contact2_firstName: deleteField(),
              contact2_lastName:  deleteField(),
              contact2_email:     deleteField(),
              contact2_phone:     deleteField(),
              // Nuke legacy single-name fields if they exist.
              contact1_name:      deleteField(),
              contact2_name:      deleteField(),
            },
          },
          { merge: true }
        );
        setContacts({ ...c1, contact2_firstName: "", contact2_lastName: "", contact2_email: "", contact2_phone: "" });
      } else {
        await setDoc(
          doc(db, "users", uid),
          {
            emergencyContacts: {
              ...c1,
              ...c2,
              contact1_name: deleteField(),
              contact2_name: deleteField(),
            },
          },
          { merge: true }
        );
        setContacts({ ...c1, ...c2 });
      }

      // 2) Send invites only if the email is new/changed.
      const inviteJobs: Promise<unknown>[] = [];

      const prevC1 = normEmail(contacts.contact1_email);
      const nextC1 = normEmail(c1.contact1_email);
      if (!prevC1 || prevC1 !== nextC1) {
        inviteJobs.push(
          sendInvite({
            // The server uses (mainUserUid, email) to build the link doc and invite.
            name: fullName(c1.contact1_firstName, c1.contact1_lastName),
            email: c1.contact1_email,
            relation: "primary",
          })
        );
      }

      const prevC2 = normEmail(contacts.contact2_email);
      const nextC2 = normEmail(c2.contact2_email);
      if (!c2Empty && nextC2 && (!prevC2 || prevC2 !== nextC2)) {
        inviteJobs.push(
          sendInvite({
            name: fullName(c2.contact2_firstName, c2.contact2_lastName),
            email: c2.contact2_email,
            relation: "secondary",
          })
        );
      }

      if (inviteJobs.length) {
        await Promise.all(inviteJobs);
        toast({ title: "Invites sent", description: "We emailed your emergency contact(s) an invitation." });
      } else {
        toast({ title: "Saved", description: "Emergency contacts updated successfully." });
      }

      setIsDialogOpen(false);
    } catch (e: any) {
      console.error("Save failed:", e);
      toast({ title: "Save failed", description: e?.message ?? String(e), variant: "destructive" });
    }
  };

  /* ---------------- Manual resend (send a fresh invite) ---------------- */
  const handleResend = async (email?: string | null) => {
    const target = (email || "").trim();
    if (!target) {
      toast({ title: "Missing email", description: "Add an email first, then try again.", variant: "destructive" });
      return;
    }

    try {
      setResending(normEmail(target));
      const isC1 = normEmail(target) === normEmail(contacts.contact1_email);
      const relation = isC1 ? "primary" : "secondary";
      const name = isC1
        ? fullName(contacts.contact1_firstName, contacts.contact1_lastName)
        : fullName(contacts.contact2_firstName, contacts.contact2_lastName);

      await sendInvite({ email: target, name, relation });
      toast({ title: "Invite sent", description: `We sent a new invite to ${target}.` });
    } catch (e: any) {
      toast({ title: "Could not resend", description: e?.message ?? "Please try again.", variant: "destructive" });
    } finally {
      setResending(null);
    }
  };

  /* ---------------- Derived flags ---------------- */
  const hasContact2 =
    !!contacts.contact2_firstName?.trim() ||
    !!contacts.contact2_lastName?.trim()  ||
    !!contacts.contact2_email?.trim()     ||
    !!contacts.contact2_phone?.trim();

  /* ---------------- Skeleton while loading ---------------- */
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

  /* ---------------- Render ---------------- */
  return (
    <Card className="shadow-lg">
      {/* Header + edit button (opens dialog) */}
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

          {/* The dialog content is scrollable on small screens */}
          <DialogContent className="w-[95vw] sm:max-w-[480px] max-h-[90vh] overflow-y-auto p-0">
            <DialogHeader className="p-6 pb-4">
              <DialogTitle>Edit Emergency Contacts</DialogTitle>
            </DialogHeader>

            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-0">
                <div className="px-6 pb-6 space-y-4">
                  {/* Contact 1 (required) */}
                  <div className="space-y-4 border p-4 rounded-lg">
                    <FormLabel className="font-bold">Emergency Contact 1</FormLabel>

                    <FormField control={form.control} name="contact1_firstName" render={({ field }) => (
                      <FormItem>
                        <FormLabel>First name</FormLabel>
                        <FormControl><Input placeholder="Jane" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="contact1_lastName" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Last name</FormLabel>
                        <FormControl><Input placeholder="Doe" {...field} /></FormControl>
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

                  {/* Contact 2 (optional) */}
                  <div className="space-y-4 border p-4 rounded-lg">
                    <FormLabel className="font-bold">Emergency Contact 2 (Optional)</FormLabel>

                    <FormField control={form.control} name="contact2_firstName" render={({ field }) => (
                      <FormItem>
                        <FormLabel>First name</FormLabel>
                        <FormControl><Input placeholder="John" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="contact2_lastName" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Last name</FormLabel>
                        <FormControl><Input placeholder="Doe" {...field} /></FormControl>
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
                </div>

                {/* Sticky footer buttons */}
                <DialogFooter className="sticky bottom-0 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 p-4 border-t mt-0">
                  <DialogClose asChild>
                    <Button type="button" variant="secondary">Cancel</Button>
                  </DialogClose>
                  <Button type="submit">Save changes</Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </CardHeader>

      {/* Read-only display of saved contacts */}
      <CardContent className="space-y-6">
        {/* Contact 1 */}
        <div className="space-y-2">
          <h4 className="font-semibold">Contact 1</h4>
          <div className="flex items-center gap-3 text-muted-foreground">
            <User className="h-5 w-5" />
            <span>{fullName(contacts.contact1_firstName, contacts.contact1_lastName)}</span>
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
                disabled={resending === normEmail(contacts.contact1_email)}
              >
                {resending === normEmail(contacts.contact1_email) ? "Sending…" : "Resend invite"}
              </Button>
            </div>
          )}
        </div>

        {/* Contact 2 (only shown if any of its fields exist) */}
        {(!!hasContact2) && (
          <div className="space-y-2 border-t pt-4">
            <h4 className="font-semibold">Contact 2</h4>
            <div className="flex items-center gap-3 text-muted-foreground">
              <User className="h-5 w-5" />
              <span>{fullName(contacts.contact2_firstName, contacts.contact2_lastName)}</span>
            </div>
            <div className="flex items-center gap-3 text-muted-foreground">
              <Mail className="h-5 w-5" />
              <span>{contacts.contact2_email || "—"}</span>
            </div>
            <div className="flex items-center gap-3 text-muted-foreground">
              <Phone className="h-5 w-5" />
              <span>{contacts.contact2_phone || "—"}</span>
            </div>
            {!!contacts.contact2_email && (
              <div className="pt-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleResend(contacts.contact2_email)}
                  disabled={resending === normEmail(contacts.contact2_email)}
                >
                  {resending === normEmail(contacts.contact2_email) ? "Sending…" : "Resend invite"}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default EmergencyContacts;
