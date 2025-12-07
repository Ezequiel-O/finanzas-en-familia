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

export function Debts({ data, actions, monthKeyStr }) {
  const debts = data?.debts || [];
  const budgetCutDay = data?.budgetCutDay || 1;

  const { addDebt, updateDebt, removeDebt } = actions || {};

  const [form, setForm] = useState({
    name: '',
    original: '',
    remaining: '',
    rateAPR: '',
    firstDue: '',
    installments: '',
  });

  const [quotaModal, setQuotaModal] = useState(null); // { debtId, quotaId, periodKey, plannedAmount, paidAmount, dueDate }

  const [debtEditModal, setDebtEditModal] = useState(null);

  function openDebtEditModal(debt) {
    setDebtEditModal({
      id: debt.id,
      name: debt.name || '',
      rateAPR: debt.rateAPR != null ? String(debt.rateAPR) : '',
      due: debt.due || '',
    });
  }

  async function handleSaveDebtMeta(e) {
    e.preventDefault();
    if (!debtEditModal || !updateDebt) return;

    const { id, name, rateAPR, due } = debtEditModal;

    await updateDebt(id, {
      name: name || 'Deuda',
      rateAPR: rateAPR !== '' ? Number(rateAPR) : 0,
      due: due || null,
    });

    setDebtEditModal(null);
  }

  // clave del período actual basada en HOY
  const currentPeriodKey = useMemo(
    () => monthKeyStr || monthKey(new Date()),
    [monthKeyStr],
  );

  const visiblePeriods = useMemo(() => {
    const center = currentPeriodKey;
    const arr = [];
    // solo 6 periodos: 2 antes, 3 después
    for (let delta = -2; delta <= 3; delta += 1) {
      arr.push(shiftMonth(center, delta));
    }
    return arr;
  }, [currentPeriodKey]);

  function handleFormChange(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
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

  async function handleAddDebt(e) {
    e.preventDefault();

    const original = Number(form.original || 0);
    if (!original || !addDebt) return;

    const remaining =
      form.remaining && Number(form.remaining) > 0
        ? Number(form.remaining)
        : original;

    const alreadyPaid = Math.max(0, original - remaining);
    const installments = Math.max(1, Number(form.installments || 1));
    const firstDue = form.firstDue || new Date().toISOString().slice(0, 10);

    const schedule = buildSchedule(remaining, installments, firstDue);
    const lastQuota = schedule[schedule.length - 1];

    const d = {
      name: form.name || 'Deuda',
      original,
      remaining,
      alreadyPaid,
      rateAPR: Number(form.rateAPR || 0),
      due: lastQuota?.dueDate || firstDue,
      createdAt: Date.now(),
      schedule,
    };

    await addDebt(d);

    setForm({
      name: '',
      original: '',
      remaining: '',
      rateAPR: '',
      firstDue: '',
      installments: '',
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
      paidAmount:
        quota && quota.paidAmount != null ? String(quota.paidAmount) : '',
      dueDate: defaultDueDate,
    });
  }

  async function handleSaveQuota(e) {
    e.preventDefault();
    if (!quotaModal || !updateDebt) return;

    const { debtId, quotaId, periodKey, plannedAmount, paidAmount, dueDate } =
      quotaModal;

    const debt = debts.find((d) => d.id === debtId);
    if (!debt) {
      setQuotaModal(null);
      return;
    }

    const schedule = Array.isArray(debt.schedule) ? [...debt.schedule] : [];

    if (quotaId) {
      const idx = schedule.findIndex((q) => q.id === quotaId);
      if (idx !== -1) {
        schedule[idx] = {
          ...schedule[idx],
          periodKey,
          plannedAmount: Number(plannedAmount || 0),
          paidAmount: Number(paidAmount || 0),
          dueDate,
          status: computeQuotaStatus(plannedAmount, paidAmount),
        };
      }
    } else {
      schedule.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        periodKey,
        plannedAmount: Number(plannedAmount || 0),
        paidAmount: Number(paidAmount || 0),
        dueDate,
        status: computeQuotaStatus(plannedAmount, paidAmount),
      });
    }

    const totalPaidFromSchedule = schedule.reduce(
      (sum, q) => sum + Number(q.paidAmount || 0),
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

  function totalPlannedForPeriod(periodKey) {
    return debts
      .flatMap((d) => (Array.isArray(d.schedule) ? d.schedule : []))
      .filter((q) => q.periodKey === periodKey)
      .reduce((sum, q) => sum + Number(q.plannedAmount || 0), 0);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card>
        <SectionTitle>Nueva deuda</SectionTitle>
        <form onSubmit={handleAddDebt} className="grid gap-3">
          <input
            className="border rounded-lg p-2"
            placeholder="Nombre (ej. Tarjeta, Préstamo)"
            value={form.name}
            onChange={(e) => handleFormChange('name', e.target.value)}
          />
          <input
            className="border rounded-lg p-2"
            type="number"
            min={0}
            step="1"
            placeholder="Monto original (total)"
            value={form.original}
            onChange={(e) => handleFormChange('original', e.target.value)}
          />
          <input
            className="border rounded-lg p-2"
            type="number"
            min={0}
            step="1"
            placeholder="Saldo pendiente (opcional)"
            value={form.remaining}
            onChange={(e) => handleFormChange('remaining', e.target.value)}
          />
          <input
            className="border rounded-lg p-2"
            type="number"
            min={1}
            step="1"
            placeholder="Número de cuotas"
            value={form.installments}
            onChange={(e) => handleFormChange('installments', e.target.value)}
          />
          <input
            className="border rounded-lg p-2"
            type="date"
            placeholder="Fecha de primer pago"
            value={form.firstDue}
            onChange={(e) => handleFormChange('firstDue', e.target.value)}
          />
          <input
            className="border rounded-lg p-2"
            type="number"
            min={0}
            step="0.01"
            placeholder="Tasa anual % (opcional)"
            value={form.rateAPR}
            onChange={(e) => handleFormChange('rateAPR', e.target.value)}
          />

          <button className="px-3 py-2 rounded-xl border bg-gray-900 text-white">
            Agregar deuda
          </button>
        </form>
      </Card>

      <Card className="lg:col-span-2">
        <SectionTitle
          right={
            <div className="flex flex-col items-end text-xs gap-1">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1">
                  <span className="w-4 h-3 rounded bg-gray-300" />
                  <span>Pendiente</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="w-4 h-3 rounded bg-amber-500" />
                  <span>Pago parcial</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="w-4 h-3 rounded bg-green-600" />
                  <span>Pagado</span>
                </div>
              </div>
              <div className="text-[11px] text-gray-500">
                Total cuotas planificadas este período:{' '}
                <Money n={totalPlannedForPeriod(monthKeyStr)} />
              </div>
            </div>
          }
        >
          Calendario de deudas
        </SectionTitle>

        {debts.length === 0 ? (
          <div className="text-gray-500">Sin deudas registradas.</div>
        ) : (
          <div>
            <div className="min-w-full space-y-3">
              {/* Encabezado de periodos */}
              <div
                className="grid text-xs font-medium text-gray-600 mb-1"
                style={{
                  gridTemplateColumns: `180px repeat(${visiblePeriods.length}, minmax(90px, 1fr))`,
                }}
              >
                <div />
                {visiblePeriods.map((pk) => {
                  const isCurrent = pk === currentPeriodKey;
                  return (
                    <div
                      key={pk}
                      className={
                        'text-center px-1 rounded-lg ' +
                        (isCurrent
                          ? 'bg-green-100 text-green-800 font-semibold border border-green-400'
                          : '')
                      }
                    >
                      {formatBudgetPeriodLabel(pk, budgetCutDay)}
                    </div>
                  );
                })}
              </div>

              {/* Filas por deuda */}
              {debts.map((d) => {
                const progress =
                  d.original > 0
                    ? ((d.original - (d.remaining || 0)) / d.original) * 100
                    : 0;

                return (
                  <div
                    key={d.id || d.name + d.due}
                    className="border rounded-xl p-3"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <div className="font-medium">{d.name}</div>
                        <div className="text-sm text-gray-600">
                          Saldo: <Money n={d.remaining} /> / Original:{' '}
                          <Money n={d.original} />
                        </div>
                        <div className="text-xs text-gray-500">
                          {d.rateAPR ? `Tasa: ${d.rateAPR}%` : ''}{' '}
                          {d.due ? `· Último vencimiento: ${d.due}` : ''}
                        </div>
                      </div>
                      <div className="w-56">
                        <Progress value={progress} mode="good" />
                        <div className="text-xs text-gray-600 mt-1">
                          Pagado: {progress.toFixed(1)}%
                        </div>
                      </div>
                    </div>

                    <div
                      className="grid text-xs items-center"
                      style={{
                        gridTemplateColumns: `180px repeat(${visiblePeriods.length}, minmax(90px, 1fr))`,
                      }}
                    >
                      <div className="text-xs text-gray-500">Cuotas</div>
                      {visiblePeriods.map((pk) => {
                        const quota = (d.schedule || []).find(
                          (q) => q.periodKey === pk,
                        );

                        if (!quota) {
                          return (
                            <button
                              key={pk}
                              type="button"
                              className="h-7 flex items-center justify-center border border-dashed border-gray-300 rounded hover:bg-gray-50"
                              onClick={() => openQuotaModal(d, null, pk)}
                            >
                              <span className="text-[10px] text-gray-400">
                                + cuota
                              </span>
                            </button>
                          );
                        }

                        return (
                          <button
                            key={pk}
                            type="button"
                            className="h-7 flex items-center justify-center"
                            onClick={() => openQuotaModal(d, quota, pk)}
                          >
                            <div
                              className={`w-full h-6 rounded flex items-center justify-center ${quotaBoxColor(
                                quota,
                              )}`}
                            >
                              <span className="text-[10px] truncate px-1">
                                <Money n={quota.plannedAmount} />
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    <div className="mt-3 flex justify-center gap-3">
                      <button
                        type="button"
                        className="text-xs px-3 py-1.5 rounded-lg border text-gray-700 hover:bg-gray-50"
                        onClick={() => openDebtEditModal(d)}
                      >
                        Editar deuda
                      </button>
                      <button
                        type="button"
                        className="text-xs px-3 py-1.5 rounded-lg border border-red-500 text-red-600 hover:bg-red-50"
                        onClick={() => removeDebt && removeDebt(d.id)}
                      >
                        Eliminar deuda
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Card>

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
                ✕
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
                />
              </div>

              <div className="grid gap-1">
                <label>Monto pagado (acumulado en el período)</label>
                <input
                  type="number"
                  min={0}
                  step="1"
                  className="border rounded-lg p-2"
                  value={quotaModal.paidAmount}
                  onChange={(e) =>
                    setQuotaModal((prev) => ({
                      ...prev,
                      paidAmount: e.target.value,
                    }))
                  }
                />
              </div>

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
                ✕
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
                <label>Fecha último vencimiento</label>
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
