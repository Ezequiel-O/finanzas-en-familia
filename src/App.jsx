// Finanzas en Familia - App V2 (Firebase + Firestore, tiempo real)
// - Autenticación email/contraseña
// - Household compartido (código de hogar)
// - Datos en Firestore con sincronización en tiempo real
// - Validación de login con tooltip en caso de credenciales vacías o inválidas

import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';

// Firebase
import { auth, db } from './firebase';

// Layout y avisos
import { Header } from './components/layout/Header.jsx';
import { BottomNav } from './components/layout/BottomNav.jsx';
import { Money } from './components/ui/Money.jsx';
import { ErrorBoundary } from './components/feedback/ErrorBoundary.jsx';
import { FeedbackHost } from './components/feedback/FeedbackHost.jsx';
import { confirmDialog } from './components/feedback/feedback.js';
import { parseIntent } from './ai/intentParser.js';

// Dominio y navegación
import { buildDebtPaidIndex, debtProgress } from './domain/commitments.js';
import { todayKey } from './domain/dates.js';
import { useHashTab } from './navigation/tabs.js';

// Siempre visibles al entrar
import { AuthGate } from './modules/auth/AuthGate.jsx';
import { QuickAddSheet } from './features/quick-add/QuickAddSheet.jsx';
import { CommitmentsPanel } from './features/plan/CommitmentsPanel.jsx';
import { UpcomingCard } from './features/plan/UpcomingCard.jsx';
import { PlanScreen } from './features/plan/PlanCards.jsx';
import { PeriodClosingCard } from './features/plan/PeriodClosingCard.jsx';
import { FinancialHealthCard } from './features/plan/FinancialHealthCard.jsx';

// Pestañas: se cargan al abrirlas para achicar la descarga inicial
const named = (loader, name) => lazy(() => loader().then((m) => ({ default: m[name] })));
const Dashboard = named(() => import('./modules/dashboard/Dashboard.jsx'), 'Dashboard');
const Transactions = named(() => import('./modules/transactions/Transactions.jsx'), 'Transactions');
const Budgets = named(() => import('./modules/budgets/Budgets.jsx'), 'Budgets');
const CommitmentsPage = named(() => import('./features/commitments/CommitmentsPage.jsx'), 'CommitmentsPage');
const Settings = named(() => import('./modules/settings/Settings.jsx'), 'Settings');

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

function TabFallback() {
  return (
    <div className="py-10 text-center text-sm text-[color:var(--text-muted)]" role="status">
      Cargando…
    </div>
  );
}

export default function App() {
  const [tab, setTab, tabSection] = useHashTab('dashboard');
  const [commitmentsSection, setCommitmentsSection] = useState('debts');
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [ctx, setCtx] = useState(null);

  const [selectedMonth, setSelectedMonth] = useState(monthKey());
  const [hasInitMonthByCutDay, setHasInitMonthByCutDay] = useState(false);

  const [showTrashModal, setShowTrashModal] = useState(false);
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiText, setAiText] = useState('');
  const [aiListening, setAiListening] = useState(false);
  const [aiStatus, setAiStatus] = useState('');
  const [aiInterim, setAiInterim] = useState('');
  const [aiError, setAiError] = useState('');
  const [aiPlan, setAiPlan] = useState(null);
  const aiRecognitionRef = useRef(null);
  const aiManualStopRef = useRef(false);
  const aiListenTimerRef = useRef(null);

  const [authedUser, setAuthedUser] = useState(null);
  const lastActivityRef = useRef(Date.now());
  const lastSyncRef = useRef(0);

  // Datos del hogar
  const h =
    useHouseholdData(ctx?.householdId, ctx?.user, {
      selectedMonthKey: selectedMonth,
    }) || {};
  const todayStr = todayKey();
  const selectedHid = ctx?.householdId || null;
  const trashItems = Array.isArray(h.trash) ? h.trash : [];
  const archivedDebts = Array.isArray(h.debts)
    ? h.debts.filter((d) => d && d.archived)
    : [];
  const debtPaidIndex = useMemo(
    () => buildDebtPaidIndex(h.transactions || []),
    [h.transactions],
  );

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

  const stopAiDictation = useCallback(() => {
    aiManualStopRef.current = true;
    if (aiListenTimerRef.current) {
      clearTimeout(aiListenTimerRef.current);
      aiListenTimerRef.current = null;
    }
    const recognition = aiRecognitionRef.current;
    if (recognition) {
      recognition.stop();
    }
    setAiListening(false);
    setAiInterim('');
  }, []);

  const startAiDictation = useCallback(() => {
    if (aiListening) return;
    setAiError('');
    setAiStatus('');
    setAiInterim('');
    aiManualStopRef.current = false;
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setAiError('Transcripción no disponible en este navegador.');
      return;
    }
    const recognition = new SpeechRecognition();
    aiRecognitionRef.current = recognition;
    recognition.lang = navigator.language || 'es-CL';
    recognition.interimResults = true;
    recognition.continuous = true;

    recognition.onresult = (event) => {
      let interimText = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript || '';
        if (result.isFinal) {
          finalText += transcript;
        } else {
          interimText += transcript;
        }
      }
      if (interimText) setAiInterim(interimText.trim());
      if (finalText.trim()) {
        setAiText((prev) =>
          prev ? `${prev} ${finalText.trim()}` : finalText.trim(),
        );
        setAiInterim('');
        setAiStatus('Transcripción lista (pendiente de IA).');
      }
    };

    recognition.onerror = (event) => {
      if (!aiManualStopRef.current && event?.error === 'no-speech') {
        return;
      }
      setAiError('No se pudo transcribir el audio.');
      aiManualStopRef.current = true;
      setAiListening(false);
      setAiInterim('');
    };

    recognition.onend = () => {
      if (aiManualStopRef.current) {
        setAiListening(false);
        setAiInterim('');
        return;
      }
      try {
        recognition.start();
      } catch {
        setAiError('No se pudo reanudar el dictado.');
        setAiListening(false);
      }
    };

    recognition.start();
    setAiListening(true);
    setAiStatus('Escuchando...');
    if (aiListenTimerRef.current) {
      clearTimeout(aiListenTimerRef.current);
    }
    aiListenTimerRef.current = setTimeout(() => {
      aiManualStopRef.current = true;
      setAiStatus('Dictado finalizado (límite 2 min).');
      const rec = aiRecognitionRef.current;
      if (rec) rec.stop();
      setAiListening(false);
      setAiInterim('');
      aiListenTimerRef.current = null;
    }, 120000);
  }, [aiListening]);

  const handleAiToggle = useCallback(() => {
    if (aiListening) stopAiDictation();
    setAiOpen((prev) => !prev);
  }, [aiListening, stopAiDictation]);

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

  // Sección de Compromisos pedida por enlace antiguo (#deudas / #ahorro).
  useEffect(() => {
    if (tabSection) setCommitmentsSection(tabSection);
  }, [tabSection]);

  // Pestaña inicial según preferencias, solo si la URL no trae una.
  const appliedDefaultTabRef = useRef(false);
  const preferredTab = userPrefs.defaultTab;
  useEffect(() => {
    if (appliedDefaultTabRef.current || !activeHouseholdUser) return;
    appliedDefaultTabRef.current = true;
    if (!window.location.hash && preferredTab && preferredTab !== 'dashboard') {
      setTab(preferredTab);
    }
  }, [activeHouseholdUser, preferredTab, setTab]);

  // Atajo del ícono instalado: "Registrar gasto" abre el formulario rápido.
  useEffect(() => {
    if (!ctx) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('accion') !== 'nuevo-gasto') return;
    setQuickAddOpen(true);
    params.delete('accion');
    const query = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
    );
  }, [ctx]);

  // Datos compartidos a los módulos
  const data = {
    categories: h.categories,
    budgets: budgetsForSelectedMonth,
    budgetsAll: h.budgets,
    transactions: h.transactions,
    debts: h.debts,
    savings: h.savings,
    fixedCategories: h.fixedCategories,
    priorityCategories: h.priorityCategories,
    fixedDueDays: h.fixedDueDays,
    householdUsers: h.householdUsers,
    memberInfo: h.memberInfo,
    ownerUid: h.ownerUid,
    budgetCutDay: h.budgetCutDay,
    expectedIncome: h.expectedIncome,
    closings: h.closings,
    trash: h.trash,
    activeUser,
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
    setCategoryPriority: h.setCategoryPriority,
    setCategoryDueDay: h.setCategoryDueDay,
    moveCategoryInGroup: h.moveCategoryInGroup,
    addHouseholdUser: h.addHouseholdUser,
    updateHouseholdUser: h.updateHouseholdUser,
    removeHouseholdUser: h.removeHouseholdUser,
    setBudgetCutDay: h.setBudgetCutDay,
    exportFinances: h.exportFinances,
    resetFinances: h.resetFinances,
    setExpectedIncome: h.setExpectedIncome,
    closePeriod: h.closePeriod,
    reopenPeriod: h.reopenPeriod,
    fetchAuditLog: h.fetchAuditLog,
  };

  const handleAiSendText = useCallback(() => {
    const input = aiText.trim();
    if (!input) return;
    try {
      const result = parseIntent(input, {
        categories: data.categories,
        transactions: data.transactions,
      });
      if (result.type === 'clarify') {
        setAiPlan(null);
        setAiStatus(result.message);
        return;
      }
      if (result.type === 'plan') {
        setAiPlan(result.plan);
        setAiStatus('Revisa y confirma la acción.');
        return;
      }
      setAiStatus('No pude interpretar la instrucción.');
    } catch (err) {
      console.error('AI parse error:', err);
      setAiError('No se pudo interpretar la instrucción.');
    }
  }, [aiText, data.categories, data.transactions]);

  const handleAiConfirm = useCallback(async () => {
    if (!aiPlan) return;
    setAiError('');
    try {
      if (aiPlan.kind === 'create_transaction') {
        if (!actions?.addTransaction) {
          setAiError('Acción no disponible.');
          return;
        }
        const payload = {
          type: aiPlan.payload.type,
          amount: Math.round(Number(aiPlan.payload.amount || 0)),
          category: aiPlan.payload.category || 'Ingresos',
          description: aiPlan.payload.description || '',
          date: aiPlan.payload.date,
          ownerId: activeUser?.id || null,
          ownerName: activeUser?.name || null,
          ownerEmail: activeUser?.email || null,
          createdAt: new Date().toISOString(),
        };
        const createdId = await actions.addTransaction(payload);
        if (!createdId) {
          setAiError('No se pudo guardar el movimiento.');
          return;
        }
      } else if (aiPlan.kind === 'update_transaction') {
        if (!actions?.updateTransaction) {
          setAiError('Acción no disponible.');
          return;
        }
        await actions.updateTransaction(aiPlan.payload.id, aiPlan.payload.patch);
      } else if (aiPlan.kind === 'delete_transaction') {
        if (!actions?.removeTransaction) {
          setAiError('Acción no disponible.');
          return;
        }
        await actions.removeTransaction(aiPlan.payload.id);
      } else if (aiPlan.kind === 'set_budget') {
        if (!actions?.setBudget) {
          setAiError('Acción no disponible.');
          return;
        }
        await actions.setBudget(aiPlan.payload.category, aiPlan.payload.amount);
      }
      setAiStatus('Acción ejecutada.');
      setAiPlan(null);
      setAiText('');
    } catch (err) {
      console.error('AI action error:', err);
      setAiError('No se pudo ejecutar la acción.');
    }
  }, [aiPlan, actions, activeUser]);

  const handleAiCancelPlan = useCallback(() => {
    setAiPlan(null);
    setAiStatus('Acción cancelada.');
  }, []);

  const hasCtx = !!ctx;
  const showTrashButton =
    hasCtx &&
    (tab === 'transactions' || tab === 'plan' || tab === 'commitments');
  const showArchiveButton =
    hasCtx && tab === 'commitments' && commitmentsSection === 'debts';
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
  // Saldo real desde los pagos registrados (el campo `remaining` guardado puede estar desactualizado).
  const archivedDebtAmount = (debt) => {
    const progress = debtProgress(debt, debtPaidIndex);
    return progress.remaining > 0 ? progress.remaining : progress.total;
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
    const ok = await confirmDialog(
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
    const ok = await confirmDialog(
      'Eliminar definitivamente este elemento? Esta accion no se puede deshacer.',
    );
    if (!ok) return;
    await actions.purgeTrashItem(item?.id);
  };

  if (!hasCtx) {
    return (
      <div className="min-h-screen bg-[color:var(--bg)] text-[color:var(--text)]">
        <AuthGate onReady={(c) => setCtx(c)} />
        <FeedbackHost />
      </div>
    );
  }

  const aiFloating = (
    <div className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] md:bottom-4 right-4 left-auto z-[9999]">
      {!aiOpen ? (
        <button
          type="button"
          className="ai-fab h-12 w-12 md:h-16 md:w-16 rounded-full shadow-lg hover:brightness-105 active:scale-95 transition text-sm md:text-base font-semibold tracking-wide"
          onClick={handleAiToggle}
          aria-label="Abrir asistente"
        >
          IA
        </button>
      ) : (
        <div className="ai-panel w-[min(90vw,360px)] rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-1)] shadow-[var(--shadow)] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Asistente</div>
            <button
              type="button"
              className="text-xs text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
              onClick={handleAiToggle}
            >
              Cerrar
            </button>
          </div>
          <textarea
            className="w-full rounded-lg border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm"
            rows={3}
            placeholder="Escribe tu solicitud (o pega la transcripción aquí)"
            value={aiText}
            onChange={(e) => {
              setAiText(e.target.value);
              setAiStatus('');
              setAiPlan(null);
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            {aiListening ? (
              <button
                type="button"
                className="px-3 py-1.5 text-xs rounded-lg border border-[color:var(--danger)]/40 text-[color:var(--danger)] hover:bg-[color:var(--danger)]/10"
                onClick={stopAiDictation}
              >
                Detener dictado
              </button>
            ) : (
              <button
                type="button"
                className="px-3 py-1.5 text-xs rounded-lg border text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)]"
                onClick={startAiDictation}
              >
                Dictar
              </button>
            )}
          </div>
          {aiListening && (
            <div className="flex items-center gap-2 text-xs text-[color:var(--text-muted)]">
              <span className="ai-listening-dot" />
              Escuchando...
            </div>
          )}
          {aiInterim && (
            <div className="text-xs text-[color:var(--text-muted)]">
              {aiInterim}
            </div>
          )}
          {aiError && (
            <div className="text-xs text-[color:var(--danger)]">{aiError}</div>
          )}
          {aiStatus && (
            <div className="text-xs text-[color:var(--text-muted)]">
              {aiStatus}
            </div>
          )}
          {aiPlan && (
            <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-2)]/60 p-3 text-xs space-y-2">
              <div className="font-semibold text-[color:var(--text)]">
                Confirmar acción
              </div>
              <div className="text-[color:var(--text-muted)]">
                {aiPlan.summary}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="flex-1 px-3 py-2 text-xs rounded-lg border bg-[color:var(--primary)] text-[color:var(--primary-contrast)] disabled:opacity-60"
                  onClick={handleAiConfirm}
                >
                  Confirmar
                </button>
                <button
                  type="button"
                  className="flex-1 px-3 py-2 text-xs rounded-lg border text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)]"
                  onClick={handleAiCancelPlan}
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="flex-1 px-3 py-2 text-xs rounded-lg border text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)] disabled:opacity-60"
              onClick={handleAiSendText}
              disabled={!aiText.trim()}
            >
              Enviar texto
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-[color:var(--bg)] text-[color:var(--text)] overflow-x-clip">
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
              const today = todayKey();
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
                      <button
                        type="button"
                        onClick={() => setQuickAddOpen(true)}
                        className="hidden md:inline-flex h-9 items-center gap-1 rounded-lg bg-[color:var(--primary)] px-3 text-sm font-semibold text-[color:var(--primary-contrast)] shadow-sm active:scale-[0.98]"
                      >
                        + Registrar gasto
                      </button>
                      <div className="grid min-w-0 grid-cols-[minmax(2rem,auto)_auto_minmax(2rem,auto)] items-center gap-2">
                        <button
                          className="period-nav-button w-full h-8 min-h-[32px] inline-flex items-center justify-center rounded-md border border-[color:var(--border)] bg-[color:var(--surface-2)] text-[color:var(--text)] shadow-sm transition-colors duration-150 hover:bg-[color:var(--surface-1)] active:bg-[color:var(--surface-2)] active:shadow-inner disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={() =>
                            setSelectedMonth((prev) => shiftMonth(prev, -1))
                          }
                          aria-label="Periodo anterior"
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
                          aria-label="Periodo siguiente"
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
          className={`${tab === 'commitments' ? 'w-full max-w-none' : 'max-w-6xl mx-auto'} px-4 pt-4 pb-28 md:pb-6 grid gap-4 ${
            density === 'compact' ? 'text-xs' : 'text-sm'
          }`}
        >
          <ErrorBoundary resetKey={tab}>
            <Suspense fallback={<TabFallback />}>
              {tab === 'dashboard' && (
                <>
                  <UpcomingCard
                    data={data}
                    actions={actions}
                    activeUser={activeUser}
                    onOpenPlan={() => setTab('plan')}
                  />
                  <FinancialHealthCard data={data} periodKey={selectedMonth} />
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
                </>
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

              {tab === 'plan' && (
                <PlanScreen
                  data={data}
                  budgetsTable={
                    <Budgets
                      data={{
                        budgets: data.budgets,
                        budgetsAll: data.budgetsAll,
                        transactions: data.transactions,
                        categories: data.categories,
                        fixedCategories: data.fixedCategories,
                        fixedDueDays: data.fixedDueDays,
                        budgetCutDay: data.budgetCutDay,
                        debts: data.debts,
                        savings: data.savings,
                      }}
                      actions={actions}
                      activeUser={activeUser}
                      monthKeyStr={selectedMonth}
                    />
                  }
                  commitments={
                    <CommitmentsPanel
                      data={data}
                      actions={actions}
                      activeUser={activeUser}
                      periodKey={selectedMonth}
                      onOpenCommitments={() => setTab('commitments')}
                    />
                  }
                  closing={
                    <PeriodClosingCard
                      data={data}
                      actions={actions}
                      activeUser={activeUser}
                      periodKey={selectedMonth}
                      isOwner={!!data.ownerUid && data.ownerUid === ctx.user?.uid}
                    />
                  }
                />
              )}

              {tab === 'commitments' && (
                <CommitmentsPage
                  section={commitmentsSection}
                  onSectionChange={setCommitmentsSection}
                  data={data}
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
                    priorityCategories: data.priorityCategories,
                  }}
                  householdId={selectedHid}
                  user={ctx.user}
                  categories={data.categories}
                  actions={actions}
                  activeHouseholdUser={activeHouseholdUser}
                />
              )}
            </Suspense>
          </ErrorBoundary>
        </main>

        <BottomNav
          currentTab={tab}
          setTab={setTab}
          onQuickAdd={() => setQuickAddOpen(true)}
        />

        <QuickAddSheet
          open={quickAddOpen}
          onClose={() => setQuickAddOpen(false)}
          categories={data.categories || []}
          budgetsAll={data.budgetsAll || {}}
          transactions={data.transactions || []}
          budgetCutDay={data.budgetCutDay || 1}
          fixedCategories={data.fixedCategories || {}}
          householdUsers={data.householdUsers || []}
          activeUser={activeUser}
          actions={actions}
        />

        <FeedbackHost />

        {typeof document !== 'undefined'
          ? createPortal(aiFloating, document.body)
          : aiFloating}

      </div>
    </div>
  </div>
</div>
);
}
