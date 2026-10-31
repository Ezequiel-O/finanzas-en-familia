// src/components/feedback/FeedbackHost.jsx
import React, { useEffect, useRef, useState } from 'react';
import { formatAmountInput, parseAmount } from '../../domain/money.js';
import { createPortal } from 'react-dom';
import { dismissToast, useFeedbackState } from './feedback.js';

const TONE_CLASS = {
  info: 'border-[color:var(--border)]',
  success: 'border-[color:var(--success)]/50',
  warning: 'border-[color:var(--warning)]/60',
  error: 'border-[color:var(--danger)]/60',
};
const TONE_DOT = {
  info: 'bg-[color:var(--primary)]',
  success: 'bg-[color:var(--success)]',
  warning: 'bg-[color:var(--warning)]',
  error: 'bg-[color:var(--danger)]',
};

function ConfirmModal({ confirm }) {
  const confirmRef = useRef(null);
  const amountRef = useRef(null);
  const [amountText, setAmountText] = useState(
    confirm.amount?.initial ? formatAmountInput(String(confirm.amount.initial)) : '',
  );
  const amountValue = parseAmount(amountText);
  const max = confirm.amount?.max;
  const amountInvalid = !!confirm.amount && (amountValue <= 0 || (max !== null && amountValue > max));
  const accept = () => confirm.resolve(confirm.amount ? amountValue : true);
  useEffect(() => {
    (amountRef.current || confirmRef.current)?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') confirm.resolve(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm]);

  return (
    <div className="fixed inset-0 z-[10001] flex items-end sm:items-center justify-center bg-black/40 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        className="w-full max-w-sm rounded-2xl bg-[color:var(--surface-1)] text-[color:var(--text)] shadow-xl p-5 space-y-4"
      >
        <h3 id="confirm-title" className="text-base font-semibold">
          {confirm.title}
        </h3>
        <p id="confirm-message" className="text-sm text-[color:var(--text-muted)] whitespace-pre-line">
          {confirm.message}
        </p>
        {confirm.amount && (
          <div>
            <div className="flex items-center gap-2 rounded-xl border border-[color:var(--border)] bg-[color:var(--input-bg)] px-3">
              <span className="text-lg font-semibold text-[color:var(--text-muted)]">$</span>
              <input
                ref={amountRef}
                value={amountText}
                onChange={(e) => setAmountText(formatAmountInput(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !amountInvalid) accept();
                }}
                inputMode="numeric"
                aria-label="Monto"
                className="w-full bg-transparent py-2 text-xl font-bold outline-none"
              />
            </div>
            {max !== null && amountValue > max && (
              <div className="mt-1 text-xs text-[color:var(--danger)]">El máximo es ${formatAmountInput(String(max))}.</div>
            )}
          </div>
        )}
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            className="min-h-[44px] px-4 rounded-xl border border-[color:var(--border)] text-sm hover:bg-[color:var(--surface-2)]"
            onClick={() => confirm.resolve(false)}
          >
            {confirm.cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`min-h-[44px] px-4 rounded-xl text-sm font-semibold text-white disabled:opacity-50 ${
              confirm.danger ? 'bg-[color:var(--danger)]' : 'bg-[color:var(--primary)]'
            }`}
            onClick={accept}
            disabled={amountInvalid}
          >
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function FeedbackHost() {
  const { toasts, confirm } = useFeedbackState();
  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      <div
        className="fixed inset-x-0 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] md:bottom-6 z-[10000] flex flex-col items-center gap-2 px-4 pointer-events-none"
        aria-live="polite"
        role="status"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast-enter pointer-events-auto w-full max-w-md flex items-center gap-3 rounded-xl border bg-[color:var(--surface-1)] text-[color:var(--text)] shadow-[var(--shadow)] px-4 py-3 text-sm ${TONE_CLASS[t.tone] || TONE_CLASS.info}`}
          >
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${TONE_DOT[t.tone] || TONE_DOT.info}`} aria-hidden="true" />
            <span className="flex-1">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="shrink-0 font-semibold text-[color:var(--primary)] dark:text-blue-300 min-h-[36px] px-2"
                onClick={() => {
                  dismissToast(t.id);
                  t.action.onClick();
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              className="shrink-0 text-[color:var(--text-faint)] hover:text-[color:var(--text)] px-1"
              onClick={() => dismissToast(t.id)}
              aria-label="Cerrar aviso"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {confirm && <ConfirmModal confirm={confirm} />}
    </>,
    document.body,
  );
}
