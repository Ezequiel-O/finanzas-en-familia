// src/modules/savings/Savings.jsx
import React, { useEffect, useMemo, useState } from 'react';

import { Card } from '../../components/ui/card.jsx';
import { SectionTitle } from '../../components/ui/SectionTitle.jsx';
import { Money } from '../../components/ui/money.jsx';
import { Progress } from '../../components/ui/Progress.jsx';
import {
  monthKey,
  shiftMonth,
  formatBudgetPeriodLabel,
  budgetMonthKeyForDate,
  getBudgetPeriod,
} from '../../utils/budgetPeriod.js';

function toNumber(n) {
  const num = Number(n || 0);
  return Number.isNaN(num) ? 0 : num;
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

function perPeriodPlanForSaving(s, periodKey, budgetCutDay) {
  if (!periodKey) return { plan: 0, targetPk: '', monthsLeft: 0 };
  const targetPk = s.targetDate
    ? budgetMonthKeyForDate(s.targetDate, budgetCutDay)
    : `${new Date().getFullYear()}-12`;
  const remaining = Math.max(toNumber(s.goal) - toNumber(s.saved), 0);
  const monthsLeft = targetPk >= periodKey ? periodsBetween(periodKey, targetPk) : 0;
  const plan = monthsLeft > 0 ? remaining / monthsLeft : remaining;
  return { plan, targetPk, monthsLeft };
}

function savingsPaidFromTransactions(transactions, periodKey, cutDay) {
  const { start, end } = getBudgetPeriod(periodKey, cutDay);
  return (transactions || [])
    .filter((t) => t.category === 'Ahorro')
    .filter((t) => {
      const d = (t.date || t.createdAt || '').slice(0, 10);
      return d >= start && d < end;
    })
    .reduce((s, t) => s + toNumber(t.amount), 0);
}

export function Savings({ data, actions, monthKeyStr }) {
  const savings = Array.isArray(data?.savings) ? data.savings : [];
  const transactions = Array.isArray(data?.transactions) ? data.transactions : [];
  const budgetCutDay = data?.budgetCutDay || 1;

  const { addSaving, updateSaving, removeSaving } = actions || {};

  const [form, setForm] = useState({
    name: '',
    goal: '',
    saved: '',
    targetDate: '',
  });
  const [savingEdit, setSavingEdit] = useState(null); // {id,name,goal,targetDate}

  const [currentPeriodKey, setCurrentPeriodKey] = useState(
    monthKeyStr || monthKey(new Date()),
  );

  useEffect(() => {
    if (monthKeyStr) {
      setCurrentPeriodKey(monthKeyStr);
    }
  }, [monthKeyStr]);

  const trueCurrentPeriod = useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    return budgetMonthKeyForDate(todayStr, budgetCutDay);
  }, [budgetCutDay]);

  const visiblePeriods = useMemo(() => {
    const center = currentPeriodKey;
    const list = [
      shiftMonth(center, -1),
      center,
      shiftMonth(center, 1),
      trueCurrentPeriod,
    ];
    return Array.from(new Set(list));
  }, [currentPeriodKey, trueCurrentPeriod]);

  const totals = savings.reduce(
    (acc, s) => {
      acc.goal += toNumber(s.goal);
      acc.saved += toNumber(s.saved);
      return acc;
    },
    { goal: 0, saved: 0 },
  );
  const totalRemaining = Math.max(totals.goal - totals.saved, 0);

  const plannedThisPeriod = savings.reduce((sum, s) => {
    const { plan, targetPk } = perPeriodPlanForSaving(
      s,
      currentPeriodKey,
      budgetCutDay,
    );
    return targetPk && targetPk >= currentPeriodKey ? sum + plan : sum;
  }, 0);

  const paidThisPeriod = savingsPaidFromTransactions(
    transactions,
    currentPeriodKey,
    budgetCutDay,
  );
  const pendingThisPeriod = Math.max(plannedThisPeriod - paidThisPeriod, 0);

  async function addSavingHandler(e) {
    e.preventDefault();
    if (!addSaving) return;
    const s = {
      name: form.name || 'Ahorro',
      goal: toNumber(form.goal),
      saved: toNumber(form.saved),
      targetDate: form.targetDate || '',
      createdAt: Date.now(),
    };
    await addSaving(s);
    setForm({ name: '', goal: '', saved: '', targetDate: '' });
  }

  async function handleSaveEdit(e) {
    e.preventDefault();
    if (!savingEdit || !updateSaving) return;
    const patch = {
      name: savingEdit.name || 'Ahorro',
      goal: toNumber(savingEdit.goal),
      targetDate: savingEdit.targetDate || '',
    };
    await updateSaving(savingEdit.id, patch);
    setSavingEdit(null);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* Columna izquierda: formulario */}
      <Card className="h-full">
        <SectionTitle>Nueva meta de ahorro</SectionTitle>
        <form onSubmit={addSavingHandler} className="grid gap-3">
          <input
            className="border rounded-xl p-2"
            placeholder="Nombre (ej. Fondo de emergencia)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className="border rounded-xl p-2"
            type="number"
            min={0}
            step="1"
            placeholder="Meta (CLP)"
            value={form.goal}
            onChange={(e) => setForm({ ...form, goal: e.target.value })}
          />
          <input
            className="border rounded-xl p-2"
            type="number"
            min={0}
            step="1"
            placeholder="Ahorro inicial (CLP)"
            value={form.saved}
            onChange={(e) => setForm({ ...form, saved: e.target.value })}
          />
          <input
            className="border rounded-xl p-2"
            type="date"
            placeholder="Fecha meta"
            value={form.targetDate}
            onChange={(e) => setForm({ ...form, targetDate: e.target.value })}
          />
          <button className="px-4 py-2 rounded-xl bg-gray-900 text-white hover:bg-gray-800">
            Agregar meta
          </button>
        </form>
      </Card>

      {/* Columna derecha: calendario / listado */}
      <Card className="lg:col-span-2 space-y-3">
        <SectionTitle>Calendario de ahorro</SectionTitle>

        {/* KPIs */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-center text-sm">
          <div className="border rounded-xl p-3 bg-white shadow-sm dark:bg-gray-800 dark:border-gray-700">
            <div className="text-xs text-gray-500">Planificado</div>
            <div className="text-lg font-semibold">
              <Money n={plannedThisPeriod} />
            </div>
          </div>
          <div className="border rounded-xl p-3 bg-white shadow-sm dark:bg-gray-800 dark:border-gray-700">
            <div className="text-xs text-gray-500">Ahorros (movimientos)</div>
            <div className="text-lg font-semibold">
              <Money n={paidThisPeriod} />
            </div>
          </div>
          <div className="border rounded-xl p-3 bg-white shadow-sm dark:bg-gray-800 dark:border-gray-700">
            <div className="text-xs text-gray-500">Pendiente</div>
            <div className="text-lg font-semibold">
              <Money n={pendingThisPeriod} />
            </div>
          </div>
        </div>

        {/* Periodos */}
        <div className="overflow-x-auto">
          <div
            className="grid text-[11px] font-semibold text-gray-700 border rounded-lg bg-gray-50 px-2 py-2 min-w-[520px] dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200"
            style={{
              gridTemplateColumns: `160px repeat(${visiblePeriods.length}, minmax(90px, 1fr))`,
            }}
          >
            <div
              className="text-left px-2 cursor-help text-gray-700 dark:text-gray-200"
              title="Ahorro: se planifica por fecha meta de la meta (no por cuotas de deudas)."
            >
              Periodos
            </div>
            {visiblePeriods.map((pk) => {
              const isActual = pk === trueCurrentPeriod;
              const isSelected = pk === currentPeriodKey;
              return (
                <div
                  key={pk}
                  onClick={() => setCurrentPeriodKey(pk)}
                  className={`text-center px-2 py-1 rounded-lg border flex flex-col items-center justify-center gap-1 ${
                    isActual
                      ? 'bg-green-50 text-green-800 border-green-400 dark:bg-green-900/30 dark:text-green-200 dark:border-green-500'
                      : 'border-transparent bg-white dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200'
                  } ${isSelected ? 'ring-1 ring-blue-400' : ''} cursor-pointer`}
                >
                  <span>{formatBudgetPeriodLabel(pk, budgetCutDay)}</span>
                  {isSelected && (
                    <span className="text-blue-500 text-[10px] leading-none">v</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Metas */}
        <div className="space-y-3">
          {savings.map((s) => {
            const pct = s.goal > 0 ? (toNumber(s.saved) / toNumber(s.goal)) * 100 : 0;
            const { plan: planPerPeriod, targetPk, monthsLeft } = perPeriodPlanForSaving(
              s,
              currentPeriodKey,
              budgetCutDay,
            );
            return (
              <div
                key={s.id || s.name + s.goal}
                className="rounded-xl border shadow-sm p-2 space-y-2 bg-white dark:bg-gray-800 dark:border-gray-700"
              >
                <div className="pt-2 overflow-x-auto">
                  <div
                    className="grid text-[11px] items-center gap-2 min-w-[520px]"
                    style={{
                      gridTemplateColumns: `160px repeat(${visiblePeriods.length}, minmax(90px, 1fr))`,
                    }}
                  >
                    <div className="text-base font-semibold text-gray-800 dark:text-gray-200 px-2">
                      {s.name || 'Ahorro'}
                    </div>
                    {visiblePeriods.map((pk) => {
                      const planned = pk <= targetPk ? planPerPeriod : 0;
                      const paid = savingsPaidFromTransactions(
                        transactions,
                        pk,
                        budgetCutDay,
                      );
                      return (
                        <div
                          key={pk}
                          className="h-10 min-w-[60px] px-2 flex flex-col justify-center border rounded-md bg-gray-50 text-center dark:bg-gray-800 dark:border-gray-700"
                        >
                          <span className="text-[10px] font-semibold">
                            <Money n={planned} />
                          </span>
                          <span className="text-[9px] text-gray-500">
                            Pagado: <Money n={paid} />
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="text-[10px] text-gray-500 mt-1">
                    Plan por periodo estimado para alcanzar la meta.
                  </div>
                </div>

                <div className="mt-2">
                  <Progress value={pct} mode="good" />
                  <div className="text-[11px] text-gray-600 mt-1 text-right">
                    Meta: {s.targetDate ? `hasta ${s.targetDate} (${monthsLeft || 0} periodos)` : 'sin fecha definida'}
                    {' · '}Ahorrado: <Money n={s.saved} /> / Meta: <Money n={s.goal} />
                  </div>
                </div>

                <div className="flex flex-col md:flex-row items-center gap-2">
                  <button
                    className="px-4 py-2 rounded-xl border bg-white hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-100 dark:border-gray-700"
                    onClick={() =>
                      setSavingEdit({
                        id: s.id,
                        name: s.name,
                        goal: s.goal,
                        targetDate: s.targetDate || '',
                      })
                    }
                  >
                    Editar
                  </button>
                  <button
                    className="ml-auto text-red-600 text-sm px-3 py-2 rounded-lg border border-red-500 hover:bg-red-50 dark:hover:bg-red-900/10"
                    onClick={() => removeSaving && removeSaving(s.id)}
                  >
                    Eliminar
                  </button>
                </div>
              </div>
            );
          })}
          {savings.length === 0 && (
            <div className="text-gray-500">Sin metas registradas.</div>
          )}
        </div>

        {/* Resumen general */}
        <div className="grid grid-cols-3 gap-2 text-xs text-gray-600 pt-2">
          <div className="border rounded-lg p-2 bg-gray-50 text-center">
            Meta total: <Money n={totals.goal} />
          </div>
          <div className="border rounded-lg p-2 bg-gray-50 text-center">
            Ahorrado: <Money n={totals.saved} />
          </div>
          <div className="border rounded-lg p-2 bg-gray-50 text-center">
            Restante: <Money n={totalRemaining} />
          </div>
        </div>
      </Card>

      {savingEdit && (
        <div className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center pt-16 px-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl p-5 w-full max-w-md">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">Editar meta</h3>
              <button
                type="button"
                className="text-sm text-gray-500 hover:text-gray-800 dark:text-gray-300 dark:hover:text-white"
                onClick={() => setSavingEdit(null)}
              >
                x
              </button>
            </div>
            <form onSubmit={handleSaveEdit} className="grid gap-3 text-sm">
              <div className="grid gap-1">
                <label>Nombre</label>
                <input
                  className="border rounded-lg p-2 bg-white dark:bg-gray-800"
                  value={savingEdit.name}
                  onChange={(e) =>
                    setSavingEdit((prev) => ({ ...prev, name: e.target.value }))
                  }
                  required
                />
              </div>
              <div className="grid gap-1">
                <label>Meta</label>
                <input
                  type="number"
                  min={0}
                  step="1"
                  className="border rounded-lg p-2 bg-white dark:bg-gray-800"
                  value={savingEdit.goal}
                  onChange={(e) =>
                    setSavingEdit((prev) => ({ ...prev, goal: e.target.value }))
                  }
                  required
                />
              </div>
              <div className="grid gap-1">
                <label>Fecha meta</label>
                <input
                  type="date"
                  className="border rounded-lg p-2 bg-white dark:bg-gray-800"
                  value={savingEdit.targetDate}
                  onChange={(e) =>
                    setSavingEdit((prev) => ({
                      ...prev,
                      targetDate: e.target.value,
                    }))
                  }
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="px-4 py-2 rounded-lg border text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:border-gray-700 dark:hover:bg-gray-800"
                  onClick={() => setSavingEdit(null)}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-gray-900 text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
                >
                  Guardar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
