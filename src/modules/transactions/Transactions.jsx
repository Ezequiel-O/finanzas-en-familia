// src/modules/transactions/Transactions.jsx
import { isAdjustment, periodBalances, periodLedger, txDateKey } from '../../domain/ledger.js';
import { extractDebtQuotaIds, plannedForSavingPeriod } from '../../domain/commitments.js';
import { toast, confirmDialog } from '../../components/feedback/feedback.js';
import { confirmWithinCash } from '../../features/cash/confirmWithinCash.js';
import { todayKey, toLocalDateKey } from '../../domain/dates.js';
import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  monthKey,
  shiftMonth,
  formatBudgetPeriodLabel,
  getBudgetPeriod,
  budgetMonthKeyForDate,
} from '../../utils/budgetPeriod.js';
import { filterTransactionsByPeriodAndUser } from '../../utils/transactions.js';
import {
  getFixedCarryoverForSubcategory,
  resolveFixedCategory,
} from '../../utils/fixedBudgets.js';
import { getSubcategoryAllocationsForTransaction } from '../../utils/subcategoryAllocations.js';
import { Card } from '../../components/ui/Card.jsx';
import { SectionTitle } from '../../components/ui/SectionTitle.jsx';
import { Money } from '../../components/ui/Money.jsx';
import { CATEGORIES, DEBT_CATEGORY, SAVINGS_CATEGORY } from '../../constants.js';
import { GmailImportModal } from '../../features/transactions/GmailImportModal.jsx';
import { subscribePendingBankInbox } from '../../lib/bankInbox.js';

// SheetJS (~400 KB) y fflate solo se descargan al exportar o importar Excel.
let XLSX = null;
let FFLATE = null;
async function loadExcelLibs() {
  if (!XLSX) XLSX = await import('xlsx');
  if (!FFLATE) FFLATE = await import('fflate');
}

const DEFAULT_UNBUDGETED_LABEL = 'gasto no presupuestado';
const DEFAULT_UNBUDGETED_KEY = DEFAULT_UNBUDGETED_LABEL.toLowerCase();
const UNBUDGETED_FILTER_VALUE = DEFAULT_UNBUDGETED_KEY;

export function Transactions({
  data,
  actions,
  activeUser,
  householdId,
  monthKeyStr,
  budgetCutDay,
}) {
  const {
    transactions = [],
    categories = [],
    debts = [],
    savings = [],
    budgets = {},
    budgetsAll = {},
    fixedCategories = {},
    householdUsers = [],
    accounts = [],
  } = data || {};

  const debtsArray = Array.isArray(debts) ? debts : [];
  // Cuenta sugerida: la del dueño del movimiento (p. ej. su banco).
  const defaultAccountFor = (userId) =>
    accounts.find((account) => account.ownerId && account.ownerId === userId)?.id || '';
  const accountName = (id) => accounts.find((account) => account.id === id)?.name || '';
  const txAccountLabel = (tx) =>
    tx?.meta?.fromAccount || tx?.meta?.toAccount
      ? `${accountName(tx.meta.fromAccount) || '?'} → ${accountName(tx.meta.toAccount) || '?'}`
      : accountName(tx?.account);
  const savingsArray = Array.isArray(savings) ? savings : [];

  const currentPeriodKey = useMemo(
    () => monthKeyStr || monthKey(new Date()),
    [monthKeyStr],
  );
  const { addTransaction, updateTransaction, removeTransaction, restoreTrashItem } =
    actions || {};
  const hasContextActions =
    !!updateTransaction || !!removeTransaction || !!addTransaction;

  const usersList = Array.isArray(householdUsers) ? householdUsers : [];
  const canImport = !!addTransaction && !!activeUser;
  const projectId = String(
    import.meta.env.VITE_FIREBASE_PROJECT_ID || '',
  ).trim();
  const incomeCategoryLabel = 'Ingresos';
  const incomeCategoryKey = incomeCategoryLabel.toLowerCase();

  const isDebtCategory = (cat) => cat === DEBT_CATEGORY || cat === 'Deuda';
  const isSavingsCategory = (cat) => cat === SAVINGS_CATEGORY;

  const [type, setType] = useState('gasto'); // gasto | ingreso
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState(categories[0] || '');
  const [date, setDate] = useState(() => todayKey());
  const [description, setDescription] = useState('');
  const [showOnlyMine] = useState(false);
  const [filterType, setFilterType] = useState('todos'); // todos | ingresos | gastos
  const [filterCategories, setFilterCategories] = useState([]);
  const [filterSubcategories, setFilterSubcategories] = useState([]);
  const [filterFromDate, setFilterFromDate] = useState('');
  const [filterToDate, setFilterToDate] = useState('');
  const [filterUserId, setFilterUserId] = useState('todos');
  const [showIngresoModal, setShowIngresoModal] = useState(false);
  const [showGastoModal, setShowGastoModal] = useState(false);
  const [amountFormatted, setAmountFormatted] = useState('');
  const [editingTx, setEditingTx] = useState(null);
  const [selectedDebtQuotaIds, setSelectedDebtQuotaIds] = useState([]);
  const [selectedSavingId, setSelectedSavingId] = useState('');
  const [selectedSubcategoryIds, setSelectedSubcategoryIds] = useState([]);
  const [amountEditedByUser, setAmountEditedByUser] = useState(false);
  const [ownerUserId, setOwnerUserId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [showExcelModal, setShowExcelModal] = useState(false);
  const [showGmailModal, setShowGmailModal] = useState(false);
  const [bankInboxItems, setBankInboxItems] = useState([]);
  const [infoTx, setInfoTx] = useState(null);
  const [showFiltersModal, setShowFiltersModal] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const fileInputRef = useRef(null);
  const [contextMenu, setContextMenu] = useState(null);

  // Avisos bancarios que llegaron solos y esperan que el usuario decida dónde cargarlos.
  useEffect(() => {
    if (!householdId) return undefined;
    const unsubscribe = subscribePendingBankInbox(
      householdId,
      setBankInboxItems,
      (inboxError) => {
        console.error('No se pudo leer la bandeja de avisos bancarios:', {
          code: inboxError?.code || 'unknown',
        });
        setBankInboxItems([]);
      },
    );
    return () => {
      unsubscribe();
      setBankInboxItems([]);
    };
  }, [householdId]);
  const [showDateRangePicker, setShowDateRangePicker] = useState(false);
  const [draftFromDate, setDraftFromDate] = useState('');
  const [draftToDate, setDraftToDate] = useState('');
  const [calendarBaseMonth, setCalendarBaseMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const dateRangeRef = useRef(null);
  const [showCategoryFilter, setShowCategoryFilter] = useState(false);
  const categoryFilterRef = useRef(null);
  const [showSubcategoryFilter, setShowSubcategoryFilter] = useState(false);
  const subcategoryFilterRef = useRef(null);

  // Calculadora de ajuste de balance
  const [showBalanceModal, setShowBalanceModal] = useState(false);
  const [cashInput, setCashInput] = useState('');
  const [cashFormatted, setCashFormatted] = useState('');
  const [debitInput, setDebitInput] = useState('');
  const [debitFormatted, setDebitFormatted] = useState('');
  const [adjustType, setAdjustType] = useState('ingreso'); // ingreso | gasto
  const [adjustPeriod, setAdjustPeriod] = useState('previous');
  const [adjustNote, setAdjustNote] = useState('');
  const [adjustError, setAdjustError] = useState('');

  const currencyFormatter = useMemo(
    () => new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }),
    [],
  );

  const formPeriodKey = useMemo(
    () => budgetMonthKeyForDate(date, budgetCutDay),
    [date, budgetCutDay],
  );

  const formPeriodLabel = useMemo(
    () => formatBudgetPeriodLabel(formPeriodKey, budgetCutDay),
    [formPeriodKey, budgetCutDay],
  );

  const periodKeyForBudget = formPeriodKey || currentPeriodKey;
  const budgetsForPeriod = useMemo(() => {
    if (periodKeyForBudget && budgetsAll?.[periodKeyForBudget]) {
      return budgetsAll[periodKeyForBudget];
    }
    return budgets;
  }, [budgetsAll, budgets, periodKeyForBudget]);

  const fixedCarryoverMap = useMemo(() => {
    const map = new Map();
    if (!periodKeyForBudget) return map;
    const budgetsSource = budgetsForPeriod || {};
    Object.entries(budgetsSource).forEach(([cat, entry]) => {
      const breakdown = Array.isArray(entry?.breakdown) ? entry.breakdown : [];
      const isFixedCategory = resolveFixedCategory({
        entry,
        breakdown,
        fixedCategories,
        category: cat,
      });
      if (!isFixedCategory || !breakdown.length) return;
      breakdown.forEach((item, idx) => {
        const id = item.id || item.name || `${cat}-${idx}`;
        const carryover = getFixedCarryoverForSubcategory({
          budgetsAll,
          transactions,
          cutDay: budgetCutDay,
          category: cat,
          fixedCategories,
          subId: item.id || id,
          subName: item.name || '',
          currentPeriodKey: periodKeyForBudget,
        });
        if (carryover > 0) {
          map.set(`${cat}::${id}`, carryover);
        }
      });
    });
    return map;
  }, [
    budgetsAll,
    budgetsForPeriod,
    transactions,
    budgetCutDay,
    periodKeyForBudget,
    fixedCategories,
  ]);

  const suggestedSavingsAmount = useMemo(() => {
    if (!formPeriodKey) return 0;
    return savingsArray.reduce((sum, s) => {
      const plan = plannedForSavingPeriod(s, formPeriodKey, budgetCutDay);
      return plan > 0 ? sum + plan : sum;
    }, 0);
  }, [savingsArray, formPeriodKey, budgetCutDay]);

  const categoryOptions = useMemo(() => {
    const baseCats =
      Array.isArray(categories) && categories.length ? categories : CATEGORIES;
    const unique = [];
    baseCats.forEach((cat) => {
      const name = String(cat || '').trim();
      if (!name || unique.includes(name)) return;
      unique.push(name);
    });
    if (!unique.includes(SAVINGS_CATEGORY)) {
      unique.push(SAVINGS_CATEGORY);
    }
    return unique;
  }, [categories]);

  const preferredDefaults = activeUser?.preferences?.transactionsDefaults || {};
  const preferredType =
    preferredDefaults.type === 'ingreso' ? 'ingreso' : 'gasto';
  const preferredCategory = useMemo(() => {
    const fallback = categoryOptions[0] || CATEGORIES[0] || '';
    const raw = String(preferredDefaults.defaultCategory || '').trim();
    if (raw && categoryOptions.includes(raw)) return raw;
    return fallback;
  }, [preferredDefaults.defaultCategory, categoryOptions]);

  const periodTx = useMemo(
    () =>
      filterTransactionsByPeriodAndUser(
        transactions,
        monthKeyStr,
        budgetCutDay,
        null,
        false,
      ),
    [transactions, monthKeyStr, budgetCutDay],
  );

  const subcategoryMap = useMemo(() => {
    const byCategory = new Map();
    const byId = new Map();
    const byCategoryName = new Map();

    Object.entries(budgets || {}).forEach(([cat, value]) => {
      const breakdown = Array.isArray(value?.breakdown) ? value.breakdown : [];
      const list = breakdown
        .map((item) => ({
          id: item?.id || item?.name || '',
          name: item?.name || '',
        }))
        .filter((item) => item.name);

      if (!list.length) return;
      byCategory.set(cat, list);
      const nameMap = new Map();
      list.forEach((item) => {
        if (item.id) byId.set(item.id, item.name);
        nameMap.set(String(item.name).toLowerCase(), item.id || item.name);
      });
      byCategoryName.set(cat, nameMap);
    });

    return { byCategory, byId, byCategoryName };
  }, [budgets]);

  const budgetSubcategories = useMemo(() => {
    if (!category) return [];
    const catBudget = budgetsForPeriod?.[category];
    const breakdown = Array.isArray(catBudget?.breakdown)
      ? catBudget.breakdown
      : [];
    const isFixedCategory = resolveFixedCategory({
      entry: catBudget,
      breakdown,
      fixedCategories,
      category,
    });
    return breakdown.map((item, idx) => {
      const id = item.id || item.name || `${category}-${idx}`;
      const baseAmount = Number(item.amount || 0);
      const carryover = isFixedCategory
        ? fixedCarryoverMap.get(`${category}::${id}`) || 0
        : 0;
      return {
        id,
        name: item.name || 'Subcategoria',
        amount: baseAmount + carryover,
        isFixed: isFixedCategory,
      };
    });
  }, [budgetsForPeriod, category, fixedCarryoverMap, fixedCategories]);

  const categoryBudgeted = useMemo(() => {
    if (!category) return 0;
    const catBudget = budgetsForPeriod?.[category];
    if (Array.isArray(catBudget?.breakdown) && catBudget.breakdown.length) {
      const isFixedCategory = resolveFixedCategory({
        entry: catBudget,
        breakdown: catBudget.breakdown,
        fixedCategories,
        category,
      });
      return catBudget.breakdown.reduce((sum, item, idx) => {
        const baseAmount = Number(item.amount || 0);
        if (!isFixedCategory) return sum + baseAmount;
        const id = item.id || item.name || `${category}-${idx}`;
        const carryover = fixedCarryoverMap.get(`${category}::${id}`) || 0;
        return sum + baseAmount + carryover;
      }, 0);
    }
    if (typeof catBudget === 'number') return Number(catBudget || 0);
    if (catBudget && typeof catBudget === 'object') {
      const funded =
        catBudget.funded !== undefined ? catBudget.funded : catBudget.plan || 0;
      return Number(funded || 0);
    }
    return 0;
  }, [budgetsForPeriod, category, fixedCarryoverMap, fixedCategories]);

  const categorySpentForPeriod = useMemo(() => {
    if (!category) return 0;
    return periodTx.reduce((sum, tx) => {
      if (tx.type !== 'gasto') return sum;
      if (tx.category !== category) return sum;
      return sum + Number(tx.amount || 0);
    }, 0);
  }, [periodTx, category]);

  const categoryRemaining = categoryBudgeted - categorySpentForPeriod;

  const subcategorySpentMap = useMemo(() => {
    if (!category) return new Map();
    const map = new Map();

    for (const tx of periodTx) {
      if (tx?.type !== 'gasto') continue;
      if (tx?.category !== category) continue;
      const allocations = getSubcategoryAllocationsForTransaction({
        transaction: tx,
        breakdown: budgetSubcategories,
      });
      allocations.forEach(({ id, amount }) => {
        if (!id) return;
        const amt = Number(amount || 0);
        if (!amt || Number.isNaN(amt)) return;
        map.set(id, (map.get(id) || 0) + amt);
      });
    }
    return map;
  }, [periodTx, category, budgetSubcategories]);

  const subcategoryRemainingTotal = useMemo(() => {
    if (!budgetSubcategories.length) return categoryRemaining;
    return budgetSubcategories.reduce((sum, sub) => {
      const spent = subcategorySpentMap.get(sub.id) || 0;
      const remaining = Number(sub.amount || 0) - spent;
      return sum + remaining;
    }, 0);
  }, [budgetSubcategories, subcategorySpentMap, categoryRemaining]);

  const selectedSubcategoriesTotal = useMemo(() => {
    if (!selectedSubcategoryIds.length) return 0;
    return selectedSubcategoryIds.reduce((sum, id) => {
      const item = budgetSubcategories.find((s) => s.id === id);
      const spent = item ? subcategorySpentMap.get(item.id) || 0 : 0;
      const remaining = Number(item?.amount || 0) - spent;
      return sum + remaining;
    }, 0);
  }, [selectedSubcategoryIds, budgetSubcategories, subcategorySpentMap]);

  function buildSubcategoryAmountMap(totalAmount) {
    if (selectedSubcategoryIds.length <= 1) return null;
    const safeTotal = Math.round(Number(totalAmount || 0));
    if (!safeTotal || safeTotal <= 0) return null;
    const weights = {};
    selectedSubcategoryIds.forEach((id) => {
      const item = budgetSubcategories.find((s) => s.id === id);
      const spent = item ? subcategorySpentMap.get(item.id) || 0 : 0;
      const remaining = Number(item?.amount || 0) - spent;
      weights[id] = Math.max(Math.round(remaining), 0);
    });

    const weightSum = Object.values(weights).reduce(
      (sum, val) => sum + val,
      0,
    );
    const ids = selectedSubcategoryIds.slice();
    const allocations = {};

    if (weightSum > 0) {
      const raw = ids.map((id) => ({
        id,
        raw: (Number(weights[id] || 0) / weightSum) * safeTotal,
      }));
      const floors = raw.map((item) => ({
        id: item.id,
        value: Math.floor(item.raw),
        frac: item.raw - Math.floor(item.raw),
      }));
      let remainder =
        safeTotal - floors.reduce((sum, item) => sum + item.value, 0);
      floors.sort((a, b) => b.frac - a.frac);
      for (let i = 0; i < floors.length && remainder > 0; i += 1) {
        floors[i].value += 1;
        remainder -= 1;
      }
      floors.forEach((item) => {
        allocations[item.id] = item.value;
      });
      return allocations;
    }

    const base = Math.floor(safeTotal / ids.length);
    let remainder = safeTotal - base * ids.length;
    ids.forEach((id) => {
      allocations[id] = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
    });
    return allocations;
  }

  function buildDebtQuotaAmountMap(totalAmount) {
    if (selectedDebtQuotaIds.length <= 1) return null;
    const safeTotal = Math.round(Number(totalAmount || 0));
    if (!safeTotal || safeTotal <= 0) return null;
    const weights = {};
    selectedDebtQuotaIds.forEach((id) => {
      const quota = debtQuotaById.get(id);
      const remaining = Number(quota?.remaining || 0);
      weights[id] = Math.max(Math.round(remaining), 0);
    });

    const weightSum = Object.values(weights).reduce(
      (sum, val) => sum + val,
      0,
    );
    const ids = selectedDebtQuotaIds.slice();
    const allocations = {};

    if (weightSum > 0) {
      const raw = ids.map((id) => ({
        id,
        raw: (Number(weights[id] || 0) / weightSum) * safeTotal,
      }));
      const floors = raw.map((item) => ({
        id: item.id,
        value: Math.floor(item.raw),
        frac: item.raw - Math.floor(item.raw),
      }));
      let remainder =
        safeTotal - floors.reduce((sum, item) => sum + item.value, 0);
      floors.sort((a, b) => b.frac - a.frac);
      for (let i = 0; i < floors.length && remainder > 0; i += 1) {
        floors[i].value += 1;
        remainder -= 1;
      }
      floors.forEach((item) => {
        allocations[item.id] = item.value;
      });
      return allocations;
    }

    const base = Math.floor(safeTotal / ids.length);
    let remainder = safeTotal - base * ids.length;
    ids.forEach((id) => {
      allocations[id] = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
    });
    return allocations;
  }

  const shouldLockAmount =
    type === 'gasto' &&
    !isDebtCategory(category) &&
    !isSavingsCategory(category) &&
    selectedSubcategoryIds.length > 1;
  const shouldLockDebtAmount =
    type === 'gasto' &&
    isDebtCategory(category) &&
    selectedDebtQuotaIds.length > 1;

  const debtQuotasForPeriod = useMemo(() => {
    if (!formPeriodKey) return [];
    return debtsArray.flatMap((d) => {
      const schedule = Array.isArray(d.schedule) ? d.schedule : [];
      return schedule
        .filter((q) => q.periodKey === formPeriodKey)
        .map((q) => {
          const paid = paidAmountForQuotaId(q.id, d.id);
          const planned = Number(q.plannedAmount || 0);
          const isPaid = paid >= planned && planned > 0;
          const remaining = Math.max(planned - paid, 0);
          return {
            id: q.id,
            debtId: d.id,
            debtName: d.name || 'Deuda',
            dueDate: q.dueDate || '',
            planned,
            paid,
            isPaid,
            remaining,
          };
        });
    });
  }, [debtsArray, formPeriodKey, transactions]);

  const debtQuotaById = useMemo(() => {
    const map = new Map();
    debtQuotasForPeriod.forEach((q) => {
      if (q?.id) map.set(q.id, q);
    });
    return map;
  }, [debtQuotasForPeriod]);

  const debtExcelOptions = useMemo(() => {
    const debtsById = new Map();
    const debtsByName = new Map();
    const quotasById = new Map();
    const quotasByLabel = new Map();
    const quotaRows = [];
    const debtRows = [];

    debtsArray.forEach((debt) => {
      if (!debt?.id) return;
      const debtName = String(debt.name || 'Deuda').trim() || 'Deuda';
      const debtKey = debtName.toLowerCase();
      debtsById.set(debt.id, debt);
      if (!debtsByName.has(debtKey)) debtsByName.set(debtKey, debt);
      debtRows.push({ id: debt.id, name: debtName });

      const schedule = Array.isArray(debt.schedule) ? debt.schedule : [];
      schedule.forEach((quota) => {
        if (!quota?.id) return;
        const periodKey =
          quota.periodKey ||
          (quota.dueDate
            ? budgetMonthKeyForDate(quota.dueDate, budgetCutDay)
            : '');
        const planned = Math.round(Number(quota.plannedAmount || 0));
        const paid = paidAmountForQuotaId(quota.id, debt.id);
        const remaining = Math.max(planned - paid, 0);
        const dueDate = quota.dueDate || '';
        const labelParts = [
          debtName,
          periodKey || 'sin periodo',
          dueDate || 'sin vencimiento',
          planned ? `$${currencyFormatter.format(planned)}` : '',
        ].filter(Boolean);
        const label = labelParts.join(' | ');
        const row = {
          id: quota.id,
          debtId: debt.id,
          debtName,
          label,
          periodKey,
          dueDate,
          planned,
          paid,
          remaining,
        };
        quotasById.set(quota.id, row);
        quotasByLabel.set(label.toLowerCase(), row);
        quotaRows.push(row);
      });
    });

    debtRows.sort((a, b) =>
      a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }),
    );
    quotaRows.sort((a, b) => {
      if (a.periodKey !== b.periodKey) return a.periodKey < b.periodKey ? -1 : 1;
      return a.label.localeCompare(b.label, 'es', { sensitivity: 'base' });
    });

    return { debtRows, quotaRows, debtsById, debtsByName, quotasById, quotasByLabel };
  }, [debtsArray, budgetCutDay, transactions, currencyFormatter]);

  const selectedDebtQuotas = useMemo(
    () =>
      selectedDebtQuotaIds
        .map((id) => debtQuotaById.get(id))
        .filter(Boolean),
    [selectedDebtQuotaIds, debtQuotaById],
  );

  const selectedDebtQuotaNames = useMemo(() => {
    const names = selectedDebtQuotas
      .map((q) => q?.debtName)
      .filter(Boolean)
      .map((name) => String(name).trim())
      .filter(Boolean);
    return Array.from(new Set(names));
  }, [selectedDebtQuotas]);

  const selectedDebtQuotaRemainingTotal = useMemo(
    () =>
      selectedDebtQuotas.reduce(
        (sum, q) => sum + Number(q?.remaining || 0),
        0,
      ),
    [selectedDebtQuotas],
  );

  const savingsGoalsForPeriod = useMemo(() => {
    if (!formPeriodKey) return [];
    return savingsArray.map((s, idx) => {
      const plan = plannedForSavingPeriod(s, formPeriodKey, budgetCutDay);
      const nameBase = s.name || 'Ahorro';
      const name = s.targetDate ? `${nameBase} (${s.targetDate})` : nameBase;
      return {
        id: s.id || `${nameBase}-${idx}`,
        name,
        planned: plan,
      };
    });
  }, [savingsArray, formPeriodKey, budgetCutDay]);

  // Autocompletar monto de Deuda solo cuando el usuario selecciona cuotas.

  useEffect(() => {
    const savingsSelected = isSavingsCategory(category);
    const modalOpen = showGastoModal;

    if (!modalOpen) return;
    if (type !== 'gasto') return;
    if (!savingsSelected) return;
    if (suggestedSavingsAmount <= 0) return;
    if (selectedSavingId) return;
    if (amountEditedByUser) return;
    if (editingTx) return;

    const n = Math.round(suggestedSavingsAmount);
    const digits = String(n);
    const formatted = currencyFormatter.format(n);

    setAmount(digits);
    setAmountFormatted(formatted);
  }, [
    showGastoModal,
    type,
    category,
    suggestedSavingsAmount,
    selectedSavingId,
    amountEditedByUser,
    editingTx,
    currencyFormatter,
  ]);

  useEffect(() => {
    if (!showGastoModal) return;
    if (type !== 'gasto') return;
    if (!isDebtCategory(category)) return;
    if (!selectedDebtQuotaIds.length) return;
    if (editingTx) return;
    const remainingTotal = Number(selectedDebtQuotaRemainingTotal || 0);
    if (!remainingTotal) return;

    const rounded = Math.round(remainingTotal);
    const digits = String(rounded);
    const formatted = currencyFormatter.format(rounded);

    setAmountEditedByUser(false);
    setAmount(digits);
    setAmountFormatted(formatted);
  }, [
    showGastoModal,
    type,
    category,
    selectedDebtQuotaIds,
    selectedDebtQuotaRemainingTotal,
    editingTx,
    currencyFormatter,
  ]);

  useEffect(() => {
    if (!showGastoModal) return;
    if (type !== 'gasto') return;
    if (!isSavingsCategory(category)) return;
    if (!selectedSavingId) return;
    if (editingTx) return;

    const goal = savingsGoalsForPeriod.find((s) => s.id === selectedSavingId);
    if (!goal) return;
    const planned = Number(goal.planned || 0);
    if (!planned) return;

    const rounded = Math.round(planned);
    const digits = String(rounded);
    const formatted = currencyFormatter.format(rounded);

    setAmountEditedByUser(false);
    setAmount(digits);
    setAmountFormatted(formatted);
  }, [
    showGastoModal,
    type,
    category,
    selectedSavingId,
    savingsGoalsForPeriod,
    editingTx,
    currencyFormatter,
  ]);

  useEffect(() => {
    if (!showGastoModal) return;
    if (type !== 'gasto') return;
    if (isDebtCategory(category)) return;
    if (isSavingsCategory(category)) return;
    if (!selectedSubcategoryIds.length) return;
    const shouldForce = selectedSubcategoryIds.length > 1;
    if (!shouldForce && (editingTx || amountEditedByUser)) return;

    const rounded = Math.round(selectedSubcategoriesTotal);
    const normalizedTotal = shouldForce ? Math.max(0, rounded) : rounded;
    if (!shouldForce && normalizedTotal <= 0) return;
    const digits = String(normalizedTotal);
    const formatted = currencyFormatter.format(normalizedTotal);

    setAmountEditedByUser(false);
    setAmount(digits);
    setAmountFormatted(formatted);
  }, [
    showGastoModal,
    type,
    category,
    selectedSubcategoryIds,
    selectedSubcategoriesTotal,
    amountEditedByUser,
    editingTx,
    currencyFormatter,
  ]);

  useEffect(() => {
    if (!selectedSubcategoryIds.length) return;
    setAmountEditedByUser(false);
  }, [selectedSubcategoryIds]);

  // Ajustar categoria de gasto por defecto si cambian las categorias
  useEffect(() => {
    if (!categoryOptions.length) return;
    setCategory((prev) =>
      prev && categoryOptions.includes(prev) ? prev : categoryOptions[0],
    );
  }, [categoryOptions]);

  useEffect(() => {
    if (showGastoModal || showIngresoModal || editingTx) return;
    setType(preferredType);
    if (preferredType === 'gasto') {
      setCategory(preferredCategory);
    }
  }, [
    preferredType,
    preferredCategory,
    showGastoModal,
    showIngresoModal,
    editingTx,
  ]);

  useEffect(() => {
    if (!showIngresoModal) return;
    const baseOwnerId =
      editingTx?.ownerId || activeUser?.id || usersList[0]?.id || '';
    setOwnerUserId(baseOwnerId);
  }, [showIngresoModal, editingTx, activeUser?.id, usersList]);

  useEffect(() => {
    if (type !== 'gasto') {
      setSelectedDebtQuotaIds([]);
      setSelectedSavingId('');
      setSelectedSubcategoryIds([]);
      return;
    }
    if (isDebtCategory(category)) {
      setSelectedSavingId('');
      setSelectedSubcategoryIds([]);
    } else if (isSavingsCategory(category)) {
      setSelectedDebtQuotaIds([]);
      setSelectedSubcategoryIds([]);
    } else {
      setSelectedDebtQuotaIds([]);
      setSelectedSavingId('');
    }
  }, [type, category]);

  const periodLabel = useMemo(
    () => formatBudgetPeriodLabel(monthKeyStr, budgetCutDay),
    [monthKeyStr, budgetCutDay],
  );

  const categoryFilterLabel = useMemo(() => {
    const normalized = filterCategories.filter(
      (cat) => cat !== UNBUDGETED_FILTER_VALUE,
    );
    if (!normalized.length) return 'Todas las categorias';
    if (normalized.length <= 2) return normalized.join(', ');
    return `${normalized.length} categorias`;
  }, [filterCategories]);

  useEffect(() => {
    if (!filterCategories.length) return;
    if (!filterCategories.includes(UNBUDGETED_FILTER_VALUE)) return;
    setFilterCategories((prev) =>
      prev.filter((cat) => cat !== UNBUDGETED_FILTER_VALUE),
    );
  }, [filterCategories]);

  const subcategoryOptions = useMemo(() => {
    const seen = new Set();
    const list = [];
    const add = (name) => {
      const trimmed = String(name || '').trim();
      if (!trimmed) return;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      list.push(trimmed);
    };

    subcategoryMap.byCategory.forEach((items) => {
      items.forEach((item) => add(item.name));
    });
    periodTx.forEach((tx) => {
      getSubcategoryLabels(tx).forEach(add);
    });

    if (!seen.has(DEFAULT_UNBUDGETED_KEY)) {
      list.unshift(DEFAULT_UNBUDGETED_LABEL);
    }

    return list;
  }, [subcategoryMap, periodTx, debts]);

  const subcategoryFilterLabel = useMemo(() => {
    if (!filterSubcategories.length) return 'Todas las subcategorias';
    const names = filterSubcategories.map((sub) =>
      sub === UNBUDGETED_FILTER_VALUE ? DEFAULT_UNBUDGETED_LABEL : sub,
    );
    if (names.length <= 2) return names.join(', ');
    return `${names.length} subcategorias`;
  }, [filterSubcategories]);

  const filtered = useMemo(() => {
    let base = filterTransactionsByPeriodAndUser(
      transactions,
      monthKeyStr,
      budgetCutDay,
      activeUser,
      showOnlyMine,
    );

    if (filterType !== 'todos') {
      base = base.filter((tx) =>
        filterType === 'ingresos' ? tx.type === 'ingreso' : tx.type === 'gasto',
      );
    }

    if (filterCategories.length) {
      const selectedCats = filterCategories.filter(
        (cat) => cat !== UNBUDGETED_FILTER_VALUE,
      );
      if (selectedCats.length) {
        base = base.filter((tx) => selectedCats.includes(tx.category));
      }
    }

    if (filterSubcategories.length) {
      const wantsUnbudgeted = filterSubcategories.includes(
        UNBUDGETED_FILTER_VALUE,
      );
      const selectedSubs = filterSubcategories.filter(
        (sub) => sub !== UNBUDGETED_FILTER_VALUE,
      );
      base = base.filter((tx) => {
        const labels = getSubcategoryLabels(tx);
        const matchesSubcategory = selectedSubs.length
          ? labels.some((label) => selectedSubs.includes(label))
          : false;
        const matchesUnbudgeted =
          wantsUnbudgeted && isDefaultUnbudgetedTx(tx);
        if (wantsUnbudgeted && selectedSubs.length > 0) {
          return matchesUnbudgeted || matchesSubcategory;
        }
        if (wantsUnbudgeted) {
          return matchesUnbudgeted;
        }
        return matchesSubcategory;
      });
    }

    if (filterFromDate || filterToDate) {
      base = base.filter((tx) => {
        const txDate = txDateKey(tx);
        if (filterFromDate && txDate < filterFromDate) return false;
        if (filterToDate && txDate > filterToDate) return false;
        return true;
      });
    }

    if (filterUserId !== 'todos') {
      base = base.filter((tx) => tx.ownerId === filterUserId);
    }

    base.sort((a, b) => {
      const aKey = getTransactionSortKey(a);
      const bKey = getTransactionSortKey(b);
      if (aKey.dayKey !== bKey.dayKey) {
        return aKey.dayKey < bKey.dayKey ? 1 : -1;
      }
      if (aKey.createdTime !== bKey.createdTime) {
        return bKey.createdTime - aKey.createdTime;
      }
      return 0;
    });

    return base;
  }, [
    transactions,
    monthKeyStr,
    budgetCutDay,
    activeUser,
    showOnlyMine,
    filterType,
    filterCategories,
    filterSubcategories,
    filterFromDate,
    filterToDate,
    filterUserId,
    debts,
  ]);

  const canExport = filtered.length > 0;

  const totals = useMemo(() => {
    let ingresos = 0;
    let gastos = 0;

    for (const tx of filtered) {
      const amt = Number(tx.amount || 0);
      if (tx.type === 'ingreso') ingresos += amt;
      if (tx.type === 'gasto') gastos += amt;
    }

    return {
      ingresos,
      gastos,
      balance: ingresos - gastos,
    };
  }, [filtered]);

  // Mismo libro que Inicio y Plan del mes (base caja). Los traspasos entre miembros
  // no cambian el saldo del hogar; los ajustes sí, pero no son ingreso ni gasto.
  const ledger = useMemo(
    () => periodLedger({ transactions, periodKey: currentPeriodKey, cutDay: budgetCutDay, debts }),
    [transactions, currentPeriodKey, budgetCutDay, debts],
  );
  const periodTotals = {
    ingresos: ledger.income,
    gastos: ledger.outflows - ledger.refunds,
    balance: ledger.netCashFlow,
  };
  const saldoAnterior = ledger.opening;
  // Balance a hoy (lo que debería estar en tus cuentas) y proyectado al cierre del periodo,
  // que suma los movimientos registrados con fecha futura.
  const balances = useMemo(
    () => periodBalances({ transactions, periodKey: currentPeriodKey, cutDay: budgetCutDay, today: todayKey() }),
    [transactions, currentPeriodKey, budgetCutDay],
  );
  const balanceDisponible = balances.atToday;
  const balanceProyectado = balances.projected;

  const totalBudgeted = useMemo(() => {
    const source = budgetsForPeriod || {};
    return Object.entries(source).reduce((sum, [cat, entry]) => {
      if (typeof entry === 'number') return sum + Number(entry || 0);
      if (entry && typeof entry === 'object') {
        if (Array.isArray(entry.breakdown) && entry.breakdown.length) {
          const isFixedCategory = resolveFixedCategory({
            entry,
            breakdown: entry.breakdown,
            fixedCategories,
            category: cat,
          });
          return (
            sum +
            entry.breakdown.reduce((acc, item, idx) => {
              const baseAmount = Number(item.amount || 0);
              if (!isFixedCategory) return acc + baseAmount;
              const id = item.id || item.name || `${cat}-${idx}`;
              const carryover =
                fixedCarryoverMap.get(`${cat}::${id}`) || 0;
              return acc + baseAmount + carryover;
            }, 0)
          );
        }
        const funded =
          entry.funded !== undefined ? entry.funded : entry.plan || 0;
        return sum + Number(funded || 0);
      }
      return sum;
    }, 0);
  }, [budgetsForPeriod, fixedCarryoverMap, fixedCategories]);

  const isOverspent =
    periodTotals.gastos > totalBudgeted && periodTotals.gastos > 0;

  const platformBalance = balanceDisponible;
  const cashValue = Number(cashInput || 0);
  const debitValue = Number(debitInput || 0);
  const realBalance = cashValue + debitValue;
  const delta = realBalance - platformBalance;

  useEffect(() => {
    if (!showBalanceModal) return;
    if (delta > 0) setAdjustType('ingreso');
    else if (delta < 0) setAdjustType('gasto');
  }, [delta, showBalanceModal]);

  function getOwnerName(tx) {
    if (tx.ownerName) return tx.ownerName;
    const ownerId = String(tx.ownerId || '').trim();
    const owner = ownerId ? usersList.find((u) => u.id === ownerId) : null;
    if (owner?.name) return owner.name;
    if (owner?.email) return owner.email.split('@')[0];
    if (tx.ownerEmail) return tx.ownerEmail.split('@')[0];
    return 'Usuario';
  }
  // Nombre de la deuda de un pago de cuota (cuotas de cualquier periodo, no solo el del formulario).
  function getDebtPaymentLabel(tx) {
    const meta = tx?.meta || {};
    const quotaIds = extractDebtQuotaIds(meta);
    if (!quotaIds.length && !meta.debtId) return '';
    const debt =
      debtsArray.find((d) => d?.id && d.id === meta.debtId) ||
      debtsArray.find((d) =>
        (Array.isArray(d?.schedule) ? d.schedule : []).some((q) => quotaIds.includes(q?.id)),
      );
    return debt?.name || 'Pago de deuda';
  }

  function getSubcategoryLabel(tx) {
    const meta = tx?.meta || {};
    const names = String(meta.budgetSubcategoryNames || '').trim();
    if (names) {
      return names.split(';')[0].trim();
    }
    if (meta.budgetSubcategoryName) {
      return String(meta.budgetSubcategoryName).trim();
    }
    if (isSavingsCategory(tx?.category)) {
      const savingName = String(meta.savingName || '').trim();
      if (savingName) return savingName;
      const savingId = String(meta.savingId || '').trim();
      if (savingId) {
        const match = savingsArray.find((s) => s.id === savingId);
        if (match) {
          const baseName = match.name || 'Ahorro';
          return match.targetDate ? `${baseName} (${match.targetDate})` : baseName;
        }
      }
    }
    const ids = Array.isArray(meta.budgetSubcategoryIds)
      ? meta.budgetSubcategoryIds
      : meta.budgetSubcategoryId
      ? [meta.budgetSubcategoryId]
      : [];
    if (ids.length) {
      const name = subcategoryMap.byId.get(ids[0]);
      if (name) return name;
    }
    return getDebtPaymentLabel(tx);
  }

  function getSubcategoryLabels(tx) {
    const meta = tx?.meta || {};
    const names = String(meta.budgetSubcategoryNames || '').trim();
    if (names) {
      return names
        .split(';')
        .map((name) => name.trim())
        .filter(Boolean);
    }
    if (meta.budgetSubcategoryName) {
      return [String(meta.budgetSubcategoryName).trim()].filter(Boolean);
    }
    if (isSavingsCategory(tx?.category)) {
      const savingName = String(meta.savingName || '').trim();
      if (savingName) return [savingName];
      const savingId = String(meta.savingId || '').trim();
      if (savingId) {
        const match = savingsArray.find((s) => s.id === savingId);
        if (match) {
          const baseName = match.name || 'Ahorro';
          const label = match.targetDate
            ? `${baseName} (${match.targetDate})`
            : baseName;
          return [label];
        }
      }
    }
    const ids = Array.isArray(meta.budgetSubcategoryIds)
      ? meta.budgetSubcategoryIds
      : meta.budgetSubcategoryId
      ? [meta.budgetSubcategoryId]
      : [];
    if (ids.length) {
      return ids
        .map((id) => subcategoryMap.byId.get(id))
        .filter(Boolean);
    }
    const debtLabel = getDebtPaymentLabel(tx);
    return debtLabel ? [debtLabel] : [];
  }

  function isDefaultUnbudgetedTx(tx) {
    if (!tx || tx.type !== 'gasto') return false;
    const label = getSubcategoryLabel(tx);
    if (label && label.trim().toLowerCase() === DEFAULT_UNBUDGETED_KEY) {
      return true;
    }
    const meta = tx?.meta || {};
    const hasIds = Array.isArray(meta.budgetSubcategoryIds)
      ? meta.budgetSubcategoryIds.length > 0
      : Boolean(meta.budgetSubcategoryId);
    const hasNames =
      Boolean(String(meta.budgetSubcategoryNames || '').trim()) ||
      Boolean(meta.budgetSubcategoryName);
    if (hasIds || hasNames) return false;
    if (isSavingsCategory(tx?.category)) {
      if (meta.savingId || meta.savingName) return false;
    }
    // Los pagos de cuotas ya están presupuestados en Compromisos; los ajustes no son gasto.
    if (extractDebtQuotaIds(meta).length || meta.debtId) return false;
    if (isAdjustment(tx)) return false;
    return Boolean(tx.category);
  }

  function getTransactionSortKey(tx) {
    const rawDate = String(tx?.date || '').slice(0, 10);
    const rawCreated = String(tx?.createdAt || '');
    const dayKey = rawDate || rawCreated.slice(0, 10) || '1970-01-01';
    const parsedCreated = rawCreated ? Date.parse(rawCreated) : NaN;
    const createdTime = Number.isNaN(parsedCreated) ? 0 : parsedCreated;
    return { dayKey, createdTime };
  }

  function formatDateKey(date) {
    if (!date) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function parseDateKey(dateStr) {
    if (!dateStr) return null;
    const [year, month, day] = String(dateStr).split('-').map(Number);
    if (!year || !month || !day) return null;
    return new Date(year, month - 1, day);
  }

  function addMonths(date, diff) {
    return new Date(date.getFullYear(), date.getMonth() + diff, 1);
  }

  function buildMonthMatrix(date) {
    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDay = new Date(year, month, 1);
    const startOffset = (firstDay.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const weeks = [];
    let day = 1;

    for (let week = 0; week < 6; week += 1) {
      const row = [];
      for (let col = 0; col < 7; col += 1) {
        if (week === 0 && col < startOffset) {
          row.push(null);
          continue;
        }
        if (day > daysInMonth) {
          row.push(null);
          continue;
        }
        row.push(new Date(year, month, day));
        day += 1;
      }
      weeks.push(row);
    }

    while (weeks.length && weeks[weeks.length - 1].every((d) => !d)) {
      weeks.pop();
    }

    return weeks;
  }

  function handleDatePick(date) {
    const dateKey = formatDateKey(date);
    if (!dateKey) return;
    if (!draftFromDate || (draftFromDate && draftToDate)) {
      setDraftFromDate(dateKey);
      setDraftToDate('');
      return;
    }
    if (dateKey < draftFromDate) {
      setDraftToDate(draftFromDate);
      setDraftFromDate(dateKey);
    } else {
      setDraftToDate(dateKey);
    }
  }

  function clampDateToPeriod(dateStr) {
    const { start, end } = getBudgetPeriod(monthKeyStr, budgetCutDay);
    if (!dateStr) return start;
    const today = new Date(dateStr + 'T00:00:00');
    const startDate = new Date(start + 'T00:00:00');
    const endDate = new Date(end + 'T00:00:00');
    const endMinusOne = new Date(endDate);
    endMinusOne.setDate(endMinusOne.getDate() - 1);
    if (today < startDate) return start;
    if (today > endMinusOne) return toLocalDateKey(endMinusOne);
    return toLocalDateKey(today);
  }

  function getPeriodEndDate(monthKeyValue) {
    const { end } = getBudgetPeriod(monthKeyValue, budgetCutDay);
    const endDate = new Date(end + 'T00:00:00');
    endDate.setDate(endDate.getDate() - 1);
    return toLocalDateKey(endDate);
  }

  function formatAmountForInput(value) {
    const n = Number(value || 0);
    if (!n || Number.isNaN(n)) {
      return { digits: '', formatted: '' };
    }
    const rounded = Math.round(n);
    const digits = String(rounded);
    return { digits, formatted: currencyFormatter.format(rounded) };
  }

  function parseCalculatorSum(raw) {
    const text = String(raw || '').trim();
    if (!text) return { sum: '', isExpression: false, isValid: false };
    const cleaned = text.replace(/[.,\s]/g, '');
    if (!cleaned) return { sum: '', isExpression: false, isValid: false };
    const isExpression = cleaned.includes('+');
    const parts = cleaned.split('+').filter(Boolean);
    if (!parts.length || parts.some((p) => /\D/.test(p))) {
      return { sum: '', isExpression, isValid: false };
    }
    const total = parts.reduce((acc, p) => acc + Number(p), 0);
    return { sum: String(Math.round(total)), isExpression, isValid: true };
  }

  function handleCalculatorInput(raw, setters) {
    const text = String(raw || '');
    if (!text.trim()) {
      setters.setFormatted('');
      setters.setValue('');
      return;
    }
    const parsed = parseCalculatorSum(text);
    if (!parsed.isValid) {
      setters.setFormatted(text);
      setters.setValue('');
      return;
    }
    const formatted = currencyFormatter.format(Number(parsed.sum || 0));
    setters.setFormatted(parsed.isExpression ? text : formatted);
    setters.setValue(parsed.sum);
  }

  function commitCalculatorInput(raw, setters) {
    const parsed = parseCalculatorSum(raw);
    if (!parsed.isValid || !parsed.sum) {
      return;
    }
    const formatted = currencyFormatter.format(Number(parsed.sum || 0));
    setters.setFormatted(formatted);
    setters.setValue(parsed.sum);
  }

  function paidAmountForQuotaId(quotaId, debtId) {
    if (!quotaId) return 0;
    let total = 0;
    let totalByDebt = 0;
    let hasDebtMatch = false;

    (transactions || []).forEach((t) => {
      if (t?.category !== DEBT_CATEGORY) return;
      const meta = t?.meta || {};
      const ids = Array.isArray(meta.debtQuotaIds)
        ? meta.debtQuotaIds
        : meta.debtQuotaId
        ? [meta.debtQuotaId]
        : [];
      const uniqueIds = Array.from(
        new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)),
      );
      if (!uniqueIds.length || !uniqueIds.includes(quotaId)) return;
      const amt = Number(t.amount || 0);
      if (Number.isNaN(amt)) return;

      const safeTotal = Math.round(amt);
      let allocationMap = null;
      if (uniqueIds.length === 1) {
        allocationMap = { [uniqueIds[0]]: safeTotal };
      } else if (safeTotal > 0) {
        const rawAlloc =
          meta.debtQuotaAmounts || meta.debtQuotaAllocations || null;
        if (rawAlloc && typeof rawAlloc === 'object') {
          const weights = {};
          if (Array.isArray(rawAlloc)) {
            rawAlloc.forEach((item) => {
              if (!item || !item.id) return;
              weights[String(item.id)] = Number(item.amount || 0);
            });
          } else {
            Object.entries(rawAlloc).forEach(([key, value]) => {
              const safeKey = String(key || '').trim();
              if (!safeKey) return;
              weights[safeKey] = Number(value || 0);
            });
          }
          const entries = uniqueIds.map((id) => ({
            id,
            weight: Math.max(Number(weights[id] || 0), 0),
          }));
          const weightSum = entries.reduce((sum, item) => sum + item.weight, 0);
          if (weightSum > 0) {
            const raw = entries.map((item) => ({
              id: item.id,
              raw: (item.weight / weightSum) * safeTotal,
            }));
            const floors = raw.map((item) => ({
              id: item.id,
              value: Math.floor(item.raw),
              frac: item.raw - Math.floor(item.raw),
            }));
            let remainder =
              safeTotal - floors.reduce((sum, item) => sum + item.value, 0);
            floors.sort((a, b) => b.frac - a.frac);
            for (let i = 0; i < floors.length && remainder > 0; i += 1) {
              floors[i].value += 1;
              remainder -= 1;
            }
            allocationMap = {};
            floors.forEach((item) => {
              allocationMap[item.id] = item.value;
            });
          }
        }
        if (!allocationMap) {
          const base = Math.floor(safeTotal / uniqueIds.length);
          let remainder = safeTotal - base * uniqueIds.length;
          allocationMap = {};
          uniqueIds.forEach((id) => {
            allocationMap[id] = base + (remainder > 0 ? 1 : 0);
            if (remainder > 0) remainder -= 1;
          });
        }
      }

      const allocation = allocationMap?.[quotaId] || 0;
      if (!allocation) return;

      total += allocation;
      if (debtId) {
        const debtIdMap =
          meta.debtQuotaDebtIds && typeof meta.debtQuotaDebtIds === 'object'
            ? meta.debtQuotaDebtIds
            : null;
        const quotaDebtId = debtIdMap?.[quotaId] || meta.debtId || '';
        if (quotaDebtId && quotaDebtId === debtId) {
          totalByDebt += allocation;
          hasDebtMatch = true;
        }
      }
    });

    if (debtId && hasDebtMatch) return totalByDebt;
    return total;
  }

  function resetAdjustForm() {
    setCashInput('');
    setCashFormatted('');
    setDebitInput('');
    setDebitFormatted('');
    setAdjustPeriod('previous');
    setAdjustNote('');
    setAdjustError('');
  }

  function openExcelModal() {
    setImportError('');
    setShowExcelModal(true);
  }

  function closeExcelModal() {
    setShowExcelModal(false);
    setIsDraggingFile(false);
    setImportError('');
  }

  function closeTransactionModal() {
    setShowIngresoModal(false);
    setShowGastoModal(false);
    setEditingTx(null);
    setAmount('');
    setAmountFormatted('');
    setDescription('');
    setSelectedDebtQuotaIds([]);
    setSelectedSavingId('');
    setSelectedSubcategoryIds([]);
    setAmountEditedByUser(false);
    setOwnerUserId('');
  }

  function closeContextMenu() {
    setContextMenu(null);
  }

  function openContextMenu(tx, event) {
    if (!tx || !hasContextActions) return;
    event.preventDefault();
    const padding = 12;
    const menuWidth = 200;
    const menuHeight = 140;
    const maxX = Math.max(padding, window.innerWidth - menuWidth - padding);
    const maxY = Math.max(padding, window.innerHeight - menuHeight - padding);
    const nextX = Math.min(event.clientX, maxX);
    const nextY = Math.min(event.clientY, maxY);
    setContextMenu({
      tx,
      x: nextX,
      y: nextY,
    });
  }

  // Borra al tiro y ofrece "Deshacer": el movimiento queda en la papelera.
  async function confirmRemoveTransaction(tx) {
    if (!removeTransaction || !tx?.id) return;
    const label = tx.description || 'Movimiento';
    try {
      const removed = await removeTransaction(tx.id);
      toast.success(`${label} eliminado.`, {
        action:
          removed && restoreTrashItem
            ? { label: 'Deshacer', onClick: () => restoreTrashItem(removed.item) }
            : null,
      });
    } catch (err) {
      console.error('Error eliminando movimiento', { code: err?.code });
      toast.error('No se pudo eliminar el movimiento.');
    }
  }


  async function duplicateTransaction(tx) {
    if (!addTransaction || !tx) return;
    const typeValue = tx.type === 'ingreso' ? 'ingreso' : 'gasto';
    const baseDate = txDateKey(tx);
    const normalized = {
      type: typeValue,
      amount: Math.round(Number(tx.amount || 0)),
      category:
        typeValue === 'ingreso' ? incomeCategoryLabel : tx.category || '',
      description: String(tx.description || '').trim(),
      date: baseDate || todayKey(),
      ownerId: tx.ownerId || activeUser?.id || null,
      ownerName: tx.ownerName || activeUser?.name || null,
      ownerEmail: tx.ownerEmail || activeUser?.email || null,
      createdAt: new Date().toISOString(),
    };
    if (typeValue === 'gasto' && tx.meta) {
      normalized.meta = { ...tx.meta };
    }
    try {
      await addTransaction(normalized);
    } catch (err) {
      console.error('Error al duplicar movimiento:', err);
      toast.error('No se pudo duplicar el movimiento.');
    }
  }

  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    const handleKey = (event) => {
      if (event.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('click', handleClick);
    window.addEventListener('keydown', handleKey);
    window.addEventListener('scroll', handleClick, true);
    window.addEventListener('resize', handleClick);
    return () => {
      window.removeEventListener('click', handleClick);
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('scroll', handleClick, true);
      window.removeEventListener('resize', handleClick);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!showDateRangePicker) return;
    const handleClick = (event) => {
      if (!dateRangeRef.current) return;
      if (!dateRangeRef.current.contains(event.target)) {
        setShowDateRangePicker(false);
      }
    };
    const handleKey = (event) => {
      if (event.key === 'Escape') setShowDateRangePicker(false);
    };
    window.addEventListener('mousedown', handleClick);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handleClick);
      window.removeEventListener('keydown', handleKey);
    };
  }, [showDateRangePicker]);

  useEffect(() => {
    if (!showCategoryFilter) return;
    const handleClick = (event) => {
      if (!categoryFilterRef.current) return;
      if (!categoryFilterRef.current.contains(event.target)) {
        setShowCategoryFilter(false);
      }
    };
    const handleKey = (event) => {
      if (event.key === 'Escape') setShowCategoryFilter(false);
    };
    window.addEventListener('mousedown', handleClick);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handleClick);
      window.removeEventListener('keydown', handleKey);
    };
  }, [showCategoryFilter]);

  useEffect(() => {
    if (!showSubcategoryFilter) return;
    const handleClick = (event) => {
      if (!subcategoryFilterRef.current) return;
      if (!subcategoryFilterRef.current.contains(event.target)) {
        setShowSubcategoryFilter(false);
      }
    };
    const handleKey = (event) => {
      if (event.key === 'Escape') setShowSubcategoryFilter(false);
    };
    window.addEventListener('mousedown', handleClick);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handleClick);
      window.removeEventListener('keydown', handleKey);
    };
  }, [showSubcategoryFilter]);

  useEffect(() => {
    if (!showDateRangePicker) return;
    const seed = parseDateKey(filterFromDate) || new Date();
    setCalendarBaseMonth(new Date(seed.getFullYear(), seed.getMonth(), 1));
    setDraftFromDate(filterFromDate || '');
    setDraftToDate(filterToDate || '');
  }, [showDateRangePicker, filterFromDate, filterToDate]);

  function startNewTransaction(kind) {
    setEditingTx(null);
    const resolvedType = kind || preferredType;
    setType(resolvedType);
    setAmount('');
    setAmountFormatted('');
    setDescription('');
    setSelectedDebtQuotaIds([]);
    setSelectedSavingId('');
    setSelectedSubcategoryIds([]);
    setAmountEditedByUser(false);
    if (resolvedType === 'gasto') {
      setCategory(preferredCategory);
    }
    if (resolvedType === 'ingreso') {
      setOwnerUserId(activeUser?.id || usersList[0]?.id || '');
    }
    setAccountId(defaultAccountFor(activeUser?.id));
    if (resolvedType === 'ingreso') setShowIngresoModal(true);
    if (resolvedType === 'gasto') setShowGastoModal(true);
  }

  function startEditTransaction(tx) {
    if (!tx) return;
    const baseType = tx.type === 'ingreso' ? 'ingreso' : 'gasto';
    const { digits, formatted } = formatAmountForInput(tx.amount);
    const baseDate = clampDateToPeriod(
      (tx.date || tx.createdAt || todayKey()).slice(
        0,
        10,
      ),
    );

    setType(baseType);
    setAmount(digits);
    setAmountFormatted(formatted);
    setCategory(tx.category || categoryOptions[0] || '');
    setDate(baseDate);
    setDescription(tx.description || '');
    setAmountEditedByUser(false);
    const metaDebtIds = tx?.meta?.debtQuotaIds;
    const singleDebtId = tx?.meta?.debtQuotaId;
    if (Array.isArray(metaDebtIds)) {
      setSelectedDebtQuotaIds(metaDebtIds.filter(Boolean));
    } else if (singleDebtId) {
      setSelectedDebtQuotaIds([singleDebtId]);
    } else {
      setSelectedDebtQuotaIds([]);
    }
    setSelectedSavingId(tx?.meta?.savingId || '');
    const metaSubs = tx?.meta?.budgetSubcategoryIds;
    const singleMeta = tx?.meta?.budgetSubcategoryId;
    if (Array.isArray(metaSubs)) {
      setSelectedSubcategoryIds(metaSubs.filter(Boolean));
    } else if (singleMeta) {
      setSelectedSubcategoryIds([singleMeta]);
    } else {
      setSelectedSubcategoryIds([]);
    }
    setEditingTx(tx);
    if (baseType === 'ingreso') {
      setOwnerUserId(tx.ownerId || activeUser?.id || usersList[0]?.id || '');
    }
    setAccountId(tx.account || '');
    if (baseType === 'ingreso') setShowIngresoModal(true);
    else setShowGastoModal(true);
  }

  async function handleAdd(e) {
    e.preventDefault();

    const n = Number(amount || 0);
    const isEditing = !!editingTx;
    const handler = isEditing ? updateTransaction : addTransaction;
    if (!n || n <= 0 || !handler) {
      toast.warning('Ingresa un monto válido.');
      return;
    }

    const editingOwner = editingTx
      ? {
          id: editingTx.ownerId || null,
          name: editingTx.ownerName || null,
          email: editingTx.ownerEmail || null,
        }
      : null;
    const selectedOwner = usersList.find((u) => u.id === ownerUserId);
    const ownerIngreso = selectedOwner || editingOwner || activeUser || null;
    const ownerGasto = editingOwner || activeUser || null;
    const owner = type === 'ingreso' ? ownerIngreso : ownerGasto;

    const rawDate = date || todayKey();
    const normalized = {
      type,
      amount: n,
      category:
        type === 'gasto' ? category || categoryOptions[0] || 'Otros' : '',
      description: description.trim(),
      date: rawDate,
      ownerId: owner?.id ?? null,
      ownerName: owner?.name ?? null,
      ownerEmail: owner?.email ?? null,
      account: accountId || null,
    };

    const baseMeta = editingTx?.meta ? { ...editingTx.meta } : {};
    const isDebtTx = type === 'gasto' && isDebtCategory(normalized.category);
    const isSavingsTx =
      type === 'gasto' && isSavingsCategory(normalized.category);
    const resolvedDebtName = selectedDebtQuotaNames[0] || '';

    if (isDebtTx) {
      const periodDate = clampDateToPeriod(rawDate);
      if (periodDate !== rawDate) {
        const todayStr = todayKey();
        normalized.date = clampDateToPeriod(todayStr);
      } else {
        normalized.date = periodDate;
      }
      if (selectedDebtQuotaIds.length) {
        const debtQuotaDebtIds = {};
        selectedDebtQuotas.forEach((quota) => {
          if (quota?.id && quota?.debtId) {
            debtQuotaDebtIds[quota.id] = quota.debtId;
          }
        });

        baseMeta.debtQuotaIds = selectedDebtQuotaIds;

        if (selectedDebtQuotaIds.length === 1) {
          const onlyId = selectedDebtQuotaIds[0];
          baseMeta.debtQuotaId = onlyId;
          if (debtQuotaDebtIds[onlyId]) {
            baseMeta.debtId = debtQuotaDebtIds[onlyId];
          } else {
            delete baseMeta.debtId;
          }
          if (resolvedDebtName) {
            baseMeta.debtName = resolvedDebtName;
          } else {
            delete baseMeta.debtName;
          }
          baseMeta.budgetSubcategoryName = resolvedDebtName || 'pago de deudas';
          delete baseMeta.budgetSubcategoryNames;
          delete baseMeta.debtQuotaAmounts;
        } else {
          delete baseMeta.debtQuotaId;
          delete baseMeta.debtId;
          delete baseMeta.debtName;
          if (selectedDebtQuotaNames.length) {
            baseMeta.budgetSubcategoryNames =
              selectedDebtQuotaNames.join('; ');
            baseMeta.budgetSubcategoryName = selectedDebtQuotaNames[0];
          } else {
            delete baseMeta.budgetSubcategoryNames;
            delete baseMeta.budgetSubcategoryName;
          }
          const allocationMap = buildDebtQuotaAmountMap(n);
          if (allocationMap) {
            baseMeta.debtQuotaAmounts = allocationMap;
          } else {
            delete baseMeta.debtQuotaAmounts;
          }
        }

        if (Object.keys(debtQuotaDebtIds).length) {
          baseMeta.debtQuotaDebtIds = debtQuotaDebtIds;
        } else {
          delete baseMeta.debtQuotaDebtIds;
        }
      } else {
        delete baseMeta.debtQuotaIds;
        delete baseMeta.debtQuotaAmounts;
        delete baseMeta.debtQuotaDebtIds;
        delete baseMeta.debtQuotaId;
        delete baseMeta.debtId;
        delete baseMeta.debtName;
        baseMeta.budgetSubcategoryName = 'pago de deudas';
        delete baseMeta.budgetSubcategoryNames;
      }

      delete baseMeta.budgetSubcategoryIds;
      delete baseMeta.budgetSubcategoryAmounts;
      delete baseMeta.budgetSubcategoryId;
    } else {
      delete baseMeta.debtQuotaIds;
      delete baseMeta.debtQuotaAmounts;
      delete baseMeta.debtQuotaDebtIds;
      delete baseMeta.debtQuotaId;
      delete baseMeta.debtId;
      delete baseMeta.debtName;
    }

    const selectedSaving = selectedSavingId
      ? savingsGoalsForPeriod.find((s) => s.id === selectedSavingId)
      : null;
    if (selectedSavingId) {
      baseMeta.savingId = selectedSavingId;
      if (selectedSaving?.name) {
        baseMeta.savingName = selectedSaving.name;
      }
    } else {
      delete baseMeta.savingId;
      delete baseMeta.savingName;
    }
    if (isSavingsTx) {
      if (selectedSaving?.name) {
        baseMeta.budgetSubcategoryName = selectedSaving.name;
      } else {
        delete baseMeta.budgetSubcategoryName;
      }
      delete baseMeta.budgetSubcategoryNames;
      delete baseMeta.budgetSubcategoryIds;
      delete baseMeta.budgetSubcategoryAmounts;
      delete baseMeta.budgetSubcategoryId;
    } else if (!isDebtTx) {
      if (selectedSubcategoryIds.length > 0) {
        baseMeta.budgetSubcategoryIds = selectedSubcategoryIds;
        baseMeta.budgetSubcategoryNames = selectedSubcategoryIds
          .map((id) => budgetSubcategories.find((s) => s.id === id)?.name)
          .filter(Boolean)
          .join('; ');
        if (selectedSubcategoryIds.length > 1) {
          const allocationMap = buildSubcategoryAmountMap(n);
          if (allocationMap) {
            baseMeta.budgetSubcategoryAmounts = allocationMap;
          } else {
            delete baseMeta.budgetSubcategoryAmounts;
          }
        } else {
          delete baseMeta.budgetSubcategoryAmounts;
        }
        // compat con datos antiguos: limpiamos la clave singular
        delete baseMeta.budgetSubcategoryId;
        delete baseMeta.budgetSubcategoryName;
      } else {
        delete baseMeta.budgetSubcategoryIds;
        delete baseMeta.budgetSubcategoryNames;
        delete baseMeta.budgetSubcategoryAmounts;
        delete baseMeta.budgetSubcategoryId;
        delete baseMeta.budgetSubcategoryName;
      }
    }
    // Traspasos, reembolsos y retiros de ahorro conservan su tipo y categoría al editarse:
    // de eso depende cómo se contabilizan (ver domain/ledger.js).
    if (['transfer', 'refund', 'saving_withdrawal'].includes(editingTx?.meta?.kind)) {
      normalized.type = editingTx.type;
      normalized.category = editingTx.category;
    }

    const shouldPersistMeta =
      isDebtTx ||
      selectedDebtQuotaIds.length > 0 ||
      selectedSavingId ||
      selectedSubcategoryIds.length > 0 ||
      (editingTx && editingTx.meta);
    if (shouldPersistMeta) {
      normalized.meta = baseMeta;
    }

    // Gasto nuevo o edición que sube el monto: avisar si supera la plata que hay hoy.
    if (normalized.type === 'gasto' && normalized.meta?.kind !== 'transfer') {
      const prevAmount =
        isEditing && editingTx.type === 'gasto' ? Number(editingTx.amount || 0) : 0;
      const increase = Number(normalized.amount || 0) - prevAmount;
      if (increase > 0 && !(await confirmWithinCash({ amount: increase, transactions }))) return;
    }

    try {
      if (isEditing) {
        await updateTransaction(editingTx.id, normalized);
      } else {
        const createdId = await addTransaction({
          ...normalized,
          createdAt: new Date().toISOString(),
        });
        // Si no se guardó, se conserva lo escrito para reintentar (el aviso ya se mostró).
        if (!createdId) return;
      }
      setAmount('');
      setAmountFormatted('');
      setDescription('');
      setEditingTx(null);
      setSelectedDebtQuotaIds([]);
      setSelectedSubcategoryIds([]);
      setAmountEditedByUser(false);
      setOwnerUserId('');
      setShowIngresoModal(false);
      setShowGastoModal(false);
    } catch (err) {
      console.error('Error al guardar movimiento:', err);
      toast.error('No se pudo guardar el movimiento.');
    }
  }

  async function handleSaveAdjustment() {
    if (!addTransaction) return;
    setAdjustError('');

    const efectivo = Number(cashInput || 0);
    const debito = Number(debitInput || 0);
    if (
      Number.isNaN(efectivo) ||
      Number.isNaN(debito) ||
      efectivo < 0 ||
      debito < 0
    ) {
      setAdjustError('Ingresa montos validos para efectivo y debito.');
      return;
    }

    if (delta === 0) {
      setAdjustError('No hay diferencia que ajustar.');
      return;
    }

    const amountAdjust = Math.abs(delta);
    if (!amountAdjust || amountAdjust <= 0) {
      setAdjustError('El monto de ajuste no es valido.');
      return;
    }

    const adjustmentPeriodKey =
      adjustPeriod === 'current' ? monthKeyStr : shiftMonth(monthKeyStr, -1);
    const txDate =
      adjustPeriod === 'current'
        ? clampDateToPeriod(todayKey())
        : getPeriodEndDate(adjustmentPeriodKey);

    const fallbackCategory = 'Ajuste Balance';

    const adjustmentTx = {
      type: adjustType,
      amount: amountAdjust,
      category: fallbackCategory,
      description: adjustNote.trim() || 'Ajuste de balance desde calculadora',
      date: txDate,
      createdAt: new Date().toISOString(),
      ownerId: activeUser?.id || null,
      ownerName: activeUser?.name || null,
      ownerEmail: activeUser?.email || null,
      meta: {
        cashSum: efectivo,
        debitSum: debito,
        platformBalance,
        realBalance,
        delta,
        adjustmentPeriod: adjustPeriod,
        adjustmentPeriodKey,
        source: 'balance-calculator',
      },
    };

    try {
      await addTransaction(adjustmentTx);
      setShowBalanceModal(false);
      resetAdjustForm();
    } catch (err) {
      console.error('Error al guardar ajuste de balance:', err);
      setAdjustError('No se pudo guardar el ajuste.');
    }
  }

  function normalizeRowValue(row, keys) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(row, key)) {
        return row[key];
      }
    }
    return '';
  }

  function normalizeRowKeys(row) {
    const normalized = {};
    Object.entries(row || {}).forEach(([key, value]) => {
      const safeKey = String(key || '')
        .trim()
        .toLowerCase();
      if (!safeKey) return;
      normalized[safeKey] = value;
    });
    return normalized;
  }

  function normalizeHeaderKey(value) {
    const raw = String(value || '')
      .trim()
      .toLowerCase();
    if (!raw) return '';
    return raw.replace(/\s+/g, '');
  }

  function columnIndexToLetter(index) {
    let n = index + 1;
    let out = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      out = String.fromCharCode(65 + rem) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  }

  function escapeXml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function applyFreezePanes(sheetXml) {
    const freezeXml =
      '<sheetViews>' +
      '<sheetView workbookViewId="0">' +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' +
      '</sheetView>' +
      '</sheetViews>';

    if (sheetXml.includes('<sheetViews')) {
      return sheetXml.replace(/<sheetViews[\s\S]*?<\/sheetViews>/, freezeXml);
    }

    const dimensionMatch = sheetXml.match(/<dimension[^>]*\/>/);
    if (dimensionMatch) {
      return sheetXml.replace(
        dimensionMatch[0],
        `${dimensionMatch[0]}${freezeXml}`,
      );
    }

    const worksheetMatch = sheetXml.match(/<worksheet[^>]*>/);
    if (worksheetMatch) {
      return sheetXml.replace(
        worksheetMatch[0],
        `${worksheetMatch[0]}${freezeXml}`,
      );
    }

    return sheetXml;
  }

  function applyHeaderStyleToSheet(sheetXml, styleId) {
    if (styleId === null || styleId === undefined) return sheetXml;
    return sheetXml.replace(
      /<row r="1"[^>]*>([\s\S]*?)<\/row>/,
      (match, inner) => {
        const updated = inner.replace(/<c ([^>]*?)>/g, (cell, attrs) => {
          if (/s="[^"]*"/.test(attrs)) {
            return `<c ${attrs.replace(/s="[^"]*"/, `s="${styleId}"`)}>`;
          }
          return `<c ${attrs} s="${styleId}">`;
        });
        return match.replace(inner, updated);
      },
    );
  }

  function appendHeaderStyle(stylesXml) {
    const fontMatch = stylesXml.match(/<fonts[^>]*count="(\d+)"[^>]*>/);
    const fillMatch = stylesXml.match(/<fills[^>]*count="(\d+)"[^>]*>/);
    const xfMatch = stylesXml.match(/<cellXfs[^>]*count="(\d+)"[^>]*>/);
    if (!fontMatch || !fillMatch || !xfMatch) {
      return { xml: stylesXml, styleId: null };
    }

    const fontCount = Number(fontMatch[1]);
    const fillCount = Number(fillMatch[1]);
    const xfCount = Number(xfMatch[1]);
    const fontId = fontCount;
    const fillId = fillCount;
    const styleId = xfCount;

    const headerFont =
      '<font><sz val="12"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/><scheme val="minor"/><b/></font>';
    const headerFill =
      '<fill><patternFill patternType="solid"><fgColor rgb="FF1F2937"/><bgColor indexed="64"/></patternFill></fill>';
    const headerXf =
      `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1">` +
      '<alignment horizontal="center" vertical="center"/>' +
      '</xf>';

    let nextXml = stylesXml;
    nextXml = nextXml.replace(
      /<fonts([^>]*)count="(\d+)"([^>]*)>([\s\S]*?)<\/fonts>/,
      (match, pre, count, post, inner) => {
        const nextCount = Number(count) + 1;
        return `<fonts${pre}count="${nextCount}"${post}>${inner}${headerFont}</fonts>`;
      },
    );
    nextXml = nextXml.replace(
      /<fills([^>]*)count="(\d+)"([^>]*)>([\s\S]*?)<\/fills>/,
      (match, pre, count, post, inner) => {
        const nextCount = Number(count) + 1;
        return `<fills${pre}count="${nextCount}"${post}>${inner}${headerFill}</fills>`;
      },
    );
    nextXml = nextXml.replace(
      /<cellXfs([^>]*)count="(\d+)"([^>]*)>([\s\S]*?)<\/cellXfs>/,
      (match, pre, count, post, inner) => {
        const nextCount = Number(count) + 1;
        return `<cellXfs${pre}count="${nextCount}"${post}>${inner}${headerXf}</cellXfs>`;
      },
    );

    return { xml: nextXml, styleId };
  }

  function toExcelName(value, used) {
    let base = String(value || '').trim();
    if (!base) base = 'CAT';
    base = base
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9_]/g, '_');
    if (!base) base = 'CAT';
    if (/^[0-9]/.test(base)) base = `C_${base}`;
    let name = base;
    let idx = 1;
    while (used.has(name)) {
      name = `${base}_${idx}`;
      idx += 1;
    }
    used.add(name);
    return name;
  }

  function normalizeDateValue(value) {
    if (!value) return '';
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString().slice(0, 10);
    }
    if (typeof value === 'number') {
      const parsed = XLSX.SSF.parse_date_code(value);
      if (parsed) {
        const safe = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
        return safe.toISOString().slice(0, 10);
      }
    }
    const str = String(value || '').trim();
    const iso = str.match(/^\d{4}-\d{2}-\d{2}/);
    if (iso) return iso[0];
    const dmy = str.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
    if (dmy) {
      const day = String(dmy[1]).padStart(2, '0');
      const month = String(dmy[2]).padStart(2, '0');
      const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
      return `${year}-${month}-${day}`;
    }
    return '';
  }

  function parseAmountValue(value) {
    if (typeof value === 'number') return value;
    const cleaned = String(value || '').replace(/[^0-9.-]/g, '');
    const n = Number(cleaned);
    return Number.isNaN(n) ? 0 : n;
  }

  function normalizeTypeValue(value) {
    const raw = String(value || '').toLowerCase();
    if (raw.includes('ing')) return 'ingreso';
    if (raw.includes('gas')) return 'gasto';
    return '';
  }

  function resolveOwnerFromRow(row) {
    const ownerIdRaw = normalizeRowValue(row, [
      'usuarioid',
      'usuario id',
      'ownerid',
      'owner id',
      'user id',
      'userid',
    ]);
    const ownerEmailRaw = normalizeRowValue(row, [
      'usuarioemail',
      'usuario email',
      'owneremail',
      'owner email',
      'user email',
      'email',
      'correo',
    ]);
    const ownerNameRaw = normalizeRowValue(row, ['usuario', 'user', 'nombre']);

    const ownerId = String(ownerIdRaw || '').trim();
    const ownerEmail = String(ownerEmailRaw || '')
      .trim()
      .toLowerCase();
    const ownerName = String(ownerNameRaw || '')
      .trim()
      .toLowerCase();

    let owner = (ownerId && usersList.find((u) => u.id === ownerId)) || null;
    if (!owner && ownerEmail) {
      owner = usersList.find(
        (u) => String(u.email || '').toLowerCase() === ownerEmail,
      );
    }
    if (!owner && ownerName) {
      owner = usersList.find(
        (u) => String(u.name || '').toLowerCase() === ownerName,
      );
    }
    return owner || activeUser || null;
  }

  function extractDebtQuotaIdsFromMeta(meta) {
    const ids = Array.isArray(meta?.debtQuotaIds)
      ? meta.debtQuotaIds
      : meta?.debtQuotaId
      ? [meta.debtQuotaId]
      : [];
    return Array.from(
      new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)),
    );
  }

  function getDebtExcelFields(tx) {
    const meta = tx?.meta || {};
    const quotaIds = extractDebtQuotaIdsFromMeta(meta);
    const quotaRows = quotaIds
      .map((id) => debtExcelOptions.quotasById.get(id))
      .filter(Boolean);
    const debtIds = Array.from(
      new Set(
        quotaRows
          .map((q) => q.debtId)
          .concat(String(meta.debtId || '').trim())
          .filter(Boolean),
      ),
    );
    const debtNames = Array.from(
      new Set(
        quotaRows
          .map((q) => q.debtName)
          .concat(String(meta.debtName || '').trim())
          .filter(Boolean),
      ),
    );
    return {
      debtName: debtNames.join('; '),
      quotaLabel: quotaRows.map((q) => q.label).join('; '),
      debtId: debtIds.join('; '),
      quotaId: quotaIds.join('; '),
    };
  }

  function splitExcelMultiValue(value) {
    return String(value || '')
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function resolveDebtSelectionFromRow({
    rawDebtId,
    rawDebtName,
    rawQuotaId,
    rawQuotaLabel,
  }) {
    const quotaIds = [];
    const debtIdMap = {};
    let selectedDebtId = '';
    let selectedDebtName = '';

    const quotaLabels = splitExcelMultiValue(rawQuotaLabel);
    quotaLabels.forEach((label) => {
      const quota = debtExcelOptions.quotasByLabel.get(label.toLowerCase());
      if (!quota) return;
      if (!quotaIds.includes(quota.id)) quotaIds.push(quota.id);
      debtIdMap[quota.id] = quota.debtId;
      selectedDebtId = selectedDebtId || quota.debtId;
      selectedDebtName = selectedDebtName || quota.debtName;
    });

    if (!quotaIds.length) {
      splitExcelMultiValue(rawQuotaId).forEach((id) => {
        const quota = debtExcelOptions.quotasById.get(id);
        if (!quota) return;
        quotaIds.push(quota.id);
        debtIdMap[quota.id] = quota.debtId;
        selectedDebtId = selectedDebtId || quota.debtId;
        selectedDebtName = selectedDebtName || quota.debtName;
      });
    }

    const debtNames = splitExcelMultiValue(rawDebtName);
    debtNames.forEach((name) => {
      const debt = debtExcelOptions.debtsByName.get(name.toLowerCase());
      if (!debt) return;
      selectedDebtId = selectedDebtId || debt.id;
      selectedDebtName = selectedDebtName || debt.name || 'Deuda';
    });

    if (!selectedDebtId && !debtNames.length) {
      splitExcelMultiValue(rawDebtId).forEach((id) => {
        const debt = debtExcelOptions.debtsById.get(id);
        if (!debt) return;
        selectedDebtId = selectedDebtId || debt.id;
        selectedDebtName = selectedDebtName || debt.name || 'Deuda';
      });
    }

    return {
      quotaIds: Array.from(new Set(quotaIds)),
      debtIdMap,
      debtId: selectedDebtId,
      debtName: selectedDebtName,
    };
  }

  function buildDebtQuotaAmountMapFromIds(totalAmount, quotaIds) {
    const ids = Array.isArray(quotaIds) ? quotaIds : [];
    const safeTotal = Math.round(Number(totalAmount || 0));
    if (!ids.length || safeTotal <= 0) return null;
    if (ids.length === 1) return { [ids[0]]: safeTotal };

    const weights = {};
    ids.forEach((id) => {
      const quota = debtExcelOptions.quotasById.get(id);
      const remaining = Number(quota?.remaining || quota?.planned || 0);
      weights[id] = Math.max(Math.round(remaining), 0);
    });
    const weightSum = Object.values(weights).reduce(
      (sum, value) => sum + value,
      0,
    );
    const allocations = {};
    if (weightSum > 0) {
      const raw = ids.map((id) => ({
        id,
        raw: (Number(weights[id] || 0) / weightSum) * safeTotal,
      }));
      const floors = raw.map((item) => ({
        id: item.id,
        value: Math.floor(item.raw),
        frac: item.raw - Math.floor(item.raw),
      }));
      let remainder =
        safeTotal - floors.reduce((sum, item) => sum + item.value, 0);
      floors.sort((a, b) => b.frac - a.frac);
      for (let i = 0; i < floors.length && remainder > 0; i += 1) {
        floors[i].value += 1;
        remainder -= 1;
      }
      floors.forEach((item) => {
        allocations[item.id] = item.value;
      });
      return allocations;
    }

    const base = Math.floor(safeTotal / ids.length);
    let remainder = safeTotal - base * ids.length;
    ids.forEach((id) => {
      allocations[id] = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
    });
    return allocations;
  }

  function applyDebtMeta(meta, debtSelection, amount) {
    const nextMeta = meta && typeof meta === 'object' ? { ...meta } : {};
    const quotaIds = debtSelection?.quotaIds || [];
    if (quotaIds.length) {
      nextMeta.debtQuotaIds = quotaIds;
      if (quotaIds.length === 1) {
        nextMeta.debtQuotaId = quotaIds[0];
        delete nextMeta.debtQuotaAmounts;
      } else {
        delete nextMeta.debtQuotaId;
        const allocationMap = buildDebtQuotaAmountMapFromIds(amount, quotaIds);
        if (allocationMap) nextMeta.debtQuotaAmounts = allocationMap;
        else delete nextMeta.debtQuotaAmounts;
      }
      nextMeta.debtQuotaDebtIds = debtSelection.debtIdMap || {};
      if (debtSelection.debtId) nextMeta.debtId = debtSelection.debtId;
      else delete nextMeta.debtId;
      if (debtSelection.debtName) {
        nextMeta.debtName = debtSelection.debtName;
        nextMeta.budgetSubcategoryName = debtSelection.debtName;
      } else {
        delete nextMeta.debtName;
        nextMeta.budgetSubcategoryName = 'pago de deudas';
      }
      delete nextMeta.budgetSubcategoryNames;
      delete nextMeta.budgetSubcategoryIds;
      delete nextMeta.budgetSubcategoryAmounts;
      delete nextMeta.budgetSubcategoryId;
      return nextMeta;
    }

    delete nextMeta.debtQuotaIds;
    delete nextMeta.debtQuotaId;
    delete nextMeta.debtQuotaAmounts;
    delete nextMeta.debtQuotaDebtIds;
    if (debtSelection?.debtId) nextMeta.debtId = debtSelection.debtId;
    else delete nextMeta.debtId;
    if (debtSelection?.debtName) {
      nextMeta.debtName = debtSelection.debtName;
      nextMeta.budgetSubcategoryName = debtSelection.debtName;
    } else {
      delete nextMeta.debtName;
      nextMeta.budgetSubcategoryName = 'pago de deudas';
    }
    delete nextMeta.budgetSubcategoryNames;
    delete nextMeta.budgetSubcategoryIds;
    delete nextMeta.budgetSubcategoryAmounts;
    delete nextMeta.budgetSubcategoryId;
    return nextMeta;
  }

  async function handleExportExcel() {
    if (!canExport) return;
    try {
      await loadExcelLibs();
    } catch (err) {
      console.error('No se pudo cargar el exportador de Excel', { message: err?.message });
      toast.error('No se pudo preparar el Excel. Revisa tu conexión.');
      return;
    }
    const excelCategories = categoryOptions.includes(incomeCategoryLabel)
      ? categoryOptions
      : [incomeCategoryLabel, ...categoryOptions];
    const headers = [
      'Id',
      'Fecha',
      'Tipo',
      'Categoria',
      'Subcategoria',
      'CuentaDeuda',
      'CuotaDeuda',
      'Descripcion',
      'Monto',
      'Usuario',
      'UsuarioId',
      'DeudaId',
      'CuotaDeudaId',
    ];
    const exportRows = [...filtered].sort((a, b) => {
      const aKey = getTransactionSortKey(a);
      const bKey = getTransactionSortKey(b);
      if (aKey.dayKey !== bKey.dayKey) {
        return aKey.dayKey < bKey.dayKey ? -1 : 1;
      }
      if (aKey.createdTime !== bKey.createdTime) {
        return aKey.createdTime - bKey.createdTime;
      }
      return 0;
    });
    const rows = exportRows.map((tx) => {
      const debtFields = getDebtExcelFields(tx);
      return [
        tx.id || '',
        txDateKey(tx),
        tx.type === 'ingreso' ? 'Ingreso' : tx.type === 'gasto' ? 'Gasto' : '',
        tx.type === 'ingreso' ? incomeCategoryLabel : tx.category || '',
        getSubcategoryLabel(tx),
        debtFields.debtName,
        debtFields.quotaLabel,
        tx.description || '',
        Number(tx.amount || 0),
        tx.ownerName || getOwnerName(tx),
        tx.ownerId || '',
        debtFields.debtId,
        debtFields.quotaId,
      ];
    });

    const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    sheet['!rows'] = [{ hpt: 20 }];

    if (sheet['!ref']) {
      const range = XLSX.utils.decode_range(sheet['!ref']);
      range.e.c = Math.max(range.e.c, headers.length - 1);
      range.e.r = Math.max(range.e.r, rows.length + 1);
      sheet['!ref'] = XLSX.utils.encode_range(range);
    }
    sheet['!cols'] = headers.map((header) => {
      if (
        header === 'UsuarioId' ||
        header === 'Id' ||
        header === 'DeudaId' ||
        header === 'CuotaDeudaId'
      ) {
        return { hidden: true };
      }
      if (header === 'Descripcion') {
        return { wch: 36 };
      }
      if (header === 'Categoria') {
        return { wch: 24 };
      }
      if (header === 'Subcategoria') {
        return { wch: 24 };
      }
      if (header === 'CuentaDeuda') {
        return { wch: 28 };
      }
      if (header === 'CuotaDeuda') {
        return { wch: 48 };
      }
      return { wch: 16 };
    });

    const categoriesSheet = XLSX.utils.aoa_to_sheet([
      ['Categorias'],
      ...excelCategories.map((c) => [c]),
    ]);
    categoriesSheet['!protect'] = { password: 'finanzas-password-control' };
    const usersForExcel = usersList
      .map((u) => u.name || u.email || '')
      .filter(Boolean);
    const uniqueUsers = [...new Set(usersForExcel)];
    const usersSheet = XLSX.utils.aoa_to_sheet([
      ['Usuarios'],
      ...uniqueUsers.map((u) => [u]),
    ]);
    usersSheet['!protect'] = { password: 'finanzas-password-control' };
    const typesSheet = XLSX.utils.aoa_to_sheet([
      ['Tipos'],
      ['Ingreso'],
      ['Gasto'],
    ]);
    typesSheet['!protect'] = { password: 'finanzas-password-control' };
    const debtsSheet = XLSX.utils.aoa_to_sheet([
      ['CuentaDeuda', 'DeudaId'],
      ...debtExcelOptions.debtRows.map((d) => [d.name, d.id]),
    ]);
    debtsSheet['!protect'] = { password: 'finanzas-password-control' };
    const debtQuotasSheet = XLSX.utils.aoa_to_sheet([
      [
        'CuotaDeuda',
        'CuotaDeudaId',
        'CuentaDeuda',
        'DeudaId',
        'Periodo',
        'Vencimiento',
        'Planificado',
        'Pendiente',
      ],
      ...debtExcelOptions.quotaRows.map((q) => [
        q.label,
        q.id,
        q.debtName,
        q.debtId,
        q.periodKey,
        q.dueDate,
        q.planned,
        q.remaining,
      ]),
    ]);
    debtQuotasSheet['!protect'] = {
      password: 'finanzas-password-control',
    };
    const usedRangeNames = new Set();
    const subcategoryColumns = [];
    const subcategoryMapRows = [['Categoria', 'Rango']];
    excelCategories.forEach((cat) => {
      const safeName = toExcelName(cat, usedRangeNames);
      subcategoryMapRows.push([cat, safeName]);
      const list = subcategoryMap.byCategory.get(cat) || [];
      const values = list.map((sub) => sub.name).filter(Boolean);
      if (!values.length) values.push('');
      subcategoryColumns.push([safeName, ...values]);
    });
    const subcategoryRows = subcategoryColumns.length
      ? Array.from(
          {
            length: Math.max(...subcategoryColumns.map((col) => col.length)),
          },
          (_, rowIndex) => subcategoryColumns.map((col) => col[rowIndex] || ''),
        )
      : [['CAT_1'], ['']];
    const subcategoriesSheet = XLSX.utils.aoa_to_sheet(subcategoryRows);
    subcategoriesSheet['!protect'] = {
      password: 'finanzas-password-control',
    };
    const subcategoryMapSheet = XLSX.utils.aoa_to_sheet(subcategoryMapRows);
    subcategoryMapSheet['!protect'] = {
      password: 'finanzas-password-control',
    };
    const controlSheet = XLSX.utils.aoa_to_sheet([
      ['ProyectoId', projectId || ''],
      ['Generado', new Date().toISOString()],
    ]);
    controlSheet['!protect'] = { password: 'finanzas-password-control' };

    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Movimientos');
    XLSX.utils.book_append_sheet(book, categoriesSheet, 'Categorias');
    XLSX.utils.book_append_sheet(book, subcategoriesSheet, 'Subcategorias');
    XLSX.utils.book_append_sheet(book, subcategoryMapSheet, 'SubcatMap');
    XLSX.utils.book_append_sheet(book, usersSheet, 'Usuarios');
    XLSX.utils.book_append_sheet(book, typesSheet, 'Tipos');
    XLSX.utils.book_append_sheet(book, debtsSheet, 'Deudas');
    XLSX.utils.book_append_sheet(book, debtQuotasSheet, 'CuotasDeuda');
    XLSX.utils.book_append_sheet(book, controlSheet, 'Control');
    const namedRanges = subcategoryColumns.map((col, index) => {
      const rangeName = col[0];
      const colLetter = columnIndexToLetter(index);
      const endRow = Math.max(col.length, 2);
      return {
        Name: rangeName,
        Ref: `Subcategorias!$${colLetter}$2:$${colLetter}$${endRow}`,
      };
    });
    book.Workbook = {
      Sheets: [
        { name: 'Movimientos' },
        { name: 'Categorias', Hidden: 1 },
        { name: 'Subcategorias', Hidden: 1 },
        { name: 'SubcatMap', Hidden: 1 },
        { name: 'Usuarios', Hidden: 1 },
        { name: 'Tipos', Hidden: 1 },
        { name: 'Deudas', Hidden: 1 },
        { name: 'CuotasDeuda', Hidden: 1 },
        { name: 'Control', Hidden: 1 },
      ],
      Names: namedRanges,
    };

    let output = XLSX.write(book, {
      bookType: 'xlsx',
      type: 'array',
      cellStyles: true,
    });

    const validations = [];
    const dateIndex = headers.indexOf('Fecha');
    const typeIndex = headers.indexOf('Tipo');
    const categoryIndex = headers.indexOf('Categoria');
    const subcategoryIndex = headers.indexOf('Subcategoria');
    const debtAccountIndex = headers.indexOf('CuentaDeuda');
    const debtQuotaIndex = headers.indexOf('CuotaDeuda');
    const amountIndex = headers.indexOf('Monto');
    const userIndex = headers.indexOf('Usuario');
    const rowStart = 2;
    const rowEnd = 1048576;

    if (dateIndex >= 0) {
      const dateCol = columnIndexToLetter(dateIndex);
      const formulaStart = escapeXml('DATE(2000,1,1)');
      const formulaEnd = escapeXml('DATE(2100,12,31)');
      validations.push(
        `<dataValidation type="date" operator="between" allowBlank="1" showErrorMessage="1" sqref="${dateCol}${rowStart}:${dateCol}${rowEnd}">` +
          `<formula1>${formulaStart}</formula1>` +
          `<formula2>${formulaEnd}</formula2>` +
          '</dataValidation>',
      );
    }

    if (typeIndex >= 0) {
      const typeCol = columnIndexToLetter(typeIndex);
      const formulaTypes = escapeXml('Tipos!$A$2:$A$3');
      validations.push(
        `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${typeCol}${rowStart}:${typeCol}${rowEnd}">` +
          `<formula1>${formulaTypes}</formula1>` +
          '</dataValidation>',
      );
    }

    if (categoryIndex >= 0 && excelCategories.length > 0) {
      const categoryCol = columnIndexToLetter(categoryIndex);
      const categoryRange = `Categorias!$A$2:$A$${excelCategories.length + 1}`;
      const formulaCategories = escapeXml(categoryRange);
      validations.push(
        `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${categoryCol}${rowStart}:${categoryCol}${rowEnd}">` +
          `<formula1>${formulaCategories}</formula1>` +
          '</dataValidation>',
      );
    }

    if (
      subcategoryIndex >= 0 &&
      subcategoryRows.length > 1 &&
      categoryIndex >= 0 &&
      subcategoryMapRows.length > 1
    ) {
      const subcategoryCol = columnIndexToLetter(subcategoryIndex);
      const mapLastRow = Math.max(subcategoryMapRows.length, 2);
      const categoryCol = columnIndexToLetter(categoryIndex);
      const formulaSubcategories = escapeXml(
        `INDIRECT(IFERROR(VLOOKUP($${categoryCol}2,SubcatMap!$A$2:$B$${mapLastRow},2,FALSE),""))`,
      );
      validations.push(
        `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${subcategoryCol}${rowStart}:${subcategoryCol}${rowEnd}">` +
          `<formula1>${formulaSubcategories}</formula1>` +
          '</dataValidation>',
      );
    }

    if (amountIndex >= 0) {
      const amountCol = columnIndexToLetter(amountIndex);
      const formulaAmount = escapeXml('0');
      validations.push(
        `<dataValidation type="whole" operator="greaterThan" allowBlank="1" showErrorMessage="1" errorTitle="Monto" error="Solo numeros sin puntos" errorStyle="stop" sqref="${amountCol}${rowStart}:${amountCol}${rowEnd}">` +
          `<formula1>${formulaAmount}</formula1>` +
          '</dataValidation>',
      );
    }

    if (userIndex >= 0 && uniqueUsers.length > 0) {
      const userCol = columnIndexToLetter(userIndex);
      const userRange = `Usuarios!$A$2:$A$${uniqueUsers.length + 1}`;
      const formulaUsers = escapeXml(userRange);
      validations.push(
        `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${userCol}${rowStart}:${userCol}${rowEnd}">` +
          `<formula1>${formulaUsers}</formula1>` +
          '</dataValidation>',
      );
    }

    if (debtAccountIndex >= 0 && debtExcelOptions.debtRows.length > 0) {
      const debtCol = columnIndexToLetter(debtAccountIndex);
      const debtRange = `Deudas!$A$2:$A$${debtExcelOptions.debtRows.length + 1}`;
      validations.push(
        `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${debtCol}${rowStart}:${debtCol}${rowEnd}">` +
          `<formula1>${escapeXml(debtRange)}</formula1>` +
          '</dataValidation>',
      );
    }

    if (debtQuotaIndex >= 0 && debtExcelOptions.quotaRows.length > 0) {
      const quotaCol = columnIndexToLetter(debtQuotaIndex);
      const quotaRange = `CuotasDeuda!$A$2:$A$${debtExcelOptions.quotaRows.length + 1}`;
      validations.push(
        `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${quotaCol}${rowStart}:${quotaCol}${rowEnd}">` +
          `<formula1>${escapeXml(quotaRange)}</formula1>` +
          '</dataValidation>',
      );
    }

    const zipped = FFLATE.unzipSync(new Uint8Array(output));
    const sheetPath = 'xl/worksheets/sheet1.xml';
    const stylesPath = 'xl/styles.xml';
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let headerStyleId = null;

    if (zipped[stylesPath]) {
      const stylesXml = decoder.decode(zipped[stylesPath]);
      const styled = appendHeaderStyle(stylesXml);
      headerStyleId = styled.styleId;
      if (styled.xml !== stylesXml) {
        zipped[stylesPath] = encoder.encode(styled.xml);
      }
    }

    if (zipped[sheetPath]) {
      let sheetXml = decoder.decode(zipped[sheetPath]);

      sheetXml = applyFreezePanes(sheetXml);
      sheetXml = applyHeaderStyleToSheet(sheetXml, headerStyleId);

      if (validations.length && !sheetXml.includes('<dataValidations')) {
        const validationXml =
          `<dataValidations count="${validations.length}">` +
          validations.join('') +
          '</dataValidations>';
        const insertBeforeTags = [
          '<hyperlinks',
          '<printOptions',
          '<pageMargins',
          '<pageSetup',
          '<headerFooter',
          '<rowBreaks',
          '<colBreaks',
          '<customProperties',
          '<cellWatches',
          '<ignoredErrors',
          '<smartTags',
          '<drawing',
          '<legacyDrawing',
          '<legacyDrawingHF',
          '<picture',
          '<oleObjects',
          '<extLst',
          '</worksheet>',
        ];

        let nextXml = '';
        for (const tag of insertBeforeTags) {
          if (!sheetXml.includes(tag)) continue;
          nextXml = sheetXml.replace(tag, `${validationXml}${tag}`);
          break;
        }

        if (!nextXml) {
          nextXml = sheetXml.replace(
            '</worksheet>',
            `${validationXml}</worksheet>`,
          );
        }

        if (nextXml !== sheetXml) {
          sheetXml = nextXml;
        }
      }

      zipped[sheetPath] = encoder.encode(sheetXml);
    }

    output = FFLATE.zipSync(zipped);

    const blob = new Blob([output], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `movimientos-${currentPeriodKey}.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function handleImportExcel(file) {
    if (!canImport || !addTransaction) return;
    if (!file) return;
    setImportError('');
    setIsImporting(true);

    try {
      await loadExcelLibs();
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array', cellDates: true });
      if (!projectId) {
        setImportError('No se pudo validar el proyecto.');
        return;
      }
      const controlSheet = workbook.Sheets?.Control;
      if (!controlSheet) {
        setImportError(
          'Solo se pueden subir Excels descargados desde la plataforma.',
        );
        return;
      }
      const controlTable = XLSX.utils.sheet_to_json(controlSheet, {
        header: 1,
        defval: '',
        blankrows: false,
      });
      const projectRow = controlTable.find(
        (row) => normalizeHeaderKey(row?.[0]) === 'proyectoid',
      );
      const fileProjectId = String(projectRow?.[1] || '').trim();
      if (!fileProjectId || fileProjectId !== projectId) {
        setImportError('El Excel no corresponde a este proyecto.');
        return;
      }
      const sheetName = workbook.SheetNames?.[0];
      if (!sheetName) {
        setImportError('El archivo no tiene hojas para importar.');
        return;
      }
      const sheet = workbook.Sheets[sheetName];
      const table = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: '',
        blankrows: false,
      });
      const [headerRow, ...dataRows] = table;
      if (!headerRow || headerRow.length === 0) {
        setImportError('El archivo no tiene encabezados.');
        return;
      }

      const allowed = new Set([
        'id',
        'fecha',
        'tipo',
        'categoria',
        'subcategoria',
        'cuentadeuda',
        'cuotadeuda',
        'descripcion',
        'monto',
        'usuario',
        'usuarioid',
        'deudaid',
        'cuotadeudaid',
        'instrucciones',
      ]);

      const headerKeys = headerRow.map((cell) => {
        const key = normalizeHeaderKey(cell);
        if (!key) return '';
        if (!allowed.has(key)) {
          setImportError(`Columna no permitida: ${String(cell || '').trim()}`);
          return null;
        }
        return key;
      });

      if (headerKeys.includes(null)) return;

      const existingMap = new Map();
      filtered.forEach((tx) => {
        if (tx.id) existingMap.set(tx.id, tx);
      });

      const missingByColumn = new Map();
      const rowsWithData = [];
      const rowsToUpdate = [];
      let fatalError = '';

      const recordMissing = (column, rowNumber) => {
        if (!missingByColumn.has(column)) {
          missingByColumn.set(column, new Set());
        }
        missingByColumn.get(column).add(rowNumber);
      };

      for (let i = 0; i < dataRows.length; i += 1) {
        const row = dataRows[i];
        const rowNumber = i + 2;
        let hasData = false;
        const rowObj = {};

        row.forEach((cell, idx) => {
          const key = headerKeys[idx] || '';
          const value = cell ?? '';
          if (!key) {
            if (String(value).trim()) {
              hasData = true;
              rowObj.__invalid = true;
            }
            return;
          }
          const isIgnored = key === 'instrucciones';
          if (String(value).trim() && !isIgnored) hasData = true;
          rowObj[key] = value;
        });

        if (!hasData) continue;
        if (rowObj.__invalid) {
          fatalError = 'Hay datos en columnas sin encabezado permitido.';
          break;
        }

        const normalized = normalizeRowKeys(rowObj);
        const rawId = normalizeRowValue(normalized, ['id']);
        const rawDate = normalizeRowValue(normalized, ['fecha', 'date']);
        const rawType = normalizeRowValue(normalized, ['tipo', 'type']);
        const rawCategory = normalizeRowValue(normalized, [
          'categoria',
          'category',
        ]);
        const rawSubcategory = normalizeRowValue(normalized, [
          'subcategoria',
          'subcat',
        ]);
        const rawDebtAccount = normalizeRowValue(normalized, [
          'cuentadeuda',
          'cuenta deuda',
          'deuda',
        ]);
        const rawDebtQuota = normalizeRowValue(normalized, [
          'cuotadeuda',
          'cuota deuda',
          'cuota',
        ]);
        const rawDescription = normalizeRowValue(normalized, [
          'descripcion',
          'description',
          'detalle',
        ]);
        const rawAmount = normalizeRowValue(normalized, [
          'monto',
          'amount',
          'valor',
        ]);
        const rawUser = normalizeRowValue(normalized, [
          'usuario',
          'user',
          'nombre',
        ]);
        const rawUserId = normalizeRowValue(normalized, [
          'usuarioid',
          'usuario id',
          'ownerid',
          'owner id',
          'user id',
          'userid',
        ]);
        const rawUserEmail = normalizeRowValue(normalized, [
          'usuarioemail',
          'usuario email',
          'owneremail',
          'owner email',
          'user email',
          'email',
          'correo',
        ]);
        const rawDebtId = normalizeRowValue(normalized, [
          'deudaid',
          'deuda id',
          'debtid',
          'debt id',
        ]);
        const rawDebtQuotaId = normalizeRowValue(normalized, [
          'cuotadeudaid',
          'cuota deuda id',
          'debtquotaid',
          'debt quota id',
        ]);

        const typeValue = normalizeTypeValue(rawType);
        const amountValue = parseAmountValue(rawAmount);
        const dateValue = normalizeDateValue(rawDate);
        const rawAmountText = String(rawAmount ?? '').trim();

        if (!dateValue) recordMissing('Fecha', rowNumber);
        if (!typeValue) recordMissing('Tipo', rowNumber);
        if (!amountValue || amountValue <= 0) recordMissing('Monto', rowNumber);
        if (rawAmountText && /[.,]/.test(rawAmountText)) {
          recordMissing('Monto', rowNumber);
        }
        if (amountValue && !Number.isInteger(amountValue)) {
          recordMissing('Monto', rowNumber);
        }

        const categoryValue = String(rawCategory || '').trim();
        const subcategoryValue = String(rawSubcategory || '').trim();
        const categoryValueKey = categoryValue.toLowerCase();
        const isIncomeRow = typeValue === 'ingreso';
        const isIncomeCategoryValue = categoryValueKey === incomeCategoryKey;
        const normalizedCategoryValue = isIncomeRow ? '' : categoryValue;
        const normalizedSubcategoryValue = isIncomeRow ? '' : subcategoryValue;

        const requiresCategory = typeValue === 'gasto';
        if (requiresCategory && !categoryValue) {
          recordMissing('Categoria', rowNumber);
        }
        if (categoryValue) {
          const isAllowedExpense = categoryOptions.includes(categoryValue);
          const isAllowedIncome = isIncomeRow && isIncomeCategoryValue;
          if (!isAllowedExpense && !isAllowedIncome) {
            fatalError = `Categoria no valida: ${categoryValue}`;
            break;
          }
        }

        const owner = resolveOwnerFromRow(normalized);
        const hasUserInput = String(
          rawUserId || rawUserEmail || rawUser || '',
        ).trim();
        if (!hasUserInput || !owner) {
          recordMissing('Usuario', rowNumber);
        }

        let subcategoryId = '';
        const isDebtRow = typeValue === 'gasto' && isDebtCategory(
          normalizedCategoryValue,
        );
        if (normalizedCategoryValue && normalizedSubcategoryValue && !isDebtRow) {
          const nameMap = subcategoryMap.byCategoryName.get(
            normalizedCategoryValue,
          );
          const candidate = nameMap?.get(
            String(normalizedSubcategoryValue).toLowerCase(),
          );
          if (!candidate) {
            fatalError = `Subcategoria no valida: ${subcategoryValue}`;
            break;
          }
          subcategoryId = candidate;
        }

        const debtSelection = isDebtRow
          ? resolveDebtSelectionFromRow({
              rawDebtId,
              rawDebtName: rawDebtAccount,
              rawQuotaId: rawDebtQuotaId,
              rawQuotaLabel: rawDebtQuota,
            })
          : { quotaIds: [], debtIdMap: {}, debtId: '', debtName: '' };
        if (isDebtRow) {
          const hasDebtInput = String(
            rawDebtAccount || rawDebtQuota || rawDebtId || rawDebtQuotaId || '',
          ).trim();
          if (hasDebtInput && !debtSelection.quotaIds.length && !debtSelection.debtId) {
            fatalError = `Deuda o cuota no valida en fila ${rowNumber}`;
            break;
          }
        }

        const rowData = {
          rowNumber,
          id: String(rawId || '').trim(),
          type: typeValue,
          amount: amountValue,
          date: dateValue,
          category: normalizedCategoryValue,
          subcategory: normalizedSubcategoryValue,
          subcategoryId,
          debtSelection,
          description: String(rawDescription || '').trim(),
          owner,
        };

        if (rowData.id && existingMap.has(rowData.id)) {
          const existing = existingMap.get(rowData.id);
          const existingDate = (
            existing.date ||
            existing.createdAt ||
            ''
          ).slice(0, 10);
          const existingType = String(existing.type || '').trim();
          const existingCategory = String(existing.category || '').trim();
          const existingSubcategory = String(
            getSubcategoryLabel(existing) || '',
          )
            .trim()
            .toLowerCase();
          const existingDebtFields = getDebtExcelFields(existing);
          const existingDebtId = String(existingDebtFields.debtId || '').trim();
          const existingQuotaId = String(existingDebtFields.quotaId || '').trim();
          const rowDebtId = Array.from(
            new Set(
              [rowData.debtSelection.debtId]
                .concat(Object.values(rowData.debtSelection.debtIdMap || {}))
                .filter(Boolean),
            ),
          ).join('; ');
          const rowQuotaId = rowData.debtSelection.quotaIds.join('; ');
          const existingAmount = Math.round(Number(existing.amount || 0));
          const existingDescription = String(existing.description || '').trim();
          const existingOwnerId = String(existing.ownerId || '').trim();
          const rowOwnerId = String(rowData.owner?.id || '').trim();
          const rowSubcategory = String(rowData.subcategory || '')
            .trim()
            .toLowerCase();

          const sameOwner = !existingOwnerId || existingOwnerId === rowOwnerId;
          const sameCategory = existingCategory === rowData.category;
          const sameSubcategory =
            isDebtCategory(rowData.category) ||
            existingSubcategory === rowSubcategory ||
            (!existingSubcategory && !rowSubcategory);
          const sameDebt =
            existingDebtId === rowDebtId && existingQuotaId === rowQuotaId;
          const sameAmount = existingAmount === Math.round(rowData.amount || 0);
          const sameDescription = existingDescription === rowData.description;
          const sameType = existingType === rowData.type;
          const sameDate = existingDate === rowData.date;

          if (
            !sameOwner ||
            !sameCategory ||
            !sameSubcategory ||
            !sameDebt ||
            !sameAmount ||
            !sameDescription ||
            !sameType ||
            !sameDate
          ) {
            rowsToUpdate.push({ rowData, existing });
          }
        }

        rowsWithData.push(rowData);
      }

      if (fatalError) {
        setImportError(fatalError);
        return;
      }

      if (!rowsWithData.length) {
        setImportError('No se encontraron filas validas para importar.');
        return;
      }

      if (missingByColumn.size) {
        const parts = [];
        missingByColumn.forEach((rows, col) => {
          const list = [...rows].sort((a, b) => a - b).join(', ');
          parts.push(`${col} (filas ${list})`);
        });
        const msg =
          'Faltan datos en columnas obligatorias:\n' + parts.join('\n');
        toast.warning(msg);
        setImportError('Faltan datos en columnas obligatorias.');
        return;
      }

      let foundBlankId = false;
      const orderErrors = [];
      const unknownIds = [];

      rowsWithData.forEach((row) => {
        const hasId = !!row.id;
        if (!hasId) foundBlankId = true;
        if (foundBlankId && hasId) {
          orderErrors.push(row.rowNumber);
        }
        if (hasId && !existingMap.has(row.id)) {
          unknownIds.push(row.rowNumber);
        }
      });

      if (orderErrors.length) {
        const msg =
          'Los movimientos nuevos deben agregarse al final y con Id vacio. ' +
          `Revisa las filas: ${orderErrors.join(', ')}`;
        toast.warning(msg);
        setImportError('Orden incorrecto de filas.');
        return;
      }

      if (unknownIds.length) {
        const msg =
          'No modifiques la columna Id. Para nuevos movimientos deja Id vacio. ' +
          `Revisa las filas: ${unknownIds.join(', ')}`;
        toast.warning(msg);
        setImportError('Ids no permitidos en nuevas filas.');
        return;
      }

      const seenIds = new Set(
        rowsWithData.filter((row) => row.id).map((row) => row.id),
      );
      const missingExisting = [];
      existingMap.forEach((_, id) => {
        if (!seenIds.has(id)) missingExisting.push(id);
      });

      if (missingExisting.length) {
        const msg =
          'No se permite eliminar movimientos existentes. El Excel debe ' +
          `contener todas las filas actuales. Faltan ${missingExisting.length}.`;
        toast.warning(msg);
        setImportError('Faltan movimientos existentes.');
        return;
      }

      const toCreate = rowsWithData.filter((row) => !row.id);
      const toUpdate = rowsToUpdate;
      if (toUpdate.length > 0 && !updateTransaction) {
        setImportError('No se puede editar movimientos desde este usuario.');
        return;
      }
      if (!toCreate.length && !toUpdate.length) {
        setImportError('No hay cambios para aplicar.');
        return;
      }

      const ok = await confirmDialog(
        `Se actualizaran ${toUpdate.length} movimientos y se agregaran ${toCreate.length} movimientos nuevos.`,
      );
      if (!ok) return;

      for (const entry of toUpdate) {
        const { rowData, existing } = entry;
        const patch = {
          type: rowData.type,
          amount: Math.round(Number(rowData.amount || 0)),
          category: rowData.type === 'gasto' ? rowData.category : '',
          description: rowData.description,
          date: rowData.date || todayKey(),
          ownerId: rowData.owner?.id ?? null,
          ownerName: rowData.owner?.name ?? null,
          ownerEmail: rowData.owner?.email ?? null,
        };

        const existingMeta =
          existing?.meta && typeof existing.meta === 'object'
            ? { ...existing.meta }
            : {};
        let metaChanged = false;
        const removeMetaKeys = (keys) => {
          keys.forEach((key) => {
            if (Object.prototype.hasOwnProperty.call(existingMeta, key)) {
              delete existingMeta[key];
              metaChanged = true;
            }
          });
        };

        const isGasto = rowData.type === 'gasto';
        const isDebt = isDebtCategory(rowData.category);
        if (!isGasto || !isDebt) {
          removeMetaKeys([
            'debtQuotaId',
            'debtQuotaIds',
            'debtQuotaAmounts',
            'debtQuotaDebtIds',
            'debtId',
            'debtName',
          ]);
        }

        if (isGasto && isDebt) {
          const nextMeta = applyDebtMeta(
            existingMeta,
            rowData.debtSelection,
            rowData.amount,
          );
          Object.keys(existingMeta).forEach((key) => {
            if (!Object.is(existingMeta[key], nextMeta[key])) {
              metaChanged = true;
            }
          });
          Object.keys(nextMeta).forEach((key) => {
            if (!Object.is(existingMeta[key], nextMeta[key])) {
              metaChanged = true;
            }
          });
          Object.keys(existingMeta).forEach((key) => delete existingMeta[key]);
          Object.assign(existingMeta, nextMeta);
        } else if (isGasto && rowData.subcategoryId) {
          const nextIds = [rowData.subcategoryId];
          const nextNames = rowData.subcategory;
          if (
            String(existingMeta.budgetSubcategoryNames || '') !== nextNames ||
            JSON.stringify(existingMeta.budgetSubcategoryIds || []) !==
              JSON.stringify(nextIds)
          ) {
            metaChanged = true;
          }
          existingMeta.budgetSubcategoryIds = nextIds;
          existingMeta.budgetSubcategoryNames = nextNames;
          removeMetaKeys(['budgetSubcategoryId', 'budgetSubcategoryName']);
        } else {
          removeMetaKeys([
            'budgetSubcategoryIds',
            'budgetSubcategoryNames',
            'budgetSubcategoryId',
            'budgetSubcategoryName',
          ]);
        }

        if (metaChanged) {
          patch.meta = existingMeta;
        }

        await updateTransaction(rowData.id, patch);
      }

      for (const row of toCreate) {
        const base = {
          type: row.type,
          amount: Math.round(Number(row.amount || 0)),
          category: row.type === 'gasto' ? row.category : '',
          description: row.description,
          date: row.date || todayKey(),
          ownerId: row.owner?.id || null,
          ownerName: row.owner?.name || null,
          ownerEmail: row.owner?.email || null,
        };

        if (row.type === 'gasto' && row.subcategoryId) {
          base.meta = {
            budgetSubcategoryIds: [row.subcategoryId],
            budgetSubcategoryNames: row.subcategory,
          };
        }

        if (row.type === 'gasto' && isDebtCategory(row.category)) {
          base.meta = applyDebtMeta(
            base.meta || {},
            row.debtSelection,
            row.amount,
          );
        }

        await addTransaction({
          ...base,
          createdAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error('Error importando Excel:', err);
      setImportError('No se pudo importar el archivo.');
    } finally {
      setIsImporting(false);
    }
  }

  const descriptionPlaceholder =
    type === 'ingreso'
      ? 'Ej: sueldo, venta, bono'
      : 'Ej: supermercado, arriendo, bencina';
  const weekLabels = ['lu', 'ma', 'mi', 'ju', 'vi', 'sa', 'do'];
  const monthLabels = [
    'enero',
    'febrero',
    'marzo',
    'abril',
    'mayo',
    'junio',
    'julio',
    'agosto',
    'septiembre',
    'octubre',
    'noviembre',
    'diciembre',
  ];
  const baseMonth = calendarBaseMonth;
  const nextMonth = addMonths(calendarBaseMonth, 1);
  const baseWeeks = buildMonthMatrix(baseMonth);
  const nextWeeks = buildMonthMatrix(nextMonth);
  const hasSavedDateRange = !!filterFromDate || !!filterToDate;

  return (
    <div className="max-w-6xl mx-auto py-6 px-4 space-y-6">
      <SectionTitle
        right={
          <div className="hidden md:flex gap-2">
            <button
              type="button"
              className="px-4 py-1.5 rounded-full text-xs font-medium bg-[color:var(--primary)] text-[color:var(--primary-contrast)] hover:brightness-110 transition"
              onClick={() => startNewTransaction('ingreso')}
            >
              + Ingreso
            </button>

            <button
              type="button"
              className="px-4 py-1.5 rounded-full text-xs font-medium bg-[color:var(--danger)] text-[color:var(--primary-contrast)] hover:brightness-110 transition"
              onClick={() => startNewTransaction('gasto')}
            >
              + Gasto
            </button>
          </div>
        }
      >
        Movimientos del periodo
      </SectionTitle>
      <div className="md:hidden grid gap-2">
        <button
          type="button"
          className="w-full px-4 py-2 rounded-full text-xs font-medium bg-[color:var(--primary)] text-[color:var(--primary-contrast)] hover:brightness-110 transition"
          onClick={() => startNewTransaction('ingreso')}
        >
          + Ingreso
        </button>
        <button
          type="button"
          className="w-full px-4 py-2 rounded-full text-xs font-medium bg-[color:var(--danger)] text-[color:var(--primary-contrast)] hover:brightness-110 transition"
          onClick={() => startNewTransaction('gasto')}
        >
          + Gasto
        </button>
        <button
          type="button"
          className="w-full px-4 py-2 rounded-full text-xs font-medium border border-[color:var(--border)] text-[color:var(--text)]"
          onClick={() => setShowFiltersModal(true)}
        >
          Filtros
        </button>
      </div>

      {/* Resumen superior */}
      <div className="grid md:grid-cols-3 gap-4">
        <Card>
          <div className="text-xs uppercase text-[color:var(--text-muted)] mb-1 text-center">
            Ingresos
          </div>
          <div className="text-lg font-semibold text-center">
            <Money n={totals.ingresos} />
          </div>
        </Card>
        <Card
          className={
            isOverspent
              ? 'border-[color:var(--danger)]/30 bg-[color:var(--danger)]/15  '
              : ''
          }
        >
          <div className="text-xs uppercase text-[color:var(--text-muted)] mb-1 text-center">
            Gastos
          </div>
          <div
            className={`text-lg font-semibold text-center ${
              isOverspent ? 'text-[color:var(--danger)]' : ''
            }`}
          >
            <Money n={totals.gastos} />
          </div>
          {isOverspent && (
            <div className="text-[11px] text-[color:var(--danger)] mt-1 text-center font-semibold">
              Exceso de gastos vs presupuesto
            </div>
          )}
        </Card>
        <Card>
          <div className="flex flex-col items-center">
            <div className="text-xs uppercase text-[color:var(--text-muted)] mb-1 text-center">
              Balance a hoy
            </div>
            <div
              className={`w-full text-lg font-semibold ${
                balanceDisponible < 0
                  ? 'text-[color:var(--danger)]'
                  : 'text-[color:var(--success)]'
              }`}
            >
              <div className="grid grid-cols-[40px_minmax(0,1fr)_40px] items-center">
                <span aria-hidden="true" />
                <div className="text-center">
                  <Money n={balanceDisponible} />
                </div>
                <button
                  type="button"
                className="w-10 h-10 -translate-y-1.5 flex items-center justify-center rounded-full bg-transparent border border-transparent text-[color:var(--text-muted)] hover:text-[color:var(--text)] hover:bg-transparent"
                  style={{ borderColor: 'transparent' }}
                  data-tooltip="Calculadora del balance real (efectivo y debito)"
                  onClick={() => {
                    setShowBalanceModal(true);
                    setAdjustError('');
                  }}
                >
                  <svg
                    className="w-full h-full"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="4.5" y="3" width="15" height="18" rx="2" />
                    <rect x="7" y="5.5" width="10" height="3" rx="0.6" />
                    <line x1="7.5" y1="11" x2="9.5" y2="11" />
                    <line x1="11.25" y1="11" x2="13.25" y2="11" />
                    <line x1="15" y1="11" x2="17" y2="11" />
                    <line x1="7.5" y1="14.5" x2="9.5" y2="14.5" />
                    <line x1="11.25" y1="14.5" x2="13.25" y2="14.5" />
                    <line x1="15" y1="14.5" x2="17" y2="14.5" />
                    <line x1="7.5" y1="18" x2="9.5" y2="18" />
                    <line x1="11.25" y1="18" x2="13.25" y2="18" />
                    <line x1="15" y1="18" x2="17" y2="18" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="mt-1 w-full max-w-[240px] text-[11px] text-[color:var(--text-muted)]">
              <div className="flex items-center justify-between gap-2">
                <span>Saldo anterior</span>
                <Money n={saldoAnterior} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span>Balance periodo a hoy</span>
                <Money n={balanceDisponible - saldoAnterior} />
              </div>
              {balanceProyectado !== balanceDisponible && (
                <div className="flex items-center justify-between gap-2">
                  <span>Proyectado al cierre</span>
                  <Money n={balanceProyectado} />
                </div>
              )}
            </div>
          </div>
        </Card>
      </div>

      {/* Filtros */}
      <div className="hidden md:block">
      <Card>
        <div className="flex flex-wrap gap-3 items-center mb-4">
          <span className="text-sm font-medium">Filtros:</span>

          <select
            className="border rounded-lg px-2 py-1 text-sm"
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
          >
            <option value="todos">Todos</option>
            <option value="ingresos">Solo ingresos</option>
            <option value="gastos">Solo gastos</option>
          </select>

          <div className="relative" ref={categoryFilterRef}>
            <button
              type="button"
              className={`inline-flex items-center gap-1.5 border rounded-lg px-2.5 py-1 text-sm shrink-0 ${
                filterCategories.length
                  ? 'border-[color:var(--primary)]/30 bg-[color:var(--primary)]/15 text-[color:var(--primary)]'
                  : 'bg-[color:var(--surface-1)] text-[color:var(--text)]'
              }`}
              onClick={() => setShowCategoryFilter((prev) => !prev)}
              aria-label="Filtrar por categoria"
              aria-expanded={showCategoryFilter}
            >
              <span className="max-w-[12rem] truncate">
                {categoryFilterLabel}
              </span>
              <svg
                className={`h-4 w-4 ${
                  filterCategories.length ? 'text-[color:var(--primary)]' : 'text-[color:var(--text-muted)]'
                }`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>

            {showCategoryFilter && (
              <div className="absolute z-30 mt-2 w-64 rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-1)] shadow-[var(--shadow)] p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] uppercase text-[color:var(--text-muted)]">
                    Categorias
                  </span>
                  <button
                    type="button"
                    className="text-xs text-[color:var(--primary)] hover:text-[color:var(--primary)]"
                    onClick={() => setFilterCategories([])}
                  >
                    Todas
                  </button>
                </div>
                <div className="space-y-1 max-h-52 overflow-y-auto">
                  {categoryOptions.map((c) => {
                    const checked = filterCategories.includes(c);
                    return (
                      <label
                        key={c}
                        className="flex items-center gap-2 text-sm cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          className="rounded"
                          checked={checked}
                          onChange={() =>
                            setFilterCategories((prev) =>
                              checked
                                ? prev.filter((cat) => cat !== c)
                                : [...prev, c],
                            )
                          }
                        />
                        <span>{c}</span>
                      </label>
                    );
                  })}
                </div>
                <div className="mt-2 text-[11px] text-[color:var(--text-muted)]">
                  Puedes elegir varias.
                </div>
              </div>
            )}
          </div>

          <div className="relative" ref={subcategoryFilterRef}>
            <button
              type="button"
              className={`inline-flex items-center gap-1.5 border rounded-lg px-2.5 py-1 text-sm shrink-0 ${
                filterSubcategories.length
                  ? 'border-[color:var(--primary)]/30 bg-[color:var(--primary)]/15 text-[color:var(--primary)]'
                  : 'bg-[color:var(--surface-1)] text-[color:var(--text)]'
              }`}
              onClick={() => setShowSubcategoryFilter((prev) => !prev)}
              aria-label="Filtrar por subcategoria"
              aria-expanded={showSubcategoryFilter}
            >
              <span className="max-w-[12rem] truncate">
                {subcategoryFilterLabel}
              </span>
              <svg
                className={`h-4 w-4 ${
                  filterSubcategories.length ? 'text-[color:var(--primary)]' : 'text-[color:var(--text-muted)]'
                }`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>

            {showSubcategoryFilter && (
              <div className="absolute z-30 mt-2 w-64 rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-1)] shadow-[var(--shadow)] p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] uppercase text-[color:var(--text-muted)]">
                    Subcategorias
                  </span>
                  <button
                    type="button"
                    className="text-xs text-[color:var(--primary)] hover:text-[color:var(--primary)]"
                    onClick={() => setFilterSubcategories([])}
                  >
                    Todas
                  </button>
                </div>
                <div className="space-y-1 max-h-52 overflow-y-auto">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      className="rounded"
                      checked={filterSubcategories.includes(
                        UNBUDGETED_FILTER_VALUE,
                      )}
                      onChange={() =>
                        setFilterSubcategories((prev) =>
                          prev.includes(UNBUDGETED_FILTER_VALUE)
                            ? prev.filter(
                                (sub) => sub !== UNBUDGETED_FILTER_VALUE,
                              )
                            : [...prev, UNBUDGETED_FILTER_VALUE],
                        )
                      }
                    />
                    <span className="text-[color:var(--danger)] font-semibold">
                      {DEFAULT_UNBUDGETED_LABEL}
                    </span>
                  </label>
                  {subcategoryOptions
                    .filter(
                      (sub) => sub.toLowerCase() !== DEFAULT_UNBUDGETED_KEY,
                    )
                    .map((sub) => {
                      const checked = filterSubcategories.includes(sub);
                      return (
                        <label
                          key={sub}
                          className="flex items-center gap-2 text-sm cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            className="rounded"
                            checked={checked}
                            onChange={() =>
                              setFilterSubcategories((prev) =>
                                checked
                                  ? prev.filter((item) => item !== sub)
                                  : [...prev, sub],
                              )
                            }
                          />
                          <span>{sub}</span>
                        </label>
                      );
                    })}
                </div>
                <div className="mt-2 text-[11px] text-[color:var(--text-muted)]">
                  Puedes elegir varias.
                </div>
              </div>
            )}
          </div>

          <div className="relative" ref={dateRangeRef}>
            <button
              type="button"
              className={`inline-flex items-center gap-1.5 border rounded-lg px-2.5 py-1 text-sm shrink-0 ${
                hasSavedDateRange
                  ? 'border-[color:var(--primary)]/30 bg-[color:var(--primary)]/15 text-[color:var(--primary)]'
                  : 'bg-[color:var(--surface-1)] text-[color:var(--text)]'
              }`}
              onClick={() => setShowDateRangePicker((prev) => !prev)}
              aria-label="Seleccionar fecha o rango"
            >
              <span>Fecha</span>
              <svg
                className={`h-4 w-4 ${
                  hasSavedDateRange ? 'text-[color:var(--primary)]' : 'text-[color:var(--text-muted)]'
                }`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="3.5" y="4.5" width="17" height="16" rx="2" />
                <line x1="8" y1="2.5" x2="8" y2="6.5" />
                <line x1="16" y1="2.5" x2="16" y2="6.5" />
                <line x1="3.5" y1="9" x2="20.5" y2="9" />
              </svg>
            </button>

            {showDateRangePicker && (
              <div className="absolute z-30 mt-2 rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-1)] shadow-[var(--shadow)] p-4 w-[480px]">
                <div className="flex gap-4">
                  <div className="w-52">
                    <div className="flex items-center justify-between mb-2">
                      <button
                        type="button"
                        className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-[color:var(--surface-2)]"
                        onClick={() =>
                          setCalendarBaseMonth(addMonths(baseMonth, -1))
                        }
                        aria-label="Mes anterior"
                      >
                        <svg
                          className="h-4 w-4 text-[color:var(--text-faint)]"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <polyline points="15 18 9 12 15 6" />
                        </svg>
                      </button>
                      <span className="text-sm font-medium text-[color:var(--text)] capitalize">
                        {monthLabels[baseMonth.getMonth()]} de{' '}
                        {baseMonth.getFullYear()}
                      </span>
                      <button
                        type="button"
                        className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-[color:var(--surface-2)]"
                        onClick={() =>
                          setCalendarBaseMonth(addMonths(baseMonth, 1))
                        }
                        aria-label="Mes siguiente"
                      >
                        <svg
                          className="h-4 w-4 text-[color:var(--text-faint)]"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </button>
                    </div>
                    <div className="grid grid-cols-7 text-[11px] text-[color:var(--text-muted)] mb-1">
                      {weekLabels.map((label) => (
                        <span key={`base-${label}`} className="text-center">
                          {label}
                        </span>
                      ))}
                    </div>
                    <div className="grid grid-cols-7 gap-1">
                      {baseWeeks.flatMap((week, weekIndex) =>
                        week.map((day, dayIndex) => {
                          const key = `base-${weekIndex}-${dayIndex}`;
                          if (!day) {
                            return <span key={key} className="h-8 w-8" />;
                          }
                          const dateKey = formatDateKey(day);
                          const isStart = dateKey === draftFromDate;
                          const isEnd = dateKey === draftToDate;
                          const inRange =
                            draftFromDate &&
                            draftToDate &&
                            dateKey > draftFromDate &&
                            dateKey < draftToDate;
                          const className =
                            isStart || isEnd
                              ? 'bg-[color:var(--primary)] text-[color:var(--primary-contrast)]'
                              : inRange
                              ? 'bg-[color:var(--primary)]/15 text-[color:var(--primary)]'
                              : 'text-[color:var(--text)] hover:bg-[color:var(--surface-2)]';
                          return (
                            <button
                              type="button"
                              key={key}
                              className={`h-8 w-8 rounded-full text-sm flex items-center justify-center transition ${className}`}
                              onClick={() => handleDatePick(day)}
                            >
                              {day.getDate()}
                            </button>
                          );
                        }),
                      )}
                    </div>
                  </div>

                  <div className="w-52">
                    <div className="flex items-center justify-center mb-2">
                      <span className="text-sm font-medium text-[color:var(--text)] capitalize">
                        {monthLabels[nextMonth.getMonth()]} de{' '}
                        {nextMonth.getFullYear()}
                      </span>
                    </div>
                    <div className="grid grid-cols-7 text-[11px] text-[color:var(--text-muted)] mb-1">
                      {weekLabels.map((label) => (
                        <span key={`next-${label}`} className="text-center">
                          {label}
                        </span>
                      ))}
                    </div>
                    <div className="grid grid-cols-7 gap-1">
                      {nextWeeks.flatMap((week, weekIndex) =>
                        week.map((day, dayIndex) => {
                          const key = `next-${weekIndex}-${dayIndex}`;
                          if (!day) {
                            return <span key={key} className="h-8 w-8" />;
                          }
                          const dateKey = formatDateKey(day);
                          const isStart = dateKey === draftFromDate;
                          const isEnd = dateKey === draftToDate;
                          const inRange =
                            draftFromDate &&
                            draftToDate &&
                            dateKey > draftFromDate &&
                            dateKey < draftToDate;
                          const className =
                            isStart || isEnd
                              ? 'bg-[color:var(--primary)] text-[color:var(--primary-contrast)]'
                              : inRange
                              ? 'bg-[color:var(--primary)]/15 text-[color:var(--primary)]'
                              : 'text-[color:var(--text)] hover:bg-[color:var(--surface-2)]';
                          return (
                            <button
                              type="button"
                              key={key}
                              className={`h-8 w-8 rounded-full text-sm flex items-center justify-center transition ${className}`}
                              onClick={() => handleDatePick(day)}
                            >
                              {day.getDate()}
                            </button>
                          );
                        }),
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex justify-between items-center mt-3 text-xs">
                  <div className="flex gap-3">
                    <button
                      type="button"
                      className="text-[color:var(--primary)] hover:text-[color:var(--primary)]"
                      onClick={() => {
                        setFilterFromDate(draftFromDate);
                        setFilterToDate(draftToDate);
                        setShowDateRangePicker(false);
                      }}
                    >
                      Guardar
                    </button>
                    <button
                      type="button"
                      className="text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                      onClick={() => {
                        setDraftFromDate('');
                        setDraftToDate('');
                        setFilterFromDate('');
                        setFilterToDate('');
                      }}
                    >
                      Limpiar
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          <select
            className="border rounded-lg px-2 py-1 text-sm"
            value={filterUserId}
            onChange={(e) => setFilterUserId(e.target.value)}
          >
            <option value="todos">Todos los usuarios</option>
            {usersList.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || u.email || 'Usuario'}
              </option>
            ))}
          </select>
        </div>
      </Card>
      </div>

      {bankInboxItems.length > 0 && canImport && (
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 rounded-xl border border-[color:var(--success)]/30 bg-[color:var(--success)]/15 px-4 py-3 text-left text-sm text-[color:var(--success)] transition hover:bg-[color:var(--success)]/20"
          onClick={() => setShowGmailModal(true)}
        >
          <span>
            {bankInboxItems.length === 1
              ? 'Llegó 1 aviso del banco. ¿Dónde lo cargamos?'
              : `Llegaron ${bankInboxItems.length} avisos del banco. ¿Dónde los cargamos?`}
          </span>
          <span className="shrink-0 font-medium">Revisar</span>
        </button>
      )}

      {/* Tabla de movimientos */}
      <Card>
        <div className="flex justify-between items-center mb-3">
          <div className="flex items-center gap-3">
            <h3 className="font-semibold">Listado de movimientos</h3>
            <button
              type="button"
              className="h-8 w-8 flex items-center justify-center rounded-lg border border-[color:var(--success)]/30 bg-[color:var(--success)]/15 text-[color:var(--success)] hover:text-[color:var(--success)] hover:border-[color:var(--success)]/40 hover:bg-[color:var(--success)]/20 transition"
              onClick={openExcelModal}
              data-tooltip="Excel"
              aria-label="Excel"
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" />
                <path d="M9.5 14.5l5-5" />
                <path d="M14.5 14.5l-5-5" />
              </svg>
            </button>
            <button
              type="button"
              className="h-8 rounded-lg border border-[color:var(--success)]/30 bg-[color:var(--success)]/15 px-2 text-xs font-medium text-[color:var(--success)] transition hover:border-[color:var(--success)]/40 hover:bg-[color:var(--success)]/20 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => setShowGmailModal(true)}
              disabled={!canImport || !householdId}
              data-tooltip="Avisos del banco"
              aria-label={
                bankInboxItems.length
                  ? `Avisos del banco: ${bankInboxItems.length} por revisar`
                  : 'Avisos del banco'
              }
            >
              Gmail{bankInboxItems.length ? ` · ${bankInboxItems.length}` : ''}
            </button>
          </div>
          <span className="text-xs text-[color:var(--text-muted)]">
            {filtered.length} movimiento{filtered.length === 1 ? '' : 's'}
          </span>
        </div>

        {filtered.length === 0 ? (
          <div className="text-sm text-[color:var(--text-muted)]">
            No hay movimientos para el periodo y filtros seleccionados.
          </div>
        ) : (
          <>
            <div className="md:hidden">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-[color:var(--text-muted)]">
                    <th className="px-2 py-2 text-left">Subgasto</th>
                    <th className="px-2 py-2 text-right">Editar</th>
                    <th className="px-2 py-2 text-right">Eliminar</th>
                    <th className="px-2 py-2 text-right">Info</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((tx) => {
                    const isDefaultUnbudgeted = isDefaultUnbudgetedTx(tx);
                    const subcategoryLabel = getSubcategoryLabel(tx);
                    const displaySubcategory = isDefaultUnbudgeted
                      ? DEFAULT_UNBUDGETED_LABEL
                      : subcategoryLabel;
                    return (
                      <tr key={tx.id} className="border-b last:border-0">
                        <td className="px-2 py-2 align-top">
                          {displaySubcategory ? (
                            <span
                              className={
                                isDefaultUnbudgeted
                                  ? 'text-[color:var(--danger)] font-semibold'
                                  : ''
                              }
                            >
                              {displaySubcategory}
                            </span>
                          ) : (
                            <span className="text-[color:var(--text-faint)]">-</span>
                          )}
                        </td>
                        <td className="px-2 py-2 align-top text-right">
                          {updateTransaction ? (
                            <button
                              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[color:var(--divider)] text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                              aria-label="Editar movimiento"
                              onClick={() => startEditTransaction(tx)}
                            >
                              <svg
                                className="h-4 w-4"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <path d="M16.862 4.487a1.5 1.5 0 1 1 2.121 2.121L7.5 18.09l-4.5.9.9-4.5 12.962-12.003z" />
                              </svg>
                            </button>
                          ) : (
                            <span className="text-[color:var(--text-faint)]">-</span>
                          )}
                        </td>
                        <td className="px-2 py-2 align-top text-right">
                          {removeTransaction ? (
                            <button
                              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[color:var(--divider)] text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                              aria-label="Eliminar movimiento"
                              onClick={() => {
                                confirmRemoveTransaction(tx);
                              }}
                            >
                              <svg
                                className="h-4 w-4"
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
                                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                <path d="M10 11v6" />
                                <path d="M14 11v6" />
                              </svg>
                            </button>
                          ) : (
                            <span className="text-[color:var(--text-faint)]">-</span>
                          )}
                        </td>
                        <td className="px-2 py-2 align-top text-right">
                          <button
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[color:var(--divider)] text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                            aria-label="Ver detalle del movimiento"
                            onClick={() => setInfoTx(tx)}
                          >
                            i
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="hidden md:block overflow-x-auto -mx-2">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-[color:var(--text-muted)]">
                    <th className="px-2 py-1 text-left">Fecha</th>
                    <th className="px-2 py-1 text-left">Descripcion</th>
                    <th className="px-2 py-1 text-left">Categoria</th>
                    <th className="px-2 py-1 text-left">Subgasto</th>
                    <th className="px-2 py-1 text-left">Tipo</th>
                    <th className="px-2 py-1 text-right">Monto</th>
                    <th className="px-2 py-1 text-left">Usuario</th>
                    <th className="px-2 py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((tx) => {
                    const isDefaultUnbudgeted = isDefaultUnbudgetedTx(tx);
                    const subcategoryLabel = getSubcategoryLabel(tx);
                    const displaySubcategory = isDefaultUnbudgeted
                      ? DEFAULT_UNBUDGETED_LABEL
                      : subcategoryLabel;
                    return (
                      <tr
                        key={tx.id}
                        className="border-b last:border-0"
                        onContextMenu={(event) => openContextMenu(tx, event)}
                      >
                        <td className="px-2 py-1 align-top">
                          {(tx.date || '').slice(0, 10)}
                        </td>
                        <td className="px-2 py-1 align-top">
                          {tx.description || (
                            <span className="text-[color:var(--text-faint)]">-</span>
                          )}
                        </td>
                        <td className="px-2 py-1 align-top">
                          <div
                            className={isDefaultUnbudgeted ? 'text-[color:var(--danger)]' : ''}
                          >
                            {tx.category || (
                              <span className="text-[color:var(--text-faint)]">-</span>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-1 align-top">
                          {displaySubcategory ? (
                            <span
                              className={
                                isDefaultUnbudgeted
                                  ? 'text-[color:var(--danger)] font-semibold'
                                  : ''
                              }
                            >
                              {displaySubcategory}
                            </span>
                          ) : (
                            <span className="text-[color:var(--text-faint)]">-</span>
                          )}
                        </td>
                        <td className="px-2 py-1 align-top">
                          {tx.type === 'ingreso' ? 'Ingreso' : 'Gasto'}
                        </td>
                        <td className="px-2 py-1 align-top text-right">
                          <Money n={tx.amount} />
                        </td>
                        <td className="px-2 py-1 align-top text-xs text-[color:var(--text-muted)]">
                          {getOwnerName(tx)}
                          {txAccountLabel(tx) && (
                            <div className="text-[color:var(--text-faint)]">{txAccountLabel(tx)}</div>
                          )}
                        </td>
                        <td className="px-2 py-1 align-top text-right">
                          <div className="flex justify-end gap-3 text-xs">
                            {updateTransaction && (
                              <button
                                className="text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                                aria-label="Editar movimiento"
                                data-tooltip="Editar movimiento"
                                onClick={() => startEditTransaction(tx)}
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
                                  <path d="M16.862 4.487a1.5 1.5 0 1 1 2.121 2.121L7.5 18.09l-4.5.9.9-4.5 12.962-12.003z" />
                                </svg>
                              </button>
                            )}
                            {removeTransaction && (
                              <button
                                className="text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                                aria-label="Eliminar movimiento"
                                data-tooltip="Eliminar movimiento"
                                onClick={() => {
                                  confirmRemoveTransaction(tx);
                                }}
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
                                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                  <path d="M10 11v6" />
                                  <path d="M14 11v6" />
                                </svg>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      {contextMenu && (
        <div
          className="fixed z-50 w-48 rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-1)] shadow-[var(--shadow)]"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="px-3 py-2 text-xs font-semibold text-[color:var(--text-faint)] border-b">
            Acciones
          </div>
          <div className="p-1">
            {updateTransaction && (
              <button
                type="button"
                className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-[color:var(--surface-2)] transition active:scale-[0.98]"
                onClick={() => {
                  const target = contextMenu.tx;
                  closeContextMenu();
                  startEditTransaction(target);
                }}
              >
                Editar
              </button>
            )}
            {removeTransaction && (
              <button
                type="button"
                className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-[color:var(--surface-2)] transition active:scale-[0.98]"
                onClick={() => {
                  const target = contextMenu.tx;
                  closeContextMenu();
                  confirmRemoveTransaction(target);
                }}
              >
                Eliminar
              </button>
            )}
            {addTransaction && (
              <button
                type="button"
                className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-[color:var(--surface-2)] transition active:scale-[0.98]"
                onClick={() => {
                  const target = contextMenu.tx;
                  closeContextMenu();
                  duplicateTransaction(target);
                }}
              >
                Duplicar
              </button>
            )}
          </div>
        </div>
      )}

      {infoTx &&
        (() => {
          const isDefaultUnbudgeted = isDefaultUnbudgetedTx(infoTx);
          const subcategoryLabel = getSubcategoryLabel(infoTx);
          const displaySubcategory = isDefaultUnbudgeted
            ? DEFAULT_UNBUDGETED_LABEL
            : subcategoryLabel;
          const infoCategory = infoTx.category || '-';
          const infoDescription = infoTx.description || 'Sin descripcion';
          const infoDate = (infoTx.date || '').slice(0, 10) || '-';
          return (
            <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 backdrop-blur-sm pt-16 px-4">
              <div className="bg-[color:var(--surface-1)] rounded-2xl shadow-[var(--shadow)] p-5 w-full max-w-lg">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold">Detalle del movimiento</h3>
                  <button
                    type="button"
                    className="text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                    onClick={() => setInfoTx(null)}
                  >
                    Cerrar
                  </button>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <span className="text-[color:var(--text-muted)]">Fecha</span>
                    <span className="font-medium text-right">{infoDate}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-[color:var(--text-muted)]">Descripcion</span>
                    <span className="font-medium text-right">{infoDescription}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-[color:var(--text-muted)]">Categoria</span>
                    <span
                      className={`font-medium text-right ${
                        isDefaultUnbudgeted ? 'text-[color:var(--danger)]' : ''
                      }`}
                    >
                      {infoCategory}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-[color:var(--text-muted)]">Subgasto</span>
                    <span
                      className={`font-medium text-right ${
                        isDefaultUnbudgeted ? 'text-[color:var(--danger)]' : ''
                      }`}
                    >
                      {displaySubcategory || '-'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-[color:var(--text-muted)]">Tipo</span>
                    <span className="font-medium text-right">
                      {infoTx.type === 'ingreso' ? 'Ingreso' : 'Gasto'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-[color:var(--text-muted)]">Monto</span>
                    <span className="font-semibold text-right">
                      <Money n={infoTx.amount} />
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-[color:var(--text-muted)]">Usuario</span>
                    <span className="font-medium text-right">{getOwnerName(infoTx)}</span>
                  </div>
                  {txAccountLabel(infoTx) && (
                    <div className="flex justify-between gap-4">
                      <span className="text-[color:var(--text-muted)]">Cuenta</span>
                      <span className="font-medium text-right">{txAccountLabel(infoTx)}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

      {showFiltersModal && (
        <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 backdrop-blur-sm pt-16 px-4">
          <div className="bg-[color:var(--surface-1)] rounded-2xl shadow-[var(--shadow)] p-5 w-full max-w-lg">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Filtros</h3>
              <button
                type="button"
                className="text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                onClick={() => setShowFiltersModal(false)}
              >
                Cerrar
              </button>
            </div>

            <div className="space-y-4 text-sm">
              <div className="grid gap-1">
                <label className="text-xs text-[color:var(--text-muted)]">Tipo</label>
                <select
                  className="border rounded-lg px-2 py-2 text-sm"
                  value={filterType}
                  onChange={(e) => setFilterType(e.target.value)}
                >
                  <option value="todos">Todos</option>
                  <option value="ingresos">Solo ingresos</option>
                  <option value="gastos">Solo gastos</option>
                </select>
              </div>

              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase text-[color:var(--text-muted)]">
                    Categorias
                  </span>
                  <button
                    type="button"
                    className="text-xs text-[color:var(--primary)] hover:text-[color:var(--primary)]"
                    onClick={() => setFilterCategories([])}
                  >
                    Todas
                  </button>
                </div>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {categoryOptions.map((c) => {
                    const checked = filterCategories.includes(c);
                    return (
                      <label
                        key={c}
                        className="flex items-center gap-2 text-sm cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          className="rounded"
                          checked={checked}
                          onChange={() =>
                            setFilterCategories((prev) =>
                              checked
                                ? prev.filter((cat) => cat !== c)
                                : [...prev, c],
                            )
                          }
                        />
                        <span>{c}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase text-[color:var(--text-muted)]">
                    Subcategorias
                  </span>
                  <button
                    type="button"
                    className="text-xs text-[color:var(--primary)] hover:text-[color:var(--primary)]"
                    onClick={() => setFilterSubcategories([])}
                  >
                    Todas
                  </button>
                </div>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      className="rounded"
                      checked={filterSubcategories.includes(
                        UNBUDGETED_FILTER_VALUE,
                      )}
                      onChange={() =>
                        setFilterSubcategories((prev) =>
                          prev.includes(UNBUDGETED_FILTER_VALUE)
                            ? prev.filter(
                                (sub) => sub !== UNBUDGETED_FILTER_VALUE,
                              )
                            : [...prev, UNBUDGETED_FILTER_VALUE],
                        )
                      }
                    />
                    <span className="text-[color:var(--danger)] font-semibold">
                      {DEFAULT_UNBUDGETED_LABEL}
                    </span>
                  </label>
                  {subcategoryOptions
                    .filter((sub) => sub.toLowerCase() !== DEFAULT_UNBUDGETED_KEY)
                    .map((sub) => {
                      const checked = filterSubcategories.includes(sub);
                      return (
                        <label
                          key={sub}
                          className="flex items-center gap-2 text-sm cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            className="rounded"
                            checked={checked}
                            onChange={() =>
                              setFilterSubcategories((prev) =>
                                checked
                                  ? prev.filter((item) => item !== sub)
                                  : [...prev, sub],
                              )
                            }
                          />
                          <span>{sub}</span>
                        </label>
                      );
                    })}
                </div>
              </div>

              <div className="grid gap-2">
                <span className="text-xs uppercase text-[color:var(--text-muted)]">
                  Fecha (YYYY-MM-DD)
                </span>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    className="border rounded-lg px-2 py-2 text-sm"
                    type="text"
                    placeholder="Desde"
                    value={filterFromDate}
                    onChange={(e) => setFilterFromDate(e.target.value)}
                  />
                  <input
                    className="border rounded-lg px-2 py-2 text-sm"
                    type="text"
                    placeholder="Hasta"
                    value={filterToDate}
                    onChange={(e) => setFilterToDate(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid gap-1">
                <label className="text-xs text-[color:var(--text-muted)]">
                  Usuario
                </label>
                <select
                  className="border rounded-lg px-2 py-2 text-sm"
                  value={filterUserId}
                  onChange={(e) => setFilterUserId(e.target.value)}
                >
                  <option value="todos">Todos los usuarios</option>
                  {usersList.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name || u.email || 'Usuario'}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Excel */}
      {showExcelModal && (
        <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 backdrop-blur-sm pt-16 px-4">
          <div className="bg-[color:var(--surface-1)]  rounded-2xl shadow-[var(--shadow)] p-5 w-full max-w-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Excel de movimientos</h3>
              <button
                type="button"
                className="text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                onClick={closeExcelModal}
              >
                Cerrar
              </button>
            </div>
            <div className="mb-4 text-xs text-[color:var(--warning)] bg-[color:var(--warning)]/15 border border-[color:var(--warning)]/30 rounded-lg px-3 py-2">
              Solo se pueden subir Excel descargados desde la plataforma.
              Descarga el archivo, editalo y luego subelo.
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="border rounded-xl p-4 space-y-3">
                <div>
                  <h4 className="text-sm font-semibold">Descargar Excel</h4>
                  <p className="text-xs text-[color:var(--text-muted)]">
                    Descarga el listado visible.
                  </p>
                </div>
                <button
                  type="button"
                  className="w-full px-3 py-2 rounded-lg bg-[color:var(--success)] text-[color:var(--primary-contrast)] text-sm hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed"
                  onClick={handleExportExcel}
                  disabled={!canExport}
                >
                  Descargar Excel
                </button>
              </div>

              <div className="border rounded-xl p-4 space-y-3">
                <div>
                  <h4 className="text-sm font-semibold">Subir Excel</h4>
                  <p className="text-xs text-[color:var(--text-muted)]">
                    Reemplaza los movimientos visibles.
                  </p>
                </div>
                <div
                  className={`border-2 border-dashed rounded-xl p-4 text-xs flex flex-col items-center justify-center gap-2 transition ${
                    isDraggingFile
                      ? 'border-[color:var(--success)] bg-[color:var(--success)]/15 text-[color:var(--success)]'
                      : 'border-[color:var(--border)] text-[color:var(--text-muted)]'
                  } ${
                    !canImport || isImporting
                      ? 'opacity-50 cursor-not-allowed'
                      : 'cursor-pointer'
                  }`}
                  onClick={() => {
                    if (!canImport || isImporting) return;
                    fileInputRef.current?.click();
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (!canImport || isImporting) return;
                    setIsDraggingFile(true);
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    setIsDraggingFile(false);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIsDraggingFile(false);
                    if (!canImport || isImporting) return;
                    const file = e.dataTransfer.files?.[0];
                    if (!file) return;
                    handleImportExcel(file);
                  }}
                  aria-disabled={!canImport || isImporting}
                >
                  <svg
                    className="h-5 w-5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 16V4" />
                    <path d="M8 8l4-4 4 4" />
                    <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                  </svg>
                  <span>Arrastra el Excel aqui o haz clic</span>
                  <span className="text-[11px] text-[color:var(--text-faint)]">
                    .xlsx o .xls
                  </span>
                </div>
                <button
                  type="button"
                  className="w-full px-3 py-2 rounded-lg border text-sm hover:bg-[color:var(--surface-2)] disabled:opacity-60 disabled:cursor-not-allowed"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!canImport || isImporting}
                >
                  {isImporting ? 'Subiendo...' : 'Elegir archivo'}
                </button>
                {!canImport && (
                  <p className="text-xs text-[color:var(--text-muted)]">
                    Selecciona un usuario para subir movimientos.
                  </p>
                )}
                {importError && (
                  <p className="text-xs text-[color:var(--danger)]">{importError}</p>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept=".xlsx,.xls"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    handleImportExcel(file);
                    e.target.value = '';
                  }}
                  disabled={!canImport || isImporting}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {showGmailModal && (
        <GmailImportModal
          onClose={() => setShowGmailModal(false)}
          householdId={householdId}
          activeUser={activeUser}
          categories={categories}
          householdUsers={usersList}
          addTransaction={addTransaction}
          inboxItems={bankInboxItems}
          transactions={transactions}
          accounts={accounts}
        />
      )}

      {/* Modal ingreso/gasto */}
      {(showIngresoModal || showGastoModal) && (
        <div className="fixed inset-0 z-30 bg-black/30 backdrop-blur-sm overflow-y-auto">
          <div className="min-h-full flex items-start justify-center pt-12 pb-12">
            <div className="bg-[color:var(--surface-1)]  rounded-2xl shadow-[var(--shadow)] p-5 w-full max-w-xl mx-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-semibold">
                  {editingTx
                    ? 'Editar movimiento'
                    : type === 'ingreso'
                    ? 'Nuevo ingreso'
                    : 'Nuevo gasto'}
                </h3>
                <button
                  type="button"
                  className="text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                  onClick={closeTransactionModal}
                >
                  Cerrar
                </button>
              </div>

              <form onSubmit={handleAdd} className="grid gap-3">
                {accounts.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-[color:var(--text-muted)]">
                      {type === 'ingreso' ? '¿A qué cuenta entró?' : '¿De qué cuenta salió?'}
                    </label>
                    <select
                      className="border rounded-lg px-2 py-1 text-sm"
                      value={accountId}
                      onChange={(e) => setAccountId(e.target.value)}
                    >
                      <option value="">Sin indicar</option>
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {type === 'ingreso' && (
                  <>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-[color:var(--text-muted)]">Usuario</label>
                      <select
                        className="border rounded-lg px-2 py-1 text-sm"
                        value={ownerUserId}
                        onChange={(e) => {
                          setOwnerUserId(e.target.value);
                          if (!editingTx) setAccountId(defaultAccountFor(e.target.value) || accountId);
                        }}
                      >
                        {usersList.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name || u.email || 'Usuario'}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-[color:var(--text-muted)]">Monto</label>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-[color:var(--text-muted)]">$</span>
                        <input
                          type="text"
                          className="border rounded-lg px-2 py-1 text-sm flex-1 disabled:bg-[color:var(--surface-2)] disabled:text-[color:var(--text-faint)] disabled:cursor-not-allowed"
                          value={amountFormatted}
                          disabled={shouldLockAmount}
                          onChange={(e) => {
                            setAmountEditedByUser(true);
                            const raw = e.target.value;
                            const digits = raw.replace(/\D/g, '');
                            if (!digits) {
                              setAmountFormatted('');
                              setAmount('');
                              return;
                            }
                            const formatted = currencyFormatter.format(
                              Number(digits),
                            );
                            setAmountFormatted(formatted);
                            setAmount(digits);
                          }}
                          placeholder="0"
                        />
                      </div>
                      {shouldLockAmount && (
                        <span className="text-[11px] text-[color:var(--text-muted)]">
                          Monto bloqueado por multiples subcategorias.
                        </span>
                      )}
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-[color:var(--text-muted)]">Fecha</label>
                    <input
                      type="date"
                      className="border rounded-lg px-2 py-1 text-sm"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                      required
                    />
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-[color:var(--text-muted)]">
                        Descripcion
                      </label>
                      <div className="flex gap-2">
                        <input
                          className="border rounded-lg px-2 py-1 text-sm flex-1"
                          value={description}
                          onChange={(e) => setDescription(e.target.value)}
                          placeholder={descriptionPlaceholder}
                        />
                        <button
                          type="submit"
                          className="px-3 py-1.5 rounded-xl border bg-[color:var(--primary)] text-[color:var(--primary-contrast)] text-sm"
                        >
                          {editingTx ? 'Guardar cambios' : 'Agregar'}
                        </button>
                      </div>
                    </div>
                  </>
                )}

                {type === 'gasto' && (
                  <>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-[color:var(--text-muted)]">Categoria</label>
                      <select
                        className="border rounded-lg px-2 py-1 text-sm"
                        value={category}
                        onChange={(e) => {
                          setCategory(e.target.value);
                          setSelectedSubcategoryIds([]);
                          setSelectedDebtQuotaIds([]);
                          setSelectedSavingId('');
                          setAmountEditedByUser(false);
                        }}
                      >
                        {categoryOptions.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>

                    {isDebtCategory(category) ? (
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-[color:var(--text-muted)]">
                          Subcategoria (cuota del periodo)
                        </label>
                        <div className="border rounded-lg px-2 py-2 text-sm space-y-1 max-h-40 overflow-y-auto">
                          <label className="flex items-center justify-between gap-2 cursor-pointer">
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                className="rounded"
                                checked={!selectedDebtQuotaIds.length}
                                onChange={(e) => {
                                  if (!e.target.checked) return;
                                  setSelectedDebtQuotaIds([]);
                                  setAmountEditedByUser(false);
                                }}
                              />
                              <span>Sin asignar</span>
                            </div>
                            <span className="text-xs text-[color:var(--text-faint)]">-</span>
                          </label>
                          {debtQuotasForPeriod.map((q) => (
                            <label
                              key={q.id}
                              className="flex items-center justify-between gap-2 cursor-pointer"
                            >
                              <div className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  className="rounded"
                                  checked={selectedDebtQuotaIds.includes(q.id)}
                                  onChange={(e) => {
                                    setSelectedDebtQuotaIds((prev) => {
                                      if (e.target.checked) {
                                        return [...new Set([...prev, q.id])];
                                      }
                                      return prev.filter((id) => id !== q.id);
                                    });
                                    setAmountEditedByUser(false);
                                  }}
                                />
                                <span
                                  className={
                                    q.isPaid ? 'line-through text-[color:var(--text-faint)]' : ''
                                  }
                                >
                                  {q.debtName} — {q.dueDate || formPeriodLabel}{' '}
                                  {q.isPaid ? '(Pagada)' : '(Pendiente)'}
                                </span>
                              </div>
                              <span className="text-xs text-[color:var(--text-muted)]">
                                <Money n={q.remaining} />
                              </span>
                            </label>
                          ))}
                          {debtQuotasForPeriod.length === 0 && (
                            <div className="text-xs text-[color:var(--text-muted)]">
                              No hay cuotas planificadas en {formPeriodLabel}.
                            </div>
                          )}
                        </div>
                        {debtQuotasForPeriod.length > 0 && (
                          <div className="flex items-center justify-between text-xs text-[color:var(--text-muted)]">
                            <span>
                              Opcional: puedes elegir varias cuotas y el monto se
                              reparte segun el saldo pendiente.
                            </span>
                            {selectedDebtQuotaIds.length > 0 && (
                              <button
                                type="button"
                                className="text-[color:var(--primary)] hover:text-[color:var(--primary)]"
                                onClick={() => {
                                  setSelectedDebtQuotaIds([]);
                                  setAmountEditedByUser(false);
                                }}
                              >
                                Limpiar
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    ) : isSavingsCategory(category) ? (
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-[color:var(--text-muted)]">
                          Meta de ahorro (plan del periodo)
                        </label>
                        <div className="border rounded-lg px-2 py-2 text-sm space-y-1 max-h-40 overflow-y-auto">
                          <label className="flex items-center justify-between gap-2 cursor-pointer">
                            <div className="flex items-center gap-2">
                              <input
                                type="radio"
                                name="savingGoal"
                                checked={!selectedSavingId}
                                onChange={() => {
                                  setSelectedSavingId('');
                                  setAmountEditedByUser(false);
                                }}
                              />
                              <span>Sin asignar</span>
                            </div>
                            <span className="text-xs text-[color:var(--text-faint)]">-</span>
                          </label>
                          {savingsGoalsForPeriod.map((goal) => (
                            <label
                              key={goal.id}
                              className="flex items-center justify-between gap-2 cursor-pointer"
                            >
                              <div className="flex items-center gap-2">
                                <input
                                  type="radio"
                                  name="savingGoal"
                                  checked={selectedSavingId === goal.id}
                                  onChange={() => {
                                    setSelectedSavingId(goal.id);
                                    setAmountEditedByUser(false);
                                  }}
                                />
                                <span>{goal.name}</span>
                              </div>
                              <span className="text-xs text-[color:var(--text-muted)]">
                                <Money n={goal.planned} />
                              </span>
                            </label>
                          ))}
                          {savingsGoalsForPeriod.length === 0 && (
                            <div className="text-xs text-[color:var(--text-muted)]">
                              No hay metas planificadas en {formPeriodLabel}.
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-[color:var(--text-muted)]">
                          Subcategoria (presupuesto disponible:{' '}
                          <span
                            className={
                              subcategoryRemainingTotal < 0
                                ? 'text-[color:var(--danger)] font-semibold'
                                : ''
                            }
                          >
                            <Money n={subcategoryRemainingTotal} />
                          </span>
                          )
                        </label>
                        <div className="border rounded-lg px-2 py-2 text-sm space-y-1 max-h-40 overflow-y-auto">
                          {budgetSubcategories.map((sub) => {
                            const checked = selectedSubcategoryIds.includes(
                              sub.id,
                            );
                            const spent = subcategorySpentMap.get(sub.id) || 0;
                            const remaining = Number(sub.amount || 0) - spent;
                            const isPaid =
                              sub.amount > 0 && spent >= sub.amount;
                            return (
                              <label
                                key={sub.id}
                                className="flex items-center justify-between gap-2 cursor-pointer"
                              >
                                <div className="flex items-center gap-2">
                                  <input
                                    type="checkbox"
                                    className="rounded"
                                    checked={checked}
                                    onChange={(e) => {
                                      setSelectedSubcategoryIds((prev) => {
                                        if (e.target.checked) {
                                          return [
                                            ...new Set([...prev, sub.id]),
                                          ];
                                        }
                                        return prev.filter(
                                          (id) => id !== sub.id,
                                        );
                                      });
                                    }}
                                  />
                                  <span
                                    className={
                                      isPaid ? 'line-through text-[color:var(--text-faint)]' : ''
                                    }
                                  >
                                    {sub.name}
                                  </span>
                                </div>
                                <span
                                  className={`text-xs ${
                                    remaining < 0
                                      ? 'text-[color:var(--danger)]'
                                      : 'text-[color:var(--text-muted)]'
                                  }`}
                                >
                                  <Money n={remaining} />
                                </span>
                              </label>
                            );
                          })}
                          {budgetSubcategories.length === 0 && (
                            <div className="text-xs text-[color:var(--text-muted)]">
                              Esta categoria no tiene subcategorias en el
                              presupuesto del periodo.
                            </div>
                          )}
                        </div>
                        {budgetSubcategories.length > 0 && (
                          <div className="flex items-center justify-between text-xs text-[color:var(--text-muted)]">
                            <span>
                              Puedes elegir varias; se guardan separadas por ';'
                              en el movimiento.
                            </span>
                            <button
                              type="button"
                              className="text-[color:var(--primary)] hover:text-[color:var(--primary)]"
                              onClick={() => {
                                setSelectedSubcategoryIds([]);
                                setAmountEditedByUser(false);
                              }}
                            >
                              Limpiar
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-[color:var(--text-muted)]">Monto</label>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-[color:var(--text-muted)]">$</span>
                      <input
                        type="text"
                        className="border rounded-lg px-2 py-1 text-sm flex-1 disabled:bg-[color:var(--surface-2)] disabled:text-[color:var(--text-faint)] disabled:cursor-not-allowed"
                        value={amountFormatted}
                        disabled={shouldLockAmount || shouldLockDebtAmount}
                        onChange={(e) => {
                          setAmountEditedByUser(true);
                          const raw = e.target.value;
                          const digits = raw.replace(/\D/g, '');
                            if (!digits) {
                              setAmountFormatted('');
                              setAmount('');
                              return;
                            }
                            const formatted = currencyFormatter.format(
                              Number(digits),
                            );
                            setAmountFormatted(formatted);
                            setAmount(digits);
                        }}
                        placeholder="0"
                      />
                    </div>
                    {(shouldLockAmount || shouldLockDebtAmount) && (
                      <span className="text-[11px] text-[color:var(--text-muted)]">
                        {shouldLockDebtAmount
                          ? 'Monto bloqueado por multiples cuotas seleccionadas.'
                          : 'Monto bloqueado por multiples subcategorias.'}
                      </span>
                    )}
                  </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-[color:var(--text-muted)]">Fecha</label>
                    <input
                      type="date"
                      className="border rounded-lg px-2 py-1 text-sm"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                      required
                    />
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-[color:var(--text-muted)]">
                        Descripcion
                      </label>
                      <div className="flex gap-2">
                        <input
                          className="border rounded-lg px-2 py-1 text-sm flex-1"
                          value={description}
                          onChange={(e) => setDescription(e.target.value)}
                          placeholder={descriptionPlaceholder}
                        />
                        <button
                          type="submit"
                          className="px-3 py-1.5 rounded-xl border bg-[color:var(--primary)] text-[color:var(--primary-contrast)] text-sm"
                        >
                          {editingTx ? 'Guardar cambios' : 'Agregar'}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Modal calculadora de ajuste */}
      {showBalanceModal && (
        <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 backdrop-blur-sm pt-16">
          <div className="bg-[color:var(--surface-1)]  rounded-2xl shadow-[var(--shadow)] p-5 w-full max-w-2xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">
                Calculadora de ajuste de balance ({periodLabel})
              </h3>
              <button
                type="button"
                className="text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                onClick={() => {
                  setShowBalanceModal(false);
                  resetAdjustForm();
                }}
              >
                ×
              </button>
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <label className="text-xs text-[color:var(--text-muted)]">
                  Suma el efectivo actual
                </label>
                <div className="text-[11px] text-[color:var(--text-muted)]">
                  Puedes sumar montos: 1000+2000+500
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-[color:var(--text-muted)]">$</span>
                  <input
                    type="text"
                    className="border rounded-lg px-2 py-1 text-sm flex-1"
                    value={cashFormatted}
                    onChange={(e) =>
                      handleCalculatorInput(e.target.value, {
                        setFormatted: setCashFormatted,
                        setValue: setCashInput,
                      })
                    }
                    onBlur={(e) =>
                      commitCalculatorInput(e.target.value, {
                        setFormatted: setCashFormatted,
                        setValue: setCashInput,
                      })
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitCalculatorInput(e.currentTarget.value, {
                          setFormatted: setCashFormatted,
                          setValue: setCashInput,
                        });
                        e.currentTarget.blur();
                      }
                    }}
                    placeholder="0"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-xs text-[color:var(--text-muted)]">
                  Suma el debito actual
                </label>
                <div className="text-[11px] text-[color:var(--text-muted)]">
                  Puedes sumar montos: 1000+2000+500
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-[color:var(--text-muted)]">$</span>
                  <input
                    type="text"
                    className="border rounded-lg px-2 py-1 text-sm flex-1"
                    value={debitFormatted}
                    onChange={(e) =>
                      handleCalculatorInput(e.target.value, {
                        setFormatted: setDebitFormatted,
                        setValue: setDebitInput,
                      })
                    }
                    onBlur={(e) =>
                      commitCalculatorInput(e.target.value, {
                        setFormatted: setDebitFormatted,
                        setValue: setDebitInput,
                      })
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitCalculatorInput(e.currentTarget.value, {
                          setFormatted: setDebitFormatted,
                          setValue: setDebitInput,
                        });
                        e.currentTarget.blur();
                      }
                    }}
                    placeholder="0"
                  />
                </div>
              </div>
            </div>

            <div className="grid md:grid-cols-3 gap-3 mt-4">
              <div className="border rounded-lg p-3">
                <div className="text-xs text-[color:var(--text-muted)]">
                  Balance en plataforma
                </div>
                <div className="text-lg font-semibold">
                  <Money n={platformBalance} />
                </div>
              </div>
              <div className="border rounded-lg p-3">
                <div className="text-xs text-[color:var(--text-muted)]">Balance real total</div>
                <div className="text-lg font-semibold">
                  <Money n={realBalance} />
                </div>
              </div>
              <div className="border rounded-lg p-3">
                <div className="text-xs text-[color:var(--text-muted)]">Diferencia (delta)</div>
                <div
                  className={`text-lg font-semibold ${
                    delta < 0 ? 'text-[color:var(--danger)]' : 'text-[color:var(--success)]'
                  }`}
                >
                  <Money n={delta} />
                </div>
              </div>
            </div>

            <div className="mt-3 text-sm">
              {delta > 0 && (
                <p>
                  Hay <strong>mas dinero real</strong> que el balance de la
                  plataforma. Este delta se registrara como un{' '}
                  <strong>INGRESO</strong>.
                </p>
              )}
              {delta < 0 && (
                <p>
                  Hay <strong>menos dinero real</strong> que el balance de la
                  plataforma. Este delta se registrara como un{' '}
                  <strong>GASTO</strong>.
                </p>
              )}
              {delta === 0 && (
                <p>
                  No hay diferencia entre el balance real y el balance de la
                  plataforma.
                </p>
              )}
            </div>

            <div className="mt-4 border-t pt-3 grid gap-3">
              <div className="grid md:grid-cols-3 gap-3">
                <div className="flex flex-col gap-2">
                  <div className="text-xs text-[color:var(--text-muted)]">Tipo de ajuste</div>
                  <div className="flex gap-3 text-sm">
                    <label className="flex items-center gap-1">
                      <input
                        type="radio"
                        name="adjust-type"
                        value="ingreso"
                        checked={adjustType === 'ingreso'}
                        onChange={(e) => setAdjustType(e.target.value)}
                      />
                      Ingreso
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        type="radio"
                        name="adjust-type"
                        value="gasto"
                        checked={adjustType === 'gasto'}
                        onChange={(e) => setAdjustType(e.target.value)}
                      />
                      Gasto
                    </label>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="text-xs text-[color:var(--text-muted)]">Aplicar en</div>
                  <div className="flex flex-col gap-1 text-sm">
                    <label className="flex items-center gap-1">
                      <input
                        type="radio"
                        name="adjust-period"
                        value="previous"
                        checked={adjustPeriod === 'previous'}
                        onChange={(e) => setAdjustPeriod(e.target.value)}
                      />
                      Periodo anterior
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        type="radio"
                        name="adjust-period"
                        value="current"
                        checked={adjustPeriod === 'current'}
                        onChange={(e) => setAdjustPeriod(e.target.value)}
                      />
                      Periodo actual
                    </label>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <label className="text-xs text-[color:var(--text-muted)]">
                    Nota / comentario (opcional)
                  </label>
                  <input
                    className="border rounded-lg px-2 py-1 text-sm"
                    value={adjustNote}
                    onChange={(e) => setAdjustNote(e.target.value)}
                    placeholder="Ajuste de balance desde calculadora"
                  />
                </div>
              </div>
            </div>

            {adjustError && (
              <div className="text-sm text-[color:var(--danger)] mt-2">{adjustError}</div>
            )}

            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                className="px-3 py-1.5 text-sm border rounded-lg"
                onClick={() => {
                  setShowBalanceModal(false);
                  resetAdjustForm();
                }}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="px-3 py-1.5 text-sm rounded-lg text-[color:var(--primary-contrast)]"
                style={{
                  backgroundColor: delta < 0 ? 'var(--danger)' : 'var(--success)',
                  opacity: delta === 0 ? 0.5 : 1,
                }}
                disabled={delta === 0}
                onClick={handleSaveAdjustment}
              >
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}











