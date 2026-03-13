// Finanzas en Familia - App V2 (Firebase + Firestore, tiempo real)
// - Autenticación email/contraseña
// - Household compartido (código de hogar)
// - Datos en Firestore con sincronización en tiempo real
// - Validación de login con tooltip en caso de credenciales vacías o inválidas

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';

// Firebase
import { auth, db } from './firebase';

// Layout
import { Header } from './components/layout/header.jsx';
import { Money } from './components/ui/money.jsx';

// Módulos principales
import { Dashboard } from './modules/dashboard/Dashboard.jsx';
import { Transactions } from './modules/transactions/Transactions.jsx';
import { Budgets } from './modules/budgets/Budgets.jsx';
import { Debts } from './modules/debts/Debts.jsx';
import { Savings } from './modules/savings/Savings.jsx';
import { AuthGate } from './modules/auth/AuthGate.jsx';
import { Settings } from './modules/settings/Settings.jsx';

// Hooks y utils
import useHouseholdData from './hooks/useHouseholdData.js';
import {
  monthKey,
  shiftMonth,
  formatBudgetPeriodLabel,
  budgetMonthKeyForDate,
} from './utils/budgetPeriod.js';

// Config / estilos globales
import './App.css';

const INACTIVITY_TIMEOUT_MS = 20 * 60 * 1000;
const ACTIVITY_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

export default function App() {
  const [tab, setTab] = useState('dashboard');
  const [ctx, setCtx] = useState(null);

  const [selectedMonth, setSelectedMonth] = useState(monthKey());
  const [hasInitMonthByCutDay, setHasInitMonthByCutDay] = useState(false);

  const [showTrashModal, setShowTrashModal] = useState(false);
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [authedUser, setAuthedUser] = useState(null);
  const lastActivityRef = useRef(Date.now());
  const lastSyncRef = useRef(0);

  // Datos del hogar
  const h =
    useHouseholdData(ctx?.householdId, ctx?.user, {
      selectedMonthKey: selectedMonth,
    }) || {};
  const todayStr = new Date().toISOString().slice(0, 10);
  const selectedHid = ctx?.householdId || null;
  const trashItems = Array.isArray(h.trash) ? h.trash : [];
  const archivedDebts = Array.isArray(h.debts)
    ? h.debts.filter((d) => d && d.archived)
    : [];

  const budgetsForSelectedMonth = (h.budgets && h.budgets[selectedMonth]) || {};
  const householdUsers = h.householdUsers || [];
  const activeHouseholdUser = (() => {
    if (!ctx?.user || !Array.isArray(householdUsers)) return null;
    const uid = ctx.user.uid;
    const emailLower = String(ctx.user.email || '').toLowerCase();
    const byAuth = householdUsers.find((u) => u.authUid === uid);
    if (byAuth) return byAuth;
    if (emailLower) {
      return (
        householdUsers.find(
          (u) => String(u.email || '').toLowerCase() === emailLower,
        ) || null
      );
    }
    return null;
  })();
  const activeUser =
    activeHouseholdUser ||
    (ctx?.user
      ? {
          id: ctx.user.uid,
          name: ctx.user.displayName || ctx.user.email || 'Usuario',
          email: ctx.user.email || '',
          authUid: ctx.user.uid,
        }
      : null);

  // Estado de autenticación Firebase (email/contraseña)
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setAuthedUser(u));
    return () => unsub();
  }, []);

  // Ajustar el mes seleccionado según el día de corte al entrar
  useEffect(() => {
    if (!h || !h.budgetCutDay) return;
    if (h.budgets === null) return;
    if (!selectedHid) return;
    if (hasInitMonthByCutDay) return;

    const key = budgetMonthKeyForDate(todayStr, h.budgetCutDay || 1);
    setSelectedMonth(key);
    setHasInitMonthByCutDay(true);
  }, [selectedHid, h.budgetCutDay, h.budgets, hasInitMonthByCutDay, todayStr]);

  const handleLogout = useCallback(async () => {
    try {
      await signOut(auth);
    } catch (err) {
      console.error('Error cerrando sesion:', err);
    }
    setCtx(null);
    setAuthedUser(null);
  }, []);

  const syncActivity = useCallback(async () => {
    if (!ctx?.user?.uid || !ctx?.householdId) return;
    const now = Date.now();
    if (now - lastSyncRef.current < ACTIVITY_SYNC_INTERVAL_MS) return;
    lastSyncRef.current = now;
    try {
      await Promise.all([
        setDoc(
          doc(db, 'households', ctx.householdId),
          {
            lastActiveAt: serverTimestamp(),
            lastActiveBy: ctx.user.uid,
          },
          { merge: true },
        ),
        setDoc(
          doc(db, 'profiles', ctx.user.uid),
          {
            lastActiveAt: serverTimestamp(),
            lastActiveHouseholdId: ctx.householdId,
          },
          { merge: true },
        ),
      ]);
    } catch (err) {
      console.error('Error actualizando actividad:', err);
    }
  }, [ctx?.householdId, ctx?.user?.uid]);

  useEffect(() => {
    if (!ctx?.user?.uid || !ctx?.householdId) return;
    let timeoutId;

    const resetTimer = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        const idleFor = Date.now() - lastActivityRef.current;
        if (idleFor >= INACTIVITY_TIMEOUT_MS) {
          handleLogout();
        }
      }, INACTIVITY_TIMEOUT_MS);
    };

    const onActivity = () => {
      lastActivityRef.current = Date.now();
      syncActivity();
      resetTimer();
    };

    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    events.forEach((event) =>
      window.addEventListener(event, onActivity, { passive: true }),
    );

    lastActivityRef.current = Date.now();
    syncActivity();
    resetTimer();

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      events.forEach((event) =>
        window.removeEventListener(event, onActivity),
      );
    };
  }, [ctx?.householdId, ctx?.user?.uid, handleLogout, syncActivity]);

  // Preferencias de usuario de la casa
  const userPrefs = activeHouseholdUser?.preferences || {};
  const theme = userPrefs.ui?.theme || 'light';
  const density = userPrefs.ui?.density || 'normal';

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [theme]);

  // Datos compartidos a los módulos
  const data = {
    categories: h.categories,
    budgets: budgetsForSelectedMonth,
    budgetsAll: h.budgets,
    transactions: h.transactions,
    debts: h.debts,
    savings: h.savings,
    fixedCategories: h.fixedCategories,
    householdUsers: h.householdUsers,
    memberInfo: h.memberInfo,
    ownerUid: h.ownerUid,
    budgetCutDay: h.budgetCutDay,
    trash: h.trash,
  };

  const actions = {
    setBudget: h.setBudget,
    setBudgetPlan: h.setBudgetPlan,
    setBudgetFunded: (monthKeyStrArg, cat, value) =>
      h.setBudgetFunded(monthKeyStrArg, cat, value),
    addTransaction: h.addTransaction,
    updateTransaction: h.updateTransaction,
    removeTransaction: h.removeTransaction,
    addDebt: h.addDebt,
    updateDebt: h.updateDebt,
    removeDebt: h.removeDebt,
    addSaving: h.addSaving,
    updateSaving: h.updateSaving,
    removeSaving: h.removeSaving,
    addTrashItem: h.addTrashItem,
    restoreTrashItem: h.restoreTrashItem,
    purgeTrashItem: h.purgeTrashItem,
    addCategory: h.addCategory,
    removeCategory: h.removeCategory,
    renameCategory: h.renameCategory,
    setCategoryFixed: h.setCategoryFixed,
    moveCategoryInGroup: h.moveCategoryInGroup,
    addHouseholdUser: h.addHouseholdUser,
    updateHouseholdUser: h.updateHouseholdUser,
    removeHouseholdUser: h.removeHouseholdUser,
    setBudgetCutDay: h.setBudgetCutDay,
  };

  const hasCtx = !!ctx;
  const showTrashButton =
    hasCtx &&
    (tab === 'transactions' ||
      tab === 'budgets' ||
      tab === 'debts' ||
      tab === 'savings');
  const showArchiveButton = hasCtx && tab === 'debts';
  const headerUser = hasCtx ? ctx.user : authedUser;
  const headerHouseholdId = hasCtx ? selectedHid : null;
  const sortedTrashItems = [...trashItems].sort(
    (a, b) => Number(b?.deletedAt || 0) - Number(a?.deletedAt || 0),
  );
  const archiveSortKey = (item) => {
    const raw = item?.archivedAt;
    if (typeof raw === 'number') return raw;
    const parsed = Date.parse(raw || '');
    if (!Number.isNaN(parsed)) return parsed;
    return Number(item?.updatedAt || item?.createdAt || 0);
  };
  const sortedArchivedDebts = [...archivedDebts].sort(
    (a, b) => archiveSortKey(b) - archiveSortKey(a),
  );

  const trashTypeLabel = (item) => {
    if (item?.type === 'debt') return 'Deuda';
    if (item?.type === 'saving') return 'Ahorro';
    if (item?.type === 'transaction') return 'Movimiento';
    if (item?.type === 'budget-subcategory') return 'Subcategoria presupuesto';
    return 'Elemento';
  };

  const trashTitle = (item) => {
    const data = item?.data || {};
    if (item?.type === 'debt') return data.name || 'Deuda sin nombre';
    if (item?.type === 'saving') return data.name || 'Meta de ahorro';
    if (item?.type === 'transaction') {
      return data.description || data.category || 'Movimiento';
    }
    if (item?.type === 'budget-subcategory') {
      const sub = data.item || {};
      return sub.name || 'Subcategoria';
    }
    return 'Elemento eliminado';
  };

  const trashAmount = (item) => {
    const data = item?.data || {};
    if (item?.type === 'transaction') return Number(data.amount || 0);
    if (item?.type === 'saving') return Number(data.goal || 0);
    if (item?.type === 'debt') {
      const remaining = Number(data.remaining || 0);
      if (remaining) return remaining;
      return Number(data.original || 0);
    }
    if (item?.type === 'budget-subcategory') {
      const sub = data.item || {};
      return Number(sub.amount || 0);
    }
    return 0;
  };

  const archivedDebtTitle = (debt) => debt?.name || 'Deuda sin nombre';
  const archivedDebtAmount = (debt) => {
    const remaining = Number(debt?.remaining || 0);
    if (remaining > 0) return remaining;
    return Number(debt?.original || 0);
  };
  const archivedDebtMeta = (debt) => {
    const parts = [];
    const card = String(debt?.cardName || '').trim();
    const chargeDay = Number(debt?.chargeDay || 0);
    if (card) parts.push(`Tarjeta: ${card}`);
    if (chargeDay > 0) parts.push(`Cobro: ${chargeDay}`);
    return parts.join(' - ');
  };

  const handleRestoreArchivedDebt = async (debt) => {
    if (!h.updateDebt || !debt?.id) return;
    await h.updateDebt(debt.id, { archived: false, archivedAt: null });
  };

  const handleDeleteArchivedDebt = async (debt) => {
    if (!h.removeDebt || !debt?.id) return;
    const name = String(debt?.name || '').trim();
    const label = name ? ` "${name}"` : '';
    const ok = window.confirm(
      `Eliminar deuda archivada${label}? Se movera a la papelera.`,
    );
    if (!ok) return;
    await h.removeDebt(debt.id);
  };

  const trashMetaText = (item) => {
    const trashData = item?.data || {};
    if (item?.type === 'transaction') {
      const date = String(trashData.date || trashData.createdAt || '').slice(
        0,
        10,
      );
      const type = trashData.type ? String(trashData.type) : '';
      const category = trashData.category ? String(trashData.category) : '';
      return [type, category, date].filter(Boolean).join(' - ');
    }
    if (item?.type === 'saving') {
      const target = String(trashData.targetDate || '');
      return target ? `Meta: ${target}` : '';
    }
    if (item?.type === 'debt') {
      const due = String(trashData.due || trashData.firstDue || '');
      return due ? `Vence: ${due}` : '';
    }
    if (item?.type === 'budget-subcategory') {
      const category = String(trashData.category || '').trim();
      const periodKey = String(trashData.monthKey || '').trim();
      const periodLabel = periodKey
        ? formatBudgetPeriodLabel(periodKey, data.budgetCutDay || 1)
        : '';
      return [
        category ? `Categoria: ${category}` : '',
        periodLabel ? `Periodo: ${periodLabel}` : '',
      ]
        .filter(Boolean)
        .join(' - ');
    }
    return '';
  };

  const handleRestoreTrash = async (item) => {
    if (!actions.restoreTrashItem) return;
    await actions.restoreTrashItem(item);
  };

  const handlePurgeTrash = async (item) => {
    if (!actions.purgeTrashItem) return;
    const ok = window.confirm(
      'Eliminar definitivamente este elemento? Esta accion no se puede deshacer.',
    );
    if (!ok) return;
    await actions.purgeTrashItem(item?.id);
  };

  if (!hasCtx) {
    return (
      <div className="min-h-screen bg-[color:var(--bg)] text-[color:var(--text)]">
        <AuthGate onReady={(c) => setCtx(c)} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[color:var(--bg)] text-[color:var(--text)]">
      <div>
        <div className="flex min-h-screen flex-col md:flex-row">
          <Header
            currentTab={tab}
            setTab={setTab}
            user={headerUser}
            onLogout={handleLogout}
            householdId={headerHouseholdId}
            mobileOpen={mobileMenuOpen}
            setMobileOpen={setMobileMenuOpen}
            showMobileTopBar={tab === 'settings'}
          />
          <div
            className={`flex-1 min-w-0 ${
              tab === 'settings' ? 'with-mobile-header-offset' : ''
            }`}
          >
            {tab !== 'settings' && (() => {
              const today = new Date().toISOString().slice(0, 10);
              const currentBudgetKey = budgetMonthKeyForDate(
                today,
                data.budgetCutDay || 1,
              );
              const isCurrentPeriod = selectedMonth === currentBudgetKey;
              return (
                <div className="sticky top-0 z-30 border-b border-[color:var(--divider)] bg-[color:var(--surface-1)]/80 backdrop-blur">
                  <div className="w-full max-w-none px-4 py-2 grid grid-cols-[auto_1fr] items-center gap-3 text-sm text-[color:var(--text)]">
                    {headerUser && headerHouseholdId && (
                      <button
                        type="button"
                        onClick={() => setMobileMenuOpen((prev) => !prev)}
                        className="md:hidden flex items-center rounded-r-full bg-blue-900 text-blue-100 px-4 py-2 shadow-sm -ml-4 transition active:scale-95"
                        aria-label={mobileMenuOpen ? 'Cerrar menu' : 'Abrir menu'}
                        aria-expanded={mobileMenuOpen}
                      >
                        <img
                          src="/logo-finanzas-en-familia.png"
                          alt="Finanzas en Familia"
                          className="h-7 w-7 object-contain"
                          decoding="async"
                        />
                        <span className="sr-only">Finanzas en Familia</span>
                      </button>
                    )}
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <div className="grid min-w-0 grid-cols-[minmax(2rem,auto)_auto_minmax(2rem,auto)] items-center gap-2">
                        <button
                          className="period-nav-button w-full h-8 min-h-[32px] inline-flex items-center justify-center rounded-md border border-[color:var(--border)] bg-[color:var(--surface-2)] text-[color:var(--text)] shadow-sm transition-colors duration-150 hover:bg-[color:var(--surface-1)] active:bg-[color:var(--surface-2)] active:shadow-inner disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={() =>
                            setSelectedMonth((prev) => shiftMonth(prev, -1))
                          }
                        >
                          <svg
                            className="h-4 w-4"
                            viewBox="0 0 20 20"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M12.5 5l-5 5 5 5" />
                          </svg>
                        </button>
                        <span className="font-medium text-center text-[color:var(--text)] whitespace-nowrap">
                          {formatBudgetPeriodLabel(
                            selectedMonth,
                            data.budgetCutDay || 1,
                          )}
                        </span>
                        <button
                          className="period-nav-button w-full h-8 min-h-[32px] inline-flex items-center justify-center rounded-md border border-[color:var(--border)] bg-[color:var(--surface-2)] text-[color:var(--text)] shadow-sm transition-colors duration-150 hover:bg-[color:var(--surface-1)] active:bg-[color:var(--surface-2)] active:shadow-inner disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={() =>
                            setSelectedMonth((prev) => shiftMonth(prev, 1))
                          }
                        >
                          <svg
                            className="h-4 w-4"
                            viewBox="0 0 20 20"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M7.5 5l5 5-5 5" />
                          </svg>
                        </button>
                      </div>
                      <button
                        className={`period-current-button px-2 sm:px-3 py-1 border rounded-lg shadow-sm transition active:scale-[0.98] active:brightness-95 whitespace-normal text-center leading-tight max-w-[140px] sm:max-w-none text-xs sm:text-sm ${
                          isCurrentPeriod
                            ? 'bg-[color:var(--primary)] text-[color:var(--primary-contrast)] border-[color:var(--primary)] hover:brightness-110'
                            : 'bg-[color:var(--surface-2)] text-[color:var(--text)] border-[color:var(--border)] hover:bg-[color:var(--surface-1)]'
                        }`}
                        onClick={() => setSelectedMonth(currentBudgetKey)}
                      >
                        {isCurrentPeriod
                          ? 'Periodo Actual'
                          : 'Ir al periodo actual'}
                      </button>
                      {showTrashButton && (
                        <>
                          {showArchiveButton && (
                            <button
                              type="button"
                              className="period-current-button h-9 w-9 inline-flex items-center justify-center border rounded-lg bg-[color:var(--surface-2)] text-[color:var(--text)] shadow-sm transition active:scale-[0.98] active:brightness-95 hover:bg-[color:var(--surface-1)]"
                              onClick={() => setShowArchiveModal(true)}
                              aria-label="Archivados"
                              title="Archivados"
                            >
                              <svg
                                className="h-5 w-5"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <rect x="3" y="4" width="18" height="5" rx="1" />
                                <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" />
                                <path d="M10 13h4" />
                              </svg>
                            </button>
                          )}
                          <button
                            type="button"
                            className="period-current-button h-9 w-9 inline-flex items-center justify-center border rounded-lg bg-[color:var(--surface-2)] text-[color:var(--text)] shadow-sm transition active:scale-[0.98] active:brightness-95 hover:bg-[color:var(--surface-1)]"
                            onClick={() => setShowTrashModal(true)}
                            aria-label="Papelera"
                            title="Papelera"
                          >
                          <svg
                            className="h-5 w-5"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M3 6h18" />
                            <path d="M8 6V4h8v2" />
                            <path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
                            <path d="M10 11v6" />
                              <path d="M14 11v6" />
                            </svg>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}

        {hasCtx && showTrashModal && (
          <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/40 px-4 py-10">
            <div className="w-full max-w-3xl rounded-2xl bg-[color:var(--surface-1)] text-[color:var(--text)] shadow-xl">
              <div className="flex items-center justify-between border-b border-[color:var(--divider)] px-5 py-3">
                <h3 className="text-lg font-semibold">Papelera</h3>
                <button
                  type="button"
                  className="text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                  onClick={() => setShowTrashModal(false)}
                >
                  Cerrar
                </button>
              </div>
              <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
                {sortedTrashItems.length ? (
                  <div className="grid gap-3">
                    {sortedTrashItems.map((item) => {
                      const amount = trashAmount(item);
                      const meta = trashMetaText(item);
                      return (
                        <div
                          key={item.id}
                          className="flex flex-col gap-3 rounded-xl border border-[color:var(--border)] p-4 sm:flex-row sm:items-center sm:justify-between bg-[color:var(--surface-2)]"
                        >
                          <div className="min-w-0">
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">
                              {trashTypeLabel(item)}
                            </div>
                            <div className="truncate font-semibold">
                              {trashTitle(item)}
                            </div>
                            {meta && (
                              <div className="text-xs text-[color:var(--text-muted)]">
                                {meta}
                              </div>
                            )}
                            {amount ? (
                              <div className="text-xs text-[color:var(--text-muted)]">
                                <Money n={amount} />
                              </div>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              className="rounded-lg border border-[color:var(--success)]/30 bg-[color:var(--success)]/15 px-3 py-1.5 text-xs font-semibold text-[color:var(--success)] transition hover:bg-[color:var(--success)]/25"
                              onClick={() => handleRestoreTrash(item)}
                            >
                              Recuperar
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border border-[color:var(--danger)]/30 bg-[color:var(--danger)]/15 px-3 py-1.5 text-xs font-semibold text-[color:var(--danger)] transition hover:bg-[color:var(--danger)]/25"
                              onClick={() => handlePurgeTrash(item)}
                            >
                              Eliminar definitivo
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-sm text-[color:var(--text-muted)]">
                    No hay elementos eliminados.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {hasCtx && showArchiveModal && (
          <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/40 px-4 py-10">
            <div className="w-full max-w-3xl rounded-2xl bg-[color:var(--surface-1)] text-[color:var(--text)] shadow-xl">
              <div className="flex items-center justify-between border-b border-[color:var(--divider)] px-5 py-3">
                <h3 className="text-lg font-semibold">Archivados</h3>
                <button
                  type="button"
                  className="text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                  onClick={() => setShowArchiveModal(false)}
                >
                  Cerrar
                </button>
              </div>
              <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
                {sortedArchivedDebts.length ? (
                  <div className="grid gap-3">
                    {sortedArchivedDebts.map((debt) => {
                      const meta = archivedDebtMeta(debt);
                      return (
                        <div
                          key={debt.id}
                          className="flex flex-col gap-3 rounded-xl border border-[color:var(--border)] p-4 sm:flex-row sm:items-center sm:justify-between bg-[color:var(--surface-2)]"
                        >
                          <div className="min-w-0">
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">
                              Deuda archivada
                            </div>
                            <div className="truncate font-semibold">
                              {archivedDebtTitle(debt)}
                            </div>
                            {meta && (
                              <div className="mt-1 text-xs text-[color:var(--text-muted)]">
                                {meta}
                              </div>
                            )}
                            <div className="mt-1 text-sm font-semibold">
                              <Money n={archivedDebtAmount(debt)} />
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <button
                              className="rounded-lg border border-[color:var(--success)]/40 bg-[color:var(--success)]/10 px-3 py-1.5 text-xs font-semibold text-[color:var(--success)] transition hover:bg-[color:var(--success)]/20"
                              onClick={() => handleRestoreArchivedDebt(debt)}
                            >
                              Recuperar
                            </button>
                            <button
                              className="rounded-lg border border-[color:var(--danger)]/30 bg-[color:var(--danger)]/15 px-3 py-1.5 text-xs font-semibold text-[color:var(--danger)] transition hover:bg-[color:var(--danger)]/25"
                              onClick={() => handleDeleteArchivedDebt(debt)}
                            >
                              Eliminar
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-sm text-[color:var(--text-muted)]">
                    No hay deudas archivadas.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <main
          className={`${tab === 'debts' || tab === 'savings' ? 'w-full max-w-none' : 'max-w-6xl mx-auto'} px-4 py-4 grid gap-4 ${
            density === 'compact' ? 'text-xs' : 'text-sm'
          }`}
        >
          {!hasCtx && <AuthGate onReady={(c) => setCtx(c)} />}

          {tab === 'dashboard' && (
            <Dashboard
              data={{
                categories: data.categories,
                budgets: data.budgets,
                budgetsAll: data.budgetsAll,
                transactions: data.transactions,
                debts: data.debts,
                savings: data.savings,
                fixedCategories: data.fixedCategories,
                budgetCutDay: data.budgetCutDay,
                activeUserPreferences: userPrefs,
              }}
              monthKeyStr={selectedMonth}
            />
          )}

          {tab === 'transactions' && (
            <Transactions
              data={{
                transactions: data.transactions,
                categories: data.categories,
                debts: data.debts,
                savings: data.savings,
                budgets: data.budgets,
                budgetsAll: data.budgetsAll,
                fixedCategories: data.fixedCategories,
                householdUsers: data.householdUsers,
              }}
              actions={actions}
              activeUser={activeUser}
              monthKeyStr={selectedMonth}
              budgetCutDay={data.budgetCutDay}
            />
          )}

          {tab === 'budgets' && (
            <Budgets
              data={{
                budgets: data.budgets,
                budgetsAll: data.budgetsAll,
                transactions: data.transactions,
                categories: data.categories,
                fixedCategories: data.fixedCategories,
                budgetCutDay: data.budgetCutDay,
                debts: data.debts,
                savings: data.savings,
              }}
              actions={actions}
              monthKeyStr={selectedMonth}
            />
          )}

          {tab === 'debts' && (
            <Debts
              data={{
                debts: data.debts,
                transactions: data.transactions,
                budgetCutDay: data.budgetCutDay,
              }}
              actions={actions}
              monthKeyStr={selectedMonth}
            />
          )}

          {tab === 'savings' && (
            <Savings
              data={{
                savings: data.savings,
                transactions: data.transactions,
                budgetCutDay: data.budgetCutDay,
              }}
              actions={actions}
              monthKeyStr={selectedMonth}
            />
          )}

          {tab === 'settings' && (
            <Settings
              data={{
                budgets: data.budgets,
                transactions: data.transactions,
                debts: data.debts,
                savings: data.savings,
                householdUsers: data.householdUsers,
                memberInfo: data.memberInfo,
                ownerUid: data.ownerUid,
                budgetCutDay: data.budgetCutDay,
                fixedCategories: data.fixedCategories,
              }}
              householdId={selectedHid}
              user={ctx.user}
              categories={data.categories}
              actions={actions}
              activeHouseholdUser={activeHouseholdUser}
            />
          )}
        </main>

      </div>
    </div>
  </div>
</div>
);
}
