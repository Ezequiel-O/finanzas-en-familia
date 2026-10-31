// src/modules/dashboard/Dashboard.jsx
import { categorySpent, periodLedger } from '../../domain/ledger.js';
import { plannedForSavingPeriod } from '../../domain/commitments.js';
import { annualSummary } from '../../domain/annualSummary.js';
import { useState } from 'react';
import { Card } from '../../components/ui/Card.jsx';
import { SectionTitle } from '../../components/ui/SectionTitle.jsx';
import { Money } from '../../components/ui/Money.jsx';
import { Progress } from '../../components/ui/Progress.jsx';
import { CATEGORIES, DEBT_CATEGORY, SAVINGS_CATEGORY } from '../../constants.js';
import {
  buildDebtPaidIndex,
  debtProgress as getDebtProgress,
} from '../../domain/commitments.js';
import { filterTransactionsByPeriodAndUser } from '../../utils/transactions.js';
import {
  getFixedCarryoverForSubcategory,
  resolveFixedCategory,
} from '../../utils/fixedBudgets.js';
import { getSubcategoryAllocationsForTransaction } from '../../utils/subcategoryAllocations.js';

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

function plannedSavingsForPeriod(savings, periodKey, cutDay) {
  if (!periodKey) return 0;
  return (savings || []).reduce(
    (sum, s) => sum + plannedForSavingPeriod(s, periodKey, cutDay),
    0,
  );
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
  const [showAnnualMobile, setShowAnnualMobile] = useState(false);

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

  // Mismo libro que Plan del mes y Movimientos (base caja): ingresos sin ajustes ni
  // retiros de ahorro; salidas separadas en consumo, cuotas y ahorro.
  const ledger = periodLedger({ transactions, periodKey: mk, cutDay: budgetCutDay, debts });
  const totalIngresos = ledger.income;
  const totalConsumo = ledger.consumptionNet;
  const totalGastos = ledger.outflows - ledger.refunds;
  const flujoMes = ledger.netCashFlow;
  const balance = ledger.closing;

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

    // Gastos menos reembolsos de la categoría (misma fórmula en todas las pantallas).
    const spent = categorySpent(monthTx, c);

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

  // Saldo real calculado desde los pagos registrados (no desde el campo guardado `remaining`,
  // que queda desactualizado si se edita o borra un movimiento). Excluye suscripciones y archivadas.
  const debtPaidIndex = buildDebtPaidIndex(transactions);
  const debtTotals = debts
    .filter((d) => d && !d.archived && !d.isSubscription)
    .reduce(
      (acc, d) => {
        const p = getDebtProgress(d, debtPaidIndex);
        acc.original += p.total;
        acc.remaining += p.remaining;
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
      // Aporte suma, retiro (ingreso) resta.
      const signed = t.type === 'ingreso' ? -amt : amt;
      map.set(savingId, (map.get(savingId) || 0) + signed);
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

  // === Resumen anual (por periodos de presupuesto) ===
  const annual = annualSummary({
    year: currentYear,
    categories: cats.includes(SAVINGS_CATEGORY) ? cats : [...cats, SAVINGS_CATEGORY],
    budgetsAll,
    transactions,
    debts,
    savings,
    cutDay: budgetCutDay,
    fixedCategories,
  });
  const annualTotals = annual.totals;
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
              <span>Consumo</span>
              <strong>
                <Money n={totalConsumo} />
              </strong>
            </div>
            <div className="flex justify-between">
              <span>Cuotas de deudas</span>
              <strong>
                <Money n={ledger.debtPayments} />
              </strong>
            </div>
            <div className="flex justify-between">
              <span>Ahorro neto</span>
              <strong>
                <Money n={ledger.savingsNet} />
              </strong>
            </div>
            <div className="flex justify-between text-[color:var(--text-muted)]">
              <span>Flujo del mes</span>
              <strong>
                <Money n={flujoMes} />
              </strong>
            </div>
            <div
              className={`flex justify-between ${
                balance >= 0 ? 'text-[color:var(--success)]' : 'text-[color:var(--danger)]'
              }`}
            >
              <span>Saldo actual (con lo que sobró antes)</span>
              <strong>
                <Money n={balance} />
              </strong>
            </div>
            <div>
              <div className="text-sm mb-1">% de ingresos ya usado (consumo + cuotas + ahorro)</div>
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
                  <div className="hidden md:block overflow-auto max-h-56">
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
      <Card className="md:col-span-2 lg:col-span-3">
        <SectionTitle
          right={
            <button
              type="button"
              className="md:hidden h-7 w-7 inline-flex items-center justify-center rounded-md border border-[color:var(--border)] text-[color:var(--text-muted)] transition hover:bg-[color:var(--surface-2)]"
              onClick={() => setShowAnnualMobile((prev) => !prev)}
              aria-expanded={showAnnualMobile}
              aria-label="Mostrar resumen anual"
            >
              <span
                className={`inline-block transition-transform ${
                  showAnnualMobile ? 'rotate-90' : ''
                }`}
              >
                &gt;
              </span>
            </button>
          }
        >
          Resumen anual {currentYear}
        </SectionTitle>
        <div
          className={`rounded-lg border border-[color:var(--divider)] bg-[color:var(--surface-1)]/80 px-3 py-3 space-y-3 ${
            showAnnualMobile ? '' : 'hidden'
          } md:block`}
        >
          {annual.periods.length > 0 ? (
            <>
              <div className="text-xs text-[color:var(--text-muted)]">
                Por periodos de presupuesto (corte día {budgetCutDay}). El periodo en curso cuenta hasta hoy.
              </div>
              <div className="grid gap-2 grid-cols-2 lg:grid-cols-4 text-xs">
                <div className="rounded-md border border-[color:var(--divider)] bg-[color:var(--surface-1)]/80 px-2 py-2">
                  <div className="text-[11px] text-[color:var(--text-muted)]">Ingresos del año</div>
                  <div className="text-sm font-semibold">
                    <Money n={annualTotals.income} />
                  </div>
                </div>
                <div className="rounded-md border border-[color:var(--divider)] bg-[color:var(--surface-1)]/80 px-2 py-2">
                  <div className="text-[11px] text-[color:var(--text-muted)]">Gastado del año</div>
                  <div className="text-sm font-semibold">
                    <Money n={annualTotals.spent} />
                  </div>
                  <div className="text-[10px] text-[color:var(--text-faint)]">
                    de <Money n={annualTotals.budget} /> presupuestado
                  </div>
                </div>
                <div className="rounded-md border border-[color:var(--divider)] bg-[color:var(--surface-1)]/80 px-2 py-2">
                  <div className="text-[11px] text-[color:var(--text-muted)]">Te quedó</div>
                  <div
                    className={`text-sm font-semibold ${
                      annualTotals.result < 0
                        ? 'text-[color:var(--danger)]'
                        : 'text-[color:var(--success)]'
                    }`}
                  >
                    <Money n={annualTotals.result} />
                  </div>
                  <div className="text-[10px] text-[color:var(--text-faint)]">
                    {annualTotals.savingsRate === null
                      ? 'ingresos − gastos'
                      : `${Math.round(annualTotals.savingsRate * 100)}% de tus ingresos`}
                  </div>
                </div>
                <div className="rounded-md border border-[color:var(--divider)] bg-[color:var(--surface-1)]/80 px-2 py-2">
                  <div className="text-[11px] text-[color:var(--text-muted)]">
                    Periodos sobre presupuesto
                  </div>
                  <div
                    className={`text-sm font-semibold ${
                      annualTotals.overBudgetCount > 0
                        ? 'text-[color:var(--danger)]'
                        : 'text-[color:var(--success)]'
                    }`}
                  >
                    {annualTotals.overBudgetCount} de {annualTotals.periodsCount}
                  </div>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs sm:text-sm">
                  <thead>
                    <tr className="text-left text-[11px] text-[color:var(--text-muted)] border-b">
                      <th className="py-2 pr-3">Periodo</th>
                      <th className="py-2 px-3 text-right">Ingresos</th>
                      <th className="py-2 px-3 text-right">Presupuesto</th>
                      <th className="py-2 px-3 text-right">Gastado</th>
                      <th className="py-2 px-3 text-right">Presupuesto − Gastado</th>
                      <th className="py-2 pl-3 text-right">Te quedó</th>
                    </tr>
                  </thead>
                  <tbody>
                    {annual.periods.map((p) => {
                      const isFuture = p.status === 'future';
                      return (
                        <tr
                          key={p.periodKey}
                          className={`border-b last:border-0 ${
                            p.status === 'current' ? 'bg-[color:var(--surface-2)]/60' : ''
                          } ${isFuture ? 'text-[color:var(--text-muted)]' : ''}`}
                        >
                          <td className="py-2 pr-3">
                            <div className="font-semibold">{p.label}</div>
                            <div className="text-[10px] text-[color:var(--text-faint)]">
                              {p.status === 'current' ? 'en curso' : isFuture ? 'planificado' : 'cerrado'}
                            </div>
                          </td>
                          <td className="py-2 px-3 text-right">
                            {isFuture ? '—' : <Money n={p.income} />}
                          </td>
                          <td className="py-2 px-3 text-right">
                            <Money n={p.budget} />
                          </td>
                          <td className="py-2 px-3 text-right">
                            {isFuture ? '—' : <Money n={p.spent} />}
                          </td>
                          <td
                            className={`py-2 px-3 text-right ${
                              !isFuture && p.budgetLeft < 0 ? 'text-[color:var(--danger)]' : ''
                            }`}
                          >
                            {isFuture ? '—' : <Money n={p.budgetLeft} />}
                          </td>
                          <td
                            className={`py-2 pl-3 text-right font-semibold ${
                              !isFuture && p.result < 0 ? 'text-[color:var(--danger)]' : ''
                            }`}
                          >
                            {isFuture ? '—' : <Money n={p.result} />}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {annualTotals.closedCount > 0 && (
                <div className="text-xs text-[color:var(--text-muted)]">
                  En tus {annualTotals.closedCount}{' '}
                  {annualTotals.closedCount === 1 ? 'periodo cerrado' : 'periodos cerrados'} ingresaste en promedio{' '}
                  <strong className="text-[color:var(--text)]"><Money n={annualTotals.avgClosedIncome} /></strong> y gastaste{' '}
                  <strong className="text-[color:var(--text)]"><Money n={annualTotals.avgClosedSpent} /></strong> por periodo.
                </div>
              )}
            </>
          ) : (
            <div className="text-xs text-[color:var(--text-muted)]">
              Aún no hay movimientos ni presupuestos en {currentYear}.
            </div>
          )}
        </div>
      </Card>
    </div>

    </>
  );
}







