// src/features/plan/PlanCards.jsx
// Pantalla Plan: "Hoy" (gasto seguro), "Qué pagar y cuándo", "Fin de mes" y el detalle de
// tramos. Todo se calcula desde hoy con safeSpendPlan (domain/safeSpend.js).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '../../components/ui/Card.jsx';
import { Money } from '../../components/ui/Money.jsx';
import { addDaysToKey, formatShortDate } from '../../domain/dates.js';
import { formatAmountInput, parseAmount } from '../../domain/money.js';
import { canISpend, safeSpendPlan } from '../../domain/safeSpend.js';
import { planFacts } from '../../domain/planAdvice.js';

const TONE = {
  green: 'border-[color:var(--success)]/40 bg-[color:var(--success)]/10',
  yellow: 'border-[color:var(--warning)]/50 bg-[color:var(--warning)]/10',
  red: 'border-[color:var(--danger)]/50 bg-[color:var(--danger)]/10',
};
const TEXT_TONE = {
  green: 'text-[color:var(--success)]',
  yellow: 'text-[color:var(--warning)]',
  red: 'text-[color:var(--danger)]',
};

function useSafeSpend(data) {
  const {
    transactions = [],
    debts = [],
    savings = [],
    budgetsAll = {},
    fixedCategories = {},
    priorityCategories = {},
    fixedDueDays = {},
    categories = [],
    budgetCutDay = 1,
    expectedIncome = 0,
  } = data || {};
  return useMemo(
    () =>
      safeSpendPlan({
        transactions,
        debts,
        savings,
        budgetsAll,
        fixedCategories,
        priorityCategories,
        fixedDueDays,
        categories,
        cutDay: budgetCutDay,
        expectedIncome,
      }),
    [transactions, debts, savings, budgetsAll, fixedCategories, priorityCategories, fixedDueDays, categories, budgetCutDay, expectedIncome],
  );
}

// Avisos redactados por Gemini con los datos del plan. Se vuelven a pedir solo cuando
// cambian esos datos; mientras tanto (o si Gemini falla) se muestran los textos fijos.
function usePlanAdvice(summary, advise) {
  const [advice, setAdvice] = useState(null);
  // Se compara por contenido (factsKey) para no repetir llamadas en cada render.
  const factsKey = useMemo(() => JSON.stringify(planFacts(summary)), [summary]);
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  useEffect(() => {
    if (!advise) return undefined;
    let active = true;
    setAdvice(null);
    advise(summaryRef.current)
      .then((result) => {
        if (active) setAdvice(result || null);
      })
      .catch((error) => {
        console.error('No se pudieron redactar los avisos del Plan:', { code: error?.code || 'unknown' });
      });
    return () => {
      active = false;
    };
  }, [factsKey, advise]);
  return advice;
}

function GeminiTag() {
  return (
    <span className="ml-1 inline-block rounded-full bg-[color:var(--surface-2)] px-2 py-0.5 align-middle text-[10px] font-semibold text-[color:var(--text-muted)]">
      ✨ Gemini
    </span>
  );
}

// El último tramo termina el día siguiente al fin del periodo: se muestra su último día.
function tramoEnd(summary, tramo) {
  const last = summary.tramos[summary.tramos.length - 1];
  return formatShortDate(tramo === last ? addDaysToKey(tramo.end, -1) : tramo.end);
}

const paymentName = (item) => item.subName || (item.kind === 'fixed' ? item.category : item.name);

function PaymentLine({ item }) {
  return (
    <li className="flex justify-between gap-3 py-1.5 text-sm">
      <span className="min-w-0 truncate">
        {item.dueDate ? formatShortDate(item.dueDate) : 'Sin fecha'} · {paymentName(item)}
      </span>
      <span className="shrink-0 font-semibold">
        <Money n={item.pending} />
      </span>
    </li>
  );
}

function SpendCheck({ summary, categories }) {
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [result, setResult] = useState(null);

  function review(e) {
    e.preventDefault();
    if (parseAmount(amount) <= 0) return;
    setResult(canISpend(summary, { amount: parseAmount(amount), category }));
  }

  const answers = {
    si_presupuesto: () => 'Sí, y sigues dentro de tu presupuesto',
    si_margen: (r) => (
      <>
        Sí, pero baja tu margen del mes a <Money n={r.amount} />
      </>
    ),
    no_tramo: (r) => (
      <>
        No: el {formatShortDate(r.date)} te faltarían <Money n={r.amount} /> para lo necesario
      </>
    ),
    no_margen: (r) => (
      <>
        No: terminas el mes con déficit de <Money n={r.amount} />
      </>
    ),
  };

  return (
    <form onSubmit={review} className="mt-4 space-y-2 border-t border-[color:var(--divider)] pt-3">
      <div className="text-sm font-semibold">¿Puedo gastar esto?</div>
      <div className="flex flex-wrap gap-2">
        <input
          value={amount}
          onChange={(e) => {
            setAmount(formatAmountInput(e.target.value));
            setResult(null);
          }}
          inputMode="numeric"
          placeholder="Monto"
          aria-label="Monto a gastar"
          className="min-h-[44px] w-36 rounded-xl border border-[color:var(--border)] bg-[color:var(--input-bg)] px-3 text-sm"
        />
        <select
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            setResult(null);
          }}
          aria-label="Categoría del gasto"
          className="min-h-[44px] flex-1 min-w-[150px] rounded-xl border border-[color:var(--border)] bg-[color:var(--input-bg)] px-3 text-sm"
        >
          <option value="">Fuera del presupuesto</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="min-h-[44px] px-4 rounded-xl bg-[color:var(--primary)] text-[color:var(--primary-contrast)] text-sm font-semibold"
        >
          Revisar
        </button>
      </div>
      {result && (
        <p
          role="status"
          className={`text-sm font-semibold ${result.answer.startsWith('si') ? TEXT_TONE.green : TEXT_TONE.red}`}
        >
          {answers[result.answer](result)}
        </p>
      )}
    </form>
  );
}

// Tarjeta 1 – "Hoy".
export function TodayCard({ summary, advice }) {
  const tight = summary.tightest;
  return (
    <div className={`rounded-2xl border p-4 shadow-[var(--shadow)] ${TONE[summary.level]}`}>
      {advice ? (
        <>
          <h2 className={`text-2xl font-bold ${summary.level === 'red' ? TEXT_TONE.red : ''}`}>
            {advice.hoyTitulo}
            <GeminiTag />
          </h2>
          <p className="mt-1 text-sm">{advice.hoyMensaje}</p>
          {advice.consejos.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm">
              {advice.consejos.map((tip) => (
                <li key={tip}>{tip}</li>
              ))}
            </ul>
          )}
        </>
      ) : summary.level === 'red' ? (
        <>
          <h2 className={`text-2xl font-bold ${TEXT_TONE.red}`}>No gastes nada que no sea esencial</h2>
          <p className="mt-1 text-sm">
            Te faltan <strong><Money n={summary.shortfall} /></strong> el {formatShortDate(summary.shortDate)}.
            {summary.postpone && <> Posterga {paymentName(summary.postpone)}.</>}
          </p>
        </>
      ) : (
        <>
          <h2 className="text-2xl font-bold">
            Hoy puedes gastar hasta <span className={TEXT_TONE[summary.level]}><Money n={summary.safeToday} /></span>
          </h2>
          <p className="mt-1 text-sm">
            Sin quedarte sin plata para comer, moverte y pagar tus cuentas hasta fin de mes. Tu punto más justo es entre el{' '}
            {formatShortDate(tight.start)} y el {tramoEnd(summary, tight)}.
          </p>
          <p className="mt-1 text-sm">
            Fuera de tu presupuesto, solo <strong><Money n={Math.max(0, summary.margin)} /></strong>. Más que eso y terminas el
            mes en negativo.
          </p>
        </>
      )}
      <SpendCheck summary={summary} categories={Object.keys(summary.categoryAvailable)} />
    </div>
  );
}

// Tarjeta 2 – "Qué pagar y cuándo".
export function PayScheduleCard({ summary }) {
  const after = summary.payAfterIncome;
  const afterTotal = after.reduce((s, i) => s + i.pending, 0);
  const incomeDay = formatShortDate(summary.nextIncomeDate);
  return (
    <Card>
      <h2 className="text-lg font-semibold">Qué pagar y cuándo</h2>
      {summary.payBeforeIncome.length > 0 ? (
        <ul className="mt-1 divide-y divide-[color:var(--divider)]">
          {summary.payBeforeIncome.map((item) => (
            <PaymentLine key={item.key} item={item} />
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-[color:var(--text-muted)]">No hay pagos antes del {incomeDay}.</p>
      )}
      {after.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-[color:var(--text-muted)]">
            Después del {incomeDay}: {after.length} {after.length === 1 ? 'pago' : 'pagos'} por <Money n={afterTotal} />
          </summary>
          <ul className="divide-y divide-[color:var(--divider)] text-[color:var(--text-muted)]">
            {after.map((item) => (
              <PaymentLine key={item.key} item={item} />
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

// Tarjeta 3 – "Fin de mes".
export function MonthEndCard({ summary, advice }) {
  const { margin, monthLevel } = summary;
  return (
    <div className={`rounded-2xl border p-4 shadow-[var(--shadow)] ${TONE[monthLevel]}`}>
      <h2 className="text-lg font-semibold">
        Fin de mes
        {advice && <GeminiTag />}
      </h2>
      {advice && <p className="mt-1 text-sm">{advice.finDeMesMensaje}</p>}
      <p className={`mt-1 text-base font-semibold ${TEXT_TONE[monthLevel]}`}>
        {monthLevel === 'green' && (
          <>
            Terminas el mes con superávit de <Money n={margin} />
          </>
        )}
        {monthLevel === 'yellow' && (
          <>
            Terminas justo: <Money n={margin} /> de margen
          </>
        )}
        {monthLevel === 'red' && (
          <>
            Tu presupuesto supera tus ingresos en <Money n={-margin} />
          </>
        )}
      </p>
      {monthLevel === 'red' && summary.cuts.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-sm">
          {summary.cuts.map((c) => (
            <li key={c.category}>
              Recorta {c.category}: <strong><Money n={c.cut} /></strong>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-[color:var(--text-muted)]">
        Ingresos del mes <Money n={summary.monthIncome} /> (por recibir <Money n={summary.upcoming} />) · Presupuesto{' '}
        <Money n={summary.budgetTotal} />
      </p>
    </div>
  );
}

// Detalle de tramos (siempre visible).
export function TramosDetail({ summary }) {
  return (
    <Card>
      <h2 className="text-lg font-semibold">Detalle de tramos</h2>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-[color:var(--text-muted)]">
            <tr className="text-right">
              <th className="py-1 text-left font-medium">Tramo</th>
              <th className="py-1 font-medium">Días</th>
              <th className="py-1 font-medium">+ Ingreso</th>
              <th className="py-1 font-medium">− Pagos</th>
              <th className="py-1 font-medium">− Gasto prioritario</th>
              <th className="py-1 font-medium">Saldo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--divider)]">
            {summary.tramos.map((t) => (
              <tr key={t.start} className={`text-right ${t === summary.tightest ? 'font-semibold' : ''}`}>
                <td className="py-1.5 text-left whitespace-nowrap">
                  {formatShortDate(t.start)} → {tramoEnd(summary, t)}
                </td>
                <td className="py-1.5">{t.days}</td>
                <td className="py-1.5"><Money n={t.incomeIn} /></td>
                <td className="py-1.5"><Money n={t.billsIn} /></td>
                <td className="py-1.5"><Money n={t.priorityIn} /></td>
                <td className={`py-1.5 ${t.balance < 0 ? TEXT_TONE.red : ''}`}><Money n={t.balance} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-[color:var(--text-muted)]">
        Gasto prioritario: <Money n={Math.round(summary.priorityDaily)} /> por día. El saldo de cada tramo es lo que queda al
        final, acumulado desde hoy.
      </p>
    </Card>
  );
}

// Pantalla Plan completa: las tres tarjetas y, siempre visible, el detalle (tabla de
// presupuestos, compromisos, tramos y cierre del periodo).
// `advise` (opcional) pide a Gemini que redacte los avisos con los datos del plan.
export function PlanScreen({ data, budgetsTable, commitments, closing, advise }) {
  const summary = useSafeSpend(data);
  const advice = usePlanAdvice(summary, advise);
  return (
    <div className="grid gap-4">
      <TodayCard summary={summary} advice={advice} />
      <PayScheduleCard summary={summary} />
      <MonthEndCard summary={summary} advice={advice} />
      {budgetsTable}
      {commitments}
      <TramosDetail summary={summary} />
      {closing}
    </div>
  );
}
