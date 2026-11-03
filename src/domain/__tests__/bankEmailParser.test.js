import { describe, expect, it } from 'vitest';
import {
  parseBankEmail,
  sanitizeBankEmailForAI,
  validateAiBankEmailMovement,
} from '../bankEmailParser.js';

describe('parseBankEmail', () => {
  it('extracts an outgoing CuentaRUT transfer without using account numbers as amounts', () => {
    const result = parseBankEmail({
      subject: 'Aviso de transferencia',
      body: `Acabas de realizar una Transferencia Electronica, con los siguientes datos:
Monto transferido: $1.200.000
Desde:
Producto : CuentaRUT
N° de cuenta : 00000000000
Fecha y Hora de TEF : 29/10/2026 08:26:31
Hacia:
Nombre : Fulana
N° de cuenta : 74930000`,
    });

    expect(result).toEqual({
      amount: 1200000,
      date: '2026-10-29',
      type: 'gasto',
      description: 'Transferencia a Fulana',
    });
  });

  it('recognizes a transfer to CuentaRUT as income', () => {
    const result = parseBankEmail({
      body: `Monto transferido: $12.345
Fecha y Hora de TEF: 01/11/2026 10:30:00
Hacia:
Producto: CuentaRUT`,
    });

    expect(result?.type).toBe('ingreso');
  });

  it('extracts purchase notices using a labeled amount and date', () => {
    const result = parseBankEmail({
      subject: 'Compra con tarjeta',
      body: 'Monto de la compra: $9.990\nFecha: 02/11/2026',
    });

    expect(result).toEqual({
      amount: 9990,
      date: '2026-11-02',
      type: 'gasto',
      description: 'Compra con tarjeta',
    });
  });

  it('does not propose a movement when the amount or date is missing or invalid', () => {
    expect(
      parseBankEmail({ body: 'Fecha y Hora de TEF: 29/10/2026 08:26:31' }),
    ).toBeNull();
    expect(
      parseBankEmail({ body: 'Monto transferido: $1.200 31/02/2026' }),
    ).toBeNull();
  });

  it('redacts account identifiers from the text sent to AI', () => {
    const text = sanitizeBankEmailForAI({
      subject: 'Aviso para user@example.com',
      body: 'Monto transferido: $1.200.000 Nombre: Fulana N° de cuenta: 123456789 RUT: 12.345.678-9 Fecha: 29/10/2026',
    });

    expect(text).toContain('$1.200.000');
    expect(text).toContain('29/10/2026');
    expect(text).not.toContain('Fulana');
    expect(text).not.toContain('user@example.com');
    expect(text).not.toContain('123456789');
    expect(text).not.toContain('12.345.678-9');
  });

  it('accepts AI fields only when amount and date are present in the email', () => {
    const email = {
      body: 'Monto transferido: $1.200.000\nFecha y Hora de TEF: 29/10/2026 08:26:31',
    };

    expect(
      validateAiBankEmailMovement(
        email,
        {
          hasMovement: true,
          type: 'gasto',
          amount: 1200000,
          date: '2026-10-29',
          description: 'Transferencia',
          category: 'Otros',
        },
        ['Otros'],
      ),
    ).toEqual({
      type: 'gasto',
      amount: 1200000,
      date: '2026-10-29',
      description: 'Transferencia',
      suggestedCategory: 'Otros',
    });
    expect(() =>
      validateAiBankEmailMovement(email, {
        hasMovement: true,
        type: 'gasto',
        amount: 1200001,
        date: '2026-10-29',
        description: 'Transferencia',
      }),
    ).toThrow('no coinciden');
    expect(() =>
      validateAiBankEmailMovement(email, {
        hasMovement: true,
        type: 'gasto',
        amount: 1200000,
        date: '2026-10-28',
        description: 'Transferencia',
      }),
    ).toThrow('no coinciden');
  });
});
