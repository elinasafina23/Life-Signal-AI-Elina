# Firebase Studio

This is a NextJS starter in Firebase Studio.

To get started, take a look at src/app/page.tsx.

## Environment setup

The app expects a Firebase project (or the local emulators) to be configured via environment variables.
Create a `.env.local` file in the project root by copying the provided example:

```bash
cp .env.example .env.local
```

Then replace each placeholder with the values from your Firebase console. The `NEXT_PUBLIC_…` variables
come from **Project settings → Your apps → Web app**. The `FIREBASE_…` variables are from a service account
JSON (generate one under **Project settings → Service accounts → Firebase Admin SDK**). Keep the `\n`
escapes in the private key if you paste it on a single line.

If you prefer to use the emulators for local development, uncomment the `FIRESTORE_EMULATOR_HOST` and
`FIREBASE_AUTH_EMULATOR_HOST` entries in the environment file and run `firebase emulators:start` in a
separate terminal.

Once the environment variables are in place, install dependencies and start the dev server:

```bash
npm install
npm run dev
```
