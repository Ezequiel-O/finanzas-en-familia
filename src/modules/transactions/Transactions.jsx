// src/modules/transactions/Transactions.jsx
import React, { useState, useMemo, useEffect } from 'react';
import {
  monthKey,
  formatBudgetPeriodLabel,
  getBudgetPeriod,
  budgetMonthKeyForDate,
} from '../../utils/budgetPeriod.js';
import { filterTransactionsByPeriodAndUser } from '../../utils/transactions.js';
import { Card } from '../../components/ui/card.jsx';
import { SectionTitle } from '../../components/ui/SectionTitle.jsx';
import { Money } from '../../components/ui/money.jsx';
import { CATEGORIES, DEBT_CATEGORY } from '../../constants.js';

export function Transactions({
  data,
  actions,
  activeUser,
  monthKeyStr,
  superAdminEmail,
  budgetCutDay,
}) {
  const { transactions = [], categories = [], debts = [], budgets = {} } =
    data || {};

  const debtsArray = Array.isArray(debts) ? debts : [];

  const currentPeriodKey = useMemo(
    () => monthKeyStr || monthKey(new Date()),
    [monthKeyStr],
  );
  const trueCurrentPeriod = useMemo(
    () => budgetMonthKeyForDate(new Date().toISOString().slice(0, 10), budgetCutDay),
    [budgetCutDay],
  );

  // Suma de cuotas planificadas restantes para la categoria Deuda
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

  const { addTransaction, updateTransaction, removeTransaction } =
    actions || {};

  const isDebtCategory = (cat) => cat === DEBT_CATEGORY || cat === 'Deuda';

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
  const [editingTx, setEditingTx] = useState(null);
  const [selectedDebtQuotaId, setSelectedDebtQuotaId] = useState('');
  const [selectedSubcategoryIds, setSelectedSubcategoryIds] = useState([]);

  // Calculadora de ajuste de balance
  const [showBalanceModal, setShowBalanceModal] = useState(false);
  const [cashInput, setCashInput] = useState('');
  const [cashFormatted, setCashFormatted] = useState('');
  const [debitInput, setDebitInput] = useState('');
  const [debitFormatted, setDebitFormatted] = useState('');
  const [adjustType, setAdjustType] = useState('ingreso'); // ingreso | gasto
  const [adjustCategory, setAdjustCategory] = useState(
    categories[0] || CATEGORIES[0] || '',
  );
  const [adjustNote, setAdjustNote] = useState('');
  const [adjustError, setAdjustError] = useState('');

  const currencyFormatter = useMemo(
    () => new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }),
    [],
  );

  const formPeriodKey = useMemo(
    () => budgetMonthKeyForDate(date, budgetCutDay),
    [date, budgetCutDay],
  );

  const formPeriodLabel = useMemo(
    () => formatBudgetPeriodLabel(formPeriodKey, budgetCutDay),
    [formPeriodKey, budgetCutDay],
  );

  const budgetSubcategories = useMemo(() => {
    if (!category) return [];
    const catBudget = budgets?.[category];
    const breakdown = Array.isArray(catBudget?.breakdown)
      ? catBudget.breakdown
      : [];
    return breakdown.map((item) => ({
      id: item.id || item.name || Math.random().toString(36).slice(2, 10),
      name: item.name || 'Subcategoria',
      amount: Number(item.amount || 0),
    }));
  }, [budgets, category]);

  // Autocompletar monto de Deuda en modal de gasto
  useEffect(() => {
    const debtSelected = isDebtCategory(category);
    const modalOpen = showGastoModal;

    if (!modalOpen) return;
    if (type !== 'gasto') return;
    if (!debtSelected) return;
    if (suggestedDebtAmount <= 0) return;

    if (amount && Number(amount) > 0) return;

    const n = Math.round(suggestedDebtAmount);
    const digits = String(n);
    const formatted = currencyFormatter.format(n);

    setAmount(digits);
    setAmountFormatted(formatted);
  }, [
    showGastoModal,
    type,
    category,
    suggestedDebtAmount,
    amount,
    currencyFormatter,
  ]);

  // Ajustar categoria de gasto por defecto si cambian las categorias
  useEffect(() => {
    if (!categories || categories.length === 0) return;
    setCategory((prev) => prev || categories[0]);
    setAdjustCategory((prev) => prev || categories[0]);
  }, [categories]);

  useEffect(() => {
    if (type !== 'gasto' || !isDebtCategory(category)) {
      setSelectedDebtQuotaId('');
    }
    if (type !== 'gasto') {
      setSelectedSubcategoryIds([]);
    }
  }, [type, category]);

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

  const platformBalance = totals.balance;
  const cashValue = Number(cashInput || 0);
  const debitValue = Number(debitInput || 0);
  const realBalance = cashValue + debitValue;
  const delta = realBalance - platformBalance;

  useEffect(() => {
    if (!showBalanceModal) return;
    if (delta > 0) setAdjustType('ingreso');
    else if (delta < 0) setAdjustType('gasto');
  }, [delta, showBalanceModal]);

  function getOwnerName(tx) {
    if (tx.ownerName) return tx.ownerName;
    if (tx.ownerEmail && tx.ownerEmail === superAdminEmail) return 'Admin';
    if (tx.ownerEmail) return tx.ownerEmail.split('@')[0];
    return '—';
  }

  function clampDateToPeriod(dateStr) {
    const { start, end } = getBudgetPeriod(monthKeyStr, budgetCutDay);
    if (!dateStr) return start;
    const today = new Date(dateStr + 'T00:00:00');
    const startDate = new Date(start + 'T00:00:00');
    const endDate = new Date(end + 'T00:00:00');
    const endMinusOne = new Date(endDate);
    endMinusOne.setDate(endMinusOne.getDate() - 1);
    if (today < startDate) return start;
    if (today > endMinusOne) return endMinusOne.toISOString().slice(0, 10);
    return today.toISOString().slice(0, 10);
  }

  function formatAmountForInput(value) {
    const n = Number(value || 0);
    if (!n || Number.isNaN(n)) {
      return { digits: '', formatted: '' };
    }
    const rounded = Math.round(n);
    const digits = String(rounded);
    return { digits, formatted: currencyFormatter.format(rounded) };
  }

  function handleMoneyInput(raw, setters) {
    const digits = raw.replace(/\D/g, '');
    if (!digits) {
      setters.setFormatted('');
      setters.setValue('');
      return;
    }
    const formatted = currencyFormatter.format(Number(digits));
    setters.setFormatted(formatted);
    setters.setValue(digits);
  }

  function paidAmountForQuotaId(quotaId) {
    if (!quotaId) return 0;
    return (transactions || []).reduce((sum, t) => {
      const metaId = t?.meta?.debtQuotaId;
      if (metaId !== quotaId) return sum;
      const amt = Number(t.amount || 0);
      return Number.isNaN(amt) ? sum : sum + amt;
    }, 0);
  }

  const debtQuotasForPeriod = useMemo(() => {
    if (!formPeriodKey) return [];
    return debtsArray.flatMap((d) => {
      const schedule = Array.isArray(d.schedule) ? d.schedule : [];
      return schedule
        .filter((q) => q.periodKey === formPeriodKey)
        .map((q) => {
          const paid = paidAmountForQuotaId(q.id);
          const planned = Number(q.plannedAmount || 0);
          const isPaid = paid >= planned && planned > 0;
          return {
            id: q.id,
            debtName: d.name || 'Deuda',
            dueDate: q.dueDate || '',
            planned,
            paid,
            isPaid,
          };
        });
    });
  }, [debtsArray, formPeriodKey, transactions]);

  function resetAdjustForm() {
    setCashInput('');
    setCashFormatted('');
    setDebitInput('');
    setDebitFormatted('');
    setAdjustNote('');
    setAdjustError('');
  }

  function closeTransactionModal() {
    setShowIngresoModal(false);
    setShowGastoModal(false);
    setEditingTx(null);
    setAmount('');
    setAmountFormatted('');
    setDescription('');
  }

  function startNewTransaction(kind) {
    setEditingTx(null);
    setType(kind);
    setAmount('');
    setAmountFormatted('');
    setDescription('');
    setSelectedDebtQuotaId('');
    if (kind === 'ingreso') setShowIngresoModal(true);
    if (kind === 'gasto') setShowGastoModal(true);
  }

  function startEditTransaction(tx) {
    if (!tx) return;
    const baseType = tx.type === 'ingreso' ? 'ingreso' : 'gasto';
    const { digits, formatted } = formatAmountForInput(tx.amount);
    const baseDate = clampDateToPeriod(
      (tx.date || tx.createdAt || new Date().toISOString().slice(0, 10)).slice(
        0,
        10,
      ),
    );

    setType(baseType);
    setAmount(digits);
    setAmountFormatted(formatted);
    setCategory(tx.category || categories[0] || '');
    setDate(baseDate);
    setDescription(tx.description || '');
    setSelectedDebtQuotaId(tx?.meta?.debtQuotaId || '');
    const metaSubs = tx?.meta?.budgetSubcategoryIds;
    const singleMeta = tx?.meta?.budgetSubcategoryId;
    if (Array.isArray(metaSubs)) {
      setSelectedSubcategoryIds(metaSubs.filter(Boolean));
    } else if (singleMeta) {
      setSelectedSubcategoryIds([singleMeta]);
    } else {
      setSelectedSubcategoryIds([]);
    }
    setEditingTx(tx);
    if (baseType === 'ingreso') setShowIngresoModal(true);
    else setShowGastoModal(true);
  }

  async function handleAdd(e) {
    e.preventDefault();

    const n = Number(amount || 0);
    const isEditing = !!editingTx;
    const handler = isEditing ? updateTransaction : addTransaction;
    if (!n || n <= 0 || !handler) {
      alert('Ingresa un monto valido.');
      return;
    }

    const normalized = {
      type,
      amount: n,
      category: type === 'gasto' ? category || categories[0] || 'Otros' : '',
      description: description.trim(),
      date: date || new Date().toISOString().slice(0, 10),
      ownerId: editingTx?.ownerId ?? activeUser?.id ?? null,
      ownerName: editingTx?.ownerName ?? activeUser?.name ?? null,
      ownerEmail: editingTx?.ownerEmail ?? activeUser?.email ?? null,
    };

    const baseMeta = editingTx?.meta ? { ...editingTx.meta } : {};
    if (selectedDebtQuotaId) {
      baseMeta.debtQuotaId = selectedDebtQuotaId;
    } else if (baseMeta.debtQuotaId) {
      delete baseMeta.debtQuotaId;
    }
    if (selectedSubcategoryIds.length > 0) {
      baseMeta.budgetSubcategoryIds = selectedSubcategoryIds;
      baseMeta.budgetSubcategoryNames = selectedSubcategoryIds
        .map((id) => budgetSubcategories.find((s) => s.id === id)?.name)
        .filter(Boolean)
        .join('; ');
      // compat con datos antiguos: limpiamos la clave singular
      delete baseMeta.budgetSubcategoryId;
      delete baseMeta.budgetSubcategoryName;
    } else {
      delete baseMeta.budgetSubcategoryIds;
      delete baseMeta.budgetSubcategoryNames;
      delete baseMeta.budgetSubcategoryId;
      delete baseMeta.budgetSubcategoryName;
    }
    const shouldPersistMeta =
      selectedDebtQuotaId ||
      selectedSubcategoryIds.length > 0 ||
      (editingTx && editingTx.meta);
    if (shouldPersistMeta) {
      normalized.meta = baseMeta;
    }

    try {
      if (isEditing) {
        await updateTransaction(editingTx.id, normalized);
      } else {
        await addTransaction({
          ...normalized,
          createdAt: new Date().toISOString(),
        });
      }
      setAmount('');
      setAmountFormatted('');
      setDescription('');
      setEditingTx(null);
      setSelectedDebtQuotaId('');
      setSelectedSubcategoryIds([]);
      setShowIngresoModal(false);
      setShowGastoModal(false);
    } catch (err) {
      console.error('Error al guardar movimiento:', err);
      alert('No se pudo guardar el movimiento.');
    }
  }

  async function handleSaveAdjustment() {
    if (!addTransaction) return;
    setAdjustError('');

    const efectivo = Number(cashInput || 0);
    const debito = Number(debitInput || 0);
    if (
      Number.isNaN(efectivo) ||
      Number.isNaN(debito) ||
      efectivo < 0 ||
      debito < 0
    ) {
      setAdjustError('Ingresa montos validos para efectivo y debito.');
      return;
    }

    if (delta === 0) {
      setAdjustError('No hay diferencia que ajustar.');
      return;
    }

    if (adjustType === 'gasto' && !adjustCategory) {
      setAdjustError('Selecciona una categoria para el gasto.');
      return;
    }

    const amountAdjust = Math.abs(delta);
    if (!amountAdjust || amountAdjust <= 0) {
      setAdjustError('El monto de ajuste no es valido.');
      return;
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const txDate = clampDateToPeriod(todayStr);

    const adjustmentTx = {
      type: adjustType,
      amount: amountAdjust,
      category:
        adjustType === 'gasto'
          ? adjustCategory || categories[0] || 'Otros'
          : '',
      description: adjustNote.trim() || 'Ajuste de balance desde calculadora',
      date: txDate,
      createdAt: new Date().toISOString(),
      ownerId: activeUser?.id || null,
      ownerName: activeUser?.name || null,
      ownerEmail: activeUser?.email || null,
      meta: {
        cashSum: efectivo,
        debitSum: debito,
        platformBalance,
        realBalance,
        delta,
        source: 'balance-calculator',
      },
    };

    try {
      await addTransaction(adjustmentTx);
      setShowBalanceModal(false);
      resetAdjustForm();
    } catch (err) {
      console.error('Error al guardar ajuste de balance:', err);
      setAdjustError('No se pudo guardar el ajuste.');
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
              onClick={() => startNewTransaction('ingreso')}
            >
              + Ingreso
            </button>

            <button
              type="button"
              className="px-4 py-1.5 rounded-full text-xs font-medium bg-red-600 text-white hover:bg-red-700 transition"
              onClick={() => startNewTransaction('gasto')}
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
          <div className="relative">
            <button
              type="button"
              className="absolute top-2 right-2 w-10 h-10 flex items-center justify-center rounded-full bg-gray-100 border text-base hover:bg-gray-200"
              title="Ajustar balance con calculadora"
              onClick={() => {
                setShowBalanceModal(true);
                setAdjustError('');
              }}
            >
              🧮
            </button>
            <div className="text-xs uppercase text-gray-500 mb-1 text-center">
              Balance
            </div>
            <div
              className={`text-lg font-semibold text-center ${
                totals.balance < 0 ? 'text-red-600' : 'text-green-600'
              }`}
            >
              <Money n={totals.balance} />
            </div>
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
            <option value="todas">Todas las categorias</option>
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
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">Listado de movimientos</h3>
            {currentPeriodKey === trueCurrentPeriod && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-green-100 text-green-700 border border-green-200">
                Periodo actual
              </span>
            )}
          </div>
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
                  <th className="px-2 py-1 text-left">Descripcion</th>
                  <th className="px-2 py-1 text-left">Categoria</th>
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
                      <div className="flex justify-end gap-3 text-xs">
                        {updateTransaction && (
                          <button
                            className="text-blue-600 hover:text-blue-800"
                            onClick={() => startEditTransaction(tx)}
                          >
                            Editar
                          </button>
                        )}
                        {removeTransaction && (
                          <button
                            className="text-red-600 hover:text-red-800"
                            onClick={() => removeTransaction(tx.id)}
                          >
                            Eliminar
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Modal ingreso/gasto */}
      {(showIngresoModal || showGastoModal) && (
        <div className="fixed inset-0 z-30 bg-black/30 backdrop-blur-sm overflow-y-auto">
          <div className="min-h-full flex items-start justify-center pt-12 pb-12">
            <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl p-5 w-full max-w-xl mx-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">
                {editingTx
                  ? 'Editar movimiento'
                  : type === 'ingreso'
                    ? 'Nuevo ingreso'
                    : 'Nuevo gasto'}
              </h3>
              <button
                type="button"
                className="text-sm text-gray-500 hover:text-gray-800"
                onClick={closeTransactionModal}
              >
                × Cerrar
              </button>
            </div>

            <form onSubmit={handleAdd} className="grid gap-3">
              {/* Monto */}
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
                      const digits = raw.replace(/\D/g, '');
                      if (!digits) {
                        setAmountFormatted('');
                        setAmount('');
                        return;
                      }
                      const formatted = currencyFormatter.format(
                        Number(digits),
                      );

                      setAmountFormatted(formatted);
                      setAmount(digits);
                    }}
                    placeholder="0"
                  />
                </div>
              </div>

              {/* Fecha */}
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

              {/* Categoria solo para gasto */}
              {type === 'gasto' && (
                <>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-gray-500">Categoria</label>
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

                  {isDebtCategory(category) ? (
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-gray-500">
                        Subcategoria (cuota del periodo)
                      </label>
                      <select
                        className="border rounded-lg px-2 py-1 text-sm"
                        value={selectedDebtQuotaId}
                        onChange={(e) => setSelectedDebtQuotaId(e.target.value)}
                      >
                        <option value="">Sin asignar</option>
                        {debtQuotasForPeriod.map((q) => (
                          <option key={q.id} value={q.id}>
                            {q.debtName} · {q.dueDate || formPeriodLabel}{' '}
                            {q.isPaid ? '(Pagada)' : '(Pendiente)'}
                          </option>
                        ))}
                      </select>
                      {debtQuotasForPeriod.length === 0 ? (
                        <p className="text-xs text-gray-500">
                          No hay cuotas planificadas en {formPeriodLabel}.
                        </p>
                      ) : (
                        <p className="text-xs text-gray-500">
                          Opcional: vincula el movimiento a una cuota para
                          marcarla como pagada con los movimientos del periodo.
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-gray-500">
                        Subcategoria (presupuesto)
                      </label>
                      <div className="border rounded-lg px-2 py-2 text-sm space-y-1 max-h-40 overflow-y-auto">
                        {budgetSubcategories.map((sub) => {
                          const checked = selectedSubcategoryIds.includes(sub.id);
                          return (
                            <label
                              key={sub.id}
                              className="flex items-center justify-between gap-2 cursor-pointer"
                            >
                              <div className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  className="rounded"
                                  checked={checked}
                                  onChange={(e) => {
                                    setSelectedSubcategoryIds((prev) => {
                                      if (e.target.checked) {
                                        return [...new Set([...prev, sub.id])];
                                      }
                                      return prev.filter((id) => id !== sub.id);
                                    });
                                  }}
                                />
                                <span>{sub.name}</span>
                              </div>
                              <span className="text-xs text-gray-600">
                                {sub.amount ? `$${currencyFormatter.format(sub.amount)}` : ''}
                              </span>
                            </label>
                          );
                        })}
                        {budgetSubcategories.length === 0 && (
                          <div className="text-xs text-gray-500">
                            Esta categoria no tiene subcategorias en el presupuesto del periodo.
                          </div>
                        )}
                      </div>
                      <div className="flex items-center justify-between text-xs text-gray-500">
                        <span>
                          Puedes elegir varias; se guardan separadas por ';' en el movimiento.
                        </span>
                        <button
                          type="button"
                          className="text-blue-600 hover:text-blue-800"
                          onClick={() => setSelectedSubcategoryIds([])}
                        >
                          Limpiar
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Descripcion */}
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500">Descripcion</label>
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
                    {editingTx ? 'Guardar cambios' : 'Agregar'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>
      )}

      {/* Modal calculadora de ajuste */}
      {showBalanceModal && (
        <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 backdrop-blur-sm pt-16">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl p-5 w-full max-w-2xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">
                Calculadora de ajuste de balance ({periodLabel})
              </h3>
              <button
                type="button"
                className="text-sm text-gray-500 hover:text-gray-800"
                onClick={() => {
                  setShowBalanceModal(false);
                  resetAdjustForm();
                }}
              >
                ×
              </button>
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <label className="text-xs text-gray-500">
                  Suma de efectivo actual
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">$</span>
                  <input
                    type="text"
                    className="border rounded-lg px-2 py-1 text-sm flex-1"
                    value={cashFormatted}
                    onChange={(e) =>
                      handleMoneyInput(e.target.value, {
                        setFormatted: setCashFormatted,
                        setValue: setCashInput,
                      })
                    }
                    placeholder="0"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-xs text-gray-500">
                  Suma de debito actual
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">$</span>
                  <input
                    type="text"
                    className="border rounded-lg px-2 py-1 text-sm flex-1"
                    value={debitFormatted}
                    onChange={(e) =>
                      handleMoneyInput(e.target.value, {
                        setFormatted: setDebitFormatted,
                        setValue: setDebitInput,
                      })
                    }
                    placeholder="0"
                  />
                </div>
              </div>
            </div>

            <div className="grid md:grid-cols-3 gap-3 mt-4">
              <div className="border rounded-lg p-3">
                <div className="text-xs text-gray-500">
                  Balance en plataforma
                </div>
                <div className="text-lg font-semibold">
                  <Money n={platformBalance} />
                </div>
              </div>
              <div className="border rounded-lg p-3">
                <div className="text-xs text-gray-500">Balance real total</div>
                <div className="text-lg font-semibold">
                  <Money n={realBalance} />
                </div>
              </div>
              <div className="border rounded-lg p-3">
                <div className="text-xs text-gray-500">Diferencia (delta)</div>
                <div
                  className={`text-lg font-semibold ${
                    delta < 0 ? 'text-red-600' : 'text-green-700'
                  }`}
                >
                  <Money n={delta} />
                </div>
              </div>
            </div>

            <div className="mt-3 text-sm">
              {delta > 0 && (
                <p>
                  Hay <strong>mas dinero real</strong> que el balance de la
                  plataforma. Este delta se registrara como un{' '}
                  <strong>INGRESO</strong>.
                </p>
              )}
              {delta < 0 && (
                <p>
                  Hay <strong>menos dinero real</strong> que el balance de la
                  plataforma. Este delta se registrara como un{' '}
                  <strong>GASTO</strong>.
                </p>
              )}
              {delta === 0 && (
                <p>
                  No hay diferencia entre el balance real y el balance de la
                  plataforma.
                </p>
              )}
            </div>

            <div className="mt-4 border-t pt-3 grid gap-3">
              <div className="grid md:grid-cols-3 gap-3">
                <div className="flex flex-col gap-2">
                  <div className="text-xs text-gray-500">Tipo de ajuste</div>
                  <div className="flex gap-3 text-sm">
                    <label className="flex items-center gap-1">
                      <input
                        type="radio"
                        name="adjust-type"
                        value="ingreso"
                        checked={adjustType === 'ingreso'}
                        onChange={(e) => setAdjustType(e.target.value)}
                      />
                      Ingreso
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        type="radio"
                        name="adjust-type"
                        value="gasto"
                        checked={adjustType === 'gasto'}
                        onChange={(e) => setAdjustType(e.target.value)}
                      />
                      Gasto
                    </label>
                  </div>
                </div>

                {adjustType === 'gasto' && (
                  <div className="flex flex-col gap-2">
                    <label className="text-xs text-gray-500">
                      Categoria del ajuste
                    </label>
                    <select
                      className="border rounded-lg px-2 py-1 text-sm"
                      value={adjustCategory}
                      onChange={(e) => setAdjustCategory(e.target.value)}
                    >
                      {categories.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  <label className="text-xs text-gray-500">
                    Nota / comentario (opcional)
                  </label>
                  <input
                    className="border rounded-lg px-2 py-1 text-sm"
                    value={adjustNote}
                    onChange={(e) => setAdjustNote(e.target.value)}
                    placeholder="Ajuste de balance desde calculadora"
                  />
                </div>
              </div>
            </div>

            {adjustError && (
              <div className="text-sm text-red-600 mt-2">{adjustError}</div>
            )}

            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                className="px-3 py-1.5 text-sm border rounded-lg"
                onClick={() => {
                  setShowBalanceModal(false);
                  resetAdjustForm();
                }}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="px-3 py-1.5 text-sm rounded-lg text-white"
                style={{
                  backgroundColor: delta < 0 ? '#dc2626' : '#16a34a',
                  opacity: delta === 0 ? 0.5 : 1,
                }}
                disabled={delta === 0}
                onClick={handleSaveAdjustment}
              >
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
