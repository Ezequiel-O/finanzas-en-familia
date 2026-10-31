import { describe, expect, it } from 'vitest';
import { categoryBudgetStatus } from '../budgetHealth.js';
import { isAdjustment, periodBalances, periodIncomeSplit } from '../ledger.js';
import {
  dueDateInPeriod,
  fixedReason,
  isPriorityCategory,
  nextIncome,
  paymentPlan,
  PRIORITY,
} from '../paymentPlan.js';

// Escenario real: día de corte 28 (periodo 28-oct al 27-nov), hoy 31-oct.
const TODAY = '2026-10-31';
const PK = '2026-10';
const CUT_DAY = 28;

const gasto = (date, category, amount, meta) => ({ type: 'gasto', date, category, amount, ...(meta ? { meta } : {}) });
const ingreso = (date, description, amount) => ({ type: 'ingreso', date, category: 'Sueldo', description, amount });

const transactions = [
  ingreso('2026-10-30', 'Sueldo', 1255149),
  ingreso('2026-11-06', 'Faltante sueldo', 250000),
  ingreso('2026-11-24', 'SRL', 100000),
  gasto('2026-10-30', 'Deudas', 77578),
  gasto('2026-10-30', 'Hogar', 56838, { budgetSubcategoryName: 'Gastos Comunes' }),
  gasto('2026-10-30', 'Abastecimiento', 117290, { budgetSubcategoryName: 'Carnes' }),
  // Creado con la calculadora de balance y después pasado a Otros/ajustes.
  gasto('2026-10-30', 'Otros', 40869, { budgetSubcategoryName: 'ajustes', source: 'balance-calculator' }),
  gasto('2026-10-30', 'Ofrenda', 165000),
  gasto('2026-10-31', 'Servicios', 10000, { budgetSubcategoryName: 'Internet' }),
];

const budgetsAll = {
  [PK]: {
    Hogar: 510838,
    Ofrenda: 165000,
    Servicios: 141460,
    Abastecimiento: 367290,
    Transporte: 40000,
    Salud: 0,
    Entretenimiento: 150000,
    Vestuario: 80000,
    Otros: 40869,
  },
};

const scenario = {
  today: TODAY,
  cutDay: CUT_DAY,
  transactions,
  budgetsAll,
  categories: ['Deudas', 'Ahorro', ...Object.keys(budgetsAll[PK])],
  fixedCategories: { Hogar: true, Ofrenda: true, Servicios: true },
  priorityCategories: { Hogar: true, Ofrenda: true, Abastecimiento: true, Transporte: true, Salud: true },
  // Arriendo el 5 y servicios el 3: ambos antes del ingreso del 06-nov.
  fixedDueDays: { Hogar: 5, Servicios: 3 },
};

describe('escenario real: Qué hacer hoy', () => {
  const plan = paymentPlan(scenario);

  it('plata a hoy y por recibir', () => {
    expect(plan.cash).toBe(787574);
    expect(plan.projection.upcoming).toBe(350000);
    expect(plan.income).toEqual({ date: '2026-11-06', amount: 250000, isEstimated: false });
    expect(plan.days).toBe(6);
    expect(plan.daysLeftInPeriod).toBe(28);
  });

  it('1. un gasto fijo prioritario es un pago único, no un gasto diario', () => {
    const hogar = plan.items.find((i) => i.name === 'Hogar');
    expect(hogar).toMatchObject({ kind: 'fixed', pending: 454000, dueDate: '2026-11-05', when: 'antes', action: 'pay' });
    expect(plan.essentials.some((e) => e.category === 'Hogar')).toBe(false);
  });

  it('2. no reserva para categorías ya pagadas o sin disponible', () => {
    const names = plan.essentials.map((e) => e.category);
    expect(names).not.toContain('Ofrenda');
    expect(names).not.toContain('Salud');
    expect(plan.items.some((i) => i.name === 'Ofrenda')).toBe(false);
  });

  it('3. el monto diario es disponible ÷ días que quedan del periodo', () => {
    // Abastecimiento: 367.290 − 117.290 = 250.000 / 28 días; Transporte: 40.000 / 28.
    expect(plan.essentials).toEqual([
      { category: 'Abastecimiento', available: 250000, daily: 8929, reserve: 53571 },
      { category: 'Transporte', available: 40000, daily: 1429, reserve: 8571 },
    ]);
    expect(plan.reserve).toBe(62142);
  });

  it('4. pagos con fecha: antes del ingreso, y los fijos aunque no sean prioridad', () => {
    expect(plan.payToday).toEqual([]);
    expect(plan.beforeIncome.map((i) => [i.name, i.pending, i.dueDate])).toEqual([
      ['Servicios', 131460, '2026-11-03'],
      ['Hogar', 454000, '2026-11-05'],
    ]);
    expect(plan.missingDueDates).toEqual([]);
    expect(plan.freeUntilIncome).toBe(787574 - 62142 - 585460);
  });

  it('7. proyección al cierre del periodo', () => {
    expect(plan.projection).toMatchObject({
      fixedPending: 585460,
      commitmentsPending: 0,
      // Abastecimiento 250.000 + Transporte 40.000 + Entretenimiento 150.000 + Vestuario 80.000 (Otros queda en 0).
      variableAvailable: 520000,
      closing: 32114,
      cuts: [],
    });
  });
});

describe('4. fechas de vencimiento de los gastos fijos', () => {
  it('sin fecha: se cuenta antes del ingreso y se pide definirla', () => {
    const plan = paymentPlan({ ...scenario, fixedDueDays: {} });
    expect(plan.missingDueDates).toEqual(['Hogar', 'Servicios']);
    expect(plan.payToday).toEqual([]);
    expect(plan.beforeIncome.every((i) => i.missingDueDate && i.dueDate === '')).toBe(true);
  });

  it('"Paga hoy" es solo lo vencido o que vence hoy; lo posterior al ingreso queda después', () => {
    const plan = paymentPlan({ ...scenario, fixedDueDays: { Servicios: 31, Hogar: 20 } });
    expect(plan.payToday.map((i) => [i.name, i.dueDate])).toEqual([['Servicios', '2026-10-31']]);
    expect(plan.afterIncome.map((i) => [i.name, i.dueDate, i.action])).toEqual([['Hogar', '2026-11-20', 'later']]);
    expect(plan.freeUntilIncome).toBe(787574 - 62142 - 131460);
  });

  it('ubica el día dentro del periodo, también en meses cortos', () => {
    expect(dueDateInPeriod('2026-10', 5, 28)).toBe('2026-11-05');
    expect(dueDateInPeriod('2026-10', 30, 28)).toBe('2026-10-30');
    expect(dueDateInPeriod('2027-01', 31, 28)).toBe('2027-01-31');
    expect(dueDateInPeriod('2027-01', 30, 1)).toBe('2027-01-30');
    expect(dueDateInPeriod('2027-02', 30, 1)).toBe('2027-02-28');
  });
});

describe('fechas por subcategoría y aviso según lo que es cada pago', () => {
  const servicios = {
    breakdown: [
      { id: 'luz', name: 'Luz', amount: 40000 },
      { id: 'agua', name: 'Agua', amount: 30000 },
      { id: 'internet', name: 'Internet', amount: 71460 },
    ],
  };
  const withSubs = {
    ...scenario,
    budgetsAll: { [PK]: { ...budgetsAll[PK], Servicios: servicios } },
    // Servicios vence el 3 por defecto; la luz el 10 (después del ingreso del 06-nov).
    fixedDueDays: { Hogar: 5, Servicios: 3, 'Servicios::luz': 10 },
  };

  it('cada subcategoría es un pago con su fecha (o la de la categoría)', () => {
    const plan = paymentPlan(withSubs);
    const servicios = plan.items.filter((i) => i.category === 'Servicios');
    expect(servicios.map((i) => [i.name, i.pending, i.dueDate, i.when])).toEqual([
      ['Servicios · Agua', 30000, '2026-11-03', 'antes'],
      ['Servicios · Internet', 61460, '2026-11-03', 'antes'],
      ['Servicios · Luz', 40000, '2026-11-10', 'despues'],
    ]);
    // El total pendiente de Servicios no cambia: 131.460.
    expect(plan.projection.fixedPending).toBe(585460);
    expect(plan.projection.closing).toBe(32114);
  });

  it('un gasto sin subcategoría se descuenta de la subcategoría más grande', () => {
    const plan = paymentPlan({
      ...withSubs,
      transactions: [...transactions, gasto('2026-10-31', 'Servicios', 5000)],
    });
    const internet = plan.items.find((i) => i.name === 'Servicios · Internet');
    expect(internet.pending).toBe(56460);
    expect(plan.items.filter((i) => i.category === 'Servicios').reduce((s, i) => s + i.pending, 0)).toBe(126460);
  });

  it('el aviso depende de cada gasto fijo', () => {
    const plan = paymentPlan(withSubs);
    expect(plan.items.find((i) => i.name === 'Hogar').reason).toBe('Atrasarse genera multa o intereses');
    expect(plan.items.find((i) => i.name === 'Servicios · Agua').reason).toBe('Si se atrasa, pueden cortar el servicio');
    expect(fixedReason('Hogar', 'Gastos Comunes')).toBe('Atrasarse genera multa o intereses');
    expect(fixedReason('Hogar', 'Luz')).toBe('Si se atrasa, pueden cortar el servicio');
    expect(fixedReason('Ofrenda')).toBe('Compromiso fijo del mes');
    expect(fixedReason('Mascotas')).toBe('Gasto fijo del mes');
  });
});

describe('5. ingresos futuros no cuentan como recibidos', () => {
  it('separa recibido y por recibir', () => {
    expect(periodIncomeSplit({ transactions, periodKey: PK, cutDay: CUT_DAY, today: TODAY })).toEqual({
      received: 1255149,
      upcoming: 350000,
    });
  });

  it('el saldo a comparar con las cuentas reales es el de hoy; el proyectado va aparte', () => {
    expect(periodBalances({ transactions, periodKey: PK, cutDay: CUT_DAY, today: TODAY })).toEqual({
      asOf: TODAY,
      atToday: 787574,
      projected: 1137574,
    });
  });

  it('en un periodo pasado ambos saldos son el del cierre', () => {
    const b = periodBalances({ transactions, periodKey: PK, cutDay: CUT_DAY, today: '2026-12-15' });
    expect(b).toEqual({ asOf: '2026-11-27', atToday: 1137574, projected: 1137574 });
  });
});

describe('6. un ajuste con categoría real suma a esa categoría', () => {
  it('Otros/ajustes cuenta como gasto de Otros', () => {
    const otros = categoryBudgetStatus({ budgetsAll, transactions, cutDay: CUT_DAY, category: 'Otros', periodKey: PK });
    expect(otros).toEqual({ funded: 40869, spent: 40869, remaining: 0 });
  });

  it('solo es ajuste lo que está en "Ajuste Balance" o no tiene categoría', () => {
    expect(isAdjustment({ category: 'Ajuste Balance' })).toBe(true);
    expect(isAdjustment({ meta: { kind: 'adjustment' } })).toBe(true);
    expect(isAdjustment({ category: 'Otros', meta: { source: 'balance-calculator' } })).toBe(false);
  });
});

describe('7. proyección negativa', () => {
  it('alerta y sugiere recortar primero lo no prioritario', () => {
    const plan = paymentPlan({
      ...scenario,
      budgetsAll: { [PK]: { ...budgetsAll[PK], Entretenimiento: 300000 } },
    });
    expect(plan.projection.closing).toBe(32114 - 150000);
    expect(plan.projection.cuts).toEqual([{ category: 'Entretenimiento', available: 300000, cut: 117886 }]);
    expect(plan.projection.uncovered).toBe(0);
  });
});

describe('nextIncome', () => {
  it('sin ingreso registrado, supone el inicio del próximo periodo con el ingreso esperado', () => {
    expect(nextIncome({ transactions: [], today: '2026-11-05', cutDay: 1, expectedIncome: 800000 })).toEqual({
      date: '2026-12-01',
      amount: 800000,
      isEstimated: true,
    });
  });
});

describe('reparto con poca plata', () => {
  const quota = (id, dueDate, plannedAmount) => ({ id, periodKey: dueDate.slice(0, 7), dueDate, plannedAmount });
  const base = {
    today: '2026-11-05',
    cutDay: 1,
    categories: ['Alimentación'],
    budgetsAll: { '2026-11': { 'Alimentación': 260000 } },
    transactions: [ingreso('2026-11-01', 'Sueldo', 300000), ingreso('2026-11-30', 'Sueldo', 900000)],
    debts: [
      { id: 'tc', name: 'Tarjeta', rateAPR: 30, schedule: [quota('tc1', '2026-11-05', 60000)] },
      { id: 'fam', name: 'Préstamo familia', rateAPR: 0, schedule: [quota('f1', '2026-11-20', 25000)] },
      { id: 'sub', name: 'Streaming', isSubscription: true, schedule: [quota('s1', '2026-11-25', 15000)] },
    ],
  };

  it('paga por prioridad, abona deudas y pausa suscripciones', () => {
    const plan = paymentPlan(base);
    // 260.000 / 26 días = 10.000 × 25 = 250.000 de reserva; quedan 50.000.
    expect(plan.reserve).toBe(250000);
    expect(plan.items.map((i) => [i.name, i.priority, i.when, i.action, i.payNow])).toEqual([
      ['Tarjeta', PRIORITY.INTEREST, 'hoy', 'partial', 50000],
      ['Préstamo familia', PRIORITY.NO_INTEREST, 'antes', 'wait', 0],
      ['Streaming', PRIORITY.SUBSCRIPTION, 'antes', 'wait', 0],
    ]);
  });

  it('si no alcanza para lo prioritario, no manda a pagar nada', () => {
    const plan = paymentPlan({ ...base, transactions: [ingreso('2026-11-01', 'Sueldo', 200000), base.transactions[1]] });
    expect(plan.isShort).toBe(true);
    expect(plan.payNowTotal).toBe(0);
  });

  it('una prioritaria sin presupuesto usa el promedio de los últimos 90 días', () => {
    const plan = paymentPlan({
      ...base,
      budgetsAll: {},
      transactions: [...base.transactions, gasto('2026-09-15', 'Alimentación', 900000)],
    });
    expect(plan.essentials).toEqual([{ category: 'Alimentación', available: null, daily: 10000, reserve: 250000 }]);
  });
});

describe('isPriorityCategory', () => {
  it('la marca guardada manda sobre el nombre; las del sistema nunca son prioridad', () => {
    expect(isPriorityCategory('Abastecimiento')).toBe(true);
    expect(isPriorityCategory('Hogar')).toBe(false);
    expect(isPriorityCategory('Hogar', { Hogar: true })).toBe(true);
    expect(isPriorityCategory('Salud', { Salud: false })).toBe(false);
    expect(isPriorityCategory('Deudas', { Deudas: true })).toBe(false);
  });
});
