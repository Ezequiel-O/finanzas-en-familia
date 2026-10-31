// src/components/ui/Progress.jsx

export function Progress({
  value,
  mode = 'risk',
  danger = false,
  success = false,
}) {
  const raw = Number.isFinite(Number(value)) ? Number(value) : 0;
  const v = Math.max(0, raw);
  const width = Math.min(100, v);

  let color = 'bg-[color:var(--primary)]';

  if (mode === 'flat') {
    if (danger) color = 'bg-[color:var(--danger)]';
    else if (success) color = 'bg-[color:var(--success)]';
    else color = 'bg-[color:var(--primary)]';
  } else if (mode === 'good') {
    // Verde solo cuando se cumple la meta.
    if (v >= 100) color = 'bg-[color:var(--success)]';
    else color = 'bg-[color:var(--primary)]';
  } else {
    // Semáforo: verde bajo 80 %, amarillo hasta 100 %, rojo si se pasa
    // (o si `danger` lo indica, por ejemplo gasto sin presupuesto).
    if (danger || v > 100) color = 'bg-[color:var(--danger)]';
    else if (v >= 80) color = 'bg-[color:var(--warning)]';
    else color = 'bg-[color:var(--success)]';
  }

  return (
    <div className="w-full h-3 rounded-full bg-[color:var(--divider)]">
      <div
        className={`h-3 rounded-full ${color}`}
        style={{ width: `${width}%` }}
        data-tooltip={`${v.toFixed(0)}%`}
        aria-label={`${v.toFixed(0)}%`}
      />
    </div>
  );
}
