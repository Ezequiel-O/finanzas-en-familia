import { createHash, timingSafeEqual } from 'node:crypto';

// Mismos remitentes que src/lib/gmail.js.
export const ALLOWED_SENDERS = new Set([
  'notificaciones@correo.bancoestado.cl',
  'noreply@correo.bancoestado.cl',
  'mensajeria@santander.cl',
]);
export const MAX_SUBJECT_LENGTH = 300;
export const MAX_BODY_LENGTH = 12000;

// Clave de conexión: <householdId>.<uid>.<secreto hex de 32 bytes>.
const TOKEN_PATTERN = /^([A-Za-z0-9_-]{1,128})\.([A-Za-z0-9_-]{1,128})\.([a-f0-9]{64})$/;
const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9]{6,64}$/;
const PAYLOAD_KEYS = new Set([
  'messageId',
  'sender',
  'subject',
  'body',
  'receivedAt',
  'senderVerified',
]);

export function parseBearerToken(header) {
  const value = String(header || '').match(/^Bearer (\S+)$/)?.[1];
  const parts = value?.match(TOKEN_PATTERN);
  if (!parts) return null;
  return { householdId: parts[1], uid: parts[2], secret: parts[3] };
}

export function hashSecret(secret) {
  return createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

export function secretMatches(secret, storedHash) {
  if (typeof storedHash !== 'string' || !TOKEN_HASH_PATTERN.test(storedHash)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(hashSecret(secret), 'hex'),
    Buffer.from(storedHash, 'hex'),
  );
}

// Misma redacción que sanitizeBankEmailForAI en src/domain/bankEmailParser.js:
// el aviso se guarda sin RUT, correos ni números de cuenta.
export function redactBankText(value) {
  return String(value)
    .replace(
      // El nombre del destinatario se conserva: la app lo usa en la descripción y
      // nunca lo envía a Gemini. El aviso se borra al resolverlo.
      /((?:N[°º]\s*(?:de\s*)?(?:cuenta|TEF)|RUT|E-?mail|correo)\s*:\s*).*?(?=\s+(?:N[°º]\s*(?:de\s*)?(?:cuenta|TEF)|RUT|E-?mail|correo|Fecha|Monto|Desde|Hacia|Producto|Banco|Comentario|Nombre)\s*:|[\r\n]|$)/gi,
      '$1[oculto]',
    )
    .replace(/\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/g, '[RUT oculto]')
    .replace(LONG_NUMBER, hideLongNumber)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[correo oculto]');
}

// Números de cuenta u operación sin etiqueta "N° de cuenta:" (Santander los pone
// sin dos puntos o en la línea siguiente): 7+ dígitos, con o sin guiones, que no
// sean montos ($ 1.200.000) ni fechas (04-11-2026).
// Repetición acotada ({5,40}) para que un correo armado no dispare backtracking largo.
const LONG_NUMBER = /(?<!(?:\$|CLP)\s{0,2}|[\d.,])\b\d[\d-]{5,40}\d\b(?![.,]\d)/gi;
function hideLongNumber(match) {
  if (match.replace(/-/g, '').length < 7) return match;
  if (/^(?:\d{1,2}-\d{1,2}-\d{2,4}|\d{4}-\d{2}-\d{2})$/.test(match)) return match;
  return '[número oculto]';
}

// Devuelve el aviso listo para guardar, o null si no cumple el formato esperado.
export function validateBankEmailPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (Object.keys(payload).some((key) => !PAYLOAD_KEYS.has(key))) return null;

  const {
    messageId,
    sender,
    subject = '',
    body,
    receivedAt = null,
    senderVerified = false,
  } = payload;
  const normalizedSender = typeof sender === 'string' ? sender.trim().toLowerCase() : '';
  if (typeof messageId !== 'string' || !MESSAGE_ID_PATTERN.test(messageId)) return null;
  if (!ALLOWED_SENDERS.has(normalizedSender)) return null;
  if (typeof subject !== 'string' || subject.length > MAX_SUBJECT_LENGTH) return null;
  if (typeof body !== 'string' || !body.trim() || body.length > MAX_BODY_LENGTH) {
    return null;
  }
  if (
    receivedAt !== null &&
    (typeof receivedAt !== 'string' ||
      receivedAt.length > 40 ||
      Number.isNaN(Date.parse(receivedAt)))
  ) {
    return null;
  }
  if (typeof senderVerified !== 'boolean') return null;

  return {
    messageId,
    sender: normalizedSender,
    subject: redactBankText(subject).slice(0, MAX_SUBJECT_LENGTH),
    body: redactBankText(body).slice(0, MAX_BODY_LENGTH),
    receivedAt: receivedAt ? new Date(receivedAt).toISOString() : null,
    senderVerified,
  };
}
