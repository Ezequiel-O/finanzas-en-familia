// src/domain/categorySuggestion.js
// Sugiere categoría y subcategoría para un movimiento nuevo (por ejemplo, un aviso
// bancario) a partir de cómo se clasificaron antes movimientos parecidos.
//
// Las subcategorías viven en el presupuesto de cada periodo
// (budgetsAll[periodo][categoría].breakdown) y su id puede cambiar entre periodos,
// así que entre periodos se comparan por nombre.
import { txDateKey } from './ledger.js';

const MIN_TOKEN_LENGTH = 3;
const MIN_SIMILARITY = 0.5;
const MAX_EXAMPLES = 40;

// Palabras que no distinguen un comercio de otro.
const STOPWORDS = new Set([
  'compra', 'compras', 'pago', 'pagos', 'cargo', 'cobro', 'con', 'del', 'las', 'los',
  'para', 'por', 'tarjeta', 'debito', 'credito', 'cuenta', 'cuentarut', 'rut', 'transferencia',
  'online', 'www', 'com', 'spa', 'ltda', 'chile', 'santiago', 'sucursal', 'local',
]);

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// Palabras que identifican al comercio o servicio ("Compra UNIMARC SAN JOAQUIN"
// → unimarc, san, joaquin).
export function merchantTokens(description) {
  return Array.from(
    new Set(
      normalize(description)
        .split(/[^a-z]+/)
        .filter((word) => word.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(word)),
    ),
  );
}

function similarity(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const shared = a.filter((token) => setB.has(token)).length;
  // Respecto del más corto: "Unimarc" encaja con "Unimarc San Joaquin".
  return shared / Math.min(a.length, b.length);
}

// Nombres de subcategoría guardados en un movimiento (formatos nuevo y antiguo).
export function transactionSubcategoryNames(transaction) {
  const meta = transaction?.meta || {};
  const names = String(meta.budgetSubcategoryNames || '').trim();
  if (names) {
    return names
      .split(';')
      .map((name) => name.trim())
      .filter(Boolean);
  }
  const single = String(meta.budgetSubcategoryName || '').trim();
  return single ? [single] : [];
}

// Subcategorías del presupuesto de un periodo para una categoría.
export function subcategoriesFor(budgetsAll, periodKey, category) {
  const entry = budgetsAll?.[periodKey]?.[category];
  const breakdown = Array.isArray(entry?.breakdown) ? entry.breakdown : [];
  return breakdown
    .map((item, index) => ({
      id: String(item?.id || item?.name || `${category}-${index}`),
      name: String(item?.name || '').trim(),
    }))
    .filter((item) => item.name);
}

export function findSubcategoryByName(subcategories, name) {
  const key = normalize(name).trim();
  if (!key) return null;
  return (subcategories || []).find((item) => normalize(item.name).trim() === key) || null;
}

// Gastos ya clasificados por la persona que sirven de referencia.
function isReference(transaction, allowedCategories) {
  return (
    transaction?.type === 'gasto' &&
    transaction.category &&
    allowedCategories.has(transaction.category) &&
    !['transfer', 'refund', 'saving_withdrawal'].includes(transaction?.meta?.kind) &&
    String(transaction.description || '').trim()
  );
}

// Categoría y subcategoría más usadas en gastos con descripción parecida.
// Devuelve null si no hay antecedentes.
export function suggestFromHistory(candidate, transactions = [], categories = []) {
  const tokens = merchantTokens(candidate?.description);
  if (!tokens.length) return null;
  const allowed = new Set(categories);
  const votes = new Map();
  (Array.isArray(transactions) ? transactions : []).forEach((transaction) => {
    if (!isReference(transaction, allowed)) return;
    if (similarity(tokens, merchantTokens(transaction.description)) < MIN_SIMILARITY) return;
    const subcategory = transactionSubcategoryNames(transaction);
    const key = `${transaction.category}\u0000${subcategory.length === 1 ? subcategory[0] : ''}`;
    const date = txDateKey(transaction) || '';
    const current = votes.get(key) || { count: 0, lastDate: '' };
    votes.set(key, {
      count: current.count + 1,
      lastDate: date > current.lastDate ? date : current.lastDate,
    });
  });
  if (!votes.size) return null;
  const [bestKey, best] = Array.from(votes.entries()).sort(
    ([, a], [, b]) => b.count - a.count || b.lastDate.localeCompare(a.lastDate),
  )[0];
  const [category, subcategory] = bestKey.split('\u0000');
  return { category, subcategory, matches: best.count };
}

// Ejemplos de cómo se clasificaron gastos recientes, para orientar a Gemini.
// Uno por descripción, los más recientes primero.
export function classificationExamples(transactions = [], categories = [], limit = MAX_EXAMPLES) {
  const allowed = new Set(categories);
  const seen = new Set();
  const examples = [];
  const sorted = (Array.isArray(transactions) ? transactions : [])
    // Las transferencias llevan el nombre de una persona: no salen del dispositivo.
    .filter(
      (transaction) =>
        isReference(transaction, allowed) &&
        !/^\s*transferencia\b/i.test(transaction.description),
    )
    .sort((a, b) => (txDateKey(b) || '').localeCompare(txDateKey(a) || ''));
  for (const transaction of sorted) {
    const key = merchantTokens(transaction.description).join(' ');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const subcategory = transactionSubcategoryNames(transaction);
    examples.push({
      description: String(transaction.description).trim().slice(0, 80),
      category: transaction.category,
      subcategory: subcategory.length === 1 ? subcategory[0] : '',
    });
    if (examples.length >= limit) break;
  }
  return examples;
}
