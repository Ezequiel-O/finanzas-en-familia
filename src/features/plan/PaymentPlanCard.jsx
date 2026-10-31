// src/features/plan/PaymentPlanCard.jsx
// "Qué hacer hoy": la respuesta corta del plan hasta el próximo ingreso, en pasos, y cómo
// cierra el periodo completo. El cálculo queda plegado debajo.
// Siempre se calcula desde hoy, no desde el periodo elegido.
import { useMemo } from 'react';
import { Card } from '../../components/ui/Card.jsx';
import { Money } from '../../components/ui/Money.jsx';
import { formatShortDate } from '../../domain/dates.js';
import { paymentPlan, PRIORITY_LABEL } from '../../domain/paymentPlan.js';
import { usePayCommitment } from '../commitments/usePayCommitment.js';

const KIND_ICON = { fixed: '🏠', debt: '💳', subscription: '🔁' };

const STATUS = {
  ok: { label: 'Vas bien', className: 'bg-[color:var(--success)]/15 text-[color:var(--success)] border-[color:var(--success)]/30' },
  tight: { label: 'Cuidado', className: 'bg-[color:var(--warning)]/15 text-[color:var(--warning)] border-[color:var(--warning)]/40' },
  short: { label: 'No alcanza', className: 'bg-[color:var(--danger)]/15 text-[color:var(--danger)] border-[color:var(--danger)]/40' },
};

function listNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
}

function dueText(item) {
  if (item.isOverdue) return <span className="font-semibold text-[color:var(--danger)]">Atrasada</span>;
  if (!item.dueDate) return <span className="font-semibold text-[color:var(--warning)]">Sin fecha de pago</span>;
  return `Vence ${formatShortDate(item.dueDate)}`;
}

function actionText(item, incomeDay) {
  if (item.action === 'partial') {
    return (
      <>
        Abona ahora y el resto (<Money n={item.pending - item.payNow} />) el {incomeDay}
      </>
    );
  }
  if (item.action !== 'wait') return item.reason || PRIORITY_LABEL[item.priority];
  if (item.kind === 'subscription') return 'No alcanza: pausa la suscripción';
  return `No alcanza: pide plazo o págala el ${incomeDay}`;
}

function BillRow({ item, incomeDay, onPay }) {
  const amount = item.action === 'pay' || item.action === 'partial' ? item.payNow : item.pending;
  const canPay = item.payNow > 0 && item.kind !== 'fixed' && onPay;
  return (
    <li className="flex items-start gap-3 py-2">
      <span aria-hidden="true">{KIND_ICON[item.kind] || '•'}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{item.name}</div>
        <div className="text-xs text-[color:var(--text-muted)]">
          {dueText(item)} · {actionText(item, incomeDay)}
        </div>
      </div>
      <div className="text-right">
        <div className="text-sm font-semibold">
          <Money n={amount} />
        </div>
        {canPay && (
          <button
            type="button"
            onClick={() => onPay({ ...item, pending: item.payNow })}
            className="mt-1 min-h-[36px] px-3 rounded-lg bg-[color:var(--primary)] text-[color:var(--primary-contrast)] text-xs font-semibold"
          >
            {item.action === 'partial' ? 'Abonar' : 'Pagar'}
          </button>
        )}
      </div>
    </li>
  );
}

function Step({ n, title, children }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color:var(--primary)] text-sm font-bold text-[color:var(--primary-contrast)]">
        {n}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="font-semibold">{title}</div>
        {children}
      </div>
    </li>
  );
}

export function PaymentPlanCard({ data, actions, activeUser }) {
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
  const plan = useMemo(
    () =>
      paymentPlan({
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
  const pay = usePayCommitment({ debts, savings, actions, activeUser });

  const incomeDay = formatShortDate(plan.income.date);
  const { projection } = plan;
  const hasWaiting = plan.items.some((i) => i.action === 'wait' || i.action === 'partial');
  const status = plan.isShort ? STATUS.short : hasWaiting || projection.closing < 0 ? STATUS.tight : STATUS.ok;
  let n = 0;

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Qué hacer hoy</h2>
          <p className="text-sm text-[color:var(--text-muted)]">
            Plata a hoy <strong className="text-[color:var(--text)]"><Money n={plan.cash} /></strong>
            {projection.upcoming > 0 && (
              <>
                {' '}· Por recibir <Money n={projection.upcoming} />
              </>
            )}
          </p>
        </div>
        <span className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold ${status.className}`}>{status.label}</span>
      </div>

      {plan.missingDueDates.length > 0 && (
        <div className="mt-3 rounded-xl border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10 px-3 py-2 text-sm">
          Define la fecha de pago de {listNames(plan.missingDueDates)} más abajo, en Presupuestos por categoría (campo «Vence el día» de cada gasto fijo). Mientras tanto se cuenta
          {plan.missingDueDates.length === 1 ? '' : 'n'} como si venciera{plan.missingDueDates.length === 1 ? '' : 'n'} antes del{' '}
          {incomeDay}.
        </div>
      )}

      <ol className="mt-4 space-y-4">
        {plan.isShort && (
          <Step n={++n} title="No pagues cuentas todavía">
            <p className="text-sm">
              Lo que tienes no alcanza para lo prioritario hasta el {incomeDay}: faltan{' '}
              <strong className="text-[color:var(--danger)]"><Money n={-plan.free} /></strong>. Gasta solo en lo esencial y pide
              plazo en lo que venza antes.
            </p>
          </Step>
        )}

        {!plan.isShort &&
          (plan.payToday.length > 0 ? (
            <Step n={++n} title={<>Paga hoy <Money n={plan.payToday.reduce((s, i) => s + i.payNow, 0)} /></>}>
              <ul className="divide-y divide-[color:var(--divider)]">
                {plan.payToday.map((item) => (
                  <BillRow key={item.key} item={item} incomeDay={incomeDay} onPay={pay} />
                ))}
              </ul>
            </Step>
          ) : (
            <Step n={++n} title="Hoy no vence nada">
              <p className="text-sm text-[color:var(--text-muted)]">No tienes pagos atrasados ni que venzan hoy.</p>
            </Step>
          ))}

        {plan.beforeIncome.length > 0 && (
          <Step n={++n} title={<>Paga antes del {incomeDay}: <Money n={plan.beforeIncome.reduce((s, i) => s + i.pending, 0)} /></>}>
            <ul className="divide-y divide-[color:var(--divider)]">
              {plan.beforeIncome.map((item) => (
                <BillRow key={item.key} item={item} incomeDay={incomeDay} onPay={pay} />
              ))}
            </ul>
          </Step>
        )}

        {plan.reserve > 0 && (
          <Step n={++n} title={<>Aparta <Money n={plan.reserve} /> para lo prioritario</>}>
            <p className="text-sm">
              Para {listNames(plan.essentials.map((e) => e.category))}: no más de{' '}
              <strong><Money n={plan.dailyEssentials} /> por día</strong> hasta el {incomeDay}.
            </p>
          </Step>
        )}

        {!plan.isShort && (
          <Step n={++n} title={<>Libre hasta el {incomeDay}: <Money n={plan.freeUntilIncome} /></>}>
            <p className="text-sm text-[color:var(--text-muted)]">
              Es lo que queda después de apartar y de pagar lo que vence antes
              {plan.income.amount > 0 && (
                <>
                  {' '}del ingreso de <Money n={plan.income.amount} />
                </>
              )}
              . No es plata extra: también cubre el resto de tu presupuesto del mes.
            </p>
          </Step>
        )}

        <Step
          n={++n}
          title={
            <>
              Al cierre del periodo:{' '}
              <span className={projection.closing < 0 ? 'text-[color:var(--danger)]' : 'text-[color:var(--success)]'}>
                {projection.closing >= 0 ? '+' : ''}
                <Money n={projection.closing} />
              </span>
            </>
          }
        >
          {projection.closing >= 0 ? (
            <p className="text-sm text-[color:var(--text-muted)]">Si gastas según tu presupuesto, cierras el periodo con ese margen.</p>
          ) : (
            <div className="mt-1 rounded-xl border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 px-3 py-2 text-sm">
              Con tu presupuesto actual te faltarían <strong><Money n={-projection.closing} /></strong>.
              {projection.cuts.length > 0 && (
                <>
                  {' '}Recorta:{' '}
                  {projection.cuts.map((c, i) => (
                    <span key={c.category}>
                      {i > 0 ? ', ' : ''}
                      {c.category} <strong><Money n={c.cut} /></strong>
                    </span>
                  ))}
                  .
                </>
              )}
              {projection.uncovered > 0 && (
                <>
                  {' '}Aun así faltan <Money n={projection.uncovered} />: revisa también las categorías prioritarias.
                </>
              )}
            </div>
          )}
        </Step>
      </ol>

      {plan.afterIncome.length > 0 && (
        <details className="mt-4 rounded-xl border border-[color:var(--border)] px-3 py-2 text-sm">
          <summary className="cursor-pointer text-[color:var(--text-muted)]">
            Después del {incomeDay} ({plan.afterIncome.length}): <Money n={plan.afterIncome.reduce((s, i) => s + i.pending, 0)} />
          </summary>
          <ul className="divide-y divide-[color:var(--divider)]">
            {plan.afterIncome.map((item) => (
              <BillRow key={item.key} item={item} incomeDay={incomeDay} />
            ))}
          </ul>
        </details>
      )}

      <details className="mt-2 rounded-xl border border-[color:var(--border)] px-3 py-2 text-sm">
        <summary className="cursor-pointer text-[color:var(--text-muted)]">¿Cómo lo calculé?</summary>
        <div className="mt-2 space-y-1 text-xs text-[color:var(--text-muted)]">
          <p>
            Próximo ingreso: {incomeDay} ({plan.days} {plan.days === 1 ? 'día' : 'días'}).
            {plan.income.isEstimated &&
              ' No hay uno registrado con fecha futura, así que supuse el inicio del próximo periodo. Regístralo en Movimientos con su fecha.'}
          </p>
          {plan.essentials.map((e) => (
            <p key={e.category}>
              {e.category}:{' '}
              {e.available === null ? (
                'promedio de los últimos 90 días'
              ) : (
                <>
                  disponible <Money n={e.available} /> ÷ {plan.daysLeftInPeriod} días que quedan
                </>
              )}{' '}
              = <Money n={e.daily} /> por día × {plan.days} = <Money n={e.reserve} />
            </p>
          ))}
          <p>
            Libre: <Money n={plan.cash} /> − <Money n={plan.reserve} /> apartado − <Money n={plan.payNowTotal} /> en pagos ={' '}
            <Money n={plan.freeUntilIncome} />
          </p>
          <p>
            Cierre: <Money n={projection.cash} /> + <Money n={projection.upcoming} /> por recibir − <Money n={projection.fixedPending} />{' '}
            fijos − <Money n={projection.commitmentsPending} /> cuotas y aportes − <Money n={projection.variableAvailable} /> por
            gastar en categorías variables = <Money n={projection.closing} />
          </p>
          <p>
            Los gastos fijos se pagan una vez en su fecha. Solo las categorías prioritarias que no son fijas se reservan por día.
            La fecha de cada gasto fijo se define aquí en Plan; las prioridades, en Ajustes &gt; Categorías.
          </p>
        </div>
      </details>
    </Card>
  );
}
