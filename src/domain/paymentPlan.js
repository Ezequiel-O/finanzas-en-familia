// src/domain/paymentPlan.js
// Plan hasta el próximo ingreso: qué pagar hoy y qué dejar para cuando entre la plata,
// sin quedarse sin comida en los días intermedios.
//
// - Gastos FIJOS (arriendo, luz, ofrenda): lo pendiente es UN pago con fecha de vencimiento
//   (día definido en Plan, en cada subgasto fijo). Nunca se reparte por día. Si la categoría tiene
//   subcategorías (Luz, Agua, Internet), cada una es un pago con su propia fecha.
// - Categorías PRIORITARIAS no fijas (comida, transporte): se reserva por día
//   disponible ÷ días que quedan del periodo (incluido hoy), solo si queda disponible.
//
//   libre hasta el ingreso = plata a hoy − reserva diaria × días − pagos que vencen antes
//
// Los pagos se ordenan: fijos (cortan el servicio o cobran multa), cuotas con interés o
// atrasadas, cuotas sin interés, suscripciones. "Paga hoy" es solo lo vencido o que vence hoy.
// Lo que vence después del ingreso se paga con ese ingreso.
//
// Proyección al cierre del periodo:
//   plata a hoy + ingresos por recibir − fijos pendientes − cuotas/aportes pendientes
//   − disponible de las categorías variables
import { getBudgetPeriod, budgetMonthKeyForDate, shiftMonth } from '../utils/budgetPeriod.js';
import {
  getFixedCarryoverForSubcategory,
  getSubcategorySpentForPeriod,
  resolveFixedCategory,
} from '../utils/fixedBudgets.js';
import { categoryBudgetStatus } from './budgetHealth.js';
import { isSystemCategory } from './categories.js';
import { commitmentsForPeriod } from './commitments.js';
import { addDaysToKey, daysBetween, parseDateKey, toLocalDateKey, todayKey } from './dates.js';
import { cashOnHand, categorySpent, classifyTransaction, KIND, periodIncomeSplit, txDateKey } from './ledger.js';
import { toNumber } from './money.js';

// Nombres que suelen ser gasto para vivir (comida, salud, transporte), para cuando el hogar
// aún no marcó sus prioridades.
const ESSENTIAL_PATTERN =
  /aliment|comida|supermerc|mercad|feria|almac|abastec|salud|farmac|remedio|medic|transport|locomoc|bencina|combustible/i;
const FOOD_PATTERN = /aliment|comida|supermerc|mercad|feria|almac|abastec/i;

const HISTORY_DAYS = 90;
const MAX_PERIODS_AHEAD = 3;

export const PRIORITY = Object.freeze({
  FIXED: 1,
  INTEREST: 2,
  NO_INTEREST: 3,
  SUBSCRIPTION: 4,
});

export const PRIORITY_LABEL = {
  [PRIORITY.FIXED]: 'Corta el servicio o cobra multa',
  [PRIORITY.INTEREST]: 'Acumula interés si se atrasa',
  [PRIORITY.NO_INTEREST]: 'Sin interés: se puede pedir plazo',
  [PRIORITY.SUBSCRIPTION]: 'Se puede pausar',
};

export function isPriorityCategory(category, priorityCategories = {}) {
  if (isSystemCategory(category)) return false;
  if (Object.prototype.hasOwnProperty.call(priorityCategories || {}, category)) {
    return !!priorityCategories[category];
  }
  return ESSENTIAL_PATTERN.test(String(category || ''));
}

export const isFoodCategory = (category) => FOOD_PATTERN.test(String(category || ''));

// Qué pasa si un gasto fijo se atrasa, según lo que es (se mira la subcategoría y la categoría).
const FIXED_REASONS = [
  [/luz|agua|\bgas\b|electric|internet|tel[eé]fono|celular|cable|servicio/i, 'Si se atrasa, pueden cortar el servicio'],
  [/arriendo|alquiler|dividendo|hipotec|gastos? comunes|hogar|vivienda/i, 'Atrasarse genera multa o intereses'],
  [/colegio|jard[ií]n|educa|universidad|matr[ií]cula/i, 'Puede cobrar multa o interés por atraso'],
  [/seguro|isapre|fonasa|plan de salud/i, 'Si no se paga, se puede perder la cobertura'],
  [/ofrenda|diezmo|donaci|aporte/i, 'Compromiso fijo del mes'],
];

export function fixedReason(category, subcategory = '') {
  const text = `${subcategory} ${category}`;
  const match = FIXED_REASONS.find(([pattern]) => pattern.test(text));
  return match ? match[1] : 'Gasto fijo del mes';
}

// Clave del día de vencimiento: por subcategoría ("Servicios::<id>") o por categoría.
export const dueDayKey = (category, subId) => (subId ? `${category}::${subId}` : category);

function validDay(value) {
  const day = Number(value);
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : null;
}

// Próximo ingreso: el primer ingreso registrado con fecha futura. Si no hay, se supone que
// llega al inicio del próximo periodo con el ingreso esperado.
export function nextIncome({ transactions = [], today, cutDay = 1, expectedIncome = 0 }) {
  const byDate = new Map();
  (transactions || []).forEach((t) => {
    const d = txDateKey(t);
    if (!d || d <= today || classifyTransaction(t) !== KIND.INCOME) return;
    byDate.set(d, (byDate.get(d) || 0) + toNumber(t.amount));
  });
  const first = Array.from(byDate.keys()).sort()[0];
  if (first) return { date: first, amount: byDate.get(first), isEstimated: false };
  const { end } = getBudgetPeriod(budgetMonthKeyForDate(today, cutDay), cutDay);
  return { date: end, amount: toNumber(expectedIncome), isEstimated: true };
}

// Vencimiento dentro del periodo para un día del mes (si el mes es corto, su último día).
export function dueDateInPeriod(periodKey, day, cutDay = 1) {
  const { start, end } = getBudgetPeriod(periodKey, cutDay);
  const first = parseDateKey(start);
  for (let offset = 0; offset <= 1; offset += 1) {
    const y = first.getFullYear();
    const m = first.getMonth() + offset;
    const lastDay = new Date(y, m + 1, 0).getDate();
    const key = toLocalDateKey(new Date(y, m, Math.min(day, lastDay)));
    if (key >= start && key < end) return key;
  }
  return '';
}

function isFixedCategory({ category, budgetsAll, periodKey, fixedCategories }) {
  const entry = budgetsAll?.[periodKey]?.[category];
  const breakdown = Array.isArray(entry?.breakdown) ? entry.breakdown : [];
  return resolveFixedCategory({ entry, breakdown, fixedCategories, category });
}

// Lo que queda por gastar de una categoría en el periodo (nunca negativo).
function categoryAvailable({ category, budgetsAll, transactions, cutDay, periodKey, fixedCategories }) {
  const { funded, spent } = categoryBudgetStatus({ budgetsAll, transactions, cutDay, category, periodKey, fixedCategories });
  return { funded, spent, available: Math.max(0, Math.round(funded - spent)) };
}

// Promedio diario gastado en los últimos 90 días: solo para prioritarias sin presupuesto.
function historicDaily({ category, transactions, today }) {
  const from = addDaysToKey(today, -HISTORY_DAYS);
  const recent = (transactions || []).filter((t) => {
    const d = txDateKey(t);
    return d >= from && d < today;
  });
  return Math.max(0, categorySpent(recent, category)) / HISTORY_DAYS;
}

function periodsUntil(fromPk, untilDate, cutDay) {
  const lastPk = budgetMonthKeyForDate(addDaysToKey(untilDate, -1), cutDay);
  const keys = [fromPk];
  while (keys[keys.length - 1] < lastPk && keys.length < MAX_PERIODS_AHEAD) {
    keys.push(shiftMonth(keys[keys.length - 1], 1));
  }
  return keys;
}

// Gastos fijos pendientes de un periodo, como pagos únicos con su fecha de vencimiento.
// Con subcategorías, un pago por cada una (su día o, si no tiene, el de la categoría).
function fixedBills({ budgetsAll, transactions, cutDay, periodKey, fixedCategories, fixedDueDays }) {
  const entries = budgetsAll?.[periodKey] || {};
  return Object.keys(entries)
    .filter((category) => !isSystemCategory(category))
    .filter((category) => isFixedCategory({ category, budgetsAll, periodKey, fixedCategories }))
    .flatMap((category) => {
      const { available } = categoryAvailable({ category, budgetsAll, transactions, cutDay, periodKey, fixedCategories });
      if (available <= 0) return [];
      const categoryDay = validDay(fixedDueDays?.[category]);
      const bill = ({ subId = '', subName = '', pending }) => {
        const day = validDay(fixedDueDays?.[dueDayKey(category, subId)]) || categoryDay;
        const dueDate = day ? dueDateInPeriod(periodKey, day, cutDay) : '';
        return {
          key: `fixed:${category}:${subId}:${periodKey}`,
          kind: 'fixed',
          category,
          subId,
          name: subName ? `${category} · ${subName}` : category,
          detail: 'Gasto fijo',
          reason: fixedReason(category, subName),
          pending,
          dueDate,
          missingDueDate: !dueDate,
          isOverdue: false,
          rate: 0,
        };
      };

      const breakdown = Array.isArray(entries[category]?.breakdown) ? entries[category].breakdown : [];
      if (!breakdown.length) return [bill({ pending: available })];

      const subs = breakdown.map((item, idx) => {
        const subId = String(item.id || item.name || `${category}-${idx}`);
        const subName = String(item.name || '').trim();
        const carryover = getFixedCarryoverForSubcategory({
          budgetsAll,
          transactions,
          cutDay,
          category,
          fixedCategories,
          subId,
          subName,
          currentPeriodKey: periodKey,
        });
        const spent = getSubcategorySpentForPeriod({ transactions, periodKey, cutDay, category, subId, subName, breakdown });
        return bill({ subId, subName, pending: Math.max(0, Math.round(toNumber(item.amount) + carryover - spent)) });
      });
      // Si hubo gastos de la categoría sin subcategoría, lo pendiente por subcategoría puede
      // sumar más que lo disponible: se descuenta el exceso desde la subcategoría más grande.
      let excess = subs.reduce((sum, b) => sum + b.pending, 0) - available;
      [...subs]
        .sort((a, b) => b.pending - a.pending)
        .forEach((b) => {
          if (excess <= 0) return;
          const cut = Math.min(b.pending, excess);
          b.pending -= cut;
          excess -= cut;
        });
      return subs;
    })
    .filter((b) => b.pending > 0);
}

function priorityOf(item) {
  if (item.kind === 'fixed') return PRIORITY.FIXED;
  if (item.kind === 'subscription') return PRIORITY.SUBSCRIPTION;
  return item.isOverdue || item.rate > 0 ? PRIORITY.INTEREST : PRIORITY.NO_INTEREST;
}

// Cuándo toca pagar: 'hoy' (vencido o vence hoy), 'antes' del ingreso o 'despues'.
// Un fijo sin fecha se cuenta 'antes', por seguridad, y se pide definir su fecha.
function whenDue(item, today, incomeDate) {
  if (!item.dueDate) return 'antes';
  if (item.isOverdue || item.dueDate <= today) return 'hoy';
  return item.dueDate < incomeDate ? 'antes' : 'despues';
}

const byPriority = (a, b) =>
  a.priority - b.priority ||
  Number(b.isOverdue) - Number(a.isOverdue) ||
  b.rate - a.rate ||
  String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999'));

export function paymentPlan({
  transactions = [],
  debts = [],
  savings = [],
  budgetsAll = {},
  fixedCategories = {},
  priorityCategories = {},
  fixedDueDays = {},
  categories = [],
  cutDay = 1,
  expectedIncome = 0,
  today = todayKey(),
}) {
  const cash = cashOnHand(transactions, today);
  const income = nextIncome({ transactions, today, cutDay, expectedIncome });
  const days = Math.max(1, daysBetween(today, income.date));
  const periodKey = budgetMonthKeyForDate(today, cutDay);
  const { end: periodEnd } = getBudgetPeriod(periodKey, cutDay);
  const daysLeftInPeriod = Math.max(1, daysBetween(today, periodEnd));
  const ctx = { budgetsAll, transactions, cutDay, periodKey, fixedCategories };
  const allCategories = Array.from(
    new Set([...(categories || []), ...Object.keys(budgetsAll?.[periodKey] || {})]),
  ).filter((c) => !isSystemCategory(c));
  const isFixed = (category) => isFixedCategory({ category, ...ctx });

  // Reserva diaria: solo prioritarias NO fijas y con disponible.
  const essentials = allCategories
    .filter((category) => !isFixed(category) && isPriorityCategory(category, priorityCategories))
    .map((category) => {
      const hasBudget = budgetsAll?.[periodKey]?.[category] !== undefined;
      if (!hasBudget) {
        const daily = historicDaily({ category, transactions, today });
        return { category, available: null, daily: Math.round(daily), reserve: Math.round(daily * days) };
      }
      const { available } = categoryAvailable({ category, ...ctx });
      const daily = available / daysLeftInPeriod;
      return {
        category,
        available,
        daily: Math.round(daily),
        reserve: Math.min(available, Math.round(daily * days)),
      };
    })
    .filter((e) => e.reserve > 0)
    .sort((a, b) => b.reserve - a.reserve);
  const reserve = essentials.reduce((s, e) => s + e.reserve, 0);

  // Pagos: cuotas, suscripciones y gastos fijos (prioritarios o no) del periodo y de los
  // siguientes hasta el ingreso.
  const rateById = new Map((debts || []).map((d) => [d.id, toNumber(d.rateAPR)]));
  const seen = new Set();
  const bills = periodsUntil(periodKey, income.date, cutDay)
    .flatMap((pk) => [
      ...commitmentsForPeriod({ debts, savings, transactions, periodKey: pk, cutDay, today })
        .filter((i) => i.kind !== 'saving' && i.status !== 'paid')
        .map((i) => ({ ...i, rate: rateById.get(i.refId) || 0 })),
      ...fixedBills({ ...ctx, periodKey: pk, fixedDueDays }),
    ])
    .filter((i) => (seen.has(i.key) ? false : seen.add(i.key)))
    .filter((i) => i.pending > 0)
    .map((i) => ({ ...i, priority: priorityOf(i), when: whenDue(i, today, income.date) }))
    .sort(byPriority);

  // Con lo que queda después de la reserva se cubre, por prioridad, lo que vence antes del ingreso.
  const free = cash - reserve;
  let left = Math.max(0, free);
  const items = bills.map((bill) => {
    if (bill.when === 'despues') return { ...bill, action: 'later', payNow: 0 };
    if (bill.pending <= left) {
      left -= bill.pending;
      return { ...bill, action: 'pay', payNow: bill.pending };
    }
    // Un abono a una deuda baja el interés; un fijo o suscripción se paga entero o no.
    if (left > 0 && bill.kind === 'debt') {
      const payNow = left;
      left = 0;
      return { ...bill, action: 'partial', payNow };
    }
    return { ...bill, action: 'wait', payNow: 0 };
  });
  const dueBeforeIncome = items.filter((i) => i.when !== 'despues');
  const payNowTotal = dueBeforeIncome.reduce((s, i) => s + i.payNow, 0);

  // Proyección del periodo completo.
  const { upcoming } = periodIncomeSplit({ transactions, periodKey, cutDay, today });
  const fixedPending = fixedBills({ ...ctx, fixedDueDays }).reduce((s, b) => s + b.pending, 0);
  const commitmentsPending = commitmentsForPeriod({ debts, savings, transactions, periodKey, cutDay, today }).reduce(
    (s, i) => s + i.pending,
    0,
  );
  const variable = allCategories
    .filter((category) => !isFixed(category))
    .map((category) => ({ category, ...categoryAvailable({ category, ...ctx }) }))
    .filter((v) => v.available > 0);
  const variableAvailable = variable.reduce((s, v) => s + v.available, 0);
  const closing = cash + upcoming - fixedPending - commitmentsPending - variableAvailable;
  // Si no alcanza, se sugiere recortar primero lo que no es prioridad, de mayor a menor.
  const cuts = [];
  let deficit = Math.max(0, -closing);
  variable
    .filter((v) => !isPriorityCategory(v.category, priorityCategories))
    .sort((a, b) => b.available - a.available)
    .forEach((v) => {
      if (deficit <= 0) return;
      const cut = Math.min(v.available, deficit);
      deficit -= cut;
      cuts.push({ category: v.category, available: v.available, cut });
    });

  return {
    today,
    cash,
    income,
    days,
    daysLeftInPeriod,
    essentials,
    reserve,
    dailyEssentials: essentials.reduce((s, e) => s + e.daily, 0),
    free,
    items,
    payToday: items.filter((i) => i.when === 'hoy'),
    beforeIncome: items.filter((i) => i.when === 'antes'),
    afterIncome: items.filter((i) => i.when === 'despues'),
    missingDueDates: items.filter((i) => i.missingDueDate).map((i) => i.name),
    payNowTotal,
    waitingTotal: dueBeforeIncome.reduce((s, i) => s + i.pending - i.payNow, 0),
    // Plata que queda libre hasta el ingreso, después de la reserva y los pagos que vencen antes.
    freeUntilIncome: Math.max(0, free) - payNowTotal,
    // No alcanza ni para lo prioritario: no se debe pagar nada todavía.
    isShort: free < 0,
    projection: {
      cash,
      upcoming,
      fixedPending,
      commitmentsPending,
      variableAvailable,
      closing,
      cuts,
      // Lo que falta aun recortando todo lo no prioritario.
      uncovered: deficit,
    },
  };
}
