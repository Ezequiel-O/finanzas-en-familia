// src/features/plan/CommitmentsPanel.jsx
// "Compromisos del mes" dentro de Plan del mes: cuotas que vencen, atrasadas y aportes
// de ahorro, generados solos desde Deudas y Ahorro.
import { useMemo } from 'react';
import { Card } from '../../components/ui/Card.jsx';
import { Money } from '../../components/ui/Money.jsx';
import { Progress } from '../../components/ui/Progress.jsx';
import { commitmentsForPeriod, summarizeCommitments } from '../../domain/commitments.js';
import { CommitmentList } from '../commitments/CommitmentList.jsx';
import { usePayCommitment } from '../commitments/usePayCommitment.js';

export function CommitmentsPanel({ data, actions, activeUser, periodKey, onOpenCommitments }) {
  const { debts = [], savings = [], transactions = [], budgetCutDay = 1 } = data || {};
  const items = useMemo(
    () => commitmentsForPeriod({ debts, savings, transactions, periodKey, cutDay: budgetCutDay }),
    [debts, savings, transactions, periodKey, budgetCutDay],
  );
  const totals = summarizeCommitments(items);
  const pay = usePayCommitment({ debts, savings, actions, activeUser });
  const pct = totals.planned > 0 ? (totals.paid / totals.planned) * 100 : 0;

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold">Compromisos del mes</h2>
        {onOpenCommitments && (
          <button type="button" onClick={onOpenCommitments} className="text-sm font-semibold text-[color:var(--primary)] dark:text-blue-300">
            Ver todos
          </button>
        )}
      </div>
      {items.length > 0 && (
        <div className="mt-2 space-y-1">
          <div className="flex flex-wrap justify-between gap-2 text-sm text-[color:var(--text-muted)]">
            <span>
              Pagado <strong className="text-[color:var(--text)]"><Money n={totals.paid} /></strong> de <Money n={totals.planned} />
            </span>
            <span>
              Pendiente <strong className="text-[color:var(--text)]"><Money n={totals.pending} /></strong>
              {totals.overdue > 0 && (
                <span className="text-[color:var(--danger)]">
                  {' '}(<Money n={totals.overdue} /> atrasado)
                </span>
              )}
            </span>
          </div>
          <Progress value={pct} mode="good" />
        </div>
      )}
      <div className="mt-2">
        <CommitmentList
          items={items}
          onPay={pay}
          emptyText="No tienes cuotas ni aportes de ahorro en este periodo. Agrégalos en Compromisos."
        />
      </div>
    </Card>
  );
}
