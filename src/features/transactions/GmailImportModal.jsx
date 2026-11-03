import { useEffect, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { parseBankEmail } from '../../domain/bankEmailParser.js';
import { db } from '../../firebase';
import {
  prepareGmailAuthorization,
  readBancoEstadoEmails,
} from '../../lib/gmail.js';
import {
  CATEGORIES,
  DEBT_CATEGORY,
  SAVINGS_CATEGORY,
} from '../../constants.js';
import { TRANSFER_CATEGORY } from '../../domain/ledger.js';

const GOOGLE_CLIENT_ID = String(
  import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID || '',
).trim();

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function findImportedMessageIds(householdId, messageIds) {
  const imported = new Set();
  const transactions = collection(
    db,
    'households',
    householdId,
    'transactions',
  );
  for (const batch of chunks(messageIds, 30)) {
    const snapshot = await getDocs(
      query(transactions, where('sourceGmailId', 'in', batch)),
    );
    snapshot.docs.forEach((document) => {
      const id = document.data()?.sourceGmailId;
      if (id) imported.add(id);
    });
  }
  return imported;
}

export function GmailImportModal({
  onClose,
  householdId,
  activeUser,
  categories,
  householdUsers,
  addTransaction,
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [googleReady, setGoogleReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [scanInfo, setScanInfo] = useState('');

  const categorySource =
    Array.isArray(categories) && categories.length ? categories : CATEGORIES;
  const expenseCategories = categorySource.filter(
    (category) =>
      category !== DEBT_CATEGORY &&
      category !== SAVINGS_CATEGORY &&
      category !== TRANSFER_CATEGORY,
  );
  const members = Array.isArray(householdUsers) ? householdUsers : [];

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return undefined;
    let active = true;
    prepareGmailAuthorization()
      .then(() => {
        if (active) setGoogleReady(true);
      })
      .catch((loadError) => {
        if (active) {
          setError(loadError?.message || 'No se pudo preparar la autorización de Google.');
        }
      });
    return () => {
      active = false;
    };
  }, []);

  function updateCandidate(id, patch) {
    setCandidates((current) =>
      current.map((candidate) =>
        candidate.id === id ? { ...candidate, ...patch } : candidate,
      ),
    );
  }

  async function handleReadEmails() {
    setLoading(true);
    setError('');
    setNotice('');
    setCandidates([]);
    setScanInfo('');
    try {
      const { messages, truncated } = await readBancoEstadoEmails(GOOGLE_CLIENT_ID);
      const parsed = messages
        .map((message) => {
          const movement = parseBankEmail(message);
          return movement
            ? {
                id: message.id,
                subject: message.subject,
                ...movement,
                selected: true,
                category: '',
                description: movement.description.slice(0, 500),
              }
            : null;
        })
        .filter(Boolean);
      const importedIds = await findImportedMessageIds(
        householdId,
        parsed.map((message) => message.id),
      );
      const pending = parsed.filter((message) => !importedIds.has(message.id));
      const duplicates = parsed.length - pending.length;
      const skipped = messages.length - parsed.length;
      setCandidates(pending);
      setScanInfo(
        `${messages.length} correos revisados; ${pending.length} movimientos para revisar; ${duplicates} ya importados; ${skipped} sin monto o fecha reconocible.${
          truncated ? ' Se revisaron los 100 avisos más recientes.' : ''
        }`,
      );
      if (!messages.length) {
        setNotice('No se encontraron avisos de movimiento de los remitentes configurados.');
      }
    } catch (readError) {
      console.error('No se pudieron leer los avisos de BancoEstado:', {
        message: readError?.message,
      });
      setError(readError?.message || 'No se pudieron leer los correos de Gmail.');
    } finally {
      setLoading(false);
    }
  }

  async function handleImport() {
    const selected = candidates.filter((candidate) => candidate.selected);
    if (!selected.length) {
      setError('Selecciona al menos un movimiento para importar.');
      return;
    }
    const invalid = selected.find(
      (candidate) =>
        !candidate.type ||
        !Number.isSafeInteger(Number(candidate.amount)) ||
        Number(candidate.amount) <= 0 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(candidate.date) ||
        (candidate.type === 'gasto' && !candidate.category) ||
        (candidate.type === 'traspaso' &&
          (!candidate.fromUserId ||
            !candidate.toUserId ||
            candidate.fromUserId === candidate.toUserId)),
    );
    if (invalid) {
      setError(
        'Completa el tipo, monto, fecha y categoría de cada gasto seleccionado.',
      );
      return;
    }

    setSaving(true);
    setError('');
    let saved = 0;
    let failed = 0;
    for (const candidate of selected) {
      try {
        const isTransfer = candidate.type === 'traspaso';
        const fromMember = members.find((member) => member.id === candidate.fromUserId);
        const toMember = members.find((member) => member.id === candidate.toUserId);
        const id = await addTransaction({
          type: isTransfer ? 'gasto' : candidate.type,
          amount: Number(candidate.amount),
          ...(isTransfer
            ? {
                category: TRANSFER_CATEGORY,
                meta: {
                  kind: 'transfer',
                  fromUserId: candidate.fromUserId,
                  fromUserName: fromMember?.name || fromMember?.email || 'Miembro',
                  toUserId: candidate.toUserId,
                  toUserName: toMember?.name || toMember?.email || 'Miembro',
                },
              }
            : candidate.type === 'gasto'
            ? { category: candidate.category }
            : {}),
          description: candidate.description.trim(),
          date: candidate.date,
          ownerId: isTransfer ? fromMember?.id || null : activeUser?.id || null,
          ownerName: isTransfer
            ? fromMember?.name || fromMember?.email || null
            : activeUser?.name || null,
          ownerEmail: isTransfer
            ? fromMember?.email || null
            : activeUser?.email || null,
          createdAt: new Date().toISOString(),
          sourceGmailId: candidate.id,
        });
        if (id) saved += 1;
        else failed += 1;
      } catch (saveError) {
        console.error('No se pudo guardar un movimiento de Gmail:', {
          message: saveError?.message,
        });
        failed += 1;
      }
    }
    setSaving(false);
    setNotice(
      `${saved} movimiento${saved === 1 ? '' : 's'} guardado${saved === 1 ? '' : 's'}${
        failed ? `; ${failed} no se pudo guardar` : ''
      }.`,
    );
    if (!failed) setCandidates((current) => current.filter((item) => !item.selected));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 pb-8 pt-12 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="gmail-import-title"
        className="w-full max-w-2xl rounded-2xl bg-[color:var(--surface-1)] p-5 shadow-[var(--shadow)]"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 id="gmail-import-title" className="text-lg font-semibold">
            Leer avisos de BancoEstado
          </h3>
          <button
            type="button"
            className="text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
            onClick={onClose}
            disabled={loading || saving}
          >
            Cerrar
          </button>
        </div>

        <p className="mb-3 text-sm text-[color:var(--text-muted)]">
          Gmail solicita permiso de lectura del buzón, pero esta función consulta
          únicamente los dos remitentes de BancoEstado indicados. El texto se
          analiza en tu navegador y no se envía a una IA. La app no envía ni
          elimina correos.
        </p>
        {!GOOGLE_CLIENT_ID && (
          <p className="mb-3 rounded-lg border border-[color:var(--warning)]/30 bg-[color:var(--warning)]/15 px-3 py-2 text-sm text-[color:var(--warning)]">
            Falta configurar VITE_GOOGLE_OAUTH_CLIENT_ID. Consulta la sección de
            Gmail en el README para habilitar la conexión.
          </p>
        )}
        <button
          type="button"
          className="rounded-lg bg-[color:var(--success)] px-4 py-2 text-sm text-[color:var(--primary-contrast)] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          onClick={handleReadEmails}
          disabled={loading || saving || !GOOGLE_CLIENT_ID || !googleReady}
        >
          {loading
            ? 'Buscando avisos…'
            : googleReady
            ? 'Conectar y buscar avisos'
            : 'Preparando Google…'}
        </button>

        {scanInfo && (
          <p className="mt-3 text-xs text-[color:var(--text-muted)]">{scanInfo}</p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-[color:var(--danger)]">
            {error}
          </p>
        )}
        {notice && (
          <p className="mt-3 text-sm text-[color:var(--success)]">{notice}</p>
        )}

        {candidates.length > 0 && (
          <div className="mt-4 max-h-[55vh] space-y-3 overflow-y-auto pr-1">
            {candidates.map((candidate) => (
              <article
                key={candidate.id}
                className="space-y-3 rounded-xl border border-[color:var(--border)] p-3"
              >
                <label className="flex items-start gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={candidate.selected}
                    onChange={(event) =>
                      updateCandidate(candidate.id, {
                        selected: event.target.checked,
                      })
                    }
                  />
                  <span>{candidate.subject || candidate.description}</span>
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-xs text-[color:var(--text-muted)]">
                    Tipo
                    <select
                      className="rounded-lg border bg-[color:var(--surface-1)] px-2 py-2 text-sm text-[color:var(--text)]"
                      value={candidate.type}
                      onChange={(event) =>
                        updateCandidate(candidate.id, { type: event.target.value })
                      }
                    >
                      <option value="gasto">Gasto</option>
                      <option value="ingreso">Ingreso</option>
                      {members.length > 1 && (
                        <option value="traspaso">
                          Traspaso entre miembros (no afecta saldo)
                        </option>
                      )}
                    </select>
                  </label>
                  <label className="grid gap-1 text-xs text-[color:var(--text-muted)]">
                    Monto (CLP)
                    <input
                      type="number"
                      min="1"
                      step="1"
                      className="rounded-lg border bg-[color:var(--surface-1)] px-2 py-2 text-sm text-[color:var(--text)]"
                      value={candidate.amount}
                      onChange={(event) =>
                        updateCandidate(candidate.id, { amount: event.target.value })
                      }
                    />
                  </label>
                  <label className="grid gap-1 text-xs text-[color:var(--text-muted)]">
                    Fecha
                    <input
                      type="date"
                      className="rounded-lg border bg-[color:var(--surface-1)] px-2 py-2 text-sm text-[color:var(--text)]"
                      value={candidate.date}
                      onChange={(event) =>
                        updateCandidate(candidate.id, { date: event.target.value })
                      }
                    />
                  </label>
                  {candidate.type === 'traspaso' && members.length > 1 && (
                    <>
                      <label className="grid gap-1 text-xs text-[color:var(--text-muted)]">
                        De
                        <select
                          className="rounded-lg border bg-[color:var(--surface-1)] px-2 py-2 text-sm text-[color:var(--text)]"
                          value={candidate.fromUserId || ''}
                          onChange={(event) =>
                            updateCandidate(candidate.id, {
                              fromUserId: event.target.value,
                            })
                          }
                        >
                          <option value="">Seleccionar miembro</option>
                          {members.map((member) => (
                            <option key={member.id} value={member.id}>
                              {member.name || member.email || 'Miembro'}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="grid gap-1 text-xs text-[color:var(--text-muted)]">
                        Para
                        <select
                          className="rounded-lg border bg-[color:var(--surface-1)] px-2 py-2 text-sm text-[color:var(--text)]"
                          value={candidate.toUserId || ''}
                          onChange={(event) =>
                            updateCandidate(candidate.id, {
                              toUserId: event.target.value,
                            })
                          }
                        >
                          <option value="">Seleccionar miembro</option>
                          {members.map((member) => (
                            <option key={member.id} value={member.id}>
                              {member.name || member.email || 'Miembro'}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                  {candidate.type === 'gasto' && (
                    <label className="grid gap-1 text-xs text-[color:var(--text-muted)]">
                      Categoría
                      <select
                        className="rounded-lg border bg-[color:var(--surface-1)] px-2 py-2 text-sm text-[color:var(--text)]"
                        value={candidate.category}
                        onChange={(event) =>
                          updateCandidate(candidate.id, {
                            category: event.target.value,
                          })
                        }
                      >
                        <option value="">Seleccionar categoría</option>
                        {expenseCategories.map((category) => (
                          <option key={category} value={category}>
                            {category}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="grid gap-1 text-xs text-[color:var(--text-muted)] sm:col-span-2">
                    Descripción
                    <input
                      type="text"
                      maxLength="500"
                      className="rounded-lg border bg-[color:var(--surface-1)] px-2 py-2 text-sm text-[color:var(--text)]"
                      value={candidate.description}
                      onChange={(event) =>
                        updateCandidate(candidate.id, {
                          description: event.target.value,
                        })
                      }
                    />
                  </label>
                </div>
              </article>
            ))}
          </div>
        )}

        {candidates.some((candidate) => candidate.selected) && (
          <button
            type="button"
            className="mt-4 w-full rounded-lg bg-[color:var(--success)] px-4 py-2 text-sm text-[color:var(--primary-contrast)] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={handleImport}
            disabled={saving}
          >
            {saving ? 'Guardando movimientos…' : 'Confirmar movimientos seleccionados'}
          </button>
        )}
      </section>
    </div>
  );
}
