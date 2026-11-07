// src/features/quick-add/QuickAddSheet.jsx
// Registro rápido de un gasto o ingreso: monto primero (teclado numérico),
// categorías como botones ordenadas por uso, fecha "hoy" por defecto y texto libre
// opcional ("súper 15 lucas"). Al guardar muestra cuánto queda en la categoría y
// ofrece "Deshacer".
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from '../../components/feedback/feedback.js';
import { categoryBudgetStatus } from '../../domain/budgetHealth.js';
import { addDaysToKey, todayKey } from '../../domain/dates.js';
import { TRANSFER_CATEGORY } from '../../domain/ledger.js';
import { formatAmountInput, formatCLP, parseAmount } from '../../domain/money.js';
import { parseQuickEntry, rankCategories } from '../../domain/quickEntry.js';
import { budgetMonthKeyForDate } from '../../utils/budgetPeriod.js';
import { confirmWithinCash } from '../cash/confirmWithinCash.js';

const STORAGE_KEY = 'fef.quickAdd.last';
const VISIBLE_CHIPS = 6;

function readLast() {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function writeLast(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Sin almacenamiento local (modo privado): solo se pierde el recordatorio.
  }
}

// Cuánto queda en la categoría en el periodo de `date` después del movimiento nuevo,
// con la misma fórmula que la tabla de Presupuestos. `delta` es + para gasto, − para reembolso.
function remainingAfter({ category, delta, date, budgetsAll, transactions, cutDay, fixedCategories }) {
  const periodKey = budgetMonthKeyForDate(date, cutDay);
  const status = categoryBudgetStatus({ budgetsAll, transactions, cutDay, category, periodKey, fixedCategories });
  if (status.funded <= 0) return null;
  return status.remaining - delta;
}

const TYPE_LABEL = { gasto: 'Gasto', ingreso: 'Ingreso', traspaso: 'Traspaso' };

export function QuickAddSheet({
  open,
  onClose,
  categories = [],
  budgetsAll = {},
  transactions = [],
  budgetCutDay = 1,
  fixedCategories = {},
  householdUsers = [],
  accounts = [],
  activeUser,
  actions,
  initialType = 'gasto',
}) {
  // Cuenta sugerida: la del miembro (su banco); si no tiene, sin indicar.
  const memberAccount = (memberId) =>
    accounts.find((account) => account.ownerId && account.ownerId === memberId)?.id || '';
  const [accountId, setAccountId] = useState('');
  const members = (householdUsers || []).filter((u) => u?.id);
  const canTransfer = members.length >= 2;
  const [isRefund, setIsRefund] = useState(false);
  const [fromUserId, setFromUserId] = useState('');
  const [toUserId, setToUserId] = useState('');
  const today = todayKey();
  const [type, setType] = useState(initialType);
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [subcategoryId, setSubcategoryId] = useState('');
  const [date, setDate] = useState(today);
  const [description, setDescription] = useState('');
  const [quickText, setQuickText] = useState('');
  const [showAllCats, setShowAllCats] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const amountRef = useRef(null);

  const ranked = useMemo(
    () => rankCategories(categories, transactions, { today, ownerId: activeUser?.id }),
    [categories, transactions, today, activeUser?.id],
  );

  // Ref para precargar la categoría al abrir sin reiniciar el formulario cada vez que
  // llegan movimientos nuevos desde Firestore.
  const rankedRef = useRef(ranked);
  rankedRef.current = ranked;
  const activeUserIdRef = useRef(activeUser?.id);
  activeUserIdRef.current = activeUser?.id;
  const memberAccountRef = useRef(memberAccount);
  memberAccountRef.current = memberAccount;

  const periodKey = budgetMonthKeyForDate(date || today, budgetCutDay);
  const subcategories = useMemo(() => {
    const entry = budgetsAll?.[periodKey]?.[category];
    return Array.isArray(entry?.breakdown) ? entry.breakdown.filter((b) => b?.id && b?.name) : [];
  }, [budgetsAll, periodKey, category]);

  // Al abrir: limpiar y precargar la última categoría usada.
  useEffect(() => {
    if (!open) return;
    const last = readLast();
    setType(initialType);
    setAmount('');
    setDescription('');
    setQuickText('');
    setDate(todayKey());
    setShowAllCats(false);
    setShowMore(false);
    setIsRefund(false);
    setFromUserId(activeUserIdRef.current || '');
    setToUserId('');
    setAccountId(memberAccountRef.current(activeUserIdRef.current));
    const options = rankedRef.current;
    const lastCat = last.category && options.includes(last.category) ? last.category : options[0] || '';
    setCategory(lastCat);
    setSubcategoryId(last.subcategoryByCategory?.[lastCat] || '');
    const t = setTimeout(() => amountRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open, initialType]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  const amountValue = parseAmount(amount);
  const visibleCats = showAllCats ? ranked : ranked.slice(0, VISIBLE_CHIPS);
  if (category && !visibleCats.includes(category) && ranked.includes(category)) {
    visibleCats.push(category);
  }

  function applyQuickText() {
    const parsed = parseQuickEntry(quickText, { categories, transactions, today });
    if (parsed.amount) setAmount(formatAmountInput(String(parsed.amount)));
    setType(parsed.type);
    if (parsed.category) {
      setCategory(parsed.category);
      setSubcategoryId('');
    }
    if (parsed.description) setDescription(parsed.description);
    if (parsed.date) setDate(parsed.date);
    if (!parsed.amount) toast.info('No encontré un monto en el texto. Escríbelo arriba.');
  }

  const usesCategory = type === 'gasto' || (type === 'ingreso' && isRefund);
  const memberName = (id) => members.find((u) => u.id === id)?.name || 'Miembro';

  function buildPayload() {
    const base = {
      type: type === 'ingreso' ? 'ingreso' : 'gasto',
      amount: amountValue,
      description: description.trim(),
      date: date || today,
      createdAt: new Date().toISOString(),
      ownerId: activeUser?.id || null,
      ownerName: activeUser?.name || null,
      ownerEmail: activeUser?.email || null,
    };
    if (type === 'traspaso') {
      // No cambia la caja del hogar: no es gasto ni ingreso. Si cada miembro tiene
      // su cuenta, la plata pasa de una cuenta a la otra.
      const fromAccount = memberAccount(fromUserId);
      const toAccount = memberAccount(toUserId);
      return {
        ...base,
        category: TRANSFER_CATEGORY,
        description: base.description || `Traspaso de ${memberName(fromUserId)} a ${memberName(toUserId)}`,
        meta: {
          kind: 'transfer',
          fromUserId,
          fromUserName: memberName(fromUserId),
          toUserId,
          toUserName: memberName(toUserId),
          ...(fromAccount && toAccount && fromAccount !== toAccount ? { fromAccount, toAccount } : {}),
        },
      };
    }
    base.account = accountId || null;
    if (type === 'ingreso') {
      // Un reembolso descuenta el gasto de su categoría; no es ingreso.
      return isRefund
        ? { ...base, category, meta: { kind: 'refund' } }
        : { ...base, category: '' };
    }
    const sub = subcategories.find((x) => x.id === subcategoryId);
    return {
      ...base,
      category,
      ...(sub ? { meta: { budgetSubcategoryIds: [sub.id], budgetSubcategoryNames: sub.name } } : {}),
    };
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (saving) return;
    if (amountValue <= 0) {
      toast.warning('Ingresa un monto mayor a 0.');
      amountRef.current?.focus();
      return;
    }
    if (usesCategory && !category) {
      toast.warning('Elige una categoría.');
      return;
    }
    if (type === 'traspaso' && (!fromUserId || !toUserId || fromUserId === toUserId)) {
      toast.warning('Elige quién envía y quién recibe (deben ser distintos).');
      return;
    }
    const payload = buildPayload();
    if (type === 'gasto' && !(await confirmWithinCash({ amount: amountValue, transactions }))) return;

    setSaving(true);
    const remaining = usesCategory
      ? remainingAfter({
          category,
          delta: type === 'gasto' ? amountValue : -amountValue,
          date: payload.date,
          budgetsAll,
          transactions,
          cutDay: budgetCutDay,
          fixedCategories,
        })
      : null;
    const id = await actions?.addTransaction?.(payload);
    setSaving(false);
    if (!id) return; // el hook ya mostró el error

    if (type === 'gasto') {
      const last = readLast();
      writeLast({
        category,
        subcategoryByCategory: { ...(last.subcategoryByCategory || {}), [category]: subcategoryId || '' },
      });
    }

    const base =
      type === 'traspaso'
        ? `Traspaso de ${formatCLP(amountValue)} registrado (no cambia el saldo del hogar).`
        : type === 'ingreso'
          ? isRefund
            ? `Reembolso de ${formatCLP(amountValue)} descontado de ${category}.`
            : `Ingreso de ${formatCLP(amountValue)} guardado.`
          : `Gasto de ${formatCLP(amountValue)} guardado.`;
    const detail =
      remaining === null
        ? ''
        : remaining >= 0
          ? ` Te quedan ${formatCLP(remaining)} en ${category}.`
          : ` Te pasaste por ${formatCLP(-remaining)} en ${category}.`;
    toast.show({
      message: base + detail,
      tone: remaining !== null && remaining < 0 ? 'warning' : 'success',
      action: {
        label: 'Deshacer',
        onClick: async () => {
          const removed = await actions?.removeTransaction?.(id);
          if (removed?.trashId) await actions?.purgeTrashItem?.(removed.trashId);
        },
      },
    });
    onClose();
  }

  const chip = (active) =>
    `min-h-[44px] px-3 rounded-xl border text-sm transition ${
      active
        ? 'bg-[color:var(--primary)] text-[color:var(--primary-contrast)] border-[color:var(--primary)]'
        : 'bg-[color:var(--surface-2)] border-[color:var(--border)] text-[color:var(--text)]'
    }`;

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex items-end md:items-center justify-center bg-black/40" onClick={onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-add-title"
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="sheet-enter w-full md:max-w-md max-h-[92vh] overflow-y-auto rounded-t-3xl md:rounded-3xl bg-[color:var(--surface-1)] text-[color:var(--text)] shadow-xl p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] space-y-4"
      >
        <div className="flex items-center justify-between">
          <h2 id="quick-add-title" className="text-lg font-semibold">
            {type === 'gasto' ? 'Registrar gasto' : type === 'ingreso' ? 'Registrar ingreso' : 'Registrar traspaso'}
          </h2>
          <button type="button" onClick={onClose} className="min-h-[44px] px-2 text-sm text-[color:var(--text-muted)]">
            Cerrar
          </button>
        </div>

        <div
          className={`grid ${canTransfer ? 'grid-cols-3' : 'grid-cols-2'} gap-2 rounded-xl bg-[color:var(--surface-2)] p-1`}
          role="radiogroup"
          aria-label="Tipo de movimiento"
        >
          {(canTransfer ? ['gasto', 'ingreso', 'traspaso'] : ['gasto', 'ingreso']).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              onClick={() => setType(t)}
              className={`min-h-[40px] rounded-lg text-sm font-semibold ${
                type === t ? 'bg-[color:var(--surface-1)] shadow-sm' : 'text-[color:var(--text-muted)]'
              }`}
            >
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>

        <label className="block">
          <span className="sr-only">Monto</span>
          <div className="flex items-center gap-2 rounded-2xl border border-[color:var(--border)] bg-[color:var(--input-bg)] px-4 focus-within:ring-2 focus-within:ring-[color:var(--primary)]">
            <span className="text-2xl font-semibold text-[color:var(--text-muted)]">$</span>
            <input
              ref={amountRef}
              value={amount}
              onChange={(e) => setAmount(formatAmountInput(e.target.value))}
              inputMode="numeric"
              pattern="[0-9.]*"
              autoComplete="off"
              placeholder="0"
              aria-label="Monto en pesos"
              className="w-full bg-transparent py-3 text-3xl font-bold outline-none"
            />
          </div>
        </label>

        {type === 'ingreso' && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isRefund} onChange={(e) => setIsRefund(e.target.checked)} />
            Es un reembolso o devolución de una compra
          </label>
        )}

        {type === 'traspaso' && (
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-[color:var(--text-muted)]">
              De
              <select
                value={fromUserId}
                onChange={(e) => setFromUserId(e.target.value)}
                className="mt-1 w-full min-h-[44px] rounded-xl border border-[color:var(--border)] bg-[color:var(--input-bg)] px-2 text-sm text-[color:var(--text)]"
              >
                <option value="">Elegir…</option>
                {members.map((u) => (
                  <option key={u.id} value={u.id}>{u.name || u.email || 'Miembro'}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-[color:var(--text-muted)]">
              Para
              <select
                value={toUserId}
                onChange={(e) => setToUserId(e.target.value)}
                className="mt-1 w-full min-h-[44px] rounded-xl border border-[color:var(--border)] bg-[color:var(--input-bg)] px-2 text-sm text-[color:var(--text)]"
              >
                <option value="">Elegir…</option>
                {members.map((u) => (
                  <option key={u.id} value={u.id}>{u.name || u.email || 'Miembro'}</option>
                ))}
              </select>
            </label>
            <p className="col-span-2 text-xs text-[color:var(--text-faint)]">
              Un traspaso entre miembros no es gasto ni ingreso: no cambia el saldo del hogar.
            </p>
          </div>
        )}

        {usesCategory && (
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold uppercase text-[color:var(--text-muted)]">Categoría</legend>
            <div className="flex flex-wrap gap-2">
              {visibleCats.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={chip(category === c)}
                  aria-pressed={category === c}
                  onClick={() => {
                    setCategory(c);
                    setSubcategoryId(readLast().subcategoryByCategory?.[c] || '');
                  }}
                >
                  {c}
                </button>
              ))}
              {ranked.length > VISIBLE_CHIPS && (
                <button type="button" className={chip(false)} onClick={() => setShowAllCats((v) => !v)}>
                  {showAllCats ? 'Menos' : 'Más…'}
                </button>
              )}
            </div>
            {type === 'gasto' && subcategories.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {subcategories.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`${chip(subcategoryId === s.id)} min-h-[36px] text-xs`}
                    aria-pressed={subcategoryId === s.id}
                    onClick={() => setSubcategoryId((prev) => (prev === s.id ? '' : s.id))}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            )}
            {type === 'gasto' && (
              <div className="rounded-xl border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10 px-3 py-2 text-xs">
                <strong>¿Pagaste con tarjeta de crédito?</strong> No lo registres aquí: se cuenta como gasto
                cuando pagas la cuota (en Plan del mes). Así no se cuenta dos veces.
              </div>
            )}
            <p className="text-xs text-[color:var(--text-faint)]">
              Las cuotas y los aportes de ahorro se registran desde Plan del mes.
            </p>
          </fieldset>
        )}

        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Fecha">
          {[
            { label: 'Hoy', value: today },
            { label: 'Ayer', value: addDaysToKey(today, -1) },
          ].map((opt) => (
            <button
              key={opt.label}
              type="button"
              role="radio"
              aria-checked={date === opt.value}
              className={chip(date === opt.value)}
              onClick={() => setDate(opt.value)}
            >
              {opt.label}
            </button>
          ))}
          <input
            type="date"
            value={date}
            max={addDaysToKey(today, 365)}
            onChange={(e) => setDate(e.target.value)}
            aria-label="Otra fecha"
            className="min-h-[44px] rounded-xl border border-[color:var(--border)] bg-[color:var(--input-bg)] px-3 text-sm"
          />
        </div>

        {type !== 'traspaso' && accounts.length > 0 && (
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Cuenta">
            {accounts.map((account) => (
              <button
                key={account.id}
                type="button"
                role="radio"
                aria-checked={accountId === account.id}
                className={chip(accountId === account.id)}
                onClick={() => setAccountId((prev) => (prev === account.id ? '' : account.id))}
              >
                {account.name}
              </button>
            ))}
          </div>
        )}

        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={200}
          placeholder="Descripción (opcional)"
          className="w-full min-h-[44px] rounded-xl border border-[color:var(--border)] bg-[color:var(--input-bg)] px-3 text-sm"
        />

        <div>
          <button
            type="button"
            className="text-xs font-semibold text-[color:var(--primary)] dark:text-blue-300"
            onClick={() => setShowMore((v) => !v)}
            aria-expanded={showMore}
          >
            {showMore ? 'Ocultar texto rápido' : 'Escribir en una frase (ej. “súper 15 lucas”)'}
          </button>
          {showMore && (
            <div className="mt-2 flex gap-2">
              <input
                value={quickText}
                onChange={(e) => setQuickText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    applyQuickText();
                  }
                }}
                maxLength={200}
                placeholder="bencina 30 mil ayer"
                className="flex-1 min-h-[44px] rounded-xl border border-[color:var(--border)] bg-[color:var(--input-bg)] px-3 text-sm"
              />
              <button type="button" className={chip(false)} onClick={applyQuickText}>
                Aplicar
              </button>
            </div>
          )}
        </div>

        <button
          type="submit"
          disabled={saving}
          className="w-full min-h-[52px] rounded-2xl bg-[color:var(--primary)] text-[color:var(--primary-contrast)] text-base font-semibold disabled:opacity-60"
        >
          {saving ? 'Guardando…' : amountValue > 0 ? `Guardar ${formatCLP(amountValue)}` : 'Guardar'}
        </button>
      </form>
    </div>,
    document.body,
  );
}
