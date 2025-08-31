// src/lib/inviteEmergencyContact.ts
"use client";

import { addDoc, collection, serverTimestamp, Timestamp } from "firebase/firestore";
import { auth, db } from "@/firebase";

/** Small random hex token for the link */
function randomTokenHex(len = 32) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Optional: SHA-256 for auditing / fallback lookup */
async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Creates an emergency-contact invite in Firestore and queues an email via the
 * Firebase Trigger Email extension (writes to the `mail` collection).
 *
 * NOTE: This is a CLIENT helper. Only call it from client components/pages.
 * If you prefer server-side invites, call POST /api/emergency_contact/invite instead.
 */
export async function inviteEmergencyContact(input: {
  name?: string;
  email: string;
  phone?: string;
}) {
  const user = auth.currentUser;
  if (!user) throw new Error("You must be signed in.");

  const emergencyEmail = input.email.trim().toLowerCase();
  const token = randomTokenHex(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)); // 7 days

  // Build link (we’ll insert the invite id after we create it)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || window.location.origin;
  const linkTemplate = `${appUrl}/emergency_contact/accept?invite={{id}}&token=${token}`;

  // 1) Create the invite (pending)
  const inviteRef = await addDoc(collection(db, "invites"), {
    userId: user.uid,                 // main_user uid
    role: "emergency_contact",        // canonical role of invitee
    emergencyEmail,                   // canonical field
    // Back-compat keys if older code reads them:
    caregiverEmail: emergencyEmail,

    // tokening
    token,                            // stored since your client accept flow reads it
    tokenHash,                        // optional, useful for server-side lookups
    status: "pending",
    createdAt: serverTimestamp(),
    expiresAt,

    // display
    name: input.name || null,
    phone: input.phone || null,
  });

  const acceptLink = linkTemplate.replace("{{id}}", inviteRef.id);

  // 2) Queue email for the Trigger Email extension
  await addDoc(collection(db, "mail"), {
    to: [emergencyEmail],
    message: {
      subject: "You’re invited as an emergency contact",
      html: `
        <p>Hello${input.name ? " " + input.name : ""},</p>
        <p>You’ve been invited to be an <strong>emergency contact</strong> on LifeSignal AI.</p>
        <p><a href="${acceptLink}">Accept invitation</a></p>
        <p>If the button doesn't work, copy this URL:<br>${acceptLink}</p>
      `,
      text: `Accept invitation: ${acceptLink}`,
    },
  });

  return inviteRef.id;
}
