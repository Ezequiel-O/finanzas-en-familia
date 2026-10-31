// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackHost } from '../../components/feedback/FeedbackHost.jsx';
import { DangerZone } from '../settings/DangerZone.jsx';

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:respaldo');
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

async function typeAndConfirm() {
  const button = screen.getByRole('button', { name: 'Eliminar todo el registro histórico' });
  expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/escribe/i), { target: { value: 'borrar' } });
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await screen.findByRole('alertdialog');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar todo' }));
  });
}

describe('DangerZone', () => {
  it('solo el dueño ve el botón', () => {
    render(<DangerZone isOwner={false} onExport={vi.fn()} onReset={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/Solo el dueño/)).toBeTruthy();
  });

  it('respalda primero y luego borra', async () => {
    const order = [];
    const onExport = vi.fn(async () => {
      order.push('export');
      return { collections: {} };
    });
    const onReset = vi.fn(async () => {
      order.push('reset');
      return 42;
    });
    render(
      <>
        <DangerZone isOwner onExport={onExport} onReset={onReset} />
        <FeedbackHost />
      </>,
    );
    await typeAndConfirm();
    await waitFor(() => expect(onReset).toHaveBeenCalled());
    expect(order).toEqual(['export', 'reset']);
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(await screen.findByText(/se borraron 42 registros/)).toBeTruthy();
  });

  it('si el respaldo falla, no borra nada', async () => {
    const onExport = vi.fn().mockRejectedValue(new Error('sin red'));
    const onReset = vi.fn();
    render(
      <>
        <DangerZone isOwner onExport={onExport} onReset={onReset} />
        <FeedbackHost />
      </>,
    );
    await typeAndConfirm();
    expect(await screen.findByText(/no se borró nada/)).toBeTruthy();
    expect(onReset).not.toHaveBeenCalled();
  });
});
