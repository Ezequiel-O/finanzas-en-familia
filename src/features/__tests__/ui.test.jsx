// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedbackHost } from '../../components/feedback/FeedbackHost.jsx';
import { todayKey } from '../../domain/dates.js';
import { CommitmentsPanel } from '../plan/CommitmentsPanel.jsx';
import { PeriodOutlook } from '../plan/PeriodOutlook.jsx';
import { QuickAddSheet } from '../quick-add/QuickAddSheet.jsx';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const user = { id: 'u1', name: 'Eze', email: 'e@x.cl' };

describe('QuickAddSheet', () => {
  it('registra un gasto con monto, categoría y fecha de hoy, y avisa cuánto queda', async () => {
    const addTransaction = vi.fn().mockResolvedValue('tx-1');
    const onClose = vi.fn();
    const pk = todayKey().slice(0, 7);
    render(
      <>
        <QuickAddSheet
          open
          onClose={onClose}
          categories={['Deudas', 'Ahorro', 'Alimentación', 'Transporte']}
          budgetsAll={{ [pk]: { Alimentación: { plan: 100000, funded: 100000 } } }}
          transactions={[{ id: 'in-1', type: 'ingreso', amount: 500000, date: todayKey() }]}
          budgetCutDay={1}
          activeUser={user}
          actions={{ addTransaction }}
        />
        <FeedbackHost />
      </>,
    );

    // Las categorías del sistema no se ofrecen en el registro rápido.
    expect(screen.queryByRole('button', { name: 'Deudas' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Monto en pesos'), { target: { value: '15000' } });
    expect(screen.getByLabelText('Monto en pesos').value).toBe('15.000');
    fireEvent.click(screen.getByRole('button', { name: 'Alimentación' }));
    fireEvent.click(screen.getByRole('button', { name: /Guardar \$15\.000/ }));

    await waitFor(() => expect(addTransaction).toHaveBeenCalledTimes(1));
    expect(addTransaction.mock.calls[0][0]).toMatchObject({
      type: 'gasto',
      amount: 15000,
      category: 'Alimentación',
      date: todayKey(),
      ownerId: 'u1',
    });
    expect(onClose).toHaveBeenCalled();
    expect(await screen.findByText(/Te quedan \$85\.000 en Alimentación/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deshacer' })).toBeTruthy();
  });

  it('avisa antes de guardar un gasto mayor a la plata que hay hoy', async () => {
    const addTransaction = vi.fn().mockResolvedValue('tx-2');
    render(
      <>
        <QuickAddSheet
          open
          onClose={() => {}}
          categories={['Alimentación']}
          transactions={[{ id: 'in-1', type: 'ingreso', amount: 10000, date: todayKey() }]}
          activeUser={user}
          actions={{ addTransaction }}
        />
        <FeedbackHost />
      </>,
    );
    fireEvent.change(screen.getByLabelText('Monto en pesos'), { target: { value: '15000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Alimentación' }));
    fireEvent.click(screen.getByRole('button', { name: /Guardar \$15\.000/ }));

    expect(await screen.findByText(/solo hay \$10\.000 disponibles/)).toBeTruthy();
    expect(addTransaction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Registrar igual' }));
    await waitFor(() => expect(addTransaction).toHaveBeenCalledTimes(1));
  });

  it('entiende el texto rápido "bencina 30 mil ayer"', async () => {
    render(
      <QuickAddSheet open onClose={() => {}} categories={['Alimentación', 'Transporte']} actions={{}} activeUser={user} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Escribir en una frase/ }));
    fireEvent.change(screen.getByPlaceholderText('bencina 30 mil ayer'), { target: { value: 'bencina 30 mil ayer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(screen.getByLabelText('Monto en pesos').value).toBe('30.000');
    expect(screen.getByRole('button', { name: 'Transporte' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Ayer' }).getAttribute('aria-checked')).toBe('true');
  });

  it('no guarda sin monto', async () => {
    const addTransaction = vi.fn();
    render(
      <>
        <QuickAddSheet open onClose={() => {}} categories={['Otros']} actions={{ addTransaction }} activeUser={user} />
        <FeedbackHost />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(addTransaction).not.toHaveBeenCalled();
    expect(await screen.findByText('Ingresa un monto mayor a 0.')).toBeTruthy();
  });
});

describe('CommitmentsPanel', () => {
  it('paga una cuota con un movimiento vinculado a la deuda', async () => {
    const pk = '2026-10';
    const debts = [
      {
        id: 'd1',
        name: 'Tarjeta BCI',
        original: 200000,
        schedule: [
          { id: 'q1', periodKey: pk, dueDate: '2026-10-05', plannedAmount: 100000 },
          { id: 'q2', periodKey: '2026-11', dueDate: '2026-11-05', plannedAmount: 100000 },
        ],
      },
    ];
    const addTransaction = vi.fn().mockResolvedValue('tx-9');
    render(
      <>
        <CommitmentsPanel
          data={{ debts, savings: [], transactions: [], budgetCutDay: 1 }}
          actions={{ addTransaction }}
          activeUser={user}
          periodKey={pk}
        />
        <FeedbackHost />
      </>,
    );

    expect(screen.getByText('Cuota 1 de 2', { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pagar' }));
    // Diálogo propio de confirmación (no window.confirm)
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toMatch(/\$100\.000/);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Pagar' }).at(-1));
    });

    await waitFor(() => expect(addTransaction).toHaveBeenCalledTimes(1));
    const tx = addTransaction.mock.calls[0][0];
    expect(tx).toMatchObject({ type: 'gasto', category: 'Deudas', amount: 100000, ownerId: 'u1' });
    expect(tx.meta).toMatchObject({ debtId: 'd1', debtQuotaIds: ['q1'], debtQuotaDebtIds: { q1: 'd1' } });
  });

  it('muestra la cuota como pagada cuando existe el movimiento', () => {
    const debts = [{ id: 'd1', name: 'Crédito', schedule: [{ id: 'q1', periodKey: '2026-10', dueDate: '2026-10-05', plannedAmount: 50000 }] }];
    const transactions = [
      { type: 'gasto', category: 'Deudas', amount: 50000, date: '2026-10-05', meta: { debtId: 'd1', debtQuotaIds: ['q1'] } },
    ];
    render(
      <CommitmentsPanel data={{ debts, savings: [], transactions, budgetCutDay: 1 }} actions={{}} periodKey="2026-10" />,
    );
    expect(screen.queryByRole('button', { name: 'Pagar' })).toBeNull();
    expect(screen.getByText(/pagado/)).toBeTruthy();
  });
});

describe('PeriodOutlook', () => {
  it('ofrece copiar el presupuesto anterior cuando no hay plan', () => {
    const onCopy = vi.fn();
    render(<PeriodOutlook rows={[]} periodKey="2026-10" copyableCount={3} onCopyPrevious={onCopy} />);
    fireEvent.click(screen.getByRole('button', { name: /Copiar presupuesto del periodo anterior \(3\)/ }));
    expect(onCopy).toHaveBeenCalled();
  });

  it('marca las categorías en amarillo y rojo e ignora Deudas/Ahorro', () => {
    render(
      <PeriodOutlook
        periodKey="2020-01"
        rows={[
          { c: 'Alimentación', funded: 100000, spent: 85000 },
          { c: 'Entretenimiento', funded: 40000, spent: 55000 },
          { c: 'Deudas', funded: 500000, spent: 0 },
        ]}
      />,
    );
    // planned = 140.000, spent = 140.000 -> 100 % usado, sin contar Deudas
    expect(screen.getByText(/100% usado/)).toBeTruthy();
    expect(screen.getByText('Alimentación · 85%')).toBeTruthy();
    expect(screen.getByText('Entretenimiento · 138%')).toBeTruthy();
    expect(screen.queryByText(/Deudas ·/)).toBeNull();
  });
});
