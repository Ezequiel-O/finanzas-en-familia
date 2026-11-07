// src/domain/accounts.js
// Dónde está la plata del hogar: cada movimiento puede indicar la cuenta de la que
// sale o a la que entra (BancoEstado, Santander, Efectivo...). El saldo de cada
// cuenta parte de un saldo real que la persona anota ("hoy tengo X") y suma los
// movimientos registrados después.
//
// - Un movimiento con `account` afecta solo esa cuenta (según cashEffect).
// - Un traspaso entre cuentas (giro, transferencia propia) lleva
//   meta.kind = 'transfer' con meta.fromAccount y meta.toAccount: no cambia la
//   plata total del hogar, solo la mueve.
import { cashEffect, cashOnHand, isAdjustment, txDateKey } from './ledger.js';
import { toNumber } from './money.js';

export const DEFAULT_ACCOUNTS = Object.freeze([
  { id: 'bancoestado', name: 'BancoEstado', kind: 'bank', bank: 'bancoestado' },
  { id: 'santander', name: 'Santander', kind: 'bank', bank: 'santander' },
  { id: 'efectivo', name: 'Efectivo', kind: 'cash' },
]);

// Dominio del remitente del aviso → banco.
const BANK_DOMAINS = [
  { bank: 'bancoestado', pattern: /(?:^|\.)bancoestado\.cl$/i },
  { bank: 'santander', pattern: /(?:^|\.)santander\.cl$/i },
];

const ID_PATTERN = /^[a-z0-9-]{1,40}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Normaliza la lista guardada en la configuración del hogar. Sin configuración,
// usa las cuentas por defecto (sin saldo inicial ni dueño).
export function normalizeAccounts(raw) {
  const source = Array.isArray(raw) && raw.length ? raw : DEFAULT_ACCOUNTS;
  const seen = new Set();
  return source
    .map((account) => {
      const id = String(account?.id || '').trim();
      if (!ID_PATTERN.test(id) || seen.has(id)) return null;
      seen.add(id);
      const anchorDate = DATE_PATTERN.test(String(account?.anchorDate || ''))
        ? account.anchorDate
        : '';
      return {
        id,
        name: String(account?.name || id).trim().slice(0, 60) || id,
        kind: account?.kind === 'cash' ? 'cash' : 'bank',
        bank: account?.bank ? String(account.bank) : '',
        ownerId: account?.ownerId ? String(account.ownerId) : '',
        anchorBalance: anchorDate ? toNumber(account?.anchorBalance) : 0,
        anchorDate,
        anchoredAt: anchorDate ? String(account?.anchoredAt || '') : '',
      };
    })
    .filter(Boolean);
}

// Cuenta que corresponde al remitente de un aviso bancario, si hay una.
export function accountForSender(accounts, sender) {
  const domain = String(sender || '').split('@')[1] || '';
  const bank = BANK_DOMAINS.find((item) => item.pattern.test(domain))?.bank;
  if (!bank) return null;
  return (accounts || []).find((account) => account.bank === bank) || null;
}

export function isAccountTransfer(t) {
  return t?.meta?.kind === 'transfer' && !!(t.meta.fromAccount || t.meta.toAccount);
}

// Efecto de un movimiento en una cuenta: + entra, − sale, 0 no la toca.
export function accountEffect(t, accountId) {
  if (isAccountTransfer(t)) {
    const amount = toNumber(t.amount);
    if (t.meta.fromAccount === accountId) return -amount;
    if (t.meta.toAccount === accountId) return amount;
    return 0;
  }
  return t?.account === accountId ? cashEffect(t) : 0;
}

// ¿El movimiento ocurrió después de anotar el saldo real? Los del mismo día cuentan
// solo si ocurrieron después: para los importados de un aviso bancario manda la hora
// del aviso (occurredAt), no la hora en que se confirmó; para el resto, createdAt.
function afterAnchor(t, account) {
  const date = txDateKey(t);
  if (!date) return false;
  if (date !== account.anchorDate) return date > account.anchorDate;
  const created = Date.parse(String(t?.occurredAt || t?.createdAt || ''));
  const anchored = Date.parse(account.anchoredAt);
  return Number.isFinite(created) && Number.isFinite(anchored) && created > anchored;
}

// Saldo de cada cuenta a `today`. Una cuenta sin saldo inicial anotado queda con
// `configured: false` y no suma al total.
export function accountBalances({ accounts, transactions = [], today }) {
  const list = (accounts || []).map((account) => {
    if (!account.anchorDate) {
      return { ...account, balance: null, configured: false, movements: 0 };
    }
    let balance = account.anchorBalance;
    let movements = 0;
    (transactions || []).forEach((t) => {
      const effect = accountEffect(t, account.id);
      if (!effect || txDateKey(t) > today || !afterAnchor(t, account)) return;
      balance += effect;
      movements += 1;
    });
    return { ...account, balance, configured: true, movements };
  });
  const configured = list.filter((account) => account.configured);
  return {
    accounts: list,
    total: configured.reduce((sum, account) => sum + account.balance, 0),
    configuredCount: configured.length,
  };
}

// Diferencia entre la plata real (suma de las cuentas) y el saldo que calcula la app
// con todo el historial. Un ajuste de balance por `delta` deja ambos iguales:
// delta > 0 → falta registrar un ingreso; delta < 0 → falta registrar un gasto.
export function reconciliation({ accounts, transactions = [], today }) {
  const summary = accountBalances({ accounts, transactions, today });
  const appCash = cashOnHand(transactions, today);
  return {
    realTotal: summary.total,
    appCash,
    delta: summary.configuredCount ? summary.total - appCash : 0,
    complete: summary.configuredCount === (accounts || []).length,
  };
}

// Movimientos que mueven plata, registrados desde que se empezó a llevar cuentas,
// que todavía no dicen de qué cuenta salieron o a cuál entraron.
export function unassignedTransactions({ accounts, transactions = [], today }) {
  const first = (accounts || [])
    .filter((account) => account.anchorDate)
    .sort((a, b) =>
      `${a.anchorDate} ${a.anchoredAt}`.localeCompare(`${b.anchorDate} ${b.anchoredAt}`),
    )[0];
  if (!first) return [];
  return (transactions || []).filter((t) => {
    const date = txDateKey(t);
    return (
      date &&
      date <= today &&
      afterAnchor(t, first) &&
      !t?.account &&
      !isAccountTransfer(t) &&
      !isAdjustment(t) &&
      cashEffect(t) !== 0
    );
  });
}
