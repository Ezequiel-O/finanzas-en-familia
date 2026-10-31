// src/domain/commitments.js
// Compromisos del hogar: cuotas de deudas, suscripciones y metas de ahorro.
//
// Regla de precisión: lo pagado y lo ahorrado se calcula SIEMPRE desde los
// movimientos vinculados (meta.debtId + meta.debtQuotaIds, meta.savingId).
// Los campos guardados `remaining` y `schedule[].paidAmount` son copias que se
// desactualizan cuando alguien edita o borra un movimiento, así que no se usan.
import { DEBT_CATEGORY, SAVINGS_CATEGORY } from '../constants.js';
import {
  budgetMonthKeyForDate,
  dateKeyFromValue,
  getBudgetPeriod,
  monthKey,
  shiftMonth,
} from '../utils/budgetPeriod.js';
import { addDaysToKey, todayKey } from './dates.js';
import { txDateKey } from './ledger.js';
import { toNumber } from './money.js';

const DEFAULT_PLAN_PERIODS = 3;
const DEBT_PAYMENT_SUBCATEGORY = 'pago de deudas';

const normalizeName = (value) => String(value || '').trim().toLowerCase();

export { txDateKey };

export function ensureSchedule(schedule) {
  return Array.isArray(schedule)
    ? schedule.map((q, idx) => ({
        id: q?.id || `q-${idx}`,
        periodKey: q?.periodKey || '',
        plannedAmount: toNumber(q?.plannedAmount),
        dueDate: q?.dueDate || '',
      }))
    : [];
}

export function resolvePeriodKey(entry, cutDay = 1) {
  if (entry?.periodKey) return entry.periodKey;
  if (entry?.dueDate) return budgetMonthKeyForDate(entry.dueDate, cutDay);
  return '';
}

export function periodLastDay(periodKey, cutDay = 1) {
  const { end } = getBudgetPeriod(periodKey, cutDay);
  return addDaysToKey(end, -1);
}

// ---------------------------------------------------------------------------
// Deudas
// ---------------------------------------------------------------------------

export function extractDebtQuotaIds(meta) {
  const ids = Array.isArray(meta?.debtQuotaIds)
    ? meta.debtQuotaIds
    : meta?.debtQuotaId
      ? [meta.debtQuotaId]
      : [];
  return Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
}

// Reparte `total` entre ids según pesos, sin perder pesos por redondeo.
export function allocateByWeights(total, entries) {
  const safeTotal = Math.max(0, Math.round(toNumber(total)));
  if (!entries.length) return {};
  let weights = entries.map((e) => Math.max(0, toNumber(e.weight)));
  let weightSum = weights.reduce((s, w) => s + w, 0);
  if (weightSum <= 0) {
    weights = entries.map(() => 1);
    weightSum = entries.length;
  }
  const floors = weights.map((w, i) => {
    const raw = (w / weightSum) * safeTotal;
    return { id: entries[i].id, value: Math.floor(raw), frac: raw - Math.floor(raw), i };
  });
  let remainder = safeTotal - floors.reduce((s, f) => s + f.value, 0);
  [...floors]
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
    .forEach((f) => {
      if (remainder > 0) {
        f.value += 1;
        remainder -= 1;
      }
    });
  return Object.fromEntries(floors.map((f) => [f.id, f.value]));
}

function quotaAllocations(ids, amount, meta) {
  const total = Math.round(toNumber(amount));
  if (!ids.length || total <= 0) return {};
  if (ids.length === 1) return { [ids[0]]: total };
  const rawAlloc = meta?.debtQuotaAmounts || meta?.debtQuotaAllocations || null;
  const weights = {};
  if (Array.isArray(rawAlloc)) {
    rawAlloc.forEach((item) => {
      if (item?.id) weights[String(item.id)] = toNumber(item.amount);
    });
  } else if (rawAlloc && typeof rawAlloc === 'object') {
    Object.entries(rawAlloc).forEach(([k, v]) => {
      weights[String(k).trim()] = toNumber(v);
    });
  }
  return allocateByWeights(
    total,
    ids.map((id) => ({ id, weight: weights[id] || 0 })),
  );
}

// Índice de lo pagado por cuota a partir de los movimientos.
// Clave preferente `${debtId}::${quotaId}`; respaldo solo por quotaId (movimientos antiguos).
export function buildDebtPaidIndex(transactions) {
  const byDebtQuota = new Map();
  const byQuota = new Map();
  (transactions || []).forEach((t) => {
    const meta = t?.meta || {};
    const sub = normalizeName(meta.budgetSubcategoryName);
    const subs = String(meta.budgetSubcategoryNames || '').toLowerCase();
    if (sub === DEBT_PAYMENT_SUBCATEGORY || subs.includes(DEBT_PAYMENT_SUBCATEGORY)) return;
    const ids = extractDebtQuotaIds(meta);
    if (!ids.length) return;
    const allocations = quotaAllocations(ids, t?.amount, meta);
    const debtIdMap =
      meta.debtQuotaDebtIds && typeof meta.debtQuotaDebtIds === 'object'
        ? meta.debtQuotaDebtIds
        : null;
    ids.forEach((quotaId) => {
      const amount = allocations[quotaId] || 0;
      if (!amount) return;
      const debtId = debtIdMap?.[quotaId] || meta.debtId;
      if (debtId) {
        const key = `${debtId}::${quotaId}`;
        byDebtQuota.set(key, (byDebtQuota.get(key) || 0) + amount);
      } else {
        byQuota.set(quotaId, (byQuota.get(quotaId) || 0) + amount);
      }
    });
  });
  return { byDebtQuota, byQuota };
}

export function paidForQuota(index, debtId, quotaId) {
  if (!index || !quotaId) return 0;
  const key = `${debtId}::${quotaId}`;
  if (debtId && index.byDebtQuota.has(key)) return index.byDebtQuota.get(key);
  return index.byQuota.get(quotaId) || 0;
}

// Estado real de una deuda calculado desde los movimientos.
export function debtProgress(debt, paidIndex, today = todayKey()) {
  const schedule = ensureSchedule(debt?.schedule)
    .filter((q) => q.plannedAmount > 0)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  const isSubscription = !!debt?.isSubscription;
  const original = toNumber(debt?.original);
  const plannedTotal = schedule.reduce((s, q) => s + q.plannedAmount, 0);
  const alreadyPaid = toNumber(debt?.alreadyPaid);

  const quotas = schedule.map((q) => {
    const paid = paidForQuota(paidIndex, debt?.id, q.id);
    const status = paid >= q.plannedAmount ? 'paid' : paid > 0 ? 'partial' : 'pending';
    return { ...q, paid, pending: Math.max(0, q.plannedAmount - paid), status };
  });
  const paidFromQuotas = quotas.reduce((s, q) => s + q.paid, 0);
  const total = isSubscription ? plannedTotal : Math.max(original, plannedTotal + alreadyPaid);
  const paid = alreadyPaid + paidFromQuotas;
  const remaining = isSubscription ? 0 : Math.max(0, total - paid);
  const paidCount = quotas.filter((q) => q.status === 'paid').length;
  const overdue = quotas.filter((q) => q.status !== 'paid' && q.dueDate && q.dueDate < today);
  const next = quotas.find((q) => q.status !== 'paid') || null;
  const last = quotas[quotas.length - 1] || null;

  // Si las cuotas reales (como las cobra el banco) suman más que el monto original,
  // la diferencia es el costo del crédito (intereses y cargos).
  const interest =
    !isSubscription && original > 0 ? Math.max(0, plannedTotal + alreadyPaid - original) : 0;

  return {
    id: debt?.id,
    name: debt?.name || 'Deuda',
    isSubscription,
    interest,
    total,
    paid,
    remaining,
    ratio: total > 0 ? Math.min(1, paid / total) : 0,
    quotaCount: quotas.length,
    paidCount,
    overdueCount: overdue.length,
    overdueAmount: overdue.reduce((s, q) => s + q.pending, 0),
    nextQuota: next,
    endDate: isSubscription ? '' : last?.dueDate || debt?.due || '',
    isPaidOff: !isSubscription && total > 0 && remaining <= 0,
    quotas,
  };
}

// ---------------------------------------------------------------------------
// Ahorro
// ---------------------------------------------------------------------------

function periodsBetween(startPk, endPk) {
  if (!startPk || !endPk) return 0;
  let count = 1;
  let cursor = startPk;
  while (cursor < endPk && count < 120) {
    cursor = shiftMonth(cursor, 1);
    count += 1;
  }
  return count;
}

function savingStartPeriodKey(s, cutDay) {
  const key = dateKeyFromValue(s?.createdAt);
  return key ? budgetMonthKeyForDate(key, cutDay) : '';
}

// Plan para metas antiguas sin cronograma: reparte lo que falta en partes iguales hasta la fecha meta.
function legacySavingPlan(s, periodKey, cutDay) {
  if (!periodKey) return { plan: 0, targetPk: '' };
  const rawStartPk = savingStartPeriodKey(s, cutDay);
  const startPk = rawStartPk || periodKey || monthKey(new Date());
  const targetPk = s?.targetDate
    ? budgetMonthKeyForDate(s.targetDate, cutDay)
    : shiftMonth(startPk, DEFAULT_PLAN_PERIODS - 1);
  const normalizedTarget = targetPk && rawStartPk && rawStartPk > targetPk ? rawStartPk : targetPk;
  if (rawStartPk && periodKey < rawStartPk) return { plan: 0, targetPk: normalizedTarget };
  const remaining = Math.max(toNumber(s?.goal) - toNumber(s?.saved), 0);
  if (remaining <= 0 || (normalizedTarget && periodKey > normalizedTarget)) {
    return { plan: 0, targetPk: normalizedTarget };
  }
  const scheduleStartPk = rawStartPk || periodKey;
  const totalPeriods = periodsBetween(scheduleStartPk, normalizedTarget || scheduleStartPk);
  const basePlan = totalPeriods > 0 ? Math.floor(remaining / totalPeriods) : remaining;
  const delta = remaining - basePlan * totalPeriods;
  return {
    plan: periodKey === normalizedTarget ? basePlan + delta : basePlan,
    targetPk: normalizedTarget,
  };
}

export function plannedForSavingPeriod(saving, periodKey, cutDay = 1) {
  if (!periodKey) return 0;
  const schedule = ensureSchedule(saving?.schedule);
  if (schedule.length) {
    return schedule
      .filter((q) => resolvePeriodKey(q, cutDay) === periodKey)
      .reduce((s, q) => s + q.plannedAmount, 0);
  }
  const { plan, targetPk } = legacySavingPlan(saving, periodKey, cutDay);
  if (!targetPk || periodKey > targetPk) return 0;
  return plan;
}

// Busca la meta de un movimiento: por savingId, o por nombre si el nombre es único.
export function buildSavingResolver(savings) {
  const counts = new Map();
  const ids = new Map();
  (savings || []).forEach((s) => {
    const key = normalizeName(s?.name);
    if (!key || !s?.id) return;
    counts.set(key, (counts.get(key) || 0) + 1);
    ids.set(key, s.id);
  });
  return (t) => {
    const direct = String(t?.meta?.savingId || '').trim();
    if (direct) return direct;
    const key = normalizeName(t?.meta?.savingName);
    return key && counts.get(key) === 1 ? ids.get(key) : '';
  };
}

export function buildSavingsPaidIndex(transactions, savings, cutDay = 1) {
  const resolve = buildSavingResolver(savings);
  const bySaving = new Map();
  const bySavingPeriod = new Map();
  (transactions || []).forEach((t) => {
    const isWithdrawal = t?.meta?.kind === 'saving_withdrawal' || (t?.category === SAVINGS_CATEGORY && t?.type === 'ingreso');
    if (t?.category !== SAVINGS_CATEGORY && !isWithdrawal) return;
    const amount = toNumber(t.amount);
    if (!amount) return;
    const savingId = resolve(t);
    if (!savingId) return;
    // Aporte (gasto) suma a la meta; retiro la descuenta.
    bySaving.set(savingId, (bySaving.get(savingId) || 0) + (isWithdrawal ? -amount : amount));
    if (isWithdrawal) return; // lo aportado en el periodo cuenta solo aportes
    const dk = txDateKey(t);
    if (dk) {
      const key = `${savingId}::${budgetMonthKeyForDate(dk, cutDay)}`;
      bySavingPeriod.set(key, (bySavingPeriod.get(key) || 0) + amount);
    }
  });
  return { bySaving, bySavingPeriod };
}

export function savingProgress(saving, paidIndex, { periodKey, cutDay = 1, today = todayKey() } = {}) {
  const goal = toNumber(saving?.goal);
  const saved = toNumber(saving?.saved) + (paidIndex?.bySaving.get(saving?.id) || 0);
  const remaining = Math.max(0, goal - saved);
  const targetDate = String(saving?.targetDate || '');
  const targetPk = targetDate ? budgetMonthKeyForDate(targetDate, cutDay) : '';
  const fromPk = periodKey || budgetMonthKeyForDate(today, cutDay);
  const periodsLeft = targetPk && targetPk >= fromPk ? periodsBetween(fromPk, targetPk) : 0;
  return {
    id: saving?.id,
    name: saving?.name || 'Ahorro',
    goal,
    saved,
    remaining,
    ratio: goal > 0 ? Math.min(1, saved / goal) : 0,
    targetDate,
    periodsLeft,
    suggestedPerPeriod: periodsLeft > 0 ? Math.ceil(remaining / periodsLeft) : remaining,
    isComplete: goal > 0 && saved >= goal,
    milestone: goal > 0 ? [100, 75, 50, 25].find((m) => saved / goal >= m / 100) || 0 : 0,
  };
}

// ---------------------------------------------------------------------------
// Compromisos de un periodo (para "Plan del mes")
// ---------------------------------------------------------------------------

// Lista unificada de lo que hay que pagar o aportar en `periodKey`,
// incluyendo cuotas atrasadas de periodos anteriores.
export function commitmentsForPeriod({
  debts = [],
  savings = [],
  transactions = [],
  periodKey,
  cutDay = 1,
  today = todayKey(),
}) {
  if (!periodKey) return [];
  const debtIndex = buildDebtPaidIndex(transactions);
  const savingsIndex = buildSavingsPaidIndex(transactions, savings, cutDay);
  const items = [];

  (debts || [])
    .filter((d) => d && !d.archived)
    .forEach((debt) => {
      const progress = debtProgress(debt, debtIndex, today);
      progress.quotas.forEach((q, idx) => {
        const pk = resolvePeriodKey(q, cutDay);
        const isCurrent = pk === periodKey;
        const isOverdue = pk && pk < periodKey && q.status !== 'paid';
        if (!isCurrent && !isOverdue) return;
        items.push({
          key: `debt:${debt.id}:${q.id}`,
          kind: debt.isSubscription ? 'subscription' : 'debt',
          refId: debt.id,
          quotaId: q.id,
          name: debt.name || 'Deuda',
          detail: debt.isSubscription
            ? 'Suscripción'
            : `Cuota ${idx + 1} de ${progress.quotaCount}`,
          cardName: String(debt.cardName || '').trim(),
          planned: q.plannedAmount,
          paid: q.paid,
          pending: q.pending,
          status: q.status,
          dueDate: q.dueDate || periodLastDay(pk || periodKey, cutDay),
          isOverdue: !!isOverdue,
        });
      });
    });

  (savings || []).forEach((saving) => {
    const planned = plannedForSavingPeriod(saving, periodKey, cutDay);
    if (planned <= 0) return;
    const paid = savingsIndex.bySavingPeriod.get(`${saving.id}::${periodKey}`) || 0;
    items.push({
      key: `saving:${saving.id}:${periodKey}`,
      kind: 'saving',
      refId: saving.id,
      name: saving.name || 'Ahorro',
      detail: 'Aporte a meta',
      planned,
      paid,
      pending: Math.max(0, planned - paid),
      status: paid >= planned ? 'paid' : paid > 0 ? 'partial' : 'pending',
      dueDate: periodLastDay(periodKey, cutDay),
      isOverdue: false,
    });
  });

  const rank = (i) => (i.isOverdue ? 0 : i.status === 'paid' ? 2 : 1);
  return items.sort(
    (a, b) => rank(a) - rank(b) || String(a.dueDate).localeCompare(String(b.dueDate)),
  );
}

export function summarizeCommitments(items) {
  return (items || []).reduce(
    (acc, i) => {
      acc.planned += i.planned;
      acc.paid += Math.min(i.paid, i.planned);
      acc.pending += i.pending;
      if (i.isOverdue) acc.overdue += i.pending;
      return acc;
    },
    { planned: 0, paid: 0, pending: 0, overdue: 0 },
  );
}

// Payload de movimiento para pagar una cuota, con el mismo formato que usa Deudas.
export function buildDebtPaymentTransaction({ debt, quotaIds, amount, date, user, allocations }) {
  const ids = (quotaIds || []).filter(Boolean);
  const debtIdMap = Object.fromEntries(ids.map((id) => [id, debt.id]));
  const meta = {
    debtQuotaIds: ids,
    debtQuotaAmounts: allocations || (ids.length === 1 ? { [ids[0]]: amount } : undefined),
    debtQuotaDebtIds: debtIdMap,
    debtId: debt.id,
  };
  if (ids.length === 1) meta.debtQuotaId = ids[0];
  Object.keys(meta).forEach((k) => meta[k] === undefined && delete meta[k]);
  return {
    type: 'gasto',
    category: DEBT_CATEGORY,
    amount: Math.round(toNumber(amount)),
    description: debt?.name ? `Pago deuda: ${debt.name}` : 'Pago deuda',
    date: date || todayKey(),
    createdAt: new Date().toISOString(),
    ownerId: user?.id || null,
    ownerName: user?.name || null,
    ownerEmail: user?.email || null,
    meta,
  };
}

// Retiro desde una meta: la plata vuelve a la caja y la meta baja. No es un ingreso.
export function buildSavingWithdrawalTransaction({ saving, amount, date, user, reason = '' }) {
  return {
    type: 'ingreso',
    category: SAVINGS_CATEGORY,
    amount: Math.round(toNumber(amount)),
    description: reason || (saving?.name ? `Retiro de ahorro: ${saving.name}` : 'Retiro de ahorro'),
    date: date || todayKey(),
    createdAt: new Date().toISOString(),
    ownerId: user?.id || null,
    ownerName: user?.name || null,
    ownerEmail: user?.email || null,
    meta: {
      kind: 'saving_withdrawal',
      savingId: saving.id,
      ...(saving.name ? { savingName: saving.name } : {}),
    },
  };
}

export function buildSavingContributionTransaction({ saving, amount, date, user }) {
  return {
    type: 'gasto',
    category: SAVINGS_CATEGORY,
    amount: Math.round(toNumber(amount)),
    description: saving?.name ? `Aporte ahorro: ${saving.name}` : 'Aporte ahorro',
    date: date || todayKey(),
    createdAt: new Date().toISOString(),
    ownerId: user?.id || null,
    ownerName: user?.name || null,
    ownerEmail: user?.email || null,
    meta: {
      savingId: saving.id,
      ...(saving.name ? { savingName: saving.name } : {}),
    },
  };
}
