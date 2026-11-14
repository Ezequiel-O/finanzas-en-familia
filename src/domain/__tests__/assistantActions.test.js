import { describe, expect, it } from 'vitest';
import { balanceAdjustment, validateAssistantActions } from '../assistantActions.js';
import { validateAiBankEmailMovement } from '../bankEmailParser.js';
import { findSimilarTransactions } from '../similarTransactions.js';

const accounts = [
  { id: 'bancoestado', name: 'BancoEstado', anchorBalance: 100000, anchorDate: '2026-11-01', anchoredAt: '2026-11-01T00:00:00Z' },
  { id: 'efectivo', name: 'Efectivo', kind: 'cash', anchorBalance: 20000, anchorDate: '2026-11-01', anchoredAt: '2026-11-01T00:00:00Z' },
];
const budgetsAll = {
  '2026-11': { Supermercado: { breakdown: [{ id: 's1', name: 'Súper', amount: 100 }] } },
};
const transactions = [
  { id: 'a', type: 'gasto', amount: 5000, date: '2026-11-05', category: 'Supermercado', description: 'Lider', meta: { budgetSubcategoryName: 'Viejo' } },
  { id: 'g', type: 'gasto', amount: 20000, date: '2026-11-06', category: 'Otros', description: 'Giro en cajero', account: 'bancoestado' },
  { id: 'd', type: 'gasto', amount: 9000, date: '2026-11-07', category: 'Deudas', description: 'Cuota' },
];
const ctx = {
  transactions,
  categories: ['Supermercado', 'Otros', 'Deudas'],
  budgetsAll,
  cutDay: 1,
  accounts,
  today: '2026-11-14',
};

describe('validateAssistantActions', () => {
  it('builds the exact patch for valid proposals', () => {
    const actions = validateAssistantActions(
      [
        { tipo: 'asignar_subcategoria', id: 'a', categoria: 'Supermercado', subcategoria: 'super', motivo: 'Como antes' },
        { tipo: 'asignar_cuenta', id: 'a', cuenta: 'efectivo', motivo: 'x' },
        { tipo: 'convertir_en_giro', id: 'g', desde: 'bancoestado', hacia: 'efectivo', motivo: 'Es un giro' },
      ],
      ctx,
    );
    expect(actions.map((a) => a.kind)).toEqual(['asignar_subcategoria', 'asignar_cuenta', 'convertir_en_giro']);
    expect(actions[0].patch).toEqual({
      category: 'Supermercado',
      meta: { budgetSubcategoryIds: ['s1'], budgetSubcategoryNames: 'Súper' },
    });
    expect(actions[2].patch).toEqual({
      category: 'Traspaso',
      account: null,
      meta: { kind: 'transfer', fromAccount: 'bancoestado', toAccount: 'efectivo' },
    });
  });

  it('drops proposals that do not match the household data', () => {
    expect(
      validateAssistantActions(
        [
          { tipo: 'asignar_subcategoria', id: 'no-existe', categoria: 'Supermercado', subcategoria: 'Súper' },
          { tipo: 'asignar_subcategoria', id: 'a', categoria: 'Supermercado', subcategoria: 'Inventada' },
          { tipo: 'asignar_subcategoria', id: 'd', categoria: 'Supermercado', subcategoria: 'Súper' },
          { tipo: 'asignar_cuenta', id: 'g', cuenta: 'efectivo' },
          { tipo: 'convertir_en_giro', id: 'g', desde: 'efectivo', hacia: 'efectivo' },
          { tipo: 'borrar_todo', id: 'a' },
        ],
        ctx,
      ),
    ).toEqual([]);
  });
});

describe('balanceAdjustment', () => {
  it('computes the adjustment after the other corrections', () => {
    // Sin correcciones: cuentas 80.000 + 20.000; la app calcula −34.000.
    const before = balanceAdjustment([], ctx);
    expect(before.delta).toBe(100000 + 34000);
    expect(before.transaction).toMatchObject({ type: 'ingreso', amount: 134000, category: 'Ajuste Balance' });
    const [giro] = validateAssistantActions(
      [{ tipo: 'convertir_en_giro', id: 'g', desde: 'bancoestado', hacia: 'efectivo' }],
      ctx,
    );
    // Con el giro: cuentas 80.000 + 40.000; la app calcula −14.000.
    expect(balanceAdjustment([giro], ctx).delta).toBe(120000 + 14000);
  });
});

describe('giros in bank emails', () => {
  const email = { subject: 'Giro en cajero automático', body: 'Giro por $20.000 el 06/11/2026' };
  const movement = {
    hasMovement: true,
    type: 'gasto',
    amount: 20000,
    date: '2026-11-06',
    description: 'Giro en cajero',
    category: 'Otros',
  };

  it('flags cash withdrawals and does not suggest an expense category', () => {
    const result = validateAiBankEmailMovement(email, movement, ['Otros']);
    expect(result.cashWithdrawal).toBe(true);
    expect(result.suggestedCategory).toBe('');
  });

  it('matches a giro against expenses when looking for duplicates', () => {
    const manual = { id: 'm', type: 'gasto', amount: 20000, date: '2026-11-06' };
    expect(findSimilarTransactions({ type: 'giro', amount: 20000, date: '2026-11-06' }, [manual])).toEqual([manual]);
  });
});
