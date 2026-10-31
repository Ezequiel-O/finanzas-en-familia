// src/components/ui/DueDayInput.jsx
// Día del mes (1-31) en que vence un gasto fijo. Se guarda al salir del campo; vacío lo borra.

export function DueDayInput({ value, label, onSave }) {
  return (
    <label className="inline-flex items-center gap-1 text-[10px] text-[color:var(--text-muted)]">
      Vence el día
      <input
        key={String(value || '')}
        type="number"
        inputMode="numeric"
        min={1}
        max={31}
        step={1}
        defaultValue={value || ''}
        placeholder="—"
        aria-label={label}
        className={`w-12 rounded border px-1 py-0.5 text-[11px] ${value ? '' : 'border-[color:var(--warning)]/60'}`}
        onBlur={(e) => {
          const next = e.target.value.trim();
          if (next === String(value || '')) return;
          onSave?.(next);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
