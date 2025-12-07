// src/modules/transactions/Transactions.jsx
import React, { useState, useMemo, useEffect } from 'react';
import { monthKey, formatBudgetPeriodLabel } from '../../utils/budgetPeriod.js';
import { filterTransactionsByPeriodAndUser } from '../../utils/transactions.js';
import { Card } from '../../components/ui/card.jsx';
import { SectionTitle } from '../../components/ui/SectionTitle.jsx';
import { Money } from '../../components/ui/money.jsx';
// si usas Progress aquí, agrega:
// import { Progress } from '../../components/ui/Progress.jsx';

// si dentro de Transactions usas CATEGORIES:
import { CATEGORIES } from '../../constants.js';
// si usas helpers de periodo (monthKey, getBudgetPeriod, etc.) y ya los moviste a lib:
// import { getBudgetPeriod } from '../../lib/budgetPeriod.js';

export function Transactions({
  data,
  actions,
  activeUser,
  monthKeyStr,
  superAdminEmail,
  budgetCutDay,
}) {
  const { transactions = [], categories = [], debts = [] } = data || {};

  const debtsArray = Array.isArray(debts) ? debts : [];

  const currentPeriodKey = useMemo(
    () => monthKeyStr || monthKey(new Date()),
    [monthKeyStr],
  );

  // Suma de: (cuota planificada - pagado) de todos los periodos <= actual
  const suggestedDebtAmount = useMemo(() => {
    if (!currentPeriodKey) return 0;

    return debtsArray
      .flatMap((d) => (Array.isArray(d.schedule) ? d.schedule : []))
      .filter((q) => q.periodKey && q.periodKey <= currentPeriodKey)
      .reduce((sum, q) => {
        const planned = Number(q.plannedAmount || 0);
        const paid = Number(q.paidAmount || 0);
        const remaining = planned - paid;
        return remaining > 0 ? sum + remaining : sum;
      }, 0);
  }, [debtsArray, currentPeriodKey]);

  const { addTransaction, removeTransaction } = actions || {};

  const [type, setType] = useState('gasto'); // gasto | ingreso
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState(categories[0] || '');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState('');
  const [showOnlyMine, setShowOnlyMine] = useState(false);
  const [filterType, setFilterType] = useState('todos'); // todos | ingresos | gastos
  const [filterCategory, setFilterCategory] = useState('todas');
  const [showIngresoModal, setShowIngresoModal] = useState(false);
  const [showGastoModal, setShowGastoModal] = useState(false);
  const [amountFormatted, setAmountFormatted] = useState('');

  // Cuando abres "Nuevo gasto" con categoría Deuda, autocompleta el monto
  useEffect(() => {
    const isDebtCategory = category === 'Deuda'; // usa EXACTAMENTE el nombre que tengas en tu lista de categorías
    const modalOpen = showGastoModal;

    if (!modalOpen) return; // solo cuando está abierto el modal de gasto
    if (type !== 'gasto') return; // solo en gastos
    if (!isDebtCategory) return; // solo si la categoría es Deuda
    if (suggestedDebtAmount <= 0) return;

    // Si ya escribió un monto, no lo tocamos
    if (amount && Number(amount) > 0) return;

    const n = Math.round(suggestedDebtAmount);
    const digits = String(n);
    const formatted = new Intl.NumberFormat('es-CL', {
      maximumFractionDigits: 0,
    }).format(n);

    setAmount(digits); // valor "real" sin formato
    setAmountFormatted(formatted); // valor mostrado con puntos
  }, [showGastoModal, type, category, suggestedDebtAmount, amount]);

  const periodLabel = useMemo(
    () => formatBudgetPeriodLabel(monthKeyStr, budgetCutDay),
    [monthKeyStr, budgetCutDay],
  );

  const filtered = useMemo(() => {
    let base = filterTransactionsByPeriodAndUser(
      transactions,
      monthKeyStr,
      budgetCutDay,
      activeUser,
      showOnlyMine,
    );

    if (filterType !== 'todos') {
      base = base.filter((tx) =>
        filterType === 'ingresos' ? tx.type === 'ingreso' : tx.type === 'gasto',
      );
    }

    if (filterCategory !== 'todas') {
      base = base.filter((tx) => tx.category === filterCategory);
    }

    // Orden descendente por fecha (más reciente arriba)
    base.sort((a, b) => {
      const da = new Date(
        (a.date || a.createdAt || '1970-01-01') + 'T00:00:00',
      ).getTime();
      const db = new Date(
        (b.date || b.createdAt || '1970-01-01') + 'T00:00:00',
      ).getTime();
      return db - da;
    });

    return base;
  }, [
    transactions,
    monthKeyStr,
    budgetCutDay,
    activeUser,
    showOnlyMine,
    filterType,
    filterCategory,
  ]);

  const totals = useMemo(() => {
    let ingresos = 0;
    let gastos = 0;

    for (const tx of filtered) {
      const amt = Number(tx.amount || 0);
      if (tx.type === 'ingreso') ingresos += amt;
      if (tx.type === 'gasto') gastos += amt;
    }

    return {
      ingresos,
      gastos,
      balance: ingresos - gastos,
    };
  }, [filtered]);

  function getOwnerName(tx) {
    if (tx.ownerName) return tx.ownerName;
    if (tx.ownerEmail && tx.ownerEmail === superAdminEmail) return 'Admin';
    if (tx.ownerEmail) return tx.ownerEmail.split('@')[0];
    return '—';
  }

  async function handleAdd(e) {
    e.preventDefault();

    const n = Number(amount || 0);
    if (!n || n <= 0 || !addTransaction) {
      alert('Ingresa un monto válido.');
      return;
    }

    const normalized = {
      type,
      amount: n,
      category: type === 'gasto' ? category || categories[0] || 'Otros' : '',
      description: description.trim(),
      date: date || new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
      ownerId: activeUser?.id || null,
      ownerName: activeUser?.name || null,
      ownerEmail: activeUser?.email || null,
    };

    try {
      await addTransaction(normalized);
      setAmount('');
      setDescription('');
      setShowIngresoModal(false);
      setShowGastoModal(false);
    } catch (err) {
      console.error('Error al agregar movimiento:', err);
      alert('No se pudo guardar el movimiento.');
    }
  }

  return (
    <div className="max-w-6xl mx-auto py-6 px-4 space-y-6">
      <SectionTitle
        right={
          <div className="flex gap-2">
            <button
              type="button"
              className="px-4 py-1.5 rounded-full text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 transition"
              onClick={() => {
                setType('ingreso');
                setShowIngresoModal(true);
              }}
            >
              + Ingreso
            </button>

            <button
              type="button"
              className="px-4 py-1.5 rounded-full text-xs font-medium bg-red-600 text-white hover:bg-red-700 transition"
              onClick={() => {
                setType('gasto');
                setShowGastoModal(true);
              }}
            >
              + Gasto
            </button>
          </div>
        }
      >
        Movimientos del periodo
      </SectionTitle>

      {/* Resumen superior */}
      <div className="grid md:grid-cols-3 gap-4">
        <Card>
          <div className="text-xs uppercase text-gray-500 mb-1">Ingresos</div>
          <div className="text-lg font-semibold">
            <Money n={totals.ingresos} />
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase text-gray-500 mb-1">Gastos</div>
          <div className="text-lg font-semibold">
            <Money n={totals.gastos} />
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase text-gray-500 mb-1">Balance</div>
          <div
            className={`text-lg font-semibold ${
              totals.balance < 0 ? 'text-red-600' : 'text-green-600'
            }`}
          >
            <Money n={totals.balance} />
          </div>
        </Card>
      </div>

      {/* Filtros */}
      <Card>
        <div className="flex flex-wrap gap-3 items-center mb-4">
          <span className="text-sm font-medium">Filtros:</span>

          <select
            className="border rounded-lg px-2 py-1 text-sm"
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
          >
            <option value="todos">Todos</option>
            <option value="ingresos">Solo ingresos</option>
            <option value="gastos">Solo gastos</option>
          </select>

          <select
            className="border rounded-lg px-2 py-1 text-sm"
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
          >
            <option value="todas">Todas las categorías</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              className="rounded"
              checked={showOnlyMine}
              onChange={(e) => setShowOnlyMine(e.target.checked)}
            />
            Solo mis movimientos
          </label>
        </div>
      </Card>

      {/* Tabla de movimientos */}
      <Card>
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-semibold">Listado de movimientos</h3>
          <span className="text-xs text-gray-500">
            {filtered.length} movimiento{filtered.length === 1 ? '' : 's'}
          </span>
        </div>

        {filtered.length === 0 ? (
          <div className="text-sm text-gray-500">
            No hay movimientos para el periodo y filtros seleccionados.
          </div>
        ) : (
          <div className="overflow-x-auto -mx-2">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-gray-500">
                  <th className="px-2 py-1 text-left">Fecha</th>
                  <th className="px-2 py-1 text-left">Descripción</th>
                  <th className="px-2 py-1 text-left">Categoría</th>
                  <th className="px-2 py-1 text-left">Tipo</th>
                  <th className="px-2 py-1 text-right">Monto</th>
                  <th className="px-2 py-1 text-left">Usuario</th>
                  <th className="px-2 py-1"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((tx) => (
                  <tr key={tx.id} className="border-b last:border-0">
                    <td className="px-2 py-1 align-top">
                      {(tx.date || '').slice(0, 10)}
                    </td>
                    <td className="px-2 py-1 align-top">
                      {tx.description || (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1 align-top">
                      {tx.category || <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-2 py-1 align-top">
                      {tx.type === 'ingreso' ? 'Ingreso' : 'Gasto'}
                    </td>
                    <td className="px-2 py-1 align-top text-right">
                      <Money n={tx.amount} />
                    </td>
                    <td className="px-2 py-1 align-top text-xs text-gray-500">
                      {getOwnerName(tx)}
                    </td>
                    <td className="px-2 py-1 align-top text-right">
                      {removeTransaction && (
                        <button
                          className="text-xs text-red-600"
                          onClick={() => removeTransaction(tx.id)}
                        >
                          Eliminar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {(showIngresoModal || showGastoModal) && (
        <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/30 pt-16">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl p-5 w-full max-w-xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">
                {type === 'ingreso' ? 'Nuevo ingreso' : 'Nuevo gasto'}
              </h3>
              <button
                type="button"
                className="text-sm text-gray-500 hover:text-gray-800"
                onClick={() => {
                  setShowIngresoModal(false);
                  setShowGastoModal(false);
                }}
              >
                ✕ Cerrar
              </button>
            </div>

            <form onSubmit={handleAdd} className="grid gap-3">
              {/* Monto – siempre primero */}
              {/* Monto con formateo dinámico */}
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500">Monto</label>

                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">$</span>

                  <input
                    type="text"
                    className="border rounded-lg px-2 py-1 text-sm flex-1"
                    value={amountFormatted}
                    onChange={(e) => {
                      const raw = e.target.value;

                      // Solo números
                      const digits = raw.replace(/\D/g, '');

                      // Si no hay dígitos, dejamos el campo vacío
                      if (!digits) {
                        setAmountFormatted('');
                        setAmount('');
                        return;
                      }

                      // Formatear CLP con puntos de miles
                      const formatted = new Intl.NumberFormat('es-CL', {
                        maximumFractionDigits: 0,
                      }).format(Number(digits));

                      setAmountFormatted(formatted);
                      setAmount(digits); // valor real sin formato
                    }}
                    placeholder="0"
                  />
                </div>
              </div>

              {/* Fecha – siempre segundo */}
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500">Fecha</label>
                <input
                  type="date"
                  className="border rounded-lg px-2 py-1 text-sm"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </div>

              {/* Categoría – SOLO para gasto, y va DESPUÉS de la fecha */}
              {type === 'gasto' && (
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-gray-500">Categoría</label>
                  <select
                    className="border rounded-lg px-2 py-1 text-sm"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                  >
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Descripción + botón – al final en ambos casos */}
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500">Descripción</label>
                <div className="flex gap-2">
                  <input
                    className="border rounded-lg px-2 py-1 text-sm flex-1"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Ej: sueldo, supermercado, benzina, etc."
                  />
                  <button
                    type="submit"
                    className="px-3 py-1.5 rounded-xl border bg-gray-900 text-white text-sm"
                  >
                    Agregar
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
