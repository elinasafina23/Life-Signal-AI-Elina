// src/lib/firebaseAdmin.ts
import "server-only";
import { getApps, initializeApp, cert, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const projectId =
  process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;
// Support env-var private keys with escaped newlines
const privateKey = privateKeyRaw?.replace(/\\n/g, "\n");

if (!getApps().length) {
  initializeApp({
    credential:
      privateKey && clientEmail && projectId
        ? cert({ projectId, clientEmail, privateKey })
        : applicationDefault(), // falls back to GOOGLE_APPLICATION_CREDENTIALS
    projectId,
  });
}

export const adminAuth = getAuth();
export const db = getFirestore();
