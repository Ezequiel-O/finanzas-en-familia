import { describe, expect, it } from 'vitest';
import {
  hashSecret,
  parseBearerToken,
  secretMatches,
  validateBankEmailPayload,
} from '../payload.js';

const SECRET = 'a'.repeat(64);

function payload(overrides = {}) {
  return {
    messageId: '18f2a3b4c5d6e7f8',
    sender: 'Notificaciones@correo.bancoestado.cl',
    subject: 'Aviso de transferencia',
    body: 'Monto transferido: $12.345\nFecha y Hora de TEF: 01/11/2026 10:30:00',
    receivedAt: '2026-11-01T13:30:00.000Z',
    senderVerified: true,
    ...overrides,
  };
}

describe('parseBearerToken', () => {
  it('reads household, member and secret from the connection key', () => {
    expect(parseBearerToken(`Bearer hh123.uid456.${SECRET}`)).toEqual({
      householdId: 'hh123',
      uid: 'uid456',
      secret: SECRET,
    });
  });

  it('rejects malformed keys', () => {
    expect(parseBearerToken('')).toBeNull();
    expect(parseBearerToken(`hh.uid.${SECRET}`)).toBeNull();
    expect(parseBearerToken(`Bearer hh.uid.${SECRET.slice(1)}`)).toBeNull();
    expect(parseBearerToken(`Bearer hh/x.uid.${SECRET}`)).toBeNull();
    expect(parseBearerToken(`Bearer hh.uid.${SECRET} extra`)).toBeNull();
  });
});

describe('secretMatches', () => {
  it('compares the secret with its stored hash', () => {
    expect(secretMatches(SECRET, hashSecret(SECRET))).toBe(true);
    expect(secretMatches(SECRET, hashSecret('b'.repeat(64)))).toBe(false);
    expect(secretMatches(SECRET, undefined)).toBe(false);
    expect(secretMatches(SECRET, 'corto')).toBe(false);
  });
});

describe('validateBankEmailPayload', () => {
  it('accepts a BancoEstado notice and normalizes the sender', () => {
    expect(validateBankEmailPayload(payload())).toMatchObject({
      messageId: '18f2a3b4c5d6e7f8',
      sender: 'notificaciones@correo.bancoestado.cl',
      receivedAt: '2026-11-01T13:30:00.000Z',
      senderVerified: true,
    });
  });

  it('redacts account data before storing the notice', () => {
    const email = validateBankEmailPayload(
      payload({
        body: 'Monto transferido: $1.200.000 Nombre: Fulana N° de cuenta: 123456789 RUT: 12.345.678-9 E-mail: user@example.com Fecha: 29/10/2026',
      }),
    );

    expect(email.body).toContain('$1.200.000');
    expect(email.body).toContain('29/10/2026');
    expect(email.body).toContain('Nombre: Fulana');
    expect(email.body).not.toContain('123456789');
    expect(email.body).not.toContain('12.345.678-9');
    expect(email.body).not.toContain('user@example.com');
  });

  it('rejects other senders, unknown fields and oversized content', () => {
    expect(validateBankEmailPayload(payload({ sender: 'alguien@otro.cl' }))).toBeNull();
    expect(validateBankEmailPayload({ ...payload(), householdId: 'otro' })).toBeNull();
    expect(validateBankEmailPayload(payload({ messageId: '../x' }))).toBeNull();
    expect(validateBankEmailPayload(payload({ body: '   ' }))).toBeNull();
    expect(validateBankEmailPayload(payload({ body: 'x'.repeat(12001) }))).toBeNull();
    expect(validateBankEmailPayload(payload({ receivedAt: 'ayer' }))).toBeNull();
    expect(validateBankEmailPayload(payload({ senderVerified: 'si' }))).toBeNull();
    expect(validateBankEmailPayload(null)).toBeNull();
    expect(validateBankEmailPayload([])).toBeNull();
  });
});
