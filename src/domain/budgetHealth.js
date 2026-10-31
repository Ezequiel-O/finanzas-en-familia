// src/domain/budgetHealth.js
// Indicadores para leer el presupuesto de un vistazo: semáforo, ritmo de gasto
// y cuánto se puede gastar por día en lo que queda del periodo.
import { getBudgetPeriod } from '../utils/budgetPeriod.js';
import { daysBetween, todayKey } from './dates.js';
import { toNumber } from './money.js';
import { categorySpent, txDateKey } from './ledger.js';
import { getFixedCarryoverForSubcategory, resolveFixedCategory } from '../utils/fixedBudgets.js';

export const WARN_RATIO = 0.8;

// Presupuesto y gasto de UNA categoría en un periodo, con la misma regla que la tabla de
// Presupuestos: si tiene subcategorías, el presupuesto es su suma y, en gastos fijos, se le
// agrega lo que quedó impago del periodo anterior.
export function categoryBudgetStatus({ budgetsAll, transactions, cutDay = 1, category, periodKey, fixedCategories = {} }) {
  const entry = budgetsAll?.[periodKey]?.[category];
  let funded = 0;
  if (typeof entry === 'number') funded = entry;
  else if (entry && typeof entry === 'object') {
    const breakdown = Array.isArray(entry.breakdown) ? entry.breakdown : [];
    if (breakdown.length) {
      const isFixed = resolveFixedCategory({ entry, breakdown, fixedCategories, category });
      funded = breakdown.reduce((sum, item, idx) => {
        const base = toNumber(item.amount);
        if (!isFixed) return sum + base;
        const id = item.id || item.name || `${category}-${idx}`;
        return (
          sum +
          base +
          getFixedCarryoverForSubcategory({
            budgetsAll,
            transactions,
            cutDay,
            category,
            fixedCategories,
            subId: item.id || id,
            subName: item.name || '',
            currentPeriodKey: periodKey,
          })
        );
      }, 0);
    } else {
      funded = toNumber(entry.funded !== undefined ? entry.funded : entry.plan);
    }
  }
  const { start, end } = getBudgetPeriod(periodKey, cutDay);
  const periodTx = (transactions || []).filter((t) => {
    const d = txDateKey(t);
    return d >= start && d < end;
  });
  const spent = categorySpent(periodTx, category);
  return { funded, spent, remaining: funded - spent };
}

// 'ok' (verde) bajo 80 %, 'warn' (amarillo) entre 80 y 100 %, 'over' (rojo) sobre 100 %.
// Sin presupuesto: 'over' si ya hay gasto, 'none' si no.
export function budgetLevel(spent, planned) {
  const s = toNumber(spent);
  const p = toNumber(planned);
  if (p <= 0) return s > 0 ? 'over' : 'none';
  const ratio = s / p;
  if (ratio > 1) return 'over';
  if (ratio >= WARN_RATIO) return 'warn';
  return 'ok';
}

// Días del periodo de presupuesto respecto de `today`.
export function periodPace(periodKey, cutDay = 1, today = todayKey()) {
  const { start, end } = getBudgetPeriod(periodKey, cutDay);
  const totalDays = Math.max(1, daysBetween(start, end));
  let elapsed;
  if (today < start) elapsed = 0;
  else if (today >= end) elapsed = totalDays;
  else elapsed = daysBetween(start, today) + 1; // hoy cuenta como día transcurrido
  const daysLeft = Math.max(0, totalDays - elapsed + (today >= start && today < end ? 1 : 0));
  return {
    start,
    end,
    totalDays,
    elapsedDays: elapsed,
    daysLeft,
    isCurrent: today >= start && today < end,
    isPast: today >= end,
  };
}

// Con menos días la proyección exagera: una compra grande del supermercado el día 2 se
// multiplicaría por todo el periodo.
export const MIN_PROJECTION_DAYS = 7;

// Resumen para "te quedan $X para N días · ~$Y por día" y proyección al cierre.
// Solo el gasto variable se proyecta según el ritmo diario; los gastos fijos se pagan una vez
// por periodo, así que cuentan por lo presupuestado (o lo gastado, si ya se pasó).
export function spendingOutlook({
  planned,
  spent,
  periodKey,
  cutDay = 1,
  today = todayKey(),
  fixedPlanned = 0,
  fixedSpent = 0,
  cashAvailable = null,
}) {
  const p = toNumber(planned);
  const s = toNumber(spent);
  const fp = toNumber(fixedPlanned);
  const fs = toNumber(fixedSpent);
  const pace = periodPace(periodKey, cutDay, today);
  const remaining = p - s;
  // En el periodo en curso no se sugiere gastar más de la plata que hay hoy, aunque el
  // presupuesto cuente ingresos que todavía no llegan.
  const cash = cashAvailable === null || cashAvailable === undefined ? null : toNumber(cashAvailable);
  const limitedByCash = pace.isCurrent && cash !== null && cash < remaining;
  const spendable = limitedByCash ? Math.max(0, cash) : remaining;
  const perDay = pace.daysLeft > 0 && spendable > 0 ? Math.floor(spendable / pace.daysLeft) : 0;
  const variableSpent = Math.max(0, s - fs);
  const projected =
    pace.isCurrent && pace.elapsedDays > 0
      ? Math.max(fp, fs) + Math.round((variableSpent / pace.elapsedDays) * pace.totalDays)
      : s;
  return {
    ...pace,
    planned: p,
    spent: s,
    remaining,
    spendable,
    limitedByCash,
    cash,
    perDay,
    projected,
    projectedOver: p > 0 ? Math.max(0, projected - p) : 0,
    canProject: pace.isCurrent && pace.elapsedDays >= MIN_PROJECTION_DAYS,
    level: budgetLevel(s, p),
  };
}
