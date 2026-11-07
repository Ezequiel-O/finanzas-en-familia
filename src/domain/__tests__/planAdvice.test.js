import { describe, expect, it } from 'vitest';
import { planFacts, validatePlanAdvice } from '../planAdvice.js';

const summary = {
  today: '2026-11-07',
  level: 'red',
  safeToday: 0,
  shortfall: 49754,
  shortDate: '2026-11-23',
  tightest: { start: '2026-11-07', end: '2026-11-24' },
  postpone: null,
  margin: -84520,
  nextIncomeDate: '2026-11-24',
  payBeforeIncome: [],
  monthLevel: 'red',
  cuts: [
    { category: 'Vestuario', cut: 52020 },
    { category: 'Entretenimiento', cut: 32500 },
  ],
  monthIncome: 1605149,
  upcoming: 100000,
  budgetTotal: 1573035,
};

const advice = {
  hoyTitulo: 'Solo gastos esenciales',
  hoyMensaje: 'Te faltan $49.754 para llegar al 23 de noviembre.',
  finDeMesMensaje: 'Tu presupuesto supera tus ingresos en $84.520: recorta Vestuario ($52.020) y Entretenimiento ($32.500).',
  consejos: ['Posterga compras de ropa hasta el 24 de noviembre.'],
};

describe('validatePlanAdvice', () => {
  it('accepts advice that only cites amounts computed by the rules', () => {
    expect(validatePlanAdvice(advice, planFacts(summary))).toMatchObject({
      hoyTitulo: 'Solo gastos esenciales',
      consejos: ['Posterga compras de ropa hasta el 24 de noviembre.'],
    });
  });

  it('rejects advice with an invented or rounded amount', () => {
    const facts = planFacts(summary);
    expect(validatePlanAdvice({ ...advice, hoyMensaje: 'Te faltan $50.000.' }, facts)).toBeNull();
    expect(validatePlanAdvice({ ...advice, consejos: ['Ahorra 10.000 pesos'] }, facts)).toBeNull();
  });

  it('rejects incomplete advice', () => {
    expect(validatePlanAdvice({ ...advice, hoyMensaje: '' }, planFacts(summary))).toBeNull();
    expect(validatePlanAdvice(null, planFacts(summary))).toBeNull();
  });
});
