// src/features/plan/PeriodClosingCard.jsx
// Cierre de mes conciliado: compara el saldo de la app con el saldo real de tus cuentas,
// deja registrada la diferencia y bloquea cambios en ese periodo.
import { useMemo, useState } from 'react';
import { confirmDialog, toast } from '../../components/feedback/feedback.js';
import { Card } from '../../components/ui/Card.jsx';
import { Money } from '../../components/ui/Money.jsx';
import { periodLastDay } from '../../domain/commitments.js';
import { todayKey } from '../../domain/dates.js';
import { ADJUSTMENT_CATEGORY, periodBalances } from '../../domain/ledger.js';
import { formatAmountInput, formatCLP, parseAmount } from '../../domain/money.js';
import { budgetMonthKeyForDate, formatBudgetPeriodLabel } from '../../utils/budgetPeriod.js';

function formatClosedAt(value) {
  const d = typeof value?.toDate === 'function' ? value.toDate() : null;
  return d ? d.toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
}

export function PeriodClosingCard({ data, actions, activeUser, periodKey, isOwner }) {
  const { transactions = [], budgetCutDay = 1, closings = {} } = data || {};
  // Se compara con las cuentas reales el saldo A HOY: lo registrado con fecha futura aún no está en el banco.
  const balances = useMemo(
    () => periodBalances({ transactions, periodKey, cutDay: budgetCutDay, today: todayKey() }),
    [transactions, periodKey, budgetCutDay],
  );
  const appBalance = balances.atToday;
  const closing = closings[periodKey];
  const isClosed = closing?.status === 'closed';
  const currentPk = budgetMonthKeyForDate(todayKey(), budgetCutDay);
  const isFuture = periodKey > currentPk;
  const [bankInput, setBankInput] = useState('');
  const [busy, setBusy] = useState(false);

  const bank = parseAmount(bankInput);
  const hasBank = bankInput.trim() !== '';
  const difference = hasBank ? bank - appBalance : 0;
  const label = formatBudgetPeriodLabel(periodKey, budgetCutDay);

  async function close({ withAdjustment }) {
    if (!actions?.closePeriod || busy) return;
    const ok = await confirmDialog(
      `Cerrar el periodo ${label}.\n\nSaldo según la app a hoy: ${formatCLP(appBalance)}\nSaldo real: ${formatCLP(bank)}\nDiferencia: ${formatCLP(difference)}\n\nDespués no se podrán agregar, editar ni borrar movimientos de este periodo, salvo que el dueño lo reabra.`,
      { title: 'Cerrar y conciliar', confirmLabel: 'Cerrar periodo' },
    );
    if (!ok) return;
    setBusy(true);
    try {
      if (withAdjustment && difference !== 0) {
        const date = [periodLastDay(periodKey, budgetCutDay), todayKey()].sort()[0];
        const id = await actions.addTransaction({
          type: difference > 0 ? 'ingreso' : 'gasto',
          amount: Math.abs(difference),
          category: ADJUSTMENT_CATEGORY,
          description: `Ajuste de conciliación ${label}`,
          date,
          createdAt: new Date().toISOString(),
          ownerId: activeUser?.id || null,
          ownerName: activeUser?.name || null,
          ownerEmail: activeUser?.email || null,
          meta: { kind: 'adjustment', source: 'period-closing', periodKey },
        });
        if (!id) return;
      }
      await actions.closePeriod({ periodKey, appBalance, bankBalance: bank });
      setBankInput('');
      toast.success(`Periodo ${label} cerrado y conciliado.`);
    } catch (err) {
      console.error('Error cerrando periodo', { code: err?.code });
      toast.error('No se pudo cerrar el periodo.');
    } finally {
      setBusy(false);
    }
  }

  async function reopen() {
    const ok = await confirmDialog(
      `Reabrir el periodo ${label}? Se podrán volver a modificar sus movimientos y quedará registrado en el historial.`,
      { title: 'Reabrir periodo', confirmLabel: 'Reabrir' },
    );
    if (ok) await actions?.reopenPeriod?.(periodKey);
  }

  if (isFuture) return null;

  return (
    <Card>
      <h2 className="text-lg font-semibold">Cierre del periodo</h2>
      {isClosed ? (
        <div className="mt-2 space-y-2 text-sm">
          <div className="font-semibold text-[color:var(--success)]">✓ Cerrado y conciliado</div>
          <div className="grid gap-1 text-[color:var(--text-muted)] sm:grid-cols-3">
            <span>Según la app: <strong className="text-[color:var(--text)]"><Money n={closing.appBalance} /></strong></span>
            <span>Saldo real: <strong className="text-[color:var(--text)]"><Money n={closing.bankBalance} /></strong></span>
            <span>
              Diferencia:{' '}
              <strong className={closing.difference ? 'text-[color:var(--warning)]' : 'text-[color:var(--text)]'}>
                <Money n={closing.difference} />
              </strong>
            </span>
          </div>
          <div className="text-xs text-[color:var(--text-faint)]">
            {closing.closedByName ? `Por ${closing.closedByName}` : ''} {formatClosedAt(closing.closedAt)}
          </div>
          {isOwner && (
            <button type="button" onClick={reopen} className="min-h-[40px] px-3 rounded-lg border border-[color:var(--border)] text-sm">
              Reabrir periodo
            </button>
          )}
        </div>
      ) : (
        <div className="mt-2 space-y-3 text-sm">
          <p className="text-[color:var(--text-muted)]">
            Al terminar el periodo, compara con tus cuentas reales (banco + efectivo). Si no calza, la diferencia queda
            registrada como ajuste de conciliación, separada de ingresos y gastos.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <div className="text-xs text-[color:var(--text-muted)]">Saldo según la app a hoy</div>
              <div className="text-lg font-semibold"><Money n={appBalance} /></div>
              {balances.projected !== appBalance && (
                <div className="text-xs text-[color:var(--text-muted)]">
                  Con lo registrado a futuro: <Money n={balances.projected} />
                </div>
              )}
            </div>
            <label className="flex-1 min-w-[180px]">
              <span className="text-xs text-[color:var(--text-muted)]">Saldo real en tus cuentas</span>
              <input
                value={bankInput}
                onChange={(e) => setBankInput(formatAmountInput(e.target.value))}
                inputMode="numeric"
                placeholder="0"
                className="mt-1 w-full min-h-[44px] rounded-xl border border-[color:var(--border)] bg-[color:var(--input-bg)] px-3 text-sm"
              />
            </label>
            {hasBank && (
              <div>
                <div className="text-xs text-[color:var(--text-muted)]">Diferencia</div>
                <div className={`text-lg font-semibold ${difference ? 'text-[color:var(--warning)]' : 'text-[color:var(--success)]'}`}>
                  {difference ? <Money n={difference} /> : 'Cuadra ✓'}
                </div>
              </div>
            )}
          </div>
          {hasBank && (
            <div className="flex flex-wrap gap-2">
              {difference !== 0 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => close({ withAdjustment: true })}
                  className="min-h-[44px] px-4 rounded-xl bg-[color:var(--primary)] text-[color:var(--primary-contrast)] text-sm font-semibold disabled:opacity-60"
                >
                  Registrar diferencia como ajuste y cerrar
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => close({ withAdjustment: false })}
                className={`min-h-[44px] px-4 rounded-xl text-sm font-semibold disabled:opacity-60 ${
                  difference === 0
                    ? 'bg-[color:var(--primary)] text-[color:var(--primary-contrast)]'
                    : 'border border-[color:var(--border)]'
                }`}
              >
                {difference === 0 ? 'Cerrar periodo' : 'Cerrar sin ajustar'}
              </button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
