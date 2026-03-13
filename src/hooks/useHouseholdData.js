import { useState, useEffect, useRef } from 'react';
import {
  doc,
  setDoc,
  getDoc,
  onSnapshot,
  updateDoc,
  runTransaction,
  writeBatch,
  deleteField,
  collection,
  addDoc,
  deleteDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  serverTimestamp,
  documentId,
} from 'firebase/firestore';
import { db } from '../firebase';
import { DEBT_CATEGORY, CATEGORIES } from '../constants.js';
import { monthKey, shiftMonth } from '../utils/budgetPeriod';
import { filterTransactionsByPeriodAndUser } from '../utils/transactions.js';
import { getSubcategoryAllocationsForTransaction } from '../utils/subcategoryAllocations.js';

const SAVINGS_CATEGORY = 'Ahorro';
const DEFAULT_UNBUDGETED_LABEL = 'gasto no presupuestado';
const DEFAULT_UNBUDGETED_KEY = DEFAULT_UNBUDGETED_LABEL.toLowerCase();
const DEFAULT_USER_NAME = 'Usuario';
const META_COLLECTION = 'meta';
const META_DOC_ID = 'config';
const BUDGETS_COLLECTION = 'budgets';
const MIGRATION_FLAGS = {
  budgets: 'budgetsToSubcollection',
  config: 'configToSubcollection',
};
const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;
const TX_PAGE_SIZE = 100;
const TRASH_PAGE_SIZE = 100;
const DEBTS_PAGE_SIZE = 200;
const SAVINGS_PAGE_SIZE = 200;
const PREFETCH_IDLE_MS = 300;

function buildUserPreferences(basePrefs, cats) {
  const base = basePrefs && typeof basePrefs === 'object' ? basePrefs : {};
  const fallbackCat = cats[0] || CATEGORIES[0];
  return {
    defaultTab: base.defaultTab || 'dashboard',
    showOnlyMyMovements: !!base.showOnlyMyMovements,
    dashboardCards: {
      resumenMes: base.dashboardCards?.resumenMes ?? true,
      deudas: base.dashboardCards?.deudas ?? true,
      ahorro: base.dashboardCards?.ahorro ?? true,
      presupuestos: base.dashboardCards?.presupuestos ?? true,
    },
    transactionsDefaults: {
      type: base.transactionsDefaults?.type || 'gasto',
      defaultCategory: base.transactionsDefaults?.defaultCategory || fallbackCat,
    },
    ui: {
      theme: base.ui?.theme || 'light',
      density: base.ui?.density || 'normal',
    },
  };
}

function normalizeUserRecord(user, cats) {
  const base = user && typeof user === 'object' ? user : {};
  const rawId = String(base.id || '').trim();
  const id = rawId || Math.random().toString(36).slice(2, 10);
  const name = String(base.name || '').trim();
  const email = String(base.email || '').trim();
  const authUid = String(base.authUid || '').trim();
  const nameHistory = Array.isArray(base.nameHistory)
    ? base.nameHistory
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    : [];
  const preferences = buildUserPreferences(base.preferences, cats);
  const normalized = { id, name, preferences };
  if (email) normalized.email = email;
  if (authUid) normalized.authUid = authUid;
  if (nameHistory.length) normalized.nameHistory = nameHistory;
  if (typeof base.tempAccessActive === 'boolean')
    normalized.tempAccessActive = base.tempAccessActive;
  if (typeof base.tempAccessCreatedAtMs === 'number')
    normalized.tempAccessCreatedAtMs = base.tempAccessCreatedAtMs;
  if (typeof base.tempAccessUsedAtMs === 'number')
    normalized.tempAccessUsedAtMs = base.tempAccessUsedAtMs;

  const needsCleanup =
    !rawId ||
    !base.preferences ||
    typeof base.preferences !== 'object' ||
    !!base.pin ||
    !!base.isSuperAdmin;

  return { normalized, needsCleanup };
}

function parseSubcategoryNames(meta) {
  const list = [];
  const raw = String(meta?.budgetSubcategoryNames || '').trim();
  if (raw) {
    raw.split(';').forEach((name) => {
      const trimmed = String(name || '').trim();
      if (trimmed) list.push(trimmed);
    });
  }
  const single = String(meta?.budgetSubcategoryName || '').trim();
  if (single) list.push(single);
  return Array.from(new Set(list));
}

function getSpentBySubcategory({
  transactions,
  monthKeyStr,
  cutDay,
  category,
  breakdown,
}) {
  const periodTx = filterTransactionsByPeriodAndUser(
    transactions,
    monthKeyStr,
    cutDay,
    null,
    false,
  );
  const spentById = new Map();
  const spentByName = new Map();
  let unassigned = 0;

  periodTx.forEach((t) => {
    if (t?.type !== 'gasto') return;
    if (t?.category !== category) return;
    const amt = Number(t.amount || 0);
    if (!amt || Number.isNaN(amt)) return;
    const meta = t?.meta || {};
    const ids = Array.isArray(meta.budgetSubcategoryIds)
      ? meta.budgetSubcategoryIds
      : meta.budgetSubcategoryId
      ? [meta.budgetSubcategoryId]
      : [];
    const uniqueIds = Array.from(
      new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)),
    );
    if (uniqueIds.length) {
      const allocations = getSubcategoryAllocationsForTransaction({
        transaction: t,
        breakdown,
      });
      if (allocations.length) {
        allocations.forEach(({ id, amount }) => {
          const safe = Number(amount || 0);
          if (!id || Number.isNaN(safe)) return;
          spentById.set(id, (spentById.get(id) || 0) + safe);
        });
        return;
      }
      uniqueIds.forEach((id) => {
        spentById.set(id, (spentById.get(id) || 0) + amt);
      });
      return;
    }
    const names = parseSubcategoryNames(meta);
    if (names.length) {
      names.forEach((name) => {
        const key = String(name || '').trim().toLowerCase();
        if (!key) return;
        spentByName.set(key, (spentByName.get(key) || 0) + amt);
      });
      return;
    }
    unassigned += amt;
  });

  return { spentById, spentByName, unassigned };
}

function buildSpentBreakdown({
  transactions,
  monthKeyStr,
  cutDay,
  category,
  breakdown,
  isFixedCategory = false,
}) {
  const list = Array.isArray(breakdown) ? breakdown : [];
  if (!list.length) return { breakdown: [], total: 0 };

  const { spentById, spentByName, unassigned } = getSpentBySubcategory({
    transactions,
    monthKeyStr,
    cutDay,
    category,
    breakdown,
  });

  const nextBreakdown = list.map((item, idx) => {
    const name = String(item?.name || '').trim();
    const id = String(item?.id || name || `${category}-${idx}`);
    const byId = spentById.get(id);
    const byName = name ? spentByName.get(name.toLowerCase()) : undefined;
    const isFixed = !!item?.isFixed;
    const baseAmount = Number(item?.amount || 0);
    const amount = isFixedCategory
      ? baseAmount
      : Math.round(Number(byId ?? byName ?? 0));
    return { id, name, amount, isFixed };
  });

  if (unassigned > 0) {
    const matchIndex = nextBreakdown.findIndex(
      (item) =>
        String(item?.name || '')
          .trim()
          .toLowerCase() === DEFAULT_UNBUDGETED_KEY,
    );
    if (matchIndex >= 0) {
      const current = nextBreakdown[matchIndex];
      nextBreakdown[matchIndex] = {
        ...current,
        amount: Math.round(Number(current.amount || 0) + unassigned),
      };
    } else {
      nextBreakdown.push({
        id: `${category}-unbudgeted`,
        name: DEFAULT_UNBUDGETED_LABEL,
        amount: Math.round(unassigned),
        isFixed: false,
      });
    }
  }

  const total = nextBreakdown.reduce(
    (sum, item) => sum + Number(item.amount || 0),
    0,
  );
  return { breakdown: nextBreakdown, total };
}

export default function useHouseholdData(householdId, authUser, options = {}) {
  const selectedMonthKey =
    typeof options === 'object' && options ? options.selectedMonthKey : null;
  const activeMonthKey = selectedMonthKey || monthKey();
  const [categories, setCategories] = useState(CATEGORIES);
  const [budgets, setBudgets] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [debts, setDebts] = useState([]);
  const [savings, setSavings] = useState([]);
  const [trash, setTrash] = useState([]);
  const [fixedCategories, setFixedCategories] = useState({});
  const [householdUsers, setHouseholdUsers] = useState([]);
  const [memberInfo, setMemberInfo] = useState({});
  const [ownerUid, setOwnerUid] = useState(null);
  const [budgetCutDay, setBudgetCutDayState] = useState(1);
  const budgetsRef = useRef({});
  const txStateRef = useRef({
    map: new Map(),
    lastDoc: null,
    hasMore: true,
    loading: false,
    prefetching: false,
    pagesLoaded: 0,
  });
  const debtsStateRef = useRef({
    map: new Map(),
    lastDoc: null,
    hasMore: true,
    loading: false,
    prefetching: false,
    pagesLoaded: 0,
  });
  const savingsStateRef = useRef({
    map: new Map(),
    lastDoc: null,
    hasMore: true,
    loading: false,
    prefetching: false,
    pagesLoaded: 0,
  });
  const trashStateRef = useRef({
    map: new Map(),
    lastDoc: null,
    hasMore: true,
    loading: false,
    prefetching: false,
    pagesLoaded: 0,
  });
  const migrationRef = useRef({ budgets: false, config: false });
  const txPrefetchRef = useRef(null);
  const debtsPrefetchRef = useRef(null);
  const savingsPrefetchRef = useRef(null);
  const trashPrefetchRef = useRef(null);
  const budgetsLoadedRef = useRef(false);

  const updatedBy = String(authUser?.uid || authUser?.email || '').trim() || null;

  const buildUpdateMeta = () => ({
    updatedAt: serverTimestamp(),
    ...(updatedBy ? { updatedBy } : {}),
  });

  const normalizeCategoriesList = (rawCats) => {
    const baseCats = Array.isArray(rawCats) ? rawCats : [...CATEGORIES];
    const cleanedCats = baseCats.filter((c) => c && c !== 'Ahorro 2');
    const normalizedCats = cleanedCats.includes(SAVINGS_CATEGORY)
      ? cleanedCats
      : [...cleanedCats, SAVINGS_CATEGORY];
    const restCats = normalizedCats.filter(
      (c) => c !== DEBT_CATEGORY && c !== SAVINGS_CATEGORY,
    );
    return [SAVINGS_CATEGORY, DEBT_CATEGORY, ...restCats];
  };

  const syncBudgetsState = (next) => {
    budgetsRef.current = next;
    setBudgets(next);
  };

  const resetPagedState = (state, setList) => {
    state.map.clear();
    state.lastDoc = null;
    state.hasMore = true;
    state.loading = false;
    state.prefetching = false;
    state.pagesLoaded = 0;
    setList([]);
  };

  const scheduleIdle = (cb) => {
    if (
      typeof window !== 'undefined' &&
      typeof window.requestIdleCallback === 'function'
    ) {
      return window.requestIdleCallback(cb, { timeout: 1000 });
    }
    return setTimeout(cb, PREFETCH_IDLE_MS);
  };

  const cancelIdle = (handle) => {
    if (!handle) return;
    if (
      typeof window !== 'undefined' &&
      typeof window.cancelIdleCallback === 'function'
    ) {
      window.cancelIdleCallback(handle);
    } else {
      clearTimeout(handle);
    }
  };

  const applyDocsToState = (state, docs, setList) => {
    docs.forEach((docSnap) => {
      state.map.set(docSnap.id, { ...docSnap.data(), id: docSnap.id });
    });
    setList(Array.from(state.map.values()));
  };

  const refreshBudgets = async () => {
    if (!householdId) return;
    try {
      const snap = await getDocs(
        collection(db, 'households', householdId, BUDGETS_COLLECTION),
      );
      const next = {};
      snap.forEach((docSnap) => {
        const data = docSnap.data() || {};
        const mk = data.monthKey || docSnap.id;
        const items =
          data.items && typeof data.items === 'object' ? data.items : {};
        if (mk) next[mk] = items;
      });
      syncBudgetsState(next);
      budgetsLoadedRef.current = true;
    } catch (err) {
      console.error('Error cargando presupuestos:', err);
    }
  };

  const ensureMetaConfig = async (hhRef, data) => {
    if (!householdId || !data) return;
    if (data.migrations?.[MIGRATION_FLAGS.config]) return;
    if (migrationRef.current.config) return;
    migrationRef.current.config = true;
    try {
      const configRef = doc(
        db,
        'households',
        householdId,
        META_COLLECTION,
        META_DOC_ID,
      );
      const configSnap = await getDoc(configRef);
      if (!configSnap.exists()) {
        const fallbackCats = normalizeCategoriesList(data.categories);
        const fixed = data.fixedCategories || {};
        await setDoc(configRef, {
          categories: fallbackCats,
          fixedCategories: fixed,
          ...buildUpdateMeta(),
        });
      }
      await updateDoc(hhRef, {
        [`migrations.${MIGRATION_FLAGS.config}`]: true,
        categories: deleteField(),
        fixedCategories: deleteField(),
      });
    } catch (err) {
      console.error('Error migrando categorias:', err);
    } finally {
      migrationRef.current.config = false;
    }
  };

  const ensureBudgetsSubcollection = async (hhRef, data) => {
    if (!householdId || !data) return;
    if (data.migrations?.[MIGRATION_FLAGS.budgets]) return;
    if (migrationRef.current.budgets) return;
    migrationRef.current.budgets = true;
    try {
      const rawBudgets = data.budgets || {};
      const monthKeys = Object.keys(rawBudgets).filter((key) =>
        MONTH_KEY_PATTERN.test(key),
      );
      const nextBudgets = {};
      if (monthKeys.length) {
        monthKeys.forEach((mk) => {
          const items = rawBudgets[mk];
          if (items && typeof items === 'object') nextBudgets[mk] = items;
        });
        const legacyKeys = Object.keys(rawBudgets).filter(
          (key) => !MONTH_KEY_PATTERN.test(key),
        );
        if (legacyKeys.length) {
          const legacyItems = {};
          legacyKeys.forEach((key) => {
            legacyItems[key] = rawBudgets[key];
          });
          const targetMk = monthKey();
          nextBudgets[targetMk] = {
            ...(nextBudgets[targetMk] || {}),
            ...legacyItems,
          };
        }
      } else if (Object.keys(rawBudgets).length) {
        nextBudgets[monthKey()] = rawBudgets;
      }

      if (Object.keys(nextBudgets).length) {
        const batch = writeBatch(db);
        Object.entries(nextBudgets).forEach(([mk, items]) => {
          const ref = doc(
            db,
            'households',
            householdId,
            BUDGETS_COLLECTION,
            mk,
          );
          batch.set(
            ref,
            { monthKey: mk, items: items || {}, ...buildUpdateMeta() },
            { merge: true },
          );
        });
        await batch.commit();
      }

      await updateDoc(hhRef, {
        [`migrations.${MIGRATION_FLAGS.budgets}`]: true,
        budgets: deleteField(),
      });
      await refreshBudgets();
    } catch (err) {
      console.error('Error migrando presupuestos:', err);
    } finally {
      migrationRef.current.budgets = false;
    }
  };

  const loadMoreTransactions = async () => {
    if (!householdId) return;
    const state = txStateRef.current;
    if (state.loading || !state.hasMore) return;
    if (!state.lastDoc) return;
    state.loading = true;
    try {
      const txCol = collection(db, 'households', householdId, 'transactions');
      const q = query(
        txCol,
        orderBy('date', 'desc'),
        startAfter(state.lastDoc),
        limit(TX_PAGE_SIZE),
      );
      const snap = await getDocs(q);
      if (snap.empty) {
        state.hasMore = false;
        return;
      }
      applyDocsToState(state, snap.docs, setTransactions);
      state.lastDoc = snap.docs[snap.docs.length - 1] || state.lastDoc;
      state.pagesLoaded += 1;
      state.hasMore = snap.size === TX_PAGE_SIZE;
    } catch (err) {
      console.error('Error cargando mas movimientos:', err);
    } finally {
      state.loading = false;
    }
  };

  const scheduleTransactionsPrefetch = () => {
    const state = txStateRef.current;
    if (state.prefetching || !state.hasMore) return;
    if (!state.lastDoc) return;
    state.prefetching = true;
    txPrefetchRef.current = scheduleIdle(async () => {
      state.prefetching = false;
      await loadMoreTransactions();
      if (state.hasMore) scheduleTransactionsPrefetch();
    });
  };

  const loadMoreDebts = async () => {
    if (!householdId) return;
    const state = debtsStateRef.current;
    if (state.loading || !state.hasMore) return;
    if (!state.lastDoc) return;
    state.loading = true;
    try {
      const col = collection(db, 'households', householdId, 'debts');
      const q = query(
        col,
        orderBy('createdAt', 'desc'),
        startAfter(state.lastDoc),
        limit(DEBTS_PAGE_SIZE),
      );
      const snap = await getDocs(q);
      if (snap.empty) {
        state.hasMore = false;
        return;
      }
      applyDocsToState(state, snap.docs, setDebts);
      state.lastDoc = snap.docs[snap.docs.length - 1] || state.lastDoc;
      state.pagesLoaded += 1;
      state.hasMore = snap.size === DEBTS_PAGE_SIZE;
    } catch (err) {
      console.error('Error cargando deudas:', err);
    } finally {
      state.loading = false;
    }
  };

  const scheduleDebtsPrefetch = () => {
    const state = debtsStateRef.current;
    if (state.prefetching || !state.hasMore) return;
    if (!state.lastDoc) return;
    state.prefetching = true;
    debtsPrefetchRef.current = scheduleIdle(async () => {
      state.prefetching = false;
      await loadMoreDebts();
      if (state.hasMore) scheduleDebtsPrefetch();
    });
  };

  const loadMoreSavings = async () => {
    if (!householdId) return;
    const state = savingsStateRef.current;
    if (state.loading || !state.hasMore) return;
    if (!state.lastDoc) return;
    state.loading = true;
    try {
      const col = collection(db, 'households', householdId, 'savings');
      const q = query(
        col,
        orderBy('createdAt', 'desc'),
        startAfter(state.lastDoc),
        limit(SAVINGS_PAGE_SIZE),
      );
      const snap = await getDocs(q);
      if (snap.empty) {
        state.hasMore = false;
        return;
      }
      applyDocsToState(state, snap.docs, setSavings);
      state.lastDoc = snap.docs[snap.docs.length - 1] || state.lastDoc;
      state.pagesLoaded += 1;
      state.hasMore = snap.size === SAVINGS_PAGE_SIZE;
    } catch (err) {
      console.error('Error cargando ahorros:', err);
    } finally {
      state.loading = false;
    }
  };

  const scheduleSavingsPrefetch = () => {
    const state = savingsStateRef.current;
    if (state.prefetching || !state.hasMore) return;
    if (!state.lastDoc) return;
    state.prefetching = true;
    savingsPrefetchRef.current = scheduleIdle(async () => {
      state.prefetching = false;
      await loadMoreSavings();
      if (state.hasMore) scheduleSavingsPrefetch();
    });
  };

  const loadMoreTrash = async () => {
    if (!householdId) return;
    const state = trashStateRef.current;
    if (state.loading || !state.hasMore) return;
    if (!state.lastDoc) return;
    state.loading = true;
    try {
      const col = collection(db, 'households', householdId, 'trash');
      const q = query(
        col,
        orderBy('deletedAt', 'desc'),
        startAfter(state.lastDoc),
        limit(TRASH_PAGE_SIZE),
      );
      const snap = await getDocs(q);
      if (snap.empty) {
        state.hasMore = false;
        return;
      }
      applyDocsToState(state, snap.docs, setTrash);
      state.lastDoc = snap.docs[snap.docs.length - 1] || state.lastDoc;
      state.pagesLoaded += 1;
      state.hasMore = snap.size === TRASH_PAGE_SIZE;
    } catch (err) {
      console.error('Error cargando papelera:', err);
    } finally {
      state.loading = false;
    }
  };

  const scheduleTrashPrefetch = () => {
    const state = trashStateRef.current;
    if (state.prefetching || !state.hasMore) return;
    if (!state.lastDoc) return;
    state.prefetching = true;
    trashPrefetchRef.current = scheduleIdle(async () => {
      state.prefetching = false;
      await loadMoreTrash();
      if (state.hasMore) scheduleTrashPrefetch();
    });
  };

  useEffect(() => {
    cancelIdle(txPrefetchRef.current);
    cancelIdle(debtsPrefetchRef.current);
    cancelIdle(savingsPrefetchRef.current);
    cancelIdle(trashPrefetchRef.current);

    resetPagedState(txStateRef.current, setTransactions);
    resetPagedState(debtsStateRef.current, setDebts);
    resetPagedState(savingsStateRef.current, setSavings);
    resetPagedState(trashStateRef.current, setTrash);

    budgetsRef.current = {};
    budgetsLoadedRef.current = false;
    if (!householdId) {
      setCategories(CATEGORIES);
      setBudgets(null);
      setFixedCategories({});
      setHouseholdUsers([]);
      setMemberInfo({});
      setOwnerUid(null);
      setBudgetCutDayState(1);
    }
  }, [householdId]);

  useEffect(() => {
    if (!householdId) return;

    const hhRef = doc(db, 'households', householdId);
    const unsubHH = onSnapshot(hhRef, (snap) => {
      const d = snap.data() || {};
      const cats =
        categories && categories.length
          ? categories
          : normalizeCategoriesList(d.categories);

      const rawUsers = Array.isArray(d.householdUsers) ? d.householdUsers : [];
      const memberInfo = d.memberInfo && typeof d.memberInfo === 'object'
        ? d.memberInfo
        : {};
      const memberInfoNext = { ...memberInfo };
      let memberInfoUpdated = false;
      const upsertMemberInfo = (uid, nameValue, emailValue) => {
        const safeUid = String(uid || '').trim();
        if (!safeUid) return;
        const prev = memberInfoNext[safeUid] || {};
        const nextName = String(nameValue || '').trim();
        const nextEmail = String(emailValue || '').trim();
        const merged = { ...prev };
        if (!prev.name && nextName) merged.name = nextName;
        if (!prev.email && nextEmail) merged.email = nextEmail;
        if (merged !== prev && (merged.name !== prev.name || merged.email !== prev.email)) {
          memberInfoNext[safeUid] = merged;
          memberInfoUpdated = true;
        }
      };
      const members = Array.isArray(d.members) ? d.members : [];
      const authUid = String(authUser?.uid || '').trim();
      const authEmail = String(authUser?.email || '').trim();
      const authDisplayName = String(authUser?.displayName || '').trim();
      const authLabel = authEmail || authDisplayName || DEFAULT_USER_NAME;

      let usersUpdated = false;
      let normalizedUsers = rawUsers.map((u) => {
        const { normalized, needsCleanup } = normalizeUserRecord(u, cats);
        if (needsCleanup) usersUpdated = true;
        return normalized;
      });

      const dedupedUsers = [];
      normalizedUsers.forEach((u) => {
        const authKey = String(u.authUid || '').trim();
        const emailKey = String(u.email || '').trim().toLowerCase();
        const idKey = String(u.id || '').trim();
        const idx = dedupedUsers.findIndex((existing) => {
          const existingAuth = String(existing.authUid || '').trim();
          const existingEmail = String(existing.email || '').trim().toLowerCase();
          const existingId = String(existing.id || '').trim();
          if (authKey && (existingAuth === authKey || existingId === authKey)) {
            return true;
          }
          if (emailKey && existingEmail === emailKey) return true;
          if (idKey && (existingId === idKey || existingAuth === idKey)) {
            return true;
          }
          return false;
        });
        if (idx < 0) {
          dedupedUsers.push(u);
          return;
        }
        const existing = dedupedUsers[idx];
        const mergedName =
          String(existing.name || '').trim() || String(u.name || '').trim();
        const mergedEmail =
          String(existing.email || '').trim() || String(u.email || '').trim();
        const mergedAuth = String(existing.authUid || '').trim() ||
          String(u.authUid || '').trim();
        const mergedId = mergedAuth || existing.id || u.id;
        const mergedPrefs = existing.preferences || u.preferences;
        const historyBase = []
          .concat(existing.nameHistory || [])
          .concat(u.nameHistory || [])
          .map((item) => String(item || '').trim())
          .filter(Boolean);
        const mergedHistory = Array.from(new Set(historyBase));
        const fallbackName = mergedHistory[mergedHistory.length - 1] || '';
        dedupedUsers[idx] = {
          ...existing,
          ...u,
          id: mergedId,
          ...(mergedAuth ? { authUid: mergedAuth } : {}),
          ...(mergedEmail ? { email: mergedEmail } : {}),
          name: mergedName || fallbackName || DEFAULT_USER_NAME,
          preferences: buildUserPreferences(mergedPrefs, cats),
          ...(mergedHistory.length ? { nameHistory: mergedHistory } : {}),
          tempAccessActive:
            existing.tempAccessActive === true || u.tempAccessActive === true,
          tempAccessCreatedAtMs: Math.max(
            Number(existing.tempAccessCreatedAtMs || 0),
            Number(u.tempAccessCreatedAtMs || 0),
          ) || undefined,
          tempAccessUsedAtMs: Math.max(
            Number(existing.tempAccessUsedAtMs || 0),
            Number(u.tempAccessUsedAtMs || 0),
          ) || undefined,
        };
      });

      if (dedupedUsers.length !== normalizedUsers.length) {
        usersUpdated = true;
        normalizedUsers = dedupedUsers;
      } else {
        normalizedUsers = dedupedUsers;
      }

      normalizedUsers = normalizedUsers.map((u) => {
        const authId = String(u.authUid || u.id || '').trim();
        if (!authId) return u;
        const info = memberInfoNext[authId] || {};
        const infoName = String(info.name || '').trim();
        const infoEmail = String(info.email || '').trim();
        const fallbackName = infoName || String(u.name || '').trim();
        const nextName = fallbackName || infoEmail || DEFAULT_USER_NAME;
        upsertMemberInfo(authId, nextName, u.email || infoEmail);
        if (nextName && nextName !== String(u.name || '').trim()) {
          usersUpdated = true;
          return { ...u, name: nextName };
        }
        return u;
      });

      members.forEach((uid) => {
        const memberUid = String(uid || '').trim();
        if (!memberUid) return;
        const exists = normalizedUsers.find(
          (u) => u.authUid === memberUid || u.id === memberUid,
        );
        if (exists) return;
        const info = memberInfoNext[memberUid] || {};
        const nameFromInfo = String(info.name || '').trim();
        const emailFromInfo = String(info.email || '').trim();
        const historyFromInfo = Array.isArray(info.nameHistory)
          ? info.nameHistory.map((item) => String(item || '').trim()).filter(Boolean)
          : [];
        const defaultName = nameFromInfo || emailFromInfo || DEFAULT_USER_NAME;
        if (memberUid) {
          upsertMemberInfo(memberUid, defaultName, emailFromInfo);
        }
        normalizedUsers.push({
          id: memberUid,
          authUid: memberUid,
          name: defaultName,
          ...(emailFromInfo ? { email: emailFromInfo } : {}),
          preferences: buildUserPreferences(null, cats),
          ...(historyFromInfo.length ? { nameHistory: historyFromInfo } : {}),
        });
        usersUpdated = true;
      });

      normalizedUsers = normalizedUsers.map((u) => {
        const authId = String(u.authUid || u.id || '').trim();
        if (!authId) return u;
        const info = memberInfoNext[authId] || {};
        const infoName = String(info.name || '').trim();
        const infoHistory = Array.isArray(info.nameHistory)
          ? info.nameHistory.map((item) => String(item || '').trim()).filter(Boolean)
          : [];
        if (!infoName && infoHistory.length === 0) return u;
        const historyMerged = Array.from(
          new Set(
            []
              .concat(u.nameHistory || [])
              .concat(infoHistory),
          ),
        );
        const nextName = String(u.name || '').trim() || infoName || historyMerged[historyMerged.length - 1] || '';
        return {
          ...u,
          ...(nextName ? { name: nextName } : {}),
          ...(historyMerged.length ? { nameHistory: historyMerged } : {}),
        };
      });

      if (authUid) {
        const authIndex = normalizedUsers.findIndex(
          (u) => u.authUid === authUid,
        );
        const idIndex =
          authIndex < 0
            ? normalizedUsers.findIndex((u) => u.id === authUid)
            : -1;

        if (authIndex >= 0) {
          const existing = normalizedUsers[authIndex];
          let updated = false;
          let next = existing;
          if (!existing.name) {
            next = { ...next, name: authLabel };
            updated = true;
          }
          if (authEmail && !existing.email) {
            next = { ...next, email: authEmail };
            updated = true;
          }
          if (updated) {
            normalizedUsers[authIndex] = next;
            usersUpdated = true;
          }
        } else if (idIndex >= 0) {
          const existing = normalizedUsers[idIndex];
          const next = {
            ...existing,
            authUid,
            ...(authEmail && !existing.email ? { email: authEmail } : {}),
            ...(existing.name ? {} : { name: authLabel }),
          };
          normalizedUsers[idIndex] = next;
          usersUpdated = true;
        } else {
          const legacyIndex = rawUsers.findIndex(
            (u) => u && (u.id === 'super-admin' || u.isSuperAdmin),
          );
          if (legacyIndex >= 0) {
            const legacyId = rawUsers[legacyIndex]?.id;
            const normalizedIndex = normalizedUsers.findIndex(
              (u) => u.id === legacyId,
            );
            if (normalizedIndex >= 0) {
              const existing = normalizedUsers[normalizedIndex];
              const next = {
                ...existing,
                authUid,
                ...(authEmail && !existing.email ? { email: authEmail } : {}),
                ...(existing.name ? {} : { name: authLabel }),
              };
              normalizedUsers[normalizedIndex] = next;
              usersUpdated = true;
            }
          } else {
            const newUser = {
              id: authUid,
              name: authLabel,
              authUid,
              preferences: buildUserPreferences(null, cats),
              ...(authEmail ? { email: authEmail } : {}),
            };
            normalizedUsers.push(newUser);
            usersUpdated = true;
          }
        }
      }

      const cleanupPayload = {};
      if (Object.prototype.hasOwnProperty.call(d, 'superAdminEmail')) {
        cleanupPayload.superAdminEmail = deleteField();
      }
      if (Object.prototype.hasOwnProperty.call(d, 'superAdminUid')) {
        cleanupPayload.superAdminUid = deleteField();
      }

      if (usersUpdated || Object.keys(cleanupPayload).length) {
        runTransaction(db, async (tx) => {
          tx.update(hhRef, {
            ...(usersUpdated ? { householdUsers: normalizedUsers } : {}),
            ...(memberInfoUpdated ? { memberInfo: memberInfoNext } : {}),
            ...cleanupPayload,
            ...buildUpdateMeta(),
          });
        }).catch((err) => console.error('Error limpiando usuarios:', err));
      } else if (memberInfoUpdated) {
        runTransaction(db, async (tx) => {
          tx.update(hhRef, {
            memberInfo: memberInfoNext,
            ...buildUpdateMeta(),
          });
        }).catch((err) => console.error('Error actualizando memberInfo:', err));
      }

      setHouseholdUsers(normalizedUsers);
      setMemberInfo(memberInfoUpdated ? memberInfoNext : memberInfo);
      setOwnerUid(d.ownerUid || null);
      setBudgetCutDayState(d.budgetCutDay || 1);

      ensureMetaConfig(hhRef, d);
      ensureBudgetsSubcollection(hhRef, d);
      if (
        !budgetsLoadedRef.current &&
        d.migrations?.[MIGRATION_FLAGS.budgets]
      ) {
        refreshBudgets();
      }
    });

    return () => {
      unsubHH();
    };
  }, [
    householdId,
    authUser?.uid,
    authUser?.email,
    authUser?.displayName,
    categories,
  ]);

  useEffect(() => {
    if (!householdId) return;
    const configRef = doc(
      db,
      'households',
      householdId,
      META_COLLECTION,
      META_DOC_ID,
    );
    const unsub = onSnapshot(configRef, (snap) => {
      if (!snap.exists()) return;
      const data = snap.data() || {};
      const cats = normalizeCategoriesList(data.categories);
      setCategories(cats);
      setFixedCategories(data.fixedCategories || {});
    });
    return () => {
      unsub();
    };
  }, [householdId]);

  useEffect(() => {
    if (!householdId || !activeMonthKey) return;
    const ref = doc(
      db,
      'households',
      householdId,
      BUDGETS_COLLECTION,
      activeMonthKey,
    );
    const unsub = onSnapshot(ref, (snap) => {
      const data = snap.exists() ? snap.data() || {} : {};
      const items =
        data.items && typeof data.items === 'object' ? data.items : {};
      const next = { ...budgetsRef.current, [activeMonthKey]: items };
      syncBudgetsState(next);
    });
    return () => {
      unsub();
    };
  }, [householdId, activeMonthKey]);

  useEffect(() => {
    if (!householdId) return;
    const state = txStateRef.current;
    const txCol = collection(db, 'households', householdId, 'transactions');
    const q = query(txCol, orderBy('date', 'desc'), limit(TX_PAGE_SIZE));
    const unsub = onSnapshot(q, (snap) => {
      if (!snap.empty) {
        applyDocsToState(state, snap.docs, setTransactions);
        if (state.pagesLoaded === 0) {
          state.lastDoc = snap.docs[snap.docs.length - 1] || null;
          state.hasMore = snap.size === TX_PAGE_SIZE;
        }
        if (state.hasMore) scheduleTransactionsPrefetch();
      } else {
        state.hasMore = false;
      }
    });
    return () => {
      unsub();
      cancelIdle(txPrefetchRef.current);
    };
  }, [householdId]);

  useEffect(() => {
    if (!householdId) return;
    const state = debtsStateRef.current;
    const col = collection(db, 'households', householdId, 'debts');
    const q = query(col, orderBy('createdAt', 'desc'), limit(DEBTS_PAGE_SIZE));
    const unsub = onSnapshot(q, (snap) => {
      if (!snap.empty) {
        applyDocsToState(state, snap.docs, setDebts);
        if (state.pagesLoaded === 0) {
          state.lastDoc = snap.docs[snap.docs.length - 1] || null;
          state.hasMore = snap.size === DEBTS_PAGE_SIZE;
        }
        if (state.hasMore) scheduleDebtsPrefetch();
      } else {
        state.hasMore = false;
      }
    });
    return () => {
      unsub();
      cancelIdle(debtsPrefetchRef.current);
    };
  }, [householdId]);

  useEffect(() => {
    if (!householdId) return;
    const state = savingsStateRef.current;
    const col = collection(db, 'households', householdId, 'savings');
    const q = query(
      col,
      orderBy('createdAt', 'desc'),
      limit(SAVINGS_PAGE_SIZE),
    );
    const unsub = onSnapshot(q, (snap) => {
      if (!snap.empty) {
        applyDocsToState(state, snap.docs, setSavings);
        if (state.pagesLoaded === 0) {
          state.lastDoc = snap.docs[snap.docs.length - 1] || null;
          state.hasMore = snap.size === SAVINGS_PAGE_SIZE;
        }
        if (state.hasMore) scheduleSavingsPrefetch();
      } else {
        state.hasMore = false;
      }
    });
    return () => {
      unsub();
      cancelIdle(savingsPrefetchRef.current);
    };
  }, [householdId]);

  useEffect(() => {
    if (!householdId) return;
    const state = trashStateRef.current;
    const col = collection(db, 'households', householdId, 'trash');
    const q = query(col, orderBy('deletedAt', 'desc'), limit(TRASH_PAGE_SIZE));
    const unsub = onSnapshot(q, (snap) => {
      if (!snap.empty) {
        applyDocsToState(state, snap.docs, setTrash);
        if (state.pagesLoaded === 0) {
          state.lastDoc = snap.docs[snap.docs.length - 1] || null;
          state.hasMore = snap.size === TRASH_PAGE_SIZE;
        }
        if (state.hasMore) scheduleTrashPrefetch();
      } else {
        state.hasMore = false;
      }
    });
    return () => {
      unsub();
      cancelIdle(trashPrefetchRef.current);
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
      const base = { plan, funded };
      if (Array.isArray(entry.breakdown)) base.breakdown = entry.breakdown;
      if (entry.isFixed !== undefined) base.isFixed = !!entry.isFixed;
      return base;
    }
    return { plan: 0, funded: 0 };
  }

  function stripIdValue(value) {
    if (!value || typeof value !== 'object') return {};
    const { id: _id, ...rest } = value;
    return rest;
  }

  async function addToTrash(type, itemId, itemData) {
    const safeType = String(type || '').trim();
    const safeId = String(itemId || '').trim();
    if (!householdId || !safeType || !safeId) return;
    const payload = {
      type: safeType,
      itemId: safeId,
      data: stripIdValue(itemData),
      deletedAt: Date.now(),
      ...(updatedBy ? { deletedBy: updatedBy } : {}),
    };
    await addDoc(collection(db, 'households', householdId, 'trash'), payload);
  }

  async function addTrashItem(type, itemId, data) {
    await addToTrash(type, itemId, data);
  }

  async function setBudget(cat, value) {
    // Compatibilidad: setea plan y funded al mismo valor
    const name = String(cat || '').trim();
    if (!householdId || !name) return;
    const n = Number(value || 0);
    const mk = activeMonthKey || monthKey();
    const ref = doc(db, 'households', householdId, BUDGETS_COLLECTION, mk);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists() ? snap.data() : {};
      const items = data.items || {};
      const prev = normalizeBudgetEntry(items[name]);
      const nextItems = {
        ...items,
        [name]: { ...prev, plan: n, funded: n },
      };
      tx.set(
        ref,
        { monthKey: mk, items: nextItems, ...buildUpdateMeta() },
        { merge: true },
      );
    });
    const base = budgetsRef.current[mk] || {};
    const prev = normalizeBudgetEntry(base[name]);
    const nextItems = { ...base, [name]: { ...prev, plan: n, funded: n } };
    syncBudgetsState({ ...budgetsRef.current, [mk]: nextItems });
  }

  async function setBudgetPlan(cat, value) {
    const name = String(cat || '').trim();
    if (!householdId || !name) return;
    const n = Number(value || 0);
    const mk = activeMonthKey || monthKey();
    const ref = doc(db, 'households', householdId, BUDGETS_COLLECTION, mk);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists() ? snap.data() : {};
      const items = data.items || {};
      const prev = normalizeBudgetEntry(items[name]);
      const nextItems = {
        ...items,
        [name]: { ...prev, plan: n },
      };
      tx.set(
        ref,
        { monthKey: mk, items: nextItems, ...buildUpdateMeta() },
        { merge: true },
      );
    });
    const base = budgetsRef.current[mk] || {};
    const prev = normalizeBudgetEntry(base[name]);
    const nextItems = { ...base, [name]: { ...prev, plan: n } };
    syncBudgetsState({ ...budgetsRef.current, [mk]: nextItems });
  }

  async function setBudgetFunded(monthKeyStr, cat, value) {
    const name = String(cat || '').trim();
    if (!householdId || !name) return;
    const isObj = value && typeof value === 'object';
    const breakdown = isObj && Array.isArray(value.breakdown)
      ? value.breakdown.map((item) => ({
          id: item.id || Math.random().toString(36).slice(2, 10),
          name: item.name || '',
          amount: Number(item.amount || 0),
          isFixed: !!item.isFixed,
        }))
      : undefined;
    const hasFundedValue = isObj
      ? value.funded !== undefined || value.amount !== undefined
      : value !== undefined;
    const n = hasFundedValue
      ? isObj
        ? Number(value.funded ?? value.amount ?? 0)
        : Number(value || 0)
      : undefined;
    const nextIsFixed =
      isObj && value.isFixed !== undefined ? !!value.isFixed : undefined;
    const mk = monthKeyStr || activeMonthKey || monthKey();
    const ref = doc(db, 'households', householdId, BUDGETS_COLLECTION, mk);
    const nextMkKey = shiftMonth(mk, 1);
    const nextRef = doc(
      db,
      'households',
      householdId,
      BUDGETS_COLLECTION,
      nextMkKey,
    );
    let nextItems = null;
    let nextMonthItems = null;

    await runTransaction(db, async (tx) => {
      const [snap, nextSnap] = await Promise.all([tx.get(ref), tx.get(nextRef)]);
      const data = snap.exists() ? snap.data() : {};
      const items = data.items || {};

      const prev = normalizeBudgetEntry(items[name]);
      const breakdownSource = breakdown || prev.breakdown;
      const nextEntry = { ...prev };
      if (n !== undefined) nextEntry.funded = n;
      if (breakdown) nextEntry.breakdown = breakdown;
      if (nextIsFixed !== undefined) nextEntry.isFixed = nextIsFixed;
      const fundedValue = n !== undefined ? n : prev.funded;
      nextItems = {
        ...items,
        [name]: nextEntry,
      };

      tx.set(
        ref,
        { monthKey: mk, items: nextItems, ...buildUpdateMeta() },
        { merge: true },
      );

      const shouldCopyBreakdown =
        Array.isArray(breakdownSource) &&
        breakdownSource.length > 0 &&
        name !== DEBT_CATEGORY &&
        name !== SAVINGS_CATEGORY;
      const fixedBySettings = Object.prototype.hasOwnProperty.call(
        fixedCategories || {},
        name,
      )
        ? !!fixedCategories[name]
        : undefined;
      const isFixedCategory = shouldCopyBreakdown
        ? nextEntry.isFixed !== undefined
          ? !!nextEntry.isFixed
          : fixedBySettings !== undefined
          ? fixedBySettings
          : breakdownSource.some((item) => item?.isFixed)
        : false;
      const spentClone = shouldCopyBreakdown
        ? buildSpentBreakdown({
            transactions,
            monthKeyStr: mk,
            cutDay: budgetCutDay || 1,
            category: name,
            breakdown: breakdownSource,
            isFixedCategory,
          })
        : null;

      const nextData = nextSnap.exists() ? nextSnap.data() : {};
      const nextExisting = nextData.items || {};

      if (!nextExisting[name]) {
        const nextPrev = normalizeBudgetEntry(nextExisting[name]);
        const nextTotal = spentClone ? spentClone.total : fundedValue;
        const nextBreakdown = spentClone ? spentClone.breakdown : breakdownSource;
        const cloneIsFixed = nextEntry.isFixed;
        const clone = {
          ...nextPrev,
          plan: nextPrev.plan || nextTotal,
          ...(nextTotal > 0 ? { funded: nextTotal } : {}),
          ...(Array.isArray(nextBreakdown) && nextBreakdown.length
            ? { breakdown: nextBreakdown }
            : {}),
          ...(cloneIsFixed !== undefined ? { isFixed: !!cloneIsFixed } : {}),
        };
        nextMonthItems = {
          ...nextExisting,
          [name]: clone,
        };
        tx.set(
          nextRef,
          { monthKey: nextMkKey, items: nextMonthItems, ...buildUpdateMeta() },
          { merge: true },
        );
      }
    });

    if (nextItems) {
      const nextState = { ...budgetsRef.current, [mk]: nextItems };
      if (nextMonthItems) {
        nextState[nextMkKey] = nextMonthItems;
      }
      syncBudgetsState(nextState);
    }
  }

  async function addTransaction(tx) {
    try {
      await addDoc(
        collection(db, 'households', householdId, 'transactions'),
        { ...tx, ...buildUpdateMeta() },
      );
    } catch (e) {
      console.error('Error al guardar transacción:', e);
      alert('No se pudo guardar el movimiento. Revisa la consola.');
    }
  }

  async function updateTransaction(id, patch) {
    const payload = { ...patch, ...buildUpdateMeta() };
    await updateDoc(
      doc(db, 'households', householdId, 'transactions', id),
      payload,
    );
    const state = txStateRef.current;
    if (state.map.has(id)) {
      const current = state.map.get(id) || {};
      state.map.set(id, { ...current, ...patch, id });
      setTransactions(Array.from(state.map.values()));
    }
  }

  async function removeTransaction(id) {
    const target = transactions.find((t) => t.id === id);
    if (target) {
      await addToTrash('transaction', id, target);
    }
    await deleteDoc(doc(db, 'households', householdId, 'transactions', id));
    const state = txStateRef.current;
    state.map.delete(id);
    setTransactions(Array.from(state.map.values()));
  }

  async function addDebt(d) {
    const payload = { ...d };
    if (payload.createdAt === undefined) payload.createdAt = Date.now();
    await addDoc(collection(db, 'households', householdId, 'debts'), {
      ...payload,
      ...buildUpdateMeta(),
    });
  }

  async function updateDebt(id, patch) {
    const payload = { ...patch, ...buildUpdateMeta() };
    await updateDoc(doc(db, 'households', householdId, 'debts', id), payload);
    const state = debtsStateRef.current;
    if (state.map.has(id)) {
      const current = state.map.get(id) || {};
      state.map.set(id, { ...current, ...patch, id });
      setDebts(Array.from(state.map.values()));
    }
  }

  async function removeDebt(id) {
    const target = debts.find((d) => d.id === id);
    if (target) {
      await addToTrash('debt', id, target);
    }
    await deleteDoc(doc(db, 'households', householdId, 'debts', id));
    const state = debtsStateRef.current;
    state.map.delete(id);
    setDebts(Array.from(state.map.values()));
  }

  async function addSaving(s) {
    const payload = { ...s };
    if (payload.createdAt === undefined) payload.createdAt = Date.now();
    await addDoc(collection(db, 'households', householdId, 'savings'), {
      ...payload,
      ...buildUpdateMeta(),
    });
  }

  async function updateSaving(id, patch) {
    const payload = { ...patch, ...buildUpdateMeta() };
    await updateDoc(doc(db, 'households', householdId, 'savings', id), payload);
    const state = savingsStateRef.current;
    if (state.map.has(id)) {
      const current = state.map.get(id) || {};
      state.map.set(id, { ...current, ...patch, id });
      setSavings(Array.from(state.map.values()));
    }
  }

  async function removeSaving(id) {
    const target = savings.find((s) => s.id === id);
    if (target) {
      await addToTrash('saving', id, target);
    }
    await deleteDoc(doc(db, 'households', householdId, 'savings', id));
    const state = savingsStateRef.current;
    state.map.delete(id);
    setSavings(Array.from(state.map.values()));
  }

  async function restoreTrashItem(item) {
    const type = String(item?.type || '').trim();
    if (!householdId || !type) return;
    if (type === 'budget-subcategory') {
      const payload =
        item?.data && typeof item.data === 'object' ? item.data : {};
      const monthKeyStr = String(payload?.monthKey || '').trim();
      const category = String(payload?.category || '').trim();
      const subItem = payload?.item || null;
      if (!monthKeyStr || !category || !subItem) return;

      let monthBudgets = budgetsRef.current[monthKeyStr] || {};
      if (!Object.keys(monthBudgets).length) {
        const ref = doc(
          db,
          'households',
          householdId,
          BUDGETS_COLLECTION,
          monthKeyStr,
        );
        const snap = await getDoc(ref);
        const data = snap.exists() ? snap.data() : {};
        monthBudgets = data.items || {};
      }
      const prev = normalizeBudgetEntry(monthBudgets[category]);
      const prevBreakdown = Array.isArray(prev.breakdown) ? prev.breakdown : [];
      const hasMatch = prevBreakdown.some((entry) => {
        if (subItem.id && entry.id) return entry.id === subItem.id;
        if (subItem.name && entry.name) {
          return String(entry.name).trim() === String(subItem.name).trim();
        }
        return false;
      });
      let nextBreakdown = prevBreakdown;
      if (!hasMatch) {
        const insertIndex = Number.isInteger(payload?.index) ? payload.index : -1;
        if (insertIndex >= 0 && insertIndex <= prevBreakdown.length) {
          nextBreakdown = [...prevBreakdown];
          nextBreakdown.splice(insertIndex, 0, subItem);
        } else {
          nextBreakdown = [...prevBreakdown, subItem];
        }
      }
      if (nextBreakdown !== prevBreakdown) {
        const total = nextBreakdown.reduce(
          (sum, entry) => sum + Number(entry.amount || 0),
          0,
        );
        await setBudgetFunded(monthKeyStr, category, {
          funded: total,
          breakdown: nextBreakdown,
        });
      }
      if (item?.id) {
        await deleteDoc(doc(db, 'households', householdId, 'trash', item.id));
        const state = trashStateRef.current;
        state.map.delete(item.id);
        setTrash(Array.from(state.map.values()));
      }
      return;
    }
    const itemId = String(item?.itemId || '').trim();
    if (!itemId) return;
    const collectionMap = {
      debt: 'debts',
      saving: 'savings',
      transaction: 'transactions',
    };
    const collectionName = collectionMap[type];
    if (!collectionName) return;
    const payload =
      item?.data && typeof item.data === 'object' ? item.data : {};
    await setDoc(
      doc(db, 'households', householdId, collectionName, itemId),
      { ...payload, ...buildUpdateMeta() },
      { merge: true },
    );
    if (item?.id) {
      await deleteDoc(doc(db, 'households', householdId, 'trash', item.id));
      const state = trashStateRef.current;
      state.map.delete(item.id);
      setTrash(Array.from(state.map.values()));
    }
  }

  async function purgeTrashItem(id) {
    const safeId = String(id || '').trim();
    if (!householdId || !safeId) return;
    await deleteDoc(doc(db, 'households', householdId, 'trash', safeId));
    const state = trashStateRef.current;
    state.map.delete(safeId);
    setTrash(Array.from(state.map.values()));
  }

  async function addCategory(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return;
    if (!householdId) return;

    // "Deudas" es una categoria fija, no se agrega manualmente
    if (trimmed === DEBT_CATEGORY) return;

    const configRef = doc(
      db,
      'households',
      householdId,
      META_COLLECTION,
      META_DOC_ID,
    );
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(configRef);
      const data = snap.exists() ? snap.data() : {};
      const currentCats = Array.isArray(data.categories)
        ? data.categories
        : categories && categories.length
        ? categories
        : normalizeCategoriesList(CATEGORIES);

      if (currentCats.includes(trimmed)) return;
      const newCats = [...currentCats, trimmed];
      const fixedMap = data.fixedCategories || {};
      tx.set(
        configRef,
        { categories: newCats, fixedCategories: fixedMap, ...buildUpdateMeta() },
        { merge: true },
      );
    });

    const mk = activeMonthKey || monthKey();
    const budgetRef = doc(
      db,
      'households',
      householdId,
      BUDGETS_COLLECTION,
      mk,
    );
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(budgetRef);
      const data = snap.exists() ? snap.data() : {};
      const items = data.items || {};
      if (Object.prototype.hasOwnProperty.call(items, trimmed)) return;
      const nextItems = { ...items, [trimmed]: { plan: 0, funded: 0 } };
      tx.set(
        budgetRef,
        { monthKey: mk, items: nextItems, ...buildUpdateMeta() },
        { merge: true },
      );
    });

    const base = budgetsRef.current[mk] || {};
    if (!Object.prototype.hasOwnProperty.call(base, trimmed)) {
      const nextItems = { ...base, [trimmed]: { plan: 0, funded: 0 } };
      syncBudgetsState({ ...budgetsRef.current, [mk]: nextItems });
    }
  }

  async function removeCategory(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return;
    if (!householdId) return;

    const configRef = doc(
      db,
      'households',
      householdId,
      META_COLLECTION,
      META_DOC_ID,
    );
    let nextFixed = null;
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(configRef);
      const data = snap.exists() ? snap.data() : {};
      const currentCats = Array.isArray(data.categories)
        ? data.categories
        : normalizeCategoriesList(CATEGORIES);

      if (!currentCats.includes(trimmed)) return;
      const newCats = currentCats.filter((c) => c !== trimmed);
      const currentFixed = data.fixedCategories || {};
      nextFixed = { ...currentFixed };
      delete nextFixed[trimmed];
      tx.set(
        configRef,
        { categories: newCats, fixedCategories: nextFixed, ...buildUpdateMeta() },
        { merge: true },
      );
    });
    if (nextFixed) setFixedCategories(nextFixed);

    const snap = await getDocs(
      collection(db, 'households', householdId, BUDGETS_COLLECTION),
    );
    const updates = [];
    snap.forEach((docSnap) => {
      const data = docSnap.data() || {};
      const items = data.items || {};
      if (!Object.prototype.hasOwnProperty.call(items, trimmed)) return;
      const nextItems = { ...items };
      delete nextItems[trimmed];
      updates.push({ ref: docSnap.ref, monthKey: docSnap.id, items: nextItems });
    });

    for (let i = 0; i < updates.length; i += 400) {
      const batch = writeBatch(db);
      updates.slice(i, i + 400).forEach((u) => {
        batch.set(
          u.ref,
          { monthKey: u.monthKey, items: u.items, ...buildUpdateMeta() },
          { merge: true },
        );
      });
      await batch.commit();
    }

    if (Object.keys(budgetsRef.current).length) {
      const nextBudgets = { ...budgetsRef.current };
      Object.keys(nextBudgets).forEach((mk) => {
        const items = nextBudgets[mk] || {};
        if (!Object.prototype.hasOwnProperty.call(items, trimmed)) return;
        const nextItems = { ...items };
        delete nextItems[trimmed];
        nextBudgets[mk] = nextItems;
      });
      syncBudgetsState(nextBudgets);
    }
  }

  async function renameCategory(oldName, newName) {
    const from = String(oldName || '').trim();
    const to = String(newName || '').trim();
    if (!from || !to || from === to) return;
    if (!householdId) return;

    const configRef = doc(
      db,
      'households',
      householdId,
      META_COLLECTION,
      META_DOC_ID,
    );
    let nextFixed = null;
    let renamed = false;
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(configRef);
      const data = snap.exists() ? snap.data() : {};
      const currentCats = Array.isArray(data.categories)
        ? data.categories
        : normalizeCategoriesList(CATEGORIES);

      if (!currentCats.includes(from)) return;
      if (currentCats.includes(to)) return;
      const newCats = currentCats.map((c) => (c === from ? to : c));
      const currentFixed = data.fixedCategories || {};
      nextFixed = { ...currentFixed };
      if (Object.prototype.hasOwnProperty.call(nextFixed, from)) {
        nextFixed[to] = nextFixed[from];
        delete nextFixed[from];
      }
      tx.set(
        configRef,
        { categories: newCats, fixedCategories: nextFixed, ...buildUpdateMeta() },
        { merge: true },
      );
      renamed = true;
    });
    if (!renamed) return;
    if (nextFixed) setFixedCategories(nextFixed);

    const mergeBudgetEntries = (preferred, fallback) => {
      const primary = normalizeBudgetEntry(preferred);
      const secondary = normalizeBudgetEntry(fallback);
      const next = { ...primary };
      if ((!next.plan || next.plan === 0) && secondary.plan) {
        next.plan = secondary.plan;
      }
      if ((!next.funded || next.funded === 0) && secondary.funded) {
        next.funded = secondary.funded;
      }
      if (
        (!Array.isArray(next.breakdown) || next.breakdown.length === 0) &&
        Array.isArray(secondary.breakdown) &&
        secondary.breakdown.length > 0
      ) {
        next.breakdown = secondary.breakdown;
      }
      if (next.isFixed === undefined && secondary.isFixed !== undefined) {
        next.isFixed = secondary.isFixed;
      }
      return next;
    };

    const snap = await getDocs(
      collection(db, 'households', householdId, BUDGETS_COLLECTION),
    );
    const updates = [];
    snap.forEach((docSnap) => {
      const data = docSnap.data() || {};
      const items = data.items || {};
      if (!Object.prototype.hasOwnProperty.call(items, from)) return;
      const nextItems = { ...items };
      if (Object.prototype.hasOwnProperty.call(nextItems, to)) {
        nextItems[to] = mergeBudgetEntries(nextItems[to], nextItems[from]);
      } else {
        nextItems[to] = nextItems[from];
      }
      delete nextItems[from];
      updates.push({ ref: docSnap.ref, monthKey: docSnap.id, items: nextItems });
    });

    for (let i = 0; i < updates.length; i += 400) {
      const batch = writeBatch(db);
      updates.slice(i, i + 400).forEach((u) => {
        batch.set(
          u.ref,
          { monthKey: u.monthKey, items: u.items, ...buildUpdateMeta() },
          { merge: true },
        );
      });
      await batch.commit();
    }

    if (Object.keys(budgetsRef.current).length) {
      const nextBudgets = { ...budgetsRef.current };
      Object.keys(nextBudgets).forEach((mk) => {
        const items = nextBudgets[mk] || {};
        if (!Object.prototype.hasOwnProperty.call(items, from)) return;
        const nextItems = { ...items };
        if (Object.prototype.hasOwnProperty.call(nextItems, to)) {
          nextItems[to] = mergeBudgetEntries(nextItems[to], nextItems[from]);
        } else {
          nextItems[to] = nextItems[from];
        }
        delete nextItems[from];
        nextBudgets[mk] = nextItems;
      });
      syncBudgetsState(nextBudgets);
    }

    const txCol = collection(db, 'households', householdId, 'transactions');
    let lastDoc = null;
    while (true) {
      const q = lastDoc
        ? query(
            txCol,
            where('category', '==', from),
            orderBy(documentId()),
            startAfter(lastDoc),
            limit(400),
          )
        : query(
            txCol,
            where('category', '==', from),
            orderBy(documentId()),
            limit(400),
          );
      const txSnap = await getDocs(q);
      if (txSnap.empty) break;
      const batch = writeBatch(db);
      txSnap.docs.forEach((docSnap) => {
        batch.update(docSnap.ref, { category: to, ...buildUpdateMeta() });
      });
      await batch.commit();
      lastDoc = txSnap.docs[txSnap.docs.length - 1];
      if (txSnap.size < 400) break;
    }

    const state = txStateRef.current;
    let updated = false;
    state.map.forEach((value, key) => {
      if (value?.category !== from) return;
      state.map.set(key, { ...value, category: to });
      updated = true;
    });
    if (updated) setTransactions(Array.from(state.map.values()));
  }

  async function moveCategoryInGroup(name, direction) {
    const cat = String(name || '').trim();
    if (!cat) return;
    if (!householdId) return;
    if (cat === DEBT_CATEGORY || cat === SAVINGS_CATEGORY) return;
    const dir = direction === 'down' ? 'down' : 'up';

    const ref = doc(
      db,
      'households',
      householdId,
      META_COLLECTION,
      META_DOC_ID,
    );
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists() ? snap.data() : {};
      const currentCats = Array.isArray(data.categories)
        ? data.categories
        : normalizeCategoriesList(CATEGORIES);
      const fixedMap = data.fixedCategories || {};
      const isFixed = !!fixedMap[cat];

      const groupCats = currentCats.filter(
        (c) =>
          c !== DEBT_CATEGORY &&
          c !== SAVINGS_CATEGORY &&
          !!fixedMap[c] === isFixed,
      );
      const index = groupCats.indexOf(cat);
      if (index < 0) return;
      const targetIndex = dir === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= groupCats.length) return;
      const target = groupCats[targetIndex];

      const nextCats = [...currentCats];
      const fromIdx = nextCats.indexOf(cat);
      const toIdx = nextCats.indexOf(target);
      if (fromIdx < 0 || toIdx < 0) return;
      nextCats[fromIdx] = target;
      nextCats[toIdx] = cat;

      tx.set(
        ref,
        { categories: nextCats, fixedCategories: fixedMap, ...buildUpdateMeta() },
        { merge: true },
      );
    });
  }

  async function setCategoryFixed(cat, isFixed) {
    const name = String(cat || '').trim();
    if (!name) return;
    if (!householdId) return;
    const ref = doc(
      db,
      'households',
      householdId,
      META_COLLECTION,
      META_DOC_ID,
    );
    let nextFixed = null;
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists() ? snap.data() : {};
      const current = data.fixedCategories || {};
      nextFixed = { ...current };
      if (isFixed) nextFixed[name] = true;
      else delete nextFixed[name];
      tx.set(
        ref,
        { fixedCategories: nextFixed, ...buildUpdateMeta() },
        { merge: true },
      );
    });
    if (nextFixed) setFixedCategories(nextFixed);
  }

  async function addHouseholdUser(user) {
    if (!householdId) return;
    const safeUser = user && typeof user === 'object' ? user : {};
    const trimmedName = String(safeUser.name || '').trim();
    const newUser = {
      id: safeUser.id || Math.random().toString(36).slice(2, 10),
      name: trimmedName || DEFAULT_USER_NAME,
      preferences: safeUser.preferences || buildUserPreferences(null, categories),
    };
    if (safeUser.email) newUser.email = safeUser.email;
    if (safeUser.authUid) newUser.authUid = safeUser.authUid;

    const ref = doc(db, 'households', householdId);
    let nextUsers = null;
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists() ? snap.data() : {};
      const base = Array.isArray(data.householdUsers) ? data.householdUsers : [];
      nextUsers = [...base, newUser];
      tx.update(ref, { householdUsers: nextUsers, ...buildUpdateMeta() });
    });
    if (nextUsers) setHouseholdUsers(nextUsers);
  }

  async function updateHouseholdUser(id, patch) {
    if (!householdId || !id) return;
    const ref = doc(db, 'households', householdId);
    let nextUsers = null;
    let targetAuthUid = null;
    let nextName = null;
    let shouldSyncName = false;
    const patchNameRaw =
      patch?.name !== undefined ? String(patch.name || '').trim() : '';
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists() ? snap.data() : {};
      const base = Array.isArray(data.householdUsers) ? data.householdUsers : [];
      const memberInfo = { ...(data.memberInfo || {}) };
      nextUsers = base.map((u) => {
        const isTarget = u.id === id || u.authUid === id;
        if (!isTarget) return u;
        const updated = { ...u, ...patch };
        targetAuthUid =
          String(updated.authUid || u.authUid || u.id || '').trim() || null;
        if (patch?.name !== undefined) {
          const trimmed = String(patch.name || '').trim();
          nextName = trimmed || DEFAULT_USER_NAME;
          shouldSyncName = nextName !== String(u.name || '').trim();
          updated.name = nextName;
          const historyBase = []
            .concat(u.nameHistory || [])
            .concat(nextName);
          const nextHistory = Array.from(
            new Set(
              historyBase.map((item) => String(item || '').trim()).filter(Boolean),
            ),
          );
          if (nextHistory.length) updated.nameHistory = nextHistory;
          if (targetAuthUid) {
            memberInfo[targetAuthUid] = {
              ...(memberInfo[targetAuthUid] || {}),
              name: nextName,
              ...(nextHistory.length ? { nameHistory: nextHistory } : {}),
            };
          }
        }
        if (patch?.nameHistory !== undefined) {
          const historyList = Array.isArray(patch.nameHistory)
            ? patch.nameHistory
            : [];
          const nextHistory = Array.from(
            new Set(
              historyList.map((item) => String(item || '').trim()).filter(Boolean),
            ),
          );
          updated.nameHistory = nextHistory;
          if (targetAuthUid) {
            memberInfo[targetAuthUid] = {
              ...(memberInfo[targetAuthUid] || {}),
              ...(nextHistory.length ? { nameHistory: nextHistory } : {}),
            };
          }
        }
        if (patch?.email !== undefined && targetAuthUid) {
          const trimmedEmail = String(patch.email || '').trim();
          memberInfo[targetAuthUid] = {
            ...(memberInfo[targetAuthUid] || {}),
            ...(trimmedEmail ? { email: trimmedEmail } : {}),
          };
        }
        return updated;
      });
      tx.update(ref, {
        householdUsers: nextUsers,
        ...(targetAuthUid ? { memberInfo } : {}),
        ...buildUpdateMeta(),
      });
    });
    if (nextUsers) setHouseholdUsers(nextUsers);
    if (shouldSyncName && nextName) {
      Promise.all([
        syncOwnerNameInTransactions(id, nextName),
        targetAuthUid
          ? setDoc(
              doc(db, 'profiles', targetAuthUid),
              { name: nextName },
              { merge: true },
            )
          : Promise.resolve(),
      ]).catch((err) => {
        console.error('Error sincronizando nombre de usuario:', err);
      });
    }
  }

  async function removeHouseholdUser(id) {
    if (!householdId || !id) return;
    const ref = doc(db, 'households', householdId);
    let nextUsers = null;
    let nextMembers = null;
    let nextMemberInfo = null;
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists() ? snap.data() : {};
      const base = Array.isArray(data.householdUsers) ? data.householdUsers : [];
      const target = base.find((u) => u.id === id);
      const targetAuthUid = String(target?.authUid || target?.id || id || '').trim();
      if (targetAuthUid && (!ownerUid || targetAuthUid === ownerUid)) return;
      nextUsers = base.filter((u) => u.id !== id);

      const members = Array.isArray(data.members) ? data.members : [];
      nextMembers = members.filter((uid) => String(uid || '').trim() !== targetAuthUid);

      const memberInfo = data.memberInfo && typeof data.memberInfo === 'object'
        ? { ...data.memberInfo }
        : {};
      if (targetAuthUid && memberInfo[targetAuthUid]) {
        delete memberInfo[targetAuthUid];
      }
      nextMemberInfo = memberInfo;

      tx.update(ref, {
        householdUsers: nextUsers,
        ...(nextMembers ? { members: nextMembers } : {}),
        ...(nextMemberInfo ? { memberInfo: nextMemberInfo } : {}),
        ...buildUpdateMeta(),
      });
    });
    if (nextUsers) setHouseholdUsers(nextUsers);
    if (nextMemberInfo) setMemberInfo(nextMemberInfo);
  }

  async function syncOwnerNameInTransactions(ownerId, ownerName) {
    const trimmedName = String(ownerName || '').trim();
    if (!householdId || !ownerId || !trimmedName) return;
    const txCol = collection(db, 'households', householdId, 'transactions');
    const snap = await getDocs(query(txCol, where('ownerId', '==', ownerId)));
    if (snap.empty) return;

    let batch = writeBatch(db);
    let count = 0;
    const commitBatch = async () => {
      await batch.commit();
      batch = writeBatch(db);
      count = 0;
    };

    // Use a loop to respect batch limits.
    for (const docSnap of snap.docs) {
      batch.update(docSnap.ref, {
        ownerName: trimmedName,
        ...buildUpdateMeta(),
      });
      count += 1;
      if (count >= 450) {
        // Firestore batch limit is 500 ops; keep some slack.
        // eslint-disable-next-line no-await-in-loop
        await commitBatch();
      }
    }

    if (count > 0) {
      await batch.commit();
    }

    const state = txStateRef.current;
    if (state.map.size) {
      const next = new Map(state.map);
      let touched = false;
      next.forEach((value, key) => {
        if (value?.ownerId === ownerId) {
          next.set(key, { ...value, ownerName: trimmedName });
          touched = true;
        }
      });
      if (touched) {
        state.map = next;
        setTransactions(Array.from(next.values()));
      }
    }
  }

  async function setBudgetCutDay(day) {
    const n = Math.max(1, Math.min(28, Number(day) || 1));
    const ref = doc(db, 'households', householdId);
    await runTransaction(db, async (tx) => {
      tx.update(ref, { budgetCutDay: n, ...buildUpdateMeta() });
    });
    setBudgetCutDayState(n);
  }

  return {
    categories,
    budgets,
    transactions,
    debts,
    savings,
    trash,
    fixedCategories,
    householdUsers,
    memberInfo,
    ownerUid,
    budgetCutDay,
    setBudget,
    setBudgetPlan,
    setBudgetFunded,
    addTransaction,
    updateTransaction,
    removeTransaction,
    addDebt,
    updateDebt,
    removeDebt,
    addSaving,
    updateSaving,
    removeSaving,
    addTrashItem,
    restoreTrashItem,
    purgeTrashItem,
    addCategory,
    removeCategory,
    renameCategory,
    setCategoryFixed,
    addHouseholdUser,
    updateHouseholdUser,
    removeHouseholdUser,
    setBudgetCutDay,
    moveCategoryInGroup,
  };
}



