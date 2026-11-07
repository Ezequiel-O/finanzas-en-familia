import { useEffect, useState } from 'react';
import {
  bankInboxEndpoint,
  createBankInboxToken,
  hasBankInboxToken,
  revokeBankInboxToken,
} from '../../lib/bankInbox.js';
import { confirmDialog } from '../../components/feedback/feedback.js';

const SCRIPT_PATH = 'scripts/apps-script/avisos-bancoestado.gs';

function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <label className="grid gap-1 text-xs text-[color:var(--text-muted)]">
      {label}
      <div className="flex gap-2">
        <input
          type="text"
          readOnly
          value={value}
          className="min-w-0 flex-1 rounded-lg border bg-[color:var(--surface-2)] px-2 py-2 font-mono text-xs text-[color:var(--text)]"
          onFocus={(event) => event.target.select()}
        />
        <button
          type="button"
          className="rounded-lg border px-3 py-2 text-xs hover:bg-[color:var(--surface-2)]"
          onClick={handleCopy}
        >
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>
    </label>
  );
}

export function BankInboxSetup({ householdId }) {
  const [connected, setConnected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const endpoint = bankInboxEndpoint();

  useEffect(() => {
    let active = true;
    hasBankInboxToken(householdId)
      .then((exists) => {
        if (active) setConnected(exists);
      })
      .catch(() => {
        if (active) setConnected(false);
      });
    return () => {
      active = false;
    };
  }, [householdId]);

  async function handleCreate() {
    if (connected) {
      const ok = await confirmDialog(
        'La clave anterior dejará de funcionar. Tendrás que pegar la nueva en tu Apps Script.',
        { title: 'Generar una clave nueva', confirmLabel: 'Generar' },
      );
      if (!ok) return;
    }
    setBusy(true);
    setError('');
    try {
      setToken(await createBankInboxToken(householdId));
      setConnected(true);
    } catch (createError) {
      console.error('No se pudo generar la clave de avisos:', {
        code: createError?.code || 'unknown',
      });
      setError('No se pudo generar la clave. Intenta otra vez.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke() {
    const ok = await confirmDialog(
      'Tu Apps Script dejará de poder enviar avisos a este hogar.',
      { title: 'Desconectar recepción automática', confirmLabel: 'Desconectar', danger: true },
    );
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      await revokeBankInboxToken(householdId);
      setToken('');
      setConnected(false);
    } catch (revokeError) {
      console.error('No se pudo revocar la clave de avisos:', {
        code: revokeError?.code || 'unknown',
      });
      setError('No se pudo desconectar. Intenta otra vez.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="mt-4 rounded-xl border border-[color:var(--border)] p-3 text-sm">
      <summary className="cursor-pointer font-medium">
        Recepción automática{' '}
        <span className="text-xs font-normal text-[color:var(--text-muted)]">
          {connected === null ? '' : connected ? '· conectada' : '· sin conectar'}
        </span>
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-[color:var(--text-muted)]">
          Un Apps Script en tu cuenta de Google revisa cada 10 minutos los avisos
          de BancoEstado y los envía a esta bandeja, sin datos de cuenta ni RUT.
          Copia <code>{SCRIPT_PATH}</code> en script.google.com y guarda estos
          dos valores en sus propiedades como <code>FF_ENDPOINT</code> y{' '}
          <code>FF_TOKEN</code>.
        </p>
        {endpoint && <CopyField label="FF_ENDPOINT" value={endpoint} />}
        {token && (
          <>
            <CopyField label="FF_TOKEN" value={token} />
            <p className="text-xs text-[color:var(--warning)]">
              Esta clave se muestra una sola vez. No la compartas: permite
              enviar avisos a tu hogar.
            </p>
          </>
        )}
        {error && (
          <p role="alert" className="text-xs text-[color:var(--danger)]">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-lg border px-3 py-2 text-xs hover:bg-[color:var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-60"
            onClick={handleCreate}
            disabled={busy || connected === null}
          >
            {connected ? 'Generar clave nueva' : 'Generar clave de conexión'}
          </button>
          {connected && (
            <button
              type="button"
              className="rounded-lg border px-3 py-2 text-xs text-[color:var(--danger)] hover:bg-[color:var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-60"
              onClick={handleRevoke}
              disabled={busy}
            >
              Desconectar
            </button>
          )}
        </div>
      </div>
    </details>
  );
}
