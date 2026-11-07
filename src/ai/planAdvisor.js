// Gemini redacta los avisos del Plan ("Hoy" y "Fin de mes") a partir de lo que ya
// calcularon las reglas. Si la respuesta no es válida, la pantalla usa sus textos fijos.
import { SchemaType, ThinkingLevel } from 'firebase/ai';
import { planFacts, validatePlanAdvice } from '../domain/planAdvice.js';
import { appCheckConfigured } from '../firebase.js';
import { GEMINI_MODEL, generateWithRetry } from './generate.js';

const CACHE_PREFIX = 'ff-plan-advice:';

const text = (description) => ({ type: SchemaType.STRING, description });
const modelParams = {
  model: GEMINI_MODEL,
  generationConfig: {
    maxOutputTokens: 1024,
    thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    responseMimeType: 'application/json',
    responseSchema: {
      type: SchemaType.OBJECT,
      properties: {
        hoyTitulo: text('Título corto del aviso de hoy (máximo 8 palabras).'),
        hoyMensaje: text('Una o dos frases que explican el aviso de hoy.'),
        finDeMesMensaje: text('Una o dos frases sobre cómo termina el mes.'),
        consejos: {
          type: SchemaType.ARRAY,
          items: text('Acción concreta y breve.'),
          description: 'Hasta 3 acciones concretas para esta semana.',
        },
      },
      required: ['hoyTitulo', 'hoyMensaje', 'finDeMesMensaje', 'consejos'],
    },
  },
  systemInstruction: {
    role: 'system',
    parts: [
      {
        text: [
          'Eres el asesor de una app de finanzas familiares chilena. Escribes en español de Chile, cercano y directo, sin tecnicismos.',
          'Recibes datos ya calculados por las reglas de la app. Las reglas mandan: no cambies el nivel de alerta, no recalcules ni redondees montos y no inventes cifras, fechas, pagos ni categorías.',
          'Si mencionas un monto, cópialo exacto de los datos con formato chileno y sin signo negativo, por ejemplo $49.754 (di "déficit" o "faltan" en vez de usar el signo). Fechas como "23 de noviembre".',
          'alertaHoy red: hoy no hay que gastar nada que no sea esencial; explica cuánto falta y cuándo, y si hay un pago para postergar, dilo. yellow: se puede gastar con cuidado hasta puedeGastarHoy. green: se puede gastar hasta puedeGastarHoy con tranquilidad.',
          'alertaFinDeMes red: el presupuesto supera los ingresos; nombra los recortes sugeridos con su monto. yellow: el mes termina justo. green: termina con superávit.',
          'Los consejos deben salir de los datos (pagos próximos, recortes, próximo ingreso). No des consejos genéricos de ahorro ni recomiendes productos financieros.',
        ].join(' '),
      },
    ],
  },
};

function cacheKey(facts) {
  return CACHE_PREFIX + JSON.stringify(facts);
}

function readCache(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Sin almacenamiento disponible: se vuelve a pedir la próxima vez.
  }
}

// Devuelve { hoyTitulo, hoyMensaje, finDeMesMensaje, consejos } o null.
export async function advisePlan(summary) {
  if (!appCheckConfigured || !summary?.tightest) return null;
  const facts = planFacts(summary);
  const key = cacheKey(facts);
  const cached = readCache(key);
  if (cached) return cached;

  const result = await generateWithRetry(modelParams, [
    'Redacta los avisos del Plan con estos datos (JSON):',
    JSON.stringify(facts),
  ].join('\n\n'));
  let parsed;
  try {
    parsed = JSON.parse(result.response.text());
  } catch {
    console.error('Gemini devolvió un aviso del Plan inválido:', {
      finishReason: result.response.candidates?.[0]?.finishReason || 'unknown',
    });
    return null;
  }
  const advice = validatePlanAdvice(parsed, facts);
  if (!advice) {
    console.warn('Aviso del Plan descartado: Gemini mencionó montos que no calculó la app.');
    return null;
  }
  writeCache(key, advice);
  return advice;
}
