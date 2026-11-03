import { describe, expect, it } from 'vitest';
import { parseBankEmail } from '../bankEmailParser.js';

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
});
