// src/components/ui/money.jsx

export function Money({ n }) {
  const sign = Number(n) < 0 ? '-' : '';
  const v = Math.abs(Number(n || 0));
  return (
    <span>
      {sign}${v.toLocaleString('es-CL', { minimumFractionDigits: 0 })}
    </span>
  );
}
