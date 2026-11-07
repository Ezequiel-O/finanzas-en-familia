// src/features/accounts/AccountsCard.jsx
// ¿Dónde está la plata? Saldo de cada cuenta del hogar (BancoEstado, Santander,
// Efectivo...), a partir del saldo real que anota cada persona.
import { useMemo, useState } from 'react';
import { Card } from '../../components/ui/Card.jsx';
import { Money } from '../../components/ui/Money.jsx';
import { confirmDialog, toast } from '../../components/feedback/feedback.js';
import {
  accountBalances,
  reconciliation,
  unassignedTransactions,
} from '../../domain/accounts.js';
import { formatShortDate, todayKey } from '../../domain/dates.js';
import { ADJUSTMENT_CATEGORY, TRANSFER_CATEGORY } from '../../domain/ledger.js';
import { formatAmountInput, formatCLP, parseAmount } from '../../domain/money.js';

const MAX_UNASSIGNED_SHOWN = 20;
const inputClass =
  'rounded-lg border bg-[color:var(--surface-1)] px-2 py-2 text-sm text-[color:var(--text)]';
const buttonClass =
  'rounded-xl border px-3 py-2 text-sm font-semibold disabled:opacity-60';
const primaryClass =
  'rounded-xl bg-[color:var(--primary)] px-3 py-2 text-sm font-semibold text-[color:var(--primary-contrast)] disabled:opacity-60';

// Color de acento de cada cuenta (el de su banco) para reconocerlas de un vistazo.
const ACCOUNT_ACCENTS = { bancoestado: '#f08a00', santander: '#e30613' };
const accentFor = (account) =>
  ACCOUNT_ACCENTS[account.bank] || (account.kind === 'cash' ? 'var(--success)' : 'var(--primary)');

function memberName(users, id) {
  const user = (users || []).find((item) => item.id === id);
  return user?.name || user?.email || '';
}

// Saldo real de cada cuenta y su dueño. Solo se reemplaza el saldo de las cuentas
// en que se escribió un monto.
function AccountsEditor({ accounts, users, onSave, onCancel }) {
  const [draft, setDraft] = useState(() =>
    accounts.map((account) => ({ id: account.id, ownerId: account.ownerId, balance: '' })),
  );
  const [saving, setSaving] = useState(false);
  const update = (id, patch) =>
    setDraft((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));

  const handleSave = async () => {
    setSaving(true);
    const now = new Date().toISOString();
    const today = todayKey();
    const next = accounts.map((account) => {
      const item = draft.find((entry) => entry.id === account.id);
      const typed = String(item?.balance || '').trim();
      return {
        ...account,
        ownerId: item?.ownerId || '',
        ...(typed
          ? { anchorBalance: parseAmount(typed), anchorDate: today, anchoredAt: now }
          : {}),
      };
    });
    try {
      await onSave(next);
      toast.success('Cuentas actualizadas.');
      onCancel();
    } catch (error) {
      console.error('No se pudieron guardar las cuentas:', { code: error?.code || 'unknown' });
      toast.error('No se pudieron guardar las cuentas. Intenta de nuevo.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 space-y-3">
      <p className="text-xs text-[color:var(--text-muted)]">
        Escribe cuánto hay hoy en cada cuenta (míralo en la app del banco o cuenta el
        efectivo). Desde ahí, la app suma y resta los movimientos que registres en esa
        cuenta. Deja en blanco las que no quieras cambiar.
      </p>
      {accounts.map((account) => {
        const item = draft.find((entry) => entry.id === account.id);
        return (
          <div
            key={account.id}
            className="grid gap-2 rounded-xl bg-[color:var(--surface-2)] p-3 sm:grid-cols-3 sm:items-end"
          >
            <div className="font-semibold">{account.name}</div>
            <label className="grid gap-1 text-xs text-[color:var(--text-muted)]">
              De quién es
              <select
                className={inputClass}
                value={item?.ownerId || ''}
                onChange={(event) => update(account.id, { ownerId: event.target.value })}
              >
                <option value="">Del hogar</option>
                {(users || []).map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name || user.email || 'Usuario'}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-[color:var(--text-muted)]">
              Saldo real hoy
              <input
                className={inputClass}
                inputMode="numeric"
                placeholder={
                  account.anchorDate ? `Anotado: ${formatCLP(account.anchorBalance)}` : '$0'
                }
                value={item?.balance || ''}
                onChange={(event) =>
                  update(account.id, { balance: formatAmountInput(event.target.value) })
                }
              />
            </label>
          </div>
        );
      })}
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonClass} onClick={onCancel} disabled={saving}>
          Cancelar
        </button>
        <button type="button" className={primaryClass} onClick={handleSave} disabled={saving}>
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </div>
  );
}

// Giro, depósito o transferencia entre cuentas propias: no cambia la plata total.
function MoveMoneyForm({ accounts, activeUser, addTransaction, onDone }) {
  const [from, setFrom] = useState(accounts[0]?.id || '');
  const [to, setTo] = useState(accounts[1]?.id || '');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayKey());
  const [saving, setSaving] = useState(false);
  const nameOf = (id) => accounts.find((account) => account.id === id)?.name || id;

  const handleSubmit = async (event) => {
    event.preventDefault();
    const value = parseAmount(amount);
    if (!from || !to || from === to) {
      toast.error('Elige dos cuentas distintas.');
      return;
    }
    if (!value) {
      toast.error('Escribe el monto.');
      return;
    }
    setSaving(true);
    const id = await addTransaction({
      type: 'gasto',
      amount: value,
      category: TRANSFER_CATEGORY,
      description: `${nameOf(from)} → ${nameOf(to)}`,
      date,
      createdAt: new Date().toISOString(),
      ownerId: activeUser?.id || null,
      ownerName: activeUser?.name || null,
      ownerEmail: activeUser?.email || null,
      meta: { kind: 'transfer', fromAccount: from, toAccount: to },
    });
    setSaving(false);
    if (!id) return;
    toast.success(`Movidos ${formatCLP(value)} de ${nameOf(from)} a ${nameOf(to)}.`);
    onDone();
  };

  return (
    <form onSubmit={handleSubmit} className="mt-3 grid gap-2 rounded-xl bg-[color:var(--surface-2)] p-3 sm:grid-cols-2">
      <label className="grid gap-1 text-xs text-[color:var(--text-muted)]">
        Desde
        <select className={inputClass} value={from} onChange={(event) => setFrom(event.target.value)}>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs text-[color:var(--text-muted)]">
        Hacia
        <select className={inputClass} value={to} onChange={(event) => setTo(event.target.value)}>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs text-[color:var(--text-muted)]">
        Monto
        <input
          className={inputClass}
          inputMode="numeric"
          placeholder="$0"
          value={amount}
          onChange={(event) => setAmount(formatAmountInput(event.target.value))}
        />
      </label>
      <label className="grid gap-1 text-xs text-[color:var(--text-muted)]">
        Fecha
        <input
          type="date"
          className={inputClass}
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
      </label>
      <p className="text-xs text-[color:var(--text-muted)] sm:col-span-2">
        Para giros, depósitos o transferencias entre cuentas de la familia. No es gasto ni
        ingreso: la plata solo cambia de lugar.
      </p>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <button type="button" className={buttonClass} onClick={onDone} disabled={saving}>
          Cancelar
        </button>
        <button type="submit" className={primaryClass} disabled={saving}>
          {saving ? 'Guardando…' : 'Mover plata'}
        </button>
      </div>
    </form>
  );
}

// Movimientos registrados después de empezar que no dicen de qué cuenta son.
function UnassignedList({ transactions, accounts, users, updateTransaction }) {
  const [busyId, setBusyId] = useState('');
  const assign = async (transaction, account) => {
    if (!account || !transaction.id) return;
    setBusyId(transaction.id);
    try {
      await updateTransaction(transaction.id, { account });
    } catch (error) {
      console.error('No se pudo asignar la cuenta:', { code: error?.code || 'unknown' });
      toast.error('No se pudo asignar la cuenta. Intenta de nuevo.');
    } finally {
      setBusyId('');
    }
  };

  return (
    <ul className="mt-2 space-y-2">
      {transactions.slice(0, MAX_UNASSIGNED_SHOWN).map((transaction) => (
        <li
          key={transaction.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[color:var(--surface-2)] px-3 py-2 text-sm"
        >
          <span className="min-w-0 flex-1">
            <span className={transaction.type === 'ingreso' ? 'text-[color:var(--success)]' : ''}>
              {transaction.type === 'ingreso' ? '+' : '−'}
              {formatCLP(transaction.amount)}
            </span>{' '}
            · {formatShortDate(transaction.date)} · {transaction.description || transaction.category || 'Sin descripción'}
            {transaction.ownerId ? ` · ${memberName(users, transaction.ownerId)}` : ''}
          </span>
          <select
            className={inputClass}
            value=""
            disabled={busyId === transaction.id}
            aria-label="Asignar cuenta"
            onChange={(event) => assign(transaction, event.target.value)}
          >
            <option value="">¿De qué cuenta?</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </li>
      ))}
      {transactions.length > MAX_UNASSIGNED_SHOWN && (
        <li className="text-xs text-[color:var(--text-muted)]">
          Y {transactions.length - MAX_UNASSIGNED_SHOWN} más. Asígnalos desde Movimientos.
        </li>
      )}
    </ul>
  );
}

// Compara la plata real (cuentas) con el saldo que calcula la app y, si no calzan,
// registra un ajuste de balance por la diferencia (no es ingreso ni gasto real).
function ReconcileBox({ check, activeUser, addTransaction }) {
  const [saving, setSaving] = useState(false);
  if (!check.complete || check.delta === 0) {
    return check.complete ? (
      <p className="mt-3 text-xs text-[color:var(--success)]">
        ✓ Cuadra con el saldo de la app (<Money n={check.appCash} />).
      </p>
    ) : null;
  }
  const missingIncome = check.delta > 0;
  const amount = Math.abs(check.delta);

  const handleReconcile = async () => {
    const ok = await confirmDialog(
      `Se registrará un ajuste de balance de ${formatCLP(amount)} con fecha de hoy para que el saldo de la app (${formatCLP(check.appCash)}) quede igual a la plata real (${formatCLP(check.realTotal)}). No cuenta como ${missingIncome ? 'ingreso' : 'gasto'} en el presupuesto.`,
      { title: 'Cuadrar saldos', confirmLabel: 'Registrar ajuste' },
    );
    if (!ok) return;
    setSaving(true);
    const id = await addTransaction({
      type: missingIncome ? 'ingreso' : 'gasto',
      amount,
      category: ADJUSTMENT_CATEGORY,
      description: 'Cuadre con los saldos reales de las cuentas',
      date: todayKey(),
      createdAt: new Date().toISOString(),
      ownerId: activeUser?.id || null,
      ownerName: activeUser?.name || null,
      ownerEmail: activeUser?.email || null,
      meta: {
        source: 'accounts-reconciliation',
        realBalance: check.realTotal,
        platformBalance: check.appCash,
        delta: check.delta,
      },
    });
    setSaving(false);
    if (id) toast.success('Saldos cuadrados.');
  };

  return (
    <div className="mt-3 rounded-xl bg-[color:var(--surface-2)] p-3 text-sm">
      <p>
        La app calcula <strong><Money n={check.appCash} /></strong> y en las cuentas hay{' '}
        <strong><Money n={check.realTotal} /></strong>: a la app le{' '}
        {missingIncome ? 'faltan' : 'sobran'} <strong><Money n={amount} /></strong>.
      </p>
      <p className="mt-1 text-xs text-[color:var(--text-muted)]">
        Primero confirma los avisos del banco pendientes y los movimientos que falten; lo
        que quede de diferencia se cuadra con un ajuste de balance.
      </p>
      <div className="mt-2 flex justify-end">
        <button type="button" className={primaryClass} onClick={handleReconcile} disabled={saving}>
          {saving ? 'Guardando…' : `Cuadrar con ajuste de ${formatCLP(amount)}`}
        </button>
      </div>
    </div>
  );
}

export function AccountsCard({ data, actions, activeUser }) {
  const { accounts = [], transactions = [], householdUsers = [] } = data || {};
  const [mode, setMode] = useState('');
  const [showUnassigned, setShowUnassigned] = useState(false);
  const today = todayKey();
  const summary = useMemo(
    () => accountBalances({ accounts, transactions, today }),
    [accounts, transactions, today],
  );
  const unassigned = useMemo(
    () => unassignedTransactions({ accounts, transactions, today }),
    [accounts, transactions, today],
  );
  const check = useMemo(
    () => reconciliation({ accounts, transactions, today }),
    [accounts, transactions, today],
  );
  const started = summary.configuredCount > 0;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase text-[color:var(--text-muted)]">¿Dónde está la plata?</div>
          {started ? (
            <div className={`text-3xl font-bold ${summary.total < 0 ? 'text-[color:var(--danger)]' : ''}`}>
              <Money n={summary.total} />
            </div>
          ) : (
            <p className="mt-1 text-sm text-[color:var(--text-muted)]">
              Anota cuánto hay hoy en cada cuenta para saber cómo está repartida la plata.
            </p>
          )}
        </div>
        <div className="flex gap-2">
          {started && accounts.length > 1 && (
            <button type="button" className={buttonClass} onClick={() => setMode(mode === 'move' ? '' : 'move')}>
              Mover plata
            </button>
          )}
          <button
            type="button"
            className={started ? buttonClass : primaryClass}
            onClick={() => setMode(mode === 'edit' ? '' : 'edit')}
          >
            {started ? 'Saldos reales' : 'Empezar'}
          </button>
        </div>
      </div>

      {mode === 'edit' && (
        <AccountsEditor
          accounts={accounts}
          users={householdUsers}
          onSave={actions.saveAccounts}
          onCancel={() => setMode('')}
        />
      )}
      {mode === 'move' && (
        <MoveMoneyForm
          accounts={accounts}
          activeUser={activeUser}
          addTransaction={actions.addTransaction}
          onDone={() => setMode('')}
        />
      )}

      {started && mode !== 'edit' && (
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {summary.accounts.map((account) => (
            <div
              key={account.id}
              className="rounded-xl border-l-4 bg-[color:var(--surface-2)] p-3"
              style={{ borderLeftColor: accentFor(account) }}
            >
              <div className="text-[11px] uppercase text-[color:var(--text-muted)]">
                {account.name}
                {account.ownerId ? ` · ${memberName(householdUsers, account.ownerId)}` : ''}
              </div>
              {account.configured ? (
                <>
                  <div className={`text-xl font-bold ${account.balance < 0 ? 'text-[color:var(--danger)]' : ''}`}>
                    <Money n={account.balance} />
                  </div>
                  <div className="text-[11px] text-[color:var(--text-faint)]">
                    Saldo real del {formatShortDate(account.anchorDate)}
                    {account.movements
                      ? ` + ${account.movements} movimiento${account.movements === 1 ? '' : 's'}`
                      : ''}
                  </div>
                </>
              ) : (
                <div className="text-sm text-[color:var(--text-muted)]">Sin saldo anotado</div>
              )}
            </div>
          ))}
        </div>
      )}

      {started && mode !== 'edit' && (
        <ReconcileBox check={check} activeUser={activeUser} addTransaction={actions.addTransaction} />
      )}

      {started && unassigned.length > 0 && mode !== 'edit' && (
        <div className="mt-3 rounded-xl border border-[color:var(--warning)] p-3">
          <button
            type="button"
            className="w-full text-left text-sm font-semibold text-[color:var(--warning)]"
            aria-expanded={showUnassigned}
            onClick={() => setShowUnassigned((value) => !value)}
          >
            {unassigned.length} movimiento{unassigned.length === 1 ? '' : 's'} sin cuenta: los
            saldos no los incluyen. {showUnassigned ? 'Ocultar' : 'Asignar'}
          </button>
          {showUnassigned && (
            <UnassignedList
              transactions={unassigned}
              accounts={accounts}
              users={householdUsers}
              updateTransaction={actions.updateTransaction}
            />
          )}
        </div>
      )}
    </Card>
  );
}
