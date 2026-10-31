// src/features/settings/DangerZone.jsx
// Borrar todo el historial financiero del hogar para empezar desde cero.
// Solo el dueño del hogar; exige escribir BORRAR; descarga un respaldo antes de borrar
// y si el respaldo falla no borra nada.
import { useState } from 'react';
import { confirmDialog, toast } from '../../components/feedback/feedback.js';
import { todayKey } from '../../domain/dates.js';

const CONFIRM_WORD = 'BORRAR';

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DangerZone({ isOwner, onExport, onReset }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const canDelete = isOwner && typed.trim().toUpperCase() === CONFIRM_WORD && !busy;

  async function handleReset() {
    if (!canDelete || !onExport || !onReset) return;
    const ok = await confirmDialog(
      'Eliminar todo el registro histórico del hogar: movimientos, presupuestos, deudas, metas de ahorro y papelera.\n\nPrimero se descargará un respaldo en tu dispositivo. Esto afecta a todos los miembros del hogar y no se puede deshacer desde la app.',
      { title: '¿Empezar desde cero?', confirmLabel: 'Eliminar todo', danger: true },
    );
    if (!ok) return;

    setBusy(true);
    try {
      const backup = await onExport();
      downloadJson(backup, `respaldo-finanzas-${todayKey()}.json`);
    } catch (err) {
      console.error('Error al respaldar antes de borrar', { code: err?.code });
      toast.error('No se pudo generar el respaldo, así que no se borró nada. Inténtalo de nuevo.');
      setBusy(false);
      return;
    }

    try {
      const deleted = await onReset();
      setTyped('');
      toast.success(`Listo: se borraron ${deleted} registros. Empiezas desde cero.`);
    } catch (err) {
      console.error('Error al borrar el historial', { code: err?.code });
      toast.error('El borrado se interrumpió. Tienes el respaldo descargado; vuelve a intentarlo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="danger-zone-title"
      className="mt-6 rounded-2xl border-2 border-[color:var(--danger)]/60 bg-[color:var(--danger)]/5 p-5 space-y-3"
    >
      <h2 id="danger-zone-title" className="text-lg font-semibold text-[color:var(--danger)]">
        Zona de peligro: empezar desde cero
      </h2>
      <div className="rounded-xl border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 px-3 py-2 text-sm text-[color:var(--danger)]">
        <strong>Advertencia:</strong> se eliminará todo el registro histórico del hogar (movimientos,
        presupuestos, deudas, metas de ahorro y papelera) para todos sus miembros. No se puede
        deshacer desde la app. Se conservan el hogar, sus miembros, las categorías y el día de corte.
      </div>

      {isOwner ? (
        <>
          <label className="block text-sm">
            Para confirmar, escribe <strong>{CONFIRM_WORD}</strong>:
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              className="mt-1 w-full min-h-[44px] rounded-xl border border-[color:var(--danger)]/50 bg-[color:var(--input-bg)] px-3 text-sm"
              aria-describedby="danger-zone-title"
            />
          </label>
          <button
            type="button"
            onClick={handleReset}
            disabled={!canDelete}
            className="w-full sm:w-auto min-h-[48px] px-5 rounded-xl bg-[color:var(--danger)] text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? 'Respaldando y borrando…' : 'Eliminar todo el registro histórico'}
          </button>
          <p className="text-xs text-[color:var(--text-muted)]">
            Antes de borrar se descarga un archivo JSON con todo tu historial. Guárdalo en un lugar seguro:
            contiene tus datos financieros.
          </p>
        </>
      ) : (
        <p className="text-sm text-[color:var(--text-muted)]">
          Solo el dueño del hogar puede borrar el registro histórico.
        </p>
      )}
    </section>
  );
}
