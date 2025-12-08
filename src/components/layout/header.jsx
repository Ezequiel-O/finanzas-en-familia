// src/components/layout/header.jsx
import { Tabs } from './Tabs.jsx';

export function Header({ currentTab, setTab, user, onLogout, householdId }) {
  const showTabs = Boolean(user && householdId);
  const showLogout = Boolean(user);

  return (
    <div className="flex flex-wrap items-center gap-2 p-3 bg-white/70 dark:bg-gray-800/70 backdrop-blur sticky top-0 z-10 border-b border-gray-200/70 dark:border-gray-700/70">
      <div className="text-2xl font-bold">Finanzas en Familia</div>

      <div className="flex flex-wrap gap-2 ml-auto items-center">
        {showTabs && <Tabs currentTab={currentTab} onChange={setTab} />}

        {showLogout && (
          <button
            onClick={onLogout}
            className="px-3 py-1.5 rounded-full border text-sm border-gray-300 dark:border-gray-500 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            Salir
          </button>
        )}
      </div>
    </div>
  );
}
