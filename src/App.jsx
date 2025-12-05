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
  sendPasswordResetEmail,
  reauthenticateWithCredential,
  EmailAuthProvider,
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
  getDocs,
  query,
  where,
} from 'firebase/firestore';

// --- Utils ---
const CATEGORIES = [
  'Hogar',
  'Alimentación',
  'Transporte',
  'Salud',
  'Servicios (luz/agua/internet)',
  'Educación',
  'Entretenimiento',
  'Vestuario',
  'Otros',
];

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const date = new Date(y, m - 1 + delta, 1);
  return monthKey(date);
}

function formatMonthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  const date = new Date(y, m - 1, 1);
  return date.toLocaleDateString('es-CL', {
    month: 'long',
    year: 'numeric',
  });
}

// periodo de presupuesto según día de corte
function getBudgetPeriod(monthKeyStr, cutDay = 1) {
  const [y, m] = monthKeyStr.split('-').map(Number);
  const day = Math.max(1, Math.min(28, Number(cutDay) || 1)); // limitar 1–28
  const start = new Date(y, m - 1, day);
  const end = new Date(y, m, day); // siguiente mes mismo día

  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  return { start: startStr, end: endStr };
}

// etiqueta legible del periodo según día de corte (ej: "28-nov al 27-dic")
function formatBudgetPeriodLabel(monthKeyStr, cutDay = 1) {
  const { start, end } = getBudgetPeriod(monthKeyStr, cutDay);

  // start y end vienen como "YYYY-MM-DD"
  const startDate = new Date(start + 'T00:00:00');
  const endExclusive = new Date(end + 'T00:00:00');

  // el periodo real llega hasta el día anterior a end (end es exclusivo)
  endExclusive.setDate(endExclusive.getDate() - 1);

  const fmt = (d) =>
    d
      .toLocaleDateString('es-CL', {
        day: '2-digit',
        month: 'short',
      })
      .replace('.', ''); // para quitar el punto de "nov."

  return `${fmt(startDate)} al ${fmt(endExclusive)}`;
}

// Dado un día cualquiera y el día de corte, calcula a qué "mes de presupuesto" pertenece
function budgetMonthKeyForDate(dateStr, cutDay = 1) {
  if (!dateStr) return monthKey(new Date());

  const d = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return monthKey(new Date());

  const day = d.getDate();
  const offset = day >= cutDay ? 0 : -1; // si el día es menor al corte, pertenece al mes "anterior" de presupuesto

  const base = new Date(d.getFullYear(), d.getMonth() + offset, 1);
  return monthKey(base);
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
    <div className={`rounded-2xl shadow-sm dark:shadow-none border p-4 bg-white dark:bg-gray-800 ${className}`}>
      {children}
    </div>
  );
}

function Progress({ value, mode = 'risk' }) {
  const raw = Number.isFinite(Number(value)) ? Number(value) : 0;
  const v = Math.max(0, raw);
  const width = Math.min(100, v);

  let color = 'bg-green-600';

  if (mode === 'good') {
    // Bueno cuando el porcentaje es ALTO (deudas pagadas, ahorro, ROI)
    if (v >= 90) color = 'bg-green-600';
    else if (v >= 60) color = 'bg-amber-500';
    else color = 'bg-red-500';
  } else {
    // Riesgo: rojo solo si te pasas del 100%
    if (v > 100) color = 'bg-red-500';
    else if (v >= 90) color = 'bg-amber-500';
    else color = 'bg-green-600';
  }

  return (
    <div className="w-full h-3 rounded-full bg-gray-200">
      <div
        className={`h-3 rounded-full ${color}`}
        style={{ width: `${width}%` }}
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

// --- Household helpers ---
async function createHousehold(uid, displayName, email) {
  const id = uid.slice(0, 6) + Math.random().toString(36).slice(2, 5);
  const ref = doc(db, 'households', id);
  const categories = [...CATEGORIES];
const currentMonth = monthKey(); // ej: "2024-12"

const budgets = {
  [currentMonth]: categories.reduce((acc, c) => {
    acc[c] = { plan: 0, funded: 0 };
    return acc;
  }, {}),
};


  const superUser = {
    id: 'super-admin',
    name: '',
    pin: '',
    isSuperAdmin: true,
    preferences: {
      defaultTab: 'dashboard',
      showOnlyMyMovements: false,
      dashboardCards: {
        resumenMes: true,
        deudas: true,
        ahorro: true,
        presupuestos: true,
      },
      transactionsDefaults: {
        type: 'gasto',
        defaultCategory: categories[0],
      },
      ui: {
        theme: 'light',
        density: 'normal',
      },
    },
  };

  await setDoc(ref, {
    id,
    members: [uid],
    memberInfo: { [uid]: { name: displayName || email || 'Administrador' } },
    categories,
    budgets,
    createdAt: Date.now(),
    superAdminUid: uid,
    superAdminEmail: email || null,
    householdUsers: [superUser],
    budgetCutDay: 1, // día de corte por defecto
  });
  return id;
}

// garantiza un solo hogar por usuario
async function ensureSingleHouseholdForUser(user) {
  const uid = user.uid;
  const email = user.email || '';
  const displayName = user.displayName || email || 'Administrador';

  const profRef = doc(db, 'profiles', uid);
  const profSnap = await getDoc(profRef);

  let householdId = null;

  if (profSnap.exists()) {
    const prof = profSnap.data() || {};
    householdId =
      prof.householdId ||
      prof.defaultHouseholdId ||
      (Array.isArray(prof.householdIds) && prof.householdIds[0]) ||
      null;
  }

  if (!householdId) {
    householdId = await createHousehold(uid, displayName, email);
  }

  await setDoc(
    profRef,
    {
      name: displayName,
      householdId,
    },
    { merge: true }
  );

  return householdId;
}

async function joinHousehold(uid, code, displayName) {
  const ref = doc(db, 'households', code);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Código de hogar inválido');
  const data = snap.data();
  if (!data.members.includes(uid)) {
    await updateDoc(ref, {
      members: arrayUnion(uid),
      memberInfo: {
        ...(data.memberInfo || {}),
        [uid]: { name: displayName || 'Usuario' },
      },
    });
  }
  return code;
}

function Header({ currentTab, setTab, user, onLogout, householdId }) {
  const showTabs = Boolean(user && householdId);
  const showLogout = Boolean(user);

  const tabs = [
    ['dashboard', 'Dashboard'],
    ['transactions', 'Movimientos'],
    ['budgets', 'Presupuestos'],
    ['debts', 'Deudas'],
    ['savings', 'Ahorro'],
    ['settings', 'Ajustes'],
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 p-3 bg-white dark:bg-gray-800/70 backdrop-blur sticky top-0 z-10 border-b">
      <div className="text-2xl font-bold">Finanzas en Familia</div>

      <div className="flex flex-wrap gap-2 ml-auto">
        {showTabs &&
          tabs.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-3 py-1.5 rounded-full border text-sm ${
                currentTab === key ? 'bg-gray-900 text-white' : 'bg-white dark:bg-gray-800'
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
  const [phase, setPhase] = useState('loading'); // loading | auth | ready
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [tip, setTip] = useState('');
  const [resetMsg, setResetMsg] = useState('');
  const [resetError, setResetError] = useState('');

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
        const hid = await ensureSingleHouseholdForUser(u);
        setPhase('ready');
        onReady({ user: u, householdId: hid });
      } catch (e) {
        console.error('Error asegurando hogar único:', e);
        setTip('No se pudo cargar tus datos. Intenta más tarde.');
        setPhase('auth');
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
    return `No se pudo iniciar sesión (${code}).`;
  }

  async function handleLogin(e) {
    e.preventDefault();

    if (!email?.trim() || !pass?.trim()) {
      setTip('Ingresa un email y contraseña válidos');
      return;
    }
    setTip('');

    try {
      if (isRegister) {
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        const hid = await ensureSingleHouseholdForUser(cred.user);
        setUser(cred.user);
        setPhase('ready');
        onReady({ user: cred.user, householdId: hid });
      } else {
        await signInWithEmailAndPassword(auth, email, pass);
      }
    } catch (err) {
      console.error(err);
      setTip(mapAuthError(err));
    }
  }

  async function handleResetPassword() {
    setResetMsg('');
    setResetError('');

    const mail = (email || '').trim();
    if (!mail) {
      setResetError('Escribe tu email para enviarte el enlace de recuperación.');
      return;
    }

    try {
      await sendPasswordResetEmail(auth, mail);
      setResetMsg(
        'Te enviamos un correo con el enlace para restablecer tu contraseña. Revisa también tu carpeta de Spam o Correos no deseados.'
      );
    } catch (err) {
      console.error('Error reset password:', err);
      const code = String(err?.code || '');
      if (code.includes('user-not-found')) {
        setResetError('No existe un usuario registrado con ese email.');
      } else if (code.includes('invalid-email')) {
        setResetError('El email no es válido.');
      } else {
        setResetError('No se pudo enviar el correo de recuperación. Intenta más tarde.');
      }
    }
  }

  if (phase === 'loading')
    return <div className="p-8 text-center">Cargando…</div>;

  if (phase === 'auth')
    return (
      <div className="max-w-6xl mx-auto grid md:grid-cols-2 items-start gap-10 py-8 px-4">
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
              <div className="absolute -bottom-10 left-0 bg-red-50 text-red-700 border border-red-200 rounded-md px-3 py-2 text-sm shadow-sm dark:shadow-none">
                {tip}
              </div>
            )}
          </form>

          <div className="mt-3 flex flex-col gap-1 text-sm">
            <button
              type="button"
              className="text-blue-600 text-left"
              onClick={handleResetPassword}
            >
              ¿Olvidaste tu contraseña?
            </button>

            {resetMsg && <div className="text-xs text-green-700">{resetMsg}</div>}
            {resetError && <div className="text-xs text-red-600">{resetError}</div>}
          </div>

          <button
            className="text-sm mt-4"
            onClick={() => setIsRegister(!isRegister)}
          >
            {isRegister
              ? '¿Ya tienes cuenta? Inicia sesión'
              : '¿No tienes cuenta? Regístrate'}
          </button>
        </Card>

        <Card>
          <h3 className="text-lg font-semibold mb-3">Tu centro de control</h3>
          <ul className="space-y-2 text-sm ext-gray-900 dark:text-gray-100">
            <li>✅ Presupuestos por categoría con % de avance</li>
            <li>✅ Movimientos y conciliación rápida</li>
            <li>✅ Deudas y ahorro</li>
            <li>✅ Sesión familiar compartida</li>
          </ul>
        </Card>
      </div>
    );

  return null;
}

// --- Hooks de datos (Firestore) ---
function useHouseholdData(householdId) {
  const [categories, setCategories] = useState(CATEGORIES);
  const [budgets, setBudgets] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [debts, setDebts] = useState([]);
  const [savings, setSavings] = useState([]);
  const [householdUsers, setHouseholdUsers] = useState([]);
  const [superAdminEmail, setSuperAdminEmail] = useState(null);
  const [budgetCutDay, setBudgetCutDayState] = useState(1);

  useEffect(() => {
    if (!householdId) return;

    const unsubHH = onSnapshot(doc(db, 'households', householdId), (snap) => {
      const d = snap.data() || {};
      const cats =
        d.categories && Array.isArray(d.categories)
          ? d.categories
          : [...CATEGORIES];
      setCategories(cats);

      // Presupuestos por mes guardados en el campo "budgets"
      const rawBudgets = d.budgets || {};
      setBudgets(rawBudgets);



      let rawUsers = Array.isArray(d.householdUsers) ? d.householdUsers : [];
      const hasSuper = rawUsers.some((u) => u.isSuperAdmin);

      if (!hasSuper && d.superAdminEmail) {
        const superUser = {
          id: 'super-admin',
          name: '',
          pin: '',
          isSuperAdmin: true,
          preferences: {
            defaultTab: 'dashboard',
            showOnlyMyMovements: false,
            dashboardCards: {
              resumenMes: true,
              deudas: true,
              ahorro: true,
              presupuestos: true,
            },
            transactionsDefaults: {
              type: 'gasto',
              defaultCategory: cats[0] || CATEGORIES[0],
            },
            ui: {
              theme: 'light',
              density: 'normal',
            },
          },
        };
        rawUsers = [...rawUsers, superUser];

        updateDoc(doc(db, 'households', householdId), {
          householdUsers: rawUsers,
        }).catch((err) => console.error('Error auto-creando super admin:', err));
      }

      setHouseholdUsers(rawUsers);
      setSuperAdminEmail(d.superAdminEmail || null);
      setBudgetCutDayState(d.budgetCutDay || 1);
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

    return () => {
      unsubHH();
      unsubTx();
      unsubDebts();
      unsubSavings();
    };
  }, [householdId]);

  // Helpers internos para no repetir lógica
  function normalizeBudgetEntry(entry) {
    if (typeof entry === 'number') {
      const n = Number(entry || 0);
      return { plan: n, funded: n };
    }
    if (entry && typeof entry === 'object') {
      const plan = Number(entry.plan || 0);
      const funded = Number(
        entry.funded !== undefined ? entry.funded : (entry.plan || 0)
      );
      return { plan, funded };
    }
    return { plan: 0, funded: 0 };
  }

  async function setBudget(cat, value) {
    // Compatibilidad: setea plan y funded al mismo valor
    const n = Number(value || 0);
    const ref = doc(db, 'households', householdId);
    const snap = await getDoc(ref);
    const b = snap.data().budgets || {};
    const prev = normalizeBudgetEntry(b[cat]);
    const next = { ...b, [cat]: { ...prev, plan: n, funded: n } };
    await updateDoc(ref, { budgets: next });
  }

  async function setBudgetPlan(cat, value) {
    const n = Number(value || 0);
    const ref = doc(db, 'households', householdId);
    const snap = await getDoc(ref);
    const b = snap.data().budgets || {};
    const prev = normalizeBudgetEntry(b[cat]);
    const next = { ...b, [cat]: { ...prev, plan: n } };
    await updateDoc(ref, { budgets: next });
  }

async function setBudgetFunded(monthKeyStr, cat, value) {
  const n = Number(value || 0);
  const ref = doc(db, 'households', householdId);
  const snap = await getDoc(ref);
  const data = snap.data() || {};

  // Usamos el campo "budgets" como mapa de meses
  const allBudgets = data.budgets || {};

  const mk = monthKeyStr || monthKey(); // por si llega vacío
  const monthBudgets = allBudgets[mk] || {};

  const prev = normalizeBudgetEntry(monthBudgets[cat]);
  const nextMonthBudgets = {
    ...monthBudgets,
    [cat]: { ...prev, funded: n },
  };

  const nextAllBudgets = {
    ...allBudgets,
    [mk]: nextMonthBudgets,
  };

  await updateDoc(ref, { budgets: nextAllBudgets });
}



  async function addTransaction(tx) {
    try {
      await addDoc(collection(db, 'households', householdId, 'transactions'), tx);
    } catch (e) {
      console.error('Error al guardar transacción:', e);
      alert('No se pudo guardar el movimiento. Revisa la consola.');
    }
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

  async function addCategory(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return;

    const ref = doc(db, 'households', householdId);
    const snap = await getDoc(ref);
    const data = snap.data() || {};

    const currentCats = Array.isArray(data.categories)
      ? data.categories
      : [...CATEGORIES];

    if (currentCats.includes(trimmed)) return;

    const newCats = [...currentCats, trimmed];
    const currentBudgets = data.budgets || {};
    const newBudgets = {
      ...currentBudgets,
      [trimmed]: { plan: 0, funded: 0 },
    };

    await updateDoc(ref, {
      categories: newCats,
      budgets: newBudgets,
    });
  }

  async function removeCategory(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return;

    const ref = doc(db, 'households', householdId);
    const snap = await getDoc(ref);
    const data = snap.data() || {};

    const currentCats = Array.isArray(data.categories)
      ? data.categories
      : [...CATEGORIES];

    const newCats = currentCats.filter((c) => c !== trimmed);
    const currentBudgets = data.budgets || {};
    const newBudgets = { ...currentBudgets };
    delete newBudgets[trimmed];

    await updateDoc(ref, {
      categories: newCats,
      budgets: newBudgets,
    });
  }

  async function renameCategory(oldName, newName) {
    const from = String(oldName || '').trim();
    const to = String(newName || '').trim();
    if (!from || !to || from === to) return;

    const hhRef = doc(db, 'households', householdId);
    const snap = await getDoc(hhRef);
    const data = snap.data() || {};

    const currentCats = Array.isArray(data.categories)
      ? data.categories
      : [...CATEGORIES];

    if (!currentCats.includes(from)) return;
    if (currentCats.includes(to)) return;

    const newCats = currentCats.map((c) => (c === from ? to : c));

    const currentBudgets = data.budgets || {};
    const newBudgets = { ...currentBudgets };
    const prev = normalizeBudgetEntry(currentBudgets[from]);
    newBudgets[to] = prev;
    delete newBudgets[from];

    await updateDoc(hhRef, {
      categories: newCats,
      budgets: newBudgets,
    });

    const txCol = collection(db, 'households', householdId, 'transactions');
    const q = query(txCol, where('category', '==', from));
    const txSnap = await getDocs(q);

    const updates = txSnap.docs.map((d) =>
      updateDoc(doc(db, 'households', householdId, 'transactions', d.id), {
        category: to,
      })
    );
    await Promise.all(updates);
  }

  async function saveHouseholdUsers(nextUsers) {
    if (!householdId) return;
    const ref = doc(db, 'households', householdId);
    await updateDoc(ref, { householdUsers: nextUsers });
  }

  async function addHouseholdUser(user) {
    const base = Array.isArray(householdUsers) ? householdUsers : [];
    const newUser = {
      id: user.id || Math.random().toString(36).slice(2, 10),
      name: user.name || 'Usuario',
      pin: user.pin || '',
      isSuperAdmin: !!user.isSuperAdmin,
      preferences: user.preferences || {
        defaultTab: 'dashboard',
        showOnlyMyMovements: false,
        dashboardCards: {
          resumenMes: true,
          deudas: true,
          ahorro: true,
          presupuestos: true,
        },
        transactionsDefaults: {
          type: 'gasto',
          defaultCategory: categories[0] || CATEGORIES[0],
        },
        ui: {
          theme: 'light',
          density: 'normal',
        },
      },
    };
    const next = [...base, newUser];
    setHouseholdUsers(next);
    await saveHouseholdUsers(next);
  }

  async function updateHouseholdUser(id, patch) {
    const base = Array.isArray(householdUsers) ? householdUsers : [];
    const next = base.map((u) => (u.id === id ? { ...u, ...patch } : u));
    setHouseholdUsers(next);
    await saveHouseholdUsers(next);
  }

  async function removeHouseholdUser(id) {
    const base = Array.isArray(householdUsers) ? householdUsers : [];
    const target = base.find((u) => u.id === id);
    if (target?.isSuperAdmin) return;

    const next = base.filter((u) => u.id !== id);
    setHouseholdUsers(next);
    await saveHouseholdUsers(next);
  }

  async function setBudgetCutDay(day) {
    const n = Math.max(1, Math.min(28, Number(day) || 1));
    const ref = doc(db, 'households', householdId);
    await updateDoc(ref, { budgetCutDay: n });
    setBudgetCutDayState(n);
  }

  return {
    categories,
    budgets,
    transactions,
    debts,
    savings,
    householdUsers,
    superAdminEmail,
    budgetCutDay,
    setBudget,
    setBudgetPlan,
    setBudgetFunded,
    addTransaction,
    removeTransaction,
    addDebt,
    updateDebt,
    removeDebt,
    addSaving,
    updateSaving,
    removeSaving,
    addCategory,
    removeCategory,
    renameCategory,
    addHouseholdUser,
    updateHouseholdUser,
    removeHouseholdUser,
    setBudgetCutDay,
  };
}
function filterTransactionsByPeriodAndUser(
  transactions,
  monthKeyStr,
  budgetCutDay,
  activeUser,
  showOnlyMine
) {
  if (!Array.isArray(transactions)) return [];

  const { start, end } = getBudgetPeriod(monthKeyStr, budgetCutDay);

  return transactions.filter((tx) => {
    const txDate = tx.date || '';
    if (!txDate) return false;

    // mismo criterio que Dashboard/Budgets: [start, end)
    if (txDate < start || txDate >= end) return false;

    if (showOnlyMine && activeUser?.id) {
      return tx.ownerId === activeUser.id;
    }

    return true;
  });
}


function Transactions({
  data,
  actions,
  activeUser,
  monthKeyStr,
  superAdminEmail,
  budgetCutDay,
}) {
  const { transactions = [], categories = [] } = data || {};
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



  const periodLabel = useMemo(
    () => formatBudgetPeriodLabel(monthKeyStr, budgetCutDay),
    [monthKeyStr, budgetCutDay]
  );

  const filtered = useMemo(() => {
    let base = filterTransactionsByPeriodAndUser(
      transactions,
      monthKeyStr,
      budgetCutDay,
      activeUser,
      showOnlyMine
    );

    if (filterType !== 'todos') {
      base = base.filter((tx) =>
        filterType === 'ingresos' ? tx.type === 'ingreso' : tx.type === 'gasto'
      );
    }

    if (filterCategory !== 'todas') {
      base = base.filter((tx) => tx.category === filterCategory);
    }

    // Orden descendente por fecha (más reciente arriba)
    base.sort((a, b) => {
      const da = new Date((a.date || a.createdAt || '1970-01-01') + 'T00:00:00').getTime();
      const db = new Date((b.date || b.createdAt || '1970-01-01') + 'T00:00:00').getTime();
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
      category: type === 'gasto' ? (category || categories[0] || 'Otros') : '',
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
                      {tx.description || <span className="text-gray-400">—</span>}
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
// --- DASHBOARD & PRESUPUESTOS ---
function Dashboard({ data, monthKeyStr }) {
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
  const { start, end } = getBudgetPeriod(mk, budgetCutDay);
  const monthTx = transactions.filter((t) => {
    const d = t.date || '';
    return d >= start && d < end;
  });

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
      funded = Number(
        b.funded !== undefined ? b.funded : (b.plan || 0)
      );
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
    { original: 0, remaining: 0 }
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
    { goal: 0, saved: 0 }
  );

  const savingsProgress =
    savingsTotals.goal > 0 ? (savingsTotals.saved / savingsTotals.goal) * 100 : 0;

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

function Budgets({ data, actions, monthKeyStr }) {
  const {
    budgets = {},
    transactions = [],
    categories = [],
    budgetCutDay = 1,
  } = data || {};

  const cats = categories && categories.length ? categories : CATEGORIES;
  const mk = monthKeyStr;
  const cutDay = budgetCutDay;

  // Periodo actual y anterior (según día de corte)
  const { start, end } = getBudgetPeriod(mk, cutDay);
  const prevMk = shiftMonth(mk, -1);
  const { start: prevStart, end: prevEnd } = getBudgetPeriod(prevMk, cutDay);

  const [viewMode, setViewMode] = useState('amount'); // amount | percent

  const monthTx = transactions.filter((t) => {
    const d = t.date || '';
    return d >= start && d < end;
  });

  const prevMonthTx = transactions.filter((t) => {
    const d = t.date || '';
    return d >= prevStart && d < prevEnd;
  });

  // --- ROLLOVER ---
  const ingresosPrev = prevMonthTx
    .filter((t) => t.type === 'ingreso')
    .reduce((a, b) => a + Number(b.amount || 0), 0);

  const gastosPrev = prevMonthTx
    .filter((t) => t.type === 'gasto')
    .reduce((a, b) => a + Number(b.amount || 0), 0);

  const saldoAnterior = ingresosPrev - gastosPrev; // puede ser + o -

  const ingresosPeriodo = monthTx
    .filter((t) => t.type === 'ingreso')
    .reduce((a, b) => a + Number(b.amount || 0), 0);

  const gastosPeriodo = monthTx
    .filter((t) => t.type === 'gasto')
    .reduce((a, b) => a + Number(b.amount || 0), 0);

  const disponible = saldoAnterior + ingresosPeriodo;
  const balanceFinal = disponible - gastosPeriodo;

  // --- FILAS POR CATEGORÍA ---
  const rows = cats.map((c) => {
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
      funded = Number(
        b.funded !== undefined ? b.funded : (b.plan || 0)
      );
    }

    const pctFundedUsed = funded > 0 ? (spent / funded) * 100 : 0;

    return { c, spent, plan, funded, pctFundedUsed };
  });

  const totalFunded = rows.reduce((a, r) => a + r.funded, 0);
  const totalSpent = rows.reduce((a, r) => a + r.spent, 0);

  const restanteSinAsignar = disponible - totalFunded;
  const pctUsadoSobreFunded =
    totalFunded > 0 ? (totalSpent / totalFunded) * 100 : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* IZQUIERDA: categorías */}
      <Card className="lg:col-span-2">
        <SectionTitle
          right={
            <button
              className="px-3 py-1.5 rounded-full border text-sm"
              onClick={() =>
                setViewMode(viewMode === 'amount' ? 'percent' : 'amount')
              }
            >
              {viewMode === 'amount' ? 'Ver porcentaje' : 'Ver montos'}
            </button>
          }
        >
          Presupuestos por categoría
        </SectionTitle>

        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.c} className="border rounded-xl p-3">
              <div className="text-sm font-medium mb-2">{r.c}</div>

              <div className="flex flex-col gap-3">
                {/* Barra: Gasto vs Presupuesto */}
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="flex justify-between text-xs mb-1">
                      <span>Gasto vs Presupuestado</span>
                      <span>
                        {viewMode === 'amount' ? (
                          <>
                            <Money n={r.spent} /> / <Money n={r.funded} />
                          </>
                        ) : (
                          <>
                            {r.funded > 0
                              ? `${r.pctFundedUsed.toFixed(0)}% usado`
                              : '0% usado'}
                          </>
                        )}
                      </span>
                    </div>
                    <Progress value={r.pctFundedUsed} />
                  </div>

{/* Input: Presupuesto (antes "Asignado") */}
<div className="w-32 text-xs">
  <label className="flex flex-col gap-1">
    <span>Presupuesto</span>
    <input
      type="number"
      min={0}
      step="1"
      className="border rounded-lg px-2 py-1 text-right"
      value={r.funded || ''}
      onChange={(e) =>
        actions.setBudgetFunded(mk, r.c, e.target.value)
      }
    />
  </label>
</div>

                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* DERECHA: resumen del período con rollover */}
      <Card>
      <SectionTitle>Resumen del período</SectionTitle>
      <div className="space-y-2 text-sm">
        {/* Bloque 1: Antes de presupuestar */}
        <div className="text-xs font-semibold text-gray-500 uppercase">
          1. Antes de presupuestar
        </div>

        <div className="flex justify-between">
          <span>Lo que traes del período anterior</span>
          <strong>
            <Money n={saldoAnterior} />
          </strong>
        </div>
        <div className="flex justify-between">
          <span>Ingresos de este período</span>
          <strong>
            <Money n={ingresosPeriodo} />
          </strong>
        </div>
        <div className="flex justify-between">
          <span>Total disponible para este período</span>
          <strong>
            <Money n={disponible} />
          </strong>
        </div>

        <hr className="my-2" />

        {/* Bloque 2: Tu presupuesto */}
        <div className="text-xs font-semibold text-gray-500 uppercase">
          2. Tu presupuesto
        </div>

        <div className="flex justify-between">
          <span>Lo que ya asignaste en presupuestos</span>
          <strong>
            <Money n={totalFunded} />
          </strong>
        </div>
        <div className="flex justify-between">
          <span>Te queda por asignar / te pasaste</span>
          <strong
            className={
              restanteSinAsignar < 0 ? 'text-red-600' : 'text-green-700'
            }
          >
            <Money n={restanteSinAsignar} />
          </strong>
        </div>

        <hr className="my-2" />

        {/* Bloque 3: Lo que ha ocurrido de verdad */}
        <div className="text-xs font-semibold text-gray-500 uppercase">
          3. Lo que ha ocurrido de verdad
        </div>

        <div className="flex justify-between">
          <span>Gastado hasta ahora</span>
          <strong>
            <Money n={gastosPeriodo} />
          </strong>
        </div>
        <div className="flex justify-between">
          <span>Te queda al final (si no gastas más)</span>
          <strong
            className={
              balanceFinal < 0 ? 'text-red-600' : 'text-green-700'
            }
          >
            <Money n={balanceFinal} />
          </strong>
        </div>
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span>% usado sobre tu presupuesto</span>
            <span>
              {totalFunded > 0
                ? `${pctUsadoSobreFunded.toFixed(0)}%`
                : '—'}
            </span>
          </div>
          <Progress value={pctUsadoSobreFunded} />
        </div>

        <div className="text-xs text-gray-500">
          Día de corte del mes: {budgetCutDay}
        </div>
      </div>

      </Card>
    </div>
  );
}
// --- DEUDAS & AHORRO ---

function Debts({ data, actions }) {
  const debts = data?.debts || [];

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
          {debts.map((d) => {
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
                    <Progress value={progress} mode="good" />
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
                      if (amt <= 0) return;
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
          {debts.length === 0 && (
            <div className="text-gray-500">Sin deudas registradas.</div>
          )}
        </div>
      </Card>
    </div>
  );
}

function Savings({ data, actions }) {
  const savings = data?.savings || [];

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
          {savings.map((s) => {
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
                    <Progress value={pct} mode="good" />
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
                      if (amt <= 0) return;
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
          {savings.length === 0 && (
            <div className="text-gray-500">Sin metas registradas.</div>
          )}
        </div>
      </Card>
    </div>
  );
}
function Settings({
  data,
  householdId,
  user,
  categories,
  actions,
  activeHouseholdUser,
}) {
  const [newCategory, setNewCategory] = useState('');
  const [showUserModal, setShowUserModal] = useState(false);
  const [userForm, setUserForm] = useState({
    id: null,
    name: '',
    pin: '',
    isSuperAdmin: false,
    adminPin: '',
  });

  const cats = categories && categories.length ? categories : CATEGORIES;
  const users = Array.isArray(data.householdUsers) ? data.householdUsers : [];

  // Solo es super admin si el usuario de la casa seleccionado tiene isSuperAdmin = true
  const isSuperAdmin = !!activeHouseholdUser?.isSuperAdmin;

  const superAdminUser = users.find((u) => u.isSuperAdmin) || null;
  const familyUsers = users.filter((u) => !u.isSuperAdmin);

  function displayName(u) {
    if (u.name && u.name.trim()) return u.name.trim();
    if (u.isSuperAdmin && data.superAdminEmail) return data.superAdminEmail;
    return u.isSuperAdmin ? 'Administrador' : 'Usuario';
  }

  function startCreateUser() {
    setUserForm({
      id: null,
      name: '',
      pin: '',
      isSuperAdmin: false,
      adminPin: '',
    });
    setShowUserModal(true);
  }

  function startEditUser(u) {
    setUserForm({
      id: u.id,
      name: u.name || '',
      pin: u.pin || '',
      isSuperAdmin: !!u.isSuperAdmin,
      adminPin: '',
    });
    setShowUserModal(true);
  }

  async function handleSaveUser(e) {
    e.preventDefault();
    const trimmedName = userForm.name.trim();
    const pin = (userForm.pin || '').trim();

    if (!trimmedName && !userForm.isSuperAdmin) return;

    const currentSuper = superAdminUser;
    const hasFamily = familyUsers.length > 0;

    if (userForm.isSuperAdmin) {
      if (!currentSuper) {
        alert(
          'No se encontró al administrador del hogar. Revisa tus datos en Firestore.'
        );
        return;
      }

      if (hasFamily && !pin) {
        alert(
          'Hay usuarios familiares configurados. El administrador debe tener un PIN y no puede dejarlo en blanco.'
        );
        return;
      }

      await actions.updateHouseholdUser(userForm.id, {
        name: trimmedName,
        pin,
      });

      setShowUserModal(false);
      setUserForm({
        id: null,
        name: '',
        pin: '',
        isSuperAdmin: false,
        adminPin: '',
      });

      return;
    }

    const isNew = !userForm.id;

    if (!currentSuper) {
      alert(
        'No se puede crear un usuario familiar porque no existe un administrador definido.'
      );
      return;
    }

    if (isNew && !currentSuper.pin) {
      alert(
        'Antes de crear el primer usuario familiar debes definir un PIN para el administrador.'
      );
      setShowUserModal(false);
      setTimeout(() => {
        setUserForm({
          id: currentSuper.id,
          name: currentSuper.name || '',
          pin: '',
          isSuperAdmin: true,
          adminPin: '',
        });
        setShowUserModal(true);
      }, 0);
      return;
    }

    if (isNew) {
      const adminPinInput = (userForm.adminPin || '').trim();

      if (!adminPinInput) {
        alert(
          'Debes ingresar el PIN del administrador para crear un usuario familiar.'
        );
        return;
      }

      if (adminPinInput !== currentSuper.pin) {
        alert('PIN de administrador incorrecto. No se creó el usuario.');
        return;
      }

      await actions.addHouseholdUser({
        name: trimmedName,
        pin,
        isSuperAdmin: false,
      });
    } else {
      await actions.updateHouseholdUser(userForm.id, {
        name: trimmedName,
        pin,
      });
    }

    setShowUserModal(false);
    setUserForm({
      id: null,
      name: '',
      pin: '',
      isSuperAdmin: false,
      adminPin: '',
    });
  }

  // --- Preferencias personales por usuario de la casa ---
  const [prefs, setPrefs] = useState(() => {
    const base = activeHouseholdUser?.preferences || {};
    return {
      defaultTab: base.defaultTab || 'dashboard',
      showOnlyMyMovements: !!base.showOnlyMyMovements,
      dashboardCards: {
        resumenMes: base.dashboardCards?.resumenMes ?? true,
        deudas: base.dashboardCards?.deudas ?? true,
        ahorro: base.dashboardCards?.ahorro ?? true,
        inversiones: base.dashboardCards?.inversiones ?? false, // por si en el futuro reactivas inversiones
        presupuestos: base.dashboardCards?.presupuestos ?? true,
      },
      transactionsDefaults: {
        type: base.transactionsDefaults?.type || 'gasto',
        defaultCategory:
          base.transactionsDefaults?.defaultCategory || cats[0] || CATEGORIES[0],
      },
      ui: {
        theme: base.ui?.theme || 'light',
        density: base.ui?.density || 'normal',
      },
    };
  });

  useEffect(() => {
    const base = activeHouseholdUser?.preferences || {};
    setPrefs({
      defaultTab: base.defaultTab || 'dashboard',
      showOnlyMyMovements: !!base.showOnlyMyMovements,
      dashboardCards: {
        resumenMes: base.dashboardCards?.resumenMes ?? true,
        deudas: base.dashboardCards?.deudas ?? true,
        ahorro: base.dashboardCards?.ahorro ?? true,
        inversiones: base.dashboardCards?.inversiones ?? false,
        presupuestos: base.dashboardCards?.presupuestos ?? true,
      },
      transactionsDefaults: {
        type: base.transactionsDefaults?.type || 'gasto',
        defaultCategory:
          base.transactionsDefaults?.defaultCategory || cats[0] || CATEGORIES[0],
      },
      ui: {
        theme: base.ui?.theme || 'light',
        density: base.ui?.density || 'normal',
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHouseholdUser?.id, cats.join('|')]);

  async function handleSavePreferences(e) {
    e.preventDefault();
    if (!activeHouseholdUser) return;
    await actions.updateHouseholdUser(activeHouseholdUser.id, {
      preferences: prefs,
    });
    alert('Preferencias guardadas.');
  }

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        {/* Columna izquierda: sólo super admin ve Usuarios y Día de corte */}
        <div className="space-y-4">
          {isSuperAdmin && (
            <Card>
              <SectionTitle
                right={
                  isSuperAdmin && (
                    <button
                      className="px-3 py-1.5 rounded-full border text-sm"
                      onClick={startCreateUser}
                    >
                      + Agregar
                    </button>
                  )
                }
              >
                Usuarios de la casa
              </SectionTitle>

              {users.length === 0 && (
                <div className="text-sm text-gray-600">
                  Aún no hay usuarios configurados. Usa “Agregar” para crear los
                  integrantes de la casa.
                </div>
              )}

              {users.length > 0 && (
                <ul className="mt-3 space-y-2 text-sm">
                  {users.map((u) => (
                    <li
                      key={u.id}
                      className="flex items-center justify-between border rounded-lg px-3 py-2"
                    >
                      <div>
                        <div className="font-medium">
                          {displayName(u)}{' '}
                          {u.isSuperAdmin && (
                            <span className="text-xs text-gray-500">
                              (Admin)
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500">
                          {u.isSuperAdmin && data.superAdminEmail && (
                            <span className="block">
                              Correo: {data.superAdminEmail}
                            </span>
                          )}
                          PIN:{' '}
                          {u.pin
                            ? '••••'
                            : u.isSuperAdmin
                            ? 'Sin PIN (debes configurarlo si hay familiares)'
                            : 'Sin PIN (entra solo seleccionando el usuario)'}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="text-xs text-blue-600"
                          onClick={() => startEditUser(u)}
                        >
                          Editar
                        </button>
                        {!u.isSuperAdmin && (
                          <button
                            type="button"
                            className="text-xs text-red-600"
                            onClick={async () => {
                              const ok = window.confirm(
                                `¿Eliminar al usuario "${displayName(u)}"?`
                              );
                              if (!ok) return;
                              await actions.removeHouseholdUser(u.id);
                            }}
                          >
                            Eliminar
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          {isSuperAdmin && (
            <Card>
              <SectionTitle>Día de corte del mes</SectionTitle>
              <form
                className="grid gap-3"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const formData = new FormData(e.currentTarget);
                  const day = formData.get('cut-day') || data.budgetCutDay || 1;
                  await actions.setBudgetCutDay(day);
                  alert('Día de corte actualizado.');
                }}
              >
                <div className="grid gap-1">
                  <label className="text-sm">
                    Día (1 al 28 recomendado por meses cortos)
                  </label>
                  <input
                    type="number"
                    name="cut-day"
                    min={1}
                    max={28}
                    defaultValue={data.budgetCutDay || 1}
                    className="border rounded-lg p-2 w-32"
                  />
                  <p className="text-xs text-gray-500">
                    El presupuesto se calculará desde ese día de un mes hasta el
                    día anterior del mes siguiente.
                  </p>
                </div>
                <button className="px-3 py-2 rounded-xl border bg-gray-900 text-white text-sm">
                  Guardar día de corte
                </button>
              </form>
            </Card>
          )}

          <Card>
            <SectionTitle>Preferencias personales</SectionTitle>
            {!activeHouseholdUser && (
              <p className="text-sm text-gray-600">
                Primero selecciona quién está usando la app para configurar sus
                preferencias.
              </p>
            )}

            {activeHouseholdUser && (
              <form
                className="grid gap-3 mt-2"
                onSubmit={handleSavePreferences}
                autoComplete="off"
              >
                <div className="grid gap-1">
                  <label className="text-sm">Configurando a</label>
                  <div className="border rounded-lg p-2 bg-gray-50 dark:bg-gray-900 text-sm">
                    {displayName(activeHouseholdUser)}
                  </div>
                </div>

                <div className="border rounded-xl p-3">
                  <div className="font-medium text-sm mb-2">
                    Valores por defecto al crear movimiento
                  </div>
                  <div className="grid gap-2 text-sm">
                    <div className="grid gap-1">
                      <label>Tipo por defecto</label>
                      <select
                        className="border rounded-lg p-2"
                        value={prefs.transactionsDefaults.type}
                        onChange={(e) =>
                          setPrefs((prev) => ({
                            ...prev,
                            transactionsDefaults: {
                              ...prev.transactionsDefaults,
                              type: e.target.value,
                            },
                          }))
                        }
                      >
                        <option value="gasto">Gasto</option>
                        <option value="ingreso">Ingreso</option>
                      </select>
                    </div>
                    <div className="grid gap-1">
                      <label>Categoría por defecto (para gasto)</label>
                      <select
                        className="border rounded-lg p-2"
                        value={prefs.transactionsDefaults.defaultCategory}
                        onChange={(e) =>
                          setPrefs((prev) => ({
                            ...prev,
                            transactionsDefaults: {
                              ...prev.transactionsDefaults,
                              defaultCategory: e.target.value,
                            },
                          }))
                        }
                      >
                        {cats.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                <div className="border rounded-xl p-3">
                  <div className="font-medium text-sm mb-2">Vista y filtros</div>
                  <div className="grid gap-2 text-sm">
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="rounded border-gray-300"
                        checked={prefs.showOnlyMyMovements}
                        onChange={(e) =>
                          setPrefs((prev) => ({
                            ...prev,
                            showOnlyMyMovements: e.target.checked,
                          }))
                        }
                      />
                      <span>Mostrar solo mis movimientos en la vista Movimientos</span>
                    </label>
                  </div>
                </div>

                <div className="border rounded-xl p-3">
                  <div className="font-medium text-sm mb-2">Aspecto</div>
                  <div className="grid gap-2 text-sm">
                    <div className="grid gap-1">
                      <label>Tema</label>
                      <select
                        className="border rounded-lg p-2"
                        value={prefs.ui.theme}
                        onChange={(e) =>
                          setPrefs((prev) => ({
                            ...prev,
                            ui: { ...prev.ui, theme: e.target.value },
                          }))
                        }
                      >
                        <option value="light">Claro</option>
                        <option value="dark">Oscuro</option>
                      </select>
                    </div>
                    <div className="grid gap-1">
                      <label>Densidad</label>
                      <select
                        className="border rounded-lg p-2"
                        value={prefs.ui.density}
                        onChange={(e) =>
                          setPrefs((prev) => ({
                            ...prev,
                            ui: { ...prev.ui, density: e.target.value },
                          }))
                        }
                      >
                        <option value="normal">Normal</option>
                        <option value="compact">Compacta (más filas)</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end gap-2 mt-2">
                  <button
                    type="submit"
                    className="px-3 py-1.5 text-sm border rounded-lg bg-gray-900 text-white"
                  >
                    Guardar preferencias
                  </button>
                </div>
              </form>
            )}
          </Card>
        </div>

        {/* Columna derecha: categorías (visible para todos) */}
        <Card>
          <SectionTitle>Categorías</SectionTitle>

          <form
            className="flex gap-2 mt-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const name = newCategory.trim();
              if (!name) return;
              await actions.addCategory(name);
              setNewCategory('');
            }}
          >
            <input
              className="border rounded-lg p-2 flex-1"
              placeholder="Nueva categoría (ej. Mascotas)"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
            />
            <button
              type="submit"
              className="px-3 py-2 rounded-xl border bg-gray-900 text-white text-sm"
            >
              Agregar
            </button>
          </form>

          <ul className="list-disc pl-6 mt-4 text-sm space-y-2">
            {cats.map((c) => (
              <li
                key={c}
                className="flex items-center justify-between gap-2"
              >
                <span>{c}</span>
                <div className="flex flex-col gap-1 sm:flex-row">
                  <button
                    type="button"
                    className="text-xs text-blue-600"
                    onClick={async () => {
                      const nuevo = window.prompt(
                        `Nuevo nombre para la categoría "${c}"`,
                        c
                      );
                      if (!nuevo) return;
                      await actions.renameCategory(c, nuevo);
                    }}
                  >
                    Renombrar
                  </button>
                  <button
                    type="button"
                    className="text-xs text-red-600"
                    onClick={async () => {
                      const ok = window.confirm(
                        `¿Eliminar la categoría "${c}"? Los presupuestos de esa categoría se perderán.`
                      );
                      if (!ok) return;
                      await actions.removeCategory(c);
                    }}
                  >
                    Eliminar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {/* Modal flotante para crear/editar usuario */}
      {isSuperAdmin && showUserModal && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40">
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold mb-3">
              {userForm.isSuperAdmin
                ? 'Editar administrador'
                : userForm.id
                ? 'Editar usuario'
                : 'Nuevo usuario'}
            </h3>
            <form
              className="grid gap-3"
              onSubmit={handleSaveUser}
              autoComplete="off"
            >
              {userForm.isSuperAdmin && (
                <div className="grid gap-1">
                  <label className="text-sm">Correo (no editable)</label>
                  <input
                    className="border rounded-lg p-2 bg-gray-100 dark:bg-gray-900 text-gray-600"
                    value={data.superAdminEmail || ''}
                    readOnly
                  />
                </div>
              )}

              <div className="grid gap-1">
                <label className="text-sm">
                  {userForm.isSuperAdmin ? 'Nombre (opcional)' : 'Nombre'}
                </label>
                <input
                  className="border rounded-lg p-2"
                  value={userForm.name}
                  onChange={(e) =>
                    setUserForm((prev) => ({
                      ...prev,
                      name: e.target.value,
                    }))
                  }
                  required={!userForm.isSuperAdmin}
                />
              </div>

              <div className="grid gap-1">
                <label className="text-sm">
                  PIN{' '}
                  {userForm.isSuperAdmin && familyUsers.length > 0 && '(obligatorio)'}
                </label>
                <input
                  className="border rounded-lg p-2"
                  type="text"
                  inputMode="numeric"
                  pattern="\d*"
                  name="household-pin"
                  autoComplete="off"
                  data-lpignore="true"
                  data-form-type="other"
                  style={{ WebkitTextSecurity: 'disc' }}
                  value={userForm.pin}
                  onChange={(e) =>
                    setUserForm((prev) => ({
                      ...prev,
                      pin: e.target.value,
                    }))
                  }
                />

                <p className="text-xs text-gray-500">
                  {userForm.isSuperAdmin
                    ? 'El PIN del administrador se usará para autorizar la creación de usuarios familiares y para bloquear el acceso si no se elige editor.'
                    : 'PIN opcional para este usuario. Si tiene PIN, se pedirá al entrar como este usuario.'}
                </p>
              </div>

              {!userForm.isSuperAdmin &&
                !userForm.id &&
                superAdminUser &&
                superAdminUser.pin && (
                  <div className="grid gap-1">
                    <label className="text-sm">
                      PIN del administrador (para autorizar)
                    </label>
                    <input
                      className="border rounded-lg p-2"
                      type="text"
                      inputMode="numeric"
                      pattern="\d*"
                      name="admin-authorization-pin"
                      autoComplete="off"
                      data-lpignore="true"
                      data-form-type="other"
                      style={{ WebkitTextSecurity: 'disc' }}
                      value={userForm.adminPin}
                      onChange={(e) =>
                        setUserForm((prev) => ({
                          ...prev,
                          adminPin: e.target.value,
                        }))
                      }
                      required
                    />

                    <p className="text-xs text-gray-500">
                      Escribe el PIN del administrador del hogar para confirmar la
                      creación de este usuario familiar.
                    </p>
                  </div>
                )}

              <div className="flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  className="px-3 py-1.5 text-sm border rounded-lg"
                  onClick={() => setShowUserModal(false)}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-3 py-1.5 text-sm border rounded-lg bg-gray-900 text-white"
                >
                  Guardar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

export default function App() {
  const [tab, setTab] = useState('dashboard');
  const [ctx, setCtx] = useState(null);
  const [selectedMonth, setSelectedMonth] = useState(monthKey());

  const [selectedHouseholdUserId, setSelectedHouseholdUserId] = useState(
    () => localStorage.getItem('activeHouseholdUserId') || null
  );
  const [showUserSelector, setShowUserSelector] = useState(false);
  const [loginUserId, setLoginUserId] = useState('');
  const [loginPin, setLoginPin] = useState('');
  const [loginError, setLoginError] = useState('');
  const [useAccountPassword, setUseAccountPassword] = useState(false);
  const [accountPassword, setAccountPassword] = useState('');
  const [hasForcedUserSelection, setHasForcedUserSelection] = useState(false);

  const selectedHid = ctx?.householdId || null;

  useEffect(() => {
    if (selectedHouseholdUserId) {
      localStorage.setItem('activeHouseholdUserId', selectedHouseholdUserId);
    } else {
      localStorage.removeItem('activeHouseholdUserId');
    }
  }, [selectedHouseholdUserId]);

  const [authedUser, setAuthedUser] = useState(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setAuthedUser(u));
    return () => unsub();
  }, []);

  const h = useHouseholdData(selectedHid);

  const budgetsForSelectedMonth =
  (h.budgets && h.budgets[selectedMonth]) || {};


  const householdUsers = h.householdUsers || [];
  const activeUser =
    householdUsers.find((u) => u.id === selectedHouseholdUserId) || null;

  useEffect(() => {
    if (!selectedHid) return;

    if (!householdUsers.length) {
      setShowUserSelector(false);
      setSelectedHouseholdUserId(null);
      return;
    }

    const superAdmin = householdUsers.find((u) => u.isSuperAdmin);
    const superHasPin =
      !!(superAdmin && superAdmin.pin && superAdmin.pin.trim());

    if (!superHasPin) {
      setShowUserSelector(false);
      const exists = householdUsers.find(
        (u) => u.id === selectedHouseholdUserId
      );
      if (!exists) {
        setSelectedHouseholdUserId(householdUsers[0].id);
      }
      return;
    }

    if (hasForcedUserSelection) {
      const exists = householdUsers.find(
        (u) => u.id === selectedHouseholdUserId
      );
      if (!exists) {
        setShowUserSelector(true);
        setLoginUserId(
          (superAdmin && superAdmin.id) || householdUsers[0].id
        );
        setLoginPin('');
        setLoginError('');
      }
      return;
    }

    setShowUserSelector(true);
    setHasForcedUserSelection(true);
    setSelectedHouseholdUserId(null);
    setLoginUserId(
      (superAdmin && superAdmin.id) || householdUsers[0].id
    );
    setLoginPin('');
    setLoginError('');
  }, [
    selectedHid,
    householdUsers,
    selectedHouseholdUserId,
    hasForcedUserSelection,
  ]);

  async function handleUserLogin(e) {
    e.preventDefault();
    setLoginError('');

    const user = householdUsers.find((u) => u.id === loginUserId);
    if (!user) {
      setLoginError('Usuario inválido');
      return;
    }

    // MODO NORMAL: validar PIN
    if (!useAccountPassword) {
      if (user.pin && user.pin !== loginPin) {
        setLoginError('PIN incorrecto');
        return;
      }
    } else {
      // MODO RECUPERAR PIN (solo super admin, usando contraseña de la cuenta)
      if (!user.isSuperAdmin) {
        setLoginError('Solo el administrador puede usar la contraseña de la cuenta.');
        return;
      }

      const current = auth.currentUser;
      if (!current || !current.email) {
        setLoginError(
          'No se pudo validar tu cuenta. Vuelve a iniciar sesión e inténtalo de nuevo.'
        );
        return;
      }

      if (!accountPassword.trim()) {
        setLoginError('Escribe la contraseña de tu cuenta.');
        return;
      }

      try {
        const cred = EmailAuthProvider.credential(
          current.email,
          accountPassword.trim()
        );
        await reauthenticateWithCredential(current, cred);
        // Si no lanza error, la contraseña es correcta.
      } catch (err) {
        console.error('Error reautenticando:', err);
        setLoginError('Contraseña de la cuenta incorrecta.');
        return;
      }
    }

    // Si llegó aquí, pasó la validación (PIN o contraseña)
    setSelectedHouseholdUserId(user.id);
    setShowUserSelector(false);
    setLoginPin('');
    setAccountPassword('');
    setUseAccountPassword(false);
    setLoginError('');
  }

  async function handleAdminLoginWithPassword(password) {
    if (!authedUser || !authedUser.email) {
      setLoginError(
        'Primero debes iniciar sesión con tu email y contraseña.'
      );
      return;
    }

    const adminUser = householdUsers.find((u) => u.isSuperAdmin);
    if (!adminUser) {
      setLoginError('No hay un administrador configurado en este hogar.');
      return;
    }

    try {
      const cred = EmailAuthProvider.credential(authedUser.email, password);
      await reauthenticateWithCredential(authedUser, cred);

      setSelectedHouseholdUserId(adminUser.id);
      setShowUserSelector(false);
      setLoginPin('');
      setLoginError('');
    } catch (err) {
      console.error('Error reautenticando admin:', err);
      setLoginError('Contraseña incorrecta.');
    }
  }

  const handleLogout = async () => {
    await signOut(auth);
    setCtx(null);
    setSelectedHouseholdUserId(null);
    setHasForcedUserSelection(false);
    setTab('dashboard');
  };

  useEffect(() => {
    setHasForcedUserSelection(false);
  }, [selectedHid]);

  const userPrefs = activeUser?.preferences || {};
  const theme = userPrefs.ui?.theme || 'light';
  const density = userPrefs.ui?.density || 'normal';
  const showOnlyMyMovements = !!userPrefs.showOnlyMyMovements;

  const data = {
  categories: h.categories,
  budgets: budgetsForSelectedMonth,
  transactions: h.transactions,
  debts: h.debts,
  savings: h.savings,
  householdUsers: h.householdUsers,
  superAdminEmail: h.superAdminEmail,
  budgetCutDay: h.budgetCutDay,
};

  

  const actions = {
    setBudget: h.setBudget,
    setBudgetPlan: h.setBudgetPlan,
    setBudgetFunded: (monthKeyStr, cat, value) => h.setBudgetFunded(monthKeyStr, cat, value),
    addTransaction: h.addTransaction,
    removeTransaction: h.removeTransaction,
    addDebt: h.addDebt,
    updateDebt: h.updateDebt,
    removeDebt: h.removeDebt,
    addSaving: h.addSaving,
    updateSaving: h.updateSaving,
    removeSaving: h.removeSaving,
    addCategory: h.addCategory,
    removeCategory: h.removeCategory,
    renameCategory: h.renameCategory,
    addHouseholdUser: h.addHouseholdUser,
    updateHouseholdUser: h.updateHouseholdUser,
    removeHouseholdUser: h.removeHouseholdUser,
    setBudgetCutDay: h.setBudgetCutDay,
  };
  

  const superAdminUser =
    householdUsers.find((u) => u.isSuperAdmin) || null;
  const superAdminHasPin =
    !!(superAdminUser && superAdminUser.pin && superAdminUser.pin.trim());

  const hasCtx = !!ctx;

  const headerUser = hasCtx ? ctx.user : authedUser;
  const headerHouseholdId = hasCtx ? selectedHid : null;

  return (
    <div
      className={
        theme === 'dark'
          ? 'min-h-screen bg-gray-900 text-gray-100'
          : 'min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100'
      }
    >
      <Header
        currentTab={tab}
        setTab={setTab}
        user={headerUser}
        onLogout={handleLogout}
        householdId={headerHouseholdId}
      />

      {hasCtx && showUserSelector && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-6 w-full max-w-md text-gray-900 dark:text-gray-100">
            <h2 className="text-lg font-semibold mb-3">
              ¿Quién está usando la app?
            </h2>
            {householdUsers.length === 0 ? (
              <p className="text-sm text-gray-600">
                No hay usuarios configurados aún. Ve a Ajustes &gt; Usuarios de la
                casa para crearlos.
              </p>
            ) : (
              <form
                className="grid gap-3"
                onSubmit={handleUserLogin}
                autoComplete="off"
              >
                <div className="grid gap-1">
                  <label className="text-sm">Usuario</label>
                  <select
                    className="border rounded-lg p-2"
                    value={loginUserId}
                    onChange={(e) => {
                      setLoginUserId(e.target.value);
                      setLoginError('');
                      setUseAccountPassword(false);
                      setAccountPassword('');
                      setLoginPin('');
                    }}
                  >
                    {householdUsers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} {u.isSuperAdmin ? '(Admin)' : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid gap-2">
                  {!useAccountPassword && (
                    <div className="grid gap-1">
                      <label className="text-sm">
                        PIN (si el usuario no tiene PIN, deja en blanco)
                      </label>
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="\d*"
                        name="household-pin-login"
                        autoComplete="off"
                        data-lpignore="true"
                        data-form-type="other"
                        className="border rounded-lg p-2"
                        value={loginPin}
                        onChange={(e) => setLoginPin(e.target.value)}
                        placeholder="PIN (si el usuario no tiene PIN, deja en blanco)"
                        style={{ WebkitTextSecurity: 'disc' }}
                      />
                      <p className="text-xs text-gray-500">
                        Si olvidaste tu PIN, pídele ayuda al administrador del hogar.
                      </p>
                    </div>
                  )}

                  {useAccountPassword && (
                    <div className="grid gap-1">
                      <label className="text-sm">
                        Contraseña de tu cuenta (no el PIN)
                      </label>
                      <input
                        type="password"
                        name="admin-account-password"
                        autoComplete="current-password"
                        className="border rounded-lg p-2"
                        value={accountPassword}
                        onChange={(e) => setAccountPassword(e.target.value)}
                        placeholder="Escribe la contraseña de tu cuenta"
                      />
                      <p className="text-xs text-gray-500">
                        Usaremos tu contraseña de Firebase para confirmar que eres el
                        administrador y dejarte entrar aunque no recuerdes el PIN.
                      </p>
                    </div>
                  )}

                  {(() => {
                    const selectedUser = householdUsers.find(
                      (u) => u.id === loginUserId
                    );
                    if (!selectedUser || !selectedUser.isSuperAdmin) return null;
                    return (
                      <button
                        type="button"
                        className="text-xs text-blue-600 underline text-left"
                        onClick={() => {
                          setUseAccountPassword((prev) => !prev);
                          setLoginError('');
                        }}
                      >
                        {useAccountPassword
                          ? 'Volver a usar el PIN del admin'
                          : '¿Olvidaste tu PIN de admin? Entra usando tu contraseña de la cuenta.'}
                      </button>
                    );
                  })()}
                </div>

                {loginError && (
                  <div className="text-xs text-red-600">{loginError}</div>
                )}
                <div className="flex justify-end gap-2 mt-2">
                  {superAdminHasPin ? (
                    <button
                      type="button"
                      className="px-3 py-1.5 text-sm border rounded-lg"
                      onClick={handleLogout}
                    >
                      Cerrar sesión
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="px-3 py-1.5 text-sm border rounded-lg"
                      onClick={() => {
                        setShowUserSelector(false);
                        setLoginError('');
                      }}
                    >
                      Cancelar
                    </button>
                  )}
                  <button
                    type="submit"
                    className="px-3 py-1.5 text-sm border rounded-lg bg-gray-900 text-white"
                  >
                    Entrar
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      <div
        className={
          hasCtx && showUserSelector ? 'filter blur-sm pointer-events-none' : ''
        }
      >
        {hasCtx && tab !== 'settings' && (
          <div
            className={`max-w-6xl mx-auto px-4 mt-2 mb-1 flex items-center justify-between text-sm ${
              theme === 'dark'
                ? 'text-gray-100'
                : 'text-gray-900 dark:text-gray-100'
            }`}
          >
            <div className="flex items-center gap-2">
              <button
                className="px-2 py-1 border rounded-lg"
                onClick={() => setSelectedMonth((prev) => shiftMonth(prev, -1))}
              >
                ◀
              </button>
              <span className="font-medium">
                {formatBudgetPeriodLabel(selectedMonth, data.budgetCutDay || 1)}
              </span>
              <button
                className="px-2 py-1 border rounded-lg"
                onClick={() => setSelectedMonth((prev) => shiftMonth(prev, 1))}
              >
                ▶
              </button>
            </div>
            <div className="flex items-center gap-2">
            <button
              className="px-2 py-1 border rounded-lg"
              onClick={() => {
                const todayStr = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
                const currentBudgetKey = budgetMonthKeyForDate(
                  todayStr,
                  data.budgetCutDay || 1
                );
                setSelectedMonth(currentBudgetKey);
              }}
            >
              Ir al periodo actual
            </button>

            </div>
          </div>
        )}

<main
  className={`max-w-6xl mx-auto px-4 py-4 grid gap-4 ${
    density === 'compact' ? 'text-xs' : 'text-sm'
  }`}
>

          {!hasCtx && <AuthGate onReady={(c) => setCtx(c)} />}

          {hasCtx && tab === 'dashboard' && (
          <Dashboard
            data={{
              categories: data.categories,
              budgets: data.budgets,
              transactions: data.transactions,
              debts: data.debts,
              savings: data.savings,
              budgetCutDay: data.budgetCutDay,
              activeUserPreferences: userPrefs,
            }}
            monthKeyStr={selectedMonth}
          />
        )}


          {hasCtx && tab === 'transactions' && (
            <Transactions
              data={{
                transactions: data.transactions,
                categories: data.categories,
              }}
              actions={actions}
              activeUser={activeUser}
              monthKeyStr={selectedMonth}
              superAdminEmail={data.superAdminEmail || ctx.user?.email || null}
              budgetCutDay={data.budgetCutDay}
              onChangeMonth={setSelectedMonth}
            />
          )}

          {hasCtx && tab === 'budgets' && (
            <Budgets
              data={{
                budgets: data.budgets,
                transactions: data.transactions,
                categories: data.categories,
                budgetCutDay: data.budgetCutDay,
              }}
              actions={actions}
              monthKeyStr={selectedMonth}
            />
          )}

          {hasCtx && tab === 'debts' && (
            <Debts data={{ debts: data.debts }} actions={actions} />
          )}

          {hasCtx && tab === 'savings' && (
            <Savings data={{ savings: data.savings }} actions={actions} />
          )}

          {/* YA NO HAY VISTA DE INVERSIONES */}

          {hasCtx && tab === 'settings' && (
          <Settings
            data={{
              budgets: data.budgets,
              transactions: data.transactions,
              debts: data.debts,
              savings: data.savings,
              householdUsers: data.householdUsers,
              superAdminEmail: data.superAdminEmail,
              budgetCutDay: data.budgetCutDay,
            }}
            householdId={selectedHid}
            user={ctx.user}
            categories={data.categories}
            actions={actions}
            activeHouseholdUser={activeUser}
          />
        )}
        </main>

        <footer className="text-center text-xs text-gray-500 p-4">
          V2 · Firebase/Firestore en tiempo real
        </footer>
      </div>
    </div>
  );
}
