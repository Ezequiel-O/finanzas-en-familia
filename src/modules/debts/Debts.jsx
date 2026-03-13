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
  const safeTotal = Math.round(toNumber(amount));
  if (!safeIds.length || safeTotal <= 0) return null;
  if (safeIds.length === 1) return { [safeIds[0]]: safeTotal };

  const rawAlloc = meta?.debtQuotaAmounts || meta?.debtQuotaAllocations || null;
  if (rawAlloc && typeof rawAlloc === 'object') {
    const weights = {};
    if (Array.isArray(rawAlloc)) {
      rawAlloc.forEach((item) => {
        if (!item || !item.id) return;
        weights[String(item.id)] = toNumber(item.amount);
      });
    } else {
      Object.entries(rawAlloc).forEach(([key, value]) => {
        const safeKey = String(key || '').trim();
        if (!safeKey) return;
        weights[safeKey] = toNumber(value);
      });
    }
    const entries = safeIds.map((id) => ({
      id,
      weight: Math.max(toNumber(weights[id]), 0),
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

function monthIndexFromKey(key) {
  const [y, m] = String(key || '')
    .split('-')
    .map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return 0;
  return y * 12 + (m - 1);
}

function allocatePlannedAcrossQuotas(totalPlanned, quotas) {
  const safeTotal = Math.max(0, Math.round(toNumber(totalPlanned)));
  if (!Array.isArray(quotas) || quotas.length === 0) return {};
  const weights = quotas.map((q) => Math.max(0, toNumber(q.plannedAmount)));
  let weightSum = weights.reduce((sum, w) => sum + w, 0);
  if (weightSum <= 0) {
    weightSum = quotas.length;
    for (let i = 0; i < weights.length; i += 1) weights[i] = 1;
  }
  const raw = weights.map((w) => (w / weightSum) * safeTotal);
  const floors = raw.map((value, idx) => ({
    id: quotas[idx].id,
    value: Math.floor(value),
    frac: value - Math.floor(value),
  }));
  let remainder = safeTotal - floors.reduce((sum, item) => sum + item.value, 0);
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
  const debtsActive = useMemo(() => debts.filter((d) => !d.archived), [debts]);
  const cardOptions = useMemo(() => {
    const unique = new Set();
    debts.forEach((debt) => {
      const name = String(debt.cardName || '').trim();
      if (name) unique.add(name);
    });
    return Array.from(unique).sort((a, b) =>
      a.localeCompare(b, 'es', { sensitivity: 'base' }),
    );
  }, [debts]);

  const { addDebt, updateDebt, removeDebt } = actions || {};

  const [form, setForm] = useState({
    name: '',
    cardName: '',
    chargeDay: '',
    original: '',
    remaining: '',
    rateAPR: '',
    firstDue: '',
    installments: '',
    isSubscription: false,
  });

  const [quotaModal, setQuotaModal] = useState(null); // { debtId, quotaId, periodKey, plannedAmount, dueDate }
  const [debtEditModal, setDebtEditModal] = useState(null);
  const [hidePaidDebts, setHidePaidDebts] = useState(true);
  const [showAddDebtModal, setShowAddDebtModal] = useState(false);

  const currentPeriodKey = useMemo(
    () => monthKeyStr || monthKey(new Date()),
    [monthKeyStr],
  );

  const trueCurrentPeriod = useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    return budgetMonthKeyForDate(todayStr, budgetCutDay);
  }, [budgetCutDay]);

  const visiblePeriods = useMemo(() => {
    return [
      shiftMonth(currentPeriodKey, -2),
      shiftMonth(currentPeriodKey, -1),
      currentPeriodKey,
      shiftMonth(currentPeriodKey, 1),
      shiftMonth(currentPeriodKey, 2),
    ];
  }, [currentPeriodKey]);
  const periodVisibilityClass = (index) => {
    if (index === 1 || index === 2) return '';
    if (index === 3) return 'hidden md:table-cell';
    if (index === 4) return 'hidden lg:table-cell';
    return 'hidden xl:table-cell';
  };

  function handleRemoveDebt(debt) {
    if (!removeDebt || !debt?.id) return;
    const name = String(debt.name || '').trim();
    const label = name ? ` "${name}"` : '';
    const ok = window.confirm(
      `Eliminar deuda${label}? Se movera a la papelera para poder recuperarla.`,
    );
    if (!ok) return;
    removeDebt(debt.id);
  }

  async function handleArchiveDebt(debt) {
    if (!updateDebt || !debt?.id) return;
    const name = String(debt.name || '').trim();
    const label = name ? ` "${name}"` : '';
    const ok = window.confirm(
      `Archivar deuda${label}? Se ocultara del listado principal.`,
    );
    if (!ok) return;
    await updateDebt(debt.id, {
      archived: true,
      archivedAt: new Date().toISOString(),
    });
  }

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
    const debt = debts.find((d) => d.id === debtEditModal.id);

    const patch = {
      name: (debtEditModal.name || '').trim() || 'Deuda',
      cardName: (debtEditModal.cardName || '').trim(),
      chargeDay: (() => {
        const parsed = Number(debtEditModal.chargeDay);
        if (!Number.isFinite(parsed)) return null;
        if (parsed < 1 || parsed > 31) return null;
        return Math.round(parsed);
      })(),
      rateAPR:
        debtEditModal.rateAPR !== undefined && debtEditModal.rateAPR !== ''
          ? Number(debtEditModal.rateAPR)
          : undefined,
      due: debtEditModal.due || '',
    };

    if (debtEditModal.isSubscription) {
      const prevActive = debt?.subscriptionActive !== false;
      const subscriptionActive = debtEditModal.subscriptionActive !== false;
      const resumeDate = String(
        debtEditModal.subscriptionResumeDate || '',
      ).trim();
      const monthlyAmount = toNumber(debt?.original);

      if (subscriptionActive && !prevActive && !resumeDate) {
        window.alert(
          'Selecciona la fecha desde la que quieres reactivar el cobro.',
        );
        return;
      }

      patch.subscriptionActive = subscriptionActive;
      patch.subscriptionResumeDate = subscriptionActive ? resumeDate || '' : '';

      const schedule = ensureScheduleArray(debt?.schedule || []);
      let updatedSchedule = schedule;

      if (!subscriptionActive) {
        updatedSchedule = schedule.map((quota) => {
          const periodKey = resolveQuotaPeriodKey(quota);
          if (periodKey && periodKey > trueCurrentPeriod) {
            return {
              ...quota,
              plannedAmount: 0,
              status: computeQuotaStatus(0, toNumber(quota.paidAmount)),
            };
          }
          return quota;
        });
      } else if (!prevActive && resumeDate) {
        const resumePeriodKey = budgetMonthKeyForDate(resumeDate, budgetCutDay);
        const resumeIndex = monthIndexFromKey(resumePeriodKey);
        updatedSchedule = schedule.map((quota) => {
          const periodKey = resolveQuotaPeriodKey(quota);
          if (periodKey && periodKey >= resumePeriodKey) {
            const diff = monthIndexFromKey(periodKey) - resumeIndex;
            return {
              ...quota,
              plannedAmount: monthlyAmount,
              dueDate: addMonthsToDate(resumeDate, diff),
              status: computeQuotaStatus(
                monthlyAmount,
                toNumber(quota.paidAmount),
              ),
            };
          }
          return quota;
        });
      }

      patch.schedule = updatedSchedule;
    }

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
      cardName: (form.cardName || '').trim(),
      chargeDay: (() => {
        const parsed = Number(form.chargeDay);
        if (!Number.isFinite(parsed)) return null;
        if (parsed < 1 || parsed > 31) return null;
        return Math.round(parsed);
      })(),
      original,
      remaining,
      alreadyPaid,
      rateAPR: toNumber(form.rateAPR),
      due: isSubscription ? null : lastQuota?.dueDate || firstDue,
      createdAt: Date.now(),
      schedule,
      isSubscription,
      subscriptionActive: isSubscription ? true : undefined,
      subscriptionResumeDate: isSubscription ? '' : undefined,
    };

    await addDebt(d);

    setForm({
      name: '',
      cardName: '',
      chargeDay: '',
      original: '',
      remaining: '',
      rateAPR: '',
      firstDue: '',
      installments: '',
      isSubscription: false,
    });
  }

  async function handleAddDebtFromModal(e) {
    e.preventDefault();
    const original = toNumber(form.original);
    if (!original || !addDebt) return;
    await handleAddDebt(e);
    setShowAddDebtModal(false);
  }

  function renderDebtForm({ onSubmit, dateInputType, submitLabel }) {
    const datePlaceholder =
      dateInputType === 'text'
        ? 'Fecha de primer pago (YYYY-MM-DD)'
        : 'Fecha de primer pago';
    return (
      <form onSubmit={onSubmit} className="grid gap-3">
        <input
          className="border rounded-lg p-3 text-sm"
          placeholder="Nombre (ej. Subsicripcion, Prestamo)"
          value={form.name}
          onChange={(e) => handleFormChange('name', e.target.value)}
        />
        <input
          className="border rounded-lg p-3 text-sm"
          placeholder="Nombre de tarjeta (opcional)"
          value={form.cardName}
          list="cardNameOptions"
          onChange={(e) => handleFormChange('cardName', e.target.value)}
        />
        <input
          className="border rounded-lg p-3 text-sm"
          type="number"
          min={1}
          max={31}
          step="1"
          placeholder="Dia de cobro (1-31, opcional)"
          value={form.chargeDay}
          onChange={(e) => handleFormChange('chargeDay', e.target.value)}
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
            type={dateInputType}
            placeholder={datePlaceholder}
            value={form.firstDue}
            onChange={(e) => handleFormChange('firstDue', e.target.value)}
            disabled={form.isSubscription}
            inputMode={dateInputType === 'text' ? 'text' : undefined}
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
        <label className="flex items-center gap-2 text-sm text-[color:var(--text-muted)]">
          <input
            type="checkbox"
            checked={form.isSubscription}
            onChange={(e) =>
              handleFormChange('isSubscription', e.target.checked)
            }
          />
          Es suscripcion (se repite mes a mes hasta eliminar)
        </label>
        <button className="px-3 py-3 rounded-xl border bg-[color:var(--primary)] text-[color:var(--primary-contrast)] text-sm font-semibold">
          {submitLabel}
        </button>
      </form>
    );
  }

  function openQuotaModal(debt, quota, defaultPeriodKey) {
    const basePeriodKey =
      quota?.periodKey || defaultPeriodKey || monthKeyStr || monthKey();
    const { end } = getBudgetPeriod(basePeriodKey, budgetCutDay);
    const schedule = ensureScheduleArray(debt.schedule);
    const periodQuotas = schedule.filter(
      (q) => resolveQuotaPeriodKey(q) === basePeriodKey,
    );
    const plannedTotalForPeriod = periodQuotas.reduce(
      (sum, q) => sum + toNumber(q.plannedAmount),
      0,
    );
    const fallbackQuota = quota || periodQuotas[0] || null;
    const defaultDueDate = fallbackQuota?.dueDate || end;

    setQuotaModal({
      debtId: debt.id,
      quotaId: fallbackQuota?.id || null,
      quotaIds: periodQuotas.length > 1 ? periodQuotas.map((q) => q.id) : [],
      periodKey: basePeriodKey,
      plannedAmount:
        periodQuotas.length > 0
          ? String(plannedTotalForPeriod)
          : fallbackQuota && fallbackQuota.plannedAmount != null
            ? String(fallbackQuota.plannedAmount)
            : '',
      dueDate: defaultDueDate,
    });
  }

  async function handleSaveQuota(e) {
    e.preventDefault();
    if (!quotaModal || !updateDebt) return;

    const { debtId, quotaId, quotaIds, periodKey, plannedAmount, dueDate } =
      quotaModal;

    const debt = debts.find((d) => d.id === debtId);
    if (!debt) {
      setQuotaModal(null);
      return;
    }

    let schedule = ensureScheduleArray(debt.schedule);
    const multiIds =
      Array.isArray(quotaIds) && quotaIds.length > 1 ? quotaIds : [];

    if (multiIds.length > 1) {
      const targetQuotas = schedule.filter((q) => multiIds.includes(q.id));
      const allocations = allocatePlannedAcrossQuotas(
        plannedAmount,
        targetQuotas,
      );
      schedule = schedule.map((q) => {
        if (!multiIds.includes(q.id)) return q;
        const allocation = allocations[q.id] ?? 0;
        const paidLinked = linkedPaidForQuota(q.id, debtId);
        return {
          ...q,
          periodKey,
          plannedAmount: allocation,
          paidAmount: paidLinked,
          dueDate,
          status: computeQuotaStatus(allocation, paidLinked),
        };
      });
    } else if (quotaId) {
      const paidLinked = linkedPaidForQuota(quotaId, debtId);
      const idx = schedule.findIndex((q) => q.id === quotaId);
      if (idx !== -1) {
        schedule[idx] = {
          ...schedule[idx],
          periodKey,
          plannedAmount: toNumber(plannedAmount),
          paidAmount: paidLinked,
          dueDate,
          status: computeQuotaStatus(plannedAmount, paidLinked),
        };
      }
    } else {
      const paidLinked = 0;
      schedule.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        periodKey,
        plannedAmount: toNumber(plannedAmount),
        paidAmount: paidLinked,
        dueDate,
        status: computeQuotaStatus(plannedAmount, paidLinked),
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

  function quotaTooltip(debt, quota) {
    const paid = paidForQuota(quota, debt.id);
    return `${debt.name || 'Deuda'} | Planificado: ${toNumber(quota.plannedAmount)} | Pagado: ${paid} | Vence: ${quota.dueDate || '-'}`;
  }

  const linkedPaidByQuotaId = useMemo(() => {
    const byQuotaId = {};
    const byDebtQuotaKey = {};
    let hasLinked = false;
    (transactions || []).forEach((t) => {
      const subcatLabel = String(t?.meta?.budgetSubcategoryName || '')
        .trim()
        .toLowerCase();
      const subcatNames = String(
        t?.meta?.budgetSubcategoryNames || '',
      ).toLowerCase();
      if (
        subcatLabel === 'pago de deudas' ||
        subcatNames.includes('pago de deudas')
      ) {
        return;
      }
      const meta = t?.meta || {};
      const ids = extractDebtQuotaIds(meta);
      if (!ids.length) return;
      const amt = toNumber(t.amount);
      if (!amt) return;
      const allocationMap = buildDebtQuotaAllocationMap({
        ids,
        amount: amt,
        meta,
      });
      const debtIdMap =
        meta.debtQuotaDebtIds && typeof meta.debtQuotaDebtIds === 'object'
          ? meta.debtQuotaDebtIds
          : null;
      ids.forEach((quotaId) => {
        const allocation = allocationMap?.[quotaId] || 0;
        if (!allocation) return;
        hasLinked = true;
        const debtId = debtIdMap?.[quotaId] || meta.debtId;
        if (debtId) {
          const key = `${debtId}::${quotaId}`;
          byDebtQuotaKey[key] = (byDebtQuotaKey[key] || 0) + allocation;
          return;
        }
        byQuotaId[quotaId] = (byQuotaId[quotaId] || 0) + allocation;
      });
    });
    return { byQuotaId, byDebtQuotaKey, hasLinked };
  }, [transactions]);

  function linkedPaidForQuota(quotaId, debtId) {
    if (!quotaId) return 0;
    if (debtId) {
      const key = `${debtId}::${quotaId}`;
      if (
        Object.prototype.hasOwnProperty.call(
          linkedPaidByQuotaId.byDebtQuotaKey,
          key,
        )
      ) {
        return linkedPaidByQuotaId.byDebtQuotaKey[key];
      }
    }
    return linkedPaidByQuotaId.byQuotaId[quotaId] ?? 0;
  }

  function paidForQuota(quota, debtId) {
    if (!quota) return 0;
    const quotaId = quota.id;
    if (!quotaId) return 0;
    if (debtId) {
      const key = `${debtId}::${quotaId}`;
      if (
        Object.prototype.hasOwnProperty.call(
          linkedPaidByQuotaId.byDebtQuotaKey,
          key,
        )
      ) {
        return linkedPaidByQuotaId.byDebtQuotaKey[key];
      }
    }
    if (
      Object.prototype.hasOwnProperty.call(
        linkedPaidByQuotaId.byQuotaId,
        quotaId,
      )
    ) {
      return linkedPaidByQuotaId.byQuotaId[quotaId];
    }
    return 0;
  }

  function resolveQuotaPeriodKey(quota) {
    if (quota?.periodKey) return quota.periodKey;
    if (quota?.dueDate) {
      return budgetMonthKeyForDate(quota.dueDate, budgetCutDay);
    }
    return '';
  }

  const summaryPlanned = totalDebtPlannedForPeriod(
    debtsActive,
    currentPeriodKey,
  );
  const summaryPaid = totalDebtPaidFromTransactions(
    transactions,
    currentPeriodKey,
    budgetCutDay,
  );
  const summaryPending = debtsActive.reduce((sum, debt) => {
    const schedule = Array.isArray(debt.schedule) ? debt.schedule : [];
    if (!schedule.length) return sum;
    const debtId = debt.id;
    const pending = schedule.reduce((acc, quota) => {
      const planned = toNumber(quota.plannedAmount);
      if (planned <= 0) return acc;
      const periodKey = resolveQuotaPeriodKey(quota);
      if (!periodKey || periodKey > currentPeriodKey) return acc;
      const paid = paidForQuota(quota, debtId);
      const remaining = planned - paid;
      return remaining > 0 ? acc + remaining : acc;
    }, 0);
    return sum + pending;
  }, 0);

  const plannedTotalsByPeriod = useMemo(() => {
    const totals = {};
    visiblePeriods.forEach((periodKey) => {
      totals[periodKey] = totalDebtPlannedForPeriod(debtsActive, periodKey);
    });
    return totals;
  }, [debtsActive, visiblePeriods]);

  const shouldHighlightPeriod = (periodKey) => {
    if (periodKey !== currentPeriodKey) return false;
    const plannedTotal = plannedTotalsByPeriod[periodKey] || 0;
    return Math.abs(plannedTotal - summaryPlanned) < 0.5;
  };

  const todayStr = new Date().toISOString().slice(0, 10);

  function resolveDueDate(quota, periodKey) {
    if (quota?.dueDate) return quota.dueDate;
    if (!periodKey) return '';
    const { end } = getBudgetPeriod(periodKey, budgetCutDay);
    const endDate = new Date(end + 'T00:00:00');
    endDate.setDate(endDate.getDate() - 1);
    return endDate.toISOString().slice(0, 10);
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
    quotaModal &&
    Array.isArray(quotaModal.quotaIds) &&
    quotaModal.quotaIds.length
      ? quotaModal.quotaIds.reduce(
          (sum, id) => sum + linkedPaidForQuota(id, quotaModal.debtId),
          0,
        )
      : quotaModal && quotaModal.quotaId
        ? linkedPaidForQuota(quotaModal.quotaId, quotaModal.debtId)
        : 0;

  const plannedForModal = quotaModal ? toNumber(quotaModal.plannedAmount) : 0;

  const isModalQuotaPaid =
    plannedForModal > 0 && linkedPaidForModal >= plannedForModal;

  const visibleDebts = debtsActive.filter((d) => {
    if (!hidePaidDebts) return true;
    if (d.isSubscription) return true;
    const schedule = Array.isArray(d.schedule) ? d.schedule : [];
    const totalOriginal = toNumber(d.original);
    const plannedTotal = schedule.reduce(
      (sum, q) => sum + toNumber(q.plannedAmount),
      0,
    );
    const totalDebt = Math.max(totalOriginal, plannedTotal);
    if (totalDebt <= 0) return true;
    const basePaid = toNumber(d.alreadyPaid);
    const paidFromSchedule = schedule.reduce(
      (sum, q) => sum + paidForQuota(q, d.id),
      0,
    );
    const totalPaid = basePaid + paidFromSchedule;
    const isPaidOff = totalPaid >= totalDebt;
    return !isPaidOff;
  });

  const cardSummary = useMemo(() => {
    const summary = new Map();
    debtsActive.forEach((debt) => {
      const cardName = String(debt.cardName || '').trim() || 'Sin tarjeta';
      const schedule = Array.isArray(debt.schedule) ? debt.schedule : [];
      const quotas = schedule.filter(
        (q) => resolveQuotaPeriodKey(q) === currentPeriodKey,
      );
      if (!quotas.length) return;
      quotas.forEach((quota) => {
        const planned = toNumber(quota.plannedAmount);
        if (planned <= 0) return;
        const paid = paidForQuota(quota, debt.id);
        const pending = Math.max(planned - paid, 0);
        const entry = summary.get(cardName) || {
          planned: 0,
          paid: 0,
          pending: 0,
        };
        entry.planned += planned;
        entry.paid += paid;
        entry.pending += pending;
        summary.set(cardName, entry);
      });
    });
    return Array.from(summary.entries())
      .map(([name, values]) => ({ name, ...values }))
      .sort((a, b) => b.pending - a.pending);
  }, [debtsActive, currentPeriodKey]);

  return (
    <>
      <datalist id="cardNameOptions">
        {cardOptions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <div className="md:hidden mb-4">
        <button
          type="button"
          className="w-full px-4 py-3 rounded-xl border bg-[color:var(--primary)] text-[color:var(--primary-contrast)] text-sm font-semibold"
          onClick={() => setShowAddDebtModal(true)}
        >
          Agregar Deuda
        </button>
      </div>
      <div className="grid gap-6 w-full lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        {/* Formulario izquierda */}
        <Card className="p-5 hidden md:block">
          <SectionTitle>Nueva deuda</SectionTitle>
          {renderDebtForm({
            onSubmit: handleAddDebt,
            dateInputType: 'date',
            submitLabel: 'Agregar deuda',
          })}
        </Card>

        {/* Calendario derecha */}
        <Card className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <SectionTitle>Calendario de deudas</SectionTitle>
            <button
              type="button"
              className="text-xs font-semibold px-3 py-1.5 rounded-full border border-[color:var(--border)] text-[color:var(--text)] hover:bg-[color:var(--surface-2)]"
              onClick={() => setHidePaidDebts((prev) => !prev)}
            >
              <span className="inline-flex items-center gap-2">
                {hidePaidDebts ? (
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
                    <path d="M3 3l18 18" />
                    <path d="M9.88 9.88A3 3 0 0 0 12 15a3 3 0 0 0 2.12-.88" />
                    <path d="M5.88 5.88C4.1 7.24 2.75 9.2 2.036 11.678a1 1 0 0 0 0 .644C3.423 16.49 7.36 19.5 12 19.5c1.68 0 3.29-.41 4.72-1.14" />
                    <path d="M10.73 5.08A10.95 10.95 0 0 1 12 4.5c4.639 0 8.576 3.01 9.964 7.178a1 1 0 0 1 0 .644 11.1 11.1 0 0 1-1.67 3.03" />
                  </svg>
                ) : (
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
                    <path d="M2.036 12.322a1 1 0 0 1 0-.644C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.576 3.01 9.964 7.178a1 1 0 0 1 0 .644C20.576 16.49 16.639 19.5 12 19.5c-4.638 0-8.576-3.01-9.964-7.178Z" />
                    <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                  </svg>
                )}
                <span>
                  {hidePaidDebts ? 'Mostrar pagados' : 'Ocultar pagados'}
                </span>
              </span>
            </button>
          </div>

          {/* Chips estado */}
          <div className="grid grid-cols-3 gap-3">
            <div className="border rounded-xl p-3 bg-[color:var(--surface-2)] text-center  ">
              <div className="text-xs text-[color:var(--text-muted)]">
                Planificado
              </div>
              <div className="text-lg font-semibold">
                <Money n={summaryPlanned} />
              </div>
            </div>
            <div className="border rounded-xl p-3 bg-[color:var(--surface-2)] text-center  ">
              <div className="text-xs text-[color:var(--text-muted)]">
                Pagado (Movimientos)
              </div>
              <div className="text-lg font-semibold">
                <Money n={summaryPaid} />
              </div>
            </div>
            <div className="border rounded-xl p-3 bg-[color:var(--danger)]/20 text-center border-[color:var(--danger)]  ">
              <div className="text-xs text-[color:var(--danger)] ">
                Pendiente
              </div>
              <div className="text-lg font-semibold text-[color:var(--danger)] ">
                <Money n={summaryPending} />
              </div>
            </div>
          </div>

          {cardSummary.length > 0 && (
            <div className="grid gap-2">
              <div className="text-xs font-semibold text-[color:var(--text-muted)]">
                Resumen por tarjeta (
                {formatBudgetPeriodLabel(currentPeriodKey, budgetCutDay)})
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {cardSummary.map((card) => (
                  <div
                    key={card.name}
                    className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-2)] p-3"
                  >
                    <div className="text-sm font-semibold">{card.name}</div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <div className="text-[color:var(--text-muted)]">
                          Planificado
                        </div>
                        <div className="font-semibold">
                          <Money n={card.planned} />
                        </div>
                      </div>
                      <div>
                        <div className="text-[color:var(--text-muted)]">
                          Pagado
                        </div>
                        <div className="font-semibold">
                          <Money n={card.paid} />
                        </div>
                      </div>
                      <div>
                        <div className="text-[color:var(--text-muted)]">
                          Pendiente
                        </div>
                        <div className="font-semibold text-[color:var(--danger)]">
                          <Money n={card.pending} />
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Deudas */}
          {debtsActive.length === 0 ? (
            <div className="text-[color:var(--text-muted)]">
              Sin deudas registradas.
            </div>
          ) : (
            <>
              <div className="md:hidden space-y-3">
                {visibleDebts.map((d) => {
                  const schedule = Array.isArray(d.schedule) ? d.schedule : [];
                  const isSubscription = !!d.isSubscription;
                  const totalOriginal = toNumber(d.original);
                  const plannedTotal = schedule.reduce(
                    (sum, q) => sum + toNumber(q.plannedAmount),
                    0,
                  );
                  const totalDebt = isSubscription
                    ? totalOriginal
                    : Math.max(totalOriginal, plannedTotal);
                  const basePaid = toNumber(d.alreadyPaid);
                  const paidFromSchedule = schedule.reduce(
                    (sum, q) => sum + paidForQuota(q, d.id),
                    0,
                  );
                  const totalPaid = basePaid + paidFromSchedule;
                  const progress =
                    totalDebt > 0
                      ? (Math.min(totalPaid, totalDebt) / totalDebt) * 100
                      : 0;

                  const cardLabel = String(d.cardName || '').trim();
                  const chargeDayLabel =
                    d.chargeDay && Number(d.chargeDay) > 0
                      ? String(d.chargeDay)
                      : '';
                  return (
                    <div
                      key={d.id || d.name + d.due}
                      className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-1)]/80 p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-semibold whitespace-normal break-words">
                          {d.name || 'Deuda'}
                        </div>
                        <div className="text-xs text-[color:var(--text-muted)]">
                          {Math.round(progress)}%
                        </div>
                      </div>
                      {cardLabel && (
                        <div className="mt-1 text-xs text-[color:var(--text-muted)]">
                          Tarjeta: {cardLabel}
                        </div>
                      )}
                      {chargeDayLabel && (
                        <div className="mt-1 text-xs text-[color:var(--text-muted)]">
                          Cobro: dia {chargeDayLabel}
                        </div>
                      )}
                      <div className="mt-2">
                        <Progress value={progress} mode="good" />
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="hidden md:block overflow-visible">
                <div className="overflow-x-hidden overflow-y-visible">
                  <table className="w-full text-sm border-collapse table-auto min-w-0">
                    {[
                      <thead key="head">
                        <tr className="text-left text-xs text-[color:var(--text-muted)] border-b">
                          <th className="px-1 py-2 sm:px-2 w-20 sm:w-32">
                            Deuda
                          </th>
                          <th className="hidden md:table-cell px-1 py-2 sm:px-2 text-center w-20">
                            Tarjeta
                          </th>
                          <th className="hidden md:table-cell px-1 py-2 sm:px-2 text-center w-12">
                            Cobro
                          </th>
                          <th className="px-1 py-2 sm:px-2 text-center w-12 sm:w-16">
                            Total deuda
                          </th>
                          <th className="hidden sm:table-cell px-1 py-2 sm:px-2 text-center w-12 sm:w-16">
                            Pagado
                          </th>
                          <th className="hidden md:table-cell px-1 py-2 sm:px-2 text-center w-20 md:w-28">
                            Progreso
                          </th>
                          {visiblePeriods.map((pk, idx) => {
                            const isCurrent = pk === trueCurrentPeriod;
                            const visibilityClass = periodVisibilityClass(idx);
                            const plannedForHeader =
                              plannedTotalsByPeriod[pk] || 0;
                            const highlightColumn = shouldHighlightPeriod(pk);

                            return (
                              <th
                                key={pk}
                                className={`px-1 py-2 sm:px-2 text-center w-14 sm:w-20 ${visibilityClass} ${highlightColumn ? 'bg-[color:var(--primary-muted)]/40' : ''}`}
                              >
                                <div className="flex flex-col items-center gap-1">
                                  <span className="text-[10px] leading-tight break-words text-[color:var(--text)]">
                                    <Money n={plannedForHeader} />
                                  </span>
                                  <span
                                    className={`block w-full px-1 py-0.5 rounded-md text-center whitespace-normal break-words leading-tight ${
                                      isCurrent
                                        ? 'bg-[color:var(--surface-2)] text-[color:var(--text-muted)]'
                                        : 'text-[color:var(--text-muted)]'
                                    }`}
                                  >
                                    {formatBudgetPeriodLabel(pk, budgetCutDay)}
                                  </span>
                                </div>
                              </th>
                            );
                          })}
                          <th className="px-1 py-2 sm:px-2 text-right w-10 sm:w-12">
                            Acciones
                          </th>
                        </tr>
                      </thead>,
                      <tbody key="body">
                        {visibleDebts.map((d) => {
                          const schedule = Array.isArray(d.schedule)
                            ? d.schedule
                            : [];
                          const isSubscription = !!d.isSubscription;
                          const totalOriginal = toNumber(d.original);
                          const plannedTotal = schedule.reduce(
                            (sum, q) => sum + toNumber(q.plannedAmount),
                            0,
                          );
                          const totalDebt = isSubscription
                            ? totalOriginal
                            : Math.max(totalOriginal, plannedTotal);
                          const basePaid = toNumber(d.alreadyPaid);
                          const paidFromSchedule = schedule.reduce(
                            (sum, q) => sum + paidForQuota(q, d.id),
                            0,
                          );
                          const totalPaid = basePaid + paidFromSchedule;
                          const progress =
                            totalDebt > 0
                              ? (Math.min(totalPaid, totalDebt) / totalDebt) *
                                100
                              : 0;
                          const currentQuotas = schedule.filter(
                            (q) => q.periodKey === currentPeriodKey,
                          );
                          const plannedForCurrent = currentQuotas.reduce(
                            (sum, q) => sum + toNumber(q.plannedAmount),
                            0,
                          );
                          const paidForCurrent = currentQuotas.reduce(
                            (sum, q) => sum + paidForQuota(q, d.id),
                            0,
                          );
                          const hasSubscriptionQuota = plannedForCurrent > 0;
                          const subscriptionIsPaid =
                            hasSubscriptionQuota &&
                            paidForCurrent >= plannedForCurrent;
                          return (
                            <tr
                              key={d.id || d.name + d.due}
                              className="border-b last:border-b-0"
                            >
                              <td className="px-1 py-2 sm:px-2 w-20 sm:w-32 font-semibold text-[color:var(--text)] whitespace-normal break-words">
                                {d.name || 'Deuda'}
                              </td>
                              <td className="hidden md:table-cell px-1 py-2 sm:px-2 text-center text-[color:var(--text-muted)] break-words">
                                {String(d.cardName || '').trim() || '-'}
                              </td>
                              <td className="hidden md:table-cell px-1 py-2 sm:px-2 text-center text-[color:var(--text-muted)]">
                                {d.chargeDay ? String(d.chargeDay) : '-'}
                              </td>
                              <td className="px-1 py-2 sm:px-2 w-12 sm:w-16 text-center font-semibold text-[color:var(--text)] break-words">
                                <Money n={totalDebt} />
                              </td>
                              <td className="hidden sm:table-cell px-1 py-2 sm:px-2 w-12 sm:w-16 text-center text-[color:var(--text)] break-words">
                                <Money n={totalPaid} />
                              </td>
                              <td className="hidden md:table-cell px-1 py-2 sm:px-2 w-20 md:w-28 text-center">
                                {isSubscription ? (
                                  hasSubscriptionQuota ? (
                                    <span
                                      className={`text-xs font-semibold ${
                                        subscriptionIsPaid
                                          ? 'text-[color:var(--success)]'
                                          : 'text-[color:var(--warning)]'
                                      }`}
                                    >
                                      {subscriptionIsPaid
                                        ? 'Pagado'
                                        : 'Pendiente'}
                                    </span>
                                  ) : (
                                    <span className="text-xs font-semibold text-[color:var(--text-muted)]">
                                      -
                                    </span>
                                  )
                                ) : (
                                  <div className="flex items-center justify-center gap-1">
                                    <div className="w-20">
                                      <Progress value={progress} mode="good" />
                                    </div>
                                    <span className="text-[10px] text-[color:var(--text-muted)]">
                                      {progress.toFixed(1)}%
                                    </span>
                                  </div>
                                )}
                              </td>
                              {visiblePeriods.map((pk, idx) => {
                                const quotas = schedule.filter(
                                  (q) => q.periodKey === pk,
                                );
                                const planned = quotas.reduce(
                                  (sum, q) => sum + toNumber(q.plannedAmount),
                                  0,
                                );
                                const pendingQuotas = quotas.filter((q) => {
                                  const plannedAmount = toNumber(
                                    q.plannedAmount,
                                  );
                                  if (plannedAmount <= 0) return false;
                                  return paidForQuota(q, d.id) < plannedAmount;
                                });
                                const isPending = pendingQuotas.length > 0;
                                const isOverdue =
                                  isPending &&
                                  pendingQuotas.some((q) => {
                                    const dueDate = resolveDueDate(q, pk);
                                    return dueDate && dueDate < todayStr;
                                  });
                                const quota = quotas[0];
                                const isEmpty = planned <= 0;
                                const isPaid = !isEmpty && !isPending;
                                const cellTone = isEmpty
                                  ? 'bg-[color:var(--surface-2)] border-[color:var(--border)]'
                                  : isPaid
                                    ? 'bg-[color:var(--divider)] border-[color:var(--border)]'
                                    : isOverdue
                                      ? 'bg-[color:var(--danger)]/20 border-[color:var(--danger)]'
                                      : 'bg-[color:var(--primary)]/20 border-[color:var(--primary)]';
                                const textTone = isEmpty
                                  ? 'text-[color:var(--text-muted)]'
                                  : isPaid
                                    ? 'text-[color:var(--text)]'
                                    : 'text-[color:var(--text)]';
                                const visibilityClass =
                                  periodVisibilityClass(idx);
                                const highlightColumn =
                                  shouldHighlightPeriod(pk);
                                return (
                                  <td
                                    key={`${d.id}-${pk}`}
                                    className={`px-1 py-2 sm:px-2 text-center w-14 sm:w-20 ${visibilityClass} ${highlightColumn ? 'bg-[color:var(--primary-muted)]/40' : ''}`}
                                  >
                                    <div
                                      className={`flex items-center justify-center w-full rounded-md px-2 py-1.5 border ${cellTone}`}
                                    >
                                      {planned > 0 ? (
                                        <button
                                          type="button"
                                          className={`w-full font-semibold break-words ${textTone} ${
                                            isPaid
                                              ? 'line-through decoration-2 hover:text-[color:var(--text)]'
                                              : 'hover:text-[color:var(--text)]'
                                          } tooltip-wide`}
                                          onClick={() =>
                                            openQuotaModal(d, quota, pk)
                                          }
                                          data-tooltip={
                                            quota ? quotaTooltip(d, quota) : ''
                                          }
                                        >
                                          <Money n={planned} />
                                        </button>
                                      ) : (
                                        <button
                                          type="button"
                                          className={`w-full ${textTone} hover:text-[color:var(--text-muted)]`}
                                          data-tooltip="Agregar cuota"
                                          onClick={() =>
                                            openQuotaModal(d, null, pk)
                                          }
                                        >
                                          -
                                        </button>
                                      )}
                                    </div>
                                  </td>
                                );
                              })}
                              <td className="px-1 py-2 sm:px-2 w-10 sm:w-12 text-right">
                                <div className="flex justify-end gap-3 text-xs">
                                  <button
                                    className="text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                                    aria-label="Editar deuda"
                                    data-tooltip="Editar deuda"
                                    onClick={() =>
                                      setDebtEditModal({
                                        id: d.id,
                                        name: d.name || '',
                                        cardName: d.cardName || '',
                                        chargeDay:
                                          d.chargeDay != null
                                            ? String(d.chargeDay)
                                            : '',
                                        rateAPR:
                                          d.rateAPR != null
                                            ? String(d.rateAPR)
                                            : '',
                                        due: d.due || '',
                                        isSubscription: !!d.isSubscription,
                                        subscriptionActive:
                                          d.subscriptionActive !== false,
                                        subscriptionWasActive:
                                          d.subscriptionActive !== false,
                                        subscriptionResumeDate:
                                          d.subscriptionResumeDate || '',
                                      })
                                    }
                                  >
                                    <svg
                                      className="h-5 w-5"
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
                                  <button
                                    className="text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                                    aria-label="Archivar deuda"
                                    data-tooltip="Archivar deuda"
                                    onClick={() => handleArchiveDebt(d)}
                                  >
                                    <svg
                                      className="h-5 w-5"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      aria-hidden="true"
                                    >
                                      <rect
                                        x="3"
                                        y="4"
                                        width="18"
                                        height="5"
                                        rx="1"
                                      />
                                      <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" />
                                      <path d="M10 13h4" />
                                    </svg>
                                  </button>
                                  <button
                                    className="text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                                    aria-label="Eliminar deuda"
                                    data-tooltip="Eliminar deuda"
                                    onClick={() => handleRemoveDebt(d)}
                                  >
                                    <svg
                                      className="h-5 w-5"
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
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>,
                    ]}
                  </table>
                </div>
              </div>
            </>
          )}
        </Card>
      </div>
      {showAddDebtModal && (
        <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 backdrop-blur-sm pt-16 px-4">
          <div className="bg-[color:var(--surface-1)] rounded-2xl shadow-[var(--shadow)] p-5 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Agregar deuda</h3>
              <button
                type="button"
                className="text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                onClick={() => setShowAddDebtModal(false)}
              >
                Cerrar
              </button>
            </div>
            {renderDebtForm({
              onSubmit: handleAddDebtFromModal,
              dateInputType: 'text',
              submitLabel: 'Agregar deuda',
            })}
          </div>
        </div>
      )}
      {/* Modales */}
      {quotaModal && (
        <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/30 pt-16">
          <div className="bg-[color:var(--surface-1)] rounded-2xl shadow-xl p-5 w-full max-w-md">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">
                {quotaModal.quotaId ? 'Editar cuota' : 'Nueva cuota'}
              </h3>
              <button
                type="button"
                className="text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
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
                <div className="border rounded-lg p-2 bg-[color:var(--surface-2)]  text-right">
                  <Money n={paidInPeriodForModal} />
                </div>
                <p className="text-xs text-[color:var(--text-muted)]">
                  El pago real proviene de las transacciones con categoria{' '}
                  {`"${DEBT_CATEGORY}"`} en el periodo.
                </p>
              </div>

              {quotaModal.quotaId && (
                <div className="grid gap-1">
                  <label>Pagado vinculado a esta cuota</label>
                  <div className="border rounded-lg p-2 bg-[color:var(--surface-2)]  text-right">
                    <Money n={linkedPaidForModal} />
                  </div>
                  <div
                    className={`text-xs font-semibold ${
                      isModalQuotaPaid
                        ? 'text-[color:var(--success)]'
                        : 'text-[color:var(--warning)]'
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
                  className="px-3 py-1.5 text-sm border rounded-lg bg-[color:var(--primary)] text-[color:var(--primary-contrast)]"
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
          <div className="bg-[color:var(--surface-1)] rounded-2xl shadow-xl p-5 w-full max-w-md">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">Editar deuda</h3>
              <button
                type="button"
                className="text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
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
                <label>Tarjeta de credito</label>
                <input
                  className="border rounded-lg p-2"
                  value={debtEditModal.cardName || ''}
                  list="cardNameOptions"
                  onChange={(e) =>
                    setDebtEditModal((prev) => ({
                      ...prev,
                      cardName: e.target.value,
                    }))
                  }
                />
              </div>

              <div className="grid gap-1">
                <label>Dia de cobro</label>
                <input
                  className="border rounded-lg p-2"
                  type="number"
                  min={1}
                  max={31}
                  step="1"
                  value={debtEditModal.chargeDay || ''}
                  onChange={(e) =>
                    setDebtEditModal((prev) => ({
                      ...prev,
                      chargeDay: e.target.value,
                    }))
                  }
                />
              </div>

              {debtEditModal.isSubscription && (
                <div className="grid gap-2 rounded-lg border border-[color:var(--divider)] p-3">
                  <label className="flex items-center gap-2 text-sm text-[color:var(--text-muted)]">
                    <input
                      type="checkbox"
                      checked={debtEditModal.subscriptionActive !== false}
                      onChange={(e) =>
                        setDebtEditModal((prev) => ({
                          ...prev,
                          subscriptionActive: e.target.checked,
                          subscriptionResumeDate: e.target.checked
                            ? prev.subscriptionResumeDate
                            : '',
                        }))
                      }
                    />
                    Suscripcion activa
                  </label>
                  {!debtEditModal.subscriptionActive && (
                    <div className="text-xs text-[color:var(--text-muted)]">
                      Las cuotas futuras quedaran en 0.
                    </div>
                  )}
                  {debtEditModal.subscriptionActive &&
                    debtEditModal.subscriptionWasActive === false && (
                      <div className="grid gap-1">
                        <label>Fecha desde la que se cobrara</label>
                        <input
                          type="date"
                          className="border rounded-lg p-2"
                          value={debtEditModal.subscriptionResumeDate || ''}
                          onChange={(e) =>
                            setDebtEditModal((prev) => ({
                              ...prev,
                              subscriptionResumeDate: e.target.value,
                            }))
                          }
                        />
                      </div>
                    )}
                </div>
              )}

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
                  className="px-3 py-1.5 text-sm border rounded-lg bg-[color:var(--primary)] text-[color:var(--primary-contrast)]"
                >
                  Guardar cambios
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
