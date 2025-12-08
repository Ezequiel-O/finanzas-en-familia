// src/modules/debts/Debts.jsx
import React, { useState, useMemo } from 'react';

import { Card } from '../../components/ui/card.jsx';
import { SectionTitle } from '../../components/ui/SectionTitle.jsx';
import { Money } from '../../components/ui/money.jsx';
import { Progress } from '../../components/ui/Progress.jsx';
import {
  monthKey,
  shiftMonth,
  getBudgetPeriod,
  formatBudgetPeriodLabel,
  budgetMonthKeyForDate,
} from '../../utils/budgetPeriod.js';
import { DEBT_CATEGORY } from '../../constants.js';

function toNumber(n) {
  const num = Number(n || 0);
  return Number.isNaN(num) ? 0 : num;
}

function ensureScheduleArray(schedule) {
  return Array.isArray(schedule)
    ? schedule.map((q) => ({
        id: q.id || Math.random().toString(36).slice(2, 10),
        periodKey: q.periodKey || '',
        plannedAmount: toNumber(q.plannedAmount),
        paidAmount: toNumber(q.paidAmount),
        dueDate: q.dueDate || '',
        status: q.status || 'pending',
      }))
    : [];
}

function computeQuotaStatus(plannedAmount, paidAmount) {
  const planned = toNumber(plannedAmount);
  const paid = toNumber(paidAmount);
  if (paid >= planned && planned > 0) return 'paid';
  if (paid > 0) return 'partial';
  return 'pending';
}

function addMonthsToDate(dateStr, months) {
  const d = new Date((dateStr || '').replace(/-/g, '/'));
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

function totalDebtPlannedForPeriod(debts, periodKey) {
  return (debts || [])
    .flatMap((d) => ensureScheduleArray(d.schedule))
    .filter((q) => q.periodKey === periodKey)
    .reduce((s, q) => s + toNumber(q.plannedAmount), 0);
}

function totalDebtPaidFromTransactions(transactions, periodKey, cutDay) {
  const { start, end } = getBudgetPeriod(periodKey, cutDay);
  return (transactions || [])
    .filter((t) => t.category === DEBT_CATEGORY)
    .filter((t) => {
      const d = (t.date || t.createdAt || '').slice(0, 10);
      return d >= start && d < end;
    })
    .reduce((s, t) => s + toNumber(t.amount), 0);
}

export function Debts({ data, actions, monthKeyStr }) {
  const debtsRaw = data?.debts || [];
  const budgetCutDay = data?.budgetCutDay || 1;
  const transactions = data?.transactions || [];

  const debts = debtsRaw.map((d) => ({
    ...d,
    id: d.id || Math.random().toString(36).slice(2, 10),
    schedule: ensureScheduleArray(d.schedule),
  }));

  const { addDebt, updateDebt, removeDebt } = actions || {};

  const [form, setForm] = useState({
    name: '',
    original: '',
    remaining: '',
    rateAPR: '',
    firstDue: '',
    installments: '',
    isSubscription: false,
  });

  const [quotaModal, setQuotaModal] = useState(null); // { debtId, quotaId, periodKey, plannedAmount, dueDate }
  const [debtEditModal, setDebtEditModal] = useState(null);

  const currentPeriodKey = useMemo(
    () => monthKeyStr || monthKey(new Date()),
    [monthKeyStr],
  );

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

  function handleFormChange(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function buildSubscriptionSchedule(monthlyAmount, startPeriodKey) {
    const schedule = [];
    const start = startPeriodKey || monthKey();
    for (let i = -1; i <= 18; i += 1) {
      const pk = shiftMonth(start, i);
      const { end } = getBudgetPeriod(pk, budgetCutDay);
      const endDate = new Date(end + 'T00:00:00');
      endDate.setDate(endDate.getDate() - 1);
      schedule.push({
        id: `${Date.now()}-sub-${i}-${Math.random().toString(36).slice(2, 6)}`,
        periodKey: pk,
        dueDate: endDate.toISOString().slice(0, 10),
        plannedAmount: monthlyAmount,
        paidAmount: 0,
        status: 'pending',
      });
    }
    return schedule;
  }

  function buildSchedule(totalRemaining, installments, firstDue) {
    const n = Math.max(1, installments);
    const per = Math.floor(totalRemaining / n);
    const schedule = [];
    let acc = 0;

    for (let i = 0; i < n; i += 1) {
      let planned = per;
      if (i === n - 1) {
        planned = totalRemaining - acc;
      }
      acc += planned;

      const dueDate = addMonthsToDate(firstDue, i);
      const periodKey = budgetMonthKeyForDate(dueDate, budgetCutDay);

      schedule.push({
        id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
        periodKey,
        dueDate,
        plannedAmount: planned,
        paidAmount: 0,
        status: computeQuotaStatus(planned, 0),
      });
    }

    return schedule;
  }

  function handleSaveDebtMeta(e) {
    e.preventDefault();
    if (!debtEditModal || !updateDebt) return;

    const patch = {
      name: (debtEditModal.name || '').trim() || 'Deuda',
      rateAPR:
        debtEditModal.rateAPR !== undefined && debtEditModal.rateAPR !== ''
          ? Number(debtEditModal.rateAPR)
          : undefined,
      due: debtEditModal.due || '',
    };

    updateDebt(debtEditModal.id, patch);
    setDebtEditModal(null);
  }

  async function handleAddDebt(e) {
    e.preventDefault();

    const original = toNumber(form.original);
    if (!original || !addDebt) return;

    const isSubscription = !!form.isSubscription;
    const firstDue = form.firstDue || new Date().toISOString().slice(0, 10);
    const startPeriod = budgetMonthKeyForDate(firstDue, budgetCutDay);

    let remaining = original;
    let installments = Math.max(1, Number(form.installments || 1));
    let schedule;
    let lastQuota;

    if (isSubscription) {
      remaining = original;
      installments = 1;
      schedule = buildSubscriptionSchedule(original, startPeriod);
      lastQuota = schedule[schedule.length - 1];
    } else {
      remaining =
        form.remaining && Number(form.remaining) > 0
          ? Number(form.remaining)
          : original;
      installments = Math.max(1, Number(form.installments || 1));
      schedule = buildSchedule(remaining, installments, firstDue);
      lastQuota = schedule[schedule.length - 1];
    }

    const alreadyPaid = Math.max(0, original - remaining);

    const d = {
      name: form.name || 'Deuda',
      original,
      remaining,
      alreadyPaid,
      rateAPR: toNumber(form.rateAPR),
      due: isSubscription ? null : lastQuota?.dueDate || firstDue,
      createdAt: Date.now(),
      schedule,
      isSubscription,
    };

    await addDebt(d);

    setForm({
      name: '',
      original: '',
      remaining: '',
      rateAPR: '',
      firstDue: '',
      installments: '',
      isSubscription: false,
    });
  }

  function openQuotaModal(debt, quota, defaultPeriodKey) {
    const basePeriodKey =
      quota?.periodKey || defaultPeriodKey || monthKeyStr || monthKey();
    const { end } = getBudgetPeriod(basePeriodKey, budgetCutDay);
    const defaultDueDate = quota?.dueDate || end;

    setQuotaModal({
      debtId: debt.id,
      quotaId: quota?.id || null,
      periodKey: basePeriodKey,
      plannedAmount:
        quota && quota.plannedAmount != null ? String(quota.plannedAmount) : '',
      dueDate: defaultDueDate,
    });
  }

  async function handleSaveQuota(e) {
    e.preventDefault();
    if (!quotaModal || !updateDebt) return;

    const { debtId, quotaId, periodKey, plannedAmount, dueDate } = quotaModal;

    const debt = debts.find((d) => d.id === debtId);
    if (!debt) {
      setQuotaModal(null);
      return;
    }

    const schedule = ensureScheduleArray(debt.schedule);
    const paidInPeriod = totalDebtPaidFromTransactions(
      transactions,
      periodKey,
      budgetCutDay,
    );

    if (quotaId) {
      const idx = schedule.findIndex((q) => q.id === quotaId);
      if (idx !== -1) {
        schedule[idx] = {
          ...schedule[idx],
          periodKey,
          plannedAmount: toNumber(plannedAmount),
          paidAmount: paidInPeriod,
          dueDate,
          status: computeQuotaStatus(plannedAmount, paidInPeriod),
        };
      }
    } else {
      schedule.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        periodKey,
        plannedAmount: toNumber(plannedAmount),
        paidAmount: paidInPeriod,
        dueDate,
        status: computeQuotaStatus(plannedAmount, paidInPeriod),
      });
    }

    const totalPaidFromSchedule = schedule.reduce(
      (sum, q) => sum + toNumber(q.paidAmount),
      0,
    );
    const newRemaining = Math.max(
      0,
      Number(debt.original || 0) - totalPaidFromSchedule,
    );

    await updateDebt(debtId, { schedule, remaining: newRemaining });

    setQuotaModal(null);
  }

  function quotaBoxColor(quota) {
    const status =
      quota?.status ||
      computeQuotaStatus(quota?.plannedAmount, quota?.paidAmount);

    if (status === 'paid') return 'bg-green-600 text-white';
    if (status === 'partial') return 'bg-amber-500 text-white';
    if (status === 'pending') return 'bg-gray-300 text-gray-800';
    return 'bg-gray-100 text-gray-600';
  }

  function quotaTooltip(debt, quota) {
    return `${debt.name || 'Deuda'}\nPlanificado: ${toNumber(
      quota.plannedAmount,
    )}\nPagado: ${toNumber(quota.paidAmount)}\nVence: ${quota.dueDate || '-'}`;
  }

  const summaryPlanned = totalDebtPlannedForPeriod(debts, currentPeriodKey);
  const summaryPaid = totalDebtPaidFromTransactions(
    transactions,
    currentPeriodKey,
    budgetCutDay,
  );
  const summaryPending = Math.max(0, summaryPlanned - summaryPaid);

  function paidAmountForQuota(periodKey) {
    return totalDebtPaidFromTransactions(transactions, periodKey, budgetCutDay);
  }

  function linkedPaidForQuota(quotaId) {
    if (!quotaId) return 0;
    return (transactions || []).reduce((sum, t) => {
      const metaId = t?.meta?.debtQuotaId;
      if (metaId !== quotaId) return sum;
      return sum + toNumber(t.amount);
    }, 0);
  }

  const paidInPeriodForModal =
    quotaModal && quotaModal.periodKey
      ? totalDebtPaidFromTransactions(
          transactions,
          quotaModal.periodKey,
          budgetCutDay,
        )
      : 0;

  const linkedPaidForModal =
    quotaModal && quotaModal.quotaId
      ? linkedPaidForQuota(quotaModal.quotaId)
      : 0;

  const plannedForModal = quotaModal ? toNumber(quotaModal.plannedAmount) : 0;

  const isModalQuotaPaid =
    plannedForModal > 0 && paidInPeriodForModal >= plannedForModal;

  return (
    <div className="grid gap-6 lg:grid-cols-10">
      {/* Formulario izquierda */}
      <Card className="lg:col-span-3 p-5">
        <SectionTitle>Nueva deuda</SectionTitle>
        <form onSubmit={handleAddDebt} className="grid gap-3">
          <input
            className="border rounded-lg p-3 text-sm"
            placeholder="Nombre (ej. Tarjeta, Prestamo)"
            value={form.name}
            onChange={(e) => handleFormChange('name', e.target.value)}
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              className="border rounded-lg p-3 text-sm"
              type="number"
              min={0}
              step="1"
              placeholder="Monto original"
              value={form.original}
              onChange={(e) => handleFormChange('original', e.target.value)}
            />
            <input
              className="border rounded-lg p-3 text-sm"
              type="number"
              min={0}
              step="1"
              placeholder="Saldo pendiente (opcional)"
              value={form.remaining}
              onChange={(e) => handleFormChange('remaining', e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              className="border rounded-lg p-3 text-sm"
              type="number"
              min={1}
              step="1"
              placeholder="Numero de cuotas"
              value={form.installments}
              onChange={(e) => handleFormChange('installments', e.target.value)}
              disabled={form.isSubscription}
            />
            <input
              className="border rounded-lg p-3 text-sm"
              type="date"
              placeholder="Fecha de primer pago"
              value={form.firstDue}
              onChange={(e) => handleFormChange('firstDue', e.target.value)}
              disabled={form.isSubscription}
            />
          </div>
          <input
            className="border rounded-lg p-3 text-sm"
            type="number"
            min={0}
            step="0.01"
            placeholder="Tasa anual % (opcional)"
            value={form.rateAPR}
            onChange={(e) => handleFormChange('rateAPR', e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={form.isSubscription}
              onChange={(e) =>
                handleFormChange('isSubscription', e.target.checked)
              }
            />
            Es suscripcion (se repite mes a mes hasta eliminar)
          </label>
          <button className="px-3 py-3 rounded-xl border bg-gray-900 text-white text-sm font-semibold">
            Agregar deuda
          </button>
        </form>
      </Card>

      {/* Calendario derecha */}
      <Card className="lg:col-span-7 p-5 space-y-4">
        <SectionTitle>Calendario de deudas</SectionTitle>

        {/* Chips estado */}
        <div className="grid grid-cols-3 gap-3">
          <div className="border rounded-xl p-3 bg-gray-50 text-center dark:bg-gray-800 dark:border-gray-700">
            <div className="text-xs text-gray-500 dark:text-gray-300">Planificado</div>
            <div className="text-lg font-semibold">
              <Money n={summaryPlanned} />
            </div>
          </div>
          <div className="border rounded-xl p-3 bg-gray-50 text-center dark:bg-gray-800 dark:border-gray-700">
            <div className="text-xs text-gray-500 dark:text-gray-300">Pagado (Movimientos)</div>
            <div className="text-lg font-semibold">
              <Money n={summaryPaid} />
            </div>
          </div>
          <div className="border rounded-xl p-3 bg-gray-50 text-center dark:bg-gray-800 dark:border-gray-700">
            <div className="text-xs text-gray-500 dark:text-gray-300">Pendiente</div>
            <div className="text-lg font-semibold">
              <Money n={summaryPending} />
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
              title="Deudas: se calculan por fecha de vencimiento/día de corte del periodo."
            >
              Cuotas por periodo
            </div>
            {visiblePeriods.map((pk) => {
              const isActual = pk === trueCurrentPeriod;
              const isSelected = pk === currentPeriodKey;
              return (
                <div
                  key={pk}
                  className={`text-center px-2 py-1 rounded-lg border flex flex-col items-center justify-center gap-1 ${
                    isActual
                      ? 'bg-green-50 text-green-800 border-green-400 dark:bg-green-900/30 dark:text-green-200 dark:border-green-500'
                      : 'border-transparent bg-white dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200'
                  } ${isSelected ? 'ring-1 ring-blue-400' : ''}`}
                >
                  <span>{formatBudgetPeriodLabel(pk, budgetCutDay)}</span>
                  {isSelected && (
                    <span className="text-blue-500 text-[10px] leading-none">
                      v
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Deudas */}
        {debts.length === 0 ? (
          <div className="text-gray-500">Sin deudas registradas.</div>
        ) : (
          <div className="space-y-4">
            {debts.map((d) => {
              const progress =
                d.original > 0
                  ? ((d.original - (d.remaining || 0)) / d.original) * 100
                  : 0;

              return (
                <div
                  key={d.id || d.name + d.due}
                  className="rounded-xl border shadow-sm p-2 space-y-1 bg-white dark:bg-gray-800 dark:border-gray-700"
                >
                  <div className="text-base font-semibold text-gray-900 dark:text-gray-100 px-2">
                    {d.name || 'Deuda'}
                  </div>
                  <div className="pt-2 overflow-x-auto">
                    <div
                      className="grid text-[11px] items-center gap-2 min-w-[520px]"
                      style={{
                        gridTemplateColumns: `160px repeat(${visiblePeriods.length}, minmax(90px, 1fr))`,
                      }}
                    >
                      <div className="text-base font-semibold text-gray-800 px-2">
                        {d.name || 'Cuotas'}
                      </div>
                      {visiblePeriods.map((pk) => {
                        const quota = (d.schedule || []).find(
                          (q) => q.periodKey === pk,
                        );
                        const paid = paidAmountForQuota(pk);

                        if (!quota) {
                          return (
                            <button
                              key={pk}
                              type="button"
                              className="h-10 min-w-[60px] px-2 flex items-center justify-center border border-dashed border-gray-300 rounded-md hover:bg-gray-50"
                              onClick={() => openQuotaModal(d, null, pk)}
                            >
                              <span className="text-[10px] text-gray-400 font-medium">
                                + cuota
                              </span>
                            </button>
                          );
                        }

                        const status = computeQuotaStatus(
                          quota.plannedAmount,
                          paid,
                        );

                        return (
                          <button
                            key={pk}
                            type="button"
                            className="h-10 min-w-[60px] px-2 flex items-center justify-center"
                            onClick={() => openQuotaModal(d, quota, pk)}
                            title={quotaTooltip(d, {
                              ...quota,
                              paidAmount: paid,
                            })}
                          >
                            <div
                              className={`w-full h-full rounded-md flex items-center justify-center ${quotaBoxColor(
                                { ...quota, paidAmount: paid, status },
                              )}`}
                            >
                              <span className="text-[10px] font-semibold truncate px-1">
                                <Money n={quota.plannedAmount} />
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="pt-2 flex justify-center gap-3">
                    <button
                      type="button"
                      className="text-xs px-4 py-2 rounded-lg border text-gray-700 hover:bg-gray-50"
                      onClick={() =>
                        setDebtEditModal({
                          id: d.id,
                          name: d.name || '',
                          rateAPR: d.rateAPR != null ? String(d.rateAPR) : '',
                          due: d.due || '',
                        })
                      }
                    >
                      Editar deuda
                    </button>
                    <button
                      type="button"
                      className="text-xs px-4 py-2 rounded-lg border border-red-500 text-red-600 hover:bg-red-50"
                      onClick={() => removeDebt && removeDebt(d.id)}
                    >
                      Eliminar deuda
                    </button>
                  </div>
                  <div className="pt-1">
                    <div className="text-[11px] text-gray-500 mb-1 text-left flex justify-between items-center">
                      <span>Pagado</span>
                      <span className="text-[11px] text-gray-600">
                        Saldo: <Money n={d.remaining} />
                      </span>
                    </div>
                    <Progress value={progress} mode="good" />
                    <div className="text-[11px] text-gray-600 mt-1 text-right">
                      Pagado: {progress.toFixed(1)}%
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      {/* Modales */}
      {quotaModal && (
        <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/30 pt-16">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl p-5 w-full max-w-md">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">
                {quotaModal.quotaId ? 'Editar cuota' : 'Nueva cuota'}
              </h3>
              <button
                type="button"
                className="text-sm text-gray-500 hover:text-gray-800"
                onClick={() => setQuotaModal(null)}
              >
                x
              </button>
            </div>

            <form onSubmit={handleSaveQuota} className="grid gap-3 text-sm">
              <div className="grid gap-1">
                <label>Periodo</label>
                <select
                  className="border rounded-lg p-2"
                  value={quotaModal.periodKey}
                  onChange={(e) =>
                    setQuotaModal((prev) => ({
                      ...prev,
                      periodKey: e.target.value,
                    }))
                  }
                >
                  {visiblePeriods.map((pk) => (
                    <option key={pk} value={pk}>
                      {formatBudgetPeriodLabel(pk, budgetCutDay)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid gap-1">
                <label>Monto planificado</label>
                <input
                  type="number"
                  min={0}
                  step="1"
                  className="border rounded-lg p-2"
                  value={quotaModal.plannedAmount}
                  onChange={(e) =>
                    setQuotaModal((prev) => ({
                      ...prev,
                      plannedAmount: e.target.value,
                    }))
                  }
                  required
                />
              </div>

              <div className="grid gap-1">
                <label>Pagado (desde Movimientos)</label>
                <div className="border rounded-lg p-2 bg-gray-50 dark:bg-gray-800 text-right">
                  <Money n={paidInPeriodForModal} />
                </div>
                <p className="text-xs text-gray-500">
                  El pago real proviene de las transacciones con categoria{' '}
                  {`"${DEBT_CATEGORY}"`} en el periodo.
                </p>
              </div>

              {quotaModal.quotaId && (
                <div className="grid gap-1">
                  <label>Pagado vinculado a esta cuota</label>
                  <div className="border rounded-lg p-2 bg-gray-50 dark:bg-gray-800 text-right">
                    <Money n={linkedPaidForModal} />
                  </div>
                  <div
                    className={`text-xs font-semibold ${
                      isModalQuotaPaid ? 'text-green-700' : 'text-amber-700'
                    }`}
                  >
                    {isModalQuotaPaid ? 'Pagada' : 'Pendiente por pagar'}
                  </div>
                </div>
              )}

              <div className="grid gap-1">
                <label>Fecha de pago (o vencimiento)</label>
                <input
                  type="date"
                  className="border rounded-lg p-2"
                  value={quotaModal.dueDate}
                  onChange={(e) =>
                    setQuotaModal((prev) => ({
                      ...prev,
                      dueDate: e.target.value,
                    }))
                  }
                />
              </div>

              <div className="flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  className="px-3 py-1.5 text-sm border rounded-lg"
                  onClick={() => setQuotaModal(null)}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-3 py-1.5 text-sm border rounded-lg bg-gray-900 text-white"
                >
                  Guardar cuota
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {debtEditModal && (
        <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/30 pt-16">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl p-5 w-full max-w-md">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">Editar deuda</h3>
              <button
                type="button"
                className="text-sm text-gray-500 hover:text-gray-800"
                onClick={() => setDebtEditModal(null)}
              >
                x
              </button>
            </div>

            <form onSubmit={handleSaveDebtMeta} className="grid gap-3 text-sm">
              <div className="grid gap-1">
                <label>Nombre</label>
                <input
                  className="border rounded-lg p-2"
                  value={debtEditModal.name}
                  onChange={(e) =>
                    setDebtEditModal((prev) => ({
                      ...prev,
                      name: e.target.value,
                    }))
                  }
                />
              </div>

              <div className="grid gap-1">
                <label>Fecha Último vencimiento</label>
                <input
                  type="date"
                  className="border rounded-lg p-2"
                  value={debtEditModal.due || ''}
                  onChange={(e) =>
                    setDebtEditModal((prev) => ({
                      ...prev,
                      due: e.target.value,
                    }))
                  }
                />
              </div>

              <div className="grid gap-1">
                <label>Tasa anual % (opcional)</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  className="border rounded-lg p-2"
                  value={debtEditModal.rateAPR}
                  onChange={(e) =>
                    setDebtEditModal((prev) => ({
                      ...prev,
                      rateAPR: e.target.value,
                    }))
                  }
                />
              </div>

              <div className="flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  className="px-3 py-1.5 text-sm border rounded-lg"
                  onClick={() => setDebtEditModal(null)}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-3 py-1.5 text-sm border rounded-lg bg-gray-900 text-white"
                >
                  Guardar cambios
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
