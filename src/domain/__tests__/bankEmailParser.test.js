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

  it('accepts amounts in tables and dates written in words or taken from reception', () => {
    const fare = {
      subject: 'Notificación de cobro pasaje',
      body: 'Se realizó un cobro de pasaje\nMonto\n$1.790\nTarjeta CuentaRUT',
      receivedAt: '2026-11-05T09:45:00.000Z',
    };
    expect(
      validateAiBankEmailMovement(fare, {
        hasMovement: true,
        type: 'gasto',
        amount: 1790,
        date: '2026-11-05',
        description: 'Pasaje Red',
      }),
    ).toMatchObject({ amount: 1790, date: '2026-11-05', description: 'Pasaje Red' });

    const purchase = {
      body: 'Compra en UNIMARC SAN JOAQUIN por $12.290,00 el 7 de noviembre de 2026',
    };
    expect(
      validateAiBankEmailMovement(purchase, {
        hasMovement: true,
        type: 'gasto',
        amount: 12290,
        date: '2026-11-07',
        description: 'Compra UNIMARC SAN JOAQUIN',
      }),
    ).toMatchObject({ amount: 12290, date: '2026-11-07' });
    expect(() =>
      validateAiBankEmailMovement(purchase, {
        hasMovement: true,
        type: 'gasto',
        amount: 12290,
        date: '2026-11-06',
        description: 'Compra',
      }),
    ).toThrow('no coinciden');
  });

  it('handles Santander transfer receipts without colons', () => {
    const email = {
      subject: 'Comprobante Transferencia de fondos',
      body: `Te informamos que, con fecha 04/11/2026 se ha realizado una transferencia.
Monto transferido
$ 60.000
Datos de origen
Nombre
Persona Origen
Nº de cuenta
0-000-12-34567-8
Datos de destino
Nombre
Fulana Pérez
RUT
12.345.678-9
Banco
Banco BICE
Nº de cuenta 987654321
Comentario
almuerzo`,
    };

    const forAI = sanitizeBankEmailForAI(email);
    expect(forAI).toContain('$ 60.000');
    expect(forAI).toContain('04/11/2026');
    expect(forAI).not.toContain('Fulana');
    expect(forAI).not.toContain('Persona Origen');
    expect(forAI).not.toContain('34567');
    expect(forAI).not.toContain('987654321');
    expect(forAI).not.toContain('12.345.678-9');

    expect(
      validateAiBankEmailMovement(email, {
        hasMovement: true,
        type: 'gasto',
        amount: 60000,
        date: '2026-11-04',
        description: 'Transferencia a Banco BICE',
      }),
    ).toMatchObject({ amount: 60000, description: 'Transferencia a Fulana Pérez' });
    expect(
      validateAiBankEmailMovement(email, {
        hasMovement: true,
        type: 'ingreso',
        amount: 60000,
        date: '2026-11-04',
        description: 'Transferencia recibida',
      }).description,
    ).toBe('Transferencia de Persona Origen');
  });

  it('names the transfer recipient without sending it to AI', () => {
    const email = {
      subject: 'Aviso de envío o recepción de dinero',
      body: `Monto transferido: $20.000
Fecha y Hora de TEF : 04/11/2026 21:50:10
Hacia:
Nombre : Fulana Pérez
Banco : Banco Santander
N° de cuenta : 74930000`,
    };
    expect(sanitizeBankEmailForAI(email)).not.toContain('Fulana');
    expect(
      validateAiBankEmailMovement(email, {
        hasMovement: true,
        type: 'gasto',
        amount: 20000,
        date: '2026-11-04',
        description: 'Transferencia Electronica a tercero',
      }).description,
    ).toBe('Transferencia a Fulana Pérez');
  });
});
