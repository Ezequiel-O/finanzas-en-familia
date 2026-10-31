import { describe, expect, it } from 'vitest';
import { canISpend, safeSpendPlan } from '../safeSpend.js';

// Escenario real: día de corte 28 (periodo 28-oct al 27-nov), hoy 31-oct.
const TODAY = '2026-10-31';
const PK = '2026-10';

const gasto = (date, category, amount, meta) => ({ type: 'gasto', date, category, amount, ...(meta ? { meta } : {}) });
const ingreso = (date, description, amount) => ({ type: 'ingreso', date, category: 'Sueldo', description, amount });

const transactionsWith = (sueldo) => [
  ingreso('2026-10-30', 'Sueldo', sueldo),
  ingreso('2026-11-06', 'Faltante sueldo', 250000),
  ingreso('2026-11-24', 'SRL', 100000),
  gasto('2026-10-30', 'Deudas', 77578, { debtId: 'tc', debtQuotaIds: ['q1'], debtQuotaDebtIds: { q1: 'tc' } }),
  gasto('2026-10-30', 'Hogar', 56838, { budgetSubcategoryName: 'Gastos Comunes' }),
  gasto('2026-10-30', 'Abastecimiento', 117290, { budgetSubcategoryName: 'Carnes' }),
  gasto('2026-10-30', 'Otros', 40869, { budgetSubcategoryName: 'ajustes', source: 'balance-calculator' }),
  gasto('2026-10-30', 'Ofrenda', 165000),
  gasto('2026-10-31', 'Servicios', 10000, { budgetSubcategoryName: 'Internet' }),
];

const scenario = {
  today: TODAY,
  cutDay: 28,
  transactions: transactionsWith(1255149),
  debts: [
    { id: 'tc', name: 'Tarjeta', rateAPR: 30, schedule: [{ id: 'q1', periodKey: PK, dueDate: '2026-10-30', plannedAmount: 77578 }] },
  ],
  budgetsAll: {
    [PK]: {
      Hogar: {
        breakdown: [
          { id: 'arriendo', name: 'Arriendo casa', amount: 454000 },
          { id: 'gc', name: 'Gastos Comunes', amount: 56838 },
        ],
      },
      Ofrenda: 165000,
      Servicios: {
        breakdown: [
          { id: 'luz', name: 'Luz', amount: 40000 },
          { id: 'agua', name: 'Agua', amount: 30000 },
          { id: 'gas', name: 'Gas', amount: 20000 },
          { id: 'internet', name: 'Internet', amount: 41460 },
          { id: 'fono', name: 'Teléfono', amount: 10000 },
        ],
      },
      Abastecimiento: 367290,
      Transporte: 40000,
      Salud: 0,
      Entretenimiento: 150000,
      Vestuario: 80000,
      Otros: 40869,
    },
  },
  categories: ['Deudas', 'Ahorro', 'Hogar', 'Ofrenda', 'Servicios', 'Abastecimiento', 'Transporte', 'Salud', 'Entretenimiento', 'Vestuario', 'Otros'],
  fixedCategories: { Hogar: true, Ofrenda: true, Servicios: true },
  priorityCategories: { Abastecimiento: true, Transporte: true, Salud: true },
  fixedDueDays: {
    'Hogar::arriendo': 1,
    'Hogar::gc': 5,
    'Servicios::luz': 10,
    'Servicios::agua': 12,
    'Servicios::gas': 15,
    'Servicios::internet': 20,
    'Servicios::fono': 22,
  },
};

describe('gasto seguro hoy: escenario real', () => {
  const s = safeSpendPlan(scenario);

  it('gasto prioritario diario = disponible de prioritarias no fijas ÷ días que quedan', () => {
    // (250.000 + 40.000) / 28
    expect(Math.round(s.priorityDaily)).toBe(10357);
  });

  it('tramos según las fechas de ingreso', () => {
    expect(s.tramos).toEqual([
      { start: '2026-10-31', end: '2026-11-06', days: 6, incomeIn: 0, billsIn: 454000, priorityIn: 62143, balance: 271431 },
      { start: '2026-11-06', end: '2026-11-24', days: 18, incomeIn: 250000, billsIn: 131460, priorityIn: 186429, balance: 203543 },
      { start: '2026-11-24', end: '2026-11-28', days: 4, incomeIn: 100000, billsIn: 0, priorityIn: 41429, balance: 262114 },
    ]);
  });

  it('gasto seguro = el menor saldo acumulado; margen del mes', () => {
    expect(s.safeToday).toBe(203543);
    expect(s.tightest.start).toBe('2026-11-06');
    expect(s.shortDate).toBe('2026-11-23');
    expect(s.level).toBe('green');
    expect(s.margin).toBe(32114);
  });

  it('qué pagar y cuándo: antes del próximo ingreso y después', () => {
    expect(s.payBeforeIncome.map((i) => [i.dueDate, i.subName, i.pending])).toEqual([['2026-11-01', 'Arriendo casa', 454000]]);
    expect(s.payAfterIncome).toHaveLength(5);
    expect(s.payAfterIncome.reduce((sum, i) => sum + i.pending, 0)).toBe(131460);
  });

  it('fin de mes: ingresos, presupuesto y nivel (margen bajo el 3 % de los ingresos)', () => {
    expect(s.monthIncome).toBe(1605149);
    expect(s.upcoming).toBe(350000);
    expect(s.budgetTotal).toBe(1573035);
    expect(s.monthLevel).toBe('yellow');
  });
});

describe('niveles de "Hoy"', () => {
  it('rojo: el tramo más justo queda negativo; sugiere postergar lo que no corta un servicio', () => {
    const s = safeSpendPlan({ ...scenario, transactions: transactionsWith(900000) });
    expect(s.level).toBe('red');
    expect(s.safeToday).toBe(0);
    expect(s.shortfall).toBe(151606);
    expect(s.shortDate).toBe('2026-11-23');
    expect(s.postpone.subName).toBe('Arriendo casa');
  });

  it('amarillo: alcanza, pero para menos de 7 días de gasto prioritario', () => {
    const s = safeSpendPlan({ ...scenario, transactions: transactionsWith(1105149) });
    expect(s.safeToday).toBe(53543);
    expect(s.level).toBe('yellow');
  });
});

describe('¿Puedo gastar esto?', () => {
  const s = safeSpendPlan(scenario);

  it('sí, dentro del presupuesto de la categoría', () => {
    expect(canISpend(s, { amount: 100000, category: 'Entretenimiento' })).toEqual({ answer: 'si_presupuesto' });
  });

  it('sí, pero baja el margen del mes', () => {
    expect(canISpend(s, { amount: 20000 })).toEqual({ answer: 'si_margen', amount: 12114 });
  });

  it('no: faltaría para lo necesario en el tramo más justo', () => {
    expect(canISpend(s, { amount: 250000, category: 'Entretenimiento' })).toEqual({
      answer: 'no_tramo',
      date: '2026-11-23',
      amount: 46457,
    });
  });

  it('no: déficit a fin de mes', () => {
    expect(canISpend(s, { amount: 50000 })).toEqual({ answer: 'no_margen', amount: 17886 });
  });
});
