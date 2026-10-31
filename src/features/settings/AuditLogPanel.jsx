// src/features/settings/AuditLogPanel.jsx
// Historial de cambios: quién creó, editó o borró movimientos, cerró o reabrió periodos.
import { useState } from 'react';
import { toast } from '../../components/feedback/feedback.js';
import { Money } from '../../components/ui/Money.jsx';

const ACTION_LABEL = {
  create: 'creó',
  update: 'editó',
  delete: 'borró',
  'close-period': 'cerró el periodo',
  'reopen-period': 'reabrió el periodo',
  'reset-finances': 'borró todo el historial',
};

const FIELD_LABEL = { amount: 'monto', category: 'categoría', date: 'fecha', description: 'descripción', type: 'tipo' };

function formatWhen(value) {
  const d = typeof value?.toDate === 'function' ? value.toDate() : null;
  return d
    ? d.toLocaleString('es-CL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';
}

// Solo los campos que cambiaron en una edición.
function changes(entry) {
  if (entry.action !== 'update' || !entry.before || !entry.after) return [];
  return Object.keys(FIELD_LABEL)
    .filter((k) => k in entry.after && String(entry.after[k] ?? '') !== String(entry.before[k] ?? ''))
    .map((k) => ({ field: FIELD_LABEL[k], from: entry.before[k], to: entry.after[k], isMoney: k === 'amount' }));
}

function describe(entry) {
  const tx = entry.after || entry.before || {};
  if (entry.action.endsWith('-period')) return tx.periodKey || '';
  if (entry.action === 'reset-finances') return `${tx.deleted ?? ''} registros`;
  return tx.description || tx.category || 'movimiento';
}

export function AuditLogPanel({ onFetch }) {
  const [entries, setEntries] = useState(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!onFetch) return;
    setLoading(true);
    try {
      setEntries(await onFetch(50));
    } catch (err) {
      console.error('Error leyendo historial', { code: err?.code });
      toast.error('No se pudo cargar el historial.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mt-6 rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-1)] p-5 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Historial de cambios</h2>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="min-h-[40px] px-3 rounded-lg border border-[color:var(--border)] text-sm disabled:opacity-60"
        >
          {loading ? 'Cargando…' : entries ? 'Actualizar' : 'Ver últimos 50'}
        </button>
      </div>
      <p className="text-xs text-[color:var(--text-muted)]">
        Queda registro de cada movimiento creado, editado o borrado, y de los cierres de periodo. Nadie puede editarlo.
      </p>
      {entries && entries.length === 0 && (
        <p className="text-sm text-[color:var(--text-muted)]">Aún no hay cambios registrados.</p>
      )}
      {entries && entries.length > 0 && (
        <ul className="divide-y divide-[color:var(--divider)] text-sm">
          {entries.map((e) => {
            const diff = changes(e);
            const tx = e.after || e.before || {};
            return (
              <li key={e.id} className="py-2">
                <div>
                  <strong>{e.byName || 'Alguien'}</strong> {ACTION_LABEL[e.action] || e.action}{' '}
                  <span className="text-[color:var(--text-muted)]">{describe(e)}</span>
                  {(e.action === 'create' || e.action === 'delete') && tx.amount ? (
                    <>
                      {' '}· <Money n={tx.amount} />
                    </>
                  ) : null}
                </div>
                {diff.map((d) => (
                  <div key={d.field} className="text-xs text-[color:var(--text-muted)]">
                    {d.field}: {d.isMoney ? <Money n={d.from} /> : String(d.from ?? '—')} →{' '}
                    {d.isMoney ? <Money n={d.to} /> : String(d.to ?? '—')}
                  </div>
                ))}
                <div className="text-[11px] text-[color:var(--text-faint)]">{formatWhen(e.at)}</div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
