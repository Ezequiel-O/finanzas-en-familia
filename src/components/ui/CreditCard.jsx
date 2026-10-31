// src/components/ui/CreditCard.jsx
// Tarjeta visual (proporción real 85,6 × 54 mm) con el saldo de deuda y lo del periodo.
import { Money } from './Money.jsx';

// Degradados oscuros para que el texto blanco tenga buen contraste.
const GRADIENTS = [
  ['#1e3a8a', '#3b82f6'],
  ['#0f3046', '#1875b9'],
  ['#14532d', '#2e8b2e'],
  ['#581c87', '#9333ea'],
  ['#7c2d12', '#ea580c'],
  ['#831843', '#db2777'],
  ['#134e4a', '#0d9488'],
  ['#1f2937', '#4b5563'],
];
const NO_CARD = ['#374151', '#6b7280'];

function gradientFor(name) {
  let hash = 0;
  for (const ch of String(name || '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return GRADIENTS[hash % GRADIENTS.length];
}

export function CreditCard({
  name,
  balance = 0,
  debtCount = 0,
  planned = 0,
  paid = 0,
  pending = 0,
  isPlaceholder = false,
}) {
  const [from, to] = isPlaceholder ? NO_CARD : gradientFor(name);
  const pct = planned > 0 ? Math.min(100, Math.round((paid / planned) * 100)) : 0;
  const isDone = planned > 0 && pending <= 0;

  return (
    <article
      className="relative aspect-[1.586/1] w-full overflow-hidden rounded-2xl p-4 text-white shadow-lg flex flex-col justify-between"
      style={{ backgroundImage: `linear-gradient(135deg, ${from}, ${to})` }}
      aria-label={`Tarjeta ${name}: saldo de deuda y pagos del periodo`}
    >
      {/* Brillo decorativo */}
      <div className="pointer-events-none absolute -right-10 -top-12 h-32 w-32 rounded-full bg-white/10" aria-hidden="true" />
      <div className="pointer-events-none absolute -bottom-16 -left-8 h-32 w-32 rounded-full bg-black/10" aria-hidden="true" />

      <div className="relative flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-base font-bold leading-tight">{name}</div>
          <div className="text-[11px] text-white/70">
            {debtCount === 1 ? '1 deuda activa' : `${debtCount} deudas activas`}
          </div>
        </div>
        {isDone && (
          <span className="shrink-0 rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-semibold">Periodo al día ✓</span>
        )}
      </div>

      <div className="relative">
        <div className="text-[10px] uppercase tracking-wide text-white/70">Saldo deuda</div>
        <div className="text-2xl font-bold leading-tight tabular-nums"><Money n={balance} /></div>
      </div>

      <div className="relative space-y-1.5">
        <dl className="grid grid-cols-3 gap-2">
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-white/70">Cuota periodo</dt>
            <dd className="text-xs font-semibold tabular-nums"><Money n={planned} /></dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-white/70">Pagado</dt>
            <dd className="text-xs font-semibold tabular-nums"><Money n={paid} /></dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-white/70">Por pagar</dt>
            <dd className={`text-xs font-bold tabular-nums ${pending > 0 ? 'text-amber-200' : ''}`}><Money n={pending} /></dd>
          </div>
        </dl>
        <div className="h-1 w-full rounded-full bg-white/25" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Pagado del periodo">
          <div className="h-1 rounded-full bg-white" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </article>
  );
}
