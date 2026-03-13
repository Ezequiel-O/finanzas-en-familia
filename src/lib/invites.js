const INVITE_TOKEN_BYTES = 16;

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function generateInviteToken() {
  const bytes = new Uint8Array(INVITE_TOKEN_BYTES);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return toHex(bytes);
}

export async function hashInviteToken(token) {
  if (!token) throw new Error('Token vacio.');
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Crypto no disponible.');
  }
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}

export function buildInviteLink({
  origin,
  householdId,
  inviteId,
  token,
  invitedBy,
}) {
  const base =
    origin ||
    (typeof window !== 'undefined' ? window.location.origin : '');
  const params = new URLSearchParams({
    hid: householdId,
    invite: inviteId,
    token,
  });
  if (invitedBy) params.set('by', invitedBy);
  const path = `/invite?${params.toString()}`;
  if (!base) return path;
  return new URL(path, base).toString();
}
