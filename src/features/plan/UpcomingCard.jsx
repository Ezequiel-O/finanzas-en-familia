// src/features/plan/UpcomingCard.jsx
// Para Inicio: lo que vence en los próximos 7 días (y lo atrasado), con pago en un toque.
import { useMemo } from 'react';
import { Card } from '../../components/ui/Card.jsx';
import { commitmentsForPeriod } from '../../domain/commitments.js';
import { addDaysToKey, todayKey } from '../../domain/dates.js';
import { budgetMonthKeyForDate } from '../../utils/budgetPeriod.js';
import { CommitmentList } from '../commitments/CommitmentList.jsx';
import { usePayCommitment } from '../commitments/usePayCommitment.js';

export function UpcomingCard({ data, actions, activeUser, onOpenPlan }) {
  const { debts = [], savings = [], transactions = [], budgetCutDay = 1 } = data || {};
  const today = todayKey();
  const items = useMemo(() => {
    const limit = addDaysToKey(today, 7);
    const current = budgetMonthKeyForDate(today, budgetCutDay);
    const next = budgetMonthKeyForDate(addDaysToKey(today, 8), budgetCutDay);
    const keys = Array.from(new Set([current, next]));
    const all = keys.flatMap((pk) =>
      commitmentsForPeriod({ debts, savings, transactions, periodKey: pk, cutDay: budgetCutDay, today }),
    );
    const seen = new Set();
    return all
      .filter((i) => i.status !== 'paid' && (i.isOverdue || (i.dueDate >= today && i.dueDate <= limit)))
      .filter((i) => (seen.has(i.key) ? false : seen.add(i.key)));
  }, [debts, savings, transactions, budgetCutDay, today]);
  const pay = usePayCommitment({ debts, savings, actions, activeUser });

  if (!items.length) return null;
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Por pagar esta semana</h2>
        {onOpenPlan && (
          <button type="button" onClick={onOpenPlan} className="text-sm font-semibold text-[color:var(--primary)] dark:text-blue-300">
            Ver plan del mes
          </button>
        )}
      </div>
      <CommitmentList items={items} onPay={pay} />
    </Card>
  );
}
