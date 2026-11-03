import { getApp } from 'firebase/app';
import { getAI, getGenerativeModel, GoogleAIBackend } from 'firebase/ai';
import { categoryBudgetStatus } from '../domain/budgetHealth.js';
import { periodLedger } from '../domain/ledger.js';
import { appCheckConfigured } from '../firebase.js';

const MODEL_NAME = 'gemini-3.7-flash';

export function createAssistantContext({
  periodKey,
  transactions = [],
  budgetsAll = {},
  categories = [],
  debts = [],
  budgetCutDay = 1,
}) {
  const ledger = periodLedger({
    transactions,
    periodKey,
    cutDay: budgetCutDay,
    debts,
  });
  const budgets = categories
    .map((category) => {
      const { funded, spent, remaining } = categoryBudgetStatus({
        budgetsAll,
        transactions,
        cutDay: budgetCutDay,
        category,
        periodKey,
      });
      return { category, planned: funded, spent, remaining };
    })
    .filter((entry) => entry.planned > 0 || entry.spent > 0);

  return {
    period: periodKey,
    loadedTransactionsInPeriod: ledger.transactions.length,
    periodTotals: {
      income: ledger.income,
      refunds: ledger.refunds,
      consumption: ledger.consumptionNet,
      debtPayments: ledger.debtPayments,
      subscriptions: ledger.subscriptions,
      savingContributions: ledger.savingContributions,
      closingBalanceFromLoadedTransactions: ledger.closing,
    },
    budgets,
    limitation:
      'Cifras calculadas solo con los movimientos actualmente cargados en la app; no asumir que incluyen todo el historial.',
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
}) {
  if (!appCheckConfigured) {
    throw new Error(
      'Configura App Check para esta app web en Firebase Console y agrega VITE_FIREBASE_APP_CHECK_SITE_KEY.',
    );
  }

  const ai = getAI(getApp(), { backend: new GoogleAIBackend() });
  const model = getGenerativeModel(ai, {
    model: MODEL_NAME,
    systemInstruction: [
      'Eres el asistente de Finanzas en Familia. Habla en español claro y breve, en pesos chilenos.',
      'Ayuda a entender presupuestos, gastos, ingresos, ahorro y el uso de la aplicación.',
      'Usa solo los datos agregados que se te entregan. No inventes movimientos, saldos ni hechos; si faltan datos o el registro puede estar incompleto, dilo.',
      'El saldo es una estimación a partir de los movimientos cargados, no un saldo bancario confirmado.',
      'No solicites contraseñas, códigos, números de cuenta, RUT ni otros datos bancarios sensibles.',
      'No ejecutas cambios ni operaciones: para registrar movimientos, ofrece instrucciones. Las acciones de la app requieren revisión y confirmación explícitas.',
      'No des asesoría financiera, legal ni tributaria profesional; presenta sugerencias generales y prudentes.',
    ].join(' '),
  });
  const context = createAssistantContext({
    periodKey,
    transactions,
    budgetsAll,
    categories,
    debts,
    budgetCutDay,
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
          text: `Contexto financiero agregado del periodo:\n${JSON.stringify(context)}\n\nConsulta:\n${String(question).slice(0, 2000)}`,
        },
      ],
    },
  ];
  const result = await model.generateContent({ contents });
  const answer = String(result.response.text() || '').trim();
  if (!answer) throw new Error('El asistente no devolvió una respuesta.');
  return answer;
}
