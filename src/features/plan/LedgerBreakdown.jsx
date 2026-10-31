// src/features/plan/LedgerBreakdown.jsx
// Cuadre del periodo: saldo anterior + entradas − salidas ± ajustes = saldo final.
// Se usa igual en Inicio, Plan del mes y Movimientos para que todas muestren lo mismo.
import { Money } from '../../components/ui/Money.jsx';

function Row({ label, value, sign = '', strong = false, muted = false, hint }) {
  if (!strong && !value) return null;
  return (
    <div className={`flex justify-between gap-2 ${strong ? 'border-t border-[color:var(--divider)] pt-1 font-semibold text-[color:var(--text)]' : ''}`}>
      <span className={muted ? 'text-[color:var(--text-faint)]' : ''} title={hint}>
        {sign && <span className="inline-block w-3">{sign}</span>}
        {label}
      </span>
      <strong className={`text-[color:var(--text)] tabular-nums ${value < 0 && strong ? 'text-[color:var(--danger)]' : ''}`}>
        <Money n={value} />
      </strong>
    </div>
  );
}

export function LedgerBreakdown({ ledger, expectedIncome = 0 }) {
  if (!ledger) return null;
  const pendingIncome = Math.max(0, Number(expectedIncome || 0) - ledger.income);
  return (
    <div className="space-y-1 text-xs text-[color:var(--text-muted)]">
      <Row label="Saldo anterior" value={ledger.opening} strong />
      <Row sign="+" label="Ingresos" value={ledger.income} />
      <Row sign="+" label="Reembolsos" value={ledger.refunds} />
      <Row sign="+" label="Retiros de ahorro" value={ledger.savingWithdrawals} />
      <Row sign="−" label="Consumo" value={ledger.consumption} />
      <Row sign="−" label="Suscripciones" value={ledger.subscriptions} />
      <Row sign="−" label="Cuotas de deudas" value={ledger.debtPayments} />
      <Row sign="−" label="Aportes a ahorro" value={ledger.savingContributions} />
      <Row
        sign="±"
        label="Ajustes de conciliación"
        value={ledger.adjustments}
        hint="Diferencias entre la app y tus cuentas reales. No son ingreso ni gasto."
      />
      <Row label="Saldo actual" value={ledger.closing} strong />
      {ledger.transfers > 0 && (
        <div className="text-[10px] text-[color:var(--text-faint)]">
          Traspasos entre miembros (no cambian el saldo del hogar): <Money n={ledger.transfers} />
        </div>
      )}
      {pendingIncome > 0 && (
        <div className="text-[10px] text-[color:var(--text-faint)]">
          Ingreso esperado por recibir: <Money n={pendingIncome} />
        </div>
      )}
    </div>
  );
}
