// src/components/layout/Header.jsx
import React, { useEffect, useRef, useState } from 'react';

function AppLogo({ className }) {
  const classes = ['object-contain', className].filter(Boolean).join(' ');
  return (
    <img
      src="/logo-finanzas-en-familia.png"
      alt="Finanzas en Familia"
      className={classes}
      decoding="async"
    />
  );
}

const ICON_STROKE = 1.5;

export function DashboardIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

export function MovementsIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h12" />
      <path d="M12 3l4 4-4 4" />
      <path d="M20 17H8" />
      <path d="M12 21l-4-4 4-4" />
    </svg>
  );
}

export function BudgetsIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6" y="4" width="12" height="16" rx="2" />
      <path d="M9 4h6v3H9z" />
      <path d="M9 11h6" />
      <path d="M9 15h6" />
    </svg>
  );
}

export function DebtsIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M3 10h18" />
      <path d="M7 15h4" />
    </svg>
  );
}

export function SavingsIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <ellipse cx="12" cy="5" rx="6" ry="2" />
      <path d="M6 5v4c0 1.1 2.7 2 6 2s6-.9 6-2V5" />
      <path d="M6 9v4c0 1.1 2.7 2 6 2s6-.9 6-2V9" />
      <path d="M6 13v4c0 1.1 2.7 2 6 2s6-.9 6-2v-4" />
    </svg>
  );
}

export function SettingsIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="9" cy="6" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="7" cy="18" r="2" />
    </svg>
  );
}

function LogoutIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 17l5-5-5-5" />
      <path d="M15 12H3" />
      <path d="M21 19V5a2 2 0 0 0-2-2h-5" />
    </svg>
  );
}

// Compromisos agrupa Deudas y Ahorro; Plan del mes reemplaza a Presupuestos.
const NAV_ITEMS = [
  { id: 'dashboard', label: 'Inicio', icon: DashboardIcon },
  { id: 'transactions', label: 'Movimientos', icon: MovementsIcon },
  { id: 'plan', label: 'Plan del mes', icon: BudgetsIcon },
  { id: 'commitments', label: 'Compromisos', icon: DebtsIcon },
  { id: 'settings', label: 'Ajustes', icon: SettingsIcon },
];

export function Header({
  currentTab,
  setTab,
  user,
  onLogout,
  householdId,
  mobileOpen: mobileOpenProp,
  setMobileOpen: setMobileOpenProp,
  showMobileTopBar = true,
}) {
  const showNav = Boolean(user && householdId);
  const showLogout = Boolean(user);
  const [mobileOpenState, setMobileOpenState] = useState(false);
  const mobileOpen =
    typeof mobileOpenProp === 'boolean' ? mobileOpenProp : mobileOpenState;
  const setMobileOpen = setMobileOpenProp || setMobileOpenState;
  const [isCollapsed, setIsCollapsed] = useState(true);
  const navRef = useRef(null);

  useEffect(() => {
    setMobileOpen(false);
  }, [currentTab, householdId]);

  useEffect(() => {
    if (!showNav || isCollapsed) return;
    if (typeof window === 'undefined') return;

    const handleClickOutside = (event) => {
      if (!navRef.current) return;
      if (navRef.current.contains(event.target)) return;
      if (window.matchMedia('(min-width: 768px)').matches) {
        setIsCollapsed(true);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showNav, isCollapsed]);

  const labelBase =
    'inline-block overflow-hidden whitespace-nowrap transition-all duration-200 ease-out';
  const navLabelClass = (collapsed) =>
    `${labelBase} ${
      collapsed
        ? 'max-w-0 opacity-0 translate-x-1'
        : 'max-w-[160px] opacity-100 translate-x-0'
    }`;
  const brandLabelClass = `${labelBase} ${
    isCollapsed
      ? 'max-w-0 opacity-0 translate-x-1'
      : 'max-w-[220px] opacity-100 translate-x-0'
  }`;

  const renderNavButtons = ({ onItemClick, collapsed = isCollapsed } = {}) => (
    <div className={`grid gap-1 ${collapsed ? 'justify-items-center' : ''}`}>
      {NAV_ITEMS.map((item) => {
        const isActive = currentTab === item.id;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setTab(item.id);
              if (onItemClick) onItemClick();
            }}
            className={`w-full rounded-lg text-sm font-medium transition-colors flex items-center ${
              collapsed ? 'justify-center px-2 py-2.5' : 'px-3 py-2 gap-3'
            } ${
              isActive
                ? 'bg-blue-700 text-white shadow-sm'
                : 'text-blue-100 hover:bg-blue-800/60'
            }`}
            aria-current={isActive ? 'page' : undefined}
            title={collapsed ? item.label : undefined}
          >
            <Icon className="h-6 w-6" />
            <span className={navLabelClass(collapsed)}>{item.label}</span>
          </button>
        );
      })}
      {showLogout && (
        <button
          type="button"
          onClick={() => {
            if (onItemClick) onItemClick();
            if (onLogout) onLogout();
          }}
          className={`w-full rounded-lg text-sm font-medium transition-colors flex items-center text-red-300 hover:bg-red-900/30 ${
            collapsed ? 'justify-center px-2 py-2.5' : 'px-3 py-2 gap-3'
          }`}
          title={collapsed ? 'Salir' : undefined}
        >
          <LogoutIcon className="h-6 w-6" />
          <span className={navLabelClass(collapsed)}>Salir</span>
        </button>
      )}
    </div>
  );

  return (
    <>
      {showMobileTopBar && (
        <div
          className={`flex items-center justify-between gap-3 py-3 bg-white/80 dark:bg-gray-900/80 backdrop-blur border-b border-gray-200/70 dark:border-gray-700/70 ${
            showNav
              ? 'md:hidden pl-0 pr-4 fixed top-0 left-0 right-0 z-40'
              : 'sticky top-0 z-20 px-4'
          }`}
        >
          {showNav ? (
            <button
              type="button"
              onClick={() => setMobileOpen((prev) => !prev)}
              className="flex items-center rounded-r-full bg-blue-900 text-blue-100 px-6 py-2.5 shadow-sm min-h-[48px] transition active:scale-95"
              aria-label={mobileOpen ? 'Cerrar menu' : 'Abrir menu'}
              aria-expanded={mobileOpen}
            >
              <AppLogo className="h-7 w-7" />
              <span className="sr-only">Finanzas en Familia</span>
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <AppLogo className="h-9 w-9" />
              <div className="text-lg font-bold">Finanzas en Familia</div>
            </div>
          )}
          {!showNav && showLogout && (
            <button
              onClick={onLogout}
              className="px-3 py-1.5 rounded-lg border text-sm border-gray-300 dark:border-gray-500 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              Salir
            </button>
          )}
        </div>
      )}

      {showNav && mobileOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div className="mobile-drawer w-64 bg-blue-900 text-blue-100 border-r border-blue-800 p-4 shadow-xl">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="flex items-center gap-2 text-left mb-4"
              aria-label="Cerrar menu"
            >
              <AppLogo className="h-8 w-8" />
              <span className="text-lg font-bold">Finanzas en Familia</span>
            </button>
            {renderNavButtons({
              onItemClick: () => setMobileOpen(false),
              collapsed: false,
            })}
          </div>
          <button
            type="button"
            className="mobile-drawer-backdrop flex-1 bg-black/40"
            onClick={() => setMobileOpen(false)}
            aria-label="Cerrar menu"
          />
        </div>
      )}

      {showNav && (
        <aside
          ref={navRef}
          className={`hidden md:flex md:flex-col md:shrink-0 md:border-r md:border-blue-800 md:bg-blue-900/95 md:text-blue-100 md:backdrop-blur md:sticky md:top-0 md:h-screen md:self-start md:overflow-y-auto md:transition-all md:duration-300 md:ease-out ${
            isCollapsed ? 'md:w-16' : 'md:w-64'
          }`}
        >
          <div
            className={`${
              isCollapsed ? 'px-2 py-4' : 'px-4 py-4'
            } flex flex-col items-center justify-center gap-3`}
          >
            <button
              type="button"
              onClick={() => setIsCollapsed((prev) => !prev)}
              className="flex items-center justify-center w-full gap-2"
              aria-label={isCollapsed ? 'Expandir menu' : 'Contraer menu'}
              aria-expanded={!isCollapsed}
            >
              <AppLogo className="h-9 w-9" />
              <span className={`text-lg font-bold ${brandLabelClass}`}>
                Finanzas en Familia
              </span>
            </button>
            <div className="w-full border-b border-blue-800/80" />
          </div>
          <div className={`${isCollapsed ? 'px-2 pb-4' : 'px-3 pb-4'} pt-2`}>
            {renderNavButtons()}
          </div>
        </aside>
      )}
    </>
  );
}
