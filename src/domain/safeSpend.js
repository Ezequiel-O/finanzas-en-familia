// src/domain/safeSpend.js
// "Gasto seguro hoy": cuánto se puede gastar hoy sin quedarse sin plata para lo prioritario
// y los pagos en ningún momento del periodo.
//
// El periodo se divide en tramos según las fechas de ingreso registradas:
//   hoy → próximo ingreso → siguiente ingreso → … → fin del periodo.
// Saldo acumulado al final de cada tramo:
//   plata a hoy + ingresos que llegan hasta el inicio del tramo
//   − pagos fijos y cuotas que vencen hasta el final del tramo
//   − gasto prioritario diario × días acumulados hasta el final del tramo
// (gasto prioritario diario = disponible de prioritarias no fijas ÷ días que quedan del periodo)
//
// Gasto seguro hoy = el menor saldo acumulado (0 si es negativo).
// Margen del mes = plata a hoy + por recibir − todo lo pendiente del presupuesto
// (es la proyección al cierre que ya calcula paymentPlan).
import { budgetMonthKeyForDate, getBudgetPeriod } from '../utils/budgetPeriod.js';
import { categoryBudgetStatus } from './budgetHealth.js';
import { isSystemCategory } from './categories.js';
import { commitmentsForPeriod } from './commitments.js';
import { addDaysToKey, daysBetween } from './dates.js';
import { classifyTransaction, KIND, periodIncomeSplit, txDateKey } from './ledger.js';
import { toNumber } from './money.js';
import { paymentPlan, SERVICE_CUT_REASON } from './paymentPlan.js';

const GREEN_DAYS = 7;
const TIGHT_MARGIN_RATIO = 0.03;

const sum = (list, pick) => list.reduce((s, x) => s + pick(x), 0);

// Fecha en que se cuenta un pago: los atrasados y los sin fecha, hoy.
const effectiveDue = (item, today) => (!item.dueDate || item.isOverdue ? today : item.dueDate);

const byDue = (today) => (a, b) => effectiveDue(a, today).localeCompare(effectiveDue(b, today));

export function safeSpendPlan(input) {
  const plan = paymentPlan(input);
  const { transactions = [], debts = [], savings = [], budgetsAll = {}, fixedCategories = {}, categories = [], cutDay = 1 } =
    input || {};
  const { today, cash } = plan;
  const periodKey = budgetMonthKeyForDate(today, cutDay);
  const { end: periodEnd } = getBudgetPeriod(periodKey, cutDay);

  // Gasto prioritario diario: solo prioritarias no fijas con presupuesto.
  const priorityAvailable = sum(
    plan.essentials.filter((e) => e.available !== null),
    (e) => e.available,
  );
  const priorityDaily = priorityAvailable / plan.daysLeftInPeriod;

  // Ingresos registrados que llegan dentro del periodo, por fecha.
  const incomeByDate = new Map();
  (transactions || []).forEach((t) => {
    const d = txDateKey(t);
    if (!d || d <= today || d >= periodEnd || classifyTransaction(t) !== KIND.INCOME) return;
    incomeByDate.set(d, (incomeByDate.get(d) || 0) + toNumber(t.amount));
  });
  const incomeDates = Array.from(incomeByDate.keys()).sort();

  // Pagos del periodo (los de paymentPlan, con su fecha por subgasto).
  const bills = plan.items.filter((i) => !i.dueDate || i.isOverdue || i.dueDate < periodEnd);

  const bounds = [today, ...incomeDates, periodEnd];
  const tramos = bounds.slice(0, -1).map((start, idx) => {
    const end = bounds[idx + 1];
    const income = sum(incomeDates.filter((d) => d <= start), (d) => incomeByDate.get(d));
    const paid = sum(bills.filter((b) => effectiveDue(b, today) < end), (b) => b.pending);
    const priority = priorityDaily * daysBetween(today, end);
    const tramoBills = bills.filter((b) => {
      const due = effectiveDue(b, today);
      return due >= start && due < end;
    });
    return {
      start,
      end,
      days: daysBetween(start, end),
      incomeIn: start === today ? 0 : incomeByDate.get(start) || 0,
      billsIn: sum(tramoBills, (b) => b.pending),
      priorityIn: Math.round(priorityDaily * daysBetween(start, end)),
      balance: Math.round(cash + income - paid - priority),
    };
  });

  const tightest = tramos.reduce((min, t) => (t.balance < min.balance ? t : min), tramos[0]);
  const safeToday = Math.max(0, tightest.balance);
  // El día en que realmente falta: el anterior a que entre la plata (o el último del periodo).
  const shortDate = addDaysToKey(tightest.end, -1);
  const level = tightest.balance <= 0 ? 'red' : safeToday >= priorityDaily * GREEN_DAYS ? 'green' : 'yellow';

  // En rojo: postergar el pago más tardío (hasta el tramo más justo) que no corte un servicio.
  const postpone =
    level === 'red'
      ? bills
          .filter((b) => effectiveDue(b, today) < tightest.end && b.reason !== SERVICE_CUT_REASON)
          .sort(byDue(today))
          .pop() || null
      : null;

  // Pagos que vencen antes del próximo ingreso y los que vienen después.
  const payBeforeIncome = [...plan.payToday, ...plan.beforeIncome].sort(byDue(today));
  const payAfterIncome = [...plan.afterIncome].sort(byDue(today));

  // Fin de mes.
  const margin = plan.projection.closing;
  const { received, upcoming } = periodIncomeSplit({ transactions, periodKey, cutDay, today });
  const monthIncome = received + upcoming;
  const allCategories = Array.from(
    new Set([...(categories || []), ...Object.keys(budgetsAll?.[periodKey] || {})]),
  ).filter((c) => !isSystemCategory(c));
  const categoryAvailable = Object.fromEntries(
    allCategories.map((category) => {
      const { funded, spent } = categoryBudgetStatus({ budgetsAll, transactions, cutDay, category, periodKey, fixedCategories });
      return [category, { funded, available: Math.max(0, Math.round(funded - spent)) }];
    }),
  );
  // Presupuesto del mes: categorías + cuotas, suscripciones y aportes del periodo (como en Plan).
  const commitmentsPlanned = sum(
    commitmentsForPeriod({ debts, savings, transactions, periodKey, cutDay, today }).filter((i) => !i.isOverdue),
    (i) => i.planned,
  );
  const budgetTotal = sum(Object.values(categoryAvailable), (c) => c.funded) + commitmentsPlanned;
  const monthLevel = margin < 0 ? 'red' : margin < monthIncome * TIGHT_MARGIN_RATIO ? 'yellow' : 'green';

  return {
    today,
    cash,
    priorityDaily,
    tramos,
    tightest,
    safeToday,
    shortfall: Math.max(0, -tightest.balance),
    shortDate,
    level,
    postpone,
    nextIncomeDate: plan.income.date,
    payBeforeIncome,
    payAfterIncome,
    margin,
    monthLevel,
    cuts: plan.projection.cuts,
    monthIncome,
    upcoming,
    budgetTotal,
    categoryAvailable: Object.fromEntries(Object.entries(categoryAvailable).map(([c, v]) => [c, v.available])),
  };
}

// "¿Puedo gastar esto?": `category` vacía = fuera del presupuesto.
export function canISpend(summary, { amount, category = '' }) {
  const value = Math.max(0, Math.round(toNumber(amount)));
  if (value > summary.safeToday) {
    return { answer: 'no_tramo', date: summary.shortDate, amount: value - summary.safeToday };
  }
  if (category && value <= (summary.categoryAvailable[category] || 0)) return { answer: 'si_presupuesto' };
  if (value <= summary.margin) return { answer: 'si_margen', amount: summary.margin - value };
  return { answer: 'no_margen', amount: value - summary.margin };
}
