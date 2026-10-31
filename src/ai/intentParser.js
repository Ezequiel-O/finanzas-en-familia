import { txDateKey } from '../domain/ledger.js';
import { todayKey, toLocalDateKey } from '../domain/dates.js';
// Simple intent parser (rules) for AI assistant

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function formatCLP(value) {
  const safe = Number(value || 0);
  const abs = Math.abs(safe);
  const formatted = new Intl.NumberFormat('es-CL').format(Math.round(abs));
  return `${safe < 0 ? '-' : ''}$${formatted}`;
}

function extractAmount(text) {
  const rawText = String(text || '');
  const norm = normalizeText(rawText);

  // 1) Digits-based amount
  const match = rawText.match(/(\d[\d.,\s]*)/);
  if (match) {
    const digits = match[1].replace(/[^\d]/g, '');
    if (digits) {
      let value = Number(digits);
      if (norm.includes('millon') || norm.includes('millones')) {
        value *= 1_000_000;
      } else if (norm.includes('mil')) {
        value *= 1_000;
      }
      return value;
    }
  }

  // 2) Word-based amounts (basic)
  const wordMap = {
    un: 1,
    una: 1,
    uno: 1,
    dos: 2,
    tres: 3,
    cuatro: 4,
    cinco: 5,
    seis: 6,
    siete: 7,
    ocho: 8,
    nueve: 9,
    diez: 10,
    once: 11,
    doce: 12,
  };

  if (norm.includes('medio millon') || norm.includes('medio millon')) {
    return 500_000;
  }

  const millionMatch = norm.match(
    /\b(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b\s+(millon|millones)\b/,
  );
  if (millionMatch) {
    const rawNum = millionMatch[1];
    const base = /^\d+$/.test(rawNum)
      ? Number(rawNum)
      : wordMap[rawNum] || null;
    if (base) return base * 1_000_000;
  }

  const thousandMatch = norm.match(
    /\b(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b\s+mil\b/,
  );
  if (thousandMatch) {
    const rawNum = thousandMatch[1];
    const base = /^\d+$/.test(rawNum)
      ? Number(rawNum)
      : wordMap[rawNum] || null;
    if (base) return base * 1_000;
  }

  if (norm.includes('mil')) return 1_000;
  if (norm.includes('cien')) return 100;

  return null;
}

function extractDate(text) {
  const raw = normalizeText(text);
  const today = new Date();
  const asIso = (d) => toLocalDateKey(d);

  if (raw.includes('hoy')) return asIso(today);
  if (raw.includes('ayer')) {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return asIso(d);
  }
  if (raw.includes('anteayer') || raw.includes('antes de ayer')) {
    const d = new Date(today);
    d.setDate(d.getDate() - 2);
    return asIso(d);
  }

  const isoMatch = raw.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const m = Number(isoMatch[2]);
    const d = Number(isoMatch[3]);
    const date = new Date(y, m - 1, d);
    if (!Number.isNaN(date.getTime())) return asIso(date);
  }

  const dmMatch = raw.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (dmMatch) {
    const day = Number(dmMatch[1]);
    const month = Number(dmMatch[2]);
    const yearRaw = dmMatch[3];
    const year = yearRaw ? Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw) : today.getFullYear();
    const date = new Date(year, month - 1, day);
    if (!Number.isNaN(date.getTime())) return asIso(date);
  }

  return null;
}

function findCategoryMatches(text, categories) {
  const normText = normalizeText(text);
  const matches = [];
  (categories || []).forEach((cat) => {
    const normCat = normalizeText(cat);
    if (normCat && normText.includes(normCat)) {
      matches.push(cat);
    }
  });
  if (matches.length <= 1) return matches;
  // Keep longest match first
  return matches.sort((a, b) => normalizeText(b).length - normalizeText(a).length);
}

function buildQuery(text, removeList) {
  let cleaned = normalizeText(text);
  removeList.forEach((token) => {
    const t = normalizeText(token);
    if (!t) return;
    cleaned = cleaned.replace(new RegExp(`\\b${t}\\b`, 'g'), ' ');
  });
  cleaned = cleaned.replace(/\d[\d.,\s]*/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}

function findTransactionMatch(query, transactions) {
  const normQuery = normalizeText(query);
  if (!normQuery) return { matches: [] };
  const matches = (transactions || []).filter((tx) => {
    const desc = normalizeText(tx.description || '');
    const cat = normalizeText(tx.category || '');
    return desc.includes(normQuery) || cat.includes(normQuery);
  });
  // Sort by date desc
  matches.sort((a, b) => {
    const aDate = Date.parse(a.date || a.createdAt || 0) || 0;
    const bDate = Date.parse(b.date || b.createdAt || 0) || 0;
    return bDate - aDate;
  });
  return { matches };
}

export function parseIntent(text, context) {
  const raw = String(text || '').trim();
  if (!raw) {
    return { type: 'clarify', message: 'Escribe una instrucción primero.' };
  }

  const norm = normalizeText(raw);
  const categories = context?.categories || [];
  const transactions = context?.transactions || [];
  const incomeCategoryLabel = 'Ingresos';

  const isBudget = norm.includes('presupuesto') || norm.includes('presupuestar');
  const isDelete = /(eliminar|borrar|quitar|remover)/.test(norm);
  const isUpdate = /(editar|actualizar|modificar|cambiar|ajustar)/.test(norm);
  const isCreate =
    /(crear|agregar|anadir|añadir|nuevo|registrar|ingresar|sumar|anotar)/.test(norm);

  if (isBudget) {
    const amount = extractAmount(raw);
    const catMatches = findCategoryMatches(raw, categories);
    if (!catMatches.length) {
      return {
        type: 'clarify',
        message: '¿Para qué categoría es el presupuesto?',
      };
    }
    if (catMatches.length > 1) {
      return {
        type: 'clarify',
        message: `Hay más de una categoría en el texto: ${catMatches.join(
          ', ',
        )}. Indica solo una.`,
      };
    }
    if (!amount) {
      return { type: 'clarify', message: '¿Qué monto de presupuesto?' };
    }
    const category = catMatches[0];
    const summary = `Asignar presupuesto de ${formatCLP(amount)} a "${category}" (periodo actual).`;
    return {
      type: 'plan',
      plan: {
        kind: 'set_budget',
        summary,
        payload: { category, amount },
      },
    };
  }

  // Transaction flows
  const isIngreso =
    norm.includes('ingreso') || /(sueldo|venta|bono|honorario|deposito)/.test(norm);
  const isGasto =
    norm.includes('gasto') || /(pago|compra|cuenta|arriendo|servicio)/.test(norm);
  const txType = isIngreso && !isGasto ? 'ingreso' : 'gasto';

  if (isDelete || isUpdate) {
    const amount = extractAmount(raw);
    const date = extractDate(raw);
    const catMatches = findCategoryMatches(raw, categories);
    const query = buildQuery(raw, [
      'movimiento',
      'movimientos',
      'gasto',
      'ingreso',
      'presupuesto',
      'editar',
      'actualizar',
      'modificar',
      'cambiar',
      'ajustar',
      'eliminar',
      'borrar',
      'quitar',
      'remover',
      ...(catMatches.length ? [catMatches[0]] : []),
    ]);
    const { matches } = findTransactionMatch(query, transactions);
    if (!matches.length) {
      return {
        type: 'clarify',
        message:
          'No encontré el movimiento. Indica una parte del nombre o la categoría.',
      };
    }
    if (matches.length > 1) {
      const sample = matches
        .slice(0, 3)
        .map(
          (tx) =>
            `${txDateKey(tx)} · ${formatCLP(
              tx.amount,
            )} · ${tx.description || tx.category || 'Movimiento'}`,
        )
        .join(' | ');
      return {
        type: 'clarify',
        message: `Encontré varios movimientos: ${sample}. Indica fecha o monto.`,
      };
    }
    const target = matches[0];
    if (isDelete) {
      const summary = `Eliminar movimiento "${target.description || target.category || 'Movimiento'}" por ${formatCLP(
        target.amount,
      )} del ${(target.date || target.createdAt || '').toString().slice(0, 10)}.`;
      return {
        type: 'plan',
        plan: {
          kind: 'delete_transaction',
          summary,
          payload: { id: target.id },
        },
      };
    }

    if (!amount && !date) {
      return {
        type: 'clarify',
        message: '¿Qué quieres cambiar? Indica monto y/o fecha.',
      };
    }
    const patch = {};
    if (amount) patch.amount = amount;
    if (date) patch.date = date;
    const summaryParts = [];
    if (amount) summaryParts.push(`monto ${formatCLP(amount)}`);
    if (date) summaryParts.push(`fecha ${date}`);
    const summary = `Editar movimiento "${
      target.description || target.category || 'Movimiento'
    }": ${summaryParts.join(', ')}.`;
    return {
      type: 'plan',
      plan: {
        kind: 'update_transaction',
        summary,
        payload: { id: target.id, patch },
      },
    };
  }

  if (isCreate || isGasto || isIngreso || norm.includes('movimiento')) {
    const amount = extractAmount(raw);
    if (!amount) {
      return { type: 'clarify', message: '¿Qué monto?' };
    }
    const date = extractDate(raw) || todayKey();
    const catMatches = findCategoryMatches(raw, categories);
    if (txType === 'gasto' && !catMatches.length) {
      return {
        type: 'clarify',
        message: '¿En qué categoría va el gasto?',
      };
    }
    if (catMatches.length > 1) {
      return {
        type: 'clarify',
        message: `Hay más de una categoría en el texto: ${catMatches.join(
          ', ',
        )}. Indica solo una.`,
      };
    }
    const category =
      txType === 'ingreso' ? incomeCategoryLabel : catMatches[0];
    const description = buildQuery(raw, [
      'movimiento',
      'movimientos',
      'gasto',
      'ingreso',
      'presupuesto',
      'crear',
      'agregar',
      'anadir',
      'añadir',
      'nuevo',
      'registrar',
      'ingresar',
      'sumar',
      'anotar',
      'de',
      'en',
      'por',
      category || '',
    ]);
    const finalDescription = description || category || 'Movimiento';
    const summary = `Crear ${txType} de ${formatCLP(amount)} en "${
      category || incomeCategoryLabel
    }" (${finalDescription}) para ${date}.`;
    return {
      type: 'plan',
      plan: {
        kind: 'create_transaction',
        summary,
        payload: {
          type: txType,
          amount,
          category,
          description: finalDescription,
          date,
        },
      },
    };
  }

  return {
    type: 'clarify',
    message:
      'No entendí la instrucción. Prueba con: "Agregar gasto 12000 en Supermercado ayer".',
  };
}
