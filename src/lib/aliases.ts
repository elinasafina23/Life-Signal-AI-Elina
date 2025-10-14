// src/lib/aliases.ts
export const ROUTES = {
    dashboardMain: "/dashboard",
    dashboardEmergency: "/emergency-dashboard",
    verifyEmail: "/verify-email",
    login: "/login",
  } as const;
  
  export const API = {
    setSession: "/api/auth/session",
    acceptEmergencyInvite: "/api/emergency_contact/accept",
  } as const;
  
  export const QP = {
    role: "role",
    next: "next",
    token: "token",
    fromHosted: "fromHosted",
    email: "email",
    verified: "verified",
  } as const;
  
  export const FIRESTORE = {
    users: "users",
    fields: {
      mainUserUid: "mainUserUid",
      firstName: "firstName",
      lastName: "lastName",
      role: "role",
      email: "email",
      phone: "phone",
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
  } as const;
  
  export const COOKIE = {
    session: "session", // if you name it explicitly anywhere
  } as const;
  
  export const ACTION_MODE = {
    verifyEmail: "verifyEmail",
  } as const;
  