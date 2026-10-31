// src/modules/debts/Debts.jsx
import { txDateKey } from '../../domain/ledger.js';
import { toast, confirmDialog } from '../../components/feedback/feedback.js';
import { todayKey, toLocalDateKey } from '../../domain/dates.js';
import React, { useEffect, useState, useMemo } from 'react';

import { Card } from '../../components/ui/Card.jsx';
import { SectionTitle } from '../../components/ui/SectionTitle.jsx';
import { Money } from '../../components/ui/Money.jsx';
import { CreditCard } from '../../components/ui/CreditCard.jsx';
import { Progress } from '../../components/ui/Progress.jsx';
import {
  monthKey,
  shiftMonth,
  getBudgetPeriod,
  formatBudgetPeriodLabel,
  budgetMonthKeyForDate,
} from '../../utils/budgetPeriod.js';
import { DEBT_CATEGORY } from '../../constants.js';

// 30 años en cuotas mensuales; también mantiene el documento bajo el límite de Firestore.
const MAX_INSTALLMENTS = 360;

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
  if (Number.isNaN(d.getTime())) return todayKey();
  d.setMonth(d.getMonth() + months);
  return toLocalDateKey(d);
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
      const d = txDateKey(t);
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

  const { addDebt, updateDebt, removeDebt, addTransaction } = actions || {};
  const activeUser = data?.activeUser || null;

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

  useEffect(() => {
    if (!showAddDebtModal) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setShowAddDebtModal(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showAddDebtModal]);

  const currentPeriodKey = useMemo(
    () => monthKeyStr || monthKey(new Date()),
    [monthKeyStr],
  );

  const trueCurrentPeriod = useMemo(() => {
    const todayStr = todayKey();
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

  async function handleRemoveDebt(debt) {
    if (!removeDebt || !debt?.id) return;
    const name = String(debt.name || '').trim();
    const label = name ? ` "${name}"` : '';
    const ok = await confirmDialog(
      `Eliminar deuda${label}? Se movera a la papelera para poder recuperarla.`,
    );
    if (!ok) return;
    removeDebt(debt.id);
  }

  async function handleArchiveDebt(debt) {
    if (!updateDebt || !debt?.id) return;
    const name = String(debt.name || '').trim();
    const label = name ? ` "${name}"` : '';
    const ok = await confirmDialog(
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

  // Con fecha de inicio el primer cobro es esa fecha y se repite mes a mes desde ahí
  // (permite empezar el mes siguiente). Sin fecha, se mantiene el calendario por periodo.
  function buildSubscriptionSchedule(monthlyAmount, startPeriodKey, firstDue = '') {
    const schedule = [];
    const start = startPeriodKey || monthKey();
    for (let i = firstDue ? 0 : -1; i <= 18; i += 1) {
      let pk;
      let dueDate;
      if (firstDue) {
        dueDate = addMonthsToDate(firstDue, i);
        pk = budgetMonthKeyForDate(dueDate, budgetCutDay);
      } else {
        pk = shiftMonth(start, i);
        const { end } = getBudgetPeriod(pk, budgetCutDay);
        const endDate = new Date(end + 'T00:00:00');
        endDate.setDate(endDate.getDate() - 1);
        dueDate = toLocalDateKey(endDate);
      }
      schedule.push({
        id: `${Date.now()}-sub-${i}-${Math.random().toString(36).slice(2, 6)}`,
        periodKey: pk,
        dueDate,
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

  // Primer vencimiento con monto (las cuotas en 0 de una suscripción pausada no cuentan).
  function firstDueOf(debt) {
    const dates = ensureScheduleArray(debt?.schedule)
      .filter((q) => q.plannedAmount > 0 && q.dueDate)
      .map((q) => q.dueDate)
      .sort();
    return dates[0] || '';
  }

  // Corre todas las cuotas para que la primera venza en `firstDue`. Conserva ids y montos,
  // así los pagos ya vinculados siguen apuntando a su cuota.
  function shiftScheduleFrom(schedule, firstDue) {
    return [...schedule]
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
      .map((quota, i) => {
        const dueDate = addMonthsToDate(firstDue, i);
        return { ...quota, dueDate, periodKey: budgetMonthKeyForDate(dueDate, budgetCutDay) };
      });
  }

  // Rehace el calendario de una suscripción desde `firstDue`. Reusa la cuota del mismo periodo
  // (para no perder pagos) y solo conserva las de otros periodos si ya tienen pagos.
  function restartSubscriptionFrom(debt, schedule, firstDue, monthlyAmount) {
    const fresh = buildSubscriptionSchedule(monthlyAmount, '', firstDue);
    const freshPeriods = new Set(fresh.map((q) => q.periodKey));
    const byPeriod = new Map(schedule.map((q) => [resolveQuotaPeriodKey(q), q]));
    const keptPaid = schedule.filter(
      (q) => !freshPeriods.has(resolveQuotaPeriodKey(q)) && paidForQuota(q, debt.id) > 0,
    );
    return [
      ...keptPaid,
      ...fresh.map((q) => {
        const prev = byPeriod.get(q.periodKey);
        if (!prev) return q;
        return {
          ...prev,
          periodKey: q.periodKey,
          dueDate: q.dueDate,
          plannedAmount: monthlyAmount,
          status: computeQuotaStatus(monthlyAmount, prev.paidAmount),
        };
      }),
    ];
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

    const firstDue = String(debtEditModal.firstDue || '').trim();
    if (firstDue && !/^\d{4}-\d{2}-\d{2}$/.test(firstDue)) {
      toast.warning('La fecha del primer pago no es válida.');
      return;
    }
    let baseSchedule = ensureScheduleArray(debt?.schedule || []);
    if (debt && firstDue && firstDue !== debtEditModal.firstDueOriginal) {
      if (debtEditModal.isSubscription) {
        baseSchedule = restartSubscriptionFrom(debt, baseSchedule, firstDue, toNumber(debt.original));
      } else {
        baseSchedule = shiftScheduleFrom(baseSchedule, firstDue);
        patch.due = baseSchedule[baseSchedule.length - 1]?.dueDate || patch.due;
      }
      patch.schedule = baseSchedule;
    }

    if (debtEditModal.isSubscription) {
      const prevActive = debt?.subscriptionActive !== false;
      const subscriptionActive = debtEditModal.subscriptionActive !== false;
      const resumeDate = String(
        debtEditModal.subscriptionResumeDate || '',
      ).trim();
      const monthlyAmount = toNumber(debt?.original);

      if (subscriptionActive && !prevActive && !resumeDate) {
        toast.warning(
          'Selecciona la fecha desde la que quieres reactivar el cobro.',
        );
        return;
      }

      patch.subscriptionActive = subscriptionActive;
      patch.subscriptionResumeDate = subscriptionActive ? resumeDate || '' : '';

      const schedule = baseSchedule;
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
    if (!original || !addDebt) return false;

    const isSubscription = !!form.isSubscription;
    // Un plazo mayor a 30 años casi siempre es el monto de la cuota escrito en el campo equivocado.
    if (!isSubscription && Number(form.installments || 1) > MAX_INSTALLMENTS) {
      toast.warning(
        `El número de cuotas no puede ser mayor a ${MAX_INSTALLMENTS}. ¿Escribiste el monto de la cuota en ese campo?`,
      );
      return false;
    }
    const firstDue = form.firstDue || todayKey();
    const startPeriod = budgetMonthKeyForDate(firstDue, budgetCutDay);

    let remaining = original;
    let installments = Math.max(1, Number(form.installments || 1));
    let schedule;
    let lastQuota;

    if (isSubscription) {
      remaining = original;
      installments = 1;
      schedule = buildSubscriptionSchedule(original, startPeriod, form.firstDue);
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
      // Firestore rechaza campos `undefined`: solo las suscripciones llevan estos campos.
      ...(isSubscription
        ? { subscriptionActive: true, subscriptionResumeDate: '' }
        : {}),
    };

    try {
      await addDebt(d);
    } catch (err) {
      console.error('No se pudo agregar la deuda', { code: err?.code });
      toast.error('No se pudo agregar la deuda. Revisa los datos e inténtalo de nuevo.');
      return false;
    }

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
    return true;
  }

  async function handleAddDebtFromModal(e) {
    if (await handleAddDebt(e)) setShowAddDebtModal(false);
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
          <label className="grid gap-1 text-xs text-[color:var(--text-muted)]">
            Número de cuotas
            <input
              className="border rounded-lg p-3 text-sm text-[color:var(--text)]"
              type="number"
              min={1}
              max={MAX_INSTALLMENTS}
              step="1"
              placeholder="ej. 12"
              value={form.installments}
              onChange={(e) => handleFormChange('installments', e.target.value)}
              disabled={form.isSubscription}
            />
          </label>
          <label className="grid gap-1 text-xs text-[color:var(--text-muted)]">
            {form.isSubscription ? 'Primer cobro' : 'Vencimiento 1ª cuota'}
            <input
              className="border rounded-lg p-3 text-sm text-[color:var(--text)]"
              type={dateInputType}
              placeholder={datePlaceholder}
              value={form.firstDue}
              onChange={(e) => handleFormChange('firstDue', e.target.value)}
              inputMode={dateInputType === 'text' ? 'text' : undefined}
            />
          </label>
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
      paymentDate: todayStr,
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

  const todayStr = todayKey();

  function resolveDueDate(quota, periodKey) {
    if (quota?.dueDate) return quota.dueDate;
    if (!periodKey) return '';
    const { end } = getBudgetPeriod(periodKey, budgetCutDay);
    const endDate = new Date(end + 'T00:00:00');
    endDate.setDate(endDate.getDate() - 1);
    return toLocalDateKey(endDate);
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
  const remainingForModal = Math.max(
    0,
    plannedForModal - linkedPaidForModal,
  );

  async function handleRegisterQuotaPayment() {
    if (!quotaModal || !addTransaction) return;
    const { debtId, quotaId, quotaIds, paymentDate } = quotaModal;
    if (!debtId) return;

    const debt = debts.find((d) => d.id === debtId);
    const ids =
      Array.isArray(quotaIds) && quotaIds.length
        ? quotaIds
        : quotaId
          ? [quotaId]
          : [];
    if (!ids.length) return;

    const amount = Math.round(remainingForModal);
    if (!amount || amount <= 0) return;

    const schedule = ensureScheduleArray(debt?.schedule || []);
    const targetQuotas = schedule.filter((q) => ids.includes(q.id));
    const weightedQuotas = targetQuotas.map((q) => ({
      ...q,
      plannedAmount: Math.max(
        0,
        toNumber(q.plannedAmount) - linkedPaidForQuota(q.id, debtId),
      ),
    }));
    const allocationMap =
      ids.length > 1
        ? allocatePlannedAcrossQuotas(amount, weightedQuotas)
        : { [ids[0]]: amount };

    const debtIdMap = {};
    ids.forEach((id) => {
      debtIdMap[id] = debtId;
    });

    const description = debt?.name
      ? `Pago deuda: ${debt.name}`
      : 'Pago deuda';

    try {
      await addTransaction({
        type: 'gasto',
        category: DEBT_CATEGORY,
        amount,
        description,
        date: paymentDate || todayStr,
        createdAt: new Date().toISOString(),
        ownerId: activeUser?.id || null,
        ownerName: activeUser?.name || null,
        ownerEmail: activeUser?.email || null,
        meta: {
          debtQuotaIds: ids,
          debtQuotaId: ids.length === 1 ? ids[0] : undefined,
          debtQuotaAmounts: allocationMap,
          debtQuotaDebtIds: debtIdMap,
          debtId,
        },
      });
    } catch (err) {
      console.error('Error registrando pago de deuda:', err);
      toast.error('No se pudo registrar el pago.');
    }
  }

  // Total de la deuda y lo pagado (abono inicial + cuotas pagadas en Movimientos).
  function debtTotals(d) {
    const schedule = Array.isArray(d.schedule) ? d.schedule : [];
    const plannedTotal = schedule.reduce(
      (sum, q) => sum + toNumber(q.plannedAmount),
      0,
    );
    const total = Math.max(toNumber(d.original), plannedTotal + toNumber(d.alreadyPaid));
    const paid =
      toNumber(d.alreadyPaid) +
      schedule.reduce((sum, q) => sum + paidForQuota(q, d.id), 0);
    return { total, paid };
  }

  const visibleDebts = debtsActive.filter((d) => {
    if (!hidePaidDebts) return true;
    if (d.isSubscription) return true;
    const { total, paid } = debtTotals(d);
    if (total <= 0) return true;
    return paid < total;
  });

  const cardSummary = useMemo(() => {
    const summary = new Map();
    debtsActive.forEach((debt) => {
      const cardName = String(debt.cardName || '').trim() || 'Sin tarjeta';
      const entry = summary.get(cardName) || {
        planned: 0,
        paid: 0,
        pending: 0,
        balance: 0,
        debtCount: 0,
      };

      if (!debt.isSubscription) {
        const { total, paid } = debtTotals(debt);
        const balance = Math.max(total - paid, 0);
        entry.balance += balance;
        if (balance > 0) entry.debtCount += 1;
      } else if (debt.subscriptionActive !== false) {
        entry.debtCount += 1;
      }

      let debtPending = 0;
      const schedule = Array.isArray(debt.schedule) ? debt.schedule : [];
      schedule
        .filter((q) => resolveQuotaPeriodKey(q) === currentPeriodKey)
        .forEach((quota) => {
          const planned = toNumber(quota.plannedAmount);
          if (planned <= 0) return;
          const paid = paidForQuota(quota, debt.id);
          entry.planned += planned;
          entry.paid += paid;
          debtPending += Math.max(planned - paid, 0);
        });
      entry.pending += debtPending;
      // Las suscripciones no tienen saldo total (se repiten hasta eliminarlas):
      // lo que se debe de ellas en la tarjeta es el cobro del periodo sin pagar.
      if (debt.isSubscription) entry.balance += debtPending;

      if (entry.debtCount > 0 || entry.planned > 0) summary.set(cardName, entry);
    });
    return Array.from(summary.entries())
      .map(([name, values]) => ({ name, ...values }))
      .sort((a, b) => b.balance - a.balance || b.pending - a.pending);
  }, [debtsActive, currentPeriodKey]);

  return (
    <>
      <datalist id="cardNameOptions">
        {cardOptions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <div className="grid gap-6 w-full">
        {/* Calendario */}
        <Card className="p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SectionTitle>Calendario de deudas</SectionTitle>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="inline-flex min-h-[40px] items-center gap-1 rounded-xl bg-[color:var(--primary)] px-4 text-sm font-semibold text-[color:var(--primary-contrast)] shadow-sm active:scale-[0.98]"
                onClick={() => setShowAddDebtModal(true)}
              >
                + Agregar deuda
              </button>
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
                    : Math.max(totalOriginal, plannedTotal + toNumber(d.alreadyPaid));
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
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="px-3 py-1.5 text-xs rounded-lg border text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)]"
                          onClick={() =>
                            setDebtEditModal({
                              id: d.id,
                              name: d.name || '',
                              original: d.original != null ? String(d.original) : '',
                              alreadyPaid:
                                d.alreadyPaid != null ? String(d.alreadyPaid) : '',
                              due: d.due || '',
                              firstDue: firstDueOf(d),
                              firstDueOriginal: firstDueOf(d),
                              rateAPR: d.rateAPR != null ? String(d.rateAPR) : '',
                              cardName: d.cardName || '',
                              chargeDay:
                                d.chargeDay != null ? String(d.chargeDay) : '',
                              isSubscription: !!d.isSubscription,
                            })
                          }
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          className="px-3 py-1.5 text-xs rounded-lg border border-[color:var(--danger)]/40 text-[color:var(--danger)] hover:bg-[color:var(--danger)]/10"
                          onClick={() => handleRemoveDebt(d)}
                        >
                          Eliminar
                        </button>
                        <button
                          type="button"
                          className="px-3 py-1.5 text-xs rounded-lg border text-[color:var(--primary)] border-[color:var(--primary)]/40 bg-[color:var(--primary)]/10 hover:bg-[color:var(--primary)]/20"
                          onClick={() => openQuotaModal(d, null, currentPeriodKey)}
                        >
                          Cuotas
                        </button>
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
                            : Math.max(totalOriginal, plannedTotal + toNumber(d.alreadyPaid));
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
                                        firstDue: firstDueOf(d),
                                        firstDueOriginal: firstDueOf(d),
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

        {cardSummary.length > 0 && (
          <section className="grid gap-3" aria-labelledby="card-summary-title">
            <h2 id="card-summary-title" className="text-lg font-semibold">
              Resumen por tarjeta{' '}
              <span className="text-sm font-normal text-[color:var(--text-muted)]">
                ({formatBudgetPeriodLabel(currentPeriodKey, budgetCutDay)})
              </span>
            </h2>
            <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(16rem,20rem))]">
              {cardSummary.map((card) => (
                <CreditCard
                  key={card.name}
                  name={card.name}
                  balance={card.balance}
                  debtCount={card.debtCount}
                  planned={card.planned}
                  paid={card.paid}
                  pending={card.pending}
                  isPlaceholder={card.name === 'Sin tarjeta'}
                />
              ))}
            </div>
          </section>
        )}
      </div>
      {showAddDebtModal && (
        <div
          className="fixed inset-0 z-[60] flex items-end sm:items-start justify-center bg-black/40 backdrop-blur-sm sm:pt-16 sm:px-4"
          onClick={() => setShowAddDebtModal(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-debt-title"
            className="sheet-enter bg-[color:var(--surface-1)] rounded-t-3xl sm:rounded-2xl shadow-xl p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] w-full sm:max-w-md max-h-[92vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 id="add-debt-title" className="text-lg font-semibold">
                Nueva deuda
              </h3>
              <button
                type="button"
                className="min-h-[40px] px-2 text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                onClick={() => setShowAddDebtModal(false)}
              >
                Cerrar
              </button>
            </div>
            {renderDebtForm({
              onSubmit: handleAddDebtFromModal,
              dateInputType: 'date',
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

              {(quotaModal.quotaId ||
                (Array.isArray(quotaModal.quotaIds) &&
                  quotaModal.quotaIds.length > 0)) && (
                <div className="grid gap-2 rounded-lg border border-[color:var(--border)]/70 bg-[color:var(--surface-2)]/60 p-3">
                  <div className="text-xs font-semibold uppercase text-[color:var(--text-muted)]">
                    Registrar pago
                  </div>
                  <div className="grid gap-1">
                    <label className="text-xs text-[color:var(--text-muted)]">
                      Monto a registrar
                    </label>
                    <div className="border rounded-lg p-2 bg-[color:var(--surface-1)] text-right">
                      <Money n={remainingForModal} />
                    </div>
                  </div>
                  <div className="grid gap-1">
                    <label className="text-xs text-[color:var(--text-muted)]">
                      Fecha del pago
                    </label>
                    <input
                      type="date"
                      className="border rounded-lg p-2"
                      value={quotaModal.paymentDate || ''}
                      onChange={(e) =>
                        setQuotaModal((prev) => ({
                          ...prev,
                          paymentDate: e.target.value,
                        }))
                      }
                    />
                  </div>
                  <button
                    type="button"
                    className="px-3 py-2 text-sm rounded-lg border bg-[color:var(--primary)] text-[color:var(--primary-contrast)] disabled:opacity-60"
                    onClick={handleRegisterQuotaPayment}
                    disabled={!addTransaction || remainingForModal <= 0}
                  >
                    Marcar como pagada
                  </button>
                  {remainingForModal <= 0 && (
                    <div className="text-xs text-[color:var(--text-muted)]">
                      Esta cuota ya no tiene saldo pendiente.
                    </div>
                  )}
                </div>
              )}

              <div className="grid gap-1">
                <label>Fecha de vencimiento</label>
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
                <label>
                  {debtEditModal.isSubscription ? 'Primer cobro' : 'Vencimiento 1ª cuota'}
                </label>
                <input
                  type="date"
                  className="border rounded-lg p-2"
                  value={debtEditModal.firstDue || ''}
                  onChange={(e) =>
                    setDebtEditModal((prev) => ({
                      ...prev,
                      firstDue: e.target.value,
                    }))
                  }
                />
                {debtEditModal.firstDue &&
                  debtEditModal.firstDue !== debtEditModal.firstDueOriginal && (
                    <div className="text-xs text-[color:var(--text-muted)]">
                      {debtEditModal.isSubscription
                        ? 'El cobro mensual empezará en esta fecha. Los pagos ya registrados se conservan.'
                        : 'Todas las cuotas se correrán para que la primera venza en esta fecha. Los pagos ya registrados se conservan.'}
                    </div>
                  )}
              </div>

              {!debtEditModal.isSubscription && (
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
              )}

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
