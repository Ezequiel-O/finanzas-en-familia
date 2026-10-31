// src/components/ui/Card.jsx

export function Card({ children, className = '' }) {
  return (
    <div
      className={`rounded-2xl border border-[color:var(--border)] p-4 bg-[color:var(--surface-1)] shadow-[var(--shadow)] ${className}`}
    >
      {children}
    </div>
  );
}
