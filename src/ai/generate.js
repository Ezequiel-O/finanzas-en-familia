import { getApp } from 'firebase/app';
import { getAI, getGenerativeModel, GoogleAIBackend } from 'firebase/ai';

export const GEMINI_MODEL = 'gemini-3.7-flash';
// Modelo alternativo opcional cuando el principal sigue saturado tras los reintentos.
const FALLBACK_MODEL = String(import.meta.env.VITE_GEMINI_FALLBACK_MODEL || '').trim();
const REQUEST_TIMEOUT_MS = 30000;
const RETRY_DELAYS_MS = [1000, 3000];
// Si Google pide esperar más que esto, no se reintenta en el momento.
const MAX_RETRY_WAIT_MS = 5000;
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

export const AI_BUSY_MESSAGE =
  'Gemini está con mucha demanda en este momento. Intenta de nuevo en un minuto.';
export const AI_LIMIT_MESSAGE =
  'Se alcanzó el límite de consultas a Gemini del proyecto. Espera unos minutos y vuelve a intentar.';
export const AI_FAILED_MESSAGE = 'No se pudo consultar Gemini. Intenta de nuevo.';
export const AI_BLOCKED_MESSAGE =
  'Firebase rechazó la verificación de la app (App Check). Revisa que este dominio esté autorizado en la clave de reCAPTCHA.';

// App Check o permisos: reintentar no sirve y el usuario necesita saber qué revisar.
function isAccessError(error) {
  const status = Number(error?.customErrorData?.status);
  return (
    status === 401 ||
    status === 403 ||
    /app[- ]?check|permission[_ ]denied|unauthenticated|forbidden/i.test(
      `${error?.code || ''} ${error?.message || ''}`,
    )
  );
}

function logAIError(label, error) {
  console.error(label, {
    code: error?.code || 'unknown',
    status: error?.customErrorData?.status,
    // El detalle completo solo en desarrollo: puede incluir URLs internas del proyecto.
    ...(import.meta.env.DEV ? { detail: String(error?.message || '') } : {}),
  });
}

// Saturación o caída temporal de Gemini: vale la pena reintentar.
export function isTransientAIError(error) {
  const status = Number(error?.customErrorData?.status);
  if (TRANSIENT_STATUS.has(status)) return true;
  return /\[(?:429|50[0234])\b|high demand|overloaded|unavailable|try again later/i.test(
    String(error?.message || ''),
  );
}

// 429: cuota del proyecto agotada (por minuto o por día), no saturación de Google.
export function isRateLimitError(error) {
  return (
    Number(error?.customErrorData?.status) === 429 ||
    /\[429\b|resource[_ ]exhausted|quota/i.test(String(error?.message || ''))
  );
}

// Espera sugerida por Google en el detalle RetryInfo del error (por ejemplo "37s").
export function retryDelayMs(error) {
  const details = error?.customErrorData?.errorDetails;
  const info = Array.isArray(details)
    ? details.find((detail) => String(detail?.['@type'] || '').includes('RetryInfo'))
    : null;
  const seconds = Number.parseFloat(String(info?.retryDelay || ''));
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

function aiError(message, cause) {
  const error = new Error(message);
  error.code = isTransientAIError(cause) ? 'ai-unavailable' : 'ai-failed';
  return error;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms + Math.floor(Math.random() * 500)));
}

// Llama a Gemini con reintentos ante saturación. Los errores que llegan a la UI
// son mensajes en español, sin URLs ni detalles internos de Firebase.
export async function generateWithRetry(modelParams, request) {
  const ai = getAI(getApp(), { backend: new GoogleAIBackend() });
  const models = [modelParams.model || GEMINI_MODEL, FALLBACK_MODEL].filter(
    (name, index, all) => name && all.indexOf(name) === index,
  );
  let lastError;
  for (const name of models) {
    const model = getGenerativeModel(
      ai,
      { ...modelParams, model: name },
      { timeout: REQUEST_TIMEOUT_MS },
    );
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await model.generateContent(request);
      } catch (error) {
        lastError = error;
        if (!isTransientAIError(error)) {
          logAIError('Gemini rechazó la consulta:', error);
          throw aiError(isAccessError(error) ? AI_BLOCKED_MESSAGE : AI_FAILED_MESSAGE, error);
        }
        if (attempt >= RETRY_DELAYS_MS.length) break;
        // Con cuota agotada, reintentar al tiro solo gasta más cuota.
        const suggested = retryDelayMs(error);
        if (isRateLimitError(error) && (suggested === null || suggested > MAX_RETRY_WAIT_MS)) {
          break;
        }
        await wait(Math.max(RETRY_DELAYS_MS[attempt], suggested || 0));
      }
    }
  }
  logAIError('Gemini no disponible tras reintentar:', lastError);
  throw aiError(isRateLimitError(lastError) ? AI_LIMIT_MESSAGE : AI_BUSY_MESSAGE, lastError);
}
