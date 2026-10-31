import { describe, expect, it } from 'vitest';
import { transactionPatchSchema, transactionSchema, validate } from '../schemas.js';

const base = { type: 'gasto', amount: 15000, category: 'Alimentación', date: '2026-10-30' };

describe('transactionSchema', () => {
  it('acepta un gasto válido y conserva campos antiguos', () => {
    const r = validate(transactionSchema, { ...base, meta: { debtId: 'd1' }, owner: 'legacy' });
    expect(r.ok).toBe(true);
    expect(r.data.owner).toBe('legacy');
  });

  it('quita campos que solo pone el sistema', () => {
    const r = validate(transactionSchema, { ...base, id: 'x', updatedBy: 'otro' });
    expect(r.ok).toBe(true);
    expect(r.data.id).toBeUndefined();
    expect(r.data.updatedBy).toBeUndefined();
  });

  it.each([
    [{ amount: -1 }, 'amount'],
    [{ amount: Number.NaN }, 'amount'],
    [{ type: 'transferencia' }, 'type'],
    [{ category: '  ' }, 'category'],
    [{ category: undefined }, 'category'],
    [{ date: '30/10/2026' }, 'date'],
  ])('rechaza %o', (patch, field) => {
    const r = validate(transactionSchema, { ...base, ...patch });
    expect(r.ok).toBe(false);
    expect(r.message).toContain(field);
  });

  it('el patch parcial no inventa campos', () => {
    const r = validate(transactionPatchSchema, { amount: 2000 });
    expect(r).toEqual({ ok: true, data: { amount: 2000 } });
  });
});

describe('ingresos', () => {
  it('se aceptan sin categoría', () => {
    const r = validate(transactionSchema, { type: 'ingreso', amount: 900000, category: '', date: '2026-10-01' });
    expect(r.ok).toBe(true);
  });
});
