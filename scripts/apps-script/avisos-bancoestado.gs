/**
 * Finanzas en Familia — envío automático de avisos bancarios (BancoEstado, Santander).
 *
 * Corre en tu propia cuenta de Google (script.google.com). Cada 10 minutos
 * busca avisos nuevos de tus bancos con permiso de solo lectura y los envía a
 * la bandeja de la app, donde eliges dónde cargarlos. Instrucciones en el README
 * (sección "Recepción automática de avisos").
 *
 * Propiedades del script requeridas (Configuración del proyecto → Propiedades):
 *   FF_ENDPOINT  URL https de la Cloud Function ingestBankEmail.
 *   FF_TOKEN     Clave generada en la app (Movimientos → Gmail → Recepción automática).
 */

const SENDERS = [
  'notificaciones@correo.bancoestado.cl',
  'noreply@correo.bancoestado.cl',
  'mensajeria@santander.cl',
];
// Los estados de cuenta traen los movimientos en un PDF cifrado: no se envían.
const EXCLUDED_SUBJECTS = '-subject:("Estado de Cuenta")';
// Margen para recuperar avisos si el envío falla varios días; FF_SENT_IDS evita duplicados.
const LOOKBACK = '7d';
const MAX_PER_RUN = 20;
const MAX_REMEMBERED = 300;
const MAX_SUBJECT_LENGTH = 300;
const MAX_BODY_LENGTH = 12000;
const TRIGGER_MINUTES = 10;

/** Ejecuta esta función una vez para programar la revisión cada 10 minutos. */
function instalarActivador() {
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'enviarAvisosBancarios')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('enviarAvisosBancarios')
    .timeBased()
    .everyMinutes(TRIGGER_MINUTES)
    .create();
  enviarAvisosBancarios();
}

/** Quita la revisión automática. */
function desinstalarActivador() {
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'enviarAvisosBancarios')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
}

function enviarAvisosBancarios() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const endpoint = String(props.getProperty('FF_ENDPOINT') || '').trim();
    const token = String(props.getProperty('FF_TOKEN') || '').trim();
    if (!endpoint || !token) {
      throw new Error('Configura FF_ENDPOINT y FF_TOKEN en las propiedades del script.');
    }
    if (!/^https:\/\/[^\s/]+\/\S*$/.test(endpoint)) {
      throw new Error('FF_ENDPOINT debe ser una URL https.');
    }

    const sent = JSON.parse(props.getProperty('FF_SENT_IDS') || '[]');
    const sentIds = new Set(sent);
    const list = Gmail.Users.Messages.list('me', {
      q: `from:(${SENDERS.join(' OR ')}) ${EXCLUDED_SUBJECTS} newer_than:${LOOKBACK}`,
      maxResults: 50,
    });
    const refs = (list.messages || []).filter((ref) => !sentIds.has(ref.id)).reverse();

    let delivered = 0;
    for (const ref of refs) {
      if (delivered >= MAX_PER_RUN) break;
      let email = null;
      try {
        email = toPayload(Gmail.Users.Messages.get('me', ref.id, { format: 'full' }));
      } catch (error) {
        // Un correo ilegible no debe detener el resto; no se reintenta.
        console.warn(JSON.stringify({ event: 'aviso_ilegible', error: String(error.message || error) }));
      }
      if (!email) {
        sent.push(ref.id);
        sentIds.add(ref.id);
        continue;
      }

      const response = UrlFetchApp.fetch(endpoint, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: `Bearer ${token}` },
        payload: JSON.stringify(email),
        muteHttpExceptions: true,
        followRedirects: false,
      });
      const code = response.getResponseCode();
      if (code >= 200 && code < 300) {
        sent.push(ref.id);
        sentIds.add(ref.id);
        delivered += 1;
      } else if (code === 400) {
        // Formato no aceptado: no se reintenta.
        sent.push(ref.id);
        sentIds.add(ref.id);
        console.warn(JSON.stringify({ event: 'aviso_rechazado', code }));
      } else if (code === 401) {
        throw new Error('La app rechazó FF_TOKEN. Genera una clave nueva en la app.');
      } else {
        // 429 (bandeja llena) o error temporal: se reintenta en la próxima ejecución.
        console.warn(JSON.stringify({ event: 'envio_pospuesto', code }));
        break;
      }
    }

    props.setProperty('FF_SENT_IDS', JSON.stringify(sent.slice(-MAX_REMEMBERED)));
    console.log(JSON.stringify({ event: 'avisos_enviados', delivered }));
  } finally {
    lock.releaseLock();
  }
}

function toPayload(message) {
  const headers = (message.payload && message.payload.headers) || [];
  const header = (name) => {
    const found = headers.find((item) => String(item.name).toLowerCase() === name);
    return found ? String(found.value || '') : '';
  };
  const address = header('from').match(/<([^>]+)>/);
  const sender = (address ? address[1] : header('from')).trim().toLowerCase();
  if (!SENDERS.includes(sender)) return null;

  const body = extractText(message.payload).trim().slice(0, MAX_BODY_LENGTH);
  if (!body) return null;
  return {
    messageId: message.id,
    sender,
    subject: header('subject').slice(0, MAX_SUBJECT_LENGTH),
    body,
    receivedAt: new Date(Number(message.internalDate)).toISOString(),
    senderVerified: dkimPasses(header('authentication-results'), sender),
  };
}

// DKIM válido firmado por el dominio del banco remitente (por ejemplo santander.cl).
function dkimPasses(results, sender) {
  const domain = sender.split('@')[1].split('.').slice(-2).join('.');
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\bdkim=pass\\b[^;]*header\\.(?:d|i)=@?(?:[\\w-]+\\.)*${escaped}\\b`, 'i').test(
    results,
  );
}

function extractText(payload) {
  const plain = [];
  const html = [];
  const walk = (part) => {
    if (!part) return;
    if (part.body && part.body.data) {
      if (part.mimeType === 'text/plain') plain.push(decode(part));
      if (part.mimeType === 'text/html') html.push(decode(part));
    }
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  if (plain.length) return plain.join('\n');
  return html
    .join('\n')
    .replace(/<(?:style|script)\b[\s\S]*?<\/(?:style|script)>/gi, ' ')
    .replace(/<(?:br|\/(?:p|div|tr|li|td|th)|(?:p|div|tr|td|th)\b)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n');
}

// El servicio avanzado de Gmail entrega el cuerpo como bytes o como base64url
// sin relleno "=", que Utilities no acepta tal cual.
function decode(part) {
  const data = part.body.data;
  let bytes;
  if (Array.isArray(data)) {
    bytes = data;
  } else {
    const text = String(data).replace(/\s/g, '');
    bytes = Utilities.base64DecodeWebSafe(text + '='.repeat((4 - (text.length % 4)) % 4));
  }
  return Utilities.newBlob(bytes).getDataAsString(charsetOf(part));
}

function charsetOf(part) {
  const header = (part.headers || []).find(
    (item) => String(item.name).toLowerCase() === 'content-type',
  );
  const charset = header && String(header.value).match(/charset="?([\w-]+)"?/i);
  const name = charset ? charset[1].toUpperCase() : 'UTF-8';
  return ['UTF-8', 'ISO-8859-1', 'WINDOWS-1252', 'US-ASCII'].includes(name) ? name : 'UTF-8';
}
