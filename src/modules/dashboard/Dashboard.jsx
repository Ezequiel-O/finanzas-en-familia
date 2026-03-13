// src/modules/dashboard/Dashboard.jsx
import { Card } from '../../components/ui/card.jsx';
import { SectionTitle } from '../../components/ui/SectionTitle.jsx';
import { Money } from '../../components/ui/money.jsx';
import { Progress } from '../../components/ui/Progress.jsx';
import { CATEGORIES, DEBT_CATEGORY } from '../../constants.js';
import { filterTransactionsByPeriodAndUser } from '../../utils/transactions.js';
import {
  budgetMonthKeyForDate,
  dateKeyFromValue,
  shiftMonth,
} from '../../utils/budgetPeriod.js';
import {
  getFixedCarryoverForSubcategory,
  resolveFixedCategory,
} from '../../utils/fixedBudgets.js';
import { getSubcategoryAllocationsForTransaction } from '../../utils/subcategoryAllocations.js';

const SAVINGS_CATEGORY = 'Ahorro';
const DEFAULT_SAVINGS_PERIODS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SHORT_MONTHS = [
  'Ene',
  'Feb',
  'Mar',
  'Abr',
  'May',
  'Jun',
  'Jul',
  'Ago',
  'Sep',
  'Oct',
  'Nov',
  'Dic',
];

// Helper: extract year from a budget month key "YYYY-MM"
function yearFromMonthKey(mk) {
  const y = Number((mk || '').split('-')[0]);
  return Number.isNaN(y) ? new Date().getFullYear() : y;
}

function shortMonthLabelFromKey(mk) {
  const [yStr, mStr] = (mk || '').split('-');
  const year = String(yStr || '').trim();
  const month = Number(mStr);
  if (!year || Number.isNaN(month) || month < 1 || month > 12) {
    return mk || '';
  }
  return `${SHORT_MONTHS[month - 1]} ${year}`;
}

// Normalize budget entry (number or object)
function normalizeBudgetEntry(entry) {
  if (typeof entry === 'number') {
    const n = Number(entry || 0);
    return { plan: n, funded: n };
  }
  if (entry && typeof entry === 'object') {
    const plan = Number(entry.plan || 0);
    const funded = Number(
      entry.funded !== undefined ? entry.funded : entry.plan || 0,
    );
    return { plan, funded };
  }
  return { plan: 0, funded: 0 };
}

function normalizeLabel(value) {
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

function matchesSubcategory(meta, subId, subName) {
  const id = subId ? String(subId) : '';
  if (id) {
    const ids = Array.isArray(meta?.budgetSubcategoryIds)
      ? meta.budgetSubcategoryIds
      : meta?.budgetSubcategoryId
      ? [meta.budgetSubcategoryId]
      : [];
    if (ids.some((value) => String(value) === id)) return true;
  }
  const nameKey = normalizeLabel(subName);
  if (!nameKey) return false;
  const names = parseSubcategoryNames(meta);
  return names.some((name) => normalizeLabel(name) === nameKey);
}

function getSubcategorySpentFromPeriod(
  periodTx,
  category,
  subId,
  subName,
  breakdown,
) {
  if (!Array.isArray(periodTx) || !periodTx.length) return 0;
  return periodTx.reduce((sum, tx) => {
    if (tx?.type !== 'gasto') return sum;
    if (tx?.category !== category) return sum;
    const allocations = getSubcategoryAllocationsForTransaction({
      transaction: tx,
      breakdown,
    });
    if (allocations.length) {
      const match = allocations.find(
        (item) => String(item.id) === String(subId),
      );
      if (!match) return sum;
      return sum + Number(match.amount || 0);
    }
    if (!matchesSubcategory(tx?.meta || {}, subId, subName)) return sum;
    const amt = Number(tx.amount || 0);
    return Number.isNaN(amt) ? sum : sum + amt;
  }, 0);
}

function findBreakdownItem(breakdown, subId, subName) {
  const id = subId ? String(subId) : '';
  if (id) {
    const match = breakdown.find((item) => String(item?.id || '') === id);
    if (match) return match;
  }
  const nameKey = normalizeLabel(subName);
  if (!nameKey) return null;
  return (
    breakdown.find(
      (item) => normalizeLabel(item?.name || '') === nameKey,
    ) || null
  );
}

function getCategorySpentFromPeriod(periodTx, category) {
  if (!Array.isArray(periodTx) || !periodTx.length) return 0;
  return periodTx.reduce((sum, tx) => {
    if (tx?.type !== 'gasto') return sum;
    if (tx?.category !== category) return sum;
    const amt = Number(tx.amount || 0);
    return Number.isNaN(amt) ? sum : sum + amt;
  }, 0);
}

function plannedDebtsForPeriod(debts, periodKey) {
  if (!periodKey) return 0;
  return (debts || [])
    .flatMap((d) => (Array.isArray(d.schedule) ? d.schedule : []))
    .filter((q) => q.periodKey === periodKey)
    .reduce((s, q) => s + Number(q.plannedAmount || 0), 0);
}

function savingStartPeriodKey(s, cutDay) {
  const dateKey = dateKeyFromValue(s?.createdAt);
  return dateKey ? budgetMonthKeyForDate(dateKey, cutDay) : '';
}

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

function planForSavingLegacy(s, periodKey, cutDay) {
  if (!periodKey) return { plan: 0, targetPk: '' };
  const rawStartPk = savingStartPeriodKey(s, cutDay);
  const startPk = rawStartPk || periodKey;
  const periods = Math.max(1, Number(DEFAULT_SAVINGS_PERIODS) || 1);
  const targetPk = s?.targetDate
    ? budgetMonthKeyForDate(s.targetDate, cutDay)
    : shiftMonth(startPk, periods - 1);

  const normalizedTarget =
    targetPk && rawStartPk && rawStartPk > targetPk ? rawStartPk : targetPk;

  if (rawStartPk && periodKey < rawStartPk) {
    return { plan: 0, targetPk: normalizedTarget };
  }

  const goal = Number(s.goal || 0);
  const saved = Number(s.saved || 0);
  const remaining = Math.max(goal - saved, 0);
  if (remaining <= 0 || (normalizedTarget && periodKey > normalizedTarget)) {
    return { plan: 0, targetPk: normalizedTarget };
  }

  const scheduleStartPk = rawStartPk || periodKey;
  if (periodKey < scheduleStartPk) {
    return { plan: 0, targetPk: normalizedTarget };
  }
  const totalPeriods = periodsBetween(
    scheduleStartPk,
    normalizedTarget || scheduleStartPk,
  );
  const basePlan =
    totalPeriods > 0 ? Math.floor(remaining / totalPeriods) : remaining;
  const delta = remaining - basePlan * totalPeriods;
  const plan = periodKey === normalizedTarget ? basePlan + delta : basePlan;
  return { plan, targetPk: normalizedTarget };
}

function resolveSchedulePeriodKey(entry, cutDay) {
  if (entry?.periodKey) return entry.periodKey;
  if (entry?.dueDate) {
    return budgetMonthKeyForDate(entry.dueDate, cutDay);
  }
  return '';
}

function plannedForSavingPeriod(s, periodKey, cutDay) {
  if (!periodKey) return 0;
  const schedule = Array.isArray(s?.schedule) ? s.schedule : [];
  if (schedule.length) {
    return schedule
      .filter((q) => resolveSchedulePeriodKey(q, cutDay) === periodKey)
      .reduce((sum, q) => sum + Number(q.plannedAmount || 0), 0);
  }
  const { plan, targetPk } = planForSavingLegacy(s, periodKey, cutDay);
  if (!targetPk || periodKey > targetPk) return 0;
  return plan;
}

function plannedSavingsForPeriod(savings, periodKey, cutDay) {
  if (!periodKey) return 0;
  return (savings || []).reduce(
    (sum, s) => sum + plannedForSavingPeriod(s, periodKey, cutDay),
    0,
  );
}

const CLP_FORMATTER = new Intl.NumberFormat('es-CL');
function formatCLP(value) {
  const safe = Number(value || 0);
  const abs = Math.abs(safe);
  const formatted = CLP_FORMATTER.format(Math.round(abs));
  return `${safe < 0 ? '-' : ''}$${formatted}`;
}

export function Dashboard({ data, monthKeyStr }) {
  const {
    categories = CATEGORIES,
    budgets = {},
    budgetsAll = {},
    transactions = [],
    debts = [],
    savings = [],
    fixedCategories = {},
    budgetCutDay = 1,
    activeUserPreferences,
  } = data || {};

  const mk = monthKeyStr;
  const currentYear =
    Number((monthKeyStr || '').split('-')[0]) ||
    new Date().getFullYear();
  // Filtramos movimientos del periodo actual (segun dia de corte)
  const monthTx = filterTransactionsByPeriodAndUser(
    transactions,
    mk,
    budgetCutDay,
    null,
    false,
  );

  const totalIngresos = monthTx
    .filter((t) => t.type === 'ingreso')
    .reduce((a, b) => a + Number(b.amount || 0), 0);

  const totalGastos = monthTx
    .filter((t) => t.type === 'gasto')
    .reduce((a, b) => a + Number(b.amount || 0), 0);

  const balance = totalIngresos - totalGastos;

  const cats = categories && categories.length ? categories : CATEGORIES;
  const catsWithSavings = cats.includes(SAVINGS_CATEGORY)
    ? cats
    : [...cats, SAVINGS_CATEGORY];

  const hasMonthlyBudgets = Object.keys(budgetsAll || {}).some((key) =>
    /^\d{4}-\d{2}$/.test(key),
  );

  const catSpend = catsWithSavings.reduce((acc, c) => {
    const debtPlanned =
      c === DEBT_CATEGORY ? plannedDebtsForPeriod(debts, mk) : 0;
    const savingsPlanned =
      c === SAVINGS_CATEGORY
        ? plannedSavingsForPeriod(savings, mk, budgetCutDay)
        : 0;

    const spent = monthTx
      .filter((t) => t.type === 'gasto' && t.category === c)
      .reduce((a, b) => a + Number(b.amount || 0), 0);

    const b = budgets?.[c];
    let plan = 0;
    let funded = 0;

    if (typeof b === 'number') {
      plan = funded = Number(b || 0);
    } else if (b && typeof b === 'object') {
      plan = Number(b.plan || 0);
      funded = Number(b.funded !== undefined ? b.funded : b.plan || 0);
    }

    if (c === DEBT_CATEGORY && debtPlanned > 0) {
      const shouldAutofill = !b || (!funded && !plan);
      if (shouldAutofill) {
        plan = funded = debtPlanned;
      }
    }

    if (c === SAVINGS_CATEGORY && savingsPlanned > 0) {
      const shouldAutofill = !b || (!funded && !plan);
      if (shouldAutofill) {
        plan = funded = savingsPlanned;
      }
    }

    const pctFundedUsed = funded > 0 ? (spent / funded) * 100 : 0;

    acc[c] = {
      spent,
      plan,
      funded,
      pctFundedUsed,
      debtPlanned,
      savingsPlanned,
    };
    return acc;
  }, {});

  const visibleCats = catsWithSavings.filter((c) => {
    const info = catSpend[c] || {};
    return (
      Number(info.spent || 0) > 0 ||
      Number(info.plan || 0) > 0 ||
      Number(info.funded || 0) > 0 ||
      (c === DEBT_CATEGORY && Number(info.debtPlanned || 0) > 0) ||
      (c === SAVINGS_CATEGORY && Number(info.savingsPlanned || 0) > 0)
    );
  });

  const pctIngresosVsGastos =
    totalIngresos > 0 ? (totalGastos / totalIngresos) * 100 : 0;

  const debtTotals = debts.reduce(
    (acc, d) => {
      acc.original += Number(d.original || 0);
      acc.remaining += Number(d.remaining || 0);
      return acc;
    },
    { original: 0, remaining: 0 },
  );

  const debtProgress =
    debtTotals.original > 0
      ? ((debtTotals.original - debtTotals.remaining) / debtTotals.original) *
        100
      : 0;
  const debtPaid = Math.max(
    0,
    Number(debtTotals.original || 0) - Number(debtTotals.remaining || 0),
  );

  const savingsNameLookup = (() => {
    const counts = new Map();
    const ids = new Map();
    savings.forEach((s) => {
      const key = normalizeLabel(s?.name);
      if (!key || !s?.id) return;
      counts.set(key, (counts.get(key) || 0) + 1);
      ids.set(key, s.id);
    });
    const lookup = {};
    counts.forEach((count, key) => {
      if (count === 1) lookup[key] = ids.get(key);
    });
    return lookup;
  })();

  const savingsPaidById = (() => {
    const map = new Map();
    (transactions || []).forEach((t) => {
      if (t?.category !== SAVINGS_CATEGORY) return;
      const amt = Number(t.amount || 0);
      if (Number.isNaN(amt)) return;
      let savingId = String(t?.meta?.savingId || '').trim();
      if (!savingId) {
        const nameKey = normalizeLabel(t?.meta?.savingName || '');
        savingId = nameKey ? savingsNameLookup[nameKey] : '';
      }
      if (!savingId) return;
      map.set(savingId, (map.get(savingId) || 0) + amt);
    });
    return map;
  })();

  const savingsTotals = savings.reduce(
    (acc, s) => {
      const base = Number(s.saved || 0);
      const extra = s.id ? savingsPaidById.get(s.id) || 0 : 0;
      acc.goal += Number(s.goal || 0);
      acc.saved += base + extra;
      return acc;
    },
    { goal: 0, saved: 0 },
  );

  const savingsProgress =
    savingsTotals.goal > 0
      ? (savingsTotals.saved / savingsTotals.goal) * 100
      : 0;

  const spentByCategory = monthTx.reduce((acc, t) => {
    if (t?.type !== 'gasto') return acc;
    const cat = t?.category;
    if (!cat) return acc;
    const amt = Number(t.amount || 0);
    if (Number.isNaN(amt)) return acc;
    acc[cat] = (acc[cat] || 0) + amt;
    return acc;
  }, {});

  const fixedSummary = (() => {
    const items = [];
    const totals = {
      base: 0,
      carryover: 0,
      effective: 0,
      spent: 0,
      pending: 0,
    };
    const baseCats = categories && categories.length ? categories : CATEGORIES;
    const candidateCats = baseCats.filter(
      (cat) => cat !== SAVINGS_CATEGORY && cat !== DEBT_CATEGORY,
    );

    candidateCats.forEach((cat) => {
      const entry = budgets?.[cat] ?? budgetsAll?.[mk]?.[cat];
      const breakdown = Array.isArray(entry?.breakdown)
        ? entry.breakdown
        : [];
      const isFixedCategory = resolveFixedCategory({
        entry,
        breakdown,
        fixedCategories,
        category: cat,
      });
      if (!isFixedCategory) return;

      if (breakdown.length) {
        breakdown.forEach((item, idx) => {
          const name = String(item?.name || '').trim() || 'Sin nombre';
          const id = item?.id || name || `${cat}-${idx}`;
          const subId = item?.id || id;
          const base = Number(item?.amount || 0);
          const carryover = getFixedCarryoverForSubcategory({
            budgetsAll,
            transactions,
            cutDay: budgetCutDay,
            category: cat,
            fixedCategories,
            subId,
            subName: name,
            currentPeriodKey: mk,
          });
          const effective = base + carryover;
          const spent = getSubcategorySpentFromPeriod(
            monthTx,
            cat,
            subId,
            name,
            breakdown,
          );
          if (effective === 0 && spent === 0 && carryover === 0) return;
          items.push({
            key: `${cat}::${id}`,
            category: cat,
            name,
            subId,
            isBreakdown: true,
            base,
            carryover,
            effective,
            spent,
            pending: Math.max(0, effective - spent),
          });
        });
      } else {
        const norm = normalizeBudgetEntry(entry);
        const effective = Number(norm.funded || norm.plan || 0);
        const spent = Number(spentByCategory[cat] || 0);
        if (effective === 0 && spent === 0) return;
        items.push({
          key: `${cat}::total`,
          category: cat,
          name: cat,
          subId: null,
          isBreakdown: false,
          base: effective,
          carryover: 0,
          effective,
          spent,
          pending: Math.max(0, effective - spent),
        });
      }
    });

    items.forEach((item) => {
      totals.base += Number(item.base || 0);
      totals.carryover += Number(item.carryover || 0);
      totals.effective += Number(item.effective || 0);
      totals.spent += Number(item.spent || 0);
      totals.pending += Number(item.pending || 0);
    });

    const pendingItems = items.filter((item) => item.pending > 0);
    const totalCount = items.filter((item) => item.effective > 0).length;
    const paidCount = items.filter(
      (item) => item.effective > 0 && item.pending <= 0,
    ).length;
    const coverage =
      totals.effective > 0 ? (totals.spent / totals.effective) * 100 : 0;

    return {
      items,
      totals,
      pendingItems,
      totalCount,
      paidCount,
      coverage,
    };
  })();

  const fixedHasData = fixedSummary.items.length > 0;
  const fixedAllPaid = fixedHasData && fixedSummary.totals.pending <= 0;
  const fixedTotalCount =
    fixedSummary.totalCount > 0
      ? fixedSummary.totalCount
      : fixedSummary.items.length;
  const fixedPaidCount =
    fixedSummary.totalCount > 0
      ? fixedSummary.paidCount
      : fixedSummary.items.filter((item) => item.pending <= 0).length;
  const fixedPeriodKeys = (() => {
    if (!mk) return [];
    const keys = Object.keys(budgetsAll || {}).filter((key) =>
      /^\d{4}-\d{2}$/.test(key),
    );
    if (!keys.length) return [mk];
    const filtered = keys.filter((key) => key <= mk).sort();
    if (!filtered.includes(mk)) filtered.push(mk);
    return filtered.sort();
  })();
  const periodBudgetsMap = fixedPeriodKeys.reduce((acc, periodKey) => {
    acc[periodKey] = hasMonthlyBudgets
      ? budgetsAll?.[periodKey] ||
        (periodKey === mk ? budgets || {} : {})
      : budgetsAll || budgets || {};
    return acc;
  }, {});
  const periodTxMap = fixedPeriodKeys.reduce((acc, periodKey) => {
    acc[periodKey] = filterTransactionsByPeriodAndUser(
      transactions,
      periodKey,
      budgetCutDay,
      null,
      false,
    );
    return acc;
  }, {});

  const buildPendingBucketsForItem = (item) => {
    let buckets = [];

    fixedPeriodKeys.forEach((periodKey) => {
      const periodBudgets = periodBudgetsMap[periodKey] || {};
      const entry = periodBudgets?.[item.category];
      if (!entry) {
        buckets = [];
        return;
      }

      const breakdown = Array.isArray(entry?.breakdown)
        ? entry.breakdown
        : [];
      const isFixedCategory = resolveFixedCategory({
        entry,
        breakdown,
        fixedCategories,
        category: item.category,
      });
      if (!isFixedCategory) {
        buckets = [];
        return;
      }

      const periodTx = periodTxMap[periodKey] || [];
      let spent = 0;

      if (item.isBreakdown) {
        if (!breakdown.length) {
          buckets = [];
          return;
        }
        const matched = findBreakdownItem(
          breakdown,
          item.subId,
          item.name,
        );
        if (!matched) {
          buckets = [];
          return;
        }
        const base = Number(matched.amount || 0);
        if (base > 0) {
          buckets.push({ periodKey, amount: base });
        }
        const matchId = matched.id || item.subId;
        const matchName = matched.name || item.name;
        spent = getSubcategorySpentFromPeriod(
          periodTx,
          item.category,
          matchId,
          matchName,
          breakdown,
        );
      } else {
        const norm = normalizeBudgetEntry(entry);
        const base = Number(norm.funded || norm.plan || 0);
        if (base > 0) {
          buckets.push({ periodKey, amount: base });
        }
        spent = getCategorySpentFromPeriod(periodTx, item.category);
      }

      let remaining = spent;
      if (remaining > 0 && buckets.length) {
        buckets.forEach((bucket) => {
          if (remaining <= 0) return;
          const used = Math.min(bucket.amount, remaining);
          bucket.amount = Math.max(bucket.amount - used, 0);
          remaining -= used;
        });
        buckets = buckets.filter((bucket) => bucket.amount > 0);
      }
    });

    return buckets;
  };

  const fixedPendingTable = (() => {
    if (!fixedSummary.pendingItems.length) return { rows: [], periods: [] };
    const periodSet = new Set();
    const rows = fixedSummary.pendingItems
      .map((item) => {
        const buckets = buildPendingBucketsForItem(item);
        if (!buckets.length) return null;
        const bucketMap = {};
        buckets.forEach((bucket) => {
          if (bucket.amount <= 0) return;
          bucketMap[bucket.periodKey] = bucket.amount;
          periodSet.add(bucket.periodKey);
        });
        const label =
          item.name && item.name !== item.category
            ? `${item.name} (${item.category})`
            : item.category;
        const totalPending = buckets.reduce(
          (sum, bucket) => sum + Number(bucket.amount || 0),
          0,
        );
        return {
          key: item.key,
          label,
          bucketMap,
          totalPending,
        };
      })
      .filter(Boolean);
    const periods = Array.from(periodSet).sort();
    return { rows, periods };
  })();

  // === Resumen anual ===
  function txPeriodMonthKey(tx) {
    const dateStr = (tx.date || tx.createdAt || '').slice(0, 10);
    return budgetMonthKeyForDate(dateStr, budgetCutDay);
  }

  const txWithYear = transactions.map((t) => {
    const mkTx = txPeriodMonthKey(t);
    return { ...t, __mk: mkTx, __year: yearFromMonthKey(mkTx) };
  });

  const txCurrentYear = txWithYear.filter((t) => t.__year === currentYear);

  const sumBudgetForMonth = (mkKey) => {
    const catsMap = hasMonthlyBudgets
      ? budgetsAll?.[mkKey] || {}
      : budgetsAll || budgets || {};
    return Object.entries(catsMap).reduce((s, [cat, entry]) => {
      const isMainCategory =
        categories.includes(cat) ||
        cat === DEBT_CATEGORY ||
        cat === SAVINGS_CATEGORY;
      if (!isMainCategory) return s;
      const norm = normalizeBudgetEntry(entry);
      let val = Number(norm.funded || norm.plan || 0);
      if ((!val || val === 0) && cat === DEBT_CATEGORY) {
        val = plannedDebtsForPeriod(debts, mkKey);
      }
      if ((!val || val === 0) && cat === SAVINGS_CATEGORY) {
        val = plannedSavingsForPeriod(savings, mkKey, budgetCutDay);
      }
      return s + val;
    }, 0);
  };

  // Presupuesto anual: suma de funded (o plan) por categoria en los 12 meses del anio
  const budgetTotalYear = Object.entries(budgetsAll || {}).reduce(
    (sumYear, [mkKey]) => {
      if (yearFromMonthKey(mkKey) !== currentYear) return sumYear;
      return sumYear + sumBudgetForMonth(mkKey);
    },
    0,
  );

  const annualProjection = (() => {
    const yearStart = new Date(currentYear, 0, 1);
    const yearEnd = new Date(currentYear + 1, 0, 1);
    const totalDays = Math.max(
      0,
      Math.round((yearEnd - yearStart) / MS_PER_DAY),
    );
    if (!totalDays) return null;

    const dailySpent = new Array(totalDays).fill(0);
    const dailyIncome = new Array(totalDays).fill(0);

    txCurrentYear.forEach((t) => {
      const dateStr = (t.date || t.createdAt || '').slice(0, 10);
      if (!dateStr) return;
      const day = new Date(`${dateStr}T00:00:00`);
      const idx = Math.floor((day - yearStart) / MS_PER_DAY);
      if (idx < 0 || idx >= totalDays) return;
      const amt = Number(t.amount || 0);
      if (Number.isNaN(amt)) return;
      if (t.type === 'gasto') dailySpent[idx] += amt;
      if (t.type === 'ingreso') dailyIncome[idx] += amt;
    });

    const cumulativeSpent = [];
    const cumulativeIncome = [];
    let runningSpent = 0;
    let runningIncome = 0;
    for (let i = 0; i < totalDays; i += 1) {
      runningSpent += dailySpent[i];
      runningIncome += dailyIncome[i];
      cumulativeSpent.push(runningSpent);
      cumulativeIncome.push(runningIncome);
    }

    const today = new Date();
    const todayDate = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    );
    let daysElapsed = Math.floor((todayDate - yearStart) / MS_PER_DAY) + 1;
    if (daysElapsed < 0) daysElapsed = 0;
    if (daysElapsed > totalDays) daysElapsed = totalDays;

    const spentSoFar = daysElapsed > 0 ? cumulativeSpent[daysElapsed - 1] : 0;
    const incomeSoFar = daysElapsed > 0 ? cumulativeIncome[daysElapsed - 1] : 0;
    const remainingDays = Math.max(totalDays - daysElapsed, 0);
    const avgDailySpent = daysElapsed > 0 ? spentSoFar / daysElapsed : 0;
    const avgDailyIncome = daysElapsed > 0 ? incomeSoFar / daysElapsed : 0;

    const projectedSpent = spentSoFar + avgDailySpent * remainingDays;
    const projectedIncome = incomeSoFar + avgDailyIncome * remainingDays;
    const availableTotal = projectedIncome;

    const availableLine = Array.from({ length: totalDays }, (_, idx) =>
      availableTotal > 0 ? (availableTotal / totalDays) * (idx + 1) : 0,
    );

    const maxLine = Math.max(
      projectedSpent,
      cumulativeSpent[cumulativeSpent.length - 1] || 0,
      availableTotal || 0,
      budgetTotalYear || 0,
      0,
    );

    const monthLabels = [
      'Ene',
      'Feb',
      'Mar',
      'Abr',
      'May',
      'Jun',
      'Jul',
      'Ago',
      'Sep',
      'Oct',
      'Nov',
      'Dic',
    ];
    const monthEndIndices = monthLabels.map((_, idx) => {
      const nextMonthStart = new Date(currentYear, idx + 1, 1);
      const endIdx =
        Math.floor((nextMonthStart - yearStart) / MS_PER_DAY) - 1;
      return Math.min(Math.max(endIdx, 0), totalDays - 1);
    });
    const monthlySpent = monthEndIndices.map(
      (idx) => cumulativeSpent[idx] || 0,
    );
    const monthlyIncome = monthEndIndices.map(
      (idx) => cumulativeIncome[idx] || 0,
    );
    const monthlyAvailable = monthEndIndices.map(
      (idx) => availableLine[idx] || 0,
    );
    const monthlySpentDelta = monthlySpent.map(
      (value, idx) => value - (monthlySpent[idx - 1] || 0),
    );
    const monthlyIncomeDelta = monthlyIncome.map(
      (value, idx) => value - (monthlyIncome[idx - 1] || 0),
    );
    const monthBudgetTotals = monthLabels.map((_, idx) => {
      const monthEndDate = new Date(currentYear, idx + 1, 0);
      const dateKey = `${currentYear}-${String(idx + 1).padStart(
        2,
        '0',
      )}-${String(monthEndDate.getDate()).padStart(2, '0')}`;
      const mkMonth = budgetMonthKeyForDate(dateKey, budgetCutDay);
      return sumBudgetForMonth(mkMonth);
    });
    const monthlyBudget = monthBudgetTotals.reduce((acc, value) => {
      const next = (acc.length ? acc[acc.length - 1] : 0) + value;
      acc.push(next);
      return acc;
    }, []);
    const monthlyMax = Math.max(
      ...monthBudgetTotals,
      ...monthlySpentDelta,
      ...monthlyIncomeDelta,
      0,
    );
    const monthsWithMovements = monthlySpentDelta.reduce((acc, value, idx) => {
      if (value > 0 || (monthlyIncomeDelta[idx] || 0) > 0) return acc + 1;
      return acc;
    }, 0);
    const monthsOverBudget = monthlySpentDelta.reduce((acc, value, idx) => {
      if (value > (monthBudgetTotals[idx] || 0)) return acc + 1;
      return acc;
    }, 0);
    const safeDayIndex = Math.max(daysElapsed - 1, 0);
    const projectionMonthIndex = Math.min(
      11,
      Math.max(
        0,
        new Date(yearStart.getTime() + safeDayIndex * MS_PER_DAY).getMonth(),
      ),
    );
    const currentDate = new Date(
      yearStart.getTime() + safeDayIndex * MS_PER_DAY,
    );
    const daysInCurrentMonth = new Date(
      currentDate.getFullYear(),
      currentDate.getMonth() + 1,
      0,
    ).getDate();
    const dayOfMonth = currentDate.getDate();
    const budgetBefore =
      projectionMonthIndex > 0 ? monthlyBudget[projectionMonthIndex - 1] : 0;
    const currentMonthBudget = monthBudgetTotals[projectionMonthIndex] || 0;
    const monthFraction =
      daysElapsed > 0
        ? Math.min(dayOfMonth / Math.max(daysInCurrentMonth, 1), 1)
        : 0;
    const budgetToDate = budgetBefore + currentMonthBudget * monthFraction;
    const monthsElapsed = daysElapsed > 0 ? projectionMonthIndex + 1 : 0;

    return {
      totalDays,
      cumulativeSpent,
      availableLine,
      monthLabels,
      monthlySpent,
      monthlyIncome,
      monthlyAvailable,
      monthlyBudget,
      monthlySpentDelta,
      monthlyIncomeDelta,
      monthBudgetTotals,
      monthlyMax,
      monthsWithMovements,
      monthsOverBudget,
      monthsElapsed,
      budgetToDate,
      projectionMonthIndex,
      daysElapsed,
      remainingDays,
      projectedSpent,
      projectedIncome,
      spentSoFar,
      avgDailySpent,
      maxLine,
    };
  })();

  const annualProjectedDelta = annualProjection
    ? annualProjection.projectedIncome - annualProjection.projectedSpent
    : 0;
  const isAnnualProjectedSurplus = annualProjectedDelta >= 0;
  const annualAvailableToDate = annualProjection
    ? annualProjection.budgetToDate - annualProjection.spentSoFar
    : 0;
  const monthsCoverageTotal = 12;
  const cardsPrefs = activeUserPreferences?.dashboardCards || {};
  const showResumenMes = cardsPrefs.resumenMes ?? true;
  const showGastosFijos = cardsPrefs.gastosFijos ?? true;
  const showDeudas = cardsPrefs.deudas ?? true;
  const showAhorro = cardsPrefs.ahorro ?? true;
  const showPresupuestos = cardsPrefs.presupuestos ?? true;
  // IMPORTANTE: ya NO usamos tarjetas de inversiones en el dashboard

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {showResumenMes && (
        <Card>
          <SectionTitle>Resumen del mes</SectionTitle>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span>Ingresos</span>
              <strong>
                <Money n={totalIngresos} />
              </strong>
            </div>
            <div className="flex justify-between">
              <span>Gastos</span>
              <strong>
                <Money n={totalGastos} />
              </strong>
            </div>
            <div
              className={`flex justify-between ${
                balance >= 0 ? 'text-[color:var(--success)]' : 'text-[color:var(--danger)]'
              }`}
            >
              <span>Balance</span>
              <strong>
                <Money n={balance} />
              </strong>
            </div>
            <div>
              <div className="text-sm mb-1">% Gastado sobre ingresos</div>
              <Progress
                value={pctIngresosVsGastos}
                mode="flat"
                danger={balance < 0}
              />
            </div>
            <div className="text-xs text-[color:var(--text-muted)]">
              Dia de corte del mes: {budgetCutDay}
            </div>
          </div>
        </Card>
      )}

      {showDeudas && (
        <Card>
          <SectionTitle>Progreso de deudas</SectionTitle>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span>Total original</span>
              <strong>
                <Money n={debtTotals.original} />
              </strong>
            </div>
            <div className="flex justify-between">
              <span>Saldo pendiente</span>
              <strong>
                <Money n={debtTotals.remaining} />
              </strong>
            </div>
            <div className="flex justify-between">
              <span>Pagado hasta ahora</span>
              <strong>
                <Money n={debtPaid} />
              </strong>
            </div>
            <div>
              <div className="text-sm mb-1">% pagado</div>
              <Progress
                value={debtProgress}
                mode="flat"
                danger={debtTotals.remaining < 0}
              />
            </div>
          </div>
        </Card>
      )}

      {showAhorro && (
        <Card>
          <SectionTitle>Ahorro</SectionTitle>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span>Meta total</span>
              <strong>
                <Money n={savingsTotals.goal} />
              </strong>
            </div>
            <div className="flex justify-between">
              <span>Ahorro actual</span>
              <strong>
                <Money n={savingsTotals.saved} />
              </strong>
            </div>
            <div>
              <div className="text-sm mb-1">% de meta alcanzada</div>
              <Progress value={savingsProgress} mode="flat" danger={false} />
            </div>
          </div>
        </Card>
      )}

      {showGastosFijos && (
        <Card className="md:col-span-2 lg:col-span-3">
          <SectionTitle>Pago de gastos fijos</SectionTitle>
          {!fixedHasData ? (
            <div className="text-sm text-[color:var(--text-muted)]">
              No hay gastos fijos configurados para este periodo.
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,2fr)] items-start">
              <div className="space-y-2">
                <div
                  className={`text-xs font-semibold ${
                    fixedAllPaid ? 'text-[color:var(--success)]' : 'text-[color:var(--danger)]'
                  }`}
                >
                  {fixedAllPaid
                    ? 'Todos los gastos fijos estan al dia.'
                    : 'Hay gastos fijos pendientes.'}
                </div>
                <div className="flex justify-between">
                  <span>Total del periodo</span>
                  <strong>
                    <Money n={fixedSummary.totals.base} />
                  </strong>
                </div>
                {fixedSummary.totals.carryover > 0 && (
                  <div className="flex justify-between text-xs text-[color:var(--warning)]">
                    <span>Arrastre de periodos anteriores</span>
                    <strong>
                      <Money n={fixedSummary.totals.carryover} />
                    </strong>
                  </div>
                )}
                <div className="flex justify-between">
                  <span>Total a pagar (periodo + arrastre)</span>
                  <strong>
                    <Money n={fixedSummary.totals.effective} />
                  </strong>
                </div>
                <div className="flex justify-between">
                  <span>Pagado hasta ahora</span>
                  <strong>
                    <Money n={fixedSummary.totals.spent} />
                  </strong>
                </div>
                <div
                  className={`flex justify-between ${
                    fixedSummary.totals.pending > 0
                      ? 'text-[color:var(--danger)]'
                      : 'text-[color:var(--success)]'
                  }`}
                >
                  <span>Pendiente (total a pagar - pagado)</span>
                  <strong>
                    <Money n={fixedSummary.totals.pending} />
                  </strong>
                </div>
                <div>
                  <div className="text-sm mb-1">% pago sobre gastos fijos</div>
                  <Progress
                    value={fixedSummary.coverage}
                    mode="flat"
                    danger={fixedSummary.totals.pending < 0}
                    success={
                      fixedSummary.totals.pending === 0 &&
                      (fixedSummary.pendingItems || []).length === 0
                    }
                  />
                </div>
                <div className="text-xs text-[color:var(--text-muted)]">
                  Pagados: {fixedPaidCount}/{fixedTotalCount}
                  {fixedSummary.pendingItems.length > 0
                    ? ` | Pendientes: ${fixedSummary.pendingItems.length}`
                    : ''}
                </div>
              </div>

              <div className="hidden md:block w-1.5 bg-[color:var(--divider)]/80 self-stretch" />

              <div className="pt-3 md:pt-0 md:pl-4 border-t md:border-t-0">
                <div className="text-xs font-semibold text-[color:var(--text-muted)] uppercase mb-2">
                  Gastos fijos pendientes
                </div>
                {fixedPendingTable.rows.length === 0 ||
                fixedPendingTable.periods.length === 0 ? (
                  <div className="text-sm text-[color:var(--text-muted)]">
                    No hay pagos pendientes.
                  </div>
                ) : (
                  <div className="overflow-auto max-h-56">
                    <table className="w-full text-xs border-collapse min-w-[420px]">
                      <thead>
                        <tr className="text-left text-[color:var(--text-muted)] border-b">
                          <th className="py-2 pr-4">Gasto fijo</th>
                          {fixedPendingTable.periods.map((periodKey) => (
                            <th
                              key={periodKey}
                              className="py-2 px-2 text-right"
                              data-tooltip={periodKey}
                            >
                              {shortMonthLabelFromKey(periodKey)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {fixedPendingTable.rows.map((row) => (
                          <tr key={row.key} className="border-b last:border-b-0">
                            <td className="py-2 pr-4 font-medium text-[color:var(--text)]">
                              {row.label}
                            </td>
                            {fixedPendingTable.periods.map((periodKey) => {
                              const value = row.bucketMap[periodKey];
                              return (
                                <td
                                  key={`${row.key}-${periodKey}`}
                                  className={`py-2 px-2 text-right ${
                                    value ? 'text-[color:var(--danger)] font-semibold' : ''
                                  }`}
                                >
                                  {value ? <Money n={value} /> : '-'}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </Card>
      )}

      {showPresupuestos && (
        <Card className="md:col-span-2 lg:col-span-3">
          <SectionTitle>Presupuestos (progreso por categoria)</SectionTitle>
          {visibleCats.length === 0 ? (
            <div className="text-sm text-[color:var(--text-muted)]">
              No hay categorias con presupuesto o gasto en este periodo.
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {visibleCats.map((c) => (
                <div key={c} className="border rounded-xl p-3">
                  <div className="flex justify-between text-sm mb-1 items-center">
                    <span className="font-medium">{c}</span>
                  </div>
                  {c === DEBT_CATEGORY && (catSpend[c].debtPlanned || 0) > 0 && (
                    <div className="text-[11px] text-[color:var(--text-muted)] mb-1 text-left">
                      Valor del periodo a pagar: <Money n={catSpend[c].debtPlanned} />
                    </div>
                  )}
                  {c === SAVINGS_CATEGORY &&
                    (catSpend[c].savingsPlanned || 0) > 0 && (
                      <div className="text-[11px] text-[color:var(--text-muted)] mb-1 text-left">
                        Valor del periodo a ahorrar:{' '}
                        <Money n={catSpend[c].savingsPlanned} />
                      </div>
                    )}
                  <Progress
                    value={catSpend[c].pctFundedUsed}
                    mode="flat"
                    danger={(catSpend[c].funded || 0) - (catSpend[c].spent || 0) < 0}
                  />
                  <div className="text-xs text-[color:var(--text-muted)] mt-2 text-left">
                    Gasto: <Money n={catSpend[c].spent} /> / Presupuesto:{' '}
                    <Money n={catSpend[c].funded} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Resumen anual */}
      <Card className="hidden md:block md:col-span-2 lg:col-span-3">
        <SectionTitle>Resumen anual {currentYear}</SectionTitle>
        <div className="rounded-lg border border-[color:var(--divider)] bg-[color:var(--surface-1)]/80 px-3 py-3 space-y-3">
          {annualProjection && annualProjection.totalDays > 1 ? (
            <>
              <div className="text-xs font-semibold text-[color:var(--text-muted)] uppercase">
                Proyeccion anual
              </div>
              <div className="grid gap-2 grid-cols-2 md:grid-cols-3 lg:grid-cols-5 text-xs">
                <div className="rounded-md border border-[color:var(--divider)] bg-[color:var(--surface-1)]/80 px-2 py-2">
                  <div className="text-[11px] text-[color:var(--text-muted)]">
                    Meses con movimientos
                  </div>
                  <div className="text-sm font-semibold">
                    {annualProjection.monthsWithMovements}/{monthsCoverageTotal}
                  </div>
                </div>
                <div className="rounded-md border border-[color:var(--divider)] bg-[color:var(--surface-1)]/80 px-2 py-2">
                  <div className="text-[11px] text-[color:var(--text-muted)]">
                    Meses sobre presupuesto
                  </div>
                  <div
                    className={`text-sm font-semibold ${
                      annualProjection.monthsOverBudget > 0
                        ? 'text-[color:var(--danger)]'
                        : 'text-[color:var(--success)]'
                    }`}
                  >
                    {annualProjection.monthsOverBudget}
                  </div>
                </div>
                <div className="rounded-md border border-[color:var(--divider)] bg-[color:var(--surface-1)]/80 px-2 py-2">
                  <div className="text-[11px] text-[color:var(--text-muted)]">Gastado YTD</div>
                  <div className="text-sm font-semibold">
                    <Money n={annualProjection.spentSoFar} />
                  </div>
                </div>
                <div className="rounded-md border border-[color:var(--divider)] bg-[color:var(--surface-1)]/80 px-2 py-2">
                  <div className="text-[11px] text-[color:var(--text-muted)]">
                    Presupuesto YTD
                  </div>
                  <div className="text-sm font-semibold">
                    <Money n={annualProjection.budgetToDate} />
                  </div>
                </div>
                <div className="rounded-md border border-[color:var(--divider)] bg-[color:var(--surface-1)]/80 px-2 py-2">
                  <div className="text-[11px] text-[color:var(--text-muted)]">
                    Disponible YTD
                  </div>
                  <div
                    className={`text-sm font-semibold ${
                      annualAvailableToDate < 0
                        ? 'text-[color:var(--danger)]'
                        : 'text-[color:var(--success)]'
                    }`}
                  >
                    <Money n={annualAvailableToDate} />
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-3 text-[11px] text-[color:var(--text-muted)]">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-[color:var(--primary)]" />
                  Ingreso
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-[color:var(--success)]" />
                  Presupuesto
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-[color:var(--warning)]" />
                  Gastado
                </span>
              </div>
              <div className="w-full">
                {(() => {
                  const chartWidth = 320;
                  const chartHeight = 140;
                  const padding = {
                    left: 28,
                    right: 12,
                    top: 10,
                    bottom: 18,
                  };
                  const innerWidth =
                    chartWidth - padding.left - padding.right;
                  const innerHeight =
                    chartHeight - padding.top - padding.bottom;
                  const maxY = Math.max(annualProjection.monthlyMax * 1.2, 1);
                  const totalPoints = annualProjection.monthLabels.length;
                  const groupWidth = innerWidth / Math.max(totalPoints, 1);
                  const barCount = 3;
                  const barGap = 2;
                  const rawBarWidth =
                    (groupWidth - barGap * (barCount - 1)) / barCount;
                  const barWidth = Math.max(3, Math.min(12, rawBarWidth));
                  const groupInnerWidth =
                    barWidth * barCount + barGap * (barCount - 1);
                  const groupOffset = Math.max(
                    (groupWidth - groupInnerWidth) / 2,
                    0,
                  );
                  const xForIndex = (idx) =>
                    padding.left + groupWidth * idx + groupWidth / 2;
                  const barHeight = (value) =>
                    (Math.max(value, 0) / maxY) * innerHeight;
                  const incomeValues = annualProjection.monthlyIncomeDelta;
                  const budgetValues = annualProjection.monthBudgetTotals;
                  const spentValues = annualProjection.monthlySpentDelta;
                  const currentMonthX = xForIndex(
                    annualProjection.projectionMonthIndex,
                  );
                  const labelPaddingLeft = `${(
                    (padding.left / chartWidth) *
                    100
                  ).toFixed(2)}%`;
                  const labelPaddingRight = `${(
                    (padding.right / chartWidth) *
                    100
                  ).toFixed(2)}%`;

                  return (
                    <>
                      <svg
                        className="w-full h-40"
                        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                        preserveAspectRatio="none"
                        role="img"
                        aria-label="Grafico de barras mensuales de ingreso, presupuesto y gasto"
                      >
                        <line
                          x1={padding.left}
                          y1={padding.top + innerHeight}
                          x2={chartWidth - padding.right}
                          y2={padding.top + innerHeight}
                          stroke="var(--divider)"
                          strokeWidth="1"
                        />
                        <line
                          x1={padding.left}
                          y1={padding.top}
                          x2={padding.left}
                          y2={padding.top + innerHeight}
                          stroke="var(--divider)"
                          strokeWidth="1"
                        />
                        <line
                          x1={currentMonthX}
                          y1={padding.top}
                          x2={currentMonthX}
                          y2={padding.top + innerHeight}
                          stroke="var(--divider)"
                          strokeWidth="1"
                          strokeDasharray="3 3"
                        />
                        {annualProjection.monthLabels.map((label, idx) => {
                          const baseX =
                            padding.left + groupWidth * idx + groupOffset;
                          const incomeValue = incomeValues[idx] || 0;
                          const budgetValue = budgetValues[idx] || 0;
                          const spentValue = spentValues[idx] || 0;
                          const balanceValue = incomeValue - spentValue;
                          const ejecucionPct =
                            budgetValue > 0
                              ? `${Math.round(
                                  (spentValue / budgetValue) * 100,
                                )}%`
                              : '-';
                          const tooltip = `Mes: ${label}\nIngreso: ${formatCLP(
                            incomeValue,
                          )}\nPresupuesto: ${formatCLP(
                            budgetValue,
                          )}\nGastado: ${formatCLP(
                            spentValue,
                          )}\nBalance: ${formatCLP(
                            balanceValue,
                          )}\nEjecucion: ${ejecucionPct}`;
                          return (
                            <g key={`bars-${label}-${idx}`}>
                              <rect
                                x={baseX}
                                y={
                                  padding.top +
                                  innerHeight -
                                  barHeight(incomeValue)
                                }
                                width={barWidth}
                                height={barHeight(incomeValue)}
                                fill="var(--primary)"
                                className="cursor-pointer"
                                pointerEvents="all"
                              >
                                <title>{tooltip}</title>
                              </rect>
                              <rect
                                x={baseX + barWidth + barGap}
                                y={
                                  padding.top +
                                  innerHeight -
                                  barHeight(budgetValue)
                                }
                                width={barWidth}
                                height={barHeight(budgetValue)}
                                fill="var(--text-faint)"
                                className="cursor-pointer"
                                pointerEvents="all"
                              >
                                <title>{tooltip}</title>
                              </rect>
                              <rect
                                x={baseX + (barWidth + barGap) * 2}
                                y={
                                  padding.top +
                                  innerHeight -
                                  barHeight(spentValue)
                                }
                                width={barWidth}
                                height={barHeight(spentValue)}
                                fill="var(--text-muted)"
                                className="cursor-pointer"
                                pointerEvents="all"
                              >
                                <title>{tooltip}</title>
                              </rect>
                            </g>
                          );
                        })}
                      </svg>
                      <div
                        className="mt-2 grid grid-cols-12 text-xs sm:text-sm md:text-base font-semibold text-[color:var(--text-faint)]"
                        style={{
                          paddingLeft: labelPaddingLeft,
                          paddingRight: labelPaddingRight,
                        }}
                      >
                        {annualProjection.monthLabels.map((label, idx) => {
                          const isFirst = idx === 0;
                          const isLast = idx === totalPoints - 1;
                          const isCurrent =
                            idx === annualProjection.projectionMonthIndex;
                          const alignClass = isFirst
                            ? 'text-left'
                            : isLast
                              ? 'text-right'
                              : 'text-center';
                          return (
                            <div
                              key={`month-label-${label}-${idx}`}
                              className={`${alignClass} ${
                                isCurrent ? 'text-[color:var(--primary)]' : ''
                              }`}
                            >
                              {label}
                            </div>
                          );
                        })}
                      </div>
                    </>
                  );
                })()}
              </div>
              <div className="flex items-start gap-3">
                <div
                  className={`w-12 h-12 rounded-full flex items-center justify-center ${
                    isAnnualProjectedSurplus
                      ? 'bg-[color:var(--success)]/15 text-[color:var(--success)]'
                      : 'bg-[color:var(--danger)]/15 text-[color:var(--danger)]'
                  }`}
                >
                  <svg
                    className="w-6 h-6"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    {isAnnualProjectedSurplus ? (
                      <>
                        <path d="M12 19V5" />
                        <path d="M6 11l6-6 6 6" />
                      </>
                    ) : (
                      <>
                        <path d="M12 5v14" />
                        <path d="M6 13l6 6 6-6" />
                      </>
                    )}
                  </svg>
                </div>
                <div>
                  <div
                    className={`text-sm font-semibold ${
                      isAnnualProjectedSurplus
                        ? 'text-[color:var(--success)]'
                        : 'text-[color:var(--danger)]'
                    }`}
                  >
                    Si mantienes el ritmo actual, terminaras con{' '}
                    {annualProjectedDelta >= 0 ? '+' : '-'}
                    <Money n={Math.abs(annualProjectedDelta)} />
                  </div>
                  <div className="text-xs text-[color:var(--text-muted)]">
                    Ritmo diario: <Money n={annualProjection.avgDailySpent} />
                    /dia - Dias restantes: {annualProjection.remainingDays}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="text-xs text-[color:var(--text-muted)]">
              No hay datos suficientes para la proyeccion anual.
            </div>
          )}
        </div>
      </Card>
    </div>

    </>
  );
}







