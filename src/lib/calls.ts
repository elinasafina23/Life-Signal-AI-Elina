// src/lib/calls.ts
export async function acceptEmergencyInvite(input: { token: string; inviteId?: string }) {
    const res = await fetch("/api/emergency_contact/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include", // send session cookie
      body: JSON.stringify(input),
    });
  
    if (!res.ok) {
      // surface a good error message
      let message = "Accept failed";
      try {
        const data = await res.json();
        message = data?.error || message;
      } catch {}
      throw new Error(message);
    }
  
    // on success, you can return the JSON (e.g., { ok: true, mainUserId })
    return res.json();
  }
  