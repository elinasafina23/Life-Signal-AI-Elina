// src/components/emergency-contact.tsx
"use client"; // Ensures this component runs on the client side (Next.js app router).

// React
import { useEffect, useState } from "react"; // React hooks for lifecycle and state.

// Firebase Auth
import { onAuthStateChanged } from "firebase/auth"; // Listen to auth state changes.

// Firestore
import { doc, getDoc, setDoc, deleteField } from "firebase/firestore"; // Read/write to Firestore.
import { auth, db } from "@/firebase"; // Your initialized Firebase instances.

// Forms & validation
import { useForm } from "react-hook-form"; // Form state & handlers.
import { zodResolver } from "@hookform/resolvers/zod"; // Zod resolver for RHF.
import * as z from "zod"; // Zod runtime validation.

// UI components
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"; // Card primitives.
import { Button } from "@/components/ui/button"; // Button component.
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogTrigger, DialogFooter, DialogClose
} from "@/components/ui/dialog"; // Dialog primitives.
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"; // RHF + UI bindings.
import { Input } from "@/components/ui/input"; // Text input.
import { useToast } from "@/hooks/use-toast"; // Toast notifications.
import { User, Phone, Mail, Pencil } from "lucide-react"; // Icons.

// Invites helper
import { inviteEmergencyContact as sendInvite } from "@/lib/inviteEmergencyContact"; // Helper that creates invite docs/emails.

// ---------- Validation ----------

// Name parts: allow unicode letters, spaces, hyphens, apostrophes.
const namePartValidation = z
  .string() // Expect a string.
  .min(1, { message: "This field is required" }) // Must not be empty.
  .regex(/^[\p{L}\s'-]+$/u, { message: "Only letters, spaces, hyphens, apostrophes." }); // Restrict characters.

// E.164-ish phone (loose): +, no leading 0, 7–15 digits total.
const phoneValidation = z
  .string() // Expect a string.
  .min(1, { message: "Phone number is required" }) // Must not be empty.
  .regex(/^\+?[1-9]\d{6,14}$/, { message: "Invalid phone number format." }); // Validate number.

// Optional phone with looser min (for contact 2 optionality).
const optionalPhoneValidation = z
  .string()
  .regex(/^\+?[1-9]\d{1,14}$/, { message: "Invalid phone number format." });

// Form schema with first/last names for each contact.
const emergencyContactsSchema = z
  .object({
    // Contact 1 (required)
    contact1_firstName: namePartValidation, // First name required.
    contact1_lastName: namePartValidation, // Last name required.
    contact1_email: z.string().email({ message: "Invalid email address." }), // Email required.
    contact1_phone: phoneValidation, // Phone required.

    // Contact 2 (optional as a group)
    contact2_firstName: z.string().optional().or(z.literal("")), // Optional first name.
    contact2_lastName: z.string().optional().or(z.literal("")), // Optional last name.
    contact2_email: z.string().email({ message: "Invalid email address." }).optional().or(z.literal("")), // Optional email.
    contact2_phone: optionalPhoneValidation.optional().or(z.literal("")), // Optional phone.
  })
  .refine((v) => {
    // If any of contact 2 fields are provided, all must be provided.
    const any =
      !!(v.contact2_firstName || v.contact2_lastName || v.contact2_email || v.contact2_phone);
    const all =
      !!(v.contact2_firstName && v.contact2_lastName && v.contact2_email && v.contact2_phone);
    return !any || all; // Valid if none or all are filled.
  }, { message: "Provide all fields for Contact 2 or leave them all blank." });

// Types inferred from schema.
type EmergencyContactsFormValues = z.infer<typeof emergencyContactsSchema>;

// Initial empty values.
const initialContacts: EmergencyContactsFormValues = {
  contact1_firstName: "", // C1 first name initial value.
  contact1_lastName: "", // C1 last name initial value.
  contact1_email: "", // C1 email initial value.
  contact1_phone: "", // C1 phone initial value.

  contact2_firstName: "", // C2 first name initial value.
  contact2_lastName: "", // C2 last name initial value.
  contact2_email: "", // C2 email initial value.
  contact2_phone: "", // C2 phone initial value.
};

// Utility: join first + last into a display name.
function fullName(first?: string, last?: string) {
  // Trim parts, join with space, and fallback to em dash if empty.
  const f = (first || "").trim();
  const l = (last || "").trim();
  const joined = [f, l].filter(Boolean).join(" ");
  return joined || "—";
}

// Component export
export function EmergencyContacts() {
  const { toast } = useToast(); // Toast API.
  const [uid, setUid] = useState<string | null>(null); // Current user id.
  const [contacts, setContacts] = useState<EmergencyContactsFormValues>(initialContacts); // Display state from Firestore.
  const [isDialogOpen, setIsDialogOpen] = useState(false); // Dialog open state.
  const [loaded, setLoaded] = useState(false); // Prevents UI flash before load.
  const [resending, setResending] = useState<string | null>(null); // Email being re-sent.

  // React Hook Form instance, seeded by current contacts.
  const form = useForm<EmergencyContactsFormValues>({
    resolver: zodResolver(emergencyContactsSchema), // Hook zod into RHF.
    defaultValues: contacts, // Use display state as defaults.
  });

  // Firestore load on auth change.
  useEffect(() => {
    // Subscribe to auth state.
    const unsub = onAuthStateChanged(auth, async (user) => {
      // If logged out, reset local state and mark loaded.
      if (!user) {
        setUid(null); // Clear uid.
        setContacts(initialContacts); // Reset contacts.
        setLoaded(true); // Show UI as loaded.
        return; // Exit.
      }

      // Otherwise, set uid and load their doc.
      setUid(user.uid);

      try {
        // Fetch user document.
        const snap = await getDoc(doc(db, "users", user.uid));
        const data = snap.data() as any; // Firestore doc data.
        const saved = data?.emergencyContacts; // The sub-object for contacts.

        // If we have saved contacts, map to new shape (supports legacy "contactX_name").
        if (saved) {
          // Attempt to split legacy name (e.g., "Jane Doe") into first/last if needed.
          const splitName = (name?: string) => {
            const s = (name || "").trim();
            if (!s) return { first: "", last: "" };
            const parts = s.split(/\s+/);
            if (parts.length === 1) return { first: parts[0], last: "" };
            const last = parts.pop() || "";
            const first = parts.join(" ");
            return { first, last };
          };

          // Map contact 1 (legacy fallbacks)
          const legacyC1 = splitName(saved.contact1_name);
          // Map contact 2 (legacy fallbacks)
          const legacyC2 = splitName(saved.contact2_name);

          // Fill new fields preferring explicit first/last if present, else split legacy.
          const next: EmergencyContactsFormValues = {
            contact1_firstName: saved.contact1_firstName ?? legacyC1.first ?? "",
            contact1_lastName: saved.contact1_lastName ?? legacyC1.last ?? "",
            contact1_email: saved.contact1_email ?? "",
            contact1_phone: saved.contact1_phone ?? "",

            contact2_firstName: saved.contact2_firstName ?? legacyC2.first ?? "",
            contact2_lastName: saved.contact2_lastName ?? legacyC2.last ?? "",
            contact2_email: saved.contact2_email ?? "",
            contact2_phone: saved.contact2_phone ?? "",
          };

          // Push to display state.
          setContacts(next);
        } else {
          // No saved data; reset to blank.
          setContacts(initialContacts);
        }
      } catch (e) {
        // Surface error to console; UI stays functional.
        console.error("Failed to load emergency contacts:", e);
      } finally {
        // Mark as loaded in all cases.
        setLoaded(true);
      }
    });

    // Cleanup subscription on unmount.
    return () => unsub();
  }, []); // Run once.

  // When dialog opens, reset RHF form to latest Firestore-backed state.
  useEffect(() => {
    if (isDialogOpen) form.reset(contacts); // Keep form in sync.
  }, [isDialogOpen, contacts, form]); // Re-run when dialog toggles or contacts change.

  // Save + auto-invite on new/changed emails.
  const onSubmit = async (data: EmergencyContactsFormValues) => {
    // Must be signed in to save.
    if (!uid) {
      toast({ title: "Not signed in", description: "Please sign in to save.", variant: "destructive" });
      setIsDialogOpen(false);
      return;
    }

    // Normalize/trim all inputs.
    const c1 = {
      contact1_firstName: data.contact1_firstName.trim(),
      contact1_lastName: data.contact1_lastName.trim(),
      contact1_email: data.contact1_email.trim(),
      contact1_phone: data.contact1_phone.trim(),
    };

    const c2 = {
      contact2_firstName: data.contact2_firstName?.trim() ?? "",
      contact2_lastName: data.contact2_lastName?.trim() ?? "",
      contact2_email: data.contact2_email?.trim() ?? "",
      contact2_phone: data.contact2_phone?.trim() ?? "",
    };

    // Determine if contact 2 is fully empty.
    const c2Empty = !c2.contact2_firstName && !c2.contact2_lastName && !c2.contact2_email && !c2.contact2_phone;

    try {
      // 1) Save to Firestore: if C2 empty, clear those fields with deleteField().
      if (c2Empty) {
        await setDoc(
          doc(db, "users", uid), // Target user doc.
          {
            emergencyContacts: {
              ...c1, // Save C1 fields.
              contact2_firstName: deleteField(), // Clear C2 fields.
              contact2_lastName: deleteField(),
              contact2_email: deleteField(),
              contact2_phone: deleteField(),
              // (Optional) also clear any legacy name fields if present
              contact1_name: deleteField(),
              contact2_name: deleteField(),
            },
          },
          { merge: true } // Merge to avoid overwriting unrelated data.
        );

        // Update local display state to reflect cleared C2.
        setContacts({ ...c1, contact2_firstName: "", contact2_lastName: "", contact2_email: "", contact2_phone: "" });
      } else {
        // Save both contacts when C2 provided.
        await setDoc(
          doc(db, "users", uid),
          {
            emergencyContacts: {
              ...c1,
              ...c2,
              // (Optional) also clear any legacy name fields if present
              contact1_name: deleteField(),
              contact2_name: deleteField(),
            },
          },
          { merge: true }
        );

        // Update local display state to new values.
        setContacts({ ...c1, ...c2 });
      }

      // 2) Send invite emails only when the email changed or is new.
      const invitePromises: Promise<any>[] = [];

      // Contact 1 comparison (prev vs next).
      const prevC1 = contacts.contact1_email?.trim().toLowerCase() || "";
      const nextC1 = c1.contact1_email.toLowerCase();
      if (!prevC1 || prevC1 !== nextC1) {
        // Compose full name for C1.
        const name = fullName(c1.contact1_firstName, c1.contact1_lastName);
        invitePromises.push(
          sendInvite({
            name, // Use first + last.
            email: c1.contact1_email,
            relation: "primary",
          })
        );
      }

      // Contact 2 comparison (only if not empty).
      if (!c2Empty && c2.contact2_email) {
        const prevC2 = contacts.contact2_email?.trim().toLowerCase() || "";
        const nextC2 = c2.contact2_email.toLowerCase();
        if (!prevC2 || prevC2 !== nextC2) {
          // Compose full name for C2.
          const name = fullName(c2.contact2_firstName, c2.contact2_lastName);
          invitePromises.push(
            sendInvite({
              name, // Use first + last.
              email: c2.contact2_email,
              relation: "secondary",
            })
          );
        }
      }

      // Await and toast result.
      if (invitePromises.length) {
        await Promise.all(invitePromises);
        toast({
          title: "Invites sent",
          description: "We emailed your emergency contact(s) an invitation.",
        });
      } else {
        toast({ title: "Saved", description: "Emergency contacts updated successfully." });
      }

      // Close the dialog after saving.
      setIsDialogOpen(false);
    } catch (e: any) {
      // Bubble up error.
      console.error("Save failed:", e);
      toast({ title: "Save failed", description: e?.message ?? String(e), variant: "destructive" });
    }
  };

  // Manual resend handler — reuses the invite helper to rotate a fresh invite.
  const handleResend = async (email?: string | null) => {
    // Normalize email target.
    const target = (email || "").trim();
    if (!target) {
      toast({ title: "Missing email", description: "Add an email first, then try again.", variant: "destructive" });
      return;
    }

    try {
      // Mark which email is being resent to disable the button.
      setResending(target.toLowerCase());

      // Identify contact by email to determine relation and name.
      const isC1 = target.toLowerCase() === (contacts.contact1_email || "").toLowerCase();
      const relation = isC1 ? "primary" : "secondary";
      const name = isC1
        ? fullName(contacts.contact1_firstName, contacts.contact1_lastName)
        : fullName(contacts.contact2_firstName, contacts.contact2_lastName);

      // Send invite.
      await sendInvite({ email: target, name, relation });
      toast({ title: "Invite sent", description: `We sent a new invite to ${target}.` });
    } catch (e: any) {
      // Error toast.
      toast({ title: "Could not resend", description: e?.message ?? "Please try again.", variant: "destructive" });
    } finally {
      // Clear resending state.
      setResending(null);
    }
  };

  // Show Contact 2 section only if any of its fields are present.
  const hasContact2 =
    !!contacts.contact2_firstName?.trim() ||
    !!contacts.contact2_lastName?.trim() ||
    !!contacts.contact2_email?.trim() ||
    !!contacts.contact2_phone?.trim();

  // Skeleton card while loading Firestore.
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

  // Main render.
  return (
    <Card className="shadow-lg">
      {/* Header with title and edit button */}
      <CardHeader className="flex flex-row items-center justify-between">
        {/* Title/description */}
        <div>
          <CardTitle className="text-2xl font-headline">Emergency Contacts</CardTitle>
          <CardDescription>Your designated points of contact.</CardDescription>
        </div>

        {/* Edit dialog trigger + content */}
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="icon" aria-label="Edit emergency contacts">
              <Pencil className="h-4 w-4" />
            </Button>
          </DialogTrigger>

          {/* NOTE: max-h limits height to viewport; overflow-y enables scrolling */}
          <DialogContent className="w-[95vw] sm:max-w-[480px] max-h-[90vh] overflow-y-auto p-0">
            <DialogHeader className="p-6 pb-4">
              <DialogTitle>Edit Emergency Contacts</DialogTitle>
            </DialogHeader>

            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-0">
                {/* Scrollable form body (DialogContent handles the scrolling; no overflow here) */}
                <div className="px-6 pb-6 space-y-4">
                  {/* Contact 1 */}
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

                  {/* Contact 2 */}
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

                {/* Sticky footer so buttons are always visible */}
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

      {/* Body content displaying the contacts */}
      <CardContent className="space-y-6">
        {/* Contact 1 display + resend */}
        <div className="space-y-2">
          <h4 className="font-semibold">Contact 1</h4>

          {/* Name */}
          <div className="flex items-center gap-3 text-muted-foreground">
            <User className="h-5 w-5" />
            <span>{fullName(contacts.contact1_firstName, contacts.contact1_lastName)}</span>
          </div>

          {/* Email */}
          <div className="flex items-center gap-3 text-muted-foreground">
            <Mail className="h-5 w-5" />
            <span>{contacts.contact1_email || "—"}</span>
          </div>

          {/* Phone */}
          <div className="flex items-center gap-3 text-muted-foreground">
            <Phone className="h-5 w-5" />
            <span>{contacts.contact1_phone || "—"}</span>
          </div>

          {/* Resend button (only if email present) */}
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

            {/* Name */}
            <div className="flex items-center gap-3 text-muted-foreground">
              <User className="h-5 w-5" />
              <span>{fullName(contacts.contact2_firstName, contacts.contact2_lastName)}</span>
            </div>

            {/* Email */}
            <div className="flex items-center gap-3 text-muted-foreground">
              <Mail className="h-5 w-5" />
              <span>{contacts.contact2_email}</span>
            </div>

            {/* Phone */}
            <div className="flex items-center gap-3 text-muted-foreground">
              <Phone className="h-5 w-5" />
              <span>{contacts.contact2_phone}</span>
            </div>

            {/* Resend button (only if email present) */}
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
