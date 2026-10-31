// src/components/layout/BottomNav.jsx
// Barra inferior para móvil: 4 pestañas con el botón "+" (registrar gasto) al centro.
import { BudgetsIcon, DashboardIcon, DebtsIcon, MovementsIcon } from './Header.jsx';

const LEFT = [
  { id: 'dashboard', label: 'Inicio', icon: DashboardIcon },
  { id: 'transactions', label: 'Movimientos', icon: MovementsIcon },
];
const RIGHT = [
  { id: 'plan', label: 'Plan', icon: BudgetsIcon },
  { id: 'commitments', label: 'Compromisos', icon: DebtsIcon },
];

function NavButton({ item, active, onSelect }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      className={`flex flex-1 flex-col items-center justify-center gap-0.5 min-h-[56px] text-[11px] font-medium transition-colors ${
        active ? 'text-[color:var(--primary)] dark:text-blue-300' : 'text-[color:var(--text-muted)]'
      }`}
      aria-current={active ? 'page' : undefined}
    >
      <Icon className="h-6 w-6" />
      <span>{item.label}</span>
    </button>
  );
}

export function BottomNav({ currentTab, setTab, onQuickAdd }) {
  return (
    <nav
      className="md:hidden fixed inset-x-0 bottom-0 z-40 border-t border-[color:var(--border)] bg-[color:var(--surface-1)]/95 backdrop-blur pb-[env(safe-area-inset-bottom)]"
      aria-label="Navegación principal"
    >
      <div className="flex items-stretch">
        {LEFT.map((item) => (
          <NavButton key={item.id} item={item} active={currentTab === item.id} onSelect={setTab} />
        ))}
        <div className="flex flex-1 items-start justify-center">
          <button
            type="button"
            onClick={onQuickAdd}
            className="-mt-5 h-14 w-14 rounded-full bg-[color:var(--primary)] text-[color:var(--primary-contrast)] shadow-lg text-3xl leading-none active:scale-95 transition"
            aria-label="Registrar gasto"
          >
            +
          </button>
        </div>
        {RIGHT.map((item) => (
          <NavButton key={item.id} item={item} active={currentTab === item.id} onSelect={setTab} />
        ))}
      </div>
    </nav>
  );
}
