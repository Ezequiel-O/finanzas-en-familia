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
              ? 'bg-gray-200 text-gray-900 border-gray-300 shadow-sm dark:bg-gray-200 dark:border-gray-200 dark:text-gray-900'
              : 'bg-white dark:bg-transparent border-gray-300 dark:border-gray-500 text-gray-800 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
