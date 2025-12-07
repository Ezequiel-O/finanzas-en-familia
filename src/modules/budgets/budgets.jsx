import React, { useState, useMemo } from 'react';

import { Card } from '../../components/ui/card.jsx';
import { SectionTitle } from '../../components/ui/SectionTitle.jsx';
import { Money } from '../../components/ui/money.jsx';
import { Progress } from '../../components/ui/Progress.jsx';
import { shiftMonth } from '../../utils/budgetPeriod.js';
import { CATEGORIES, DEBT_CATEGORY } from '../../constants.js';
import { filterTransactionsByPeriodAndUser } from '../../utils/transactions.js';

export function Budgets({ data, actions, monthKeyStr }) {
  const {
    budgets = {},
    transactions = [],
    categories = [],
    budgetCutDay = 1,
    debts = [],
  } = data || {};

  const cats = categories && categories.length ? categories : CATEGORIES;
  const mk = monthKeyStr;
  const cutDay = budgetCutDay;

  const debtsArray = Array.isArray(debts) ? debts : [];
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

  // --- FILAS POR CATEGORÍA ---
  const rows = cats.map((c) => {
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

    // Si es la categoría fija "Deudas" y no hay presupuesto guardado,
    // usa por defecto la suma de cuotas planificadas para este período.
    if (c === DEBT_CATEGORY && !b && debtPlannedForPeriod > 0) {
      plan = debtPlannedForPeriod;
      funded = debtPlannedForPeriod;
    }

    const pctFundedUsed = funded > 0 ? (spent / funded) * 100 : 0;

    return { c, spent, plan, funded, pctFundedUsed };
  });

  const totalFunded = rows.reduce((a, r) => a + r.funded, 0);
  const totalSpent = rows.reduce((a, r) => a + r.spent, 0);

  const restanteSinAsignar = disponible - totalFunded;
  const pctUsadoSobreFunded =
    totalFunded > 0 ? (totalSpent / totalFunded) * 100 : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* IZQUIERDA: categorías */}
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
          Presupuestos por categoría
        </SectionTitle>

        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.c} className="border rounded-xl p-3">
              <div className="text-sm font-medium mb-2">{r.c}</div>

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

                  {/* Input: Presupuesto (antes "Asignado") */}
                  <div className="w-32 text-xs">
                    <label className="flex flex-col gap-1">
                      <span>Presupuesto</span>
                      <input
                        type="number"
                        min={0}
                        step="1"
                        className="border rounded-lg px-2 py-1 text-right"
                        value={r.funded || ''}
                        onChange={(e) =>
                          actions.setBudgetFunded(mk, r.c, e.target.value)
                        }
                      />
                    </label>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* DERECHA: resumen del período con rollover */}
      <Card>
        <SectionTitle>Resumen del período</SectionTitle>
        <div className="space-y-2 text-sm">
          {/* Bloque 1: Antes de presupuestar */}
          <div className="text-xs font-semibold text-gray-500 uppercase">
            1. Antes de presupuestar
          </div>

          <div className="flex justify-between">
            <span>Lo que traes del período anterior</span>
            <strong>
              <Money n={saldoAnterior} />
            </strong>
          </div>
          <div className="flex justify-between">
            <span>Ingresos de este período</span>
            <strong>
              <Money n={ingresosPeriodo} />
            </strong>
          </div>
          <div className="flex justify-between">
            <span>Total disponible para este período</span>
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
            <span>Te queda al final (si no gastas más)</span>
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
                {totalFunded > 0 ? `${pctUsadoSobreFunded.toFixed(0)}%` : '—'}
              </span>
            </div>
            <Progress value={pctUsadoSobreFunded} />
          </div>

          <div className="text-xs text-gray-500">
            Día de corte del mes: {budgetCutDay}
          </div>
        </div>
      </Card>
    </div>
  );
}
