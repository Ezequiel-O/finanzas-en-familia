// @vitest-environment jsdom
// Renderiza cada pestaña con datos de ejemplo para detectar errores en tiempo de ejecución.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Budgets } from '../../modules/budgets/Budgets.jsx';
import { Dashboard } from '../../modules/dashboard/Dashboard.jsx';
import { Transactions } from '../../modules/transactions/Transactions.jsx';
import { CommitmentsPage } from '../commitments/CommitmentsPage.jsx';
import { PlanScreen } from '../plan/PlanCards.jsx';

afterEach(cleanup);

const pk = '2026-10';
const categories = ['Ahorro', 'Deudas', 'Hogar', 'Alimentación', 'Transporte', 'Otros'];
const debts = [
  {
    id: 'd1',
    name: 'Tarjeta BCI',
    cardName: 'BCI',
    original: 300000,
    remaining: 300000,
    schedule: [
      { id: 'q1', periodKey: '2026-09', dueDate: '2026-09-05', plannedAmount: 100000 },
      { id: 'q2', periodKey: pk, dueDate: '2026-10-05', plannedAmount: 100000 },
      { id: 'q3', periodKey: '2026-11', dueDate: '2026-11-05', plannedAmount: 100000 },
    ],
  },
];
const savings = [
  {
    id: 's1',
    name: 'Vacaciones',
    goal: 600000,
    saved: 100000,
    targetDate: '2026-12-31',
    createdAt: Date.UTC(2026, 8, 1),
    schedule: [{ id: 'p1', periodKey: pk, plannedAmount: 150000 }],
  },
];
const transactions = [
  { id: 't1', type: 'ingreso', amount: 1200000, category: '', date: '2026-10-01' },
  { id: 't2', type: 'gasto', amount: 45000, category: 'Alimentación', date: '2026-10-03', description: 'Súper' },
  { id: 't3', type: 'gasto', amount: 100000, category: 'Deudas', date: '2026-09-05', meta: { debtId: 'd1', debtQuotaIds: ['q1'] } },
  { id: 't4', type: 'gasto', amount: 50000, category: 'Ahorro', date: '2026-10-04', meta: { savingId: 's1', savingName: 'Vacaciones' } },
];
const budgets = { Alimentación: { plan: 200000, funded: 200000 }, Transporte: { plan: 50000, funded: 50000 } };
const actions = new Proxy({}, { get: () => vi.fn().mockResolvedValue(null) });
const user = { id: 'u1', name: 'Eze' };

describe('pestañas', () => {
  it('Inicio', () => {
    render(
      <Dashboard
        data={{ categories, budgets, budgetsAll: { [pk]: budgets }, transactions, debts, savings, budgetCutDay: 1 }}
        monthKeyStr={pk}
      />,
    );
    expect(document.body.textContent.length).toBeGreaterThan(50);
  });

  it('Movimientos', () => {
    render(
      <Transactions
        data={{ transactions, categories, debts, savings, budgets, budgetsAll: { [pk]: budgets }, householdUsers: [user] }}
        actions={actions}
        activeUser={user}
        monthKeyStr={pk}
        budgetCutDay={1}
      />,
    );
    expect(screen.getAllByText(/Súper/).length).toBeGreaterThan(0);
  });

  it('Plan del mes', () => {
    render(
      <Budgets
        data={{ budgets, budgetsAll: { [pk]: budgets }, transactions, categories, budgetCutDay: 1, debts, savings }}
        actions={actions}
        monthKeyStr={pk}
        beforeCategories={<div>compromisos-aqui</div>}
      />,
    );
    expect(screen.getByText('Presupuestos por categoria')).toBeTruthy();
    expect(screen.getByText('compromisos-aqui')).toBeTruthy();
  });

  it('Plan: el gasto fijo pide su fecha de vencimiento y la guarda', () => {
    const setCategoryDueDay = vi.fn();
    render(
      <Budgets
        data={{
          budgets: { Hogar: 500000 },
          budgetsAll: { [pk]: { Hogar: 500000 } },
          transactions,
          categories,
          fixedCategories: { Hogar: true },
          fixedDueDays: {},
          budgetCutDay: 1,
          debts,
          savings,
        }}
        actions={{ ...actions, setCategoryDueDay }}
        monthKeyStr={pk}
      />,
    );
    const input = screen.getByLabelText('Día de vencimiento de Hogar');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);
    expect(setCategoryDueDay).toHaveBeenCalledWith('Hogar', '5');
    // Un gasto variable no pide fecha.
    expect(screen.queryByLabelText('Día de vencimiento de Alimentación')).toBeNull();
  });

  it('Plan: tres tarjetas y el detalle plegado', () => {
    render(
      <PlanScreen
        data={{ budgets, budgetsAll: { [pk]: budgets }, transactions, categories, budgetCutDay: 1, debts, savings }}
        budgetsTable={<div>tabla-aqui</div>}
      />,
    );
    expect(screen.getByText(/¿Puedo gastar esto\?/)).toBeTruthy();
    expect(screen.getByText('Qué pagar y cuándo')).toBeTruthy();
    expect(screen.getByText('Fin de mes')).toBeTruthy();
    expect(screen.getByText('Ver detalle').closest('details').open).toBe(false);
    expect(screen.getByText('Detalle de tramos')).toBeTruthy();
  });

  it('Compromisos: deudas y ahorro', () => {
    const onSectionChange = vi.fn();
    const { rerender } = render(
      <CommitmentsPage
        section="debts"
        onSectionChange={onSectionChange}
        data={{ debts, savings, transactions, budgetCutDay: 1, activeUser: user }}
        actions={actions}
        monthKeyStr={pk}
      />,
    );
    // Saldo real: 300.000 - 100.000 pagados (no el `remaining` guardado de 300.000)
    expect(screen.getByText(/1 de 3 cuotas pagadas/)).toBeTruthy();
    expect(screen.getAllByText('$200.000').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('tab', { name: 'Metas de ahorro' }));
    expect(onSectionChange).toHaveBeenCalledWith('savings');
    rerender(
      <CommitmentsPage
        section="savings"
        onSectionChange={onSectionChange}
        data={{ debts, savings, transactions, budgetCutDay: 1, activeUser: user }}
        actions={actions}
        monthKeyStr={pk}
      />,
    );
    // 100.000 iniciales + 50.000 aportados
    expect(screen.getAllByText(/\$150\.000/).length).toBeGreaterThan(0);
  });
});

describe('Resumen por tarjeta', () => {
  it('muestra una tarjeta con saldo de deuda, cuota del periodo, pagado y por pagar', () => {
    render(
      <CommitmentsPage
        section="debts"
        onSectionChange={() => {}}
        data={{ debts, savings, transactions, budgetCutDay: 1, activeUser: user }}
        actions={actions}
        monthKeyStr={pk}
      />,
    );
    const card = screen.getByRole('article', { name: /Tarjeta BCI/ });
    // 300.000 de deuda menos la cuota de septiembre ya pagada (t3).
    expect(card.textContent).toMatch(/Saldo deuda\$200\.000/);
    expect(card.textContent).toMatch(/1 deuda activa/);
    expect(card.textContent).toMatch(/Cuota periodo\$100\.000/);
    expect(card.textContent).toMatch(/Pagado\$0/);
    expect(card.textContent).toMatch(/Por pagar\$100\.000/);
  });
});

describe('Nueva deuda en modal', () => {
  it('el formulario no está a la vista hasta pulsar "Agregar deuda"', () => {
    render(
      <CommitmentsPage
        section="debts"
        onSectionChange={() => {}}
        data={{ debts, savings, transactions, budgetCutDay: 1, activeUser: user }}
        actions={actions}
        monthKeyStr={pk}
      />,
    );
    expect(screen.queryByPlaceholderText(/Nombre \(ej\./)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '+ Agregar deuda' }));
    expect(screen.getByRole('dialog', { name: 'Nueva deuda' })).toBeTruthy();
    expect(screen.getByPlaceholderText(/Nombre \(ej\./)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Nueva deuda' })).toBeNull();
  });

  it('las tarjetas quedan fuera del calendario', () => {
    render(
      <CommitmentsPage
        section="debts"
        onSectionChange={() => {}}
        data={{ debts, savings, transactions, budgetCutDay: 1, activeUser: user }}
        actions={actions}
        monthKeyStr={pk}
      />,
    );
    const card = screen.getByRole('article', { name: /Tarjeta BCI/ });
    const calendarTitle = screen.getByText('Calendario de deudas');
    expect(card.closest('section')).toBeTruthy();
    expect(calendarTitle.closest('section')).not.toBe(card.closest('section'));
  });
});

describe('Nueva meta de ahorro en modal', () => {
  it('el formulario se abre con "+ Agregar meta" y se cierra con Escape', () => {
    render(
      <CommitmentsPage
        section="savings"
        onSectionChange={() => {}}
        data={{ debts, savings, transactions, budgetCutDay: 1, activeUser: user }}
        actions={actions}
        monthKeyStr={pk}
      />,
    );
    expect(screen.queryByPlaceholderText(/Fondo de emergencia/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '+ Agregar meta' }));
    expect(screen.getByRole('dialog', { name: 'Nueva meta de ahorro' })).toBeTruthy();
    expect(screen.getByPlaceholderText(/Fondo de emergencia/)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Nueva meta de ahorro' })).toBeNull();
  });
});
