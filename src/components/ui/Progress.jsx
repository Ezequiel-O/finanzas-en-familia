// src/components/ui/Progress.jsx

export function Progress({ value, mode = 'risk' }) {
  const raw = Number.isFinite(Number(value)) ? Number(value) : 0;
  const v = Math.max(0, raw);
  const width = Math.min(100, v);

  let color = 'bg-green-600';

  if (mode === 'good') {
    // Bueno cuando el porcentaje es ALTO (deudas pagadas, ahorro, ROI)
    if (v >= 90) color = 'bg-green-600';
    else if (v >= 60) color = 'bg-amber-500';
    else color = 'bg-red-500';
  } else {
    // Riesgo: rojo solo si te pasas del 100%
    if (v > 100) color = 'bg-red-500';
    else if (v >= 90) color = 'bg-amber-500';
    else color = 'bg-green-600';
  }

  return (
    <div className="w-full h-3 rounded-full bg-gray-200">
      <div
        className={`h-3 rounded-full ${color}`}
        style={{ width: `${width}%` }}
        title={`${v.toFixed(0)}%`}
      />
    </div>
  );
}
