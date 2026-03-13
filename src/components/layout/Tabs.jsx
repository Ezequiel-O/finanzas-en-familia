// src/components/layout/Tabs.jsx

const DEFAULT_TABS = [
  { id: 'dashboard', label: 'Resumen' },
  { id: 'transactions', label: 'Movimientos' },
  { id: 'budgets', label: 'Presupuestos' },
  { id: 'debts', label: 'Deudas' },
  { id: 'savings', label: 'Ahorro' },
  { id: 'settings', label: 'Ajustes' },
];

export function Tabs({ currentTab, onChange, tabs = DEFAULT_TABS }) {
  return (
    <div className="flex flex-wrap gap-2">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`px-3 py-1.5 rounded-full border text-sm ${
            currentTab === tab.id
              ? 'bg-[color:var(--primary)] text-[color:var(--primary-contrast)] border-[color:var(--primary)] shadow-sm'
              : 'bg-[color:var(--surface-1)] border-[color:var(--border)] text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)]'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
