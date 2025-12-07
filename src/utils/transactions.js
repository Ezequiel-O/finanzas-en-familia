// src/utils/transactions.js
export function filterTransactionsByPeriodAndUser(
  transactions,
  monthKeyStr,
  cutDay,
  activeUser,
  onlyMine,
) {
  const mk = monthKeyStr || monthKey(new Date());
  const { start, end } = getBudgetPeriod(mk, cutDay);
  let base = Array.isArray(transactions) ? transactions : [];
  base = base.filter((t) => {
    const d = (t.date || t.createdAt || '').slice(0, 10);
    return d >= start && d < end;
  });
  if (onlyMine && activeUser?.id) {
    base = base.filter((t) => t.ownerId === activeUser.id);
  }
  return base;
}
import { monthKey, getBudgetPeriod } from './budgetPeriod.js';
