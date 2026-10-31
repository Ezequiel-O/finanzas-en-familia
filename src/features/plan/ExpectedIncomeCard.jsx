// src/features/plan/ExpectedIncomeCard.jsx
// Ingreso mensual esperado vs. recibido: permite planificar antes de que llegue el sueldo.
import { useMemo, useState } from 'react';
import { toast } from '../../components/feedback/feedback.js';
import { Card } from '../../components/ui/Card.jsx';
import { Money } from '../../components/ui/Money.jsx';
import { Progress } from '../../components/ui/Progress.jsx';
import { todayKey } from '../../domain/dates.js';
import { periodIncomeSplit } from '../../domain/ledger.js';
import { formatAmountInput, parseAmount } from '../../domain/money.js';

export function ExpectedIncomeCard({ data, actions, periodKey }) {
  const { transactions = [], budgetCutDay = 1, expectedIncome = 0 } = data || {};
  // Recibido = ya llegó (fecha ≤ hoy). Lo registrado con fecha futura va aparte.
  const { received, upcoming } = useMemo(
    () => periodIncomeSplit({ transactions, periodKey, cutDay: budgetCutDay, today: todayKey() }),
    [transactions, periodKey, budgetCutDay],
  );
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');

  async function save(e) {
    e.preventDefault();
    await actions?.setExpectedIncome?.(parseAmount(value));
    setEditing(false);
    toast.success('Ingreso esperado guardado.');
  }

  const pending = Math.max(0, expectedIncome - received);
  const upcomingLine = upcoming > 0 && (
    <span>
      Por recibir (registrado) <strong className="text-[color:var(--text)]"><Money n={upcoming} /></strong>
    </span>
  );
  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Ingresos del mes</h2>
        {!editing && (
          <button
            type="button"
            className="text-sm font-semibold text-[color:var(--primary)] dark:text-blue-300"
            onClick={() => {
              setValue(expectedIncome ? formatAmountInput(String(expectedIncome)) : '');
              setEditing(true);
            }}
          >
            {expectedIncome ? 'Editar esperado' : 'Definir ingreso esperado'}
          </button>
        )}
      </div>
      {editing ? (
        <form onSubmit={save} className="mt-2 flex flex-wrap gap-2">
          <input
            value={value}
            onChange={(e) => setValue(formatAmountInput(e.target.value))}
            inputMode="numeric"
            placeholder="Ej. 1.200.000"
            aria-label="Ingreso mensual esperado"
            className="flex-1 min-w-[160px] min-h-[44px] rounded-xl border border-[color:var(--border)] bg-[color:var(--input-bg)] px-3 text-sm"
          />
          <button type="submit" className="min-h-[44px] px-4 rounded-xl bg-[color:var(--primary)] text-[color:var(--primary-contrast)] text-sm font-semibold">
            Guardar
          </button>
          <button type="button" className="min-h-[44px] px-3 text-sm text-[color:var(--text-muted)]" onClick={() => setEditing(false)}>
            Cancelar
          </button>
        </form>
      ) : expectedIncome > 0 ? (
        <div className="mt-2 space-y-1">
          <div className="flex flex-wrap justify-between gap-2 text-sm text-[color:var(--text-muted)]">
            <span>
              Recibido <strong className="text-[color:var(--text)]"><Money n={received} /></strong> de <Money n={expectedIncome} />
            </span>
            {upcoming > 0
              ? upcomingLine
              : pending > 0 && (
                  <span>
                    Por recibir <strong className="text-[color:var(--text)]"><Money n={pending} /></strong>
                  </span>
                )}
          </div>
          <Progress value={(received / expectedIncome) * 100} mode="good" />
        </div>
      ) : (
        <div className="mt-1 space-y-1 text-sm text-[color:var(--text-muted)]">
          <div className="flex flex-wrap justify-between gap-2">
            <span>
              Recibido a hoy <strong className="text-[color:var(--text)]"><Money n={received} /></strong>
            </span>
            {upcomingLine}
          </div>
          <p>Define tu ingreso mensual esperado para planificar desde el día 1.</p>
        </div>
      )}
    </Card>
  );
}
