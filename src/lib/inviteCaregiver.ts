import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { auth, db } from "@/firebase";

// Small random hex token for the link (extra safety)
function randomTokenHex(len = 16) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Creates an invite in Firestore and writes a doc to the `mail` collection.
 * The Trigger Email extension sends the email for us.
 */
export async function inviteCaregiver(input: { name?: string; email: string; phone?: string }) {
  const user = auth.currentUser;
  if (!user) throw new Error("You must be signed in.");

  const caregiverEmail = input.email.trim().toLowerCase();
  const token = randomTokenHex(16);

  // 1) Create the invite (pending)
  const inviteRef = await addDoc(collection(db, "invites"), {
    userId: user.uid,
    caregiverEmail,
    caregiverName: input.name || null,
    caregiverPhone: input.phone || null,
    token,
    status: "pending",
    createdAt: serverTimestamp(),
  });

  // 2) Queue email for the Trigger Email extension
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || window.location.origin;
  const link = `${appUrl}/caregiver/accept?invite=${inviteRef.id}&token=${token}`;

  await addDoc(collection(db, "mail"), {
    to: [caregiverEmail],
    message: {
      subject: "You’re invited to be an emergency contact on LifeSignal AI",
      html: `
        <p>Hello${input.name ? " " + input.name : ""},</p>
        <p>You’ve been invited to be a an emergency contact on LifeSignal AI.</p>
        <p><a href="${link}">Accept invitation</a></p>
        <p>If the button doesn't work, copy this URL:<br>${link}</p>
      `,
      text: `Accept invitation: ${link}`,
    },
  });

  return inviteRef.id;
}
