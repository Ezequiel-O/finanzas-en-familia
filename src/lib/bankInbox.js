import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { auth, db } from '../firebase';

const TOKEN_SECRET_BYTES = 32;
const PENDING_LIMIT = 50;

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function currentUid() {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Debes iniciar sesión.');
  return uid;
}

export function bankInboxEndpoint() {
  const configured = String(import.meta.env.VITE_BANK_INBOX_URL || '').trim();
  if (configured) return configured;
  const projectId = String(import.meta.env.VITE_FIREBASE_PROJECT_ID || '').trim();
  return projectId
    ? `https://us-central1-${projectId}.cloudfunctions.net/ingestBankEmail`
    : '';
}

export function subscribePendingBankInbox(householdId, onItems, onError) {
  const pending = query(
    collection(db, 'households', householdId, 'bankInbox'),
    where('status', '==', 'pending'),
    limit(PENDING_LIMIT),
  );
  return onSnapshot(
    pending,
    (snapshot) => {
      const items = snapshot.docs
        .map((document) => {
          const data = document.data() || {};
          return {
            id: document.id,
            subject: String(data.subject || ''),
            body: String(data.body || ''),
            sender: String(data.sender || ''),
            receivedAt: String(data.receivedAt || ''),
            senderVerified: data.senderVerified === true,
          };
        })
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
      onItems(items);
    },
    onError,
  );
}

// Marca el aviso como resuelto y borra su contenido; queda solo el ID para no repetirlo.
export function resolveBankInboxItem(householdId, messageId, status) {
  return updateDoc(doc(db, 'households', householdId, 'bankInbox', messageId), {
    status,
    resolvedBy: currentUid(),
    resolvedAt: serverTimestamp(),
    subject: deleteField(),
    body: deleteField(),
  });
}

export async function hasBankInboxToken(householdId) {
  const snapshot = await getDoc(
    doc(db, 'households', householdId, 'bankInboxTokens', currentUid()),
  );
  return snapshot.exists();
}

// Genera una clave nueva (reemplaza la anterior). Solo se guarda su hash.
export async function createBankInboxToken(householdId) {
  const uid = currentUid();
  if (typeof crypto === 'undefined' || !crypto.getRandomValues || !crypto.subtle) {
    throw new Error('Este navegador no puede generar una clave segura.');
  }
  const secret = toHex(crypto.getRandomValues(new Uint8Array(TOKEN_SECRET_BYTES)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  await setDoc(doc(db, 'households', householdId, 'bankInboxTokens', uid), {
    tokenHash: toHex(new Uint8Array(digest)),
    createdAt: serverTimestamp(),
  });
  return `${householdId}.${uid}.${secret}`;
}

export function revokeBankInboxToken(householdId) {
  return deleteDoc(doc(db, 'households', householdId, 'bankInboxTokens', currentUid()));
}
