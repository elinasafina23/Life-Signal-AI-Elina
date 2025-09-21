// src/lib/firebaseAdmin.ts
import "server-only"; // ⛔ Ensure this module is only bundled on the server (Next.js)

import {
  getApps,          // Reads currently initialized Admin apps (avoid double init)
  initializeApp,    // Initializes the Firebase Admin app
  cert,             // Creates a credential from a service-account object
  applicationDefault, // Uses GOOGLE_APPLICATION_CREDENTIALS or metadata on GCP
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";          // Admin Auth API
import { getFirestore } from "firebase-admin/firestore"; // Admin Firestore API

// --- Read environment variables (from .env.local / deployment env) ---

// Project ID used by Admin SDK (often matches NEXT_PUBLIC_FIREBASE_PROJECT_ID)
const projectId =
  process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

// Service account fields (only needed if you are NOT using applicationDefault)
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;

// Some platforms store private keys with "\n" escapes; convert them to real newlines.
const privateKey = privateKeyRaw?.replace(/\\n/g, "\n");

// --- Initialize the Admin app exactly once ---
if (!getApps().length) {
  initializeApp({
    // If a full service-account is provided, use it; otherwise fall back to ADC.
    // ADC (Application Default Credentials) works locally if GOOGLE_APPLICATION_CREDENTIALS
    // is set, and on Cloud Run/Functions/App Engine by default.
    credential:
      privateKey && clientEmail && projectId
        ? cert({ projectId, clientEmail, privateKey })
        : applicationDefault(),
    // projectId helps in some local/dev setups; on GCP it can be inferred.
    projectId,
  });
}

// --- Create singletons for Admin services ---

/**
 * adminAuth: use this in API routes to verify/mint session cookies,
 * manage users, set custom claims, etc.
 */
export const adminAuth = getAuth();

/**
 * db: Admin Firestore instance (server privileges).
 * - No security rules are applied (be careful!).
 * - Great for back-end tasks and scheduled functions.
 */
export const db = getFirestore();

// Optional: Small quality-of-life tweak.
// Ignore writing `undefined` fields instead of throwing.
try {
  db.settings({ ignoreUndefinedProperties: true });
} catch {
  // settings() can only be called once per process; safe to ignore if already set.
}

// Optional: Emulator hints (Admin SDK auto-detects via env vars).
// If you use emulators locally, set:
//   FIRESTORE_EMULATOR_HOST=localhost:8080
//   FIREBASE_AUTH_EMULATOR_HOST=localhost:9099
// No extra code is required here—Admin SDK will route to emulators automatically.
