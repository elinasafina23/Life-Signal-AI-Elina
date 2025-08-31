// src/app/api/emergency_contact/invite/route.ts
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { db, adminAuth } from '@/lib/firebaseAdmin';
import { normalizeRole, isMainUserRole, Role } from '@/lib/roles';

async function requireMainUser(req: NextRequest) {
  const cookie = req.cookies.get('__session')?.value || '';
  if (!cookie) throw new Error('UNAUTHENTICATED');

  const decoded = await adminAuth.verifySessionCookie(cookie, true);
  const userSnap = await db.doc(`users/${decoded.uid}`).get();
  const data = userSnap.data() as { role?: string; email?: string } | undefined;

  const role = normalizeRole(data?.role);
  if (!isMainUserRole(role)) throw new Error('NOT_AUTHORIZED');

  const email = data?.email || (decoded as any)?.email || '';
  return { uid: decoded.uid, email };
}

export async function POST(req: NextRequest) {
  try {
    const { uid: mainUserId } = await requireMainUser(req);
    const { email, name, relation } = await req.json();

    const targetEmail = String(email ?? '').toLowerCase().trim();
    if (!targetEmail) {
      return NextResponse.json({ error: 'Email required' }, { status: 400 });
    }

    // Idempotency: one pending/active link per main_user + email
    const careTeamId = `${mainUserId}_${targetEmail}`;
    const careTeamRef = db.doc(`careTeams/${careTeamId}`);
    const existing = await careTeamRef.get();
    if (existing.exists) {
      const status = existing.get('status');
      if (status === 'ACTIVE' || status === 'PENDING') {
        return NextResponse.json({ ok: true, alreadyInvited: true }, { status: 200 });
      }
    }

    // Create token (+ optional hash for server-side auditing)
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const now = Timestamp.now();
    const expiresAt = Timestamp.fromDate(new Date(Date.now() + 1000 * 60 * 60 * 24 * 7)); // 7 days

    // Write invite + pending careTeam + optional contact record
    const batch = db.batch();

    // Invite document (matches your /emergency_contact/accept page expectations)
    const inviteRef = db.collection('invites').doc();
    batch.set(inviteRef, {
      // identity
      userId: mainUserId,                 // main_user uid
      role: 'emergency_contact' as Role,

      // recipient
      emergencyEmail: targetEmail,        // canonical
      caregiverEmail: targetEmail,        // backward-compat for older code

      // tokening
      token,                              // plain for client accept flow
      tokenHash,                          // optional audit
      status: 'pending',                  // your accept page checks this
      createdAt: now,
      acceptedAt: null,
      expiresAt,

      // display
      name: name || null,
      relation: relation || null,
    });

    // Optional: top-level care team record (idempotency + server use)
    batch.set(careTeamRef, {
      id: careTeamId,
      patientId: mainUserId,              // keep field name if other code expects it
      caregiverEmail: targetEmail,        // legacy-friendly
      caregiverId: null,
      status: 'PENDING',
      createdAt: now,
    });

    // Optional: store a contact card under the main user
    if (name || relation) {
      const contactRef = db.collection(`users/${mainUserId}/emergencyContacts`).doc();
      batch.set(contactRef, {
        email: targetEmail,
        name: name || '',
        relation: relation || '',
        invitedAt: now,
      });
    }

    await batch.commit();

    // Accept URL for your client accept page
    const origin = process.env.APP_ORIGIN ?? 'http://localhost:3000';
    const acceptUrl = `${origin}/emergency_contact/accept?invite=${inviteRef.id}&token=${token}`;

    // ---- Send email (Firebase Trigger Email extension) ----
    // If you're NOT using the extension, replace this with your provider call.
    await db.collection('mail').add({
      to: [targetEmail],
      message: {
        subject: 'You’ve been added as an emergency contact',
        html: `
          <p>Hello${name ? ' ' + name : ''},</p>
          <p>You’ve been invited to be an <strong>emergency contact</strong>. Click the link below to accept:</p>
          <p><a href="${acceptUrl}">${acceptUrl}</a></p>
          <p>This link expires in 7 days.</p>
        `,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.message === 'UNAUTHENTICATED') return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });
    if (e?.message === 'NOT_AUTHORIZED') return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

    console.error(e);
    return NextResponse.json({ error: e?.message ?? 'Invite failed' }, { status: 400 });
  }
}
