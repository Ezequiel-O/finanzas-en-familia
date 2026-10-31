// src/modules/settings/Settings.jsx
import { DangerZone } from '../../features/settings/DangerZone.jsx';
import { AuditLogPanel } from '../../features/settings/AuditLogPanel.jsx';
import { toast, confirmDialog } from '../../components/feedback/feedback.js';
import { toLocalDateKey } from '../../domain/dates.js';
import React, { useState, useEffect } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  setDoc,
  serverTimestamp,
  Timestamp,
  updateDoc,
} from 'firebase/firestore';
import {
  createUserWithEmailAndPassword,
  deleteUser,
  signOut,
} from 'firebase/auth';

import { Card } from '../../components/ui/Card.jsx';
import { SectionTitle } from '../../components/ui/SectionTitle.jsx';
import { CATEGORIES, DEBT_CATEGORY, SAVINGS_CATEGORY } from '../../constants.js';
import { dueDayKey, isPriorityCategory } from '../../domain/paymentPlan.js';
import { auth, db, secondaryAuth, secondaryDb } from '../../firebase';
import {
  buildInviteLink,
  generateInviteToken,
  hashInviteToken,
} from '../../lib/invites.js';

const INVITE_TTL_MINUTES = 10;
const INVITE_TTL_MS = INVITE_TTL_MINUTES * 60 * 1000;
const LAST_INVITE_LINK_KEY = 'fef:lastInviteLink';
const LAST_ACCESS_MESSAGE_KEY = 'fef:lastAccessMessage';
const TEMP_LOGIN_PREFIX = 'usuario';
const TEMP_LOGIN_DOMAIN = 'finanzasenfamilia.com';
const TEMP_PASSWORD_LENGTH = 10;

// Día del mes (1-31) en que vence un gasto fijo; se guarda al salir del campo.
function DueDayInput({ value, label, placeholder = '—', onSave }) {
  return (
    <input
      key={String(value || '')}
      type="number"
      inputMode="numeric"
      min={1}
      max={31}
      step={1}
      defaultValue={value || ''}
      placeholder={placeholder}
      aria-label={label}
      className="w-14 rounded border px-1 py-0.5 text-xs"
      onBlur={(e) => {
        const next = e.target.value.trim();
        if (next === String(value || '')) return;
        onSave(next);
      }}
    />
  );
}

export function Settings({
  data,
  householdId,
  user,
  categories,
  actions,
  activeHouseholdUser,
}) {
  const [newCategory, setNewCategory] = useState('');
  const [showUserModal, setShowUserModal] = useState(false);
  const [userForm, setUserForm] = useState({
    id: null,
    name: '',
  });
  const [inviteStatus, setInviteStatus] = useState('idle');
  const [inviteError, setInviteError] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [accessData, setAccessData] = useState(null);
  const [lastAccessMessage, setLastAccessMessage] = useState('');
  const [lastInviteLink, setLastInviteLink] = useState('');
  const [showInviteInspector, setShowInviteInspector] = useState(false);
  const [inviteInspectorLoading, setInviteInspectorLoading] = useState(false);
  const [inviteInspectorError, setInviteInspectorError] = useState('');
  const [inviteInspectorData, setInviteInspectorData] = useState(null);
  const [pendingInvites, setPendingInvites] = useState([]);
  const [invitesLoading, setInvitesLoading] = useState(false);
  const [invitesError, setInvitesError] = useState('');
  const [inviteActionId, setInviteActionId] = useState('');
  const [joinRequests, setJoinRequests] = useState([]);
  const [joinRequestsLoading, setJoinRequestsLoading] = useState(false);
  const [joinRequestsError, setJoinRequestsError] = useState('');
  const [joinActionUid, setJoinActionUid] = useState('');

  const cats = categories && categories.length ? categories : CATEGORIES;
  const users = Array.isArray(data.householdUsers) ? data.householdUsers : [];
  const memberInfo =
    data.memberInfo && typeof data.memberInfo === 'object'
      ? data.memberInfo
      : {};
  const fixedCategories = data.fixedCategories || {};
  const priorityCategories = data.priorityCategories || {};
  const fixedDueDays = data.fixedDueDays || {};
  const editableCats = cats.filter(
    (c) => c !== SAVINGS_CATEGORY && c !== DEBT_CATEGORY,
  );
  const fixedCats = editableCats.filter((c) => !!fixedCategories[c]);
  const variableCats = editableCats.filter((c) => !fixedCategories[c]);
  const editingUser = userForm.id
    ? users.find((u) => u.id === userForm.id) || null
    : null;
  const ownerUid = data.ownerUid || null;
  const isOwner = !!ownerUid && user?.uid === ownerUid;
  const isInviting = inviteStatus === 'sending';
  const canInvite = isOwner && !!householdId;
  const isEditingUser = !!userForm.id;
  const showJoinRequests =
    canInvite &&
    (joinRequestsLoading || joinRequestsError || joinRequests.length > 0);
  const accessMessageToCopy = accessData?.message || lastAccessMessage || '';
  const sortedUsers = [...users].sort((a, b) => {
    const aUid = a?.authUid || a?.id || '';
    const bUid = b?.authUid || b?.id || '';
    const aIsOwner = !!ownerUid && aUid === ownerUid;
    const bIsOwner = !!ownerUid && bUid === ownerUid;
    if (aIsOwner !== bIsOwner) return aIsOwner ? -1 : 1;
    return 0;
  });

  function normalizeEmail(value) {
    return String(value || '')
      .trim()
      .toLowerCase();
  }

  function extractLoginEmail(message) {
    const match = String(message || '').match(/Usuario:\s*([^\s]+)/i);
    return match ? normalizeEmail(match[1]) : '';
  }

  function getInviteLinkStorageKey() {
    return householdId
      ? `${LAST_INVITE_LINK_KEY}:${householdId}`
      : LAST_INVITE_LINK_KEY;
  }

  function getAccessMessageStorageKey() {
    return householdId
      ? `${LAST_ACCESS_MESSAGE_KEY}:${householdId}`
      : LAST_ACCESS_MESSAGE_KEY;
  }

  function persistInviteLink(link) {
    if (!link || typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(getInviteLinkStorageKey(), link);
      setLastInviteLink(link);
    } catch (err) {
      console.warn('No se pudo guardar el enlace de invitación:', err);
    }
  }

  function persistAccessMessage(message) {
    if (!message || typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(getAccessMessageStorageKey(), message);
      setLastAccessMessage(message);
    } catch (err) {
      console.warn('No se pudo guardar la invitacion:', err);
    }
  }

  function clearAccessMessage() {
    setAccessData(null);
    setLastAccessMessage('');
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(getAccessMessageStorageKey());
    } catch (err) {
      console.warn('No se pudo eliminar la invitacion:', err);
    }
  }

  function readStoredInviteLink() {
    if (typeof window === 'undefined') return '';
    try {
      return window.localStorage.getItem(getInviteLinkStorageKey()) || '';
    } catch (err) {
      console.warn('No se pudo leer el enlace guardado:', err);
      return '';
    }
  }

  function readStoredAccessMessage() {
    if (typeof window === 'undefined') return '';
    try {
      return window.localStorage.getItem(getAccessMessageStorageKey()) || '';
    } catch (err) {
      console.warn('No se pudo leer la invitacion guardada:', err);
      return '';
    }
  }

  function parseInviteLink(link) {
    if (!link) return null;
    try {
      const base = typeof window !== 'undefined' ? window.location.origin : '';
      const url = new URL(link, base || undefined);
      const params = url.searchParams;
      return {
        householdId: params.get('hid') || '',
        inviteId: params.get('invite') || '',
        token: params.get('token') || '',
        invitedBy: params.get('by') || '',
        url: url.toString(),
      };
    } catch {
      return null;
    }
  }

  function randomString(length, alphabet) {
    const chars = alphabet || 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < length; i += 1) {
      out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
  }

  function shuffleArray(list) {
    const arr = [...list];
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function slugifyName(value) {
    const raw = String(value || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    const stripped = raw.replace(/[^a-z0-9]/g, '');
    return stripped || TEMP_LOGIN_PREFIX;
  }

  function generateLoginId(displayNameValue) {
    const base = slugifyName(displayNameValue).slice(0, 12);
    return `${base}.${randomString(5)}`;
  }

  function generateTempPassword() {
    const lower = randomString(2, 'abcdefghijkmnopqrstuvwxyz');
    const upper = randomString(2, 'ABCDEFGHJKLMNPQRSTUVWXYZ');
    const number = randomString(2, '0123456789');
    const symbol = randomString(2, '!@#$%*?');
    const remaining = Math.max(
      0,
      TEMP_PASSWORD_LENGTH -
        (lower.length + upper.length + number.length + symbol.length),
    );
    const extra = remaining
      ? randomString(
          remaining,
          'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ0123456789',
        )
      : '';
    const chars = shuffleArray(
      `${lower}${upper}${number}${symbol}${extra}`.split(''),
    );
    return chars.join('');
  }

  function buildAccessMessage({ loginEmail, tempPassword }) {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return [
      'Tienes acceso a Finanzas en Familia.',
      `Usuario: ${loginEmail}`,
      `Clave temporal: ${tempPassword}`,
      origin ? `Ingresa en: ${origin}` : '',
      'Al entrar debes cambiar tu contrasena para continuar.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  function formatDate(ms) {
    if (!ms) return '';
    return toLocalDateKey(new Date(ms));
  }

  function matchLabel(value) {
    if (value === null || value === undefined) return 'No disponible';
    return value ? 'Si' : 'No';
  }

  function displayName(u) {
    if (u.name && u.name.trim()) return u.name.trim();
    if (u.email && u.email.trim()) return u.email.trim();
    return 'Usuario';
  }

  function getUserEmail(u) {
    const authId = String(u?.authUid || u?.id || '').trim();
    const info = authId ? memberInfo[authId] || {} : {};
    const emailFromInfo = String(info.email || '').trim();
    return String(u?.email || '').trim() || emailFromInfo || '';
  }

  function getMemberName(u) {
    const authId = String(u?.authUid || u?.id || '').trim();
    const info = authId ? memberInfo[authId] || {} : {};
    const memberName = String(info.name || '').trim();
    return memberName || String(u?.name || '').trim() || '';
  }

  async function addAuthUserToHousehold({ uid, name, email, username }) {
    if (!householdId) throw new Error('Hogar no cargado.');
    const householdRef = doc(db, 'households', householdId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(householdRef);
      if (!snap.exists()) throw new Error('Hogar no encontrado.');
      const data = snap.data() || {};
      const members = Array.isArray(data.members) ? [...data.members] : [];
      if (!members.includes(uid)) members.push(uid);

      const memberInfo = { ...(data.memberInfo || {}) };
      const info = { name };
      if (email) info.email = email;
      if (username) info.username = username;
      memberInfo[uid] = info;

      const baseUsers = Array.isArray(data.householdUsers)
        ? data.householdUsers
        : [];
      const exists = baseUsers.some((u) => u.authUid === uid || u.id === uid);
      const nextUsers = exists
        ? baseUsers.map((u) =>
            u.authUid === uid || u.id === uid
              ? { ...u, name, email, authUid: uid }
              : u,
          )
        : [
            ...baseUsers,
            {
              id: uid,
              name,
              email,
              authUid: uid,
              preferences: {},
              tempAccessActive: true,
              tempAccessCreatedAtMs: Date.now(),
            },
          ];

      tx.update(householdRef, {
        members,
        memberInfo,
        householdUsers: nextUsers,
        updatedAt: serverTimestamp(),
        updatedBy: user?.uid || '',
      });
    });
  }

  async function createTemporaryAccess(displayNameValue) {
    const trimmedName = String(displayNameValue || '').trim() || 'Usuario';
    const maxAttempts = 5;
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const loginId = generateLoginId(trimmedName);
      const loginEmail = `${loginId}@${TEMP_LOGIN_DOMAIN}`;
      const tempPassword = generateTempPassword();
      let createdUser = null;
      try {
        const cred = await createUserWithEmailAndPassword(
          secondaryAuth,
          loginEmail,
          tempPassword,
        );
        createdUser = cred.user;
        const uid = createdUser.uid;

        await setDoc(
          doc(secondaryDb, 'profiles', uid),
          {
            name: trimmedName,
            email: loginEmail,
            username: loginId,
            householdId,
            defaultHouseholdId: householdId,
            mustChangePassword: true,
            createdAtMs: Date.now(),
          },
          { merge: true },
        );

        await addAuthUserToHousehold({
          uid,
          name: trimmedName,
          email: loginEmail,
          username: loginId,
        });

        const message = buildAccessMessage({
          loginEmail,
          tempPassword,
        });

        return {
          loginId,
          loginEmail,
          tempPassword,
          message,
        };
      } catch (err) {
        const code = String(err?.code || '');
        if (createdUser) {
          try {
            await deleteUser(createdUser);
          } catch (cleanupErr) {
            console.warn('No se pudo limpiar el usuario temporal:', cleanupErr);
          }
        }
        if (code.includes('email-already-in-use')) {
          lastError = err;
          continue;
        }
        throw err;
      } finally {
        if (secondaryAuth.currentUser) {
          try {
            await signOut(secondaryAuth);
          } catch (signOutErr) {
            console.warn('No se pudo cerrar sesion secundaria:', signOutErr);
          }
        }
      }
    }
    throw lastError || new Error('No se pudo generar un usuario unico.');
  }

  async function openInviteInspector() {
    setShowInviteInspector(true);
    setInviteInspectorError('');
    setInviteInspectorData(null);

    const link = inviteLink || lastInviteLink;
    if (!link) {
      setInviteInspectorError(
        'No hay enlace guardado. Genera una invitación nueva.',
      );
      return;
    }

    const parsed = parseInviteLink(link);
    if (!parsed || !parsed.inviteId || !parsed.token) {
      setInviteInspectorError('El enlace no tiene datos válidos.');
      return;
    }

    setInviteInspectorLoading(true);
    try {
      const tokenHashFromLink = await hashInviteToken(parsed.token);
      let inviteDoc = null;
      let source = '';
      if (householdId && parsed.inviteId) {
        const inviteRef = doc(
          db,
          'households',
          householdId,
          'invites',
          parsed.inviteId,
        );
        const inviteSnap = await getDoc(inviteRef);
        if (inviteSnap.exists()) {
          inviteDoc = { id: inviteSnap.id, ...(inviteSnap.data() || {}) };
          source = 'id';
        }
      }

      if (!inviteDoc && householdId) {
        const q = query(
          collection(db, 'households', householdId, 'invites'),
          orderBy('createdAtMs', 'desc'),
          limit(10),
        );
        const snap = await getDocs(q);
        const list = snap.docs.map((docSnap) => ({
          id: docSnap.id,
          ...(docSnap.data() || {}),
        }));
        const pending = list.find((item) => item.status === 'pending');
        if (pending) {
          inviteDoc = pending;
          source = 'latest-pending';
        } else if (list.length > 0) {
          inviteDoc = list[0];
          source = 'latest';
        }
      }

      const inviteStatus = inviteDoc?.status || '';
      const inviteTokenHash = inviteDoc?.tokenHash || '';
      const inviteExpiresAtMs =
        inviteDoc?.expiresAtMs ||
        (inviteDoc?.expiresAt &&
        typeof inviteDoc.expiresAt.toMillis === 'function'
          ? inviteDoc.expiresAt.toMillis()
          : 0);
      const inviteCreatedAtMs = inviteDoc?.createdAtMs || 0;
      const isExpired = !!inviteExpiresAtMs && inviteExpiresAtMs <= Date.now();
      const householdMatch =
        parsed.householdId && householdId
          ? parsed.householdId === householdId
          : null;
      const inviteIdMatch = inviteDoc?.id
        ? parsed.inviteId === inviteDoc.id
        : null;
      const tokenHashMatch = inviteTokenHash
        ? tokenHashFromLink === inviteTokenHash
        : null;

      setInviteInspectorData({
        link,
        parsed,
        tokenHashFromLink,
        invite: inviteDoc
          ? {
              id: inviteDoc.id,
              status: inviteStatus,
              tokenHash: inviteTokenHash,
              expiresAtMs: inviteExpiresAtMs,
              createdAtMs: inviteCreatedAtMs,
              inviteeName: inviteDoc.inviteeName || '',
              inviteeEmail: inviteDoc.inviteeEmail || '',
            }
          : null,
        source,
        compare: {
          householdMatch,
          inviteIdMatch,
          tokenHashMatch,
          isExpired,
        },
      });
    } catch (err) {
      console.error('Error revisando enlace:', err);
      setInviteInspectorError('No se pudo revisar el enlace.');
    } finally {
      setInviteInspectorLoading(false);
    }
  }

  async function createInviteRecord({ name, email }) {
    if (!user?.uid) throw new Error('Usuario no autenticado.');
    const safeEmail = String(email || '').trim();
    const emailLower = safeEmail ? normalizeEmail(safeEmail) : '';
    const token = generateInviteToken();
    const tokenHash = await hashInviteToken(token);
    const createdAtMs = Date.now();
    const expiresAtMs = createdAtMs + INVITE_TTL_MS;
    const inviteRef = await addDoc(
      collection(db, 'households', householdId, 'invites'),
      {
        inviteeName: name,
        inviteeEmail: safeEmail,
        inviteeEmailLower: emailLower,
        tokenHash,
        status: 'pending',
        createdAtMs,
        createdAt: serverTimestamp(),
        expiresAtMs,
        expiresAt: Timestamp.fromMillis(expiresAtMs),
        createdByUid: user.uid,
      },
    );
    return {
      inviteId: inviteRef.id,
      link: buildInviteLink({
        householdId,
        inviteId: inviteRef.id,
        token,
        invitedBy: user?.email || '',
      }),
      expiresAtMs,
    };
  }

  async function cleanupOldInvites() {
    if (!canInvite || !householdId) return;
    try {
      const q = query(
        collection(db, 'households', householdId, 'invites'),
        orderBy('createdAtMs', 'desc'),
      );
      const snap = await getDocs(q);
      const now = Date.now();
      const toDelete = snap.docs.filter((docSnap) => {
        const data = docSnap.data() || {};
        const status = data.status || 'pending';
        const tokenHash = data.tokenHash || '';
        const expiresAtMs =
          data.expiresAtMs ||
          (data.expiresAt && typeof data.expiresAt.toMillis === 'function'
            ? data.expiresAt.toMillis()
            : 0);
        const expired = !!expiresAtMs && expiresAtMs <= now;
        const invalidSchema = !tokenHash || !expiresAtMs;
        return status !== 'pending' || expired || invalidSchema;
      });

      if (!toDelete.length) return;
      await Promise.allSettled(
        toDelete.map((docSnap) => deleteDoc(docSnap.ref)),
      );
      await loadInvites();
    } catch (err) {
      console.error('Error limpiando invitaciones:', err);
      setInvitesError('No se pudieron limpiar invitaciones antiguas.');
    }
  }

  async function startCreateUser() {
    await cleanupOldInvites();
    setUserForm({
      id: null,
      name: '',
    });
    setInviteStatus('idle');
    setInviteError('');
    setInviteLink('');
    setAccessData(null);
    setShowUserModal(true);
  }

  function startEditUser(u) {
    setUserForm({
      id: u.id,
      name: getMemberName(u) || getUserEmail(u) || u.name || '',
    });
    setInviteStatus('idle');
    setInviteError('');
    setInviteLink('');
    setAccessData(null);
    setShowUserModal(true);
  }

  async function loadInvites() {
    if (!canInvite) {
      setPendingInvites([]);
      return;
    }
    setInvitesLoading(true);
    setInvitesError('');
    try {
      const q = query(
        collection(db, 'households', householdId, 'invites'),
        orderBy('createdAtMs', 'desc'),
      );
      const snap = await getDocs(q);
      const list = snap.docs.map((docSnap) => {
        const data = docSnap.data() || {};
        const expiresAtMs =
          data.expiresAtMs ||
          (data.expiresAt && typeof data.expiresAt.toMillis === 'function'
            ? data.expiresAt.toMillis()
            : 0);
        const tokenHash = data.tokenHash || '';
        const hasRequiredFields = !!tokenHash && !!expiresAtMs;
        return {
          id: docSnap.id,
          name: data.inviteeName || '',
          email: data.inviteeEmail || '',
          emailLower: data.inviteeEmailLower || '',
          status: data.status || 'pending',
          createdAtMs: data.createdAtMs || 0,
          expiresAtMs,
          hasRequiredFields,
        };
      });
      const now = Date.now();
      const pending = list
        .filter(
          (invite) => invite.status === 'pending' && invite.hasRequiredFields,
        )
        .map((invite) => ({
          ...invite,
          isExpired: !!invite.expiresAtMs && invite.expiresAtMs <= now,
        }));
      setPendingInvites(pending);
      const invalidPending = list.filter(
        (invite) => invite.status === 'pending' && !invite.hasRequiredFields,
      );
      if (invalidPending.length && user?.uid) {
        await Promise.allSettled(
          invalidPending.map((invite) =>
            updateDoc(
              doc(db, 'households', householdId, 'invites', invite.id),
              {
                status: 'revoked',
                revokedAtMs: Date.now(),
                revokedByUid: user.uid,
                revokeReason: 'invalid-schema',
              },
            ),
          ),
        );
        setInvitesError(
          'Se encontraron invitaciones antiguas sin datos. Se cancelaron automáticamente. Genera un nuevo enlace.',
        );
      }
    } catch (err) {
      console.error('Error cargando invitaciones:', err);
      setInvitesError('No se pudieron cargar las invitaciones.');
      setPendingInvites([]);
    } finally {
      setInvitesLoading(false);
    }
  }

  async function handleRevokeInvite(invite) {
    if (!invite?.id || !householdId) return;
    const ok = await confirmDialog('Cancelar esta invitacion?');
    if (!ok) return;
    setInviteActionId(invite.id);
    setInvitesError('');
    try {
      await updateDoc(
        doc(db, 'households', householdId, 'invites', invite.id),
        {
          status: 'revoked',
          revokedAtMs: Date.now(),
          revokedByUid: user?.uid || '',
        },
      );
      await loadInvites();
    } catch (err) {
      console.error('Error cancelando invitacion:', err);
      setInvitesError('No se pudo cancelar la invitacion.');
    } finally {
      setInviteActionId('');
    }
  }

  async function handleRegenerateInvite(invite) {
    if (!householdId) return;
    setInviteActionId(invite.id || '');
    setInvitesError('');
    try {
      const created = await createInviteRecord({
        name: invite.name || '',
        email: invite.email || '',
      });
      if (invite?.id) {
        await updateDoc(
          doc(db, 'households', householdId, 'invites', invite.id),
          {
            status: 'revoked',
            revokedAtMs: Date.now(),
            revokedByUid: user?.uid || '',
          },
        );
      }
      setInviteLink(created.link);
      persistInviteLink(created.link);
      setInviteStatus('sent');
      await loadInvites();
    } catch (err) {
      console.error('Error regenerando invitacion:', err);
      setInvitesError('No se pudo generar un nuevo enlace.');
    } finally {
      setInviteActionId('');
    }
  }

  async function loadJoinRequests() {
    if (!canInvite) {
      setJoinRequests([]);
      return;
    }
    setJoinRequestsLoading(true);
    setJoinRequestsError('');
    try {
      const q = query(
        collection(db, 'households', householdId, 'joinRequests'),
        orderBy('createdAtMs', 'desc'),
      );
      const snap = await getDocs(q);
      const list = snap.docs.map((docSnap) => {
        const data = docSnap.data() || {};
        return {
          id: docSnap.id,
          uid: data.uid || docSnap.id,
          inviteId: data.inviteId || '',
          status: data.status || 'pending',
          createdAtMs: data.createdAtMs || 0,
          displayName: data.displayName || '',
          email: data.email || '',
          emailLower: data.emailLower || '',
        };
      });
      setJoinRequests(list.filter((req) => req.status === 'pending'));
    } catch (err) {
      console.error('Error cargando solicitudes:', err);
      setJoinRequestsError('No se pudieron cargar las solicitudes.');
      setJoinRequests([]);
    } finally {
      setJoinRequestsLoading(false);
    }
  }

  function attachAuthUidToUsers(base, req) {
    const targetEmail = normalizeEmail(req.email || req.emailLower);
    let matched = false;
    const next = base.map((u) => {
      if (u?.authUid) return u;
      const userEmail = normalizeEmail(u?.email);
      if (targetEmail && userEmail && targetEmail === userEmail) {
        matched = true;
        return {
          ...u,
          authUid: req.uid,
          email: u.email || req.email || '',
          name: u.name || req.displayName || req.email || 'Usuario',
        };
      }
      return u;
    });
    if (!matched) {
      next.push({
        id: req.uid || Math.random().toString(36).slice(2, 10),
        name: req.displayName || req.email || 'Usuario',
        email: req.email || '',
        authUid: req.uid,
      });
    }
    return next;
  }

  async function handleApproveJoinRequest(request) {
    if (!request?.uid || !householdId) return;
    const ok = await confirmDialog(
      `Aprobar ingreso de "${request.displayName || request.email || 'usuario'}"?`,
    );
    if (!ok) return;
    setJoinActionUid(request.uid);
    setJoinRequestsError('');
    try {
      const householdRef = doc(db, 'households', householdId);
      const requestRef = doc(
        db,
        'households',
        householdId,
        'joinRequests',
        request.uid,
      );
      const inviteRef = request.inviteId
        ? doc(db, 'households', householdId, 'invites', request.inviteId)
        : null;

      await runTransaction(db, async (tx) => {
        const snap = await tx.get(householdRef);
        let inviteSnap = null;
        if (inviteRef) {
          inviteSnap = await tx.get(inviteRef);
        }
        if (!snap.exists()) throw new Error('Hogar no encontrado.');
        const data = snap.data() || {};
        const members = Array.isArray(data.members) ? [...data.members] : [];
        const ownerId = data.ownerUid || user?.uid || '';
        if (ownerId && !members.includes(ownerId)) members.push(ownerId);
        if (!members.includes(request.uid)) members.push(request.uid);

        const memberInfo = { ...(data.memberInfo || {}) };
        if (ownerId && !memberInfo[ownerId]) {
          const ownerName =
            user?.displayName || user?.email || memberInfo?.[ownerId]?.name;
          const ownerInfo = {
            name: ownerName || 'Usuario',
          };
          if (user?.email) ownerInfo.email = user.email;
          memberInfo[ownerId] = ownerInfo;
        }
        const name = request.displayName || request.email || 'Usuario';
        const info = { name };
        if (request.email) info.email = request.email;
        memberInfo[request.uid] = info;

        const baseUsers = Array.isArray(data.householdUsers)
          ? data.householdUsers
          : [];
        const nextUsers = attachAuthUidToUsers(baseUsers, request);

        tx.update(householdRef, {
          members,
          memberInfo,
          householdUsers: nextUsers,
          updatedAt: serverTimestamp(),
          updatedBy: user?.uid || '',
        });

        tx.update(requestRef, {
          status: 'accepted',
          reviewedAtMs: Date.now(),
          reviewedByUid: user?.uid || '',
        });

        if (inviteRef) {
          if (inviteSnap && inviteSnap.exists()) {
            tx.update(inviteRef, {
              status: 'accepted',
              acceptedAtMs: Date.now(),
              acceptedByUid: user?.uid || '',
            });
          }
        }
      });

      await loadJoinRequests();
      await loadInvites();
    } catch (err) {
      console.error('Error aprobando solicitud:', err);
      const code = String(err?.code || '');
      if (code.includes('permission-denied')) {
        setJoinRequestsError('No tienes permisos o faltan reglas desplegadas.');
      } else if (code.includes('not-found')) {
        setJoinRequestsError('La solicitud ya no existe.');
      } else {
        setJoinRequestsError('No se pudo aprobar la solicitud.');
      }
    } finally {
      setJoinActionUid('');
    }
  }

  async function handleRejectJoinRequest(request) {
    if (!request?.uid || !householdId) return;
    const ok = await confirmDialog('Rechazar esta solicitud?');
    if (!ok) return;
    setJoinActionUid(request.uid);
    setJoinRequestsError('');
    try {
      await updateDoc(
        doc(db, 'households', householdId, 'joinRequests', request.uid),
        {
          status: 'rejected',
          reviewedAtMs: Date.now(),
          reviewedByUid: user?.uid || '',
        },
      );
      await loadJoinRequests();
    } catch (err) {
      console.error('Error rechazando solicitud:', err);
      const code = String(err?.code || '');
      if (code.includes('permission-denied')) {
        setJoinRequestsError('No tienes permisos o faltan reglas desplegadas.');
      } else if (code.includes('not-found')) {
        setJoinRequestsError('La solicitud ya no existe.');
      } else {
        setJoinRequestsError('No se pudo rechazar la solicitud.');
      }
    } finally {
      setJoinActionUid('');
    }
  }

  async function handleLeaveHousehold(target) {
    if (!user?.uid || !householdId) return;
    if (!target?.authUid || target.authUid !== user.uid) return;
    if (ownerUid && user.uid === ownerUid) {
      toast.warning('El superadministrador no puede darse de baja.');
      return;
    }
    const ok = await confirmDialog(
      'Vas a darte de baja del presupuesto. Perderas acceso. Continuar?',
    );
    if (!ok) return;
    try {
      const householdRef = doc(db, 'households', householdId);
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(householdRef);
        if (!snap.exists()) throw new Error('Hogar no encontrado.');
        const data = snap.data() || {};
        const members = Array.isArray(data.members)
          ? data.members.filter((m) => m !== user.uid)
          : [];
        const memberInfo = { ...(data.memberInfo || {}) };
        delete memberInfo[user.uid];
        const baseUsers = Array.isArray(data.householdUsers)
          ? data.householdUsers
          : [];
        const nextUsers = baseUsers.filter(
          (u) => u.authUid !== user.uid && u.id !== user.uid,
        );
        tx.update(householdRef, {
          members,
          memberInfo,
          householdUsers: nextUsers,
          updatedAt: serverTimestamp(),
          updatedBy: user.uid,
        });
      });

      await setDoc(
        doc(db, 'profiles', user.uid),
        {
          householdId: null,
          defaultHouseholdId: null,
          inviteOnly: false,
        },
        { merge: true },
      );

      await signOut(auth);
    } catch (err) {
      console.error('Error dando de baja:', err);
      toast.error('No se pudo dar de baja. Intenta mas tarde.');
    }
  }

  async function handleSaveUser(e) {
    e.preventDefault();
    if (inviteStatus === 'sent') {
      setShowUserModal(false);
      setUserForm({
        id: null,
        name: '',
      });
      setInviteStatus('idle');
      setInviteError('');
      setInviteLink('');
      setAccessData(null);
      return;
    }
    const trimmedName = userForm.name.trim();
    if (!trimmedName) return;

    const isNew = !userForm.id;
    if (isNew) {
      if (!householdId) {
        setInviteError('Hogar no cargado.');
        return;
      }
      if (!isOwner) {
        setInviteError('Solo el superadministrador puede crear usuarios.');
        return;
      }

      setInviteStatus('sending');
      setInviteError('');
      setInviteLink('');
      setAccessData(null);

      try {
        const created = await createTemporaryAccess(trimmedName);
        setInviteStatus('sent');
        setAccessData(created);
        persistAccessMessage(created.message);
        return;
      } catch (err) {
        console.error('Error creando invitacion:', err);
        setInviteError('No se pudo crear el usuario temporal.');
        setInviteStatus('idle');
        return;
      }
    } else {
      const next = { name: trimmedName };
      await actions.updateHouseholdUser(userForm.id, next);
    }

    setShowUserModal(false);
    setUserForm({
      id: null,
      name: '',
    });
    setInviteLink('');
  }

  async function handleCopyInviteLink(value = inviteLink) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Texto copiado.');
    } catch {
      window.prompt('Copia este texto:', value);
    }
  }

  useEffect(() => {
    if (!householdId) {
      setLastInviteLink('');
      setLastAccessMessage('');
      return;
    }
    const stored = readStoredInviteLink();
    if (stored) setLastInviteLink(stored);
    const storedAccess = readStoredAccessMessage();
    if (storedAccess) setLastAccessMessage(storedAccess);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [householdId]);

  useEffect(() => {
    if (!canInvite || !householdId) {
      setPendingInvites([]);
      setJoinRequests([]);
      return;
    }
    loadInvites();
    loadJoinRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canInvite, householdId]);

  useEffect(() => {
    if (!accessMessageToCopy) return;
    const loginEmail = extractLoginEmail(accessMessageToCopy);
    if (!loginEmail) return;
    const matched = users.find((u) => normalizeEmail(u.email) === loginEmail);
    if (matched && matched.tempAccessActive === false) {
      clearAccessMessage();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessMessageToCopy, users]);
  // --- Preferencias personales por usuario de la casa ---
  const [prefs, setPrefs] = useState(() => {
    const base = activeHouseholdUser?.preferences || {};
    return {
      defaultTab: base.defaultTab || 'dashboard',
      showOnlyMyMovements: !!base.showOnlyMyMovements,
      dashboardCards: {
        resumenMes: base.dashboardCards?.resumenMes ?? true,
        deudas: base.dashboardCards?.deudas ?? true,
        ahorro: base.dashboardCards?.ahorro ?? true,
        inversiones: base.dashboardCards?.inversiones ?? false, // por si en el futuro reactivas inversiones
        presupuestos: base.dashboardCards?.presupuestos ?? true,
      },
      transactionsDefaults: {
        type: base.transactionsDefaults?.type || 'gasto',
        defaultCategory:
          base.transactionsDefaults?.defaultCategory ||
          cats[0] ||
          CATEGORIES[0],
      },
      ui: {
        theme: base.ui?.theme || 'light',
        density: base.ui?.density || 'normal',
      },
    };
  });

  useEffect(() => {
    const base = activeHouseholdUser?.preferences || {};
    setPrefs({
      defaultTab: base.defaultTab || 'dashboard',
      showOnlyMyMovements: !!base.showOnlyMyMovements,
      dashboardCards: {
        resumenMes: base.dashboardCards?.resumenMes ?? true,
        deudas: base.dashboardCards?.deudas ?? true,
        ahorro: base.dashboardCards?.ahorro ?? true,
        inversiones: base.dashboardCards?.inversiones ?? false,
        presupuestos: base.dashboardCards?.presupuestos ?? true,
      },
      transactionsDefaults: {
        type: base.transactionsDefaults?.type || 'gasto',
        defaultCategory:
          base.transactionsDefaults?.defaultCategory ||
          cats[0] ||
          CATEGORIES[0],
      },
      ui: {
        theme: base.ui?.theme || 'light',
        density: base.ui?.density || 'normal',
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHouseholdUser?.id, cats.join('|')]);

  async function handleSavePreferences(e) {
    e.preventDefault();
    if (!activeHouseholdUser) return;
    await actions.updateHouseholdUser(activeHouseholdUser.id, {
      preferences: prefs,
    });
    toast.success('Preferencias guardadas.');
  }

  function renderCategoryRow(cat, list) {
    const index = list.indexOf(cat);
    const canMoveUp = index > 0;
    const canMoveDown = index >= 0 && index < list.length - 1;
    const isFixed = !!fixedCategories[cat];
    const isPriority = isPriorityCategory(cat, priorityCategories);
    // Subcategorías del presupuesto del mes visible: cada una puede vencer otro día.
    const subcategories = isFixed
      ? (Array.isArray(data.budgets?.[cat]?.breakdown) ? data.budgets[cat].breakdown : [])
          .map((item, idx) => ({
            id: String(item.id || item.name || `${cat}-${idx}`),
            name: String(item.name || '').trim(),
          }))
          .filter((item) => item.name)
      : [];
    return (
      <li
        key={cat}
        className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between border rounded-lg px-3 py-2"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="whitespace-normal break-words">{cat}</span>
        </div>
        <div className="flex flex-wrap gap-2 sm:items-center">
          <label className="inline-flex items-center gap-1 text-[11px] text-[color:var(--text-muted)]">
            <input
              type="checkbox"
              checked={isFixed}
              onChange={(e) =>
                actions?.setCategoryFixed?.(cat, e.target.checked)
              }
            />
            Gasto fijo
          </label>
          {isFixed && (
            <label className="inline-flex items-center gap-1 text-[11px] text-[color:var(--text-muted)]">
              {subcategories.length ? 'Vence el día (por defecto)' : 'Vence el día'}
              <DueDayInput
                value={fixedDueDays[cat]}
                label={`Día de vencimiento de ${cat}`}
                onSave={(day) => actions?.setCategoryDueDay?.(cat, day)}
              />
            </label>
          )}
          {/* Un gasto fijo se paga una vez en su fecha: la prioridad (reserva diaria) es solo para los variables. */}
          {!isFixed && (
            <label
              className="inline-flex items-center gap-1 text-[11px] text-[color:var(--text-muted)]"
              data-tooltip="Se reserva por día hasta el próximo ingreso, antes de pagar cuentas"
            >
              <input
                type="checkbox"
                checked={isPriority}
                onChange={(e) =>
                  actions?.setCategoryPriority?.(cat, e.target.checked)
                }
              />
              Prioridad
            </label>
          )}
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="px-2 py-0.5 text-xs border rounded disabled:opacity-40"
              onClick={() => actions?.moveCategoryInGroup?.(cat, 'up')}
              disabled={!canMoveUp}
              data-tooltip="Subir"
            >
              ^
            </button>
            <button
              type="button"
              className="px-2 py-0.5 text-xs border rounded disabled:opacity-40"
              onClick={() => actions?.moveCategoryInGroup?.(cat, 'down')}
              disabled={!canMoveDown}
              data-tooltip="Bajar"
            >
              v
            </button>
          </div>
          <button
            type="button"
            className="text-xs text-[color:var(--primary)]"
            onClick={async () => {
              const nuevo = window.prompt(
                `Nuevo nombre para la categoria "${cat}"`,
                cat,
              );
              if (!nuevo) return;
              await actions.renameCategory(cat, nuevo);
            }}
          >
            Renombrar
          </button>
          <button
            type="button"
            className="text-xs text-[color:var(--danger)]"
            onClick={async () => {
              const txList = Array.isArray(data.transactions)
                ? data.transactions
                : [];
              const affected = actions?.updateTransaction
                ? txList.filter((tx) => tx?.category === cat)
                : [];
              if (affected.length && actions?.updateTransaction) {
                const wantsMigration = await confirmDialog(
                  `La categoria "${cat}" tiene ${affected.length} movimiento${
                    affected.length === 1 ? '' : 's'
                  } asociado${
                    affected.length === 1 ? '' : 's'
                  }. ¿Deseas migrarlos a otra categoría?`,
                );
                if (wantsMigration) {
                  const options = cats.filter((c) => c !== cat);
                  const input = window.prompt(
                    `Categoria destino:\n${options.join(', ')}`,
                    options[0] || '',
                  );
                  if (input === null) return;
                  const target = String(input || '').trim();
                  if (!target || !options.includes(target)) {
                    toast.warning('Categoría destino no válida.');
                    return;
                  }
                  await Promise.all(
                    affected.map((tx) => {
                      const nextMeta = { ...(tx.meta || {}) };
                      delete nextMeta.budgetSubcategoryIds;
                      delete nextMeta.budgetSubcategoryId;
                      delete nextMeta.budgetSubcategoryNames;
                      delete nextMeta.budgetSubcategoryName;
                      delete nextMeta.budgetSubcategoryAmounts;
                      delete nextMeta.budgetSubcategoryAllocations;
                      return actions.updateTransaction(tx.id, {
                        category: target,
                        meta: nextMeta,
                      });
                    }),
                  );
                }
              }

              const ok = await confirmDialog(
                `Eliminar la categoria "${cat}"? Los presupuestos de esa categoria se perderan.`,
              );
              if (!ok) return;
              await actions.removeCategory(cat);
            }}
          >
            Eliminar
          </button>
        </div>
        {subcategories.length > 0 && (
          <ul className="w-full grid gap-1 sm:grid-cols-2 border-t border-[color:var(--divider)] pt-2">
            {subcategories.map((sub) => (
              <li key={sub.id} className="flex items-center justify-between gap-2 text-[11px] text-[color:var(--text-muted)]">
                <span className="truncate">{sub.name}</span>
                <label className="inline-flex items-center gap-1">
                  Vence el día
                  <DueDayInput
                    value={fixedDueDays[dueDayKey(cat, sub.id)]}
                    placeholder={fixedDueDays[cat] ? String(fixedDueDays[cat]) : '—'}
                    label={`Día de vencimiento de ${cat} · ${sub.name}`}
                    onSave={(day) => actions?.setCategoryDueDay?.(dueDayKey(cat, sub.id), day)}
                  />
                </label>
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        {/* Columna izquierda: usuarios y dia de corte */}
        <div className="space-y-4">
          <Card>
            <SectionTitle
              right={
                <button
                  className="px-3 py-1.5 rounded-full border text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={startCreateUser}
                  disabled={!canInvite}
                  title={
                    canInvite
                      ? ''
                      : 'Solo el superadministrador puede administrar usuarios.'
                  }
                >
                  + Agregar
                </button>
              }
            >
              Usuarios de la casa
            </SectionTitle>
            {!canInvite && (
              <p className="text-xs text-[color:var(--text-muted)]">
                Solo el superadministrador puede administrar usuarios.
              </p>
            )}

            {users.length === 0 ? (
              <div className="text-sm text-[color:var(--text-muted)]">
                Aun no hay usuarios configurados. Usa "Agregar" para crear los
                integrantes de la casa.
              </div>
            ) : (
              <ul className="mt-3 space-y-2 text-sm">
                {sortedUsers.map((u) => {
                  const targetAuthUid = u.authUid;
                  const isProtected =
                    !!targetAuthUid &&
                    (!ownerUid || targetAuthUid === ownerUid);
                  const isCurrent = user?.uid && u.authUid === user.uid;
                  const canEdit = isOwner || isCurrent;
                  const canRemove = isOwner && !isProtected;
                  const canLeave = isCurrent && !isOwner;
                  return (
                    <li
                      key={u.id}
                      className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border rounded-lg px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="font-medium break-all">
                          {getUserEmail(u) || displayName(u)}{' '}
                          {isCurrent && (
                            <span className="text-xs text-[color:var(--text-muted)]">
                              (Tu usuario)
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-[color:var(--text-muted)]">
                          {getMemberName(u) || getUserEmail(u) || 'Sin nombre'}
                        </div>
                        <div className="text-xs text-[color:var(--text-muted)]">
                          {isProtected
                            ? 'Usuario principal (no se puede eliminar)'
                            : 'Usuario de la casa'}
                        </div>
                      </div>
                      {(canEdit || canRemove || canLeave) && (
                        <div className="flex flex-wrap gap-2">
                          {canEdit && (
                            <button
                              type="button"
                              className="text-xs text-[color:var(--primary)]"
                              onClick={() => startEditUser(u)}
                            >
                              Editar
                            </button>
                          )}
                          {canLeave && (
                            <button
                              type="button"
                              className="text-xs text-[color:var(--danger)]"
                              onClick={() => handleLeaveHousehold(u)}
                            >
                              Darse de baja
                            </button>
                          )}
                          {canRemove && (
                            <button
                              type="button"
                              className="text-xs text-[color:var(--danger)]"
                              onClick={async () => {
                                const ok = await confirmDialog(
                                  `Eliminar al usuario "${displayName(u)}"?`,
                                );
                                if (!ok) return;
                                await actions.removeHouseholdUser(u.id);
                              }}
                            >
                              Eliminar
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {canInvite && (
              <div className="mt-3 rounded-lg border px-3 py-2 text-xs">
                <div className="font-semibold mb-1">Invitacion temporal</div>
                <p className="text-[color:var(--text-muted)]">
                  Envia esta invitacion al usuario creado para que inicie con su
                  usuario ficticio (correo) y clave temporal, y cambie su clave
                  al entrar.
                </p>
                {accessMessageToCopy ? (
                  <>
                    <div className="mt-2 whitespace-pre-wrap break-all border rounded-lg p-2 bg-[color:var(--surface-2)]/60">
                      {accessMessageToCopy}
                    </div>
                    <button
                      type="button"
                      className="mt-2 text-xs text-[color:var(--primary)]"
                      onClick={() => handleCopyInviteLink(accessMessageToCopy)}
                    >
                      Copiar invitacion
                    </button>
                    <button
                      type="button"
                      className="mt-2 text-xs text-[color:var(--danger)]"
                      onClick={clearAccessMessage}
                    >
                      Eliminar invitacion
                    </button>
                  </>
                ) : (
                  <div className="mt-2 text-[color:var(--text-muted)]">
                    Aun no hay invitacion generada.
                  </div>
                )}
              </div>
            )}

            {canInvite && (
              <div className="mt-4 border-t border-[color:var(--divider)] pt-3">
                <div className="text-xs font-semibold text-[color:var(--text-muted)] uppercase mb-2">
                  Invitaciones pendientes
                </div>
                {invitesLoading && (
                  <div className="text-xs text-[color:var(--text-muted)]">
                    Cargando invitaciones...
                  </div>
                )}
                {!invitesLoading && pendingInvites.length === 0 && (
                  <div className="text-xs text-[color:var(--text-muted)]">
                    No hay invitaciones pendientes.
                  </div>
                )}
                {invitesError && (
                  <div className="text-xs text-[color:var(--danger)]">
                    {invitesError}
                  </div>
                )}
                {!invitesLoading && pendingInvites.length > 0 && (
                  <ul className="space-y-2 text-xs">
                    {pendingInvites.map((invite) => {
                      const created = formatDate(invite.createdAtMs);
                      const expires = formatDate(invite.expiresAtMs);
                      const meta = [
                        created ? `Enviada: ${created}` : null,
                        expires ? `Vence: ${expires}` : null,
                      ]
                        .filter(Boolean)
                        .join(' - ');
                      const isExpired = !!invite.isExpired;
                      const busy = inviteActionId === invite.id;
                      return (
                        <li
                          key={invite.id}
                          className="flex flex-col gap-2 border rounded-lg px-3 py-2"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="font-semibold truncate">
                                {invite.name || invite.email || 'Invitado'}
                              </div>
                              {invite.email && (
                                <div className="text-[color:var(--text-muted)] truncate">
                                  {invite.email}
                                </div>
                              )}
                              {meta && (
                                <div className="text-[color:var(--text-muted)]">
                                  {meta}
                                </div>
                              )}
                              {isExpired && (
                                <div className="text-[color:var(--danger)]">
                                  URL caducada. Solo dura 10 minutos, genera
                                  otra para que tu invitado la use dentro de
                                  este plazo.
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                className="text-xs text-[color:var(--primary)] disabled:opacity-60"
                                onClick={() => handleRegenerateInvite(invite)}
                                disabled={busy}
                              >
                                Generar nuevo enlace
                              </button>
                              <button
                                type="button"
                                className="text-xs text-[color:var(--danger)] disabled:opacity-60"
                                onClick={() => handleRevokeInvite(invite)}
                                disabled={busy}
                              >
                                Cancelar
                              </button>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {inviteLink && (
                  <div className="mt-3 rounded-lg border px-3 py-2 text-xs">
                    <div className="font-semibold mb-1">Link de invitacion</div>
                    <div className="break-all">{inviteLink}</div>
                    <button
                      type="button"
                      className="mt-2 text-xs text-[color:var(--primary)]"
                      onClick={handleCopyInviteLink}
                    >
                      Copiar enlace
                    </button>
                    <button
                      type="button"
                      className="mt-2 ml-3 text-xs text-[color:var(--primary)]"
                      onClick={openInviteInspector}
                    >
                      Revisar enlace
                    </button>
                  </div>
                )}
              </div>
            )}

            {showJoinRequests && (
              <div className="mt-4 border-t border-[color:var(--divider)] pt-3">
                <div className="text-xs font-semibold text-[color:var(--text-muted)] uppercase mb-2">
                  Solicitudes de ingreso
                </div>
                {joinRequestsLoading && (
                  <div className="text-xs text-[color:var(--text-muted)]">
                    Cargando solicitudes...
                  </div>
                )}
                {joinRequestsError && (
                  <div className="text-xs text-[color:var(--danger)]">
                    {joinRequestsError}
                  </div>
                )}
                {!joinRequestsLoading && joinRequests.length > 0 && (
                  <ul className="space-y-2 text-xs">
                    {joinRequests.map((req) => {
                      const created = formatDate(req.createdAtMs);
                      const meta = created ? `Solicitada: ${created}` : '';
                      const busy = joinActionUid === req.uid;
                      return (
                        <li
                          key={req.uid}
                          className="flex flex-col gap-2 border rounded-lg px-3 py-2"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="font-semibold truncate">
                                {req.displayName || req.email || req.uid}
                              </div>
                              {req.email && (
                                <div className="text-[color:var(--text-muted)] truncate">
                                  {req.email}
                                </div>
                              )}
                              {meta && (
                                <div className="text-[color:var(--text-muted)]">
                                  {meta}
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                className="text-xs text-[color:var(--primary)] disabled:opacity-60"
                                onClick={() => handleApproveJoinRequest(req)}
                                disabled={busy}
                              >
                                Aprobar
                              </button>
                              <button
                                type="button"
                                className="text-xs text-[color:var(--danger)] disabled:opacity-60"
                                onClick={() => handleRejectJoinRequest(req)}
                                disabled={busy}
                              >
                                Rechazar
                              </button>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </Card>
          <Card>
            <SectionTitle>Día de corte del mes</SectionTitle>
            <form
              className="grid gap-3"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!isOwner) return;
                const formData = new FormData(e.currentTarget);
                const day = formData.get('cut-day') || data.budgetCutDay || 1;
                await actions.setBudgetCutDay(day);
                toast.success('Día de corte actualizado.');
              }}
            >
              {!isOwner && (
                <p className="text-xs text-[color:var(--text-muted)]">
                  Solo el superadministrador puede cambiar el dia de corte.
                </p>
              )}
              <div className="grid gap-1">
                <label className="text-sm">
                  Día (1 al 28 recomendado por meses cortos)
                </label>
                <input
                  type="number"
                  name="cut-day"
                  min={1}
                  max={28}
                  defaultValue={data.budgetCutDay || 1}
                  className="border rounded-lg p-2 w-32"
                  disabled={!isOwner}
                />
                <p className="text-xs text-[color:var(--text-muted)]">
                  El presupuesto se calculará desde ese día de un mes hasta el
                  día anterior del mes siguiente.
                </p>
              </div>
              <button
                className="px-3 py-2 rounded-xl border bg-[color:var(--primary)] text-[color:var(--primary-contrast)] text-sm"
                disabled={!isOwner}
              >
                Guardar día de corte
              </button>
            </form>
          </Card>

          <Card>
            <SectionTitle>Preferencias personales</SectionTitle>
            {!activeHouseholdUser && (
              <p className="text-sm text-[color:var(--text-muted)]">
                No pudimos identificar tu usuario para configurar preferencias.
              </p>
            )}

            {activeHouseholdUser && (
              <form
                className="grid gap-3 mt-2"
                onSubmit={handleSavePreferences}
                autoComplete="off"
              >
                <div className="grid gap-1">
                  <label className="text-sm">Configurando a</label>
                  <div className="border rounded-lg p-2 bg-[color:var(--surface-2)]  text-sm">
                    {displayName(activeHouseholdUser)}
                  </div>
                </div>

                <div className="border rounded-xl p-3">
                  <div className="font-medium text-sm mb-2">
                    Valores por defecto al crear movimiento
                  </div>
                  <div className="grid gap-2 text-sm">
                    <div className="grid gap-1">
                      <label>Tipo por defecto</label>
                      <select
                        className="border rounded-lg p-2"
                        value={prefs.transactionsDefaults.type}
                        onChange={(e) =>
                          setPrefs((prev) => ({
                            ...prev,
                            transactionsDefaults: {
                              ...prev.transactionsDefaults,
                              type: e.target.value,
                            },
                          }))
                        }
                      >
                        <option value="gasto">Gasto</option>
                        <option value="ingreso">Ingreso</option>
                      </select>
                    </div>
                    <div className="grid gap-1">
                      <label>Categoría por defecto (para gasto)</label>
                      <select
                        className="border rounded-lg p-2"
                        value={prefs.transactionsDefaults.defaultCategory}
                        onChange={(e) =>
                          setPrefs((prev) => ({
                            ...prev,
                            transactionsDefaults: {
                              ...prev.transactionsDefaults,
                              defaultCategory: e.target.value,
                            },
                          }))
                        }
                      >
                        {cats.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                <div className="border rounded-xl p-3">
                  <div className="font-medium text-sm mb-2">Aspecto</div>
                  <div className="grid gap-2 text-sm">
                    <div className="grid gap-1">
                      <label>Tema</label>
                      <select
                        className="border rounded-lg p-2"
                        value={prefs.ui.theme}
                        onChange={(e) =>
                          setPrefs((prev) => ({
                            ...prev,
                            ui: { ...prev.ui, theme: e.target.value },
                          }))
                        }
                      >
                        <option value="light">Claro</option>
                        <option value="dark">Oscuro</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end gap-2 mt-2">
                  <button
                    type="submit"
                    className="px-3 py-1.5 text-sm border rounded-lg bg-[color:var(--primary)] text-[color:var(--primary-contrast)]"
                  >
                    Guardar preferencias
                  </button>
                </div>
              </form>
            )}
          </Card>
        </div>

        {/* Columna derecha: categorías (visible para todos) */}
        <Card>
          <SectionTitle>Categorías</SectionTitle>

          <p className="text-xs text-[color:var(--text-muted)] mt-1">
            Marca las categorias fijas para que acumulen pendientes entre
            periodos (con su día de vencimiento), y las de prioridad (comida,
            remedios) para que el plan las reserve por día hasta el próximo
            ingreso.
          </p>

          <form
            className="flex gap-2 mt-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const name = newCategory.trim();
              if (!name) return;
              await actions.addCategory(name);
              setNewCategory('');
            }}
          >
            <input
              className="border rounded-lg p-2 flex-1"
              placeholder="Nueva categoría (ej. Mascotas)"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
            />
            <button
              type="submit"
              className="px-3 py-2 rounded-xl border bg-[color:var(--primary)] text-[color:var(--primary-contrast)] text-sm"
            >
              Agregar
            </button>
          </form>

          <div className="mt-4 space-y-4 text-sm">
            <div className="rounded-lg border bg-[color:var(--surface-2)]/60 p-3">
              <div className="text-xs font-semibold text-[color:var(--text-muted)] uppercase mb-2">
                Gasto fijo
              </div>
              {fixedCats.length === 0 ? (
                <div className="text-xs text-[color:var(--text-muted)]">
                  No hay categorias fijas.
                </div>
              ) : (
                <ul className="space-y-2">
                  {fixedCats.map((c) => renderCategoryRow(c, fixedCats))}
                </ul>
              )}
            </div>

            <div className="rounded-lg border bg-[color:var(--surface-2)]/60 p-3">
              <div className="text-xs font-semibold text-[color:var(--text-muted)] uppercase mb-2">
                Gasto variable
              </div>
              {variableCats.length === 0 ? (
                <div className="text-xs text-[color:var(--text-muted)]">
                  No hay categorias variables.
                </div>
              ) : (
                <ul className="space-y-2">
                  {variableCats.map((c) => renderCategoryRow(c, variableCats))}
                </ul>
              )}
            </div>
          </div>
        </Card>
      </div>

      {/* Modal flotante para crear/editar usuario */}
      {showUserModal && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40">
          <div className="bg-[color:var(--surface-1)] rounded-2xl shadow-[var(--shadow)] p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold mb-3">
              {userForm.id ? 'Editar usuario' : 'Nuevo usuario'}
            </h3>
            <form
              className="grid gap-3"
              onSubmit={handleSaveUser}
              autoComplete="off"
            >
              <div className="grid gap-1">
                <label className="text-sm">Correo</label>
                <input
                  className="border rounded-lg p-2"
                  value={editingUser ? getUserEmail(editingUser) : ''}
                  readOnly
                  disabled
                />
              </div>

              <div className="grid gap-1">
                <label className="text-sm">Nombre</label>
                <input
                  className="border rounded-lg p-2"
                  value={userForm.name}
                  onChange={(e) =>
                    setUserForm((prev) => ({
                      ...prev,
                      name: e.target.value,
                    }))
                  }
                  required
                  disabled={isInviting || inviteStatus === 'sent'}
                />
              </div>

              {!isEditingUser && (
                <div className="grid gap-1">
                  <p className="text-xs text-[color:var(--text-muted)]">
                    Se generaran credenciales temporales para compartir.
                  </p>
                </div>
              )}

              {editingUser?.authUid &&
                (!ownerUid || editingUser.authUid === ownerUid) && (
                  <p className="text-xs text-[color:var(--text-muted)]">
                    Usuario principal (no se puede eliminar).
                  </p>
                )}

              {inviteError && (
                <p className="text-xs text-[color:var(--danger)]">
                  {inviteError}
                </p>
              )}
              {inviteStatus === 'sent' && (
                <p className="text-xs text-[color:var(--success)]">
                  Credenciales generadas.
                </p>
              )}
              {inviteStatus === 'sent' && accessData && (
                <div className="rounded-lg border px-3 py-2 text-xs">
                  <div className="font-semibold mb-2">
                    Credenciales temporales
                  </div>
                  <div className="grid gap-2">
                    <div className="grid gap-1">
                      <label>Usuario ficticio (correo)</label>
                      <input
                        className="border rounded-lg p-2 text-xs"
                        value={accessData.loginEmail}
                        readOnly
                      />
                    </div>
                    <div className="grid gap-1">
                      <label>Clave temporal</label>
                      <input
                        className="border rounded-lg p-2 text-xs"
                        value={accessData.tempPassword}
                        readOnly
                      />
                    </div>
                    <div className="text-[color:var(--text-muted)]">
                      Usa este usuario ficticio y la clave temporal para entrar.
                      Al iniciar, debera cambiar su clave.
                    </div>
                  </div>
                  <div className="font-semibold mt-3 mb-1">
                    Invitacion para copiar
                  </div>
                  <div className="whitespace-pre-wrap break-all">
                    {accessData.message}
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  className="px-3 py-1.5 text-sm border rounded-lg"
                  onClick={() => {
                    setShowUserModal(false);
                    setInviteStatus('idle');
                    setInviteError('');
                    setInviteLink('');
                    setAccessData(null);
                  }}
                >
                  {inviteStatus === 'sent' ? 'Cerrar' : 'Cancelar'}
                </button>
                {inviteStatus !== 'sent' && (
                  <button
                    type="submit"
                    className="px-3 py-1.5 text-sm border rounded-lg bg-[color:var(--primary)] text-[color:var(--primary-contrast)] disabled:opacity-60"
                    disabled={isInviting}
                  >
                    {isInviting
                      ? 'Creando...'
                      : isEditingUser
                        ? 'Guardar'
                        : 'Crear usuario'}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

      {showInviteInspector && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
          <div className="bg-[color:var(--surface-1)] rounded-2xl shadow-[var(--shadow)] p-6 w-full max-w-xl">
            <h3 className="text-lg font-semibold mb-2">
              Revisar enlace de invitación
            </h3>
            <p className="text-xs text-[color:var(--text-muted)]">
              Compara el enlace actual con la invitación guardada en Firebase.
            </p>

            {inviteInspectorError && (
              <p className="mt-3 text-xs text-[color:var(--danger)]">
                {inviteInspectorError}
              </p>
            )}
            {inviteInspectorLoading && (
              <p className="mt-3 text-xs text-[color:var(--text-muted)]">
                Cargando información...
              </p>
            )}

            {!inviteInspectorLoading && inviteInspectorData && (
              <div className="mt-3 grid gap-3 text-xs">
                <div className="rounded-lg border px-3 py-2">
                  <div className="font-semibold mb-1">URL actual</div>
                  <div className="break-all">{inviteInspectorData.link}</div>
                </div>

                <div className="rounded-lg border px-3 py-2">
                  <div className="font-semibold mb-1">Datos del enlace</div>
                  <div className="break-all">
                    ID de invitación: {inviteInspectorData.parsed.inviteId}
                  </div>
                  <div className="break-all">
                    Hogar: {inviteInspectorData.parsed.householdId || '-'}
                  </div>
                  <div className="break-all">
                    Hash del token (enlace):{' '}
                    {inviteInspectorData.tokenHashFromLink}
                  </div>
                </div>

                <div className="rounded-lg border px-3 py-2">
                  <div className="font-semibold mb-1">Firebase espera</div>
                  {inviteInspectorData.invite ? (
                    <div className="grid gap-1">
                      <div className="break-all">
                        ID de invitación: {inviteInspectorData.invite.id}
                      </div>
                      {inviteInspectorData.invite.inviteeName && (
                        <div>
                          Nombre: {inviteInspectorData.invite.inviteeName}
                        </div>
                      )}
                      {inviteInspectorData.invite.inviteeEmail && (
                        <div className="break-all">
                          Email: {inviteInspectorData.invite.inviteeEmail}
                        </div>
                      )}
                      <div>Estado: {inviteInspectorData.invite.status}</div>
                      {inviteInspectorData.invite.createdAtMs ? (
                        <div>
                          Creada:{' '}
                          {formatDate(inviteInspectorData.invite.createdAtMs)}
                        </div>
                      ) : null}
                      {inviteInspectorData.invite.expiresAtMs ? (
                        <div>
                          Vence:{' '}
                          {formatDate(inviteInspectorData.invite.expiresAtMs)}
                        </div>
                      ) : null}
                      <div className="break-all">
                        Token hash (Firebase):{' '}
                        {inviteInspectorData.invite.tokenHash}
                      </div>
                      {inviteInspectorData.source && (
                        <div className="text-[color:var(--text-muted)]">
                          Fuente:{' '}
                          {inviteInspectorData.source === 'id'
                            ? 'Invitación con ese ID'
                            : inviteInspectorData.source === 'latest-pending'
                              ? 'Última invitación pendiente'
                              : 'Última invitación encontrada'}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div>No se encontró invitación en Firebase.</div>
                  )}
                </div>

                <div className="rounded-lg border px-3 py-2">
                  <div className="font-semibold mb-1">Comparación</div>
                  <div>
                    Hogar coincide:{' '}
                    {matchLabel(inviteInspectorData.compare.householdMatch)}
                  </div>
                  <div>
                    ID de invitación coincide:{' '}
                    {matchLabel(inviteInspectorData.compare.inviteIdMatch)}
                  </div>
                  <div>
                    Token coincide:{' '}
                    {matchLabel(inviteInspectorData.compare.tokenHashMatch)}
                  </div>
                  {inviteInspectorData.compare.isExpired && (
                    <div className="text-[color:var(--danger)]">
                      La invitación está vencida.
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              {inviteInspectorData?.link && (
                <button
                  type="button"
                  className="px-3 py-1.5 text-sm border rounded-lg"
                  onClick={() => handleCopyInviteLink(inviteInspectorData.link)}
                >
                  Copiar enlace
                </button>
              )}
              <button
                type="button"
                className="px-3 py-1.5 text-sm border rounded-lg"
                onClick={() => {
                  setShowInviteInspector(false);
                  setInviteInspectorError('');
                  setInviteInspectorData(null);
                }}
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      <AuditLogPanel onFetch={actions?.fetchAuditLog} />

      <DangerZone
        isOwner={isOwner}
        onExport={actions?.exportFinances}
        onReset={actions?.resetFinances}
      />
    </>
  );
}

