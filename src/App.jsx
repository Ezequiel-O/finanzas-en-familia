import React, { useEffect, useMemo, useState } from 'react';
// Finanzas en Familia — App V2 (Firebase + Firestore, tiempo real)
// - Autenticación email/contraseña
// - Household compartido (código de hogar)
// - Datos en Firestore con sincronización en tiempo real
// - Validación de login con tooltip en caso de credenciales vacías o inválidas

import { auth, db } from './firebase';

import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import {
  doc,
  setDoc,
  getDoc,
  onSnapshot,
  updateDoc,
  arrayUnion,
  collection,
  addDoc,
  deleteDoc,
} from 'firebase/firestore';

import HouseholdPicker from './components/HouseholdPicker';
import { CATEGORIES } from './constants/categories';
import {
  createDefaultBudgets,
  createHousehold,
  joinHousehold,
} from './services/households';

// --- Utils ---
function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    '0'
  )}`;
}
function Money({ n }) {
  const sign = Number(n) < 0 ? '-' : '';
  const v = Math.abs(Number(n || 0));
  return (
    <span>
      {sign}${v.toLocaleString('es-CL', { minimumFractionDigits: 0 })}
    </span>
  );
}
function Card({ children, className = '' }) {
  return (
    <div className={`rounded-2xl shadow-sm border p-4 bg-white ${className}`}>
      {children}
    </div>
  );
}
function Progress({ value }) {
  const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div className="w-full h-3 rounded-full bg-gray-200">
      <div
        className={`h-3 rounded-full ${
          v >= 90 ? 'bg-red-500' : v >= 70 ? 'bg-amber-500' : 'bg-green-600'
        }`}
        style={{ width: `${v}%` }}
        title={`${v.toFixed(0)}%`}
      />
    </div>
  );
}
function SectionTitle({ children, right }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-xl font-semibold">{children}</h2>
      {right}
    </div>
  );
}

function Header({ currentTab, setTab, user, onLogout, householdId }) {
  const showTabs = Boolean(user && householdId); // pestañas solo “adentro”
  const showLogout = Boolean(user); // Salir siempre si hay sesión

  const tabs = [
    ['dashboard', 'Dashboard'],
    ['transactions', 'Movimientos'],
    ['budgets', 'Presupuestos'],
    ['debts', 'Deudas'],
    ['savings', 'Ahorro'],
    ['investments', 'Inversiones'],
    ['settings', 'Ajustes'],
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 p-3 bg-white/70 backdrop-blur sticky top-0 z-10 border-b">
      <div className="text-2xl font-bold">Finanzas en Familia</div>

      {householdId && (
        <div className="text-xs border rounded-full px-2 py-1 bg-gray-50">
          Código hogar: {householdId}
        </div>
      )}

      <div className="flex flex-wrap gap-2 ml-auto">
        {showTabs &&
          tabs.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-3 py-1.5 rounded-full border text-sm ${
                currentTab === key ? 'bg-gray-900 text-white' : 'bg-white'
              }`}
            >
              {label}
            </button>
          ))}

        {showLogout && (
          <button
            onClick={onLogout}
            className="px-3 py-1.5 rounded-full border text-sm"
          >
            Salir
          </button>
        )}
      </div>
    </div>
  );
}

// --- Auth + Household gate ---
function AuthGate({ onReady }) {
  const [phase, setPhase] = useState('loading'); // loading | auth | household | ready
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [name, setName] = useState('');
  const [tip, setTip] = useState(''); // texto de tooltip de error

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        setUser(null);
        setPhase('auth');
        return;
      }
      setUser(u);
      setPhase('loading');
      try {
        const profSnap = await getDoc(doc(db, 'profiles', u.uid));
        const hid = profSnap.exists() ? profSnap.data().householdId : null;
        if (hid) {
          setPhase('ready');
          onReady({ user: u }); // elegiremos el hogar después
        } else {
          setPhase('household');
        }
      } catch (e) {
        console.error('Error leyendo perfil:', e);
        setPhase('household');
      }
    });
    return () => unsub();
  }, [onReady]);

  function mapAuthError(err) {
    const code = String(err?.code || '');
    if (code.includes('invalid-credential') || code.includes('wrong-password'))
      return 'Credenciales inválidas.';
    if (code.includes('user-not-found')) return 'Usuario no encontrado.';
    if (code.includes('invalid-email')) return 'Email inválido.';
    if (code.includes('missing-password')) return 'Falta la contraseña.';
    if (code.includes('operation-not-allowed'))
      return 'El método Email/Password no está habilitado en Firebase.';
    if (code.includes('network-request-failed'))
      return 'Error de red. Revisa tu conexión.';
    if (code.includes('too-many-requests'))
      return 'Demasiados intentos. Intenta más tarde.';
    if (code.includes('invalid-api-key'))
      return 'API key inválida en la configuración de Firebase.';
    if (code.includes('domain-config-required'))
      return 'Agrega este dominio a “Authorized domains” en Firebase.';
    // fallback: muestra el code para depurar
    return `No se pudo iniciar sesión (${code}).`;
  }

  async function handleLogin(e) {
    e.preventDefault();
    // Validación: campos vacíos
    if (!email?.trim() || !pass?.trim()) {
      setTip('Ingresa un email y contraseña válidos');
      return;
    }
    setTip('');

    try {
      if (isRegister) {
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        // crea perfil mínimo para evitar estado huérfano
        await setDoc(doc(db, 'profiles', cred.user.uid), {
          householdId: null,
          name: name || email,
        });
        setUser(cred.user);
        setPhase('household');
      } else {
        await signInWithEmailAndPassword(auth, email, pass);
      }
    } catch (err) {
      setTip(mapAuthError(err));
    }
  }

  async function handleCreateHousehold() {
    if (!user) return;
    const hid = await createHousehold(user.uid, name || user.email);
    await setDoc(
      doc(db, 'profiles', user.uid),
      {
        name: name || user.email,
        householdIds: arrayUnion(hid),
        defaultHouseholdId: hid, // opcional: último usado por defecto
      },
      { merge: true }
    );
    setPhase('ready');
    onReady({ user });
  }

  async function handleJoinHousehold() {
    if (!user) return;
    try {
      const hid = await joinHousehold(
        user.uid,
        joinCode.trim(),
        name || user.email
      );
      await setDoc(
        doc(db, 'profiles', user.uid),
        {
          name: name || user.email,
          householdIds: arrayUnion(hid),
          defaultHouseholdId: hid,
        },
        { merge: true }
      );
      setPhase('ready');
      onReady({ user });
    } catch (e) {
      setTip(e.message || 'Código inválido');
    }
  }

  if (phase === 'loading')
    return <div className="p-8 text-center">Cargando…</div>;

  if (phase === 'auth')
    return (
      <div className="max-w-6xl mx-auto grid md:grid-cols-2 items-start gap-10 py-8 px-4">
        {/* Columna izquierda: login/registro */}
        <Card className="w-full max-w-xl mx-auto md:mx-0">
          <h1 className="text-2xl font-bold mb-4">Inicia sesión</h1>
          <form onSubmit={handleLogin} className="grid gap-3 relative">
            <input
              className="border rounded-lg p-2"
              placeholder="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <input
              className="border rounded-lg p-2"
              placeholder="Contraseña"
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              required
            />
            <button className="px-3 py-2 rounded-xl border bg-gray-900 text-white">
              {isRegister ? 'Crear cuenta' : 'Entrar'}
            </button>
            {tip && (
              <div className="absolute -bottom-10 left-0 bg-red-50 text-red-700 border border-red-200 rounded-md px-3 py-2 text-sm shadow-sm">
                {tip}
              </div>
            )}
          </form>
          <button
            className="text-sm mt-6"
            onClick={() => setIsRegister(!isRegister)}
          >
            {isRegister
              ? '¿Ya tienes cuenta? Inicia sesión'
              : '¿No tienes cuenta? Regístrate'}
          </button>
        </Card>

        {/* Columna derecha: beneficios/ayuda */}
        <Card>
          <h3 className="text-lg font-semibold mb-3">Tu centro de control</h3>
          <ul className="space-y-2 text-sm text-gray-800">
            <li>✅ Presupuestos por categoría con % de avance</li>
            <li>✅ Movimientos y conciliación rápida</li>
            <li>✅ Deudas, ahorro e inversiones</li>
            <li>✅ Sesión familiar compartida</li>
          </ul>
        </Card>
      </div>
    );

  // Configuración de hogar
  if (phase === 'household')
    return (
      <div className="min-h-[calc(100vh-120px)] px-4">
        <div className="max-w-6xl mx-auto grid md:grid-cols-2 items-start gap-10 py-8">
          {/* Acciones */}
          <div className="w-full max-w-xl mx-auto md:mx-0 grid gap-6">
            <h2 className="text-xl font-semibold text-center md:text-left">
              Configura tu hogar compartido
            </h2>
            <input
              className="border rounded-lg p-2 w-full"
              placeholder="Tu nombre para mostrar"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Card>
              <SectionTitle>Crear nuevo hogar</SectionTitle>
              <button
                className="w-full px-3 py-2 rounded-xl border bg-gray-900 text-white"
                onClick={handleCreateHousehold}
              >
                Crear
              </button>
            </Card>
            <Card>
              <SectionTitle>Unirme a un hogar</SectionTitle>
              <div className="flex flex-col md:flex-row gap-2">
                <input
                  className="border rounded-lg p-2 flex-1 w-full"
                  placeholder="Código de hogar"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                />
                <button
                  className="px-3 py-2 rounded-xl border w-full md:w-auto"
                  onClick={handleJoinHousehold}
                >
                  Unirme
                </button>
              </div>
              {tip && (
                <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                  {tip}
                </div>
              )}
            </Card>
          </div>

          {/* Ayuda */}
          <div className="hidden md:block">
            <div className="bg-white rounded-2xl border shadow-sm p-6">
              <h3 className="text-lg font-semibold mb-3">
                🏡 ¿Qué es un “hogar”?
              </h3>
              <p className="text-gray-700 mb-4">
                Es tu espacio compartido: invita a tu pareja o familia para{' '}
                <strong>ver y editar el mismo presupuesto</strong> en tiempo
                real. 👨‍👩‍👧‍👦⚡
              </p>
              <ol className="list-decimal pl-5 space-y-2 text-gray-700">
                <li>
                  🆕 <strong>Crea un hogar</strong> o ingresa el{' '}
                  <strong>código</strong> para unirte.
                </li>
                <li>
                  🔗 <strong>Comparte el código</strong> con tu familia.
                </li>
                <li>
                  ⚡ <strong>Listo:</strong> todos verán y editarán los datos{' '}
                  <strong>en tiempo real</strong>.
                </li>
              </ol>
            </div>
          </div>
        </div>
      </div>
    );

  return null; // ready handled por App
}

// --- Hooks de datos (Firestore) ---
function useHouseholdData(householdId) {
  const [budgets, setBudgets] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [debts, setDebts] = useState([]);
  const [savings, setSavings] = useState([]);
  const [investments, setInvestments] = useState([]);

  useEffect(() => {
    if (!householdId) return;

    const unsubHH = onSnapshot(doc(db, 'households', householdId), (snap) => {
      const d = snap.data();
      setBudgets(d?.budgets || createDefaultBudgets());
    });

    const unsubTx = onSnapshot(
      collection(db, 'households', householdId, 'transactions'),
      (snap) => {
        setTransactions(snap.docs.map((d) => ({ ...d.data(), id: d.id })));
      }
    );

    const unsubDebts = onSnapshot(
      collection(db, 'households', householdId, 'debts'),
      (snap) => {
        setDebts(snap.docs.map((d) => ({ ...d.data(), id: d.id })));
      }
    );

    const unsubSavings = onSnapshot(
      collection(db, 'households', householdId, 'savings'),
      (snap) => {
        setSavings(snap.docs.map((d) => ({ ...d.data(), id: d.id })));
      }
    );

    const unsubInv = onSnapshot(
      collection(db, 'households', householdId, 'investments'),
      (snap) => {
        setInvestments(snap.docs.map((d) => ({ ...d.data(), id: d.id })));
      }
    );

    return () => {
      unsubHH();
      unsubTx();
      unsubDebts();
      unsubSavings();
      unsubInv();
    };
  }, [householdId]);

  async function setBudget(cat, value) {
    const ref = doc(db, 'households', householdId);
    const snap = await getDoc(ref);
    const b = snap.data().budgets || createDefaultBudgets();
    await updateDoc(ref, {
      budgets: {
        ...createDefaultBudgets(),
        ...b,
        [cat]: Number(value || 0),
      },
    });
  }
  async function addTransaction(tx) {
    await addDoc(collection(db, 'households', householdId, 'transactions'), tx);
  }
  async function removeTransaction(id) {
    await deleteDoc(doc(db, 'households', householdId, 'transactions', id));
  }
  async function addDebt(d) {
    await addDoc(collection(db, 'households', householdId, 'debts'), d);
  }
  async function updateDebt(id, patch) {
    await updateDoc(doc(db, 'households', householdId, 'debts', id), patch);
  }
  async function removeDebt(id) {
    await deleteDoc(doc(db, 'households', householdId, 'debts', id));
  }
  async function addSaving(s) {
    await addDoc(collection(db, 'households', householdId, 'savings'), s);
  }
  async function updateSaving(id, patch) {
    await updateDoc(doc(db, 'households', householdId, 'savings', id), patch);
  }
  async function removeSaving(id) {
    await deleteDoc(doc(db, 'households', householdId, 'savings', id));
  }
  async function addInvestment(i) {
    await addDoc(collection(db, 'households', householdId, 'investments'), i);
  }
  async function updateInvestment(id, patch) {
    await updateDoc(
      doc(db, 'households', householdId, 'investments', id),
      patch
    );
  }
  async function removeInvestment(id) {
    await deleteDoc(doc(db, 'households', householdId, 'investments', id));
  }

  return {
    budgets,
    transactions,
    debts,
    savings,
    investments,
    setBudget,
    addTransaction,
    removeTransaction,
    addDebt,
    updateDebt,
    removeDebt,
    addSaving,
    updateSaving,
    removeSaving,
    addInvestment,
    updateInvestment,
    removeInvestment,
  };
}

// --- Vistas ---
function Dashboard({ data }) {
  const mk = monthKey();
  const monthTx = data.transactions.filter((t) =>
    (t.date || '').startsWith(mk)
  );
  const totalIngresos = monthTx
    .filter((t) => t.type === 'ingreso')
    .reduce((a, b) => a + Number(b.amount || 0), 0);
  const totalGastos = monthTx
    .filter((t) => t.type === 'gasto')
    .reduce((a, b) => a + Number(b.amount || 0), 0);
  const balance = totalIngresos - totalGastos;
  const catSpend = CATEGORIES.reduce((acc, c) => {
    const spent = monthTx
      .filter((t) => t.type === 'gasto' && t.category === c)
      .reduce((a, b) => a + Number(b.amount || 0), 0);
    const budget = data.budgets?.[c] || 0;
    acc[c] = { spent, budget, pct: budget > 0 ? (spent / budget) * 100 : 0 };
    return acc;
  }, {});
  const pctIngresosVsGastos =
    totalIngresos > 0 ? (totalGastos / totalIngresos) * 100 : 0;
  const debtTotals = data.debts.reduce(
    (acc, d) => (
      (acc.original += Number(d.original || 0)),
      (acc.remaining += Number(d.remaining || 0)),
      acc
    ),
    { original: 0, remaining: 0 }
  );
  const debtProgress =
    debtTotals.original > 0
      ? ((debtTotals.original - debtTotals.remaining) / debtTotals.original) *
        100
      : 0;
  const savingsTotals = data.savings.reduce(
    (acc, s) => (
      (acc.goal += Number(s.goal || 0)),
      (acc.saved += Number(s.saved || 0)),
      acc
    ),
    { goal: 0, saved: 0 }
  );
  const savingsProgress =
    savingsTotals.goal > 0
      ? (savingsTotals.saved / savingsTotals.goal) * 100
      : 0;
  const invTotals = data.investments.reduce(
    (acc, i) => (
      (acc.contrib += Number(i.contributed || 0)),
      (acc.current += Number(i.current || 0)),
      acc
    ),
    { contrib: 0, current: 0 }
  );
  const invROI =
    invTotals.contrib > 0
      ? ((invTotals.current - invTotals.contrib) / invTotals.contrib) * 100
      : 0;

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
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
        </div>
      </Card>

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
            <Progress value={debtProgress} />
          </div>
        </div>
      </Card>

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
            <Progress value={savingsProgress} />
          </div>
        </div>
      </Card>

      <Card className="md:col-span-2 lg:col-span-3">
        <SectionTitle>Presupuestos (progreso por categoría)</SectionTitle>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {CATEGORIES.map((c) => (
            <div key={c} className="border rounded-xl p-3">
              <div className="flex justify-between text-sm mb-1">
                <span className="font-medium">{c}</span>
                <span>
                  <Money n={catSpend[c].spent} /> /{' '}
                  <Money n={data.budgets?.[c] || 0} />
                </span>
              </div>
              <Progress value={catSpend[c].pct} />
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>Inversiones</SectionTitle>
        <div className="space-y-2">
          <div className="flex justify-between">
            <span>Contribuido</span>
            <strong>
              <Money n={invTotals.contrib} />
            </strong>
          </div>
          <div className="flex justify-between">
            <span>Valor actual</span>
            <strong>
              <Money n={invTotals.current} />
            </strong>
          </div>
          <div>
            <div className="text-sm mb-1">ROI (%)</div>
            <Progress value={Math.max(0, Math.min(100, invROI + 50))} />
            <div className="text-xs text-gray-600 mt-1">
              ROI real: {invROI.toFixed(2)}%
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function Transactions({ data, actions, user }) {
  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    type: 'gasto',
    amount: '',
    category: CATEGORIES[0],
    note: '',
    user: user?.email || 'Usuario',
  });
  const mk = monthKey();
  const monthTx = [...data.transactions]
    .filter((t) => (t.date || '').startsWith(mk))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  async function addTx(e) {
    e.preventDefault();
    const tx = {
      ...form,
      amount: Number(form.amount || 0),
      createdAt: Date.now(),
    };
    await actions.addTransaction(tx);
    setForm({ ...form, amount: '', note: '' });
  }

  const totals = useMemo(() => {
    const ing = monthTx
      .filter((t) => t.type === 'ingreso')
      .reduce((a, b) => a + Number(b.amount || 0), 0);
    const gas = monthTx
      .filter((t) => t.type === 'gasto')
      .reduce((a, b) => a + Number(b.amount || 0), 0);
    return { ing, gas, bal: ing - gas };
  }, [monthTx]);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-1">
        <SectionTitle>Nuevo movimiento</SectionTitle>
        <form onSubmit={addTx} className="grid gap-3">
          <div className="grid gap-1">
            <label className="text-sm">Fecha</label>
            <input
              type="date"
              className="border rounded-lg p-2"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <label className="text-sm">Tipo</label>
            <select
              className="border rounded-lg p-2"
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
            >
              <option value="gasto">Gasto</option>
              <option value="ingreso">Ingreso</option>
            </select>
          </div>
          {form.type === 'gasto' && (
            <div className="grid gap-1">
              <label className="text-sm">Categoría</label>
              <select
                className="border rounded-lg p-2"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="grid gap-1">
            <label className="text-sm">Monto (CLP)</label>
            <input
              type="number"
              className="border rounded-lg p-2"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              required
              min={0}
              step="1"
            />
          </div>
          <div className="grid gap-1">
            <label className="text-sm">Persona</label>
            <input
              className="border rounded-lg p-2"
              value={form.user}
              onChange={(e) => setForm({ ...form, user: e.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <label className="text-sm">Nota (opcional)</label>
            <input
              className="border rounded-lg p-2"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </div>
          <button className="px-3 py-2 rounded-xl border bg-gray-900 text-white">
            Agregar
          </button>
        </form>

        <div className="mt-4 text-sm space-y-1">
          <div className="flex justify-between">
            <span>Ingresos del mes</span>
            <strong>
              <Money n={totals.ing} />
            </strong>
          </div>
          <div className="flex justify-between">
            <span>Gastos del mes</span>
            <strong>
              <Money n={totals.gas} />
            </strong>
          </div>
          <div
            className={`flex justify-between ${
              totals.bal >= 0 ? 'text-green-700' : 'text-red-600'
            }`}
          >
            <span>Balance</span>
            <strong>
              <Money n={totals.bal} />
            </strong>
          </div>
        </div>
      </Card>

      <Card className="lg:col-span-2">
        <SectionTitle>Movimientos del mes</SectionTitle>
        <div className="overflow-auto max-h-[60vh]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white">
              <tr>
                <th className="text-left p-2">Fecha</th>
                <th className="text-left p-2">Tipo</th>
                <th className="text-left p-2">Categoría</th>
                <th className="text-right p-2">Monto</th>
                <th className="text-left p-2">Persona</th>
                <th className="text-left p-2">Nota</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {monthTx.map((t) => (
                <tr key={t.id} className="border-t">
                  <td className="p-2">{t.date}</td>
                  <td className="p-2">{t.type}</td>
                  <td className="p-2">
                    {t.type === 'gasto' ? t.category : '—'}
                  </td>
                  <td className="p-2 text-right">
                    <Money n={t.amount} />
                  </td>
                  <td className="p-2">{t.user}</td>
                  <td className="p-2">{t.note}</td>
                  <td className="p-2 text-right">
                    <button
                      className="text-red-600"
                      onClick={() => actions.removeTransaction(t.id)}
                    >
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))}
              {monthTx.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-4 text-center text-gray-500">
                    Sin movimientos este mes.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Budgets({ data, actions }) {
  const mk = monthKey();
  const monthTx = data.transactions.filter((t) =>
    (t.date || '').startsWith(mk)
  );
  const rows = CATEGORIES.map((c) => {
    const spent = monthTx
      .filter((t) => t.type === 'gasto' && t.category === c)
      .reduce((a, b) => a + Number(b.amount || 0), 0);
    const budget = data.budgets?.[c] || 0;
    const pct = budget > 0 ? (spent / budget) * 100 : 0;
    return { c, spent, budget, pct };
  });
  const totalBudget = rows.reduce((a, r) => a + r.budget, 0);
  const totalSpent = rows.reduce((a, r) => a + r.spent, 0);
  const totalPct = totalBudget > 0 ? (totalSpent / totalBudget) * 100 : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <SectionTitle>Presupuestos por categoría</SectionTitle>
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.c} className="border rounded-xl p-3">
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-medium">{r.c}</span>
                    <span>
                      <Money n={r.spent} /> / <Money n={r.budget} />
                    </span>
                  </div>
                  <Progress value={r.pct} />
                </div>
                <div className="w-36">
                  <input
                    type="number"
                    className="border rounded-lg p-2 w-full"
                    value={r.budget}
                    min={0}
                    step="1"
                    onChange={(e) => actions.setBudget(r.c, e.target.value)}
                    title="Presupuesto mensual (CLP)"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>Resumen</SectionTitle>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span>Presupuesto total</span>
            <strong>
              <Money n={totalBudget} />
            </strong>
          </div>
          <div className="flex justify-between">
            <span>Gastado</span>
            <strong>
              <Money n={totalSpent} />
            </strong>
          </div>
          <div>
            <div className="text-sm mb-1">% total usado</div>
            <Progress value={totalPct} />
          </div>
        </div>
      </Card>
    </div>
  );
}

function Debts({ data, actions }) {
  const [form, setForm] = useState({
    name: '',
    original: '',
    remaining: '',
    rateAPR: '',
    due: '',
  });

  async function addDebt(e) {
    e.preventDefault();
    const d = {
      name: form.name || 'Deuda',
      original: Number(form.original || 0),
      remaining: Number(form.remaining || 0),
      rateAPR: Number(form.rateAPR || 0),
      due: form.due || '',
      createdAt: Date.now(),
    };
    await actions.addDebt(d);
    setForm({ name: '', original: '', remaining: '', rateAPR: '', due: '' });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card>
        <SectionTitle>Nueva deuda</SectionTitle>
        <form onSubmit={addDebt} className="grid gap-3">
          <input
            className="border rounded-lg p-2"
            placeholder="Nombre (ej. Tarjeta, Préstamo)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className="border rounded-lg p-2"
            type="number"
            min={0}
            step="1"
            placeholder="Monto original"
            value={form.original}
            onChange={(e) => setForm({ ...form, original: e.target.value })}
          />
          <input
            className="border rounded-lg p-2"
            type="number"
            min={0}
            step="1"
            placeholder="Saldo pendiente"
            value={form.remaining}
            onChange={(e) => setForm({ ...form, remaining: e.target.value })}
          />
          <input
            className="border rounded-lg p-2"
            type="number"
            min={0}
            step="0.01"
            placeholder="Tasa anual % (opcional)"
            value={form.rateAPR}
            onChange={(e) => setForm({ ...form, rateAPR: e.target.value })}
          />
          <input
            className="border rounded-lg p-2"
            type="date"
            placeholder="Fecha límite (opcional)"
            value={form.due}
            onChange={(e) => setForm({ ...form, due: e.target.value })}
          />
          <button className="px-3 py-2 rounded-xl border bg-gray-900 text-white">
            Agregar deuda
          </button>
        </form>
      </Card>

      <Card className="lg:col-span-2">
        <SectionTitle>Listado de deudas</SectionTitle>
        <div className="space-y-3">
          {data.debts.map((d) => {
            const progress =
              d.original > 0
                ? ((d.original - d.remaining) / d.original) * 100
                : 0;
            return (
              <div
                key={d.id || d.name + d.due}
                className="border rounded-xl p-3"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{d.name}</div>
                    <div className="text-sm text-gray-600">
                      Saldo: <Money n={d.remaining} /> / Original:{' '}
                      <Money n={d.original} />
                    </div>
                    <div className="text-xs text-gray-500">
                      {d.rateAPR ? `Tasa: ${d.rateAPR}%` : ''}{' '}
                      {d.due ? `· Vence: ${d.due}` : ''}
                    </div>
                  </div>
                  <div className="w-56">
                    <Progress value={progress} />
                    <div className="text-xs text-gray-600 mt-1">
                      Pagado: {progress.toFixed(1)}%
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step="1"
                    placeholder="Pago (CLP)"
                    className="border rounded-lg p-2"
                    id={`pay-${d.id}`}
                  />
                  <button
                    className="px-3 py-2 rounded-xl border"
                    onClick={async () => {
                      const el = document.getElementById(`pay-${d.id}`);
                      const amt = Number(el?.value || 0);
                      await actions.updateDebt(d.id, {
                        remaining: Math.max(0, Number(d.remaining || 0) - amt),
                      });
                      if (el) el.value = '';
                    }}
                  >
                    Registrar pago
                  </button>
                  <button
                    className="ml-auto text-red-600"
                    onClick={() => actions.removeDebt(d.id)}
                  >
                    Eliminar
                  </button>
                </div>
              </div>
            );
          })}
          {data.debts.length === 0 && (
            <div className="text-gray-500">Sin deudas registradas.</div>
          )}
        </div>
      </Card>
    </div>
  );
}

function Savings({ data, actions }) {
  const [form, setForm] = useState({ name: '', goal: '', saved: '' });
  async function addSaving(e) {
    e.preventDefault();
    const s = {
      name: form.name || 'Ahorro',
      goal: Number(form.goal || 0),
      saved: Number(form.saved || 0),
      createdAt: Date.now(),
    };
    await actions.addSaving(s);
    setForm({ name: '', goal: '', saved: '' });
  }
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card>
        <SectionTitle>Nueva meta de ahorro</SectionTitle>
        <form onSubmit={addSaving} className="grid gap-3">
          <input
            className="border rounded-lg p-2"
            placeholder="Nombre (ej. Fondo de emergencia)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className="border rounded-lg p-2"
            type="number"
            min={0}
            step="1"
            placeholder="Meta (CLP)"
            value={form.goal}
            onChange={(e) => setForm({ ...form, goal: e.target.value })}
          />
          <input
            className="border rounded-lg p-2"
            type="number"
            min={0}
            step="1"
            placeholder="Ahorro inicial (CLP)"
            value={form.saved}
            onChange={(e) => setForm({ ...form, saved: e.target.value })}
          />
          <button className="px-3 py-2 rounded-xl border bg-gray-900 text-white">
            Agregar meta
          </button>
        </form>
      </Card>

      <Card className="lg:col-span-2">
        <SectionTitle>Metas</SectionTitle>
        <div className="space-y-3">
          {data.savings.map((s) => {
            const pct = s.goal > 0 ? (s.saved / s.goal) * 100 : 0;
            return (
              <div
                key={s.id || s.name + s.goal}
                className="border rounded-xl p-3"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{s.name}</div>
                    <div className="text-sm text-gray-600">
                      Ahorrado: <Money n={s.saved} /> / Meta:{' '}
                      <Money n={s.goal} />
                    </div>
                  </div>
                  <div className="w-56">
                    <Progress value={pct} />
                    <div className="text-xs text-gray-600 mt-1">
                      Completado: {pct.toFixed(1)}%
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step="1"
                    placeholder="Aporte (CLP)"
                    className="border rounded-lg p-2"
                    id={`sav-${s.id}`}
                  />
                  <button
                    className="px-3 py-2 rounded-xl border"
                    onClick={async () => {
                      const el = document.getElementById(`sav-${s.id}`);
                      const amt = Number(el?.value || 0);
                      await actions.updateSaving(s.id, {
                        saved: Number(s.saved || 0) + amt,
                      });
                      if (el) el.value = '';
                    }}
                  >
                    Registrar aporte
                  </button>
                  <button
                    className="ml-auto text-red-600"
                    onClick={() => actions.removeSaving(s.id)}
                  >
                    Eliminar
                  </button>
                </div>
              </div>
            );
          })}
          {data.savings.length === 0 && (
            <div className="text-gray-500">Sin metas registradas.</div>
          )}
        </div>
      </Card>
    </div>
  );
}

function Investments({ data, actions }) {
  const [form, setForm] = useState({ name: '', contributed: '', current: '' });
  async function addInv(e) {
    e.preventDefault();
    const i = {
      name: form.name || 'Inversión',
      contributed: Number(form.contributed || 0),
      current: Number(form.current || 0),
      createdAt: Date.now(),
    };
    await actions.addInvestment(i);
    setForm({ name: '', contributed: '', current: '' });
  }
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card>
        <SectionTitle>Nueva inversión</SectionTitle>
        <form onSubmit={addInv} className="grid gap-3">
          <input
            className="border rounded-lg p-2"
            placeholder="Nombre (ej. ETF SP500)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className="border rounded-lg p-2"
            type="number"
            min={0}
            step="1"
            placeholder="Contribuido (CLP)"
            value={form.contributed}
            onChange={(e) => setForm({ ...form, contributed: e.target.value })}
          />
          <input
            className="border rounded-lg p-2"
            type="number"
            min={0}
            step="1"
            placeholder="Valor actual (CLP)"
            value={form.current}
            onChange={(e) => setForm({ ...form, current: e.target.value })}
          />
          <button className="px-3 py-2 rounded-xl border bg-gray-900 text-white">
            Agregar inversión
          </button>
        </form>
      </Card>

      <Card className="lg:col-span-2">
        <SectionTitle>Portafolio</SectionTitle>
        <div className="space-y-3">
          {data.investments.map((i) => {
            const roi =
              i.contributed > 0
                ? ((i.current - i.contributed) / i.contributed) * 100
                : 0;
            return (
              <div
                key={i.id || i.name + i.contrib}
                className="border rounded-xl p-3"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{i.name}</div>
                    <div className="text-sm text-gray-600">
                      Contribuido: <Money n={i.contributed} /> · Actual:{' '}
                      <Money n={i.current} /> · ROI: {roi.toFixed(2)}%
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      step="1"
                      className="border rounded-lg p-2 w-40"
                      placeholder="Nuevo valor"
                      id={`inv-${i.id}`}
                    />
                    <button
                      className="px-3 py-2 rounded-xl border"
                      onClick={async () => {
                        const el = document.getElementById(`inv-${i.id}`);
                        await actions.updateInvestment(i.id, {
                          current: Number(el?.value || 0),
                        });
                        if (el) el.value = '';
                      }}
                    >
                      Actualizar
                    </button>
                    <button
                      className="text-red-600"
                      onClick={() => actions.removeInvestment(i.id)}
                    >
                      Eliminar
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          {data.investments.length === 0 && (
            <div className="text-gray-500">Sin inversiones registradas.</div>
          )}
        </div>
      </Card>
    </div>
  );
}

function Settings({ data, householdId }) {
  function exportJSON() {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `finanzas-familiares-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <SectionTitle>Datos</SectionTitle>
        <div className="flex flex-col gap-2">
          <button className="px-3 py-2 rounded-xl border" onClick={exportJSON}>
            Exportar JSON (respaldo local)
          </button>
          <div className="text-sm text-gray-600">
            Código del hogar para compartir con tu familia:{' '}
            <strong>{householdId}</strong>
          </div>
        </div>
      </Card>
      <Card>
        <SectionTitle>Categorías</SectionTitle>
        <ul className="list-disc pl-6 mt-2 text-sm">
          {CATEGORIES.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState('dashboard');
  const [ctx, setCtx] = useState(null); // { user, householdId }
  const [selectedHid, setSelectedHid] = useState(null);

  // Restaurar hogar previo (si existe)
  useEffect(() => {
    const last = localStorage.getItem('lastHouseholdId');
    if (!selectedHid && last) setSelectedHid(last);
  }, [selectedHid]);

  // Guardar cuando se seleccione/cambie
  useEffect(() => {
    if (selectedHid) localStorage.setItem('lastHouseholdId', selectedHid);
  }, [selectedHid]);

  const [authedUser, setAuthedUser] = useState(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setAuthedUser(u));
    return () => unsub();
  }, []);

  // Hook a nivel superior (si no hay householdId, sólo no suscribe)
  const h = useHouseholdData(selectedHid);

  const handleLogout = async () => {
    await signOut(auth);
    setCtx(null);
    setSelectedHid(null); // <- importante
    setTab('dashboard');
  };

  if (!ctx)
    return (
      <div className="min-h-screen bg-gray-50">
        <Header
          currentTab={tab}
          setTab={setTab}
          user={authedUser}
          onLogout={handleLogout}
          householdId={null}
        />
        <AuthGate onReady={(c) => setCtx(c)} />
        <footer className="text-center text-xs text-gray-500 p-4">
          V2 · Firebase · Diseñado por un padre de familia
        </footer>
      </div>
    );

  // Si hay sesión pero aún no se eligió hogar, muestra el selector
  if (ctx && !selectedHid) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header
          currentTab={'dashboard'}
          setTab={() => {}}
          user={ctx.user}
          onLogout={handleLogout}
          householdId={null}
        />
        <main className="max-w-5xl mx-auto p-4 grid gap-4">
          <HouseholdPicker
            user={ctx.user}
            onEnter={(hid) => {
              setSelectedHid(hid);
              setTab('dashboard');
            }}
          />
        </main>
        <footer className="text-center text-xs text-gray-500 p-4">
          V2 · Firebase/Firestore en tiempo real
        </footer>
      </div>
    );
  }

  const data = {
    budgets: h.budgets,
    transactions: h.transactions,
    debts: h.debts,
    savings: h.savings,
    investments: h.investments,
  };

  const actions = {
    setBudget: h.setBudget,
    addTransaction: h.addTransaction,
    removeTransaction: h.removeTransaction,
    addDebt: h.addDebt,
    updateDebt: h.updateDebt,
    removeDebt: h.removeDebt,
    addSaving: h.addSaving,
    updateSaving: h.updateSaving,
    removeSaving: h.removeSaving,
    addInvestment: h.addInvestment,
    updateInvestment: h.updateInvestment,
    removeInvestment: h.removeInvestment,
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        currentTab={tab}
        setTab={setTab}
        user={ctx.user}
        onLogout={handleLogout}
        householdId={selectedHid}
      />

      <main className="max-w-6xl mx-auto p-4 grid gap-4">
        {tab === 'dashboard' && (
          <Dashboard
            data={{
              budgets: data.budgets,
              transactions: data.transactions,
              debts: data.debts,
              savings: data.savings,
              investments: data.investments,
            }}
          />
        )}
        {tab === 'transactions' && (
          <Transactions
            data={{ transactions: data.transactions }}
            actions={actions}
            user={ctx.user}
          />
        )}
        {tab === 'budgets' && (
          <Budgets
            data={{ budgets: data.budgets, transactions: data.transactions }}
            actions={actions}
          />
        )}
        {tab === 'debts' && (
          <Debts data={{ debts: data.debts }} actions={actions} />
        )}
        {tab === 'savings' && (
          <Savings data={{ savings: data.savings }} actions={actions} />
        )}
        {tab === 'investments' && (
          <Investments
            data={{ investments: data.investments }}
            actions={actions}
          />
        )}
          {tab === 'settings' && (
            <Settings
              data={{
                budgets: data.budgets,
                transactions: data.transactions,
                debts: data.debts,
                savings: data.savings,
                investments: data.investments,
              }}
              householdId={selectedHid}
            />
          )}
        </main>
      <footer className="text-center text-xs text-gray-500 p-4">
        V2 · Firebase/Firestore en tiempo real
      </footer>
    </div>
  );
}
