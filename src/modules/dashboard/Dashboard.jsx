// src/modules/dashboard/Dashboard.jsx
import { Card } from '../../components/ui/card.jsx';
import { SectionTitle } from '../../components/ui/SectionTitle.jsx';
import { Money } from '../../components/ui/money.jsx';
import { Progress } from '../../components/ui/Progress.jsx';
import { CATEGORIES } from '../../constants.js';
import { filterTransactionsByPeriodAndUser } from '../../utils/transactions.js';

export function Dashboard({ data, monthKeyStr }) {
  const {
    categories = CATEGORIES,
    budgets = {},
    transactions = [],
    debts = [],
    savings = [],
    budgetCutDay = 1,
    activeUserPreferences,
  } = data || {};

  const mk = monthKeyStr;

  // Filtramos movimientos del periodo actual (según día de corte)
  const monthTx = filterTransactionsByPeriodAndUser(
    transactions,
    mk,
    budgetCutDay,
    null,
    false,
  );

  const totalIngresos = monthTx
    .filter((t) => t.type === 'ingreso')
    .reduce((a, b) => a + Number(b.amount || 0), 0);

  const totalGastos = monthTx
    .filter((t) => t.type === 'gasto')
    .reduce((a, b) => a + Number(b.amount || 0), 0);

  const balance = totalIngresos - totalGastos;

  const cats = categories && categories.length ? categories : CATEGORIES;

  const catSpend = cats.reduce((acc, c) => {
    const spent = monthTx
      .filter((t) => t.type === 'gasto' && t.category === c)
      .reduce((a, b) => a + Number(b.amount || 0), 0);

    const b = budgets?.[c];
    let plan = 0;
    let funded = 0;

    if (typeof b === 'number') {
      plan = funded = Number(b || 0);
    } else if (b && typeof b === 'object') {
      plan = Number(b.plan || 0);
      funded = Number(b.funded !== undefined ? b.funded : b.plan || 0);
    }

    const pctFundedUsed = funded > 0 ? (spent / funded) * 100 : 0;

    acc[c] = { spent, plan, funded, pctFundedUsed };
    return acc;
  }, {});

  const pctIngresosVsGastos =
    totalIngresos > 0 ? (totalGastos / totalIngresos) * 100 : 0;

  const debtTotals = debts.reduce(
    (acc, d) => {
      acc.original += Number(d.original || 0);
      acc.remaining += Number(d.remaining || 0);
      return acc;
    },
    { original: 0, remaining: 0 },
  );

  const debtProgress =
    debtTotals.original > 0
      ? ((debtTotals.original - debtTotals.remaining) / debtTotals.original) *
        100
      : 0;

  const savingsTotals = savings.reduce(
    (acc, s) => {
      acc.goal += Number(s.goal || 0);
      acc.saved += Number(s.saved || 0);
      return acc;
    },
    { goal: 0, saved: 0 },
  );

  const savingsProgress =
    savingsTotals.goal > 0
      ? (savingsTotals.saved / savingsTotals.goal) * 100
      : 0;

  const cardsPrefs = activeUserPreferences?.dashboardCards || {};
  const showResumenMes = cardsPrefs.resumenMes ?? true;
  const showDeudas = cardsPrefs.deudas ?? true;
  const showAhorro = cardsPrefs.ahorro ?? true;
  const showPresupuestos = cardsPrefs.presupuestos ?? true;
  // IMPORTANTE: ya NO usamos tarjetas de inversiones en el dashboard

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {showResumenMes && (
        <Card>
          <SectionTitle>Resumen del mes</SectionTitle>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span>Ingresos</span>
              <strong>
                <Money n={totalIngresos} />
              </strong>
            </div>
            <div className="flex justify-between">
              <span>Gastos</span>
              <strong>
                <Money n={totalGastos} />
              </strong>
            </div>
            <div
              className={`flex justify-between ${
                balance >= 0 ? 'text-green-700' : 'text-red-600'
              }`}
            >
              <span>Balance</span>
              <strong>
                <Money n={balance} />
              </strong>
            </div>
            <div>
              <div className="text-sm mb-1">% Gastado sobre ingresos</div>
              <Progress value={pctIngresosVsGastos} />
            </div>
            <div className="text-xs text-gray-500">
              Día de corte del mes: {budgetCutDay}
            </div>
          </div>
        </Card>
      )}

      {showDeudas && (
        <Card>
          <SectionTitle>Progreso de deudas</SectionTitle>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span>Total original</span>
              <strong>
                <Money n={debtTotals.original} />
              </strong>
            </div>
            <div className="flex justify-between">
              <span>Saldo pendiente</span>
              <strong>
                <Money n={debtTotals.remaining} />
              </strong>
            </div>
            <div>
              <div className="text-sm mb-1">% pagado</div>
              <Progress value={debtProgress} mode="good" />
            </div>
          </div>
        </Card>
      )}

      {showAhorro && (
        <Card>
          <SectionTitle>Ahorro</SectionTitle>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span>Meta total</span>
              <strong>
                <Money n={savingsTotals.goal} />
              </strong>
            </div>
            <div className="flex justify-between">
              <span>Ahorro actual</span>
              <strong>
                <Money n={savingsTotals.saved} />
              </strong>
            </div>
            <div>
              <div className="text-sm mb-1">% de meta alcanzada</div>
              <Progress value={savingsProgress} mode="good" />
            </div>
          </div>
        </Card>
      )}

      {showPresupuestos && (
        <Card className="md:col-span-2 lg:col-span-3">
          <SectionTitle>Presupuestos (progreso por categoría)</SectionTitle>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {cats.map((c) => (
              <div key={c} className="border rounded-xl p-3">
                <div className="flex justify-between text-sm mb-1">
                  <span className="font-medium">{c}</span>
                  <span>
                    Gasto: <Money n={catSpend[c].spent} /> / Presupuesto:{' '}
                    <Money n={catSpend[c].funded} />
                  </span>
                </div>
                <Progress value={catSpend[c].pctFundedUsed} />
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
