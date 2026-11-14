import { SchemaType } from 'firebase/ai';
import { ACTION_TYPES, validateAssistantActions } from '../domain/assistantActions.js';
import { categoryBudgetStatus } from '../domain/budgetHealth.js';
import {
  accountBalances,
  normalizeAccounts,
  reconciliation,
  unassignedTransactions,
} from '../domain/accounts.js';
import { maskSensitiveText } from '../domain/bankEmailParser.js';
import { subcategoriesFor, transactionSubcategoryNames } from '../domain/categorySuggestion.js';
import { todayKey } from '../domain/dates.js';
import { findSimilarTransactions } from '../domain/similarTransactions.js';
import { isAdjustment, periodLedger, txDateKey } from '../domain/ledger.js';
import { shiftMonth } from '../utils/budgetPeriod.js';
import { getSubcategoryAllocationsForTransaction } from '../utils/subcategoryAllocations.js';
import { appCheckConfigured } from '../firebase.js';
import { GEMINI_MODEL, generateWithRetry } from './generate.js';

// Periodos de historial que ve el asistente (el consultado y los anteriores).
const HISTORY_PERIODS = 3;
// Tope de movimientos enviados, para no exceder el contexto del modelo.
const MAX_TRANSACTIONS = 400;
const MAX_FLAGGED = 30;

function movementKind(t) {
  const kind = t?.meta?.kind;
  if (kind === 'transfer') return 'traspaso';
  if (kind === 'refund') return 'reembolso';
  if (kind === 'saving_withdrawal') return 'retiro de ahorro';
  if (isAdjustment(t)) return 'ajuste';
  return t?.type === 'ingreso' ? 'ingreso' : 'gasto';
}

// Fila compacta de un movimiento. Se ocultan RUT, correos y números de cuenta.
function compactTransaction(t, { accountNames, memberNames }) {
  const subcategories = transactionSubcategoryNames(t);
  return {
    id: String(t.id || ''),
    fecha: txDateKey(t),
    tipo: movementKind(t),
    monto: Math.round(Number(t.amount) || 0),
    categoria: t.category || '',
    subcategoria: subcategories.join('; '),
    descripcion: maskSensitiveText(t.description || '').slice(0, 120),
    cuenta: accountNames.get(t.account) || '',
    quien: memberNames.get(t.ownerId) || '',
    origen: t.sourceGmailId ? 'aviso bancario' : 'manual',
  };
}

// Presupuesto del periodo por categoría, con el detalle de subcategorías.
function budgetsWithSubcategories({ budgetsAll, transactions, categories, periodKey, cutDay, periodTx }) {
  return categories
    .map((category) => {
      const { funded, spent, remaining } = categoryBudgetStatus({
        budgetsAll,
        transactions,
        cutDay,
        category,
        periodKey,
      });
      const breakdown = (budgetsAll?.[periodKey]?.[category]?.breakdown || []).map(
        (item, index) => ({
          ...item,
          id: String(item?.id || item?.name || `${category}-${index}`),
        }),
      );
      const subs = subcategoriesFor(budgetsAll, periodKey, category);
      const spentBySub = new Map();
      let withoutSubcategory = 0;
      periodTx.forEach((t) => {
        if (t?.type !== 'gasto' || t.category !== category) return;
        const allocations = getSubcategoryAllocationsForTransaction({ transaction: t, breakdown });
        if (!allocations.length) {
          withoutSubcategory += Math.round(Number(t.amount) || 0);
          return;
        }
        allocations.forEach(({ id, amount }) => {
          spentBySub.set(id, (spentBySub.get(id) || 0) + amount);
        });
      });
      return {
        categoria: category,
        presupuestado: funded,
        gastado: spent,
        disponible: remaining,
        ...(subs.length
          ? {
              subcategorias: subs.map((sub) => ({
                nombre: sub.name,
                presupuestado: Number(breakdown.find((b) => b.id === sub.id)?.amount) || 0,
                gastado: spentBySub.get(sub.id) || 0,
              })),
              gastadoSinSubcategoria: withoutSubcategory,
            }
          : {}),
      };
    })
    .filter((entry) => entry.presupuestado > 0 || entry.gastado > 0);
}

// Cuadratura: saldo real anotado por cuenta vs. lo que calcula la app.
function accountsSummary({ accounts, transactions, today, compact }) {
  const list = normalizeAccounts(accounts);
  const balances = accountBalances({ accounts: list, transactions, today });
  const check = reconciliation({ accounts: list, transactions, today });
  const unassigned = unassignedTransactions({ accounts: list, transactions, today });
  return {
    cuentas: balances.accounts.map((account) => ({
      id: account.id,
      nombre: account.name,
      tipo: account.kind === 'cash' ? 'efectivo' : 'banco',
      saldoRealAnotado: account.configured ? account.anchorBalance : null,
      fechaSaldoReal: account.anchorDate || null,
      saldoEstimadoHoy: account.balance,
      movimientosDesdeSaldoReal: account.movements,
    })),
    sumaCuentas: check.realTotal,
    saldoSegunMovimientos: check.appCash,
    diferencia: check.delta,
    todasLasCuentasConSaldo: check.complete,
    movimientosSinCuenta: unassigned.slice(-MAX_FLAGGED).map(compact),
  };
}

export function createAssistantContext({
  periodKey,
  transactions = [],
  budgetsAll = {},
  categories = [],
  debts = [],
  budgetCutDay = 1,
  accounts = [],
  members = [],
  today = todayKey(),
}) {
  const ledger = periodLedger({
    transactions,
    periodKey,
    cutDay: budgetCutDay,
    debts,
  });
  const accountNames = new Map(normalizeAccounts(accounts).map((a) => [a.id, a.name]));
  const memberNames = new Map(
    (members || []).map((m) => [m?.id, String(m?.name || '').split(' ')[0] || 'Miembro']),
  );
  const compact = (t) => compactTransaction(t, { accountNames, memberNames });

  const oldestPeriod = shiftMonth(periodKey, -(HISTORY_PERIODS - 1));
  const { start } = periodLedger({ transactions: [], periodKey: oldestPeriod, cutDay: budgetCutDay });
  const recent = (transactions || [])
    .filter((t) => {
      const date = txDateKey(t);
      return date && date >= start && date < ledger.end;
    })
    .sort((a, b) => txDateKey(a).localeCompare(txDateKey(b)));
  const sent = recent.slice(-MAX_TRANSACTIONS);

  // Gastos del periodo sin subcategoría en categorías que sí tienen subcategorías.
  const withoutSubcategory = ledger.transactions.filter(
    (t) =>
      t?.type === 'gasto' &&
      !transactionSubcategoryNames(t).length &&
      !t?.meta?.budgetSubcategoryIds?.length &&
      !t?.meta?.budgetSubcategoryId &&
      subcategoriesFor(budgetsAll, periodKey, t.category).length > 0,
  );
  // Posibles duplicados: mismo monto y tipo en fechas cercanas.
  const seen = new Set();
  const duplicates = [];
  ledger.transactions.forEach((t) => {
    if (seen.has(t.id)) return;
    const twins = findSimilarTransactions(
      t,
      ledger.transactions.filter((other) => other.id !== t.id),
      1,
    );
    if (!twins.length) return;
    [t, ...twins].forEach((item) => seen.add(item.id));
    duplicates.push([t, ...twins].map((item) => item.id));
  });

  return {
    hoy: today,
    periodo: { clave: periodKey, desde: ledger.start, hastaAntesDe: ledger.end },
    totalesDelPeriodo: {
      ingresos: ledger.income,
      reembolsos: ledger.refunds,
      consumo: ledger.consumptionNet,
      pagosDeDeudas: ledger.debtPayments,
      suscripciones: ledger.subscriptions,
      aportesAhorro: ledger.savingContributions,
      saldoInicial: ledger.opening,
      saldoFinal: ledger.closing,
    },
    presupuestos: budgetsWithSubcategories({
      budgetsAll,
      transactions,
      categories,
      periodKey,
      cutDay: budgetCutDay,
      periodTx: ledger.transactions,
    }),
    cuadratura: accountsSummary({ accounts, transactions, today, compact }),
    revisar: {
      gastosSinSubcategoria: withoutSubcategory.slice(-MAX_FLAGGED).map((t) => String(t.id || '')),
      posiblesDuplicados: duplicates.slice(0, MAX_FLAGGED),
    },
    movimientos: sent.map(compact),
    nota:
      recent.length > sent.length
        ? `Se enviaron los ${sent.length} movimientos más recientes de ${recent.length} en los últimos ${HISTORY_PERIODS} periodos.`
        : `Incluye todos los movimientos registrados de los últimos ${HISTORY_PERIODS} periodos.`,
  };
}

export async function askFinancialAssistant({
  question,
  history = [],
  periodKey,
  transactions,
  budgetsAll,
  categories,
  debts,
  budgetCutDay,
  accounts,
  members,
}) {
  if (!appCheckConfigured) {
    throw new Error(
      'Configura App Check para esta app web en Firebase Console y agrega VITE_FIREBASE_APP_CHECK_SITE_KEY.',
    );
  }

  const modelParams = {
    model: GEMINI_MODEL,
    systemInstruction: [
      'Eres el asistente de Finanzas en Familia. Habla en español claro y breve, en pesos chilenos.',
      'Ayuda a entender presupuestos, gastos, ingresos, ahorro y el uso de la aplicación.',
      `Tienes acceso a los movimientos registrados de los últimos ${HISTORY_PERIODS} periodos de presupuesto (lista "movimientos", con fecha, monto, categoría, subcategoría, descripción, cuenta y quién lo registró), al presupuesto por categoría y subcategoría, y a la cuadratura de cuentas. Úsalos para responder con detalle: nombra comercios, fechas y montos concretos. Nunca digas que no puedes ver el historial de movimientos.`,
      'Si te piden algo de periodos más antiguos que los entregados, dilo y responde con lo que tienes.',
      'Para "cuadrar" o conciliar: compara el saldo real anotado de cada cuenta con el saldo según movimientos ("cuadratura.diferencia": positivo = falta registrar un ingreso; negativo = falta registrar un gasto), revisa movimientos sin cuenta, gastos sin subcategoría ("revisar.gastosSinSubcategoria") y posibles duplicados ("revisar.posiblesDuplicados"), y propone para cada movimiento qué categoría o subcategoría asignar según cómo se clasificaron gastos parecidos. Entrega una lista concreta de correcciones.',
      'En el texto de "respuesta", para referirte a un movimiento usa su fecha, monto y descripción, no su id.',
      'No inventes movimientos, saldos ni hechos; si faltan datos, dilo.',
      'El saldo es una estimación a partir de los movimientos cargados, no un saldo bancario confirmado.',
      'No solicites contraseñas, códigos, números de cuenta, RUT ni otros datos bancarios sensibles.',
      'Cuando te pidan cuadrar, ordenar, corregir o asignar, además de explicar, llena "correcciones" con los cambios concretos; la app los muestra con un botón Aplicar y la persona confirma. Tipos: "asignar_subcategoria" (id del movimiento, categoria y subcategoria exactas del presupuesto), "asignar_cuenta" (id y cuenta = id de la cuenta), "convertir_en_giro" (id de un gasto que en realidad fue un giro en cajero o traspaso entre cuentas propias; desde y hacia = ids de cuentas, normalmente hacia la de tipo efectivo), "ajuste_balance" (solo si, después de las otras correcciones, la diferencia de la cuadratura sigue sin explicarse; no pongas monto, la app lo calcula). Agrega un motivo breve a cada una. Si no te piden cambios o no hay nada que corregir, deja "correcciones" vacío. No digas que no puedes hacer cambios: propones y la persona aplica.',
      'Los posibles duplicados no se corrigen solos: menciónalos para que la persona los revise.',
      'No des asesoría financiera, legal ni tributaria profesional; presenta sugerencias generales y prudentes.',
    ].join(' '),
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          respuesta: {
            type: SchemaType.STRING,
            description: 'Respuesta para la persona, en español, con formato Markdown simple.',
          },
          correcciones: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                tipo: { type: SchemaType.STRING, enum: [...ACTION_TYPES] },
                id: { type: SchemaType.STRING },
                categoria: { type: SchemaType.STRING },
                subcategoria: { type: SchemaType.STRING },
                cuenta: { type: SchemaType.STRING },
                desde: { type: SchemaType.STRING },
                hacia: { type: SchemaType.STRING },
                motivo: { type: SchemaType.STRING },
              },
              required: ['tipo', 'motivo'],
            },
          },
        },
        required: ['respuesta', 'correcciones'],
      },
    },
  };
  const context = createAssistantContext({
    periodKey,
    transactions,
    budgetsAll,
    categories,
    debts,
    budgetCutDay,
    accounts,
    members,
  });
  const contents = [
    ...history.slice(-8).map((message) => ({
      role: message.role,
      parts: [{ text: String(message.text || '').slice(0, 2000) }],
    })),
    {
      role: 'user',
      parts: [
        {
          text: `Datos financieros del hogar:\n${JSON.stringify(context)}\n\nConsulta:\n${String(question).slice(0, 2000)}`,
        },
      ],
    },
  ];
  const result = await generateWithRetry(modelParams, { contents });
  let parsed;
  try {
    parsed = JSON.parse(result.response.text());
  } catch {
    // Sin el texto: puede contener datos financieros.
    console.error('El asistente devolvió JSON inválido:', {
      finishReason: result.response.candidates?.[0]?.finishReason || 'unknown',
    });
    throw new Error('El asistente devolvió una respuesta inválida. Intenta de nuevo.');
  }
  const answer = String(parsed?.respuesta || '').trim();
  if (!answer) throw new Error('El asistente no devolvió una respuesta.');
  return {
    answer,
    actions: validateAssistantActions(parsed?.correcciones, {
      transactions,
      categories,
      budgetsAll,
      cutDay: budgetCutDay,
      accounts,
      today: todayKey(),
    }),
  };
}
