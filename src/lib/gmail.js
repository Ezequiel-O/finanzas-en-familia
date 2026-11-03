const GMAIL_SENDERS = new Set([
  'notificaciones@correo.bancoestado.cl',
  'noreply@correo.bancoestado.cl',
]);
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GOOGLE_IDENTITY_SCRIPT = 'https://accounts.google.com/gsi/client';
let identityScriptPromise;

function loadGoogleIdentity() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (identityScriptPromise) return identityScriptPromise;

  identityScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GOOGLE_IDENTITY_SCRIPT;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.google?.accounts?.oauth2) resolve();
      else reject(new Error('Google no pudo iniciar la autorización de Gmail.'));
    };
    script.onerror = () => {
      identityScriptPromise = null;
      reject(new Error('No se pudo cargar la autorización de Google.'));
    };
    document.head.appendChild(script);
  });

  return identityScriptPromise;
}

function requestAccessToken(clientId) {
  if (!window.google?.accounts?.oauth2) {
    return loadGoogleIdentity().then(() => {
      throw new Error('Google quedó listo. Vuelve a pulsar para autorizar Gmail.');
    });
  }
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GMAIL_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error('Google no autorizó el acceso de solo lectura a Gmail.'));
          return;
        }
        resolve(response.access_token);
      },
      error_callback: () => {
        reject(new Error('Se cerró o no se pudo completar la autorización de Google.'));
      },
    });
    client.requestAccessToken({ prompt: '' });
  });
}

function decodeBase64Url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function collectBodyParts(part, plainParts, htmlParts) {
  if (part?.body?.data) {
    if (part.mimeType === 'text/plain') plainParts.push(part.body.data);
    if (part.mimeType === 'text/html') htmlParts.push(part.body.data);
  }
  (part?.parts || []).forEach((child) =>
    collectBodyParts(child, plainParts, htmlParts),
  );
}

function decodeSubject(value) {
  return String(value || '').replace(
    /=\?UTF-8\?([BQ])\?([^?]+)\?=/gi,
    (encoded, format, content) => {
      try {
        if (format.toUpperCase() === 'B') return decodeBase64Url(content);
        return content
          .replace(/_/g, ' ')
          .replace(/=([0-9A-F]{2})/gi, (_, hex) =>
            String.fromCharCode(parseInt(hex, 16)),
          );
      } catch {
        return encoded;
      }
    },
  );
}

function getSender(value) {
  const address = String(value || '').match(/<([^>]+)>/)?.[1] || value;
  return String(address || '').trim().toLowerCase();
}

function extractText(payload) {
  const plainParts = [];
  const htmlParts = [];
  collectBodyParts(payload, plainParts, htmlParts);
  if (plainParts.length) {
    return plainParts.map(decodeBase64Url).join('\n');
  }
  const html = htmlParts.map(decodeBase64Url).join('\n');
  if (!html) return '';
  const withBreaks = html.replace(/<(br|\/p|\/div|\/tr|\/li)\b[^>]*>/gi, '\n');
  return new DOMParser().parseFromString(withBreaks, 'text/html').body.textContent || '';
}

async function gmailRequest(url, accessToken) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    let message = `Gmail devolvió un error (${response.status}).`;
    try {
      const error = await response.json();
      if (error?.error?.message) message = error.error.message;
    } catch {
      // Keep the HTTP status message when Gmail does not return JSON.
    }
    throw new Error(message);
  }
  return response.json();
}

export async function readBancoEstadoEmails(clientId) {
  if (!clientId) {
    throw new Error('Falta configurar VITE_GOOGLE_OAUTH_CLIENT_ID para conectar Gmail.');
  }

  const accessToken = await requestAccessToken(clientId);
  const senderQuery = Array.from(GMAIL_SENDERS, (sender) => `from:${sender}`).join(' OR ');
  const search = new URLSearchParams({
    q: senderQuery,
    maxResults: '100',
  });
  const list = await gmailRequest(`${GMAIL_API}/messages?${search}`, accessToken);
  const messageRefs = Array.isArray(list.messages) ? list.messages : [];

  const messages = [];
  for (let index = 0; index < messageRefs.length; index += 10) {
    const batch = await Promise.all(
      messageRefs.slice(index, index + 10).map(async ({ id }) => {
        const message = await gmailRequest(
          `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=full`,
          accessToken,
        );
        const headers = message.payload?.headers || [];
        const sender = getSender(
          headers.find((header) => header.name?.toLowerCase() === 'from')?.value,
        );
        if (!GMAIL_SENDERS.has(sender)) return null;
        const subject = decodeSubject(
          headers.find((header) => header.name?.toLowerCase() === 'subject')?.value,
        );
        return {
          id: message.id,
          subject,
          sender,
          body: extractText(message.payload),
        };
      }),
    );
    messages.push(...batch.filter(Boolean));
  }

  return { messages, truncated: messageRefs.length === 100 };
}

export function prepareGmailAuthorization() {
  return loadGoogleIdentity();
}
