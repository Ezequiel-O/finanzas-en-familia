import { describe, expect, it, vi } from 'vitest';

vi.mock('../../firebase.js', () => ({ appCheckConfigured: true }));
vi.mock('../generate.js', () => ({ GEMINI_MODEL: 'test', generateWithRetry: vi.fn() }));

const { createAssistantContext } = await import('../financialAssistant.js');
const { parseIntent } = await import('../intentParser.js');

describe('parseIntent', () => {
  const context = { categories: ['Supermercado'], transactions: [] };

  it('sends questions and analysis requests to the assistant', () => {
    expect(parseIntent('¿Por qué tengo un gasto de 15000 en Supermercado?', context).type).toBe(
      'question',
    );
    expect(parseIntent('Cuadra mis cuentas y ajusta lo que falte', context).type).toBe('question');
    expect(parseIntent('cuanto gaste en supermercado', context).type).toBe('question');
  });

  it('still prepares an action for direct instructions', () => {
    expect(parseIntent('Agregar gasto 12000 en Supermercado', context).type).toBe('plan');
  });
});

describe('createAssistantContext', () => {
  const budgetsAll = {
    '2026-11': {
      Supermercado: { breakdown: [{ id: 's1', name: 'Súper', amount: 100000 }] },
    },
  };
  const transactions = [
    {
      id: 'a',
      type: 'gasto',
      amount: 30000,
      date: '2026-11-05',
      category: 'Supermercado',
      description: 'Unimarc RUT 12.345.678-9',
      account: 'bancoestado',
      ownerId: 'u1',
      meta: { budgetSubcategoryIds: ['s1'], budgetSubcategoryNames: 'Súper' },
    },
    { id: 'b', type: 'gasto', amount: 8000, date: '2026-11-06', category: 'Supermercado', description: 'Lider' },
    { id: 'c', type: 'ingreso', amount: 900000, date: '2026-09-01', category: 'Ingresos', description: 'Sueldo' },
    { id: 'old', type: 'gasto', amount: 1, date: '2026-01-01', category: 'Supermercado', description: 'Viejo' },
  ];

  const context = createAssistantContext({
    periodKey: '2026-11',
    transactions,
    budgetsAll,
    categories: ['Supermercado'],
    accounts: [{ id: 'bancoestado', name: 'BancoEstado', anchorBalance: 500000, anchorDate: '2026-11-01' }],
    members: [{ id: 'u1', name: 'Ezequiel Ortiz' }],
    today: '2026-11-14',
  });

  it('includes the movements of the last three periods with masked descriptions', () => {
    expect(context.movimientos.map((m) => m.id)).toEqual(['c', 'a', 'b']);
    const first = context.movimientos.find((m) => m.id === 'a');
    expect(first).toMatchObject({
      subcategoria: 'Súper',
      cuenta: 'BancoEstado',
      quien: 'Ezequiel',
    });
    expect(first.descripcion).not.toContain('12.345.678-9');
  });

  it('reports subcategory spending and what to review', () => {
    expect(context.presupuestos[0].subcategorias).toEqual([
      { nombre: 'Súper', presupuestado: 100000, gastado: 30000 },
    ]);
    expect(context.presupuestos[0].gastadoSinSubcategoria).toBe(8000);
    expect(context.revisar.gastosSinSubcategoria).toEqual(['b']);
  });

  it('includes the account reconciliation', () => {
    expect(context.cuadratura.cuentas[0]).toMatchObject({
      nombre: 'BancoEstado',
      saldoRealAnotado: 500000,
    });
    expect(typeof context.cuadratura.diferencia).toBe('number');
  });
});
