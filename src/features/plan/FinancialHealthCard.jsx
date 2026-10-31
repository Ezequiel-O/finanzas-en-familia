// src/features/plan/FinancialHealthCard.jsx
// Patrimonio neto e indicadores estándar del hogar, con el cuadre del periodo.
import { useMemo, useState } from 'react';
import { Card } from '../../components/ui/Card.jsx';
import { Money } from '../../components/ui/Money.jsx';
import { householdHealth } from '../../domain/health.js';
import { LedgerBreakdown } from './LedgerBreakdown.jsx';

const TONE = {
  good: 'text-[color:var(--success)]',
  warn: 'text-[color:var(--warning)]',
  bad: 'text-[color:var(--danger)]',
  none: 'text-[color:var(--text-muted)]',
};

// Referencias habituales de planificación financiera personal.
function rateTone(rate) {
  if (rate === null) return 'none';
  if (rate >= 0.1) return 'good';
  if (rate > 0) return 'warn';
  return 'bad';
}
function loadTone(load) {
  if (load === null) return 'none';
  if (load <= 0.3) return 'good';
  if (load <= 0.4) return 'warn';
  return 'bad';
}
function emergencyTone(months) {
  if (months === null) return 'none';
  if (months >= 3) return 'good';
  if (months >= 1) return 'warn';
  return 'bad';
}

const pct = (v) => (v === null ? '—' : `${Math.round(v * 100)}%`);

function Indicator({ label, value, tone, hint }) {
  return (
    <div className="rounded-xl bg-[color:var(--surface-2)] p-3">
      <div className="text-[11px] uppercase text-[color:var(--text-muted)]">{label}</div>
      <div className={`text-xl font-bold ${TONE[tone]}`}>{value}</div>
      <div className="text-[11px] text-[color:var(--text-faint)]">{hint}</div>
    </div>
  );
}

export function FinancialHealthCard({ data, periodKey }) {
  const { transactions = [], debts = [], savings = [], budgetCutDay = 1, expectedIncome = 0 } = data || {};
  const h = useMemo(
    () => householdHealth({ transactions, debts, savings, periodKey, cutDay: budgetCutDay }),
    [transactions, debts, savings, periodKey, budgetCutDay],
  );
  const [showLedger, setShowLedger] = useState(false);
  const yoy =
    h.lastYearConsumption && h.lastYearConsumption > 0
      ? (h.ledger.consumptionNet - h.lastYearConsumption) / h.lastYearConsumption
      : null;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase text-[color:var(--text-muted)]">Patrimonio neto</div>
          <div className={`text-3xl font-bold ${h.netWorth < 0 ? 'text-[color:var(--danger)]' : ''}`}>
            <Money n={h.netWorth} />
          </div>
          <div className="text-xs text-[color:var(--text-muted)]">
            Saldo <Money n={h.cash} /> + ahorro <Money n={h.savedTotal} /> − deudas <Money n={h.debtRemaining} />
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowLedger((v) => !v)}
          aria-expanded={showLedger}
          className="text-sm font-semibold text-[color:var(--primary)] dark:text-blue-300"
        >
          {showLedger ? 'Ocultar cuadre' : 'Ver cuadre del periodo'}
        </button>
      </div>

      {showLedger && (
        <div className="mt-3 rounded-xl border border-[color:var(--border)] p-3">
          <LedgerBreakdown ledger={h.ledger} expectedIncome={expectedIncome} />
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Indicator
          label="Tasa de ahorro"
          value={pct(h.savingsRate)}
          tone={rateTone(h.savingsRate)}
          hint="ahorro neto / ingresos · meta ≥ 10%"
        />
        <Indicator
          label="Carga financiera"
          value={pct(h.debtLoad)}
          tone={loadTone(h.debtLoad)}
          hint="cuotas del mes / ingresos (sin suscripciones) · ideal ≤ 30%"
        />
        <Indicator
          label="Fondo de emergencia"
          value={h.emergencyMonths === null ? '—' : `${h.emergencyMonths.toFixed(1)} meses`}
          tone={emergencyTone(h.emergencyMonths)}
          hint="ahorro / gasto mensual promedio · meta ≥ 3"
        />
        <Indicator
          label="Consumo vs. año anterior"
          value={yoy === null ? '—' : `${yoy > 0 ? '+' : ''}${Math.round(yoy * 100)}%`}
          tone={yoy === null ? 'none' : yoy > 0.05 ? 'warn' : 'good'}
          hint="mismo periodo del año pasado"
        />
      </div>
    </Card>
  );
}
