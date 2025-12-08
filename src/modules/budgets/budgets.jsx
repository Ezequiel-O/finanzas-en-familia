import React, { useState, useMemo } from 'react';

import { Card } from '../../components/ui/card.jsx';
import { SectionTitle } from '../../components/ui/SectionTitle.jsx';
import { Money } from '../../components/ui/money.jsx';
import { Progress } from '../../components/ui/Progress.jsx';
import { shiftMonth, budgetMonthKeyForDate } from '../../utils/budgetPeriod.js';
import { CATEGORIES, DEBT_CATEGORY } from '../../constants.js';
import { filterTransactionsByPeriodAndUser } from '../../utils/transactions.js';

const SAVINGS_CATEGORY = 'Ahorro';

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

export function Budgets({ data, actions, monthKeyStr }) {
  const {
    budgets = {},
    transactions = [],
    categories = [],
    budgetCutDay = 1,
    debts = [],
    savings = [],
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

  const debtPlannedForPeriod = debtsArray
    .flatMap((d) => (Array.isArray(d.schedule) ? d.schedule : []))
    .filter((q) => q.periodKey === mk)
    .reduce((sum, q) => sum + Number(q.plannedAmount || 0), 0);

  const savingsPlannedForPeriod = (() => {
    const [yStr, mStr] = (mk || '').split('-');
    const month = Number(mStr);
    const monthsRemaining = Number.isFinite(month) ? Math.max(1, 12 - month + 1) : 0;
    if (!monthsRemaining) return 0;
    return savingsArray.reduce((sum, s) => {
      const goal = Number(s.goal || 0);
      const saved = Number(s.saved || 0);
      const remaining = Math.max(goal - saved, 0);
      if (remaining <= 0) return sum;
      if (s.targetDate) {
        const targetPk = budgetMonthKeyForDate(s.targetDate, cutDay);
        if (targetPk < mk) return sum;
        const monthsToTarget = periodsBetween(mk, targetPk) || 1;
        return sum + remaining / monthsToTarget;
      }
      return sum + remaining / monthsRemaining;
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

  const [viewMode, setViewMode] = useState('amount'); // amount | percent
  const [showBreakdownModal, setShowBreakdownModal] = useState(false);
  const [breakdownCategory, setBreakdownCategory] = useState(null);
  const [breakdownItems, setBreakdownItems] = useState([]);
  const breakdownSpent = useMemo(() => {
    const acc = {};
    for (const t of monthTx) {
      const subIds =
        Array.isArray(t?.meta?.budgetSubcategoryIds) && t.meta.budgetSubcategoryIds.length
          ? t.meta.budgetSubcategoryIds
          : t?.meta?.budgetSubcategoryId
            ? [t.meta.budgetSubcategoryId]
            : [];
      if (!subIds.length) continue;
      const amt = Number(t.amount || 0);
      if (Number.isNaN(amt)) continue;
      subIds.forEach((subId) => {
        if (!subId) return;
        acc[subId] = (acc[subId] || 0) + amt;
      });
    }
    return acc;
  }, [monthTx]);

  // --- ROLLOVER ---
  const ingresosPrev = prevMonthTx
    .filter((t) => t.type === 'ingreso')
    .reduce((a, b) => a + Number(b.amount || 0), 0);

  const gastosPrev = prevMonthTx
    .filter((t) => t.type === 'gasto')
    .reduce((a, b) => a + Number(b.amount || 0), 0);

  const saldoAnterior = ingresosPrev - gastosPrev; // puede ser + o -

  const ingresosPeriodo = monthTx
    .filter((t) => t.type === 'ingreso')
    .reduce((a, b) => a + Number(b.amount || 0), 0);

  const gastosPeriodo = monthTx
    .filter((t) => t.type === 'gasto')
    .reduce((a, b) => a + Number(b.amount || 0), 0);

  const disponible = saldoAnterior + ingresosPeriodo;
  const balanceFinal = disponible - gastosPeriodo;

  // --- FILAS POR CATEGORIA ---
  const rows = cats.map((c) => {
    const spent = monthTx
      .filter((t) => t.type === 'gasto' && t.category === c)
      .reduce((a, b) => a + Number(b.amount || 0), 0);

    const b = budgets?.[c];
    let plan = 0;
    let funded = 0;
    const breakdown = Array.isArray(b?.breakdown) ? b.breakdown : [];
    const breakdownTotal = breakdown.reduce(
      (acc, item) => acc + Number(item.amount || 0),
      0,
    );
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
      const shouldAutofill = !b || (!funded && !plan);
      if (debtPlannedForPeriod > 0 && shouldAutofill) {
        plan = debtPlannedForPeriod;
        funded = debtPlannedForPeriod;
      } else if (debtPlannedForPeriod > funded && funded > 0) {
        debtWarning = true;
      }
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
      debtWarning,
      debtPlanned: debtPlannedForPeriod,
      savingsWarning,
      savingsPlanned: savingsPlannedForPeriod,
    };
  });

  const totalFunded = rows.reduce((a, r) => a + r.funded, 0);
  const totalSpent = rows.reduce((a, r) => a + r.spent, 0);

  const restanteSinAsignar = disponible - totalFunded;
  const pctUsadoSobreFunded =
    totalFunded > 0 ? (totalSpent / totalFunded) * 100 : 0;

  function handleOpenBreakdown(cat, breakdown = []) {
    setBreakdownCategory(cat);
    const items = Array.isArray(breakdown)
      ? breakdown.map((item) => ({
          id: item.id || Math.random().toString(36).slice(2, 10),
          name: item.name || '',
          amount: Number(item.amount || 0),
        }))
      : [];
    setBreakdownItems(
      items.length
        ? items
        : [{ id: Math.random().toString(36).slice(2, 10), name: '', amount: 0 }],
    );
    setShowBreakdownModal(true);
  }

  function handleAddBreakdownRow() {
    setBreakdownItems((prev) => [
      ...prev,
      { id: Math.random().toString(36).slice(2, 10), name: '', amount: 0 },
    ]);
  }

  function handleChangeBreakdown(id, field, value) {
    setBreakdownItems((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              [field]:
                field === 'amount'
                  ? Number(String(value || '').replace(/\D/g, ''))
                  : value,
            }
          : item,
      ),
    );
  }

  function handleRemoveBreakdownRow(id) {
    setBreakdownItems((prev) => prev.filter((item) => item.id !== id));
  }

  async function handleSaveBreakdown() {
    if (!breakdownCategory || !actions?.setBudgetFunded) {
      setShowBreakdownModal(false);
      return;
    }
    const cleanItems = breakdownItems
      .map((item) => ({
        id: item.id || Math.random().toString(36).slice(2, 10),
        name: (item.name || '').trim(),
        amount: Number(item.amount || 0),
      }))
      .filter((item) => item.name || item.amount > 0);

    const total = cleanItems.reduce(
      (acc, item) => acc + Number(item.amount || 0),
      0,
    );

    await actions.setBudgetFunded(monthKeyStr, breakdownCategory, {
      funded: total,
      breakdown: cleanItems,
    });
    setShowBreakdownModal(false);
  }

  const breakdownTotalModal = breakdownItems.reduce(
    (acc, item) => acc + Number(item.amount || 0),
    0,
  );

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* IZQUIERDA: categorias */}
      <Card className="lg:col-span-2">
        <SectionTitle
          right={
            <button
              className="px-3 py-1.5 rounded-full border text-sm"
              onClick={() =>
                setViewMode(viewMode === 'amount' ? 'percent' : 'amount')
              }
            >
              {viewMode === 'amount' ? 'Ver porcentaje' : 'Ver montos'}
            </button>
          }
        >
          Presupuestos por categoria
        </SectionTitle>

        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.c} className="border rounded-xl p-3">
              <div className="text-sm font-medium mb-2">{r.c}</div>

              {r.c === DEBT_CATEGORY && r.debtPlanned > 0 && (
                <div className="text-[11px] text-gray-500 mb-2">
                  Planificado por deudas este periodo: <Money n={r.debtPlanned} />
                  {r.debtWarning && (
                    <span className="text-red-600 ml-2">
                      (supera lo presupuestado)
                    </span>
                  )}
                </div>
              )}
              {r.c === SAVINGS_CATEGORY && r.savingsPlanned > 0 && (
                <div className="text-[11px] text-gray-500 mb-2">
                  Planificado para ahorro este periodo:{' '}
                  <Money n={r.savingsPlanned} />
                  {r.savingsWarning && (
                    <span className="text-red-600 ml-2">
                      (supera lo presupuestado)
                    </span>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-3">
                {/* Barra: Gasto vs Presupuesto */}
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="flex justify-between text-xs mb-1">
                      <span>Gasto vs Presupuestado</span>
                      <span>
                        {viewMode === 'amount' ? (
                          <>
                            <Money n={r.spent} /> / <Money n={r.funded} />
                          </>
                        ) : (
                          <>
                            {r.funded > 0
                              ? `${r.pctFundedUsed.toFixed(0)}% usado`
                              : '0% usado'}
                          </>
                        )}
                      </span>
                    </div>
                    <Progress value={r.pctFundedUsed} />
                  </div>

                  {/* Presupuesto (solo lectura) */}
                  <div className="w-44 text-xs flex justify-end">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">
                        <Money n={r.funded || 0} />
                      </span>
                      {r.c !== DEBT_CATEGORY && r.c !== SAVINGS_CATEGORY && (
                        <button
                          type="button"
                          className="w-8 h-8 flex items-center justify-center rounded-full border text-sm hover:bg-gray-100"
                          onClick={() => handleOpenBreakdown(r.c, r.breakdown)}
                        >
                          +
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* DERECHA: resumen del periodo con rollover */}
      <Card>
        <SectionTitle>Resumen del periodo</SectionTitle>
        <div className="space-y-2 text-sm">
          {/* Bloque 1: Antes de presupuestar */}
          <div className="text-xs font-semibold text-gray-500 uppercase">
            1. Antes de presupuestar
          </div>

          <div className="flex justify-between">
            <span>Lo que traes del periodo anterior</span>
            <strong>
              <Money n={saldoAnterior} />
            </strong>
          </div>
          <div className="flex justify-between">
            <span>Ingresos de este periodo</span>
            <strong>
              <Money n={ingresosPeriodo} />
            </strong>
          </div>
          <div className="flex justify-between">
            <span>Total disponible para este periodo</span>
            <strong>
              <Money n={disponible} />
            </strong>
          </div>

          <hr className="my-2" />

          {/* Bloque 2: Tu presupuesto */}
          <div className="text-xs font-semibold text-gray-500 uppercase">
            2. Tu presupuesto
          </div>

          <div className="flex justify-between">
            <span>Lo que ya asignaste en presupuestos</span>
            <strong>
              <Money n={totalFunded} />
            </strong>
          </div>
          <div className="flex justify-between">
            <span>Te queda por asignar / te pasaste</span>
            <strong
              className={
                restanteSinAsignar < 0 ? 'text-red-600' : 'text-green-700'
              }
            >
              <Money n={restanteSinAsignar} />
            </strong>
          </div>

          <hr className="my-2" />

          {/* Bloque 3: Lo que ha ocurrido de verdad */}
          <div className="text-xs font-semibold text-gray-500 uppercase">
            3. Lo que ha ocurrido de verdad
          </div>

          <div className="flex justify-between">
            <span>Gastado hasta ahora</span>
            <strong>
              <Money n={gastosPeriodo} />
            </strong>
          </div>
          <div className="flex justify-between">
            <span>Te queda al final (si no gastas mas)</span>
            <strong
              className={balanceFinal < 0 ? 'text-red-600' : 'text-green-700'}
            >
              <Money n={balanceFinal} />
            </strong>
          </div>
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span>% usado sobre tu presupuesto</span>
              <span>
                {totalFunded > 0 ? `${pctUsadoSobreFunded.toFixed(0)}%` : '-'}
              </span>
            </div>
            <Progress value={pctUsadoSobreFunded} />
          </div>

          <div className="text-xs text-gray-500">
            Dia de corte del mes: {budgetCutDay}
          </div>
        </div>
      </Card>

      {showBreakdownModal && (
        <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 backdrop-blur-sm pt-16">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl p-5 w-full max-w-3xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">
                Presupuesto para {breakdownCategory}
              </h3>
              <button
                type="button"
                className="text-sm text-gray-500 hover:text-gray-800"
                onClick={() => setShowBreakdownModal(false)}
              >
                x
              </button>
            </div>

            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
              {breakdownItems.map((item) => {
                const isPaid =
                  Number(breakdownSpent[item.id] || 0) >=
                    Number(item.amount || 0) && Number(item.amount || 0) > 0;

                return (
                  <div
                    key={item.id}
                    className="grid md:grid-cols-12 gap-2 items-start border rounded-lg p-2"
                  >
                    <div className="md:col-span-5 flex flex-col">
                      <label className="text-xs text-gray-500">
                        Nombre del gasto
                      </label>
                      <input
                        className="border rounded-lg px-2 py-1 text-sm w-full"
                        value={item.name}
                        onChange={(e) =>
                          handleChangeBreakdown(item.id, 'name', e.target.value)
                        }
                        placeholder="Ej: Luz, Agua, Internet"
                      />
                    </div>
                    <div className="md:col-span-4 flex flex-col">
                      <label className="text-xs text-gray-500">Monto</label>
                      <div className="flex items-center gap-2">
                        <input
                          className="border rounded-lg px-2 py-1 text-sm w-full text-right"
                          value={item.amount}
                          onChange={(e) =>
                            handleChangeBreakdown(item.id, 'amount', e.target.value)
                          }
                          inputMode="numeric"
                          pattern="\\d*"
                        />
                        {isPaid && (
                          <span className="text-xs font-semibold text-green-700">
                            OK
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-[11px] text-gray-600">
                        Pagado: <Money n={breakdownSpent[item.id] || 0} />
                      </div>
                    </div>
                    <div className="md:col-span-3 flex justify-end items-start">
                      <button
                        type="button"
                        className="px-2 py-1 text-xs rounded-lg border text-red-600"
                        onClick={() => handleRemoveBreakdownRow(item.id)}
                      >
                        Eliminar
                      </button>
                    </div>
                  </div>
                );
              })}

              <button
                type="button"
                className="px-3 py-1.5 text-sm rounded-lg border w-full md:w-auto"
                onClick={handleAddBreakdownRow}
              >
                Agregar sub-gasto
              </button>
            </div>

            <div className="mt-4 flex justify-between items-center text-sm">
              <span className="font-semibold">Total presupuesto categoria:</span>
              <span className="text-lg font-semibold">
                <Money n={breakdownTotalModal} />
              </span>
            </div>

            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                className="px-3 py-1.5 text-sm border rounded-lg"
                onClick={() => setShowBreakdownModal(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="px-3 py-1.5 text-sm rounded-lg bg-gray-900 text-white"
                onClick={handleSaveBreakdown}
              >
                Agregar a presupuesto de categoria
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

