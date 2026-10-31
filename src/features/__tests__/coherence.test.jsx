// @vitest-environment jsdom
// Auditoría de coherencia: con los mismos datos, todas las pantallas deben mostrar
// el mismo saldo, el mismo ingreso y el mismo gasto por categoría.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedbackHost } from '../../components/feedback/FeedbackHost.jsx';
import { categoryBudgetStatus } from '../../domain/budgetHealth.js';
import { periodLedger } from '../../domain/ledger.js';
import { formatCLP } from '../../domain/money.js';
import { Budgets } from '../../modules/budgets/Budgets.jsx';
import { Dashboard } from '../../modules/dashboard/Dashboard.jsx';
import { Transactions } from '../../modules/transactions/Transactions.jsx';
import { FinancialHealthCard } from '../plan/FinancialHealthCard.jsx';
import { PeriodClosingCard } from '../plan/PeriodClosingCard.jsx';

afterEach(cleanup);

const pk = '2026-10';
const categories = ['Ahorro', 'Deudas', 'Alimentación', 'Transporte', 'Otros'];
const debts = [{ id: 'd1', name: 'Tarjeta', original: 200000, schedule: [{ id: 'q1', periodKey: pk, dueDate: '2026-10-05', plannedAmount: 100000 }] }];
const savings = [{ id: 's1', name: 'Emergencia', goal: 1000000, saved: 0 }];
const transactions = [
  { id: 'a', type: 'ingreso', amount: 1000000, category: '', date: '2026-09-01' },
  { id: 'b', type: 'gasto', amount: 700000, category: 'Alimentación', date: '2026-09-15' },
  { id: 'c', type: 'ingreso', amount: 1200000, category: '', date: '2026-10-01' },
  { id: 'd', type: 'gasto', amount: 150000, category: 'Alimentación', date: '2026-10-02' },
  { id: 'e', type: 'ingreso', amount: 10000, category: 'Alimentación', date: '2026-10-03', meta: { kind: 'refund' } },
  { id: 'f', type: 'gasto', amount: 100000, category: 'Deudas', date: '2026-10-05', meta: { debtId: 'd1', debtQuotaIds: ['q1'] } },
  { id: 'g', type: 'gasto', amount: 200000, category: 'Ahorro', date: '2026-10-06', meta: { savingId: 's1' } },
  { id: 'h', type: 'ingreso', amount: 50000, category: 'Ahorro', date: '2026-10-07', meta: { kind: 'saving_withdrawal', savingId: 's1' } },
  { id: 'i', type: 'gasto', amount: 80000, category: 'Traspaso', date: '2026-10-08', meta: { kind: 'transfer' } },
  { id: 'j', type: 'ingreso', amount: 3000, category: 'Ajuste Balance', date: '2026-10-09', meta: { source: 'balance-calculator' } },
];
const budgets = { Alimentación: { plan: 300000, funded: 300000 } };
const budgetsAll = { [pk]: budgets };
const actions = new Proxy({}, { get: () => vi.fn().mockResolvedValue(null) });

// 300.000 sobrante de septiembre + 1.200.000 + 10.000 + 50.000 + 3.000 − 150.000 − 100.000 − 200.000
const EXPECTED_CLOSING = 1113000;

describe('coherencia entre pantallas', () => {
  it('el libro cuadra', () => {
    const l = periodLedger({ transactions, periodKey: pk, cutDay: 1, debts });
    expect(l.opening).toBe(300000);
    expect(l.closing).toBe(EXPECTED_CLOSING);
    expect(l.income).toBe(1200000); // sin ajuste, retiro ni reembolso
  });

  it('Inicio, Plan y Movimientos muestran el mismo saldo', () => {
    const closing = formatCLP(EXPECTED_CLOSING);

    render(<Dashboard data={{ categories, budgets, budgetsAll, transactions, debts, savings, budgetCutDay: 1 }} monthKeyStr={pk} />);
    expect(screen.getAllByText(closing).length).toBeGreaterThan(0);
    cleanup();

    // En Plan, el saldo está en el cierre del periodo (dentro de "Ver detalle").
    render(<PeriodClosingCard data={{ transactions, debts, budgetCutDay: 1 }} actions={actions} periodKey={pk} />);
    expect(screen.getAllByText(closing).length).toBeGreaterThan(0);
    cleanup();

    render(
      <Transactions
        data={{ transactions, categories, debts, savings, budgets, budgetsAll, householdUsers: [] }}
        actions={actions}
        activeUser={{ id: 'u1' }}
        monthKeyStr={pk}
        budgetCutDay={1}
      />,
    );
    expect(document.body.textContent).toContain(closing);
  });

  it('el gasto de la categoría descuenta reembolsos igual en Plan y en el registro rápido', () => {
    const status = categoryBudgetStatus({ budgetsAll, transactions, cutDay: 1, category: 'Alimentación', periodKey: pk });
    expect(status).toEqual({ funded: 300000, spent: 140000, remaining: 160000 });
    render(<Budgets data={{ budgets, budgetsAll, transactions, categories, budgetCutDay: 1, debts, savings }} actions={actions} monthKeyStr={pk} />);
    expect(screen.getAllByText(formatCLP(140000)).length).toBeGreaterThan(0);
  });

  it('la tarjeta de salud usa el mismo saldo y descuenta el retiro del ahorro', () => {
    render(<FinancialHealthCard data={{ transactions, debts, savings, budgetCutDay: 1 }} periodKey={pk} />);
    // patrimonio = 1.113.000 + ahorro (200.000 − 50.000) − deuda (200.000 − 100.000)
    expect(screen.getByText(formatCLP(EXPECTED_CLOSING + 150000 - 100000))).toBeTruthy();
  });
});

describe('cierre de periodo', () => {
  it('registra la diferencia como ajuste (no ingreso) y cierra', async () => {
    const addTransaction = vi.fn().mockResolvedValue('adj-1');
    const closePeriod = vi.fn().mockResolvedValue();
    render(
      <>
        <PeriodClosingCard
          data={{ transactions, debts, budgetCutDay: 1, closings: {} }}
          actions={{ addTransaction, closePeriod }}
          activeUser={{ id: 'u1' }}
          periodKey={pk}
          isOwner
        />
        <FeedbackHost />
      </>,
    );
    fireEvent.change(screen.getByLabelText('Saldo real en tus cuentas'), { target: { value: '1100000' } });
    expect(screen.getByText('-$13.000')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Registrar diferencia como ajuste y cerrar' }));
    await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cerrar periodo' }));
    });
    await waitFor(() => expect(closePeriod).toHaveBeenCalled());
    expect(addTransaction.mock.calls[0][0]).toMatchObject({
      type: 'gasto',
      amount: 13000,
      category: 'Ajuste Balance',
      meta: { kind: 'adjustment', periodKey: pk },
    });
    expect(closePeriod).toHaveBeenCalledWith({ periodKey: pk, appBalance: EXPECTED_CLOSING, bankBalance: 1100000 });
  });

  it('un periodo cerrado muestra la conciliación y solo el dueño puede reabrir', () => {
    const closings = { [pk]: { status: 'closed', appBalance: 100, bankBalance: 100, difference: 0, closedByName: 'Eze' } };
    render(<PeriodClosingCard data={{ transactions, closings }} actions={{}} periodKey={pk} isOwner={false} />);
    expect(screen.getByText(/Cerrado y conciliado/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reabrir periodo' })).toBeNull();
  });
});
