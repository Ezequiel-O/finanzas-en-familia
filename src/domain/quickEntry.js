// src/domain/quickEntry.js
// Interpreta texto corto para registrar un movimiento rápido:
//   "súper 15 lucas", "bencina 30 mil ayer", "sueldo 900 mil", "farmacia $12.990".
import { isSystemCategory } from './categories.js';
import { addDaysToKey, todayKey } from './dates.js';
import { parseAmount } from './money.js';

const normalize = (v) =>
  String(v || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

// Palabras comunes en Chile -> categoría por defecto (solo se usa si la categoría existe).
const KEYWORDS = [
  [/\b(super|supermercado|feria|almuerzo|comida|pan|verduras|lider|jumbo|unimarc|tottus|santa isabel|delivery|rappi|pedidosya)\b/, 'alimentacion'],
  [/\b(bencina|combustible|uber|didi|cabify|metro|micro|bip|estacionamiento|peaje|tag|taxi|colectivo)\b/, 'transporte'],
  [/\b(farmacia|remedio|doctor|medico|consulta|isapre|fonasa|dentista|examen)\b/, 'salud'],
  [/\b(luz|agua|gas|internet|celular|telefono|enel|aguas andinas|metrogas|movistar|entel|wom|vtr)\b/, 'servicios'],
  [/\b(colegio|jardin|universidad|curso|matricula|mensualidad|libros?|utiles)\b/, 'educacion'],
  [/\b(cine|netflix|spotify|disney|salida|bar|concierto|juego|streaming)\b/, 'entretenimiento'],
  [/\b(ropa|zapatos|zapatillas|polera|pantalon|chaqueta)\b/, 'vestuario'],
  [/\b(arriendo|dividendo|gastos comunes|ferreteria|aseo|mueble)\b/, 'hogar'],
];

const INCOME_WORDS = /\b(sueldo|salario|ingreso|bono|honorario|honorarios|venta|reembolso|aguinaldo|me pagaron)\b/;

function guessDate(text, today) {
  if (/\banteayer\b/.test(text)) return addDaysToKey(today, -2);
  if (/\bayer\b/.test(text)) return addDaysToKey(today, -1);
  return today;
}

// Categoría más usada históricamente con descripciones parecidas.
function categoryFromHistory(words, transactions) {
  if (!words.length) return '';
  const counts = new Map();
  (transactions || []).forEach((t) => {
    if (t?.type !== 'gasto' || !t.category) return;
    const desc = normalize(t.description);
    if (!desc) return;
    if (words.some((w) => desc.includes(w))) {
      counts.set(t.category, (counts.get(t.category) || 0) + 1);
    }
  });
  let best = '';
  let bestCount = 0;
  counts.forEach((c, cat) => {
    if (c > bestCount) {
      best = cat;
      bestCount = c;
    }
  });
  return best;
}

export function parseQuickEntry(input, { categories = [], transactions = [], today = todayKey() } = {}) {
  const raw = String(input || '').trim();
  const text = normalize(raw);
  const result = { type: 'gasto', amount: 0, category: '', description: '', date: today };
  if (!text) return result;

  result.amount = parseAmount(raw);
  result.date = guessDate(text, today);
  if (INCOME_WORDS.test(text)) result.type = 'ingreso';

  // Descripción: el texto sin montos ni palabras de fecha/moneda.
  const description = raw
    .replace(/\$?\s*\d[\d.,\s]*(k\b)?/gi, ' ')
    .replace(/\b(mil|lucas?|millones?|mill[oó]n|medio|pesos|anteayer|ayer|hoy)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  result.description = description ? description.charAt(0).toUpperCase() + description.slice(1) : '';

  if (result.type === 'ingreso') return result;

  const usable = categories.filter((c) => !isSystemCategory(c));
  const byName = usable
    .filter((c) => {
      const n = normalize(c).split(/[\s(/]/)[0];
      return n.length >= 3 && text.includes(n);
    })
    .sort((a, b) => b.length - a.length)[0];
  if (byName) {
    result.category = byName;
    return result;
  }

  const words = normalize(description)
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  const fromHistory = categoryFromHistory(words, transactions);
  if (fromHistory && usable.includes(fromHistory)) {
    result.category = fromHistory;
    return result;
  }

  for (const [re, key] of KEYWORDS) {
    if (!re.test(text)) continue;
    const match = usable.find((c) => normalize(c).startsWith(key));
    if (match) {
      result.category = match;
      break;
    }
  }
  return result;
}

// Categorías ordenadas por uso reciente del usuario (últimos 90 días), sin las del sistema.
export function rankCategories(categories, transactions, { today = todayKey(), ownerId = null } = {}) {
  const since = addDaysToKey(today, -90);
  const counts = new Map();
  (transactions || []).forEach((t) => {
    if (t?.type !== 'gasto' || !t.category) return;
    if (ownerId && t.ownerId && t.ownerId !== ownerId) return;
    const d = String(t.date || '').slice(0, 10);
    if (d && d < since) return;
    counts.set(t.category, (counts.get(t.category) || 0) + 1);
  });
  return categories
    .filter((c) => !isSystemCategory(c))
    .map((c, i) => ({ c, i, n: counts.get(c) || 0 }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((x) => x.c);
}
