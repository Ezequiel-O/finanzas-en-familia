// src/features/commitments/CommitmentsPage.jsx
// Pestaña "Compromisos": une Deudas y Ahorro. Arriba, la vista de largo plazo
// (cuota N de M, fecha de término, avance de metas); abajo, la gestión completa
// que ya existía en cada módulo.
import { useMemo } from 'react';
import { Card } from '../../components/ui/Card.jsx';
import { Money } from '../../components/ui/Money.jsx';
import { Progress } from '../../components/ui/Progress.jsx';
import { promptAmount, toast } from '../../components/feedback/feedback.js';
import { formatCLP } from '../../domain/money.js';
import {
  buildDebtPaidIndex,
  buildSavingContributionTransaction,
  buildSavingWithdrawalTransaction,
  buildSavingsPaidIndex,
  commitmentsForPeriod,
  debtProgress,
  savingProgress,
  summarizeCommitments,
} from '../../domain/commitments.js';
import { formatMonthYear } from '../../domain/dates.js';
import { Debts } from '../../modules/debts/Debts.jsx';
import { Savings } from '../../modules/savings/Savings.jsx';
import { periodLedger } from '../../domain/ledger.js';

const SECTIONS = [
  { id: 'debts', label: 'Cuotas y deudas' },
  { id: 'savings', label: 'Metas de ahorro' },
];

const MILESTONE_TEXT = {
  25: '¡Ya llevas un cuarto!',
  50: '¡Vas en la mitad!',
  75: '¡Queda poco!',
  100: '¡Meta cumplida! 🎉',
};

function DebtsOverview({ debts, transactions, periodKey, cutDay, income }) {
  const index = useMemo(() => buildDebtPaidIndex(transactions), [transactions]);
  const active = debts.filter((d) => d && !d.archived);
  const progress = active.map((d) => debtProgress(d, index)).filter((p) => p.isSubscription || !p.isPaidOff);
  const totalRemaining = progress.reduce((s, p) => s + p.remaining, 0);
  const allItems = commitmentsForPeriod({ debts: active, transactions, periodKey, cutDay });
  // Las suscripciones son gasto fijo, no deuda: no cuentan en la carga financiera.
  const month = summarizeCommitments(allItems.filter((i) => i.kind === 'debt'));
  const subscriptions = summarizeCommitments(allItems.filter((i) => i.kind === 'subscription'));
  const share = income > 0 ? Math.round((month.planned / income) * 100) : null;
  const totalInterest = progress.reduce((s, p) => s + p.interest, 0);

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <div className="text-xs uppercase text-[color:var(--text-muted)]">Total adeudado</div>
          <div className="text-2xl font-bold"><Money n={totalRemaining} /></div>
          <div className="text-xs text-[color:var(--text-muted)]">
            calculado desde tus pagos registrados
            {totalInterest > 0 && (
              <>
                {' '}· incluye <Money n={totalInterest} /> de intereses
              </>
            )}
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase text-[color:var(--text-muted)]">Cuotas de este periodo</div>
          <div className="text-2xl font-bold"><Money n={month.planned} /></div>
          <div className="text-xs text-[color:var(--text-muted)]">
            pendiente <Money n={month.pending} />
            {month.overdue > 0 && (
              <span className="text-[color:var(--danger)]"> · atrasado <Money n={month.overdue} /></span>
            )}
            {subscriptions.planned > 0 && (
              <div>
                + suscripciones <Money n={subscriptions.planned} /> (gasto fijo, no deuda)
              </div>
            )}
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase text-[color:var(--text-muted)]">Carga financiera</div>
          <div className={`text-2xl font-bold ${share !== null && share > 40 ? 'text-[color:var(--warning)]' : ''}`}>
            {share === null ? '—' : `${share}%`}
          </div>
          <div className="text-xs text-[color:var(--text-muted)]">
            {share === null ? 'registra tus ingresos para calcularlo' : 'de tus ingresos va a cuotas de deudas · ideal ≤ 30%'}
          </div>
        </Card>
      </div>

      {progress.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {progress.map((p) => (
            <Card key={p.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{p.name}</div>
                  <div className="text-xs text-[color:var(--text-muted)]">
                    {p.isSubscription
                      ? 'Suscripción mensual'
                      : `${p.paidCount} de ${p.quotaCount} cuotas pagadas${p.endDate ? ` · terminas en ${formatMonthYear(p.endDate)}` : ''}`}
                  </div>
                </div>
                {!p.isSubscription && (
                  <div className="text-right">
                    <div className="text-xs text-[color:var(--text-muted)]">Saldo</div>
                    <div className="font-semibold"><Money n={p.remaining} /></div>
                  </div>
                )}
              </div>
              {!p.isSubscription && (
                <div className="mt-2">
                  <Progress value={p.ratio * 100} mode="good" />
                </div>
              )}
              {p.interest > 0 && (
                <div className="mt-2 text-xs text-[color:var(--text-muted)]">
                  Costo del crédito: <strong className="text-[color:var(--text)]"><Money n={p.interest} /></strong> sobre el monto original
                </div>
              )}
              {p.overdueCount > 0 && (
                <div className="mt-2 text-xs font-semibold text-[color:var(--danger)]">
                  {p.overdueCount} {p.overdueCount === 1 ? 'cuota atrasada' : 'cuotas atrasadas'} · <Money n={p.overdueAmount} />
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function SavingsOverview({ savings, transactions, periodKey, cutDay, actions, activeUser }) {
  const index = useMemo(() => buildSavingsPaidIndex(transactions, savings, cutDay), [transactions, savings, cutDay]);

  async function move(goal, kind) {
    const saving = savings.find((s) => s.id === goal.id);
    if (!saving || !actions?.addTransaction) return;
    const isWithdrawal = kind === 'withdraw';
    const amount = await promptAmount(
      isWithdrawal
        ? `¿Cuánto sacas de "${goal.name}"? La meta bajará y la plata vuelve a tu saldo (no cuenta como ingreso).`
        : `¿Cuánto aportas a "${goal.name}"? Sale de tu saldo y no cuenta como gasto de consumo.`,
      {
        title: isWithdrawal ? 'Retirar de la meta' : 'Aportar a la meta',
        confirmLabel: isWithdrawal ? 'Retirar' : 'Aportar',
        max: isWithdrawal ? Math.max(0, Math.round(goal.saved)) : null,
      },
    );
    if (!amount) return;
    const payload = isWithdrawal
      ? buildSavingWithdrawalTransaction({ saving, amount, user: activeUser })
      : buildSavingContributionTransaction({ saving, amount, user: activeUser });
    const id = await actions.addTransaction(payload);
    if (id) {
      toast.success(
        isWithdrawal
          ? `Retiraste ${formatCLP(amount)} de ${goal.name}.`
          : `Aportaste ${formatCLP(amount)} a ${goal.name}.`,
      );
    }
  }
  const goals = savings.map((s) => savingProgress(s, index, { periodKey, cutDay }));
  if (!goals.length) return null;
  const totalSaved = goals.reduce((s, g) => s + g.saved, 0);

  return (
    <div className="grid gap-4">
      <Card>
        <div className="text-xs uppercase text-[color:var(--text-muted)]">Total ahorrado en metas</div>
        <div className="text-2xl font-bold"><Money n={totalSaved} /></div>
      </Card>
      <div className="grid gap-3 md:grid-cols-2">
        {goals.map((g) => (
          <Card key={g.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-semibold">{g.name}</div>
                <div className="text-xs text-[color:var(--text-muted)]">
                  <Money n={g.saved} /> de <Money n={g.goal} />
                  {g.targetDate ? ` · meta ${formatMonthYear(g.targetDate)}` : ''}
                </div>
              </div>
              <div className="text-right text-sm font-semibold">{Math.round(g.ratio * 100)}%</div>
            </div>
            <div className="mt-2">
              <Progress value={g.ratio * 100} mode="good" />
            </div>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => move(g, 'contribute')}
                className="min-h-[36px] px-3 rounded-lg bg-[color:var(--primary)] text-[color:var(--primary-contrast)] text-xs font-semibold"
              >
                Aportar
              </button>
              {g.saved > 0 && (
                <button
                  type="button"
                  onClick={() => move(g, 'withdraw')}
                  className="min-h-[36px] px-3 rounded-lg border border-[color:var(--border)] text-xs font-semibold"
                >
                  Retirar
                </button>
              )}
            </div>
            <div className="mt-2 text-xs text-[color:var(--text-muted)]">
              {g.isComplete ? (
                MILESTONE_TEXT[100]
              ) : (
                <>
                  {MILESTONE_TEXT[g.milestone] ? `${MILESTONE_TEXT[g.milestone]} ` : ''}
                  {g.periodsLeft > 0 ? (
                    <>
                      Ahorra <strong className="text-[color:var(--text)]"><Money n={g.suggestedPerPeriod} /></strong> por mes para llegar a tiempo.
                    </>
                  ) : g.targetDate ? (
                    <span className="text-[color:var(--warning)]">La fecha meta ya pasó: te faltan <Money n={g.remaining} />.</span>
                  ) : (
                    <>Te faltan <Money n={g.remaining} />.</>
                  )}
                </>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function CommitmentsPage({ section, onSectionChange, data, actions, monthKeyStr }) {
  const active = section === 'savings' ? 'savings' : 'debts';
  const { debts = [], savings = [], transactions = [], budgetCutDay = 1 } = data || {};
  // Ingreso real del periodo (sin ajustes de conciliación ni retiros de ahorro).
  const income = useMemo(
    () => periodLedger({ transactions, periodKey: monthKeyStr, cutDay: budgetCutDay, debts }).income,
    [transactions, monthKeyStr, budgetCutDay, debts],
  );

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Compromisos</h1>
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-[color:var(--surface-2)] p-1" role="tablist" aria-label="Tipo de compromiso">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={active === s.id}
              onClick={() => onSectionChange(s.id)}
              className={`min-h-[40px] rounded-lg px-3 text-sm font-semibold ${
                active === s.id ? 'bg-[color:var(--surface-1)] shadow-sm' : 'text-[color:var(--text-muted)]'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {active === 'debts' ? (
        <>
          <DebtsOverview debts={debts} transactions={transactions} periodKey={monthKeyStr} cutDay={budgetCutDay} income={income} />
          <Debts data={{ debts, transactions, budgetCutDay, activeUser: data?.activeUser }} actions={actions} monthKeyStr={monthKeyStr} />
        </>
      ) : (
        <>
          <SavingsOverview
            savings={savings}
            transactions={transactions}
            periodKey={monthKeyStr}
            cutDay={budgetCutDay}
            actions={actions}
            activeUser={data?.activeUser}
          />
          <Savings data={{ savings, transactions, budgetCutDay }} actions={actions} monthKeyStr={monthKeyStr} />
        </>
      )}
    </div>
  );
}
