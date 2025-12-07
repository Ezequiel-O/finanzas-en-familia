import { useState, useEffect } from 'react';
import {
  doc,
  setDoc,
  getDoc,
  onSnapshot,
  updateDoc,
  arrayUnion,
  collection,
  addDoc,
  deleteDoc,
  getDocs,
  query,
  where,
} from 'firebase/firestore';
import { db } from '../firebase';
import { DEBT_CATEGORY, CATEGORIES } from '../constants.js';
import { monthKey } from '../utils/budgetPeriod';

export default function useHouseholdData(householdId) {
  const [categories, setCategories] = useState(CATEGORIES);
  const [budgets, setBudgets] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [debts, setDebts] = useState([]);
  const [savings, setSavings] = useState([]);
  const [householdUsers, setHouseholdUsers] = useState([]);
  const [superAdminEmail, setSuperAdminEmail] = useState(null);
  const [budgetCutDay, setBudgetCutDayState] = useState(1);

  useEffect(() => {
    if (!householdId) return;

    const unsubHH = onSnapshot(doc(db, 'households', householdId), (snap) => {
      const d = snap.data() || {};
      const rawCats =
        d.categories && Array.isArray(d.categories)
          ? d.categories
          : [...CATEGORIES];

      // Asegurar que "Deudas" exista y vaya al comienzo
      let cats;
      if (!rawCats.includes(DEBT_CATEGORY)) {
        cats = [DEBT_CATEGORY, ...rawCats];
      } else {
        cats = [DEBT_CATEGORY, ...rawCats.filter((c) => c !== DEBT_CATEGORY)];
      }

      setCategories(cats);

      // Presupuestos por mes guardados en el campo "budgets"
      const rawBudgets = d.budgets || {};
      setBudgets(rawBudgets);

      let rawUsers = Array.isArray(d.householdUsers) ? d.householdUsers : [];
      const hasSuper = rawUsers.some((u) => u.isSuperAdmin);

      if (!hasSuper && d.superAdminEmail) {
        const superUser = {
          id: 'super-admin',
          name: '',
          pin: '',
          isSuperAdmin: true,
          preferences: {
            defaultTab: 'dashboard',
            showOnlyMyMovements: false,
            dashboardCards: {
              resumenMes: true,
              deudas: true,
              ahorro: true,
              presupuestos: true,
            },
            transactionsDefaults: {
              type: 'gasto',
              defaultCategory: cats[0] || CATEGORIES[0],
            },
            ui: {
              theme: 'light',
              density: 'normal',
            },
          },
        };
        rawUsers = [...rawUsers, superUser];

        updateDoc(doc(db, 'households', householdId), {
          householdUsers: rawUsers,
        }).catch((err) =>
          console.error('Error auto-creando super admin:', err),
        );
      }

      setHouseholdUsers(rawUsers);
      setSuperAdminEmail(d.superAdminEmail || null);
      setBudgetCutDayState(d.budgetCutDay || 1);
    });

    const unsubTx = onSnapshot(
      collection(db, 'households', householdId, 'transactions'),
      (snap) => {
        setTransactions(snap.docs.map((d) => ({ ...d.data(), id: d.id })));
      },
    );

    const unsubDebts = onSnapshot(
      collection(db, 'households', householdId, 'debts'),
      (snap) => {
        setDebts(snap.docs.map((d) => ({ ...d.data(), id: d.id })));
      },
    );

    const unsubSavings = onSnapshot(
      collection(db, 'households', householdId, 'savings'),
      (snap) => {
        setSavings(snap.docs.map((d) => ({ ...d.data(), id: d.id })));
      },
    );

    return () => {
      unsubHH();
      unsubTx();
      unsubDebts();
      unsubSavings();
    };
  }, [householdId]);

  // Helpers internos para no repetir lógica
  function normalizeBudgetEntry(entry) {
    if (typeof entry === 'number') {
      const n = Number(entry || 0);
      return { plan: n, funded: n };
    }
    if (entry && typeof entry === 'object') {
      const plan = Number(entry.plan || 0);
      const funded = Number(
        entry.funded !== undefined ? entry.funded : entry.plan || 0,
      );
      return { plan, funded };
    }
    return { plan: 0, funded: 0 };
  }

  async function setBudget(cat, value) {
    // Compatibilidad: setea plan y funded al mismo valor
    const n = Number(value || 0);
    const ref = doc(db, 'households', householdId);
    const snap = await getDoc(ref);
    const b = snap.data().budgets || {};
    const prev = normalizeBudgetEntry(b[cat]);
    const next = { ...b, [cat]: { ...prev, plan: n, funded: n } };
    await updateDoc(ref, { budgets: next });
  }

  async function setBudgetPlan(cat, value) {
    const n = Number(value || 0);
    const ref = doc(db, 'households', householdId);
    const snap = await getDoc(ref);
    const b = snap.data().budgets || {};
    const prev = normalizeBudgetEntry(b[cat]);
    const next = { ...b, [cat]: { ...prev, plan: n } };
    await updateDoc(ref, { budgets: next });
  }

  async function setBudgetFunded(monthKeyStr, cat, value) {
    const n = Number(value || 0);
    const ref = doc(db, 'households', householdId);
    const snap = await getDoc(ref);
    const data = snap.data() || {};

    // Usamos el campo "budgets" como mapa de meses
    const allBudgets = data.budgets || {};

    const mk = monthKeyStr || monthKey(); // por si llega vacío
    const monthBudgets = allBudgets[mk] || {};

    const prev = normalizeBudgetEntry(monthBudgets[cat]);
    const nextMonthBudgets = {
      ...monthBudgets,
      [cat]: { ...prev, funded: n },
    };

    const nextAllBudgets = {
      ...allBudgets,
      [mk]: nextMonthBudgets,
    };

    await updateDoc(ref, { budgets: nextAllBudgets });
  }

  async function addTransaction(tx) {
    try {
      await addDoc(
        collection(db, 'households', householdId, 'transactions'),
        tx,
      );
    } catch (e) {
      console.error('Error al guardar transacción:', e);
      alert('No se pudo guardar el movimiento. Revisa la consola.');
    }
  }

  async function removeTransaction(id) {
    await deleteDoc(doc(db, 'households', householdId, 'transactions', id));
  }

  async function addDebt(d) {
    await addDoc(collection(db, 'households', householdId, 'debts'), d);
  }

  async function updateDebt(id, patch) {
    await updateDoc(doc(db, 'households', householdId, 'debts', id), patch);
  }

  async function removeDebt(id) {
    await deleteDoc(doc(db, 'households', householdId, 'debts', id));
  }

  async function addSaving(s) {
    await addDoc(collection(db, 'households', householdId, 'savings'), s);
  }

  async function updateSaving(id, patch) {
    await updateDoc(doc(db, 'households', householdId, 'savings', id), patch);
  }

  async function removeSaving(id) {
    await deleteDoc(doc(db, 'households', householdId, 'savings', id));
  }

  async function addCategory(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return;

    // "Deudas" es una categoría fija, no se agrega manualmente
    if (trimmed === DEBT_CATEGORY) return;

    const ref = doc(db, 'households', householdId);
    const snap = await getDoc(ref);
    const data = snap.data() || {};

    const currentCats = Array.isArray(data.categories)
      ? data.categories
      : [...CATEGORIES];

    if (currentCats.includes(trimmed)) return;

    const newCats = [...currentCats, trimmed];
    const currentBudgets = data.budgets || {};
    const newBudgets = {
      ...currentBudgets,
      [trimmed]: { plan: 0, funded: 0 },
    };

    await updateDoc(ref, {
      categories: newCats,
      budgets: newBudgets,
    });
  }

  async function removeCategory(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return;

    const ref = doc(db, 'households', householdId);
    const snap = await getDoc(ref);
    const data = snap.data() || {};

    const currentCats = Array.isArray(data.categories)
      ? data.categories
      : [...CATEGORIES];

    const newCats = currentCats.filter((c) => c !== trimmed);
    const currentBudgets = data.budgets || {};
    const newBudgets = { ...currentBudgets };
    delete newBudgets[trimmed];

    await updateDoc(ref, {
      categories: newCats,
      budgets: newBudgets,
    });
  }

  async function renameCategory(oldName, newName) {
    const from = String(oldName || '').trim();
    const to = String(newName || '').trim();
    if (!from || !to || from === to) return;

    const hhRef = doc(db, 'households', householdId);
    const snap = await getDoc(hhRef);
    const data = snap.data() || {};

    const currentCats = Array.isArray(data.categories)
      ? data.categories
      : [...CATEGORIES];

    if (!currentCats.includes(from)) return;
    if (currentCats.includes(to)) return;

    const newCats = currentCats.map((c) => (c === from ? to : c));

    const currentBudgets = data.budgets || {};
    const newBudgets = { ...currentBudgets };
    const prev = normalizeBudgetEntry(currentBudgets[from]);
    newBudgets[to] = prev;
    delete newBudgets[from];

    await updateDoc(hhRef, {
      categories: newCats,
      budgets: newBudgets,
    });

    const txCol = collection(db, 'households', householdId, 'transactions');
    const q = query(txCol, where('category', '==', from));
    const txSnap = await getDocs(q);

    const updates = txSnap.docs.map((d) =>
      updateDoc(doc(db, 'households', householdId, 'transactions', d.id), {
        category: to,
      }),
    );
    await Promise.all(updates);
  }

  async function saveHouseholdUsers(nextUsers) {
    if (!householdId) return;
    const ref = doc(db, 'households', householdId);
    await updateDoc(ref, { householdUsers: nextUsers });
  }

  async function addHouseholdUser(user) {
    const base = Array.isArray(householdUsers) ? householdUsers : [];
    const newUser = {
      id: user.id || Math.random().toString(36).slice(2, 10),
      name: user.name || 'Usuario',
      pin: user.pin || '',
      isSuperAdmin: !!user.isSuperAdmin,
      preferences: user.preferences || {
        defaultTab: 'dashboard',
        showOnlyMyMovements: false,
        dashboardCards: {
          resumenMes: true,
          deudas: true,
          ahorro: true,
          presupuestos: true,
        },
        transactionsDefaults: {
          type: 'gasto',
          defaultCategory: categories[0] || CATEGORIES[0],
        },
        ui: {
          theme: 'light',
          density: 'normal',
        },
      },
    };
    const next = [...base, newUser];
    setHouseholdUsers(next);
    await saveHouseholdUsers(next);
  }

  async function updateHouseholdUser(id, patch) {
    const base = Array.isArray(householdUsers) ? householdUsers : [];
    const next = base.map((u) => (u.id === id ? { ...u, ...patch } : u));
    setHouseholdUsers(next);
    await saveHouseholdUsers(next);
  }

  async function removeHouseholdUser(id) {
    const base = Array.isArray(householdUsers) ? householdUsers : [];
    const target = base.find((u) => u.id === id);
    if (target?.isSuperAdmin) return;

    const next = base.filter((u) => u.id !== id);
    setHouseholdUsers(next);
    await saveHouseholdUsers(next);
  }

  async function setBudgetCutDay(day) {
    const n = Math.max(1, Math.min(28, Number(day) || 1));
    const ref = doc(db, 'households', householdId);
    await updateDoc(ref, { budgetCutDay: n });
    setBudgetCutDayState(n);
  }

  return {
    categories,
    budgets,
    transactions,
    debts,
    savings,
    householdUsers,
    superAdminEmail,
    budgetCutDay,
    setBudget,
    setBudgetPlan,
    setBudgetFunded,
    addTransaction,
    removeTransaction,
    addDebt,
    updateDebt,
    removeDebt,
    addSaving,
    updateSaving,
    removeSaving,
    addCategory,
    removeCategory,
    renameCategory,
    addHouseholdUser,
    updateHouseholdUser,
    removeHouseholdUser,
    setBudgetCutDay,
  };
}
