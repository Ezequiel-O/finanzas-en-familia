// src/components/feedback/feedback.js
// Avisos (toasts) y confirmaciones que reemplazan alert()/confirm() del navegador.
// Es un store simple fuera de React para poder usarlo también desde hooks y utilidades.
import { useSyncExternalStore } from 'react';

let state = { toasts: [], confirm: null };
const listeners = new Set();
let nextId = 1;

function setState(patch) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useFeedbackState() {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function dismissToast(id) {
  setState({ toasts: state.toasts.filter((t) => t.id !== id) });
}

// action: { label, onClick } — por ejemplo "Deshacer".
function show({ message, tone = 'info', action = null, duration }) {
  const id = nextId++;
  const ms = duration ?? (action ? 6000 : tone === 'error' ? 6000 : 3500);
  setState({ toasts: [...state.toasts.slice(-3), { id, message, tone, action }] });
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
  return id;
}

export const toast = {
  show,
  info: (message, opts) => show({ ...opts, message, tone: 'info' }),
  success: (message, opts) => show({ ...opts, message, tone: 'success' }),
  warning: (message, opts) => show({ ...opts, message, tone: 'warning' }),
  error: (message, opts) => show({ ...opts, message, tone: 'error' }),
};

const DANGER_VERBS = ['eliminar', 'rechazar', 'salir', 'quitar'];

// Si el mensaje empieza con un verbo ("Eliminar deuda...?"), el botón usa ese verbo.
function inferLabel(message) {
  const match = String(message || '').match(/^\s*¿?\s*([A-Za-zÁÉÍÓÚáéíóúñ]+r)\b/);
  if (!match) return null;
  const verb = match[1].toLowerCase();
  return { label: verb.charAt(0).toUpperCase() + verb.slice(1), danger: DANGER_VERBS.includes(verb) };
}

// Pide un monto. Resuelve el número ingresado (> 0) o null si se cancela.
export function promptAmount(message, options = {}) {
  return new Promise((resolve) => {
    if (state.confirm) state.confirm.resolve(false);
    setState({
      confirm: {
        message,
        title: options.title || 'Monto',
        confirmLabel: options.confirmLabel || 'Confirmar',
        cancelLabel: options.cancelLabel || 'Volver',
        danger: !!options.danger,
        amount: { initial: options.initial || '', max: options.max || null },
        resolve: (value) => {
          setState({ confirm: null });
          resolve(typeof value === 'number' && value > 0 ? value : null);
        },
      },
    });
  });
}

// Devuelve una promesa que resuelve true (confirmar) o false (cancelar).
export function confirmDialog(message, options = {}) {
  const inferred = inferLabel(message);
  return new Promise((resolve) => {
    if (state.confirm) state.confirm.resolve(false);
    setState({
      confirm: {
        message,
        title: options.title || '¿Confirmas?',
        confirmLabel: options.confirmLabel || inferred?.label || 'Confirmar',
        cancelLabel: options.cancelLabel || 'Volver',
        danger: options.danger ?? !!inferred?.danger,
        resolve: (value) => {
          setState({ confirm: null });
          resolve(value);
        },
      },
    });
  });
}
