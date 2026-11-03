import { useEffect, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { extractBankTransaction } from '../../ai/bankTransactionExtractor.js';
import { appCheckConfigured, db } from '../../firebase';
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
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [googleReady, setGoogleReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [emails, setEmails] = useState([]);
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
    setEmails([]);
    setCandidates([]);
    setScanInfo('');
    try {
      const { messages, truncated } = await readBancoEstadoEmails(GOOGLE_CLIENT_ID);
      const importedIds = await findImportedMessageIds(
        householdId,
        messages.map((message) => message.id),
      );
      const pending = messages
        .filter((message) => !importedIds.has(message.id))
        .map((message) => ({ ...message, selected: false }));
      const duplicates = messages.length - pending.length;
      setEmails(pending);
      setScanInfo(
        `${messages.length} avisos revisados; ${pending.length} disponibles para seleccionar; ${duplicates} ya importados.${
          truncated ? ' Se revisaron los 100 avisos más recientes.' : ''
        }`,
      );
      if (!messages.length) {
        setNotice('No se encontraron avisos de movimiento de los remitentes configurados.');
      } else if (!pending.length) {
        setNotice('Todos los avisos encontrados ya se habían importado.');
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

  async function handleExtractSelected() {
    const selected = emails.filter((email) => email.selected);
    if (!selected.length) {
      setError('Selecciona al menos un aviso para extraer con Gemini.');
      return;
    }
    if (!appCheckConfigured) {
      setError(
        'Registra esta app web en Firebase App Check y configura VITE_FIREBASE_APP_CHECK_SITE_KEY antes de usar Gemini.',
      );
      return;
    }

    setExtracting(true);
    setError('');
    setNotice('');
    setCandidates([]);
    const extracted = [];
    const finishedIds = new Set();
    let ignored = 0;
    let failed = 0;
    for (let index = 0; index < selected.length; index += 1) {
      const email = selected[index];
      setScanInfo(`Gemini está analizando el aviso ${index + 1} de ${selected.length}…`);
      try {
        const movement = await extractBankTransaction(email, expenseCategories);
        finishedIds.add(email.id);
        if (movement) {
          extracted.push({
            id: email.id,
            subject: email.subject,
            ...movement,
            selected: true,
            category: movement.suggestedCategory,
          });
        } else {
          ignored += 1;
        }
      } catch (extractError) {
        failed += 1;
        console.error('No se pudo analizar un aviso bancario con Gemini:', {
          id: email.id,
          code: extractError?.code || 'unknown',
        });
      }
    }
    setCandidates(extracted);
    setEmails((current) => current.filter((email) => !finishedIds.has(email.id)));
    setScanInfo(
      `${selected.length} avisos procesados: ${extracted.length} movimientos propuestos, ${ignored} sin movimiento importable${
        failed ? ` y ${failed} con error` : ''
      }.`,
    );
    if (failed) {
      setError(
        'Algunos avisos no pudieron procesarse. Puedes volver a seleccionarlos e intentar otra vez.',
      );
    }
    setExtracting(false);
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
            disabled={loading || extracting || saving}
          >
            Cerrar
          </button>
        </div>

        <p className="mb-3 text-sm text-[color:var(--text-muted)]">
          Gmail solicita permiso de lectura del buzón. Al seleccionar un aviso y
          pulsar “Extraer con Gemini”, se enviarán su asunto y cuerpo a Firebase
          AI Logic para procesarlo. Antes de enviarlo, la app oculta RUT, correos
          y números de cuenta detectables. Revisa cada resultado; nunca se guarda
          automáticamente.
        </p>
        {!GOOGLE_CLIENT_ID && (
          <p className="mb-3 rounded-lg border border-[color:var(--warning)]/30 bg-[color:var(--warning)]/15 px-3 py-2 text-sm text-[color:var(--warning)]">
            Falta configurar VITE_GOOGLE_OAUTH_CLIENT_ID. Consulta la sección de
            Gmail en el README para habilitar la conexión.
          </p>
        )}
        {!appCheckConfigured && (
          <p className="mb-3 rounded-lg border border-[color:var(--warning)]/30 bg-[color:var(--warning)]/15 px-3 py-2 text-sm text-[color:var(--warning)]">
            Registra la app web en Firebase App Check con reCAPTCHA Enterprise
            y configura su clave de sitio para habilitar Gemini.
          </p>
        )}
        <button
          type="button"
          className="rounded-lg bg-[color:var(--success)] px-4 py-2 text-sm text-[color:var(--primary-contrast)] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          onClick={handleReadEmails}
          disabled={loading || extracting || saving || !GOOGLE_CLIENT_ID || !googleReady}
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

        {emails.length > 0 && (
          <div className="mt-4 max-h-56 space-y-2 overflow-y-auto rounded-xl border border-[color:var(--border)] p-3">
            <p className="text-xs text-[color:var(--text-muted)]">
              Selecciona solo los avisos que deseas enviar a Gemini.
            </p>
            {emails.map((email) => (
              <label
                key={email.id}
                className="flex items-start gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={email.selected}
                  disabled={extracting}
                  onChange={(event) =>
                    setEmails((current) =>
                      current.map((item) =>
                        item.id === email.id
                          ? { ...item, selected: event.target.checked }
                          : item,
                      ),
                    )
                  }
                />
                <span>{email.subject || '(Aviso sin asunto)'}</span>
              </label>
            ))}
            <button
              type="button"
              className="w-full rounded-lg border px-3 py-2 text-sm hover:bg-[color:var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-60"
              onClick={handleExtractSelected}
              disabled={
                extracting ||
                loading ||
                saving ||
                !appCheckConfigured ||
                !emails.some((email) => email.selected)
              }
            >
              {extracting ? 'Extrayendo movimientos…' : 'Extraer avisos seleccionados con Gemini'}
            </button>
          </div>
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
