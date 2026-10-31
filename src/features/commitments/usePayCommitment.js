// src/features/commitments/usePayCommitment.js
// Registrar el pago de una cuota o el aporte a una meta en un paso: crea el
// movimiento ya vinculado (debtId/quotaId o savingId), y todo se recalcula solo.
import { useCallback } from 'react';
import { confirmDialog, toast } from '../../components/feedback/feedback.js';
import {
  buildDebtPaymentTransaction,
  buildSavingContributionTransaction,
} from '../../domain/commitments.js';
import { todayKey } from '../../domain/dates.js';
import { formatCLP } from '../../domain/money.js';

export function usePayCommitment({ debts, savings, actions, activeUser }) {
  return useCallback(
    async (item) => {
      if (!item || item.pending <= 0 || !actions?.addTransaction) return;
      const isSaving = item.kind === 'saving';
      const verb = isSaving ? 'Aportar' : 'Pagar';
      const ok = await confirmDialog(
        `${verb} ${formatCLP(item.pending)} a "${item.name}" (${item.detail.toLowerCase()}) con fecha de hoy.\n\nSi pagaste otro monto, regístralo desde Compromisos.`,
        { title: isSaving ? 'Registrar aporte' : 'Registrar pago', confirmLabel: verb },
      );
      if (!ok) return;

      let payload;
      if (isSaving) {
        const saving = (savings || []).find((s) => s.id === item.refId);
        if (!saving) return;
        payload = buildSavingContributionTransaction({ saving, amount: item.pending, date: todayKey(), user: activeUser });
      } else {
        const debt = (debts || []).find((d) => d.id === item.refId);
        if (!debt) return;
        payload = buildDebtPaymentTransaction({
          debt,
          quotaIds: [item.quotaId],
          amount: item.pending,
          date: todayKey(),
          user: activeUser,
        });
      }

      const id = await actions.addTransaction(payload);
      if (!id) return;
      toast.success(isSaving ? `Aporte a ${item.name} registrado.` : `Pago de ${item.name} registrado.`, {
        action: {
          label: 'Deshacer',
          onClick: async () => {
            const removed = await actions.removeTransaction?.(id);
            if (removed?.trashId) await actions.purgeTrashItem?.(removed.trashId);
          },
        },
      });
    },
    [debts, savings, actions, activeUser],
  );
}
