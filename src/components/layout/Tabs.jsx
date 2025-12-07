// src/components/layout/Tabs.jsx

const DEFAULT_TABS = [
  { id: 'dashboard', label: 'Dashboard' },
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
              ? 'bg-gray-900 text-white border-gray-900'
              : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
