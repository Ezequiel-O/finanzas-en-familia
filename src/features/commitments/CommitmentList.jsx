// src/features/commitments/CommitmentList.jsx
// Lista de cuotas, suscripciones y aportes con su estado y botón Pagar/Aportar.
import { Money } from '../../components/ui/Money.jsx';
import { formatShortDate } from '../../domain/dates.js';

const KIND_ICON = { debt: '💳', subscription: '🔁', saving: '🐷' };

export function CommitmentRow({ item, onPay }) {
  const isPaid = item.status === 'paid';
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className="text-lg" aria-hidden="true">
        {isPaid ? '✅' : KIND_ICON[item.kind] || '•'}
      </span>
      <div className="min-w-0 flex-1">
        <div className={`truncate text-sm font-semibold ${isPaid ? 'text-[color:var(--text-muted)] line-through decoration-1' : ''}`}>
          {item.name}
        </div>
        <div className="text-xs text-[color:var(--text-muted)]">
          {item.detail}
          {item.cardName ? ` · ${item.cardName}` : ''}
          {' · '}
          {isPaid ? (
            'pagado'
          ) : item.isOverdue ? (
            <span className="font-semibold text-[color:var(--danger)]">atrasada (venció {formatShortDate(item.dueDate)})</span>
          ) : (
            `vence ${formatShortDate(item.dueDate)}`
          )}
          {item.status === 'partial' && (
            <>
              {' · '}abonado <Money n={item.paid} />
            </>
          )}
        </div>
      </div>
      <div className="text-right">
        <div className="text-sm font-semibold">
          <Money n={isPaid ? item.planned : item.pending} />
        </div>
        {!isPaid && onPay && (
          <button
            type="button"
            onClick={() => onPay(item)}
            className="mt-1 min-h-[36px] px-3 rounded-lg bg-[color:var(--primary)] text-[color:var(--primary-contrast)] text-xs font-semibold"
          >
            {item.kind === 'saving' ? 'Aportar' : 'Pagar'}
          </button>
        )}
      </div>
    </li>
  );
}

export function CommitmentList({ items, onPay, emptyText = 'No hay compromisos en este periodo.' }) {
  if (!items.length) {
    return <p className="py-2 text-sm text-[color:var(--text-muted)]">{emptyText}</p>;
  }
  return (
    <ul className="divide-y divide-[color:var(--divider)]">
      {items.map((item) => (
        <CommitmentRow key={item.key} item={item} onPay={onPay} />
      ))}
    </ul>
  );
}
