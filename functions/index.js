const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const {
  getFirestore,
  FieldValue,
  Timestamp,
} = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();
const authAdmin = getAuth();

const INVITE_TTL_HOURS = 168;
const INACTIVITY_DAYS = 60;
const ACTIVITY_SYNC_EMAIL_LIMIT = 20;
const EMAIL_COLLECTION = 'mail';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function assert(condition, code, message) {
  if (!condition) {
    throw new HttpsError(code, message);
  }
}

function buildBaseUrl() {
  const base = String(process.env.INVITE_BASE_URL || '').trim();
  if (base) return base.replace(/\/+$/, '');
  const projectId = String(process.env.GCLOUD_PROJECT || '').trim();
  return projectId ? `https://${projectId}.web.app` : '';
}

function getInviterName(household, auth) {
  const uid = auth?.uid || '';
  const users = Array.isArray(household?.householdUsers)
    ? household.householdUsers
    : [];
  const match = users.find((u) => u && u.authUid === uid);
  if (match?.name) return String(match.name).trim();
  const memberInfo = household?.memberInfo || {};
  const info = memberInfo[uid];
  if (info?.name) return String(info.name).trim();
  const fallback = auth?.token?.name || auth?.token?.email || 'Superadmin';
  return String(fallback).trim() || 'Superadmin';
}

function buildInviteEmail({
  inviteeName,
  inviteeEmail,
  inviterName,
  inviteLink,
  logoUrl,
}) {
  const safeName = escapeHtml(inviteeName || inviteeEmail || 'Usuario');
  const safeInviter = escapeHtml(inviterName || 'Superadmin');
  const safeLink = escapeHtml(inviteLink || '');
  const safeLogo = escapeHtml(logoUrl || '');

  const subject = 'Invitacion a Finanzas en Familia';
  const text = [
    `Hola ${safeName},`,
    '',
    `${safeInviter} te invita a colaborar en "Finanzas en Familia".`,
    '',
    `Acepta la invitacion aqui: ${safeLink}`,
    '',
    'Por seguridad, cada persona debe usar su propia cuenta.',
    'No compartas tu contrasena.',
    '',
    'Cuando entres a la app, selecciona tu nombre para registrar tus movimientos.',
    '',
    'Si no esperabas esta invitacion, ignora este correo.',
  ].join('\n');

  const html = `
<div style="font-family: Arial, sans-serif; color: #111; line-height: 1.4;">
  <div style="margin-bottom: 16px;">
    <img src="${safeLogo}" alt="Finanzas en Familia" style="height: 48px;" />
  </div>
  <h2 style="margin: 0 0 12px 0;">Finanzas en Familia</h2>
  <p>Hola ${safeName},</p>
  <p><strong>${safeInviter}</strong> te invita a colaborar en "Finanzas en Familia".</p>
  <p>
    <a href="${safeLink}" style="display: inline-block; background: #1d4ed8; color: #fff; padding: 10px 16px; text-decoration: none; border-radius: 6px;">
      Aceptar invitacion
    </a>
  </p>
  <p style="font-size: 12px; color: #555;">
    Por seguridad, cada persona debe usar su propia cuenta. No compartas tu contrasena.
  </p>
  <p style="font-size: 12px; color: #555;">
    Cuando entres a la app, selecciona tu nombre para registrar tus movimientos.
  </p>
  <p style="font-size: 12px; color: #777;">
    Si no esperabas esta invitacion, ignora este correo.
  </p>
</div>
`;

  return { subject, text, html };
}

function buildCancellationEmail({ name, logoUrl }) {
  const safeName = escapeHtml(name || 'Usuario');
  const safeLogo = escapeHtml(logoUrl || '');
  const subject = 'Cuenta cancelada por inactividad';
  const text = [
    `Hola ${safeName},`,
    '',
    'Tu proyecto en Finanzas en Familia fue eliminado por inactividad de mas de 2 meses.',
    'El pago se cancelo por no uso de la plataforma.',
    '',
    'Si necesitas reactivar el servicio, contacta al soporte.',
  ].join('\n');

  const html = `
<div style="font-family: Arial, sans-serif; color: #111; line-height: 1.4;">
  <div style="margin-bottom: 16px;">
    <img src="${safeLogo}" alt="Finanzas en Familia" style="height: 48px;" />
  </div>
  <h2 style="margin: 0 0 12px 0;">Finanzas en Familia</h2>
  <p>Hola ${safeName},</p>
  <p>Tu proyecto fue eliminado por inactividad de mas de 2 meses.</p>
  <p><strong>El pago se cancelo por no uso de la plataforma.</strong></p>
  <p>Si necesitas reactivar el servicio, contacta al soporte.</p>
</div>
`;

  return { subject, text, html };
}

async function sendEmail(to, message) {
  if (!to) return;
  await db.collection(EMAIL_COLLECTION).add({
    to,
    message,
  });
}

exports.createInvite = onCall(async (request) => {
  const { auth, data } = request;
  assert(auth, 'unauthenticated', 'Debes iniciar sesion.');

  const householdId = String(data?.householdId || '').trim();
  const name = String(data?.name || '').trim();
  const email = String(data?.email || '').trim();
  const emailLower = normalizeEmail(email);

  assert(householdId, 'invalid-argument', 'Falta householdId.');
  assert(name, 'invalid-argument', 'Falta nombre.');
  assert(emailLower.includes('@'), 'invalid-argument', 'Email invalido.');

  const hhRef = db.doc(`households/${householdId}`);
  const hhSnap = await hhRef.get();
  assert(hhSnap.exists, 'not-found', 'Hogar no encontrado.');

  const household = hhSnap.data() || {};
  const members = Array.isArray(household.members) ? household.members : [];
  assert(members.includes(auth.uid), 'permission-denied', 'No eres miembro.');

  let ownerUid = household.ownerUid || null;
  if (!ownerUid) {
    if (members.length === 1 && members[0] === auth.uid) {
      await hhRef.update({ ownerUid: auth.uid });
      ownerUid = auth.uid;
    } else {
      throw new HttpsError(
        'failed-precondition',
        'ownerUid no configurado en el hogar.',
      );
    }
  }

  if (ownerUid !== auth.uid) {
    throw new HttpsError('permission-denied', 'Solo el superadmin puede invitar.');
  }

  const existingInvite = await hhRef
    .collection('invites')
    .where('emailLower', '==', emailLower)
    .where('status', '==', 'pending')
    .limit(1)
    .get();

  if (!existingInvite.empty) {
    throw new HttpsError(
      'already-exists',
      'Ya existe una invitacion pendiente para ese email.',
    );
  }

  const token = crypto.randomBytes(32).toString('hex');
  const inviterName = getInviterName(household, auth);
  const baseUrl = buildBaseUrl();
  assert(baseUrl, 'failed-precondition', 'No hay base URL configurada.');

  const inviteLink = `${baseUrl}/invite?token=${token}&hid=${encodeURIComponent(
    householdId,
  )}`;
  const logoUrl = `${baseUrl}/logo-finanzas-en-familia.png`;

  await hhRef.collection('invites').doc(token).set({
    householdId,
    name,
    email,
    emailLower,
    invitedByUid: auth.uid,
    invitedByName: inviterName,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromDate(
      new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000),
    ),
    status: 'pending',
  });

  const { subject, text, html } = buildInviteEmail({
    inviteeName: name,
    inviteeEmail: email,
    inviterName,
    inviteLink,
    logoUrl,
  });

  await sendEmail(email, { subject, text, html });

  return { ok: true, inviteLink };
});

exports.listInvites = onCall(async (request) => {
  const { auth, data } = request;
  assert(auth, 'unauthenticated', 'Debes iniciar sesion.');

  const householdId = String(data?.householdId || '').trim();
  assert(householdId, 'invalid-argument', 'Falta householdId.');

  const hhRef = db.doc(`households/${householdId}`);
  const hhSnap = await hhRef.get();
  assert(hhSnap.exists, 'not-found', 'Hogar no encontrado.');

  const household = hhSnap.data() || {};
  const members = Array.isArray(household.members) ? household.members : [];
  assert(members.includes(auth.uid), 'permission-denied', 'No eres miembro.');
  assert(
    household.ownerUid === auth.uid,
    'permission-denied',
    'Solo el superadmin puede ver invitaciones.',
  );

  const invitesSnap = await hhRef
    .collection('invites')
    .where('status', '==', 'pending')
    .limit(100)
    .get();

  const invites = invitesSnap.docs.map((docSnap) => {
    const d = docSnap.data() || {};
    return {
      token: docSnap.id,
      name: d.name || '',
      email: d.email || '',
      status: d.status || 'pending',
      createdAtMs: d.createdAt?.toMillis ? d.createdAt.toMillis() : null,
      expiresAtMs: d.expiresAt?.toMillis ? d.expiresAt.toMillis() : null,
      invitedByName: d.invitedByName || '',
    };
  });

  return { invites };
});

exports.resendInvite = onCall(async (request) => {
  const { auth, data } = request;
  assert(auth, 'unauthenticated', 'Debes iniciar sesion.');

  const householdId = String(data?.householdId || '').trim();
  const token = String(data?.token || '').trim();
  assert(householdId, 'invalid-argument', 'Falta householdId.');
  assert(token, 'invalid-argument', 'Falta token.');

  const hhRef = db.doc(`households/${householdId}`);
  const hhSnap = await hhRef.get();
  assert(hhSnap.exists, 'not-found', 'Hogar no encontrado.');

  const household = hhSnap.data() || {};
  const members = Array.isArray(household.members) ? household.members : [];
  assert(members.includes(auth.uid), 'permission-denied', 'No eres miembro.');
  assert(
    household.ownerUid === auth.uid,
    'permission-denied',
    'Solo el superadmin puede reenviar.',
  );

  const inviteRef = hhRef.collection('invites').doc(token);
  const inviteSnap = await inviteRef.get();
  assert(inviteSnap.exists, 'not-found', 'Invitacion no encontrada.');

  const invite = inviteSnap.data() || {};
  if (String(invite.status || '') !== 'pending') {
    throw new HttpsError('failed-precondition', 'Invitacion no pendiente.');
  }

  const expiresAt = invite.expiresAt;
  if (expiresAt && expiresAt.toMillis && expiresAt.toMillis() < Date.now()) {
    throw new HttpsError('deadline-exceeded', 'La invitacion vencio.');
  }

  const baseUrl = buildBaseUrl();
  assert(baseUrl, 'failed-precondition', 'No hay base URL configurada.');
  const inviteLink = `${baseUrl}/invite?token=${token}&hid=${encodeURIComponent(
    householdId,
  )}`;
  const logoUrl = `${baseUrl}/logo-finanzas-en-familia.png`;
  const inviterName = getInviterName(household, auth);

  const { subject, text, html } = buildInviteEmail({
    inviteeName: invite.name,
    inviteeEmail: invite.email,
    inviterName,
    inviteLink,
    logoUrl,
  });

  await inviteRef.set(
    {
      resentAt: FieldValue.serverTimestamp(),
      resentByUid: auth.uid,
      resentByName: inviterName,
      resentCount: FieldValue.increment(1),
    },
    { merge: true },
  );

  await sendEmail(invite.email, { subject, text, html });

  return { ok: true };
});

exports.revokeInvite = onCall(async (request) => {
  const { auth, data } = request;
  assert(auth, 'unauthenticated', 'Debes iniciar sesion.');

  const householdId = String(data?.householdId || '').trim();
  const token = String(data?.token || '').trim();
  assert(householdId, 'invalid-argument', 'Falta householdId.');
  assert(token, 'invalid-argument', 'Falta token.');

  const hhRef = db.doc(`households/${householdId}`);
  const hhSnap = await hhRef.get();
  assert(hhSnap.exists, 'not-found', 'Hogar no encontrado.');

  const household = hhSnap.data() || {};
  const members = Array.isArray(household.members) ? household.members : [];
  assert(members.includes(auth.uid), 'permission-denied', 'No eres miembro.');
  assert(
    household.ownerUid === auth.uid,
    'permission-denied',
    'Solo el superadmin puede cancelar.',
  );

  const inviteRef = hhRef.collection('invites').doc(token);
  const inviteSnap = await inviteRef.get();
  assert(inviteSnap.exists, 'not-found', 'Invitacion no encontrada.');

  await inviteRef.set(
    {
      status: 'revoked',
      revokedAt: FieldValue.serverTimestamp(),
      revokedByUid: auth.uid,
    },
    { merge: true },
  );

  return { ok: true };
});

exports.acceptInvite = onCall(async (request) => {
  const { auth, data } = request;
  assert(auth, 'unauthenticated', 'Debes iniciar sesion.');

  const token = String(data?.token || '').trim();
  const householdId = String(data?.householdId || '').trim();
  assert(token, 'invalid-argument', 'Falta token.');
  assert(householdId, 'invalid-argument', 'Falta householdId.');

  const inviteRef = db.doc(`households/${householdId}/invites/${token}`);
  const inviteSnap = await inviteRef.get();
  assert(inviteSnap.exists, 'not-found', 'Invitacion no encontrada.');

  const invite = inviteSnap.data() || {};
  const inviteEmail = normalizeEmail(invite.email || invite.emailLower || '');
  const authEmail = normalizeEmail(auth.token?.email || '');
  assert(inviteEmail, 'failed-precondition', 'Invitacion sin email.');
  assert(authEmail, 'failed-precondition', 'Tu cuenta no tiene email.');
  assert(
    inviteEmail === authEmail,
    'permission-denied',
    'El email no coincide con la invitacion.',
  );

  const expiresAt = invite.expiresAt;
  if (expiresAt && expiresAt.toMillis && expiresAt.toMillis() < Date.now()) {
    throw new HttpsError('deadline-exceeded', 'La invitacion vencio.');
  }

  const status = String(invite.status || 'pending');
  if (status === 'accepted') {
    return { householdId, status };
  }

  const inviteeName = String(invite.name || auth.token?.name || authEmail).trim();

  await db.runTransaction(async (tx) => {
    const hhRef = db.doc(`households/${householdId}`);
    const hhSnap = await tx.get(hhRef);
    assert(hhSnap.exists, 'not-found', 'Hogar no encontrado.');
    const household = hhSnap.data() || {};

    const memberInfo = { ...(household.memberInfo || {}) };
    if (!memberInfo[auth.uid]) {
      memberInfo[auth.uid] = { name: inviteeName || 'Usuario' };
    }

    const users = Array.isArray(household.householdUsers)
      ? household.householdUsers
      : [];
    let nextUsers = users;
    let usersUpdated = false;

    const matchIndex = users.findIndex(
      (u) => normalizeEmail(u?.email || '') === inviteEmail,
    );
    if (matchIndex >= 0) {
      const existing = users[matchIndex] || {};
      const next = {
        ...existing,
        authUid: auth.uid,
        ...(existing.name ? {} : { name: inviteeName }),
        ...(existing.email ? {} : { email: invite.email || authEmail }),
      };
      nextUsers = users.slice();
      nextUsers[matchIndex] = next;
      usersUpdated = true;
    } else if (!users.some((u) => u?.authUid === auth.uid)) {
      nextUsers = users.concat([
        {
          id: auth.uid,
          name: inviteeName || 'Usuario',
          email: invite.email || authEmail,
          authUid: auth.uid,
        },
      ]);
      usersUpdated = true;
    }

    tx.update(hhRef, {
      members: FieldValue.arrayUnion(auth.uid),
      memberInfo,
      ...(usersUpdated ? { householdUsers: nextUsers } : {}),
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: auth.uid,
    });

    const profileRef = db.doc(`profiles/${auth.uid}`);
    tx.set(
      profileRef,
      {
        householdId,
        defaultHouseholdId: householdId,
        householdIds: FieldValue.arrayUnion(householdId),
        name: inviteeName || authEmail,
      },
      { merge: true },
    );

    tx.set(
      inviteRef,
      {
        status: 'accepted',
        acceptedAt: FieldValue.serverTimestamp(),
        acceptedByUid: auth.uid,
        acceptedByEmail: authEmail,
      },
      { merge: true },
    );
  });

  return { householdId, status: 'accepted' };
});

exports.cleanupInactiveHouseholds = onSchedule('every 24 hours', async () => {
  const cutoffMs = Date.now() - INACTIVITY_DAYS * 24 * 60 * 60 * 1000;
  const cutoff = Timestamp.fromDate(new Date(cutoffMs));
  const baseUrl = buildBaseUrl();
  const logoUrl = baseUrl ? `${baseUrl}/logo-finanzas-en-familia.png` : '';

  const snap = await db
    .collection('households')
    .where('lastActiveAt', '<', cutoff)
    .limit(50)
    .get();

  if (snap.empty) return;

  for (const docSnap of snap.docs) {
    const householdId = docSnap.id;
    const household = docSnap.data() || {};
    const members = Array.isArray(household.members) ? household.members : [];
    const users = Array.isArray(household.householdUsers)
      ? household.householdUsers
      : [];

    const emailMap = new Map();
    users.forEach((u) => {
      const email = normalizeEmail(u?.email || '');
      if (!email) return;
      const name = String(u?.name || '').trim() || email;
      if (!emailMap.has(email)) emailMap.set(email, name);
    });

    const emails = Array.from(emailMap.entries()).slice(
      0,
      ACTIVITY_SYNC_EMAIL_LIMIT,
    );
    for (const [email, name] of emails) {
      const { subject, text, html } = buildCancellationEmail({
        name,
        logoUrl,
      });
      await sendEmail(email, { subject, text, html });
    }

    for (const uid of members) {
      const profileRef = db.doc(`profiles/${uid}`);
      const profileSnap = await profileRef.get();
      if (profileSnap.exists) {
        const profile = profileSnap.data() || {};
        const ids = Array.isArray(profile.householdIds)
          ? profile.householdIds.filter(Boolean)
          : [];
        if (ids.length > 1) {
          const nextIds = ids.filter((id) => id !== householdId);
          const updates = {
            householdIds: nextIds,
          };
          if (profile.householdId === householdId) {
            updates.householdId = nextIds[0] || null;
          }
          if (profile.defaultHouseholdId === householdId) {
            updates.defaultHouseholdId = nextIds[0] || null;
          }
          await profileRef.set(updates, { merge: true });
          continue;
        }
        await profileRef.delete().catch(() => {});
      }

      await authAdmin.deleteUser(uid).catch(() => {});
    }

    await db.recursiveDelete(docSnap.ref).catch(() => {});
  }
});
