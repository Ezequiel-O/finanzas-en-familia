import { plannedForSavingPeriod } from '../../domain/commitments.js';
import { categorySpent, isAdjustment, periodLedger, txDateKey } from '../../domain/ledger.js';
import { LedgerBreakdown } from '../../features/plan/LedgerBreakdown.jsx';
import { PeriodOutlook } from '../../features/plan/PeriodOutlook.jsx';
import { toast, confirmDialog } from '../../components/feedback/feedback.js';
import { todayKey } from '../../domain/dates.js';
import { formatCLP } from '../../domain/money.js';
import React, { useState, useMemo, useEffect } from 'react';

import { Card } from '../../components/ui/Card.jsx';
import { SectionTitle } from '../../components/ui/SectionTitle.jsx';
import { Money } from '../../components/ui/Money.jsx';
import { Progress } from '../../components/ui/Progress.jsx';
import {
  shiftMonth,
  getBudgetPeriod,
} from '../../utils/budgetPeriod.js';
import { CATEGORIES, DEBT_CATEGORY, SAVINGS_CATEGORY } from '../../constants.js';
import { filterTransactionsByPeriodAndUser } from '../../utils/transactions.js';
import {
  getFixedCarryoverForSubcategory,
  resolveFixedCategory,
} from '../../utils/fixedBudgets.js';
import { getSubcategoryAllocationsForTransaction } from '../../utils/subcategoryAllocations.js';

const DEFAULT_UNBUDGETED_LABEL = 'gasto no presupuestado';
const DEBT_UNASSIGNED_LABEL = 'pago de deudas';

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function parseSubcategoryNames(meta) {
  const list = [];
  const raw = String(meta?.budgetSubcategoryNames || '').trim();
  if (raw) {
    raw.split(';').forEach((name) => {
      const trimmed = String(name || '').trim();
      if (trimmed) list.push(trimmed);
    });
  }
  const single = String(meta?.budgetSubcategoryName || '').trim();
  if (single) list.push(single);
  return Array.from(new Set(list));
}

function extractDebtQuotaIds(meta) {
  const ids = Array.isArray(meta?.debtQuotaIds)
    ? meta.debtQuotaIds
    : meta?.debtQuotaId
    ? [meta.debtQuotaId]
    : [];
  return Array.from(
    new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)),
  );
}

function buildDebtQuotaAllocationMap({ ids, amount, meta }) {
  const safeIds = Array.isArray(ids) ? ids : [];
  const safeTotal = Math.round(Number(amount || 0));
  if (!safeIds.length || safeTotal <= 0) return null;
  if (safeIds.length === 1) return { [safeIds[0]]: safeTotal };

  const rawAlloc =
    meta?.debtQuotaAmounts || meta?.debtQuotaAllocations || null;
  if (rawAlloc && typeof rawAlloc === 'object') {
    const weights = {};
    if (Array.isArray(rawAlloc)) {
      rawAlloc.forEach((item) => {
        if (!item || !item.id) return;
        weights[String(item.id)] = Number(item.amount || 0);
      });
    } else {
      Object.entries(rawAlloc).forEach(([key, value]) => {
        const safeKey = String(key || '').trim();
        if (!safeKey) return;
        weights[safeKey] = Number(value || 0);
      });
    }
    const entries = safeIds.map((id) => ({
      id,
      weight: Math.max(Number(weights[id] || 0), 0),
    }));
    const weightSum = entries.reduce((sum, item) => sum + item.weight, 0);
    if (weightSum > 0) {
      const raw = entries.map((item) => ({
        id: item.id,
        raw: (item.weight / weightSum) * safeTotal,
      }));
      const floors = raw.map((item) => ({
        id: item.id,
        value: Math.floor(item.raw),
        frac: item.raw - Math.floor(item.raw),
      }));
      let remainder =
        safeTotal - floors.reduce((sum, item) => sum + item.value, 0);
      floors.sort((a, b) => b.frac - a.frac);
      for (let i = 0; i < floors.length && remainder > 0; i += 1) {
        floors[i].value += 1;
        remainder -= 1;
      }
      const allocations = {};
      floors.forEach((item) => {
        allocations[item.id] = item.value;
      });
      return allocations;
    }
  }

  const base = Math.floor(safeTotal / safeIds.length);
  let remainder = safeTotal - base * safeIds.length;
  const allocations = {};
  safeIds.forEach((id) => {
    allocations[id] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
  });
  return allocations;
}

function getTransactionDateKey(t) {
  return txDateKey(t);
}

function buildDebtPaidByQuotaId({ transactions, quotaIndex }) {
  const map = new Map();
  const list = Array.isArray(transactions) ? transactions : [];
  const byName = quotaIndex?.byName || new Map();
  const byQuotaId = quotaIndex?.byQuotaId || new Map();
  for (const t of list) {
    if (t?.category !== DEBT_CATEGORY) continue;
    const amt = Number(t.amount || 0);
    if (Number.isNaN(amt)) continue;
    const meta = t?.meta || {};
    const candidates = [];
    const parsedSubcategoryNames = parseSubcategoryNames(meta);
    const hasUnassigned = parsedSubcategoryNames.some(
      (name) =>
        String(name || '').trim().toLowerCase() === DEBT_UNASSIGNED_LABEL,
    );
    if (hasUnassigned) continue;
    if (meta?.debtName) candidates.push(meta.debtName);
    parsedSubcategoryNames.forEach((name) => candidates.push(name));
    const nameMatch = candidates.reduce((acc, name) => {
      if (acc) return acc;
      const key = String(name || '').trim().toLowerCase();
      if (!key || key === DEBT_UNASSIGNED_LABEL) return '';
      return byName.get(key) || '';
    }, '');

    const ids = extractDebtQuotaIds(meta);
    if (ids.length) {
      const allocationMap = buildDebtQuotaAllocationMap({
        ids,
        amount: amt,
        meta,
      });
      const debtIdMap =
        meta.debtQuotaDebtIds && typeof meta.debtQuotaDebtIds === 'object'
          ? meta.debtQuotaDebtIds
          : null;
      let hasAllocation = false;
      ids.forEach((id) => {
        const quotaInfo = byQuotaId.get(id);
        const debtIdForQuota = debtIdMap?.[id] || meta.debtId || '';
        const isQuotaValid =
          !!quotaInfo &&
          (!debtIdForQuota ||
            !quotaInfo.debtId ||
            debtIdForQuota === quotaInfo.debtId);
        if (!isQuotaValid) return;
        const allocation = allocationMap?.[id] || 0;
        if (!allocation) return;
        hasAllocation = true;
        map.set(id, (map.get(id) || 0) + allocation);
      });
      if (hasAllocation) continue;
    }

    const rawQuotaId = meta?.debtQuotaId || '';
    const quotaInfo = rawQuotaId ? byQuotaId.get(rawQuotaId) : null;
    const isQuotaValid =
      !!rawQuotaId &&
      !!quotaInfo &&
      (!meta?.debtId || !quotaInfo.debtId || meta.debtId === quotaInfo.debtId);

    let quotaId = '';
    if (isQuotaValid) {
      quotaId = rawQuotaId;
    } else if (nameMatch) {
      quotaId = nameMatch;
    }

    if (!quotaId) continue;
    map.set(quotaId, (map.get(quotaId) || 0) + amt);
  }
  return map;
}

function buildSpentBreakdownFromPeriod({
  breakdown,
  periodTx,
  category,
  isFixedCategory = false,
}) {
  const list = Array.isArray(breakdown) ? breakdown : [];
  if (!list.length) return { breakdown: [], total: 0 };

  const spentById = new Map();
  const spentByName = new Map();
  let unassigned = 0;

  periodTx.forEach((t) => {
    if (t?.type !== 'gasto') return;
    if (t?.category !== category) return;
    const amt = Number(t.amount || 0);
    if (!amt || Number.isNaN(amt)) return;
    const meta = t?.meta || {};
    const ids = Array.isArray(meta.budgetSubcategoryIds)
      ? meta.budgetSubcategoryIds
      : meta.budgetSubcategoryId
      ? [meta.budgetSubcategoryId]
      : [];
    const uniqueIds = Array.from(
      new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)),
    );
    if (uniqueIds.length) {
      const allocations = getSubcategoryAllocationsForTransaction({
        transaction: t,
        breakdown: list,
      });
      if (allocations.length) {
        allocations.forEach(({ id, amount }) => {
          const safe = Number(amount || 0);
          if (!id || Number.isNaN(safe)) return;
          spentById.set(id, (spentById.get(id) || 0) + safe);
        });
        return;
      }
      uniqueIds.forEach((id) => {
        spentById.set(id, (spentById.get(id) || 0) + amt);
      });
      return;
    }
    const names = parseSubcategoryNames(meta);
    if (names.length) {
      names.forEach((name) => {
        const key = String(name || '').trim().toLowerCase();
        if (!key) return;
        spentByName.set(key, (spentByName.get(key) || 0) + amt);
      });
      return;
    }
    unassigned += amt;
  });

  const nextBreakdown = list.map((item, idx) => {
    const name = String(item?.name || '').trim() || 'Sin nombre';
    const id = String(item?.id || name || `${category}-${idx}`);
    const byId = spentById.get(id);
    const byName = name ? spentByName.get(name.toLowerCase()) : undefined;
    const isFixed = !!item?.isFixed;
    const baseAmount = Number(item?.amount || 0);
    const amount = isFixedCategory
      ? baseAmount
      : Math.round(Number(byId ?? byName ?? 0));
    return { id, name, amount, isFixed };
  });

  if (unassigned > 0) {
    const matchIndex = nextBreakdown.findIndex(
      (item) =>
        String(item?.name || '')
          .trim()
          .toLowerCase() === DEFAULT_UNBUDGETED_LABEL.toLowerCase(),
    );
    if (matchIndex >= 0) {
      const current = nextBreakdown[matchIndex];
      nextBreakdown[matchIndex] = {
        ...current,
        amount: Math.round(Number(current.amount || 0) + unassigned),
      };
    } else {
      nextBreakdown.push({
        id: `${category}-unbudgeted`,
        name: DEFAULT_UNBUDGETED_LABEL,
        amount: Math.round(unassigned),
        isFixed: false,
      });
    }
  }

  const total = nextBreakdown.reduce(
    (sum, item) => sum + Number(item.amount || 0),
    0,
  );
  return { breakdown: nextBreakdown, total };
}

export function Budgets({ data, actions, activeUser = null, monthKeyStr, topSlot = null, beforeCategories = null }) {
  const {
    budgets = {},
    budgetsAll = {},
    fixedCategories = {},
    transactions = [],
    categories = [],
    budgetCutDay = 1,
    debts = [],
    savings = [],
    expectedIncome = 0,
  } = data || {};

  const baseCats = categories && categories.length ? categories : CATEGORIES;
  const cats = baseCats.includes(SAVINGS_CATEGORY)
    ? baseCats
    : [...baseCats, SAVINGS_CATEGORY];
  const mk = monthKeyStr;
  const cutDay = budgetCutDay;

  const debtsArray = Array.isArray(debts) ? debts : [];
  const savingsArray = Array.isArray(savings) ? savings : [];
  const monthTx = useMemo(
    () =>
      filterTransactionsByPeriodAndUser(
        transactions,
        mk,
        cutDay,
        null,
        false, // Presupuestos mira todos los movimientos del hogar
      ),
    [transactions, mk, cutDay],
  );

  const periodStart = useMemo(() => {
    if (!mk) return '';
    return getBudgetPeriod(mk, cutDay).start;
  }, [mk, cutDay]);

  const savingsPlannedForPeriod = (() => {
    if (!mk) return 0;
    return savingsArray.reduce((sum, s) => {
      const plan = plannedForSavingPeriod(s, mk, cutDay);
      return plan > 0 ? sum + plan : sum;
    }, 0);
  })();

  const prevMk = shiftMonth(mk, -1);
  const prevMonthTx = useMemo(
    () =>
      filterTransactionsByPeriodAndUser(
        transactions,
        prevMk,
        cutDay,
        null,
        false,
      ),
    [transactions, prevMk, cutDay],
  );
  const prevBudgets = useMemo(
    () => budgetsAll?.[prevMk] || {},
    [budgetsAll, prevMk],
  );
  const setBudgetFunded = actions?.setBudgetFunded;
  const addTrashItem = actions?.addTrashItem;

  useEffect(() => {
    if (!setBudgetFunded) return;
    if (!mk || !prevMk) return;
    if (!Object.keys(prevBudgets || {}).length) return;

    const pending = [];

    cats.forEach((cat) => {
      if (cat === DEBT_CATEGORY || cat === SAVINGS_CATEGORY) return;
      const current = budgets?.[cat];
      const currentBreakdown = Array.isArray(current?.breakdown)
        ? current.breakdown
        : [];
      if (currentBreakdown.length) return;
      const prev = prevBudgets?.[cat];
      const prevBreakdown = Array.isArray(prev?.breakdown) ? prev.breakdown : [];
      if (!prevBreakdown.length) return;
      const isFixedCategory = resolveFixedCategory({
        entry: prev,
        breakdown: prevBreakdown,
        fixedCategories,
        category: cat,
      });
      const { breakdown, total } = buildSpentBreakdownFromPeriod({
        breakdown: prevBreakdown,
        periodTx: prevMonthTx,
        category: cat,
        isFixedCategory,
      });
      if (!breakdown.length) return;
      pending.push({ cat, breakdown, total, isFixedCategory });
    });

    if (!pending.length) return;
    let cancelled = false;
    const run = async () => {
      for (const item of pending) {
        if (cancelled) return;
        await setBudgetFunded(mk, item.cat, {
          funded: item.total,
          breakdown: item.breakdown,
          isFixed: item.isFixedCategory,
        });
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [
    setBudgetFunded,
    mk,
    prevMk,
    prevBudgets,
    cats,
    budgets,
    prevMonthTx,
    fixedCategories,
  ]);

  const fixedCarryoverMap = useMemo(() => {
    const map = new Map();
    if (!mk) return map;
    const budgetsForPeriod = budgetsAll?.[mk] || budgets || {};

    Object.entries(budgetsForPeriod).forEach(([cat, entry]) => {
      const breakdown = Array.isArray(entry?.breakdown) ? entry.breakdown : [];
      const isFixedCategory = resolveFixedCategory({
        entry,
        breakdown,
        fixedCategories,
        category: cat,
      });
      if (!isFixedCategory || !breakdown.length) return;
      breakdown.forEach((item, idx) => {
        const id = item.id || item.name || `${cat}-${idx}`;
        const key = `${cat}::${id}`;
        const carryover = getFixedCarryoverForSubcategory({
          budgetsAll,
          transactions,
          cutDay,
          category: cat,
          fixedCategories,
          subId: item.id || id,
          subName: item.name || '',
          currentPeriodKey: mk,
        });
        if (carryover > 0) {
          map.set(key, carryover);
        }
      });
    });

    return map;
  }, [budgetsAll, budgets, transactions, cutDay, mk, fixedCategories]);

  const [expandedCats, setExpandedCats] = useState({});
  const [newBreakdownByCat, setNewBreakdownByCat] = useState({});
  const [editBreakdownByCat, setEditBreakdownByCat] = useState({});
  const [budgetInfo, setBudgetInfo] = useState(null);
  const [breakdownModal, setBreakdownModal] = useState(null);
  const [summaryOpen, setSummaryOpen] = useState({
    available: false,
    budget: false,
    vs: false,
    real: false,
  });
  const breakdownSpent = useMemo(() => {
    const acc = {};
    for (const t of monthTx) {
      if (t?.type !== 'gasto') continue;
      const entry = budgets?.[t?.category];
      const breakdown = Array.isArray(entry?.breakdown) ? entry.breakdown : [];
      const allocations = getSubcategoryAllocationsForTransaction({
        transaction: t,
        breakdown,
      });
      allocations.forEach(({ id, amount }) => {
        if (!id) return;
        acc[id] = (acc[id] || 0) + Number(amount || 0);
      });
    }
    return acc;
  }, [monthTx, budgets]);
  const unassignedSpentByCategory = useMemo(() => {
    const unbudgetedKey = DEFAULT_UNBUDGETED_LABEL.toLowerCase();
    const acc = {};
    for (const t of monthTx) {
      if (t?.type !== 'gasto') continue;
      const cat = t?.category;
      if (!cat) continue;
      const meta = t?.meta || {};
      const subIds = Array.isArray(meta?.budgetSubcategoryIds)
        ? meta.budgetSubcategoryIds.filter(Boolean)
        : [];
      const hasSubId = subIds.length > 0 || Boolean(meta?.budgetSubcategoryId);
      const subNames = parseSubcategoryNames(meta);
      const hasNamedSub = subNames.some(
        (name) =>
          String(name || '').trim().toLowerCase() !== unbudgetedKey,
      );
      const hasSavingsMeta =
        cat === SAVINGS_CATEGORY && (meta?.savingId || meta?.savingName);
      // Un pago de cuota ya cuenta en su cuota (Compromisos), no como gasto sin presupuesto.
      const hasDebtMeta =
        extractDebtQuotaIds(meta).length > 0 || Boolean(meta?.debtId);
      if (hasSubId || hasNamedSub || hasSavingsMeta || hasDebtMeta) continue;
      if (isAdjustment(t)) continue;
      const amt = Number(t.amount || 0);
      if (Number.isNaN(amt)) continue;
      acc[cat] = (acc[cat] || 0) + amt;
    }
    return acc;
  }, [monthTx]);

  const debtQuotaIndex = useMemo(() => {
    const byQuotaId = new Map();
    const byName = new Map();
    const byNamePeriod = new Map();
    debtsArray.forEach((debt, debtIdx) => {
      const schedule = Array.isArray(debt?.schedule) ? debt.schedule : [];
      schedule.forEach((q, idx) => {
        const quotaKey =
          q.id || `${debt.id || debt.name || 'deuda'}-${debtIdx}-${idx}`;
        const debtName = debt.name || 'Deuda';
        const label = q.dueDate ? `${debtName} (${q.dueDate})` : debtName;
        const labelKey = label.toLowerCase().trim();
        const debtKey = debtName.toLowerCase().trim();
        if (labelKey && !byName.has(labelKey)) {
          byName.set(labelKey, quotaKey);
          byNamePeriod.set(labelKey, q.periodKey || '');
        }
        if (debtKey) {
          const existingPeriod = byNamePeriod.get(debtKey);
          const isExistingCurrent = existingPeriod === mk;
          const isCurrent = q.periodKey === mk;
          if (!existingPeriod || (!isExistingCurrent && isCurrent)) {
            byName.set(debtKey, quotaKey);
            byNamePeriod.set(debtKey, q.periodKey || '');
          }
        }
        byQuotaId.set(quotaKey, {
          debtId: debt.id || '',
          debtName,
          periodKey: q.periodKey || '',
          dueDate: q.dueDate || '',
          plannedAmount: Number(q.plannedAmount || 0),
        });
      });
    });
    return { byQuotaId, byName };
  }, [debtsArray, mk]);

  const debtPaidByQuotaId = useMemo(
    () =>
      buildDebtPaidByQuotaId({
        transactions: monthTx,
        quotaIndex: debtQuotaIndex,
      }),
    [monthTx, debtQuotaIndex],
  );

  const debtPaidBeforePeriod = useMemo(() => {
    if (!periodStart) return new Map();
    const prevTx = (transactions || []).filter((t) => {
      const dateKey = getTransactionDateKey(t);
      return dateKey && dateKey < periodStart;
    });
    return buildDebtPaidByQuotaId({
      transactions: prevTx,
      quotaIndex: debtQuotaIndex,
    });
  }, [transactions, periodStart, debtQuotaIndex]);

  const debtOverdueItems = useMemo(() => {
    if (!mk) return [];
    const items = [];
    debtsArray.forEach((debt, debtIdx) => {
      const schedule = Array.isArray(debt?.schedule) ? debt.schedule : [];
      schedule
        .filter((q) => q.periodKey && q.periodKey < mk)
        .forEach((q, idx) => {
          const planned = Number(q.plannedAmount || 0);
          if (planned <= 0) return;
          const quotaKey =
            q.id || `${debt.id || debt.name || 'deuda'}-${debtIdx}-${idx}`;
          const paidBefore = Number(debtPaidBeforePeriod.get(quotaKey) || 0);
          const remaining = Math.max(planned - paidBefore, 0);
          if (remaining <= 0) return;
          const paidCurrent = debtPaidByQuotaId.has(quotaKey)
            ? debtPaidByQuotaId.get(quotaKey)
            : 0;
          const nameBase = debt.name || 'Deuda';
          const name = q.dueDate ? `${nameBase} (${q.dueDate})` : nameBase;
          items.push({
            id: quotaKey,
            name,
            planned: remaining,
            spent: Number.isNaN(paidCurrent) ? 0 : paidCurrent,
            isOverdue: true,
          });
        });
    });
    return items;
  }, [debtsArray, mk, debtPaidBeforePeriod, debtPaidByQuotaId]);

  const debtPlannedForPeriod = (() => {
    const current = debtsArray
      .flatMap((d) => (Array.isArray(d.schedule) ? d.schedule : []))
      .filter((q) => q.periodKey === mk)
      .reduce((sum, q) => sum + Number(q.plannedAmount || 0), 0);
    const overdue = debtOverdueItems.reduce(
      (sum, item) => sum + Number(item.planned || 0),
      0,
    );
    return current + overdue;
  })();

  const debtPeriodItems = useMemo(() => {
    if (!mk) return [];
    const items = [...debtOverdueItems];
    debtsArray.forEach((debt, debtIdx) => {
      const schedule = Array.isArray(debt?.schedule) ? debt.schedule : [];
      schedule
        .filter((q) => q.periodKey === mk)
        .forEach((q, idx) => {
          const planned = Number(q.plannedAmount || 0);
          const quotaKey =
            q.id || `${debt.id || debt.name || 'deuda'}-${debtIdx}-${idx}`;
          const paid = debtPaidByQuotaId.has(quotaKey)
            ? debtPaidByQuotaId.get(quotaKey)
            : 0;
          const nameBase = debt.name || 'Deuda';
          const name = q.dueDate ? `${nameBase} (${q.dueDate})` : nameBase;
          items.push({
            id: quotaKey,
            name,
            planned,
            spent: Number.isNaN(paid) ? 0 : paid,
            isOverdue: false,
          });
        });
    });
    return items;
  }, [debtsArray, mk, debtPaidByQuotaId, debtOverdueItems]);

  const savingsNameLookup = useMemo(() => {
    const counts = new Map();
    const ids = new Map();
    savingsArray.forEach((s) => {
      const key = normalizeName(s?.name);
      if (!key || !s?.id) return;
      counts.set(key, (counts.get(key) || 0) + 1);
      ids.set(key, s.id);
    });
    const lookup = {};
    counts.forEach((count, key) => {
      if (count === 1) lookup[key] = ids.get(key);
    });
    return lookup;
  }, [savingsArray]);

  const savingsPaidByIdForPeriod = useMemo(() => {
    if (!mk) return new Map();
    const { start, end } = getBudgetPeriod(mk, cutDay);
    const map = new Map();
    (transactions || []).forEach((t) => {
      // Solo aportes: un retiro de ahorro (ingreso) no cuenta como aporte del periodo.
      if (t?.category !== SAVINGS_CATEGORY || t?.type !== 'gasto') return;
      const dateKey = txDateKey(t);
      if (!dateKey || dateKey < start || dateKey >= end) return;
      let savingId = String(t?.meta?.savingId || '').trim();
      if (!savingId) {
        const nameKey = normalizeName(t?.meta?.savingName || '');
        savingId = nameKey ? savingsNameLookup[nameKey] : '';
      }
      if (!savingId) return;
      const amt = Number(t.amount || 0);
      if (Number.isNaN(amt)) return;
      map.set(savingId, (map.get(savingId) || 0) + amt);
    });
    return map;
  }, [transactions, mk, cutDay, savingsNameLookup]);

  const savingsUnassignedForPeriod = useMemo(() => {
    if (!mk) return 0;
    const { start, end } = getBudgetPeriod(mk, cutDay);
    let total = 0;
    (transactions || []).forEach((t) => {
      if (t?.type !== 'gasto') return;
      if (t?.category !== SAVINGS_CATEGORY) return;
      const dateKey = txDateKey(t);
      if (!dateKey || dateKey < start || dateKey >= end) return;
      const meta = t?.meta || {};
      if (meta?.savingId || meta?.savingName) return;
      const amt = Number(t.amount || 0);
      if (Number.isNaN(amt)) return;
      total += amt;
    });
    return total;
  }, [transactions, mk, cutDay]);

  const savingsPeriodItems = useMemo(() => {
    if (!mk) return [];
    const items = savingsArray
      .map((s, idx) => {
        const plan = plannedForSavingPeriod(s, mk, cutDay);
        if (plan <= 0) return null;
        const nameBase = s.name || 'Ahorro';
        const name = s.targetDate ? `${nameBase} (${s.targetDate})` : nameBase;
        return {
          id: s.id || `${nameBase}-${idx}`,
          name,
          planned: plan,
          spent: s.id ? savingsPaidByIdForPeriod.get(s.id) || 0 : 0,
        };
      })
      .filter(Boolean);
    if (savingsUnassignedForPeriod > 0) {
      items.push({
        id: `${SAVINGS_CATEGORY}-unbudgeted`,
        name: DEFAULT_UNBUDGETED_LABEL,
        planned: 0,
        spent: savingsUnassignedForPeriod,
      });
    }
    return items;
  }, [
    savingsArray,
    mk,
    cutDay,
    savingsPaidByIdForPeriod,
    savingsUnassignedForPeriod,
  ]);

  // --- SALDO DEL PERIODO (libro único, base caja) ---
  // saldo final = saldo anterior + ingresos + reembolsos + retiros de ahorro
  //               − consumo − cuotas − aportes ± ajustes. Traspasos no cuentan.
  const ledger = useMemo(
    () => periodLedger({ transactions, periodKey: mk, cutDay, debts: debtsArray }),
    [transactions, mk, cutDay, debtsArray],
  );
  const ingresosPeriodo = ledger.income;
  const ingresoEsperado = Number(expectedIncome || 0);
  // Para planificar se usa el ingreso esperado mientras no haya llegado todo.
  const ingresoBase = Math.max(ingresoEsperado, ingresosPeriodo);
  // Salidas reales: consumo + suscripciones + cuotas + aportes, menos reembolsos.
  const gastosPeriodo = ledger.outflows - ledger.refunds;

  const disponibleInicial = ledger.opening + ingresoBase;
  const disponible = ledger.closing;

  // --- FILAS POR CATEGORIA ---
  const rows = cats.map((c) => {
    // Gastos menos reembolsos de la categoría (misma fórmula en todas las pantallas).
    const spent = categorySpent(monthTx, c);

    const b = budgets?.[c];
    let plan = 0;
    let funded = 0;
    const breakdown = Array.isArray(b?.breakdown) ? b.breakdown : [];
    const isFixedCategory = resolveFixedCategory({
      entry: b,
      breakdown,
      fixedCategories,
      category: c,
    });
    const breakdownTotal = breakdown.reduce((acc, item, idx) => {
      const baseAmount = Number(item.amount || 0);
      if (!isFixedCategory) return acc + baseAmount;
      const id = item.id || item.name || `${c}-${idx}`;
      const carryover = fixedCarryoverMap.get(`${c}::${id}`) || 0;
      return acc + baseAmount + carryover;
    }, 0);
    let debtWarning = false;
    let savingsWarning = false;

    if (typeof b === 'number') {
      plan = funded = Number(b || 0);
    } else if (b && typeof b === 'object') {
      plan = Number(b.plan || 0);
      funded = Number(b.funded !== undefined ? b.funded : b.plan || 0);
    }

    if (breakdown.length) {
      plan = funded = breakdownTotal;
    }

    if (c === DEBT_CATEGORY) {
      plan = debtPlannedForPeriod;
      funded = debtPlannedForPeriod;
    }
    if (c === SAVINGS_CATEGORY) {
      const shouldAutofill = !b || (!funded && !plan);
      if (savingsPlannedForPeriod > 0 && shouldAutofill) {
        plan = savingsPlannedForPeriod;
        funded = savingsPlannedForPeriod;
      } else if (savingsPlannedForPeriod > funded && funded > 0) {
        savingsWarning = true;
      }
    }

    const pctFundedUsed = funded > 0 ? (spent / funded) * 100 : 0;

    return {
      c,
      spent,
      plan,
      funded,
      pctFundedUsed,
      breakdown,
      isFixedCategory,
      debtWarning,
      debtPlanned: debtPlannedForPeriod,
      savingsWarning,
      savingsPlanned: savingsPlannedForPeriod,
    };
  });

  const groupedRows = [
    {
      key: 'constantes',
      label: 'Categoria del sistema',
      rows: rows.filter(
        (r) => r.c === SAVINGS_CATEGORY || r.c === DEBT_CATEGORY,
      ),
      isConstant: true,
    },
    {
      key: 'fijos',
      label: 'Gasto fijo',
      rows: rows.filter(
        (r) =>
          r.c !== SAVINGS_CATEGORY &&
          r.c !== DEBT_CATEGORY &&
          r.isFixedCategory,
      ),
      isConstant: false,
    },
    {
      key: 'variables',
      label: 'Gasto variable',
      rows: rows.filter(
        (r) =>
          r.c !== SAVINGS_CATEGORY &&
          r.c !== DEBT_CATEGORY &&
          !r.isFixedCategory,
      ),
      isConstant: false,
    },
  ].filter((group) => group.rows.length > 0);

  const groupTotals = groupedRows.reduce((acc, group) => {
    acc[group.label] = group.rows.reduce((sum, row) => sum + row.funded, 0);
    return acc;
  }, {});

  const orderedRows = groupedRows.flatMap((group) =>
    group.rows.map((row) => ({
      ...row,
      group: group.key,
      groupLabel: group.label,
      isConstantGroup: group.isConstant,
    })),
  );

  const totalFunded = rows.reduce((a, r) => a + r.funded, 0);

  // Categorías sin presupuesto este periodo que sí lo tenían en el anterior (sin subcategorías;
  // las que tienen subcategorías ya se copian solas en el efecto de arriba).
  const copyableFromPrevious = cats.filter((cat) => {
    if (cat === DEBT_CATEGORY || cat === SAVINGS_CATEGORY) return false;
    const current = budgets?.[cat];
    const currentHasValue =
      (Array.isArray(current?.breakdown) && current.breakdown.length > 0) ||
      Number(current?.funded ?? current?.plan ?? current ?? 0) > 0;
    if (currentHasValue) return false;
    const prev = prevBudgets?.[cat];
    if (Array.isArray(prev?.breakdown) && prev.breakdown.length > 0) return false;
    return Number(prev?.funded ?? prev?.plan ?? prev ?? 0) > 0;
  });

  async function handleCopyPreviousBudget() {
    if (!setBudgetFunded) return;
    for (const cat of copyableFromPrevious) {
      const prev = prevBudgets?.[cat];
      await setBudgetFunded(mk, cat, Number(prev?.funded ?? prev?.plan ?? prev ?? 0));
    }
    toast.success(`Presupuesto copiado en ${copyableFromPrevious.length} categorías. Ajusta lo que cambió.`);
  }

  const restanteSinAsignar = disponibleInicial + ledger.savingWithdrawals - totalFunded;
  const disponibleMenosGastado = disponible;
  const presupuestoMenosGastado = totalFunded - gastosPeriodo;

  const defaultUnbudgetedKey = DEFAULT_UNBUDGETED_LABEL.toLowerCase();
  const overspentSubcategoryList = (() => {
    const seen = new Set();
    const items = [];
    rows.forEach((r) => {
      const breakdown = Array.isArray(r.breakdown) ? r.breakdown : [];
      const unassignedSpent = Number(unassignedSpentByCategory[r.c] || 0);
      let mergedUnassigned = false;
      breakdown.forEach((item, idx) => {
        const spentKey = item.id || item.name || `${r.c}-${idx}`;
        const carryKey = item.id || item.name || `${r.c}-${idx}`;
        let spent = Number(breakdownSpent[spentKey] || 0);
        const baseAmount = Number(item.amount || 0);
        const carryover = r.isFixedCategory
          ? fixedCarryoverMap.get(`${r.c}::${carryKey}`) || 0
          : 0;
        const planned = baseAmount + carryover;
        const name = item.name || 'Sin nombre';
        if (
          unassignedSpent > 0 &&
          String(name).trim().toLowerCase() === defaultUnbudgetedKey
        ) {
          spent += unassignedSpent;
          mergedUnassigned = true;
        }
        if (spent <= planned || spent <= 0) return;
        const key = `${r.c}::${name}`;
        if (seen.has(key)) return;
        seen.add(key);
        items.push({ cat: r.c, name });
      });
      if (unassignedSpent > 0 && !mergedUnassigned) {
        const name = DEFAULT_UNBUDGETED_LABEL;
        const key = `${r.c}::${name}`;
        if (!seen.has(key)) {
          seen.add(key);
          items.push({ cat: r.c, name });
        }
      }
    });
    return items;
  })();

  const overspentCategoryList = (() => {
    const set = new Set();
    rows.forEach((r) => {
      if (r.spent > r.funded && r.spent > 0) set.add(r.c);
    });
    overspentSubcategoryList.forEach((item) => set.add(item.cat));
    return Array.from(set);
  })();

  const hasOverspendAlert =
    overspentCategoryList.length > 0 || overspentSubcategoryList.length > 0;

  const subcategoryIndex = useMemo(() => {
    const byCategory = new Map();
    Object.entries(budgets || {}).forEach(([cat, entry]) => {
      const breakdown = Array.isArray(entry?.breakdown) ? entry.breakdown : [];
      const list = breakdown
        .map((item, idx) => ({
          id: String(item?.id || item?.name || `${cat}-${idx}`),
          name: String(item?.name || '').trim(),
        }))
        .filter((item) => item.name);
      if (list.length) {
        byCategory.set(cat, list);
      }
    });
    return { byCategory };
  }, [budgets]);

  const normalizeSubIds = (meta) => {
    const ids = Array.isArray(meta?.budgetSubcategoryIds)
      ? meta.budgetSubcategoryIds
      : meta?.budgetSubcategoryId
      ? [meta.budgetSubcategoryId]
      : [];
    return Array.from(
      new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)),
    );
  };

  const normalizeAllocationMap = (raw) => {
    if (!raw) return null;
    const out = {};
    if (Array.isArray(raw)) {
      raw.forEach((item) => {
        if (!item?.id) return;
        const id = String(item.id || '').trim();
        if (!id) return;
        out[id] = Number(item.amount || 0);
      });
    } else if (typeof raw === 'object') {
      Object.entries(raw).forEach(([key, value]) => {
        const id = String(key || '').trim();
        if (!id) return;
        out[id] = Number(value || 0);
      });
    }
    return Object.keys(out).length ? out : null;
  };

  async function migrateSubcategoryTransactions({
    fromCategory,
    fromSubId,
    fromSubName,
    toCategory,
    toSubId,
  }) {
    if (!actions?.updateTransaction) return { updated: 0, skipped: 0 };
    const list = Array.isArray(transactions) ? transactions : [];
    const targetKey = String(fromSubName || '').trim().toLowerCase();
    const updates = [];
    let skipped = 0;

    list.forEach((tx) => {
      if (!tx || tx.type !== 'gasto') return;
      if (tx.category !== fromCategory) return;
      const meta = tx.meta || {};
      const ids = normalizeSubIds(meta);
      const names = parseSubcategoryNames(meta);
      const idMatch = fromSubId && ids.includes(fromSubId);
      const nameMatch = targetKey
        ? names.some(
            (name) => String(name || '').trim().toLowerCase() === targetKey,
          )
        : false;
      if (!idMatch && !nameMatch) return;

      const nextMeta = { ...meta };
      const sameCategory = toCategory === fromCategory;
      let nextIds = ids;

      if (!sameCategory) {
        nextIds = toSubId ? [toSubId] : [];
        delete nextMeta.budgetSubcategoryAmounts;
        delete nextMeta.budgetSubcategoryAllocations;
      } else if (toSubId) {
        if (idMatch) {
          nextIds = ids.map((id) => (id === fromSubId ? toSubId : id));
        } else if (!ids.length) {
          nextIds = [toSubId];
        } else {
          skipped += 1;
          return;
        }
      } else {
        if (idMatch) {
          nextIds = ids.filter((id) => id !== fromSubId);
        } else if (!ids.length) {
          nextIds = [];
        } else {
          skipped += 1;
          return;
        }
      }

      const allocation = normalizeAllocationMap(
        nextMeta.budgetSubcategoryAmounts ||
          nextMeta.budgetSubcategoryAllocations,
      );
      if (allocation && idMatch) {
        if (toSubId) {
          allocation[toSubId] = allocation[fromSubId];
        }
        delete allocation[fromSubId];
        Object.keys(allocation).forEach((id) => {
          if (!nextIds.includes(id)) delete allocation[id];
        });
        if (Object.keys(allocation).length > 1) {
          nextMeta.budgetSubcategoryAmounts = allocation;
        } else {
          delete nextMeta.budgetSubcategoryAmounts;
          delete nextMeta.budgetSubcategoryAllocations;
        }
      } else {
        delete nextMeta.budgetSubcategoryAmounts;
        delete nextMeta.budgetSubcategoryAllocations;
      }

      if (nextIds.length) {
        nextMeta.budgetSubcategoryIds = nextIds;
      } else {
        delete nextMeta.budgetSubcategoryIds;
      }
      delete nextMeta.budgetSubcategoryId;
      delete nextMeta.budgetSubcategoryName;
      delete nextMeta.budgetSubcategoryNames;

      updates.push(
        actions.updateTransaction(tx.id, {
          category: toCategory,
          meta: nextMeta,
        }),
      );
    });

    await Promise.all(updates);
    return { updated: updates.length, skipped };
  }

  const rowGridClass =
    'grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.2fr)] sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.2fr)] lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.4fr)] items-center gap-2 sm:gap-3';

  function toggleExpanded(cat) {
    setExpandedCats((prev) => ({ ...prev, [cat]: !prev[cat] }));
  }

  function handleNewBreakdownChange(cat, field, value) {
    setNewBreakdownByCat((prev) => {
      const current = prev[cat] || { name: '', amount: '' };
      const nextValue =
        field === 'amount' ? String(value || '').replace(/\D/g, '') : value;
      return { ...prev, [cat]: { ...current, [field]: nextValue } };
    });
  }

  async function handleAddBreakdownInline(cat, breakdown = []) {
    if (!actions?.setBudgetFunded) return;
    const draft = newBreakdownByCat[cat] || { name: '', amount: '' };
    const name = (draft.name || '').trim();
    const amount = Number(String(draft.amount || '').replace(/\D/g, ''));
    if (!name && !amount) return;

    const existing = Array.isArray(breakdown) ? breakdown : [];
    const nextBreakdown = [
      ...existing,
      {
        id: Math.random().toString(36).slice(2, 10),
        name,
        amount: amount || 0,
      },
    ];
    const total = nextBreakdown.reduce(
      (sum, item) => sum + Number(item.amount || 0),
      0,
    );

    await actions.setBudgetFunded(monthKeyStr, cat, {
      funded: total,
      breakdown: nextBreakdown,
    });
    setNewBreakdownByCat((prev) => ({
      ...prev,
      [cat]: { name: '', amount: '' },
    }));
    setExpandedCats((prev) => ({ ...prev, [cat]: true }));
  }

  function handleEditBreakdownChange(cat, index, field, value) {
    setEditBreakdownByCat((prev) => {
      const catDrafts = prev[cat] || {};
      const current = catDrafts[index] || {};
      const nextValue =
        field === 'amount'
          ? String(value || '').replace(/\D/g, '')
          : value;
      return {
        ...prev,
        [cat]: {
          ...catDrafts,
          [index]: { ...current, [field]: nextValue },
        },
      };
    });
  }

  async function handleCommitBreakdownInline(cat, index, breakdown = []) {
    if (!actions?.setBudgetFunded) return;
    const catDrafts = editBreakdownByCat[cat] || {};
    const draft = catDrafts[index];
    if (!draft) return;
    const existing = Array.isArray(breakdown) ? breakdown : [];
    if (index < 0 || index >= existing.length) return;

    const current = existing[index] || {};
    const nextName =
      draft.name !== undefined ? String(draft.name).trim() : current.name || '';
    const nextAmount =
      draft.amount !== undefined
        ? Number(String(draft.amount || '').replace(/\D/g, ''))
        : Number(current.amount || 0);
    const nextBreakdown = existing.map((item, idx) =>
      idx === index
        ? {
            ...item,
            name: nextName,
            amount: Number(nextAmount || 0),
          }
        : item,
    );
    const total = nextBreakdown.reduce(
      (sum, item) => sum + Number(item.amount || 0),
      0,
    );

    await actions.setBudgetFunded(monthKeyStr, cat, {
      funded: total,
      breakdown: nextBreakdown,
    });
    setEditBreakdownByCat((prev) => ({
      ...prev,
      [cat]: {
        ...catDrafts,
        [index]: {
          name: nextName,
          amount: String(nextAmount || ''),
        },
      },
    }));
  }

  // Pagar un subgasto fijo (arriendo, luz, plan celular…) en un paso: crea el gasto ya
  // vinculado a su subcategoría por lo que falta. Solo en el periodo en curso; lo impago
  // de periodos anteriores ya se arrastra al actual.
  const isCurrentPeriod = (() => {
    if (!mk) return false;
    const { start, end } = getBudgetPeriod(mk, cutDay);
    const today = todayKey();
    return today >= start && today < end;
  })();
  const canPayFixed = isCurrentPeriod && Boolean(actions?.addTransaction);

  async function handlePayFixedSubcategory(cat, item, pending) {
    const amount = Math.round(Number(pending || 0));
    const subId = String(item?.spentKey || item?.id || '').trim();
    const name = String(item?.name || '').trim();
    if (!canPayFixed || amount <= 0 || !subId || !name) return;
    const ok = await confirmDialog(
      `Pagar ${formatCLP(amount)} de "${name}" (${cat}) con fecha de hoy.\n\nSi pagaste otro monto, regístralo desde Movimientos.`,
      { title: 'Registrar pago', confirmLabel: 'Pagar' },
    );
    if (!ok) return;
    const id = await actions.addTransaction({
      type: 'gasto',
      category: cat,
      amount,
      description: `Pago: ${name}`,
      date: todayKey(),
      createdAt: new Date().toISOString(),
      ownerId: activeUser?.id || null,
      ownerName: activeUser?.name || null,
      ownerEmail: activeUser?.email || null,
      meta: { budgetSubcategoryIds: [subId], budgetSubcategoryNames: name },
    });
    if (!id) return;
    toast.success(`Pago de ${name} registrado.`, {
      action: {
        label: 'Deshacer',
        onClick: async () => {
          const removed = await actions.removeTransaction?.(id);
          if (removed?.trashId) await actions.purgeTrashItem?.(removed.trashId);
        },
      },
    });
  }

  const renderFixedPayControl = (cat, item, effectivePlanned, spent) => {
    if (!canPayFixed || item?.isSynthetic || effectivePlanned <= 0) return null;
    if (spent >= effectivePlanned) {
      return (
        <span className="shrink-0 text-[10px] font-semibold text-[color:var(--success)]">
          ✓ Pagado
        </span>
      );
    }
    const pending = Number(item?.planned || 0) - spent;
    if (pending <= 0) return null;
    return (
      <button
        type="button"
        onClick={() => handlePayFixedSubcategory(cat, item, pending)}
        className="shrink-0 min-h-[28px] px-2.5 rounded-md bg-[color:var(--primary)] text-[color:var(--primary-contrast)] text-[11px] font-semibold"
        aria-label={`Pagar ${item?.name || 'subgasto'}`}
      >
        Pagar
      </button>
    );
  };

  async function handleRemoveBreakdownInline(cat, index, breakdown = []) {
    if (!actions?.setBudgetFunded) return;
    if (!Number.isInteger(index)) return;
    const existing = Array.isArray(breakdown) ? breakdown : [];
    if (index < 0 || index >= existing.length) return;
    const item = existing[index] || {};
    const name = String(item?.name || '').trim();
    const label = name ? ` "${name}"` : '';
    const ok = await confirmDialog(
      `Eliminar subcategoria${label}? Se movera a la papelera para poder recuperarla.`,
    );
    if (!ok) return;

    const subId = String(item?.id || item?.name || '').trim();
    const txList = Array.isArray(transactions) ? transactions : [];
    const targetKey = String(name || '').trim().toLowerCase();
    const affectedCount = actions?.updateTransaction
      ? txList.filter((tx) => {
          if (!tx || tx.type !== 'gasto') return false;
          if (tx.category !== cat) return false;
          const meta = tx.meta || {};
          const ids = normalizeSubIds(meta);
          const names = parseSubcategoryNames(meta);
          const idMatch = subId && ids.includes(subId);
          const nameMatch = targetKey
            ? names.some(
                (n) => String(n || '').trim().toLowerCase() === targetKey,
              )
            : false;
          return idMatch || nameMatch;
        }).length
      : 0;

    if (affectedCount > 0 && actions?.updateTransaction) {
      const wantsMigration = await confirmDialog(
        `Esta subcategoria tiene ${affectedCount} movimiento${
          affectedCount === 1 ? '' : 's'
        } asociado${
          affectedCount === 1 ? '' : 's'
        }. ¿Deseas migrarlos a otra subcategoria o categoria?`,
      );
      if (wantsMigration) {
        const categoryPrompt = cats.join(', ');
        const inputCategory = window.prompt(
          `Categoria destino (deja vacio para mantener "${cat}"):\n${categoryPrompt}`,
          cat,
        );
        if (inputCategory === null) return;
        const targetCategory = String(inputCategory || '').trim() || cat;
        if (!cats.includes(targetCategory)) {
          toast.warning('Categoría destino no válida.');
          return;
        }

        const targetBreakdown = subcategoryIndex.byCategory.get(
          targetCategory,
        );
        let targetSubId = '';
        if (Array.isArray(targetBreakdown) && targetBreakdown.length) {
          const targetNames = targetBreakdown.map((s) => s.name).join(', ');
          const subInput = window.prompt(
            `Subcategoria destino (opcional). Opciones:\n${targetNames}`,
            '',
          );
          if (subInput === null) return;
          const selectedName = String(subInput || '').trim();
          if (selectedName) {
            const match = targetBreakdown.find(
              (s) =>
                String(s.name || '').trim().toLowerCase() ===
                selectedName.toLowerCase(),
            );
            if (!match) {
              toast.warning('Subcategoría destino no válida.');
              return;
            }
            targetSubId = match.id;
          }
        }

        const { updated, skipped } = await migrateSubcategoryTransactions({
          fromCategory: cat,
          fromSubId: subId,
          fromSubName: name,
          toCategory: targetCategory,
          toSubId: targetSubId,
        });
        if (skipped > 0) {
          toast.warning(
            `Se migraron ${updated} movimiento${
              updated === 1 ? '' : 's'
            }. ${skipped} no se migraron por tener multiples subcategorias.`,
          );
        }
      }
    }
    const nextBreakdown = existing.filter((_, idx) => idx !== index);
    const total = nextBreakdown.reduce(
      (sum, item) => sum + Number(item.amount || 0),
      0,
    );
    if (addTrashItem) {
      const periodKey = mk || '';
      const rawId = item?.id || item?.name || `${cat}-${index}`;
      const itemId = `${periodKey}-${String(rawId || '').trim()}`;
      try {
        await addTrashItem('budget-subcategory', itemId, {
          category: cat,
          monthKey: periodKey,
          item,
          index,
        });
      } catch (err) {
        console.error('Error guardando subcategoria en papelera:', err);
      }
    }
    await actions.setBudgetFunded(monthKeyStr, cat, {
      funded: total,
      breakdown: nextBreakdown,
    });
    setEditBreakdownByCat((prev) => ({ ...prev, [cat]: {} }));
  }

  return (
    <>
      <div className="grid gap-4">
      {topSlot}
      {/* RESUMEN DEL PERIODO CON ROLLOVER: plegado para que lo primero sea qué hacer hoy */}
      <Card className="bg-transparent border-transparent shadow-none">
        <details open={totalFunded <= 0}>
        <summary className="cursor-pointer list-none">
          <SectionTitle>Números del presupuesto</SectionTitle>
          <div className="text-sm text-[color:var(--text-muted)]">
            {totalFunded > 0 ? (
              <>
                Te quedan <strong className="text-[color:var(--text)]"><Money n={presupuestoMenosGastado} /></strong> de{' '}
                <Money n={totalFunded} /> presupuestados ·{' '}
              </>
            ) : null}
            <span className="font-semibold text-[color:var(--primary)] dark:text-blue-300">Ver detalle</span>
          </div>
        </summary>
        <div className="text-xs text-[color:var(--text-muted)] mt-3 mb-3">
          Día de corte del mes: {budgetCutDay}
        </div>
        {/* Sin cashAvailable: el límite diario según la plata de hoy lo da "Qué hacer hoy". */}
        <PeriodOutlook
          rows={rows}
          periodKey={mk}
          cutDay={cutDay}
          income={ingresoBase}
          incomeIsExpected={ingresoEsperado > ingresosPeriodo}
          copyableCount={copyableFromPrevious.length}
          onCopyPrevious={handleCopyPreviousBudget}
        />
        <div className="mt-3 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-[color:var(--primary)]/35 bg-[color:var(--primary)]/20 px-5 py-4 shadow-[var(--shadow)]/80 ring-1 ring-[color:var(--primary)]/15 backdrop-blur-md">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs uppercase text-[color:var(--text-muted)]">
                Disponible
              </span>
              <button
                type="button"
                className="h-6 w-6 rounded-md border border-[color:var(--border)] text-[color:var(--text-muted)] transition hover:bg-[color:var(--surface-2)]"
                onClick={() =>
                  setSummaryOpen((prev) => ({
                    ...prev,
                    available: !prev.available,
                  }))
                }
                aria-expanded={summaryOpen.available}
                aria-label="Mostrar detalle de Disponible"
              >
                <span
                  className={`inline-block transition-transform ${
                    summaryOpen.available ? 'rotate-90' : ''
                  }`}
                >
                  &gt;
                </span>
              </button>
            </div>
            <div className="mt-1 text-lg font-semibold">
              <Money n={disponible} />
            </div>
            <div className="text-[10px] text-[color:var(--text-faint)]">
              Saldo actual del hogar (incluye lo que sobró antes)
            </div>
            {summaryOpen.available && (
              <div className="mt-2">
                <LedgerBreakdown ledger={ledger} expectedIncome={ingresoEsperado} />
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-[color:var(--primary)]/35 bg-[color:var(--primary)]/20 px-5 py-4 shadow-[var(--shadow)]/80 ring-1 ring-[color:var(--primary)]/15 backdrop-blur-md">
            <span className="text-xs uppercase text-[color:var(--text-muted)]">
              Presupuesto
            </span>
            <div className="mt-1 text-lg font-semibold">
              <Money n={totalFunded} />
            </div>
          </div>

          <div className="rounded-2xl border border-[color:var(--primary)]/35 bg-[color:var(--primary)]/20 px-5 py-4 shadow-[var(--shadow)]/80 ring-1 ring-[color:var(--primary)]/15 backdrop-blur-md">
            <span className="text-xs uppercase text-[color:var(--text-muted)]">
              Sin asignar
            </span>
            <div className="text-[10px] text-[color:var(--text-faint)]">
              Saldo anterior + ingreso {ingresoEsperado > ingresosPeriodo ? 'esperado' : 'recibido'} − presupuesto
            </div>
            <div
              className={`mt-1 text-lg font-semibold ${
                restanteSinAsignar < 0
                  ? 'text-[color:var(--danger)]'
                  : ''
              }`}
            >
              <Money n={restanteSinAsignar} />
            </div>
          </div>

          <div className="rounded-2xl border border-[color:var(--primary)]/35 bg-[color:var(--primary)]/20 px-5 py-4 shadow-[var(--shadow)]/80 ring-1 ring-[color:var(--primary)]/15 backdrop-blur-md">
            <span className="text-xs uppercase text-[color:var(--text-muted)]">
              Gastos del periodo
            </span>
            <div className="mt-2 space-y-1 text-xs text-[color:var(--text-muted)]">
              <div className="flex justify-between gap-2">
                <span>Gastado hasta ahora:</span>
                <strong className="text-[color:var(--text)]">
                  <Money n={gastosPeriodo} />
                </strong>
              </div>
              <div className="flex justify-between gap-2">
                <span>Disponible actual:</span>
                <strong
                  className={
                    disponibleMenosGastado < 0
                      ? 'text-[color:var(--danger)]'
                      : 'text-[color:var(--text)]'
                  }
                >
                  <Money n={disponibleMenosGastado} />
                </strong>
              </div>
              <div className="flex justify-between gap-2">
                <span>Presupuesto - Gastado:</span>
                <strong
                  className={
                    presupuestoMenosGastado < 0
                      ? 'text-[color:var(--danger)]'
                      : 'text-[color:var(--text)]'
                  }
                >
                  <Money n={presupuestoMenosGastado} />
                </strong>
              </div>
            </div>
          </div>
        </div>

        {hasOverspendAlert && (
          <div className="mt-4 rounded-lg border border-[color:var(--warning)]/30 bg-[color:var(--warning)]/15 px-3 py-2 text-xs text-[color:var(--warning)] space-y-1">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-[color:var(--warning)] text-[10px] font-bold text-[color:var(--warning)]">
                !
              </span>
              <span className="font-semibold">
                Alerta: algunos gastos superan el presupuesto:
              </span>
            </div>
            <div className="text-[11px] text-[color:var(--warning)]">
              {overspentCategoryList
                .slice(0, 6)
                .map((c) => `- ${c}`)
                .join(' ')}
              {overspentCategoryList.length > 6 ? ' - ...' : ''}
            </div>
          </div>
        )}
        </details>
      </Card>

      {beforeCategories}

      {/* CATEGORIAS */}
      <Card>
        <SectionTitle>Presupuestos por categoria</SectionTitle>

        <div className="overflow-x-hidden">
          <div className="min-w-0 space-y-2">
            <div className="md:hidden px-2 text-[11px] font-semibold uppercase text-[color:var(--text-muted)] flex justify-between">
              <span>Categoria</span>
              <span>Disponible</span>
            </div>
            <div
              className={`${rowGridClass} px-2 text-[11px] font-semibold uppercase text-[color:var(--text-muted)] hidden md:grid`}
            >
              <div>Categoria</div>
              <div className="text-right">Presupuestado</div>
              <div className="text-right">Gastado</div>
              <div className="text-right">Disponible</div>
              <div className="text-right">% gastado</div>
              <div>Barra gasto vs presupuesto</div>
            </div>

            <div className="space-y-2">
              {orderedRows.map((r, idx) => {
                const showGroupHeader =
                  idx === 0 || orderedRows[idx - 1].group !== r.group;
                const isConstantRow = !!r.isConstantGroup;
                const isDebtRow = r.c === DEBT_CATEGORY;
                const isSavingsRow = r.c === SAVINGS_CATEGORY;
                const isExpanded = !!expandedCats[r.c];
                const canEditBreakdown = !isDebtRow && !isSavingsRow;
                const unassignedSpent = Number(
                  unassignedSpentByCategory[r.c] || 0,
                );
                const detailRows = isDebtRow
                  ? debtPeriodItems.map((item) => ({
                      id: item.id,
                      name: item.name,
                      planned: Number(item.planned || 0),
                      spent: Number(item.spent || 0),
                      isOverdue: !!item.isOverdue,
                    }))
                  : isSavingsRow
                  ? savingsPeriodItems.map((item) => ({
                      id: item.id,
                      name: item.name,
                      planned: Number(item.planned || 0),
                      spent: Number(item.spent || 0),
                    }))
                  : (() => {
                      let items = (
                        Array.isArray(r.breakdown) ? r.breakdown : []
                      ).map((item, idx) => {
                        const itemId = item.id || item.name || `${r.c}-${idx}`;
                        const spentKey = item.id || item.name || itemId;
                        const baseAmount = Number(item.amount || 0);
                        const carryover = r.isFixedCategory
                          ? fixedCarryoverMap.get(`${r.c}::${itemId}`) || 0
                          : 0;
                        const planned = baseAmount + carryover;
                        return {
                          id: itemId,
                          name: item.name || 'Sin nombre',
                          planned,
                          baseAmount,
                          carryover,
                          spent: Number(breakdownSpent[spentKey] || 0),
                          spentKey,
                          sourceIndex: idx,
                        };
                      });
                      if (canEditBreakdown && unassignedSpent > 0) {
                        const matchedIndex = items.findIndex(
                          (item) =>
                            String(item.name || '')
                              .trim()
                              .toLowerCase() === defaultUnbudgetedKey,
                        );
                        if (matchedIndex >= 0) {
                          items = items.map((item, idx) =>
                            idx === matchedIndex
                              ? {
                                  ...item,
                                  spent:
                                    Number(item.spent || 0) + unassignedSpent,
                                }
                              : item,
                          );
                        } else {
                          items = [
                            ...items,
                            {
                              id: `${r.c}-unbudgeted`,
                              name: DEFAULT_UNBUDGETED_LABEL,
                              planned: 0,
                              baseAmount: 0,
                              carryover: 0,
                              spent: unassignedSpent,
                              isSynthetic: true,
                            },
                          ];
                        }
                      }
                      return items;
                    })();
                const debtCurrentRows = isDebtRow
                  ? detailRows.filter((item) => !item.isOverdue)
                  : [];
                const debtOverdueRows = isDebtRow
                  ? detailRows.filter((item) => item.isOverdue)
                  : [];
                const hasSubOver =
                  canEditBreakdown &&
                  detailRows.some(
                    (item) => item.spent > item.planned && item.spent > 0,
                  );
                const isCategoryOver =
                  (r.spent > r.funded && r.spent > 0) || hasSubOver;
                const available = r.funded - r.spent;
                const hasDetails = detailRows.length > 0;
                const showExpandToggle = isDebtRow || isSavingsRow || hasDetails;
                const expandLabel = isDebtRow
                  ? isExpanded
                    ? 'Contraer detalle de deudas'
                    : 'Expandir detalle de deudas'
                  : isSavingsRow
                  ? isExpanded
                    ? 'Contraer detalle de ahorros'
                    : 'Expandir detalle de ahorros'
                  : isExpanded
                  ? 'Contraer subcategorias'
                  : 'Expandir subcategorias';
                const newItemDraft = newBreakdownByCat[r.c] || {
                  name: '',
                  amount: '',
                };
                const rowContainerClass = `rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-1)]/80   ${
                  isConstantRow
                    ? 'bg-[color:var(--surface-2)]/80 border-[color:var(--border)] '
                    : ''
                }`;
                const groupTooltip =
                  r.groupLabel === 'Gasto fijo'
                    ? 'Reglas: si una subcategoria del periodo anterior no se pago completa o fue pago parcial, el pendiente se suma al valor presupuestado actual de esa subcategoria.'
                    : '';
                const buildInfoRows = (planned, spent, available, pct) => [
                  { label: 'Presupuestado', value: planned, kind: 'money' },
                  { label: 'Gastado', value: spent, kind: 'money' },
                  {
                    label: 'Disponible',
                    value: available,
                    kind: 'money',
                    danger: available < 0,
                  },
                  {
                    label: '% gastado',
                    value: planned > 0 ? `${pct.toFixed(0)}%` : '-',
                    kind: 'text',
                  },
                ];
                const categoryInfoRows = buildInfoRows(
                  Number(r.funded || 0),
                  Number(r.spent || 0),
                  available,
                  r.pctFundedUsed,
                );

                const renderDetailRow = (item) => {
                  const planned = Number(item.planned || 0);
                  const baseAmount = Number(
                    item.baseAmount !== undefined ? item.baseAmount : planned,
                  );
                  const carryover = r.isFixedCategory
                    ? Number(item.carryover || 0)
                    : 0;
                  const spent = Number(item.spent || 0);
                  const isEditableRow =
                    canEditBreakdown && Number.isInteger(item.sourceIndex);
                  const draft = isEditableRow
                    ? (editBreakdownByCat[r.c] || {})[item.sourceIndex]
                    : null;
                  const draftName =
                    isEditableRow && draft?.name !== undefined
                      ? draft.name
                      : item.name || '';
                  const draftAmount =
                    isEditableRow && draft?.amount !== undefined
                      ? draft.amount
                      : String(r.isFixedCategory ? baseAmount : planned);
                  const basePlanned =
                    isEditableRow && draft?.amount !== undefined
                      ? Number(String(draftAmount || '').replace(/\D/g, ''))
                      : r.isFixedCategory
                      ? baseAmount
                      : planned;
                  const effectivePlanned = r.isFixedCategory
                    ? basePlanned + carryover
                    : basePlanned;
                  const available = effectivePlanned - spent;
                  const pctUsed =
                    effectivePlanned > 0
                      ? (spent / effectivePlanned) * 100
                      : 0;
                  const isSubOver =
                    spent > effectivePlanned && spent > 0;
                  const isOverdue = isDebtRow && item.isOverdue;
                  const detailRowClass = `${rowGridClass} py-1 text-xs ${
                    isOverdue
                      ? 'bg-[color:var(--danger)]/15 text-[color:var(--danger)] rounded-md'
                      : 'text-[color:var(--text-muted)]'
                  }`;

                  return (
                    <div key={item.id} className={detailRowClass}>
                      <div className="flex items-start gap-2 min-w-0">
                        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                          {isEditableRow ? (
                            <input
                              className={`border rounded-md px-2 py-1 text-xs w-full min-w-0 ${
                                isSubOver
                                  ? 'text-[color:var(--danger)] border-[color:var(--danger)]/30'
                                  : ''
                              }`}
                              value={draftName}
                              onChange={(e) =>
                                handleEditBreakdownChange(
                                  r.c,
                                  item.sourceIndex,
                                  'name',
                                  e.target.value,
                                )
                              }
                              onBlur={() =>
                                handleCommitBreakdownInline(
                                  r.c,
                                  item.sourceIndex,
                                  r.breakdown,
                                )
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  e.currentTarget.blur();
                                }
                              }}
                            />
                          ) : (
                            <span
                              className={`truncate ${
                                isSubOver
                                  ? 'text-[color:var(--danger)] font-semibold'
                                  : ''
                              }`}
                            >
                              {item.name || 'Sin nombre'}
                            </span>
                          )}
                          {r.isFixedCategory && carryover > 0 && (
                            <span className="text-[10px] text-[color:var(--text-faint)]">
                              Pendiente: <Money n={carryover} />
                            </span>
                          )}
                        </div>
                        {r.isFixedCategory &&
                          renderFixedPayControl(r.c, item, effectivePlanned, spent)}
                        {isEditableRow && (
                          <button
                            type="button"
                            className="shrink-0 p-0.5 text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                            onClick={() =>
                              handleRemoveBreakdownInline(
                                r.c,
                                item.sourceIndex,
                                r.breakdown,
                              )
                            }
                            aria-label="Eliminar subcategoria"
                            data-tooltip="Eliminar subcategoria"
                          >
                            <svg
                              className="h-4 w-4"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M3 6h18" />
                              <path d="M8 6V4h8v2" />
                              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                              <path d="M10 11v6" />
                              <path d="M14 11v6" />
                            </svg>
                          </button>
                        )}
                      </div>
                      <div className="text-right">
                        {isEditableRow ? (
                          <div className="flex flex-col items-end gap-0.5">
                            <input
                              className="border rounded-md px-2 py-1 text-xs w-full text-right"
                              value={draftAmount}
                              onChange={(e) =>
                                handleEditBreakdownChange(
                                  r.c,
                                  item.sourceIndex,
                                  'amount',
                                  e.target.value,
                                )
                              }
                              onBlur={() =>
                                handleCommitBreakdownInline(
                                  r.c,
                                  item.sourceIndex,
                                  r.breakdown,
                                )
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  e.currentTarget.blur();
                                }
                              }}
                              inputMode="numeric"
                              pattern="\\d*"
                            />
                            {r.isFixedCategory && carryover > 0 && (
                              <span className="text-[10px] text-[color:var(--text-faint)]">
                                Total: <Money n={effectivePlanned} />
                              </span>
                            )}
                          </div>
                        ) : (
                          <Money n={planned} />
                        )}
                      </div>
                      <div className="text-right">
                        <Money n={spent} />
                      </div>
                      <div
                        className={`text-right ${
                          available < 0 ? 'text-[color:var(--danger)]' : ''
                        }`}
                      >
                        <Money n={available} />
                      </div>
                      <div className="text-right">
                        {effectivePlanned > 0
                          ? `${pctUsed.toFixed(0)}%`
                          : '-'}
                      </div>
                      <div>
                        <Progress
                          value={pctUsed}
                          mode={isSavingsRow ? 'good' : 'risk'}
                          danger={available < 0}
                        />
                      </div>
                    </div>
                  );
                };
                const renderDetailRowMobile = (item) => {
                  const planned = Number(item.planned || 0);
                  const baseAmount = Number(
                    item.baseAmount !== undefined ? item.baseAmount : planned,
                  );
                  const carryover = r.isFixedCategory
                    ? Number(item.carryover || 0)
                    : 0;
                  const spent = Number(item.spent || 0);
                  const effectivePlanned = r.isFixedCategory
                    ? baseAmount + carryover
                    : baseAmount;
                  const available = effectivePlanned - spent;
                  const pctUsed =
                    effectivePlanned > 0 ? (spent / effectivePlanned) * 100 : 0;
                  const isOverdue = isDebtRow && item.isOverdue;
                  const isEditableRow =
                    canEditBreakdown && Number.isInteger(item.sourceIndex);
                  const infoRows = buildInfoRows(
                    effectivePlanned,
                    spent,
                    available,
                    pctUsed,
                  );

                  return (
                    <div
                      key={item.id}
                      className="flex items-start justify-between gap-3 px-2 py-2 border-b last:border-b-0"
                    >
                      <div className="min-w-0 flex-1">
                        <div
                          className={`text-sm font-semibold whitespace-normal break-words ${
                            isOverdue ? 'text-[color:var(--danger)]' : ''
                          }`}
                        >
                          {item.name || 'Sin nombre'}
                        </div>
                        {r.isFixedCategory && carryover > 0 && (
                          <div className="text-[10px] text-[color:var(--text-faint)]">
                            Pendiente: <Money n={carryover} />
                          </div>
                        )}
                        <div className="mt-2">
                          <Progress
                            value={pctUsed}
                            mode={isSavingsRow ? 'good' : 'risk'}
                            danger={available < 0}
                          />
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {r.isFixedCategory &&
                          renderFixedPayControl(r.c, item, effectivePlanned, spent)}
                        {isEditableRow && (
                          <button
                            type="button"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[color:var(--divider)] text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                            aria-label="Editar subcategoria"
                            onClick={() =>
                              setBreakdownModal({
                                category: r.c,
                                focusIndex: item.sourceIndex,
                              })
                            }
                          >
                            <svg
                              className="h-4 w-4"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M16.862 4.487a1.5 1.5 0 1 1 2.121 2.121L7.5 18.09l-4.5.9.9-4.5 12.962-12.003z" />
                            </svg>
                          </button>
                        )}
                        <div className="text-right">
                          <div className="text-[10px] text-[color:var(--text-muted)]">
                            Disponible
                          </div>
                          <div
                            className={`text-sm font-semibold ${
                              available < 0 ? 'text-[color:var(--danger)]' : ''
                            }`}
                          >
                            <Money n={available} />
                          </div>
                        </div>
                        <button
                          type="button"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[color:var(--divider)] text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                          aria-label="Ver detalle"
                          onClick={() =>
                            setBudgetInfo({
                              title: `Detalle de ${item.name || 'Subcategoria'}`,
                              rows: infoRows,
                            })
                          }
                        >
                          i
                        </button>
                      </div>
                    </div>
                  );
                };

                return (
                  <React.Fragment key={r.c}>
                    {showGroupHeader && (
                      <div className="px-2 pt-3">
                        <div className="inline-flex items-center gap-2">
                          <div className="inline-flex items-center gap-2 rounded-full bg-[color:var(--surface-2)]/80 text-[color:var(--text)] text-[10px] uppercase tracking-wide px-2.5 py-0.5 border border-[color:var(--border)]">
                            <span>{r.groupLabel}</span>
                            <span className="text-[10px] font-semibold text-[color:var(--text-faint)]">
                              <Money n={groupTotals[r.groupLabel] || 0} />
                            </span>
                          </div>
                          {groupTooltip && (
                            <span
                              className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[color:var(--border)] text-[10px] font-semibold text-[color:var(--text-muted)] tooltip-wide"
                              data-tooltip={groupTooltip}
                              aria-label={groupTooltip}
                            >
                              i
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                    <div className={rowContainerClass}>
                      <div className="md:hidden px-2 py-2 space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-2 min-w-0">
                            {showExpandToggle && (
                              <button
                                type="button"
                                className="w-6 h-6 mt-0.5 flex items-center justify-center rounded border text-xs text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)]"
                                onClick={() => toggleExpanded(r.c)}
                                aria-label={expandLabel}
                                aria-expanded={isExpanded}
                              >
                                {isExpanded ? 'v' : '>'}
                              </button>
                            )}
                            {canEditBreakdown && (
                              <button
                                type="button"
                                className="w-6 h-6 mt-0.5 flex items-center justify-center rounded border text-xs text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)]"
                                onClick={() =>
                                  setBreakdownModal({ category: r.c })
                                }
                                aria-label="Agregar subcategoria"
                              >
                                +
                              </button>
                            )}
                            <div className="min-w-0">
                              <div
                                className={`font-semibold whitespace-normal break-words leading-snug ${
                                  isCategoryOver ? 'text-[color:var(--danger)]' : ''
                                }`}
                              >
                                {r.c}
                              </div>
                              {r.c === DEBT_CATEGORY && (
                                <div className="text-[11px] text-[color:var(--text-muted)]">
                                  Desde Modulo Deudas
                                </div>
                              )}
                              {r.c === SAVINGS_CATEGORY && (
                                <div className="text-[11px] text-[color:var(--text-muted)]">
                                  Desde Modulo Ahorro
                                </div>
                              )}
                              {r.c === DEBT_CATEGORY &&
                                r.debtPlanned > 0 &&
                                r.debtWarning && (
                                  <div className="text-[11px] text-[color:var(--danger)]">
                                    (supera lo presupuestado)
                                  </div>
                                )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="text-right">
                              <div className="text-[10px] text-[color:var(--text-muted)]">
                                Disponible
                              </div>
                              <div
                                className={`text-sm font-semibold ${
                                  available < 0 ? 'text-[color:var(--danger)]' : ''
                                }`}
                              >
                                <Money n={available} />
                              </div>
                            </div>
                            <button
                              type="button"
                              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[color:var(--divider)] text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                              aria-label="Ver detalle"
                              onClick={() =>
                                setBudgetInfo({
                                  title: `Detalle de ${r.c}`,
                                  rows: categoryInfoRows,
                                })
                              }
                            >
                              i
                            </button>
                          </div>
                        </div>
                        <div>
                          <Progress
                            value={r.pctFundedUsed}
                            mode={isSavingsRow ? 'good' : 'risk'}
                            danger={available < 0}
                          />
                        </div>
                      </div>

                      <div className={`${rowGridClass} px-2 py-2 hidden md:grid`}>
                      <div className="flex items-start gap-2">
                        {showExpandToggle ? (
                          <button
                            type="button"
                            className="w-6 h-6 mt-0.5 flex items-center justify-center rounded border text-xs text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)] "
                            onClick={() => toggleExpanded(r.c)}
                            aria-label={expandLabel}
                            aria-expanded={isExpanded}
                          >
                            {isExpanded ? 'v' : '>'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="w-6 h-6 mt-0.5 flex items-center justify-center rounded border text-xs text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)]  disabled:opacity-50"
                            onClick={() =>
                              canEditBreakdown && toggleExpanded(r.c)
                            }
                            disabled={!canEditBreakdown}
                            aria-label="Agregar subcategorias"
                          >
                            +
                          </button>
                        )}

                        <div className="min-w-0">
                          <div
                            className={`font-semibold whitespace-normal break-words leading-snug ${
                              isCategoryOver ? 'text-[color:var(--danger)]' : ''
                            }`}
                          >
                            {r.c}
                          </div>

                          {r.c === DEBT_CATEGORY && (
                            <div className="text-[11px] text-[color:var(--text-muted)]">
                              Desde Modulo Deudas
                            </div>
                          )}
                          {r.c === SAVINGS_CATEGORY && (
                            <div className="text-[11px] text-[color:var(--text-muted)]">
                              Desde Modulo Ahorro
                            </div>
                          )}

                              {r.c === DEBT_CATEGORY &&
                                r.debtPlanned > 0 &&
                                r.debtWarning && (
                              <div className="text-[11px] text-[color:var(--danger)]">
                                (supera lo presupuestado)
                              </div>
                            )}
                        </div>
                      </div>

                      <div className="text-right font-semibold">
                        <Money n={r.funded || 0} />
                      </div>
                      <div className="text-right">
                        <Money n={r.spent || 0} />
                      </div>
                      <div
                        className={`text-right ${
                          available < 0 ? 'text-[color:var(--danger)]' : ''
                        }`}
                      >
                        <Money n={available} />
                      </div>
                      <div className="text-right">
                        {r.funded > 0 ? `${r.pctFundedUsed.toFixed(0)}%` : '-'}
                      </div>
                      <div>
                        <Progress
                          value={r.pctFundedUsed}
                          mode={isSavingsRow ? 'good' : 'risk'}
                          danger={available < 0}
                        />
                      </div>
                    </div>

                    {isExpanded &&
                      (isDebtRow ||
                        detailRows.length > 0 ||
                        canEditBreakdown) && (
                        <>
                          <div className="md:hidden border-t border-[color:var(--divider)] pb-2 pt-1">
                            {detailRows.length === 0 && isDebtRow && (
                              <div className="px-2 py-2 text-xs text-[color:var(--text-muted)]">
                                Sin deudas en este periodo.
                              </div>
                            )}
                            {detailRows.length === 0 && !isDebtRow && (
                              <div className="px-2 py-2 text-xs text-[color:var(--text-muted)]">
                                Sin subcategorias.
                              </div>
                            )}
                            {isDebtRow ? (
                              <>
                                {debtCurrentRows.map(renderDetailRowMobile)}
                                {debtOverdueRows.length > 0 && (
                                  <div className="px-2 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--danger)]">
                                    Cuotas atrasadas
                                  </div>
                                )}
                                {debtOverdueRows.map(renderDetailRowMobile)}
                              </>
                            ) : (
                              detailRows.map(renderDetailRowMobile)
                            )}
                          </div>

                          <div className="hidden md:block border-t border-[color:var(--divider)]  pb-2 pt-1 pl-8 pr-2 space-y-1">
                            {detailRows.length === 0 && isDebtRow && (
                              <div
                                className={`${rowGridClass} py-1 text-xs text-[color:var(--text-muted)]`}
                              >
                                <div>Sin deudas en este periodo.</div>
                                <div className="text-right">-</div>
                                <div className="text-right">-</div>
                                <div className="text-right">-</div>
                                <div className="text-right">-</div>
                                <div>-</div>
                              </div>
                            )}
                            {isDebtRow ? (
                              <>
                                {debtCurrentRows.map(renderDetailRow)}
                                {debtOverdueRows.length > 0 && (
                                  <div
                                    className={`${rowGridClass} py-1 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--danger)]`}
                                  >
                                    <div className="col-span-6 border-t border-[color:var(--danger)]/30 pt-1">
                                      Cuotas atrasadas
                                    </div>
                                  </div>
                                )}
                                {debtOverdueRows.map(renderDetailRow)}
                              </>
                            ) : (
                              detailRows.map(renderDetailRow)
                            )}
                            {canEditBreakdown && (
                              <div className={`${rowGridClass} py-2`}>
                                <div className="col-span-6">
                                  <div className="grid gap-2 md:grid-cols-[minmax(12rem,1.6fr)_minmax(8rem,1fr)_auto] items-start border rounded-lg p-2">
                                    <div className="flex flex-col gap-1">
                                      <input
                                        className="border rounded-lg px-2 py-1 text-sm w-full"
                                        value={newItemDraft.name}
                                        onChange={(e) =>
                                          handleNewBreakdownChange(
                                            r.c,
                                            'name',
                                            e.target.value,
                                          )
                                        }
                                        placeholder="Nombre del gasto: Luz, Agua, Internet"
                                      />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                      <input
                                        className="border rounded-lg px-2 py-1 text-sm w-full text-right"
                                        value={newItemDraft.amount}
                                        onChange={(e) =>
                                          handleNewBreakdownChange(
                                            r.c,
                                            'amount',
                                            e.target.value,
                                          )
                                        }
                                        placeholder="monto"
                                        inputMode="numeric"
                                        pattern="\\d*"
                                      />
                                    </div>
                                    <div className="flex justify-end md:justify-start pt-4 md:pt-0">
                                      <button
                                        type="button"
                                        className="px-3 py-1.5 text-xs rounded-lg border text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)] disabled:opacity-60"
                                        onClick={() =>
                                          handleAddBreakdownInline(
                                            r.c,
                                            r.breakdown,
                                          )
                                        }
                                        disabled={
                                          !newItemDraft.name.trim() &&
                                          !newItemDraft.amount
                                        }
                                      >
                                        Agregar
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        </div>
      </Card>

      </div>
      {budgetInfo && (
        <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 backdrop-blur-sm pt-16 px-4">
          <div className="bg-[color:var(--surface-1)] rounded-2xl shadow-[var(--shadow)] p-5 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">{budgetInfo.title}</h3>
              <button
                type="button"
                className="text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                onClick={() => setBudgetInfo(null)}
              >
                Cerrar
              </button>
            </div>
            <div className="space-y-2 text-sm">
              {budgetInfo.rows.map((row) => (
                <div key={row.label} className="flex justify-between gap-4">
                  <span className="text-[color:var(--text-muted)]">{row.label}</span>
                  <span
                    className={`font-medium text-right ${
                      row.danger ? 'text-[color:var(--danger)]' : ''
                    }`}
                  >
                    {row.kind === 'money' ? <Money n={row.value} /> : row.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {breakdownModal &&
        (() => {
          const cat = breakdownModal.category;
          const focusIndex = Number.isInteger(breakdownModal.focusIndex)
            ? breakdownModal.focusIndex
            : -1;
          const entry = budgets?.[cat] || {};
          const breakdown = Array.isArray(entry.breakdown) ? entry.breakdown : [];
          const draft = newBreakdownByCat[cat] || { name: '', amount: '' };
          const catDrafts = editBreakdownByCat[cat] || {};
          return (
            <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 backdrop-blur-sm pt-16 px-4">
              <div className="bg-[color:var(--surface-1)] rounded-2xl shadow-[var(--shadow)] p-5 w-full max-w-md max-h-[calc(100vh-7rem)] overflow-y-auto">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold">
                    Subcategorias de {cat}
                  </h3>
                  <button
                    type="button"
                    className="text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                    onClick={() => setBreakdownModal(null)}
                  >
                    Cerrar
                  </button>
                </div>

                <div className="space-y-4 text-sm">
                  <div className="border rounded-lg p-3 space-y-2">
                    <div className="text-xs uppercase text-[color:var(--text-muted)]">
                      Agregar subcategoria
                    </div>
                    <input
                      className="border rounded-lg px-2 py-2 text-sm w-full"
                      value={draft.name}
                      onChange={(e) =>
                        handleNewBreakdownChange(cat, 'name', e.target.value)
                      }
                      placeholder="Nombre del gasto"
                    />
                    <input
                      className="border rounded-lg px-2 py-2 text-sm w-full"
                      value={draft.amount}
                      onChange={(e) =>
                        handleNewBreakdownChange(cat, 'amount', e.target.value)
                      }
                      placeholder="Monto"
                      inputMode="numeric"
                      pattern="\\d*"
                    />
                    <button
                      type="button"
                      className="w-full px-3 py-2 rounded-lg border text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)] disabled:opacity-60"
                      onClick={() => handleAddBreakdownInline(cat, breakdown)}
                      disabled={!draft.name.trim() && !draft.amount}
                    >
                      Agregar
                    </button>
                  </div>

                  <div className="space-y-3">
                    {breakdown.length === 0 && (
                      <div className="text-xs text-[color:var(--text-muted)]">
                        No hay subcategorias.
                      </div>
                    )}
                    {breakdown.map((item, idx) => {
                      const rowDraft = catDrafts[idx] || {};
                      const nameValue =
                        rowDraft.name !== undefined
                          ? rowDraft.name
                          : item.name || '';
                      const amountValue =
                        rowDraft.amount !== undefined
                          ? rowDraft.amount
                          : String(item.amount || '');
                      const shouldFocus = idx === focusIndex;
                      return (
                        <div
                          key={item.id || `${cat}-${idx}`}
                          className={`border rounded-lg p-3 space-y-2 ${
                            shouldFocus ? 'ring-1 ring-[color:var(--primary)]/40' : ''
                          }`}
                        >
                          <input
                            className="border rounded-lg px-2 py-2 text-sm w-full"
                            value={nameValue}
                            onChange={(e) =>
                              handleEditBreakdownChange(
                                cat,
                                idx,
                                'name',
                                e.target.value,
                              )
                            }
                            placeholder="Nombre"
                            autoFocus={shouldFocus}
                          />
                          <input
                            className="border rounded-lg px-2 py-2 text-sm w-full"
                            value={amountValue}
                            onChange={(e) =>
                              handleEditBreakdownChange(
                                cat,
                                idx,
                                'amount',
                                e.target.value,
                              )
                            }
                            placeholder="Monto"
                            inputMode="numeric"
                            pattern="\\d*"
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              className="px-3 py-1.5 text-xs rounded-lg border text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)]"
                              onClick={() =>
                                handleCommitBreakdownInline(cat, idx, breakdown)
                              }
                            >
                              Guardar
                            </button>
                            <button
                              type="button"
                              className="px-3 py-1.5 text-xs rounded-lg border border-[color:var(--danger)]/40 text-[color:var(--danger)] hover:bg-[color:var(--danger)]/10"
                              onClick={() =>
                                handleRemoveBreakdownInline(cat, idx, breakdown)
                              }
                            >
                              Eliminar
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          );
        })()}
    </>
  );
}













