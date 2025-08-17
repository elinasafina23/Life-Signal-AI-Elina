# **App Name**: GuardianLink

## Core Features:

- Landing Page: Landing page with clear app description, login/signup buttons, and links to 'About' and 'Privacy Policy'.
- Sign Up / Login: User signup/login via Google Account. Users add emergency contacts and location sharing consent. Emergency contacts link via invite.
- User Dashboard: User dashboard with SOS and Check-in buttons. Displays last check-in time and location. App sends 'Are you OK?' notifications if no activity is detected for too long. Option to use voice check-in.
- Emergency Contact Dashboard: Emergency Contact dashboard shows linked users' status, last check-in, and location map. Receives notifications when a user sends SOS or is unresponsive, and can escalate as needed.
- Location Sharing: Uses HTML5 Geolocation API to get and send user location coordinates with SOS and inactivity alerts. Displays a Google Maps embed in the Emergency Contact dashboard.
- Record Voice Check-in: Allow the user to record an 'I'm OK' message and store it.
- AI Voice Check-in Assessment: A tool that uses voice recognition and an LLM to evaluate the transcribed user speech and compare it to previously stored voice messages in order to verify user's condition based on behavioral biometrics such as speech rate, cadence, and typical phrases.

## Style Guidelines:

- Primary color: Soft blue (#64B5F6) for a calm and reassuring feel.
- Background color: Very light blue (#E3F2FD).
- Accent color: Muted teal (#4DB6AC) to indicate active or important elements, giving users a quick indication that they need help or require intervention from caretakers or emergency responders. It's close to blue but contrasts enough to catch the eye.
- Body and headline font: 'PT Sans', a humanist sans-serif with a modern and warm feel. Note: currently only Google Fonts are supported.
- Use clear, recognizable icons to represent key functions such as SOS, Check-in, and Location.
- The user interface should use large, friendly, clickable buttons. Space out elements so it's easy to read for impaired users. Font size is bigger than default for accessibility.
- Use subtle animations and transitions to provide feedback and guide the user through the app without overwhelming them.