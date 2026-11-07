// src/domain/planAdvice.js
// Datos del Plan que Gemini redacta como avisos. Las reglas (safeSpendPlan) deciden el
// nivel, los montos y las fechas; Gemini solo los explica. Por eso un aviso de Gemini
// se acepta solo si cada monto que menciona sale de estos datos.

const paymentName = (item) => item?.subName || (item?.kind === 'fixed' ? item?.category : item?.name) || '';
const MAX_PAYMENTS = 8;
const MAX_TEXT = 400;
const MAX_TIPS = 3;

export function planFacts(summary) {
  const s = summary || {};
  return {
    hoy: s.today,
    alertaHoy: s.level, // green | yellow | red
    puedeGastarHoy: s.safeToday,
    faltante: s.shortfall,
    fechaFaltante: s.shortDate,
    tramoMasJusto: s.tightest ? { desde: s.tightest.start, hasta: s.tightest.end } : null,
    posterga: s.postpone ? { pago: paymentName(s.postpone), monto: s.postpone.pending } : null,
    margenFueraDePresupuesto: Math.max(0, s.margin || 0),
    proximoIngreso: s.nextIncomeDate || null,
    pagosAntesDelIngreso: (s.payBeforeIncome || []).slice(0, MAX_PAYMENTS).map((item) => ({
      pago: paymentName(item),
      vence: item.dueDate || null,
      monto: item.pending,
    })),
    alertaFinDeMes: s.monthLevel, // green | yellow | red
    resultadoFinDeMes: s.margin,
    recortes: (s.cuts || []).map((c) => ({ categoria: c.category, monto: c.cut })),
    ingresosDelMes: s.monthIncome,
    porRecibir: s.upcoming,
    presupuestoTotal: s.budgetTotal,
  };
}

// Montos que Gemini puede citar: los de los datos y sus valores absolutos.
function allowedAmounts(facts) {
  const amounts = new Set();
  const walk = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) amounts.add(Math.abs(Math.round(value)));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(facts);
  return amounts;
}

// Montos en pesos escritos en un texto: "$49.754", "$ 1.605.149", "49.754 pesos".
function mentionedAmounts(text) {
  const matches = String(text || '').matchAll(
    /\$\s?(\d{1,3}(?:\.\d{3})+|\d+)|\b(\d{1,3}(?:\.\d{3})+)\b/g,
  );
  return Array.from(matches, ([, withSign, withDots]) => Number(String(withSign || withDots).replace(/\./g, '')));
}

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

// Devuelve el aviso limpio, o null si falta algo o menciona un monto que no viene de
// las reglas (Gemini no puede inventar cifras).
export function validatePlanAdvice(advice, facts) {
  if (!advice || typeof advice !== 'object') return null;
  const result = {
    hoyTitulo: clean(advice.hoyTitulo),
    hoyMensaje: clean(advice.hoyMensaje),
    finDeMesMensaje: clean(advice.finDeMesMensaje),
    consejos: (Array.isArray(advice.consejos) ? advice.consejos : [])
      .map(clean)
      .filter(Boolean)
      .slice(0, MAX_TIPS),
  };
  if (!result.hoyTitulo || !result.hoyMensaje || !result.finDeMesMensaje) return null;
  const allowed = allowedAmounts(facts);
  const texts = [result.hoyTitulo, result.hoyMensaje, result.finDeMesMensaje, ...result.consejos];
  const invented = texts.flatMap(mentionedAmounts).some((amount) => !allowed.has(amount));
  return invented ? null : result;
}
