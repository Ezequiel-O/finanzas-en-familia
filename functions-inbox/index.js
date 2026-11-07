import { randomUUID } from 'node:crypto';
import { logger } from 'firebase-functions';
import { onRequest } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import {
  parseBearerToken,
  secretMatches,
  validateBankEmailPayload,
} from './payload.js';

initializeApp();
const db = getFirestore();

const MAX_PENDING_ITEMS = 200;
const INBOX_TTL_DAYS = 30;
const FIRESTORE_ALREADY_EXISTS = 6;

function correlationIdFor(request) {
  const trace = String(request.get('x-cloud-trace-context') || '').split('/')[0];
  return /^[a-f0-9]{32}$/i.test(trace) ? trace : randomUUID();
}

// Deniega por defecto: la clave debe existir, coincidir y pertenecer a un miembro vigente.
async function isAuthorized(token) {
  const [tokenSnap, householdSnap] = await Promise.all([
    db.doc(`households/${token.householdId}/bankInboxTokens/${token.uid}`).get(),
    db.doc(`households/${token.householdId}`).get(),
  ]);
  if (!tokenSnap.exists || !householdSnap.exists) return false;
  const members = householdSnap.get('members');
  return (
    Array.isArray(members) &&
    members.includes(token.uid) &&
    secretMatches(token.secret, tokenSnap.get('tokenHash'))
  );
}

// Recibe avisos de BancoEstado enviados por el Apps Script de cada miembro
// (scripts/apps-script) y los deja pendientes en households/{hid}/bankInbox.
export const ingestBankEmail = onRequest(
  {
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: 2,
    concurrency: 20,
    invoker: 'public',
  },
  async (request, response) => {
    const correlationId = correlationIdFor(request);
    response.set('Cache-Control', 'no-store');
    response.set('X-Content-Type-Options', 'nosniff');

    if (request.method !== 'POST') {
      response.set('Allow', 'POST');
      response.status(405).json({ error: 'method-not-allowed' });
      return;
    }
    if (!request.is('application/json')) {
      response.status(415).json({ error: 'unsupported-media-type' });
      return;
    }

    try {
      const token = parseBearerToken(request.get('authorization'));
      if (!token || !(await isAuthorized(token))) {
        logger.warn('Aviso bancario rechazado: clave inválida', { correlationId });
        response.status(401).json({ error: 'unauthorized' });
        return;
      }

      const email = validateBankEmailPayload(request.body);
      if (!email) {
        logger.warn('Aviso bancario rechazado: formato inválido', {
          correlationId,
          householdId: token.householdId,
        });
        response.status(400).json({ error: 'invalid-payload' });
        return;
      }

      const householdRef = db.doc(`households/${token.householdId}`);
      const imported = await householdRef
        .collection('transactions')
        .where('sourceGmailId', '==', email.messageId)
        .limit(1)
        .get();
      if (!imported.empty) {
        response.status(200).json({ status: 'already-imported' });
        return;
      }

      const pending = await householdRef
        .collection('bankInbox')
        .where('status', '==', 'pending')
        .count()
        .get();
      if (pending.data().count >= MAX_PENDING_ITEMS) {
        logger.warn('Bandeja de avisos llena', {
          correlationId,
          householdId: token.householdId,
        });
        response.status(429).json({ error: 'inbox-full' });
        return;
      }

      try {
        await householdRef.collection('bankInbox').doc(email.messageId).create({
          ...email,
          status: 'pending',
          receivedBy: token.uid,
          createdAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromMillis(
            Date.now() + INBOX_TTL_DAYS * 24 * 60 * 60 * 1000,
          ),
        });
      } catch (error) {
        if (error?.code === FIRESTORE_ALREADY_EXISTS) {
          response.status(200).json({ status: 'duplicate' });
          return;
        }
        throw error;
      }

      logger.info('Aviso bancario recibido', {
        correlationId,
        householdId: token.householdId,
        messageId: email.messageId,
      });
      response.status(201).json({ status: 'pending' });
    } catch (error) {
      logger.error('No se pudo recibir un aviso bancario', {
        correlationId,
        code: error?.code || 'unknown',
      });
      response.status(500).json({ error: 'internal', correlationId });
    }
  },
);
