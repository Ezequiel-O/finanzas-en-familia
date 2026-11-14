// src/domain/assistantActions.js
// Correcciones que propone el asistente ("cuadra mis cuentas"). Gemini solo
// sugiere: aquí se valida cada propuesta contra los datos reales del hogar y se
// arma el cambio exacto. Lo que no calce se descarta (falla cerrado). Nada se
// guarda sin que la persona lo confirme en el panel.
import { DEBT_CATEGORY, SAVINGS_CATEGORY } from '../constants.js';
import { normalizeAccounts, reconciliation } from './accounts.js';
import { findSubcategoryByName, subcategoriesFor } from './categorySuggestion.js';
import { formatShortDate } from './dates.js';
import { ADJUSTMENT_CATEGORY, TRANSFER_CATEGORY, cashEffect, isAdjustment, txDateKey } from './ledger.js';
import { formatCLP } from './money.js';
import { budgetMonthKeyForDate } from '../utils/budgetPeriod.js';

export const ACTION_TYPES = Object.freeze([
  'asignar_subcategoria',
  'asignar_cuenta',
  'convertir_en_giro',
  'ajuste_balance',
]);
const MAX_ACTIONS = 30;
const SUBCATEGORY_KEYS = [
  'budgetSubcategoryIds',
  'budgetSubcategoryNames',
  'budgetSubcategoryAmounts',
  'budgetSubcategoryId',
  'budgetSubcategoryName',
];
const SPECIAL_CATEGORIES = new Set([DEBT_CATEGORY, SAVINGS_CATEGORY, TRANSFER_CATEGORY, ADJUSTMENT_CATEGORY]);

function label(t) {
  return `${formatShortDate(txDateKey(t))} · ${formatCLP(t.amount)}${
    t.description ? ` · ${String(t.description).slice(0, 60)}` : ''
  }`;
}

// Gasto común (no traspaso, ajuste, reembolso, cuota ni ahorro).
function isPlainExpense(t) {
  return (
    t?.type === 'gasto' &&
    !t?.meta?.kind &&
    !isAdjustment(t) &&
    !SPECIAL_CATEGORIES.has(t.category)
  );
}

function withoutSubcategory(meta) {
  const copy = { ...(meta || {}) };
  SUBCATEGORY_KEYS.forEach((key) => delete copy[key]);
  return copy;
}

function reason(raw) {
  return String(raw?.motivo || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function buildAction(raw, ctx) {
  const tipo = raw?.tipo;
  if (tipo === 'ajuste_balance') return { key: 'ajuste', kind: 'ajuste_balance', reason: reason(raw) };

  const t = ctx.byId.get(String(raw?.id || ''));
  if (!t) return null;
  const accountOk = (id) => ctx.accountIds.has(String(id || ''));

  if (tipo === 'asignar_subcategoria') {
    if (!isPlainExpense(t)) return null;
    const category = String(raw.categoria || t.category || '').trim();
    if (!ctx.categories.has(category) || SPECIAL_CATEGORIES.has(category)) return null;
    const periodKey = budgetMonthKeyForDate(txDateKey(t), ctx.cutDay);
    const sub = findSubcategoryByName(subcategoriesFor(ctx.budgetsAll, periodKey, category), raw.subcategoria);
    if (!sub) return null;
    return {
      key: `${t.id}:subcategoria`,
      kind: tipo,
      id: t.id,
      summary: `${label(t)} → ${category === t.category ? '' : `${category} / `}${sub.name}`,
      reason: reason(raw),
      patch: {
        category,
        meta: {
          ...withoutSubcategory(t.meta),
          budgetSubcategoryIds: [sub.id],
          budgetSubcategoryNames: sub.name,
        },
      },
    };
  }

  if (tipo === 'asignar_cuenta') {
    if (t.account || t?.meta?.kind === 'transfer' || isAdjustment(t) || cashEffect(t) === 0) return null;
    if (!accountOk(raw.cuenta)) return null;
    return {
      key: `${t.id}:cuenta`,
      kind: tipo,
      id: t.id,
      summary: `${label(t)} → cuenta ${ctx.accountName(raw.cuenta)}`,
      reason: reason(raw),
      patch: { account: raw.cuenta },
    };
  }

  if (tipo === 'convertir_en_giro') {
    if (!isPlainExpense(t)) return null;
    const from = String(raw.desde || t.account || '');
    const to = String(raw.hacia || '');
    if (!accountOk(from) || !accountOk(to) || from === to) return null;
    return {
      key: `${t.id}:giro`,
      kind: tipo,
      id: t.id,
      summary: `${label(t)} → giro ${ctx.accountName(from)} → ${ctx.accountName(to)} (deja de ser gasto)`,
      reason: reason(raw),
      patch: {
        category: TRANSFER_CATEGORY,
        account: null,
        meta: { ...withoutSubcategory(t.meta), kind: 'transfer', fromAccount: from, toAccount: to },
      },
    };
  }
  return null;
}

// Valida y normaliza lo que propuso Gemini. Una corrección por movimiento y tipo.
export function validateAssistantActions(rawActions, {
  transactions = [],
  categories = [],
  budgetsAll = {},
  cutDay = 1,
  accounts = [],
  today,
}) {
  const list = normalizeAccounts(accounts);
  const ctx = {
    byId: new Map((transactions || []).filter((t) => t?.id).map((t) => [String(t.id), t])),
    categories: new Set(categories),
    budgetsAll,
    cutDay,
    accountIds: new Set(list.map((a) => a.id)),
    accountName: (id) => list.find((a) => a.id === id)?.name || id,
  };
  const seen = new Set();
  const actions = [];
  (Array.isArray(rawActions) ? rawActions : []).slice(0, MAX_ACTIONS * 2).forEach((raw) => {
    const action = buildAction(raw, ctx);
    if (!action || seen.has(action.key)) return;
    seen.add(action.key);
    actions.push(action);
  });
  const result = actions.slice(0, MAX_ACTIONS);
  // El ajuste va al final: su monto depende de las otras correcciones.
  const adjustment = result.find((a) => a.kind === 'ajuste_balance');
  const others = result.filter((a) => a.kind !== 'ajuste_balance');
  if (adjustment) {
    const preview = balanceAdjustment(others, { transactions, accounts: list, today });
    if (!preview) return others;
    return [
      ...others,
      {
        ...adjustment,
        summary: `Ajuste de balance de ${formatCLP(Math.abs(preview.delta))} para que la app cuadre con tus cuentas (el monto se recalcula al aplicar)`,
      },
    ];
  }
  return others;
}

// Ajuste necesario después de aplicar `actions`, calculado sobre una copia.
// null si las cuentas no tienen todas su saldo real o si ya cuadra.
export function balanceAdjustment(actions, { transactions = [], accounts = [], today }) {
  const patches = new Map(
    (actions || []).filter((a) => a.patch && a.id).map((a) => [String(a.id), a.patch]),
  );
  const simulated = (transactions || []).map((t) => {
    const patch = patches.get(String(t?.id));
    return patch ? { ...t, ...patch } : t;
  });
  const check = reconciliation({ accounts: normalizeAccounts(accounts), transactions: simulated, today });
  if (!check.complete || check.delta === 0) return null;
  return {
    delta: check.delta,
    transaction: {
      type: check.delta > 0 ? 'ingreso' : 'gasto',
      amount: Math.abs(check.delta),
      category: ADJUSTMENT_CATEGORY,
      description: 'Cuadre con los saldos reales de las cuentas (asistente)',
      date: today,
      meta: {
        source: 'accounts-reconciliation',
        realBalance: check.realTotal,
        platformBalance: check.appCash,
        delta: check.delta,
      },
    },
  };
}
