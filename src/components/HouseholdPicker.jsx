// src/components/HouseholdPicker.jsx
import React from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot, doc, setDoc, arrayUnion, updateDoc } from 'firebase/firestore';
import { createHousehold, joinHousehold } from '../services/households';

export default function HouseholdPicker({ user, onEnter }) {
  const [list, setList] = React.useState([]);
  const [displayName, setDisplayName] = React.useState(
    user?.email || 'Usuario'
  );
  const [householdName, setHouseholdName] = React.useState('');
  const [code, setCode] = React.useState('');
  const [tip, setTip] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  // Carga hogares donde participa el usuario
  React.useEffect(() => {
    if (!user?.uid) return;
    const q = query(
      collection(db, 'households'),
      where('members', 'array-contains', user.uid)
    );
    const unsub = onSnapshot(q, (snap) => {
      setList(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return () => unsub();
  }, [user?.uid]);

  async function setDefault(hid) {
    await setDoc(
      doc(db, 'profiles', user.uid),
      { defaultHouseholdId: hid, householdIds: arrayUnion(hid) },
      { merge: true }
    );
  }

  async function handleCreate() {
    try {
      setBusy(true);
      const hid = await createHousehold(
        user.uid,
        displayName || user.email,
        householdName
      );
      await setDefault(hid);
      onEnter(hid);
    } catch (e) {
      console.error(e);
      setTip(
        e?.code === 'permission-denied'
          ? 'Tu sesión está activa, pero Firestore bloqueó la creación. Revisa las reglas de seguridad.'
          : e.message || 'No se pudo crear el hogar.'
      );
    }
    setBusy(false);
  }

  async function handleJoin() {
    try {
      setBusy(true);
      const hid = await joinHousehold(
        user.uid,
        code,
        displayName || user.email
      );
      await setDefault(hid);
      onEnter(hid);
    } catch (e) {
      console.error(e);
      setTip(
        e?.code === 'permission-denied'
          ? 'Tu sesión está activa, pero Firestore bloqueó la operación. Verifica las reglas o la conexión.'
          : e.message || 'Código inválido'
      );
    }
    setBusy(false);
  }

  async function renameHousehold(hid) {
    const newName = window.prompt('Nuevo nombre del hogar:');
    if (!newName || !newName.trim()) return;
    await updateDoc(doc(db, 'households', hid), { name: newName.trim() });
  }

  return (
    <div className="max-w-6xl mx-auto grid gap-6 md:grid-cols-3">
      {/* Columna 1-2: Tus hogares */}
      <section className="md:col-span-2 bg-white border rounded-2xl shadow-sm p-5">
        <header className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <span aria-hidden>🏠</span> Tus hogares
          </h2>
          <span className="text-xs text-gray-500">
            Elige uno para entrar o márcalo como predeterminado.
          </span>
        </header>

        {list.length === 0 ? (
          <div className="rounded-xl border border-dashed p-6 text-center text-gray-600">
            <svg
              aria-hidden
              className="mx-auto mb-3"
              width="96"
              height="64"
              viewBox="0 0 96 64"
              fill="none"
            >
              <path d="M8 40L48 12L88 40" stroke="#9CA3AF" strokeWidth="3" />
              <rect
                x="18"
                y="36"
                width="60"
                height="24"
                rx="4"
                stroke="#D1D5DB"
                strokeWidth="2"
              />
              <rect
                x="42"
                y="46"
                width="12"
                height="14"
                rx="2"
                fill="#E5E7EB"
              />
            </svg>
            <p className="font-medium">Aún no perteneces a ningún hogar.</p>
            <p className="text-sm">
              Crea uno nuevo o ingresa un código para unirte.
            </p>
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {list.map((h) => (
              <li
                key={h.id}
                className="border rounded-xl p-4 flex items-start gap-3 hover:shadow-sm transition"
              >
                <div className="text-2xl" aria-hidden>
                  🏡
                </div>
                <div className="flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-lg font-semibold tracking-wide">
                        {h.name || 'Hogar sin nombre'}
                      </div>
                      <div className="text-xs text-gray-500">
                        Código: {h.id}
                      </div>
                    </div>
                    <div className="text-xs text-gray-500">
                      {Array.isArray(h.members)
                        ? `${h.members.length} miembro(s)`
                        : '—'}
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={() => onEnter(h.id)}
                      className="px-3 py-1.5 rounded-lg text-sm font-medium bg-gray-900 text-white hover:bg-gray-800"
                      title="Entrar a este hogar"
                    >
                      Entrar
                    </button>
                    <button
                      onClick={() => setDefault(h.id)}
                      className="px-3 py-1.5 rounded-lg text-sm border hover:bg-gray-50"
                      title="Marcar como predeterminado"
                    >
                      Predeterminado
                    </button>
                    <button
                      onClick={() => renameHousehold(h.id)}
                      className="px-3 py-1.5 rounded-lg text-sm border hover:bg-gray-50"
                      title="Renombrar hogar"
                    >
                      Renombrar
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Columna 3: Crear / Unirse */}
      <section className="bg-white border rounded-2xl shadow-sm p-5">
        <h3 className="text-lg font-semibold mb-3">Crear / Unirse</h3>

        {/* Crear */}
        <div className="space-y-2 mb-6">
          <p className="text-sm text-gray-700">
            Tu nombre (como te verá tu familia)
          </p>
          <input
            className="border rounded-lg p-2 w-full"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Tu nombre"
          />
          <p className="text-sm text-gray-700">Nombre del hogar (opcional)</p>
          <input
            className="border rounded-lg p-2 w-full"
            value={householdName}
            onChange={(e) => setHouseholdName(e.target.value)}
            placeholder="p. ej. Familia Ortiz"
          />
          <button
            onClick={busy ? undefined : handleCreate}
            className="mt-2 w-full px-3 py-2 rounded-lg bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-60"
            disabled={busy}
          >
            {busy ? 'Guardando…' : 'Crear hogar'}
          </button>
        </div>

        {/* Unirse */}
        <div className="space-y-2">
          <p className="text-sm text-gray-700">Código de hogar</p>
          <input
            className="border rounded-lg p-2 w-full"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="p. ej. a1b2c3d"
          />
          <button
            onClick={busy ? undefined : handleJoin}
            className="w-full px-3 py-2 rounded-lg border hover:bg-gray-50 disabled:opacity-60"
            disabled={busy}
          >
            {busy ? 'Guardando…' : 'Unirme'}
          </button>
        </div>

        {tip && (
          <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {tip}
          </div>
        )}
      </section>
    </div>
  );
}
