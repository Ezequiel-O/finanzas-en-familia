// src/navigation/tabs.js
// Pestañas de la app. Antes eran 6 (Resumen, Movimientos, Presupuestos, Deudas,
// Ahorro, Ajustes); ahora Presupuestos pasa a "Plan del mes" y Deudas + Ahorro se
// unen en "Compromisos". La pestaña activa vive en el hash de la URL (#plan) para
// que el botón Atrás funcione y se pueda compartir un enlace directo.
import { useCallback, useEffect, useState } from 'react';

export const TABS = [
  { id: 'dashboard', hash: 'inicio', label: 'Inicio' },
  { id: 'transactions', hash: 'movimientos', label: 'Movimientos' },
  { id: 'plan', hash: 'plan', label: 'Plan del mes' },
  { id: 'commitments', hash: 'compromisos', label: 'Compromisos' },
  { id: 'settings', hash: 'ajustes', label: 'Ajustes' },
];

// Ids antiguos (preferencias guardadas, enlaces viejos) -> pestaña nueva + sección.
const LEGACY = {
  budgets: { tab: 'plan' },
  presupuestos: { tab: 'plan' },
  debts: { tab: 'commitments', section: 'debts' },
  deudas: { tab: 'commitments', section: 'debts' },
  savings: { tab: 'commitments', section: 'savings' },
  ahorro: { tab: 'commitments', section: 'savings' },
  resumen: { tab: 'dashboard' },
};

export function resolveTab(value) {
  const key = String(value || '').replace(/^#/, '').trim().toLowerCase();
  if (!key) return null;
  const direct = TABS.find((t) => t.id.toLowerCase() === key || t.hash === key);
  if (direct) return { tab: direct.id, section: null };
  const legacy = LEGACY[key];
  return legacy ? { tab: legacy.tab, section: legacy.section || null } : null;
}

function hashFor(tabId) {
  return TABS.find((t) => t.id === tabId)?.hash || 'inicio';
}

// Estado de pestaña sincronizado con location.hash.
export function useHashTab(fallbackTab = 'dashboard') {
  const initial = () =>
    (typeof window !== 'undefined' && resolveTab(window.location.hash)) ||
    resolveTab(fallbackTab) || { tab: 'dashboard', section: null };
  const [state, setState] = useState(initial);

  useEffect(() => {
    const onHash = () => {
      const next = resolveTab(window.location.hash);
      if (next) setState(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const setTab = useCallback((value, section = null) => {
    const next = resolveTab(value) || { tab: 'dashboard', section: null };
    const resolved = { tab: next.tab, section: section || next.section };
    setState(resolved);
    const hash = `#${hashFor(resolved.tab)}`;
    if (window.location.hash !== hash) {
      window.history.pushState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
    }
    window.scrollTo({ top: 0 });
  }, []);

  return [state.tab, setTab, state.section];
}
