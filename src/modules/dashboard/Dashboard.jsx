// src/modules/dashboard/Dashboard.jsx
import { Card } from '../../components/ui/card.jsx';
import { SectionTitle } from '../../components/ui/SectionTitle.jsx';
import { Money } from '../../components/ui/money.jsx';
import { Progress } from '../../components/ui/Progress.jsx';
import { CATEGORIES, DEBT_CATEGORY } from '../../constants.js';
import { filterTransactionsByPeriodAndUser } from '../../utils/transactions.js';
import { budgetMonthKeyForDate } from '../../utils/budgetPeriod.js';

const SAVINGS_CATEGORY = 'Ahorro';

// Helper: extract year from a budget month key "YYYY-MM"
function yearFromMonthKey(mk) {
  const y = Number((mk || '').split('-')[0]);
  return Number.isNaN(y) ? new Date().getFullYear() : y;
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

function plannedDebtsForPeriod(debts, periodKey) {
  if (!periodKey) return 0;
  return (debts || [])
    .flatMap((d) => (Array.isArray(d.schedule) ? d.schedule : []))
    .filter((q) => q.periodKey === periodKey)
    .reduce((s, q) => s + Number(q.plannedAmount || 0), 0);
}

function plannedSavingsForPeriod(savings, periodKey) {
  if (!periodKey) return 0;
  const [yStr, mStr] = (periodKey || '').split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  if (!year || !month) return 0;
  const monthsRemaining = Math.max(1, 12 - month + 1);
  return (savings || []).reduce((sum, s) => {
    const goal = Number(s.goal || 0);
    const saved = Number(s.saved || 0);
    const remaining = Math.max(goal - saved, 0);
    if (remaining <= 0) return sum;
    return sum + remaining / monthsRemaining;
  }, 0);
}

export function Dashboard({ data, monthKeyStr }) {
  const {
    categories = CATEGORIES,
    budgets = {},
    budgetsAll = {},
    transactions = [],
    debts = [],
    savings = [],
    budgetCutDay = 1,
    activeUserPreferences,
  } = data || {};

  const mk = monthKeyStr;
  const currentYear =
    Number((monthKeyStr || '').split('-')[0]) ||
    new Date().getFullYear();
  const previousYear = currentYear - 1;

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

  const catSpend = catsWithSavings.reduce((acc, c) => {
    const debtPlanned =
      c === DEBT_CATEGORY ? plannedDebtsForPeriod(debts, mk) : 0;
    const savingsPlanned =
      c === SAVINGS_CATEGORY ? plannedSavingsForPeriod(savings, mk) : 0;

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

  const savingsTotals = savings.reduce(
    (acc, s) => {
      acc.goal += Number(s.goal || 0);
      acc.saved += Number(s.saved || 0);
      return acc;
    },
    { goal: 0, saved: 0 },
  );

  const savingsProgress =
    savingsTotals.goal > 0
      ? (savingsTotals.saved / savingsTotals.goal) * 100
      : 0;

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
  const txPrevYear = txWithYear.filter((t) => t.__year === previousYear);

  const annualIncome = txCurrentYear
    .filter((t) => t.type === 'ingreso')
    .reduce((a, b) => a + Number(b.amount || 0), 0);
  const annualExpense = txCurrentYear
    .filter((t) => t.type === 'gasto')
    .reduce((a, b) => a + Number(b.amount || 0), 0);
  const annualSavings = annualIncome - annualExpense;

  const prevIncome = txPrevYear
    .filter((t) => t.type === 'ingreso')
    .reduce((a, b) => a + Number(b.amount || 0), 0);
  const prevExpense = txPrevYear
    .filter((t) => t.type === 'gasto')
    .reduce((a, b) => a + Number(b.amount || 0), 0);
  const prevSavings = prevIncome - prevExpense;

  function variation(current, prev, betterWhenHigher = true) {
    if (!prev) return null;
    const deltaPct = ((current - prev) / prev) * 100;
    const improved = betterWhenHigher ? deltaPct >= 0 : deltaPct <= 0;
    return {
      deltaPct,
      improved,
      arrow: improved ? '▲' : '▼',
      color: improved ? 'text-green-700' : 'text-red-600',
      label: `${improved ? '▲' : '▼'} ${Math.abs(deltaPct).toFixed(1)}% vs año anterior`,
    };
  }

  // Presupuesto anual: suma de funded (o plan) por categoria en los 12 meses del anio
  const budgetTotalYear = Object.entries(budgetsAll || {}).reduce(
    (sumYear, [mkKey, catsBudget]) => {
      if (yearFromMonthKey(mkKey) !== currentYear) return sumYear;
      const catsMap = catsBudget || {};
      const perMonth = Object.entries(catsMap).reduce((s, [cat, entry]) => {
        // Solo categorias principales (sin subcategorias)
        if (!categories.includes(cat) && cat !== DEBT_CATEGORY) return s;
        const norm = normalizeBudgetEntry(entry);
        let val = Number(norm.funded || norm.plan || 0);
        if ((!val || val === 0) && cat === DEBT_CATEGORY) {
          val = plannedDebtsForPeriod(debts, mkKey);
        }
        return s + val;
      }, 0);
      return sumYear + perMonth;
    },
    0,
  );

  const budgetTotalPrevYear = Object.entries(budgetsAll || {}).reduce(
    (sumYear, [mkKey, catsBudget]) => {
      if (yearFromMonthKey(mkKey) !== previousYear) return sumYear;
      const catsMap = catsBudget || {};
      const perMonth = Object.entries(catsMap).reduce((s, [cat, entry]) => {
        if (!categories.includes(cat) && cat !== DEBT_CATEGORY) return s;
        const norm = normalizeBudgetEntry(entry);
        let val = Number(norm.funded || norm.plan || 0);
        if ((!val || val === 0) && cat === DEBT_CATEGORY) {
          val = plannedDebtsForPeriod(debts, mkKey);
        }
        return s + val;
      }, 0);
      return sumYear + perMonth;
    },
    0,
  );

  const pctBudgetUsedYear =
    budgetTotalYear > 0 ? (annualExpense / budgetTotalYear) * 100 : 0;
  const pctBudgetUsedPrev =
    budgetTotalPrevYear > 0 ? (prevExpense / budgetTotalPrevYear) * 100 : null;

  // Top categorias por gasto anual
  const expenseByCategory = txCurrentYear
    .filter((t) => t.type === 'gasto')
    .reduce((acc, t) => {
      const cat = t.category || 'Sin categoria';
      acc[cat] = (acc[cat] || 0) + Number(t.amount || 0);
      return acc;
    }, {});

  const totalExpenseYear = annualExpense || 1;
  const topCategories = Object.entries(expenseByCategory)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  // Tendencia mensual
  const monthlyTrend = Array.from({ length: 12 }).map((_, idx) => {
    const month = idx + 1;
    const mkMonth = `${currentYear}-${String(month).padStart(2, '0')}`;
    const txMonth = txCurrentYear.filter((t) => t.__mk === mkMonth);
    const income = txMonth
      .filter((t) => t.type === 'ingreso')
      .reduce((a, b) => a + Number(b.amount || 0), 0);
    const expense = txMonth
      .filter((t) => t.type === 'gasto')
      .reduce((a, b) => a + Number(b.amount || 0), 0);
    return {
      mk: mkMonth,
      label: new Date(currentYear, idx, 1).toLocaleString('es-CL', {
        month: 'short',
      }),
      income,
      expense,
      savings: income - expense,
    };
  });

  const monthlyTrendPrev = Array.from({ length: 12 }).map((_, idx) => {
    const month = idx + 1;
    const mkMonth = `${previousYear}-${String(month).padStart(2, '0')}`;
    const txMonth = txPrevYear.filter((t) => t.__mk === mkMonth);
    const income = txMonth
      .filter((t) => t.type === 'ingreso')
      .reduce((a, b) => a + Number(b.amount || 0), 0);
    const expense = txMonth
      .filter((t) => t.type === 'gasto')
      .reduce((a, b) => a + Number(b.amount || 0), 0);
    return { income, expense, savings: income - expense };
  });

  const mostExpensiveMonth = monthlyTrend.reduce(
    (max, m) => (m.expense > max.expense ? m : max),
    { expense: -Infinity },
  );
  const bestSavingsMonth = monthlyTrend.reduce(
    (max, m) => (m.savings > max.savings ? m : max),
    { savings: -Infinity },
  );

  const expenseByCategoryPrev = txPrevYear
    .filter((t) => t.type === 'gasto')
    .reduce((acc, t) => {
      const cat = t.category || 'Sin categoria';
      acc[cat] = (acc[cat] || 0) + Number(t.amount || 0);
      return acc;
    }, {});

  const growthCategories = Object.entries(expenseByCategory)
    .map(([cat, val]) => {
      const prevVal = expenseByCategoryPrev[cat] || 0;
      if (prevVal <= 0) return null;
      const delta = ((val - prevVal) / prevVal) * 100;
      return { cat, delta };
    })
    .filter(Boolean);

  const topGrowth = [...growthCategories]
    .filter((g) => g.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 3);
  const topDecline = [...growthCategories]
    .filter((g) => g.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 3);

  // Alertas
  const alerts = [];
  if (pctBudgetUsedYear > 80) {
    alerts.push('Gastaste más del 80% del presupuesto anual.');
  }
  // dos meses seguidos con ahorro negativo
  let negativeStreak = 0;
  for (const m of monthlyTrend) {
    if (m.savings < 0) negativeStreak += 1;
    else negativeStreak = 0;
    if (negativeStreak >= 2) {
      alerts.push('Llevas 2 meses seguidos con ahorro negativo.');
      break;
    }
  }
  // categoria supera promedio +30%
  const avgExpense =
    Object.values(expenseByCategory).reduce((a, b) => a + b, 0) /
    Math.max(1, Object.values(expenseByCategory).length);
  Object.entries(expenseByCategory).forEach(([cat, val]) => {
    if (avgExpense > 0 && val > avgExpense * 1.3) {
      alerts.push(
        `${cat} supera el promedio anual en +30% (actual: ${new Intl.NumberFormat('es-CL').format(val)}).`,
      );
    }
  });
  // ingresos bajaron >15% vs año anterior
  if (prevIncome > 0 && annualIncome < prevIncome * 0.85) {
    alerts.push('Los ingresos cayeron más de 15% respecto al año anterior.');
  }

  // Mejores decisiones
  const bestDecisions = [];
  if (prevSavings !== 0) {
    const deltaSav = ((annualSavings - prevSavings) / Math.abs(prevSavings)) * 100;
    if (!Number.isNaN(deltaSav) && deltaSav > 0) {
      bestDecisions.push(
        `Aumentaste tu ahorro anual en ${deltaSav.toFixed(1)}% respecto al año anterior.`,
      );
    }
  }
  topDecline.forEach((d) => {
    bestDecisions.push(
      `Reduciste ${d.cat} en ${Math.abs(d.delta).toFixed(1)}% versus el año pasado.`,
    );
  });
  if (bestSavingsMonth.savings > 0) {
    bestDecisions.push(
      `Tu mejor mes de ahorro fue ${bestSavingsMonth.label} con ${new Intl.NumberFormat('es-CL').format(
        bestSavingsMonth.savings,
      )}.`,
    );
  }

  const cardsPrefs = activeUserPreferences?.dashboardCards || {};
  const showResumenMes = cardsPrefs.resumenMes ?? true;
  const showDeudas = cardsPrefs.deudas ?? true;
  const showAhorro = cardsPrefs.ahorro ?? true;
  const showPresupuestos = cardsPrefs.presupuestos ?? true;
  // IMPORTANTE: ya NO usamos tarjetas de inversiones en el dashboard

  return (
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
                balance >= 0 ? 'text-green-700' : 'text-red-600'
              }`}
            >
              <span>Balance</span>
              <strong>
                <Money n={balance} />
              </strong>
            </div>
            <div>
              <div className="text-sm mb-1">% Gastado sobre ingresos</div>
              <Progress value={pctIngresosVsGastos} />
            </div>
            <div className="text-xs text-gray-500">
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
            <div>
              <div className="text-sm mb-1">% pagado</div>
              <Progress value={debtProgress} mode="good" />
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
              <Progress value={savingsProgress} mode="good" />
            </div>
          </div>
        </Card>
      )}

      {showPresupuestos && (
        <Card className="md:col-span-2 lg:col-span-3">
          <SectionTitle>Presupuestos (progreso por categoria)</SectionTitle>
          {visibleCats.length === 0 ? (
            <div className="text-sm text-gray-500">
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
                    <div className="text-[11px] text-gray-500 mb-1 text-left">
                      Valor del periodo a pagar: <Money n={catSpend[c].debtPlanned} />
                    </div>
                  )}
                  {c === SAVINGS_CATEGORY &&
                    (catSpend[c].savingsPlanned || 0) > 0 && (
                      <div className="text-[11px] text-gray-500 mb-1 text-left">
                        Valor del periodo a ahorrar:{' '}
                        <Money n={catSpend[c].savingsPlanned} />
                      </div>
                    )}
                  <Progress value={catSpend[c].pctFundedUsed} />
                  <div className="text-xs text-gray-600 mt-2 text-left">
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
        <SectionTitle>Resumen anual {currentYear}</SectionTitle>

        {/* KPIs */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          <div className="border rounded-lg p-3">
            <div className="text-xs text-gray-500">Ingresos totales</div>
            <div className="text-lg font-semibold">
              <Money n={annualIncome} />
            </div>
          </div>
          <div className="border rounded-lg p-3">
            <div className="text-xs text-gray-500">Gastos totales</div>
            <div className="text-lg font-semibold">
              <Money n={annualExpense} />
            </div>
          </div>
          <div className="border rounded-lg p-3">
            <div className="text-xs text-gray-500">Ahorro acumulado</div>
            <div className="text-lg font-semibold">
              <Money n={annualSavings} />
            </div>
          </div>
          <div className="border rounded-lg p-3">
            <div className="text-xs text-gray-500">% presupuesto anual usado</div>
            <div className="text-lg font-semibold">
              {pctBudgetUsedYear.toFixed(1)}%
            </div>
          </div>
        </div>

        {/* Top categorias */}
        <div className="mb-4">
          <div className="text-sm font-semibold mb-2">
            Top categorias del año
          </div>
          {topCategories.length === 0 ? (
            <div className="text-xs text-gray-500">
              Aun no hay gastos registrados este año.
            </div>
          ) : (
            <div className="space-y-1 text-sm">
              {topCategories.map(([cat, total], idx) => {
                const pct = (total / totalExpenseYear) * 100;
                return (
                  <div key={cat} className="flex justify-between">
                    <span>
                      {idx + 1}. {cat}
                    </span>
                    <span className="text-gray-700">
                      Gasto: <Money n={total} /> — {pct.toFixed(1)}%
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Tendencia mensual */}
        <div>
          <div className="text-sm font-semibold mb-2">
            Tendencia mensual {currentYear}
          </div>
          <div className="grid grid-cols-12 gap-2 text-xs text-gray-600 mb-2">
            {monthlyTrend.map((m) => (
              <div key={m.mk} className="text-center font-semibold">
                {m.label}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-12 gap-2 text-xs">
            {monthlyTrend.map((m) => (
              <div key={m.mk} className="border rounded-lg p-2 text-center">
                <div className="font-semibold text-gray-700">
                  <Money n={m.expense} />
                </div>
                <div className="text-[11px] text-gray-500">
                  Gasto / Ingreso
                </div>
                <div className="text-[11px] text-gray-600">
                  <Money n={m.income} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}

