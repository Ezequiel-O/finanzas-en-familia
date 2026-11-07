// Asistente financiero: botón flotante y panel de conversación.
// En el teléfono el panel es una hoja inferior; en escritorio, una tarjeta en la esquina.
import { useEffect, useRef, useState } from 'react';
import { parseBlocks, parseInline } from './richText.js';

const SUGGESTIONS = [
  '¿Cuánto me queda para gastar este mes?',
  '¿En qué categoría gasté más?',
  '¿Voy bien con mi presupuesto?',
];

function Inline({ text }) {
  return parseInline(text).map((segment, index) => {
    if (segment.bold) {
      return (
        <strong key={index} className="font-semibold">
          {segment.text}
        </strong>
      );
    }
    if (segment.italic) return <em key={index}>{segment.text}</em>;
    if (segment.code) {
      return (
        <code key={index} className="rounded bg-[color:var(--surface-1)] px-1 text-[0.9em]">
          {segment.text}
        </code>
      );
    }
    return <span key={index}>{segment.text}</span>;
  });
}

function RichText({ text }) {
  return (
    <div className="space-y-2">
      {parseBlocks(text).map((block, index) => {
        if (block.type === 'h') {
          return (
            <p key={index} className="font-semibold">
              <Inline text={block.text} />
            </p>
          );
        }
        if (block.type === 'ul' || block.type === 'ol') {
          const List = block.type;
          return (
            <List
              key={index}
              className={`space-y-1 pl-5 ${block.type === 'ul' ? 'list-disc' : 'list-decimal'} marker:text-[color:var(--text-muted)]`}
            >
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  <Inline text={item} />
                </li>
              ))}
            </List>
          );
        }
        return (
          <p key={index}>
            <Inline text={block.text} />
          </p>
        );
      })}
    </div>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function NewChatIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

export function AssistantPanel({
  open,
  hidden = false,
  onToggle,
  onNewChat,
  messages,
  sending,
  text,
  onTextChange,
  onSend,
  listening,
  onStartDictation,
  onStopDictation,
  interim,
  error,
  status,
  plan,
  onConfirmPlan,
  onCancelPlan,
  aiReady,
}) {
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const [fabVisible, setFabVisible] = useState(true);

  // En el teléfono el botón se esconde al bajar (para no tapar montos) y vuelve al subir.
  useEffect(() => {
    if (open) return undefined;
    let lastY = window.scrollY;
    const onScroll = (event) => {
      if (window.matchMedia?.('(min-width: 768px)').matches) return;
      const target = event.target;
      const y = target === document ? window.scrollY : target.scrollTop;
      if (typeof y !== 'number') return;
      if (y < 80 || y < lastY - 8) setFabVisible(true);
      else if (y > lastY + 8) setFabVisible(false);
      lastY = y;
    };
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () =>
      document.removeEventListener('scroll', onScroll, { passive: true, capture: true });
  }, [open]);

  // Mantiene visible el último mensaje.
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length, sending, plan, open]);

  // El cuadro de texto crece con el contenido hasta ~5 líneas.
  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 128)}px`;
    element.style.overflowY = element.scrollHeight > 128 ? 'auto' : 'hidden';
  }, [text, open]);

  useEffect(() => {
    if (!open) return undefined;
    // En el teléfono no se enfoca solo: el teclado taparía la conversación.
    if (window.matchMedia?.('(min-width: 768px)').matches) inputRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onToggle();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onToggle]);

  if (!open) {
    if (hidden) return null;
    return (
      <button
        type="button"
        className={`ai-fab fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom))] right-3 z-[45] flex h-11 w-11 items-center justify-center overflow-hidden rounded-full transition duration-200 hover:brightness-105 active:scale-95 md:bottom-6 md:right-6 md:h-14 md:w-14 md:translate-y-0 md:opacity-100 ${
          fabVisible ? '' : 'pointer-events-none translate-y-24 opacity-0 md:pointer-events-auto'
        }`}
        onClick={onToggle}
        tabIndex={fabVisible ? 0 : -1}
        aria-label="Abrir asistente financiero con IA"
        title="Asistente financiero con IA"
      >
        <img src="/logo-finanzas-en-familia.png" alt="" className="h-full w-full object-cover" />
      </button>
    );
  }

  const canSend = !!text.trim() && !sending;

  return (
    <>
      <div
        className="fixed inset-0 z-[9989] bg-black/15 md:hidden"
        onClick={onToggle}
        aria-hidden="true"
      />
      <section
        role="dialog"
        aria-labelledby="ai-panel-title"
        className="ai-panel ai-glass fixed inset-x-0 bottom-0 z-[9990] flex max-h-[85dvh] flex-col rounded-t-3xl border border-[color:var(--border)] pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow)] md:inset-x-auto md:bottom-6 md:right-6 md:max-h-[min(640px,calc(100vh-3rem))] md:w-[400px] md:rounded-2xl md:pb-0"
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-[color:var(--border)] md:hidden" aria-hidden="true" />
        <header className="flex shrink-0 items-center gap-3 border-b border-[color:var(--border)] px-4 py-3">
          <img src="/logo-finanzas-en-familia.png" alt="" className="h-8 w-8 rounded-full object-cover" />
          <div className="min-w-0 flex-1">
            <h2 id="ai-panel-title" className="text-sm font-semibold leading-tight">
              Asistente financiero
            </h2>
            <p className="text-[11px] text-[color:var(--text-muted)]">Con Gemini · revisa antes de actuar</p>
          </div>
          {(messages.length > 0 || plan || error) && (
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-full text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)] hover:text-[color:var(--text)] disabled:opacity-50"
              onClick={() => {
                onNewChat();
                if (window.matchMedia?.('(min-width: 768px)').matches) inputRef.current?.focus();
              }}
              disabled={sending}
              aria-label="Nueva conversación"
              title="Nueva conversación"
            >
              <NewChatIcon />
            </button>
          )}
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-full text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)] hover:text-[color:var(--text)]"
            onClick={onToggle}
            aria-label="Cerrar asistente"
          >
            <CloseIcon />
          </button>
        </header>

        <div
          ref={scrollRef}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4"
          aria-live="polite"
          aria-label="Conversación con el asistente"
        >
          {!aiReady && (
            <p className="rounded-xl bg-[color:var(--warning)]/15 px-3 py-2 text-xs text-[color:var(--warning)]">
              Para habilitar Gemini, configura App Check con reCAPTCHA Enterprise y
              VITE_FIREBASE_APP_CHECK_SITE_KEY.
            </p>
          )}

          {messages.length === 0 && (
            <div className="space-y-3 py-2">
              <p className="text-sm text-[color:var(--text)]">
                Hola, pregúntame por tus finanzas o pídeme registrar un movimiento.
              </p>
              <div className="flex flex-col items-start gap-2">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="rounded-full border border-[color:var(--border)] px-3 py-1.5 text-left text-xs text-[color:var(--text)] hover:bg-[color:var(--surface-2)] disabled:opacity-60"
                    onClick={() => onSend(suggestion)}
                    disabled={sending || !aiReady}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message, index) =>
            message.role === 'user' ? (
              <div
                key={`user-${index}`}
                className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-[color:var(--primary)] px-3.5 py-2 text-sm text-[color:var(--primary-contrast)]"
              >
                {message.text}
              </div>
            ) : (
              <div
                key={`model-${index}`}
                className="ai-bubble max-w-[92%] break-words rounded-2xl rounded-bl-md px-3.5 py-2.5 text-sm leading-relaxed text-[color:var(--text)]"
              >
                <RichText text={message.text} />
              </div>
            ),
          )}

          {sending && (
            <div className="ai-typing ai-bubble flex w-fit gap-1 rounded-2xl rounded-bl-md px-3.5 py-3" aria-label="El asistente está pensando">
              <span />
              <span />
              <span />
            </div>
          )}

          {plan && (
            <div className="space-y-2 rounded-2xl border border-[color:var(--border)] p-3 text-sm">
              <div className="font-semibold">Confirmar acción</div>
              <div className="text-[color:var(--text-muted)]">{plan.summary}</div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="flex-1 rounded-xl bg-[color:var(--primary)] px-3 py-2 text-sm text-[color:var(--primary-contrast)]"
                  onClick={onConfirmPlan}
                >
                  Confirmar
                </button>
                <button
                  type="button"
                  className="flex-1 rounded-xl border px-3 py-2 text-sm text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)]"
                  onClick={onCancelPlan}
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </div>

        <footer className="shrink-0 space-y-2 border-t border-[color:var(--border)] px-3 pb-3 pt-2">
          {error && (
            <p role="alert" className="px-1 text-xs text-[color:var(--danger)]">
              {error}
            </p>
          )}
          {status && !error && (
            <p className="px-1 text-xs text-[color:var(--text-muted)]">{status}</p>
          )}
          {listening && (
            <p className="flex items-center gap-2 px-1 text-xs text-[color:var(--text-muted)]">
              <span className="ai-listening-dot" />
              {interim || 'Escuchando…'}
            </p>
          )}
          <div className="ai-bubble flex items-end gap-1 rounded-2xl border border-[color:var(--border)] p-1.5 focus-within:border-[color:var(--primary)]">
            <textarea
              ref={inputRef}
              className="max-h-32 min-h-[2.25rem] flex-1 resize-none border-0 bg-transparent px-2 py-2 focus-visible:outline-none text-base leading-snug outline-none placeholder:text-[color:var(--text-muted)] md:text-sm"
              rows={1}
              placeholder="Escribe tu pregunta…"
              aria-label="Mensaje para el asistente"
              value={text}
              onChange={(event) => onTextChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (canSend) onSend();
                }
              }}
            />
            <button
              type="button"
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition ${
                listening
                  ? 'bg-[color:var(--danger)]/15 text-[color:var(--danger)]'
                  : 'text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)] hover:text-[color:var(--text)]'
              }`}
              onClick={listening ? onStopDictation : onStartDictation}
              aria-label={listening ? 'Detener dictado' : 'Dictar'}
              aria-pressed={listening}
            >
              <MicIcon />
            </button>
            <button
              type="button"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--primary)] text-[color:var(--primary-contrast)] transition disabled:bg-[color:var(--surface-2)] disabled:text-[color:var(--text-muted)]"
              onClick={() => onSend()}
              disabled={!canSend}
              aria-label="Enviar"
            >
              <SendIcon />
            </button>
          </div>
          <p className="px-1 text-center text-[10px] leading-snug text-[color:var(--text-muted)]">
            Se envía tu consulta y un resumen agregado, sin nombres ni descripciones.
          </p>
        </footer>
      </section>
    </>
  );
}
