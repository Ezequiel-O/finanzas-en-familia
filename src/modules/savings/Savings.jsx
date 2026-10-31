// src/modules/savings/Savings.jsx
import { txDateKey } from '../../domain/ledger.js';
import { plannedForSavingPeriod } from '../../domain/commitments.js';
import { SAVINGS_CATEGORY } from '../../constants.js';
import { toast, confirmDialog } from '../../components/feedback/feedback.js';
import { todayKey, toLocalDateKey } from '../../domain/dates.js';
import React, { useEffect, useMemo, useState } from 'react';

import { Card } from '../../components/ui/Card.jsx';
import { SectionTitle } from '../../components/ui/SectionTitle.jsx';
import { Money } from '../../components/ui/Money.jsx';
import { Progress } from '../../components/ui/Progress.jsx';
import {
  monthKey,
  shiftMonth,
  getBudgetPeriod,
  formatBudgetPeriodLabel,
  budgetMonthKeyForDate,
  dateKeyFromValue,
} from '../../utils/budgetPeriod.js';

const DEFAULT_PLAN_PERIODS = 3;

function toNumber(n) {
  const num = Number(n || 0);
  return Number.isNaN(num) ? 0 : num;
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
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

function computePlanStatus(plannedAmount, paidAmount) {
  const planned = toNumber(plannedAmount);
  const paid = toNumber(paidAmount);
  if (paid >= planned && planned > 0) return 'paid';
  if (paid > 0) return 'partial';
  return 'pending';
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

function resolveSchedulePeriodKey(entry, cutDay) {
  if (entry?.periodKey) return entry.periodKey;
  if (entry?.dueDate) {
    return budgetMonthKeyForDate(entry.dueDate, cutDay);
  }
  return '';
}

function buildSavingSchedule({
  goal,
  saved,
  targetDate,
  createdAt,
  budgetCutDay,
  defaultPeriods = DEFAULT_PLAN_PERIODS,
}) {
  const remaining = Math.max(toNumber(goal) - toNumber(saved), 0);
  if (remaining <= 0) return [];

  const createdKey =
    dateKeyFromValue(createdAt) || todayKey();
  const startPk = budgetMonthKeyForDate(createdKey, budgetCutDay);
  const periods = Math.max(1, Number(defaultPeriods) || DEFAULT_PLAN_PERIODS);

  let targetPk = targetDate
    ? budgetMonthKeyForDate(targetDate, budgetCutDay)
    : shiftMonth(startPk, periods - 1);

  if (!targetPk || targetPk < startPk) targetPk = startPk;

  const totalPeriods = periodsBetween(startPk, targetPk);
  const basePlan =
    totalPeriods > 0 ? Math.floor(remaining / totalPeriods) : remaining;
  const delta = remaining - basePlan * totalPeriods;

  const schedule = [];
  for (let i = 0; i < totalPeriods; i += 1) {
    const pk = shiftMonth(startPk, i);
    const planned = basePlan + (i === totalPeriods - 1 ? delta : 0);
    const { end } = getBudgetPeriod(pk, budgetCutDay);
    const endDate = new Date(end + 'T00:00:00');
    endDate.setDate(endDate.getDate() - 1);
    schedule.push({
      id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
      periodKey: pk,
      dueDate: toLocalDateKey(endDate),
      plannedAmount: planned,
      paidAmount: 0,
      status: computePlanStatus(planned, 0),
    });
  }

  return schedule;
}

function totalSavingsPaidFromTransactions(transactions, periodKey, cutDay) {
  const { start, end } = getBudgetPeriod(periodKey, cutDay);
  return (transactions || [])
    .filter((t) => t.category === SAVINGS_CATEGORY)
    .filter((t) => {
      const d = txDateKey(t);
      return d >= start && d < end;
    })
    .reduce((sum, t) => sum + toNumber(t.amount), 0);
}

function totalSavingsPlannedForPeriod(savings, periodKey, cutDay) {
  return (savings || []).reduce(
    (sum, s) => sum + plannedForSavingPeriod(s, periodKey, cutDay),
    0,
  );
}

export function Savings({ data, actions, monthKeyStr }) {
  const savingsRaw = data?.savings || [];
  const budgetCutDay = data?.budgetCutDay || 1;
  const transactions = data?.transactions || [];

  const savings = savingsRaw.map((s) => ({
    ...s,
    id: s.id || Math.random().toString(36).slice(2, 10),
    schedule: ensureScheduleArray(s.schedule),
  }));

  const { addSaving, updateSaving, removeSaving, updateTransaction } =
    actions || {};

  const [form, setForm] = useState({
    name: '',
    goal: '',
    saved: '',
    targetDate: '',
  });

  const [planModal, setPlanModal] = useState(null);
  const [savingEditModal, setSavingEditModal] = useState(null);
  const [hideCompletedSavings, setHideCompletedSavings] = useState(true);
  const [showAddSavingModal, setShowAddSavingModal] = useState(false);

  useEffect(() => {
    if (!showAddSavingModal) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setShowAddSavingModal(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showAddSavingModal]);

  const currentPeriodKey = useMemo(
    () => monthKeyStr || monthKey(new Date()),
    [monthKeyStr],
  );

  const trueCurrentPeriod = useMemo(() => {
    const todayStr = todayKey();
    return budgetMonthKeyForDate(todayStr, budgetCutDay);
  }, [budgetCutDay]);

  const visiblePeriods = useMemo(
    () => [
      shiftMonth(currentPeriodKey, -1),
      currentPeriodKey,
      shiftMonth(currentPeriodKey, 1),
    ],
    [currentPeriodKey],
  );

  const savingNameLookup = useMemo(() => {
    const counts = new Map();
    const ids = new Map();
    savings.forEach((s) => {
      const key = normalizeName(s?.name);
      if (!key || !s?.id) return;
      counts.set(key, (counts.get(key) || 0) + 1);
      ids.set(key, s.id);
    });
    const lookup = {};
    counts.forEach((count, key) => {
      if (count === 1) lookup[key] = ids.get(key);
    });
    return lookup;
  }, [savings]);
  const savingsPaidMap = useMemo(() => {
    const bySavingId = {};
    const bySavingPeriod = {};
    (transactions || []).forEach((t) => {
      if (t?.category !== SAVINGS_CATEGORY) return;
      const amt = toNumber(t.amount);
      if (!amt) return;
      const dateStr = txDateKey(t);
      const periodKey = dateStr
        ? budgetMonthKeyForDate(dateStr, budgetCutDay)
        : '';
      let savingId = String(t?.meta?.savingId || '').trim();
      if (!savingId) {
        const nameKey = normalizeName(t?.meta?.savingName || '');
        savingId = nameKey ? savingNameLookup[nameKey] : '';
      }
      if (!savingId) return;
      // Retiro (ingreso) descuenta del total; lo aportado en el periodo cuenta solo aportes.
      if (t.type === 'ingreso') {
        bySavingId[savingId] = (bySavingId[savingId] || 0) - amt;
        return;
      }
      bySavingId[savingId] = (bySavingId[savingId] || 0) + amt;
      if (periodKey) {
        const key = `${savingId}::${periodKey}`;
        bySavingPeriod[key] = (bySavingPeriod[key] || 0) + amt;
      }
    });
    return { bySavingId, bySavingPeriod };
  }, [transactions, budgetCutDay, savingNameLookup]);

  const paidForSavingPeriod = (savingId, periodKey) => {
    if (!savingId || !periodKey) return 0;
    return savingsPaidMap.bySavingPeriod[`${savingId}::${periodKey}`] ?? 0;
  };

  const totalSavedForSaving = (saving) => {
    const base = toNumber(saving.saved);
    const extra = saving.id ? savingsPaidMap.bySavingId[saving.id] || 0 : 0;
    return base + extra;
  };

  async function handleRemoveSaving(saving) {
    if (!removeSaving || !saving?.id) return;
    const name = String(saving.name || '').trim();
    const label = name ? ` "${name}"` : '';
    const ok = await confirmDialog(
      `Eliminar meta${label}? Se movera a la papelera para poder recuperarla.`,
    );
    if (!ok) return;

    const nameKey = normalizeName(name);
    const isUniqueName = savingNameLookup[nameKey] === saving.id;
    const relatedTx =
      updateTransaction && Array.isArray(transactions)
        ? transactions.filter((tx) => {
            if (!tx || tx.type !== 'gasto') return false;
            if (tx.category !== SAVINGS_CATEGORY) return false;
            const meta = tx.meta || {};
            const metaId = String(meta.savingId || '').trim();
            const metaName = normalizeName(meta.savingName || '');
            const metaBudgetName = normalizeName(
              meta.budgetSubcategoryName || '',
            );
            if (metaId) return metaId === saving.id;
            if (!isUniqueName) return false;
            return metaName === nameKey || metaBudgetName === nameKey;
          })
        : [];

    if (relatedTx.length && updateTransaction) {
      const wantsMigration = await confirmDialog(
        `La meta${label} tiene ${relatedTx.length} movimiento${
          relatedTx.length === 1 ? '' : 's'
        } asociado${
          relatedTx.length === 1 ? '' : 's'
        }. ¿Deseas migrarlos a otra meta?`,
      );
      let targetSaving = null;
      if (wantsMigration) {
        const options = savings.filter((s) => s.id !== saving.id);
        if (options.length === 0) {
          const keepUnassigned = await confirmDialog(
            'No hay otras metas para migrar. Los movimientos quedaran sin asignar. ¿Continuar?',
          );
          if (!keepUnassigned) return;
        } else {
          const list = options
            .map((s, idx) => {
              const baseName = s.name || 'Ahorro';
              const labelName = s.targetDate
                ? `${baseName} (${s.targetDate})`
                : baseName;
              return `${idx + 1}. ${labelName}`;
            })
            .join('\n');
          const input = window.prompt(
            `Meta destino (numero). Deja vacio para no migrar:\n${list}`,
            '',
          );
          if (input === null) return;
          const trimmed = String(input || '').trim();
          if (trimmed) {
            const index = Number(trimmed) - 1;
            if (!Number.isInteger(index) || index < 0 || index >= options.length) {
              toast.warning('Opción no válida.');
              return;
            }
            targetSaving = options[index];
          }
        }
      }

      await Promise.all(
        relatedTx.map((tx) => {
          const nextMeta = { ...(tx.meta || {}) };
          delete nextMeta.budgetSubcategoryIds;
          delete nextMeta.budgetSubcategoryId;
          delete nextMeta.budgetSubcategoryNames;
          delete nextMeta.budgetSubcategoryName;
          delete nextMeta.budgetSubcategoryAmounts;
          delete nextMeta.budgetSubcategoryAllocations;
          if (targetSaving) {
            nextMeta.savingId = targetSaving.id;
            nextMeta.savingName = targetSaving.name || '';
            if (targetSaving.name) {
              nextMeta.budgetSubcategoryName = targetSaving.name;
            }
          } else {
            delete nextMeta.savingId;
            delete nextMeta.savingName;
          }
          return updateTransaction(tx.id, { meta: nextMeta });
        }),
      );
    }

    await removeSaving(saving.id);
  }

  function handleFormChange(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function resolveDueDate(planEntry, periodKey) {
    if (planEntry?.dueDate) return planEntry.dueDate;
    if (!periodKey) return '';
    const { end } = getBudgetPeriod(periodKey, budgetCutDay);
    const endDate = new Date(end + 'T00:00:00');
    endDate.setDate(endDate.getDate() - 1);
    return toLocalDateKey(endDate);
  }

  function planTooltip(saving, planEntry, periodKey) {
    const planned = plannedForSavingPeriod(saving, periodKey, budgetCutDay);
    const paid = saving.id ? paidForSavingPeriod(saving.id, periodKey) : 0;
    const dueDate = resolveDueDate(planEntry, periodKey);
    return `${saving.name || 'Ahorro'} | Planificado: ${planned} | Ahorrado: ${paid} | Fecha: ${dueDate || '-'}`;
  }

  function openPlanModal(saving, planEntry, defaultPeriodKey, fallbackPlanned) {
    const basePeriodKey =
      planEntry?.periodKey || defaultPeriodKey || monthKeyStr || monthKey();
    const { end } = getBudgetPeriod(basePeriodKey, budgetCutDay);
    const endDate = new Date(end + 'T00:00:00');
    endDate.setDate(endDate.getDate() - 1);
    const defaultDueDate =
      planEntry?.dueDate || toLocalDateKey(endDate);
    const plannedValue =
      planEntry && planEntry.plannedAmount != null
        ? String(planEntry.plannedAmount)
        : fallbackPlanned && Number(fallbackPlanned) > 0
          ? String(fallbackPlanned)
          : '';

    setPlanModal({
      savingId: saving.id,
      planId: planEntry?.id || null,
      periodKey: basePeriodKey,
      plannedAmount: plannedValue,
      dueDate: defaultDueDate,
    });
  }

  async function handleSavePlan(e) {
    e.preventDefault();
    if (!planModal || !updateSaving) return;

    const { savingId, planId, periodKey, plannedAmount, dueDate } = planModal;
    const saving = savings.find((s) => s.id === savingId);
    if (!saving) {
      setPlanModal(null);
      return;
    }

    let schedule = ensureScheduleArray(saving.schedule);
    if (!schedule.length) {
      schedule = buildSavingSchedule({
        goal: saving.goal,
        saved: saving.saved,
        targetDate: saving.targetDate,
        createdAt: saving.createdAt,
        budgetCutDay,
        defaultPeriods: DEFAULT_PLAN_PERIODS,
      });
    }

    const paidLinked = savingId ? paidForSavingPeriod(savingId, periodKey) : 0;
    if (planId) {
      const idx = schedule.findIndex((q) => q.id === planId);
      if (idx !== -1) {
        schedule[idx] = {
          ...schedule[idx],
          periodKey,
          plannedAmount: toNumber(plannedAmount),
          paidAmount: paidLinked,
          dueDate,
          status: computePlanStatus(plannedAmount, paidLinked),
        };
      } else {
        schedule.push({
          id: planId,
          periodKey,
          plannedAmount: toNumber(plannedAmount),
          paidAmount: paidLinked,
          dueDate,
          status: computePlanStatus(plannedAmount, paidLinked),
        });
      }
    } else {
      const existingIdx = schedule.findIndex(
        (q) => resolveSchedulePeriodKey(q, budgetCutDay) === periodKey,
      );
      if (existingIdx !== -1) {
        schedule[existingIdx] = {
          ...schedule[existingIdx],
          periodKey,
          plannedAmount: toNumber(plannedAmount),
          paidAmount: paidLinked,
          dueDate,
          status: computePlanStatus(plannedAmount, paidLinked),
        };
      } else {
        schedule.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          periodKey,
          plannedAmount: toNumber(plannedAmount),
          paidAmount: paidLinked,
          dueDate,
          status: computePlanStatus(plannedAmount, paidLinked),
        });
      }
    }

    await updateSaving(savingId, { schedule });
    setPlanModal(null);
  }
  async function handleAddSaving(e) {
    e.preventDefault();
    const goal = toNumber(form.goal);
    if (!goal || !addSaving) return;

    const saved = toNumber(form.saved);
    const createdAt = Date.now();
    const targetDate = form.targetDate || '';
    const schedule = buildSavingSchedule({
      goal,
      saved,
      targetDate,
      createdAt,
      budgetCutDay,
      defaultPeriods: DEFAULT_PLAN_PERIODS,
    });

    const payload = {
      name: form.name || 'Ahorro',
      goal,
      saved,
      targetDate,
      createdAt,
      schedule,
    };

    await addSaving(payload);
    setForm({ name: '', goal: '', saved: '', targetDate: '' });
  }

  async function handleAddSavingFromModal(e) {
    e.preventDefault();
    const goal = toNumber(form.goal);
    if (!goal || !addSaving) return;
    await handleAddSaving(e);
    setShowAddSavingModal(false);
  }

  function renderSavingForm({ onSubmit, dateInputType, submitLabel }) {
    const datePlaceholder =
      dateInputType === 'text'
        ? 'Fecha meta (YYYY-MM-DD)'
        : 'Fecha meta (opcional)';
    return (
      <form onSubmit={onSubmit} className="grid gap-3">
        <input
          className="border rounded-lg p-3 text-sm"
          placeholder="Nombre (ej. Fondo de emergencia)"
          value={form.name}
          onChange={(e) => handleFormChange('name', e.target.value)}
        />
        <div className="grid grid-cols-2 gap-2">
          <input
            className="border rounded-lg p-3 text-sm"
            type="number"
            min={0}
            step="1"
            placeholder="Meta total"
            value={form.goal}
            onChange={(e) => handleFormChange('goal', e.target.value)}
          />
          <input
            className="border rounded-lg p-3 text-sm"
            type="number"
            min={0}
            step="1"
            placeholder="Ahorro inicial (opcional)"
            value={form.saved}
            onChange={(e) => handleFormChange('saved', e.target.value)}
          />
        </div>
        <input
          className="border rounded-lg p-3 text-sm"
          type={dateInputType}
          placeholder={datePlaceholder}
          value={form.targetDate}
          onChange={(e) => handleFormChange('targetDate', e.target.value)}
          inputMode={dateInputType === 'text' ? 'text' : undefined}
        />
        <button className="px-3 py-3 rounded-xl border bg-[color:var(--primary)] text-[color:var(--primary-contrast)] text-sm font-semibold">
          {submitLabel}
        </button>
      </form>
    );
  }

  function handleSaveSavingMeta(e) {
    e.preventDefault();
    if (!savingEditModal || !updateSaving) return;

    const patch = {
      name: (savingEditModal.name || '').trim() || 'Ahorro',
      goal:
        savingEditModal.goal !== undefined && savingEditModal.goal !== ''
          ? Number(savingEditModal.goal)
          : undefined,
      targetDate: savingEditModal.targetDate || '',
    };

    updateSaving(savingEditModal.id, patch);
    setSavingEditModal(null);
  }

  const summaryPlanned = totalSavingsPlannedForPeriod(
    savings,
    currentPeriodKey,
    budgetCutDay,
  );
  const summaryPaid = totalSavingsPaidFromTransactions(
    transactions,
    currentPeriodKey,
    budgetCutDay,
  );
  const summaryPending = savings.reduce((sum, saving) => {
    const schedule = ensureScheduleArray(saving.schedule);
    if (!schedule.length) return sum;
    const pending = schedule.reduce((acc, entry) => {
      const planned = toNumber(entry.plannedAmount);
      if (planned <= 0) return acc;
      const periodKey = resolveSchedulePeriodKey(entry, budgetCutDay);
      if (!periodKey || periodKey > currentPeriodKey) return acc;
      const paid = saving.id ? paidForSavingPeriod(saving.id, periodKey) : 0;
      const remaining = planned - paid;
      return remaining > 0 ? acc + remaining : acc;
    }, 0);
    return sum + pending;
  }, 0);

  const plannedTotalsByPeriod = useMemo(() => {
    const totals = {};
    visiblePeriods.forEach((periodKey) => {
      totals[periodKey] = totalSavingsPlannedForPeriod(
        savings,
        periodKey,
        budgetCutDay,
      );
    });
    return totals;
  }, [savings, visiblePeriods, budgetCutDay]);

  const shouldHighlightPeriod = (periodKey) => {
    if (periodKey !== currentPeriodKey) return false;
    const plannedTotal = plannedTotalsByPeriod[periodKey] || 0;
    return Math.abs(plannedTotal - summaryPlanned) < 0.5;
  };

  const todayStr = todayKey();

  const paidInPeriodForModal =
    planModal && planModal.periodKey
      ? totalSavingsPaidFromTransactions(
          transactions,
          planModal.periodKey,
          budgetCutDay,
        )
      : 0;

  const linkedPaidForModal =
    planModal && planModal.savingId
      ? paidForSavingPeriod(planModal.savingId, planModal.periodKey)
      : 0;

  const plannedForModal = planModal ? toNumber(planModal.plannedAmount) : 0;
  const isModalPlanPaid =
    plannedForModal > 0 && linkedPaidForModal >= plannedForModal;

  const visibleSavings = savings.filter((s) => {
    if (!hideCompletedSavings) return true;
    const goal = toNumber(s.goal);
    if (!goal) return true;
    const saved = totalSavedForSaving(s);
    return saved < goal;
  });

  return (
    <>
      <div className="grid gap-6 w-full">
      <Card className="p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionTitle>Calendario de ahorro</SectionTitle>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="inline-flex min-h-[40px] items-center gap-1 rounded-xl bg-[color:var(--primary)] px-4 text-sm font-semibold text-[color:var(--primary-contrast)] shadow-sm active:scale-[0.98]"
              onClick={() => setShowAddSavingModal(true)}
            >
              + Agregar meta
            </button>
            <button
              type="button"
              className="text-xs font-semibold px-3 py-1.5 rounded-full border border-[color:var(--border)] text-[color:var(--text)] hover:bg-[color:var(--surface-2)]"
              onClick={() => setHideCompletedSavings((prev) => !prev)}
            >
              <span className="inline-flex items-center gap-2">
                {hideCompletedSavings ? (
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
                  {hideCompletedSavings ? 'Mostrar completados' : 'Ocultar completados'}
                </span>
              </span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="border rounded-xl p-3 bg-[color:var(--surface-1)] shadow-sm  ">
            <div className="text-xs text-[color:var(--text-muted)]">Planificado</div>
            <div className="text-lg font-semibold">
              <Money n={summaryPlanned} />
            </div>
          </div>
          <div className="border rounded-xl p-3 bg-[color:var(--surface-1)] shadow-sm  ">
            <div className="text-xs text-[color:var(--text-muted)]">Ahorrado (movimientos)</div>
            <div className="text-lg font-semibold">
              <Money n={summaryPaid} />
            </div>
          </div>
          <div className="border rounded-xl p-3 bg-[color:var(--surface-1)] shadow-sm  ">
            <div className="text-xs text-[color:var(--text-muted)]">Pendiente</div>
            <div className="text-lg font-semibold">
              <Money n={summaryPending} />
            </div>
          </div>
        </div>

        {savings.length === 0 ? (
          <div className="text-[color:var(--text-muted)]">Sin metas registradas.</div>
        ) : (
          <>
            <div className="md:hidden space-y-3">
              {visibleSavings.map((s) => {
                const goal = toNumber(s.goal);
                const saved = totalSavedForSaving(s);
                const progress =
                  goal > 0 ? (Math.min(saved, goal) / goal) * 100 : 0;
                const plannedForCurrent = plannedForSavingPeriod(
                  s,
                  currentPeriodKey,
                  budgetCutDay,
                );
                return (
                  <div
                    key={s.id || s.name + s.goal}
                    className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-1)] shadow-sm p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold whitespace-normal break-words">
                        {s.name || 'Ahorro'}
                      </div>
                      <div className="text-xs text-[color:var(--text-muted)]">
                        {Math.round(progress)}%
                      </div>
                    </div>
                    <div className="mt-2">
                      <Progress value={progress} mode="good" />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="px-3 py-1.5 text-xs rounded-lg border text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)]"
                        onClick={() =>
                          setSavingEditModal({
                            id: s.id,
                            name: s.name || '',
                            goal: s.goal != null ? String(s.goal) : '',
                            targetDate: s.targetDate || '',
                          })
                        }
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        className="px-3 py-1.5 text-xs rounded-lg border border-[color:var(--danger)]/40 text-[color:var(--danger)] hover:bg-[color:var(--danger)]/10"
                        onClick={() => handleRemoveSaving(s)}
                      >
                        Eliminar
                      </button>
                      <button
                        type="button"
                        className="px-3 py-1.5 text-xs rounded-lg border text-[color:var(--primary)] border-[color:var(--primary)]/40 bg-[color:var(--primary)]/10 hover:bg-[color:var(--primary)]/20"
                        onClick={() =>
                          openPlanModal(
                            s,
                            null,
                            currentPeriodKey,
                            plannedForCurrent,
                          )
                        }
                      >
                        Aportes
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="hidden md:block overflow-visible">
              <div className="overflow-x-hidden overflow-y-visible">
                <table className="w-full text-sm border-collapse table-fixed min-w-0">
                {[
                  <thead key="head">
                    <tr className="text-left text-xs text-[color:var(--text-muted)] border-b">
                      <th className="px-1 py-2 sm:px-2 w-20 sm:w-32">
                        Meta
                      </th>
                      <th className="hidden sm:table-cell px-1 py-2 sm:px-2 w-12 sm:w-16 text-center whitespace-normal break-words leading-tight">
                        Meta total
                      </th>
                      <th className="hidden sm:table-cell px-1 py-2 sm:px-2 w-12 sm:w-16 text-center whitespace-normal break-words leading-tight">
                        Ahorrado
                      </th>
                      <th className="hidden sm:table-cell px-1 py-2 sm:px-2 w-12 sm:w-16 text-center whitespace-normal break-words leading-tight">
                        Restante
                      </th>
                      <th className="hidden md:table-cell px-1 py-2 sm:px-2 w-20 md:w-28 text-center">
                        Progreso
                      </th>
                      {visiblePeriods.map((pk) => {
                        const isCurrent = pk === trueCurrentPeriod;
                        const plannedForHeader = plannedTotalsByPeriod[pk] || 0;
                        const highlightColumn = shouldHighlightPeriod(pk);
                        return (
                          <th
                            key={pk}
                            className={`px-1 py-2 sm:px-2 text-center w-14 sm:w-20 ${
                              highlightColumn ? 'bg-[color:var(--primary-muted)]/40' : ''
                            }`}
                          >
                            <div className="flex flex-col items-center gap-1">
                              <span className="text-[10px] leading-tight break-words text-[color:var(--text)]">
                                <Money n={plannedForHeader} />
                              </span>
                              <span
                                data-period-label="true"
                                className={`inline-flex items-center justify-center px-1 py-0.5 rounded-md text-center whitespace-normal break-words leading-tight ${
                                  isCurrent
                                    ? 'bg-[color:var(--surface-2)] text-[color:var(--text)]'
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
                    {visibleSavings.map((s) => {
                        const schedule = ensureScheduleArray(s.schedule);
                        const goal = toNumber(s.goal);
                        const saved = totalSavedForSaving(s);
                        const remaining = Math.max(goal - saved, 0);
                        const progress =
                          goal > 0
                            ? (Math.min(saved, goal) / goal) * 100
                            : 0;

                        return (
                          <tr
                            key={s.id || s.name + s.goal}
                            className="border-b last:border-b-0"
                          >
                            <td className="px-1 py-2 sm:px-2 w-20 sm:w-32 font-semibold text-[color:var(--text)] whitespace-normal break-words">
                              {s.name || 'Ahorro'}
                            </td>
                            <td className="hidden sm:table-cell px-1 py-2 sm:px-2 w-12 sm:w-16 text-center text-[color:var(--text)] break-words">
                              <Money n={goal} />
                            </td>
                            <td className="hidden sm:table-cell px-1 py-2 sm:px-2 w-12 sm:w-16 text-center text-[color:var(--text)] break-words">
                              <Money n={saved} />
                            </td>
                            <td className="hidden sm:table-cell px-1 py-2 sm:px-2 w-12 sm:w-16 text-center text-[color:var(--text)] break-words">
                              <Money n={remaining} />
                            </td>
                            <td className="hidden md:table-cell px-1 py-2 sm:px-2 w-20 md:w-28 text-center">
                              <div className="flex items-center justify-center gap-1">
                                <div className="w-20">
                                  <Progress value={progress} mode="good" />
                                </div>
                                <span className="text-[10px] text-[color:var(--text-muted)]">
                                  {progress.toFixed(1)}%
                                </span>
                              </div>
                            </td>
                            {visiblePeriods.map((pk) => {
                              const planned = plannedForSavingPeriod(
                                s,
                                pk,
                                budgetCutDay,
                              );
                              const paid = s.id
                                ? paidForSavingPeriod(s.id, pk)
                                : 0;
                              const planEntry = schedule.find(
                                (q) =>
                                  resolveSchedulePeriodKey(q, budgetCutDay) ===
                                  pk,
                              );
                              const isEmpty = planned <= 0;
                              const isPending = planned > 0 && paid < planned;
                              const isPaid = planned > 0 && paid >= planned;
                              const dueDate = resolveDueDate(planEntry, pk);
                              const isOverdue =
                                isPending && dueDate && dueDate < todayStr;
                              const cellTone = isEmpty
                                ? 'bg-[color:var(--surface-2)] border-[color:var(--border)]'
                                : isPaid
                                  ? 'bg-[color:var(--divider)] border-[color:var(--border)]'
                                  : isOverdue
                                    ? 'bg-[color:var(--danger)]/20 border-[color:var(--danger)]'
                                    : 'bg-[color:var(--primary)]/20 border-[color:var(--primary)]';
                              const textTone = isEmpty
                                ? 'text-[color:var(--text-muted)]'
                                : 'text-[color:var(--text)]';
                              const highlightColumn = shouldHighlightPeriod(pk);
                              return (
                                <td
                                  key={`${s.id}-${pk}`}
                                  className={`px-1 py-2 sm:px-2 text-center w-14 sm:w-20 ${
                                    highlightColumn ? 'bg-[color:var(--primary-muted)]/40' : ''
                                  }`}
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
                                          openPlanModal(
                                            s,
                                            planEntry || null,
                                            pk,
                                            schedule.length ? null : planned,
                                          )
                                        }
                                        data-tooltip={planTooltip(s, planEntry, pk)}
                                      >
                                        <Money n={planned} />
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        className={`w-full ${textTone} hover:text-[color:var(--text-muted)]`}
                                        data-tooltip="Agregar plan"
                                        onClick={() =>
                                          openPlanModal(s, null, pk, planned)
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
                                  aria-label="Editar meta"
                                  data-tooltip="Editar meta"
                                  onClick={() =>
                                    setSavingEditModal({
                                      id: s.id,
                                      name: s.name || '',
                                      goal: s.goal != null ? String(s.goal) : '',
                                      targetDate: s.targetDate || '',
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
                                  aria-label="Eliminar meta"
                                  data-tooltip="Eliminar meta"
                                  onClick={() => handleRemoveSaving(s)}
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
      {showAddSavingModal && (
        <div
          className="fixed inset-0 z-[60] flex items-end sm:items-start justify-center bg-black/40 backdrop-blur-sm sm:pt-16 sm:px-4"
          onClick={() => setShowAddSavingModal(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-saving-title"
            className="sheet-enter bg-[color:var(--surface-1)] rounded-t-3xl sm:rounded-2xl shadow-xl p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] w-full sm:max-w-md max-h-[92vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 id="add-saving-title" className="text-lg font-semibold">
                Nueva meta de ahorro
              </h3>
              <button
                type="button"
                className="min-h-[40px] px-2 text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                onClick={() => setShowAddSavingModal(false)}
              >
                Cerrar
              </button>
            </div>
            {renderSavingForm({
              onSubmit: handleAddSavingFromModal,
              dateInputType: 'date',
              submitLabel: 'Agregar meta',
            })}
          </div>
        </div>
      )}
      {planModal && (
        <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/30 pt-16">
          <div className="bg-[color:var(--surface-1)] rounded-2xl shadow-xl p-5 w-full max-w-md">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">
                {planModal.planId ? 'Editar aporte' : 'Nuevo aporte'}
              </h3>
              <button
                type="button"
                className="text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                onClick={() => setPlanModal(null)}
              >
                x
              </button>
            </div>

            <form onSubmit={handleSavePlan} className="grid gap-3 text-sm">
              <div className="grid gap-1">
                <label>Periodo</label>
                <select
                  className="border rounded-lg p-2"
                  value={planModal.periodKey}
                  onChange={(e) =>
                    setPlanModal((prev) => ({
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
                  value={planModal.plannedAmount}
                  onChange={(e) =>
                    setPlanModal((prev) => ({
                      ...prev,
                      plannedAmount: e.target.value,
                    }))
                  }
                  required
                />
              </div>

              <div className="grid gap-1">
                <label>Ahorrado (desde Movimientos)</label>
                <div className="border rounded-lg p-2 bg-[color:var(--surface-2)]  text-right">
                  <Money n={paidInPeriodForModal} />
                </div>
                <p className="text-xs text-[color:var(--text-muted)]">
                  El monto real proviene de las transacciones con categoria{' '}
                  {`"${SAVINGS_CATEGORY}"`} en el periodo.
                </p>
              </div>

              {planModal.savingId && (
                <div className="grid gap-1">
                  <label>Ahorrado vinculado a esta meta</label>
                  <div className="border rounded-lg p-2 bg-[color:var(--surface-2)]  text-right">
                    <Money n={linkedPaidForModal} />
                  </div>
                  <div
                    className={`text-xs font-semibold ${
                      isModalPlanPaid ? 'text-[color:var(--success)]' : 'text-[color:var(--warning)]'
                    }`}
                  >
                    {isModalPlanPaid ? 'Cumplido' : 'Pendiente por ahorrar'}
                  </div>
                </div>
              )}

              <div className="grid gap-1">
                <label>Fecha de aporte (opcional)</label>
                <input
                  type="date"
                  className="border rounded-lg p-2"
                  value={planModal.dueDate}
                  onChange={(e) =>
                    setPlanModal((prev) => ({
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
                  onClick={() => setPlanModal(null)}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-3 py-1.5 text-sm border rounded-lg bg-[color:var(--primary)] text-[color:var(--primary-contrast)]"
                >
                  Guardar plan
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {savingEditModal && (
        <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/30 pt-16">
          <div className="bg-[color:var(--surface-1)] rounded-2xl shadow-xl p-5 w-full max-w-md">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">Editar meta</h3>
              <button
                type="button"
                className="text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                onClick={() => setSavingEditModal(null)}
              >
                x
              </button>
            </div>

            <form onSubmit={handleSaveSavingMeta} className="grid gap-3 text-sm">
              <div className="grid gap-1">
                <label>Nombre</label>
                <input
                  className="border rounded-lg p-2"
                  value={savingEditModal.name}
                  onChange={(e) =>
                    setSavingEditModal((prev) => ({
                      ...prev,
                      name: e.target.value,
                    }))
                  }
                />
              </div>

              <div className="grid gap-1">
                <label>Meta total</label>
                <input
                  type="number"
                  min={0}
                  step="1"
                  className="border rounded-lg p-2"
                  value={savingEditModal.goal}
                  onChange={(e) =>
                    setSavingEditModal((prev) => ({
                      ...prev,
                      goal: e.target.value,
                    }))
                  }
                />
              </div>

              <div className="grid gap-1">
                <label>Fecha meta (opcional)</label>
                <input
                  type="date"
                  className="border rounded-lg p-2"
                  value={savingEditModal.targetDate}
                  onChange={(e) =>
                    setSavingEditModal((prev) => ({
                      ...prev,
                      targetDate: e.target.value,
                    }))
                  }
                />
              </div>

              <div className="flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  className="px-3 py-1.5 text-sm border rounded-lg"
                  onClick={() => setSavingEditModal(null)}
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




