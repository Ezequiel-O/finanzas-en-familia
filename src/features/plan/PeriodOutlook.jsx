// src/features/plan/PeriodOutlook.jsx
// "Te quedan $X para N días · ~$Y por día", proyección al cierre y semáforo por categoría.
// Recibe las filas ya calculadas por Presupuestos para que las cifras coincidan con la tabla.
import { Money } from '../../components/ui/Money.jsx';
import { budgetLevel, MIN_PROJECTION_DAYS, spendingOutlook } from '../../domain/budgetHealth.js';
import { isSystemCategory } from '../../domain/categories.js';

const LEVEL_STYLE = {
  ok: 'bg-[color:var(--success)]/15 text-[color:var(--success)] border-[color:var(--success)]/30',
  warn: 'bg-[color:var(--warning)]/15 text-[color:var(--warning)] border-[color:var(--warning)]/40',
  over: 'bg-[color:var(--danger)]/15 text-[color:var(--danger)] border-[color:var(--danger)]/40',
};
const LEVEL_LABEL = { ok: 'Vas bien', warn: 'Cuidado', over: 'Te pasaste' };

const sum = (list, key) => list.reduce((s, r) => s + Number(r[key] || 0), 0);

export function PeriodOutlook({
  rows = [],
  periodKey,
  cutDay = 1,
  income = 0,
  incomeIsExpected = false,
  cashAvailable = null,
  onCopyPrevious,
  copyableCount = 0,
}) {
  const spendRows = rows.filter((r) => !isSystemCategory(r.c));
  const systemRows = rows.filter((r) => isSystemCategory(r.c));
  const fixedRows = spendRows.filter((r) => r.isFixedCategory);
  const planned = sum(spendRows, 'funded');
  const spent = sum(spendRows, 'spent');
  const o = spendingOutlook({
    planned,
    spent,
    periodKey,
    cutDay,
    fixedPlanned: sum(fixedRows, 'funded'),
    fixedSpent: sum(fixedRows, 'spent'),
    cashAvailable,
  });

  // Presupuesto completo (incluye cuotas y ahorro) contra lo que entra en el mes.
  const totalBudget = sum(rows, 'funded');
  const incomeMargin = income - totalBudget;
  // Cuotas y ahorro no se proyectan: cuentan por lo comprometido o lo ya pagado.
  const systemCommitted = systemRows.reduce(
    (s, r) => s + Math.max(Number(r.funded || 0), Number(r.spent || 0)),
    0,
  );
  const projectedIncomeMargin = income - (o.projected + systemCommitted);

  const alerts = spendRows
    .map((r) => ({ c: r.c, level: budgetLevel(r.spent, r.funded), pct: r.funded > 0 ? (r.spent / r.funded) * 100 : null }))
    .filter((r) => r.level === 'warn' || r.level === 'over')
    .sort((a, b) => (b.pct ?? 999) - (a.pct ?? 999));

  if (planned <= 0) {
    return (
      <div className="rounded-2xl border border-dashed border-[color:var(--border)] bg-[color:var(--surface-1)] p-4 text-sm space-y-2">
        <div className="font-semibold">Aún no tienes presupuesto para este periodo</div>
        <p className="text-[color:var(--text-muted)]">
          Define cuánto planeas gastar por categoría y aquí verás cuánto te queda por día.
        </p>
        {copyableCount > 0 && onCopyPrevious && (
          <button
            type="button"
            onClick={onCopyPrevious}
            className="min-h-[44px] px-4 rounded-xl bg-[color:var(--primary)] text-[color:var(--primary-contrast)] text-sm font-semibold"
          >
            Copiar presupuesto del periodo anterior ({copyableCount})
          </button>
        )}
      </div>
    );
  }

  const remainingLabel = o.remaining >= 0 ? 'Te quedan' : 'Te pasaste por';
  return (
    <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-1)] p-4 shadow-[var(--shadow)] space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase text-[color:var(--text-muted)]">{remainingLabel}</div>
          <div className={`text-3xl font-bold ${o.remaining < 0 ? 'text-[color:var(--danger)]' : ''}`}>
            <Money n={Math.abs(o.remaining)} />
          </div>
          <div className="text-sm text-[color:var(--text-muted)]">
            {o.isCurrent ? (
              <>
                para {o.daysLeft} {o.daysLeft === 1 ? 'día' : 'días'}
                {o.perDay > 0 && (
                  <>
                    {' '}· ~<strong className="text-[color:var(--text)]"><Money n={o.perDay} /></strong> por día
                  </>
                )}
              </>
            ) : o.isPast ? (
              'Periodo cerrado'
            ) : (
              'Periodo futuro'
            )}
          </div>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${LEVEL_STYLE[o.level] || LEVEL_STYLE.ok}`}>
          {LEVEL_LABEL[o.level] || 'Vas bien'} · {Math.round((spent / planned) * 100)}% usado
        </span>
      </div>

      {o.limitedByCash && o.remaining > 0 && (
        <div className="rounded-xl border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 px-3 py-2 text-sm">
          {o.cash > 0 ? (
            <>
              Hoy tienes <strong><Money n={o.cash} /></strong> en el bolsillo, menos de lo que te queda de presupuesto. No gastes más de{' '}
              <strong><Money n={o.perDay} /></strong> por día hasta que llegue el próximo ingreso.
            </>
          ) : (
            <>
              Hoy no tienes saldo disponible (<Money n={o.cash} />): evita gastar hasta que llegue tu próximo ingreso.
            </>
          )}
        </div>
      )}

      {income > 0 ? (
        <div
          className={`rounded-xl border px-3 py-2 text-sm ${
            incomeMargin >= 0
              ? 'border-[color:var(--success)]/30 bg-[color:var(--success)]/10'
              : 'border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10'
          }`}
        >
          Tu presupuesto total (<strong><Money n={totalBudget} /></strong>, con cuotas y ahorro){' '}
          {incomeMargin >= 0 ? (
            <>
              está dentro de tus ingresos {incomeIsExpected ? 'esperados' : 'del mes'} (<Money n={income} />): te sobran{' '}
              <strong><Money n={incomeMargin} /></strong> sin asignar.
            </>
          ) : (
            <>
              supera tus ingresos {incomeIsExpected ? 'esperados' : 'del mes'} (<Money n={income} />) por{' '}
              <strong className="text-[color:var(--danger)]"><Money n={-incomeMargin} /></strong>.
            </>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-[color:var(--border)] px-3 py-2 text-sm text-[color:var(--text-muted)]">
          Aún no hay ingresos en este periodo: registra uno o define tu ingreso esperado para saber si el presupuesto te alcanza.
        </div>
      )}

      {o.canProject && o.projectedOver > 0 && (
        <div className="rounded-xl border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10 px-3 py-2 text-sm">
          A este ritmo de gasto variable te pasarías del presupuesto por <strong><Money n={o.projectedOver} /></strong>
          {income > 0 &&
            (projectedIncomeMargin >= 0 ? (
              <>, pero seguirías dentro de tus ingresos (sobrarían <Money n={projectedIncomeMargin} />).</>
            ) : (
              <>
                {' '}y gastarías <strong className="text-[color:var(--danger)]"><Money n={-projectedIncomeMargin} /></strong> más de lo que ingresa.
              </>
            ))}
          {income <= 0 && '.'}
        </div>
      )}
      {o.isCurrent && !o.canProject && (
        <div className="text-xs text-[color:var(--text-muted)]">
          La proyección de cierre aparece desde el día {MIN_PROJECTION_DAYS} del periodo, cuando hay suficiente gasto para estimar tu ritmo.
        </div>
      )}

      {alerts.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Categorías que requieren atención">
          {alerts.slice(0, 6).map((a) => (
            <span key={a.c} className={`rounded-full border px-2.5 py-1 text-xs font-medium ${LEVEL_STYLE[a.level]}`}>
              {a.c} · {a.pct === null ? 'sin presupuesto' : `${Math.round(a.pct)}%`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
