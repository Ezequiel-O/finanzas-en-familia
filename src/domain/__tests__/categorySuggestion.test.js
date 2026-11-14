import { describe, expect, it } from 'vitest';
import {
  classificationExamples,
  findSubcategoryByName,
  merchantTokens,
  subcategoriesFor,
  suggestFromHistory,
  transactionSubcategoryNames,
} from '../categorySuggestion.js';
import { validateAiBankEmailMovement } from '../bankEmailParser.js';

const CATEGORIES = ['Supermercado', 'Transporte', 'Hogar'];

const tx = (overrides) => ({
  type: 'gasto',
  amount: 10000,
  date: '2026-10-10',
  ...overrides,
});

describe('merchantTokens', () => {
  it('keeps merchant words and drops generic ones', () => {
    expect(merchantTokens('Compra UNIMARC San Joaquín 123')).toEqual(['unimarc', 'san', 'joaquin']);
  });
});

describe('transactionSubcategoryNames', () => {
  it('reads new and legacy formats', () => {
    expect(transactionSubcategoryNames({ meta: { budgetSubcategoryNames: 'Feria; Super' } })).toEqual([
      'Feria',
      'Super',
    ]);
    expect(transactionSubcategoryNames({ meta: { budgetSubcategoryName: 'Bencina' } })).toEqual([
      'Bencina',
    ]);
    expect(transactionSubcategoryNames({})).toEqual([]);
  });
});

describe('subcategoriesFor / findSubcategoryByName', () => {
  const budgetsAll = {
    '2026-11': { Supermercado: { breakdown: [{ id: 's1', name: 'Súper', amount: 1 }, { name: 'Feria' }] } },
  };

  it('lists the breakdown of the period', () => {
    expect(subcategoriesFor(budgetsAll, '2026-11', 'Supermercado')).toEqual([
      { id: 's1', name: 'Súper' },
      { id: 'Feria', name: 'Feria' },
    ]);
    expect(subcategoriesFor(budgetsAll, '2026-10', 'Supermercado')).toEqual([]);
  });

  it('matches names ignoring case and accents', () => {
    const subs = subcategoriesFor(budgetsAll, '2026-11', 'Supermercado');
    expect(findSubcategoryByName(subs, 'super')?.id).toBe('s1');
    expect(findSubcategoryByName(subs, 'Otra')).toBeNull();
  });
});

describe('suggestFromHistory', () => {
  it('uses the most frequent classification of similar merchants', () => {
    const history = [
      tx({ description: 'Compra UNIMARC SAN JOAQUIN', category: 'Supermercado', meta: { budgetSubcategoryNames: 'Súper' } }),
      tx({ description: 'Unimarc', category: 'Supermercado', meta: { budgetSubcategoryNames: 'Súper' } }),
      tx({ description: 'Unimarc', category: 'Hogar' }),
      tx({ description: 'Pasaje Red', category: 'Transporte' }),
    ];
    expect(
      suggestFromHistory({ description: 'Compra UNIMARC SAN JOAQUIN' }, history, CATEGORIES),
    ).toEqual({ category: 'Supermercado', subcategory: 'Súper', matches: 2 });
  });

  it('returns null without history, and ignores income and unknown categories', () => {
    const history = [
      tx({ type: 'ingreso', description: 'Lider', category: 'Supermercado' }),
      tx({ description: 'Lider', category: 'Borrada' }),
    ];
    expect(suggestFromHistory({ description: 'Lider Express' }, history, CATEGORIES)).toBeNull();
  });
});

describe('classificationExamples', () => {
  it('returns one recent example per merchant and leaves transfers out', () => {
    const history = [
      tx({ date: '2026-10-01', description: 'Unimarc', category: 'Supermercado' }),
      tx({ date: '2026-10-05', description: 'UNIMARC', category: 'Hogar' }),
      tx({ date: '2026-10-06', description: 'Transferencia a Fulana', category: 'Hogar' }),
    ];
    expect(classificationExamples(history, CATEGORIES)).toEqual([
      { description: 'UNIMARC', category: 'Hogar', subcategory: '' },
    ]);
  });
});

describe('validateAiBankEmailMovement subcategory', () => {
  const email = { body: 'Compra por $5.000 el 29/10/2026' };
  const movement = {
    hasMovement: true,
    type: 'gasto',
    amount: 5000,
    date: '2026-10-29',
    description: 'Compra Unimarc',
    category: 'Supermercado',
  };

  it('accepts a subcategory only if it belongs to the suggested category', () => {
    const subs = { Supermercado: ['Súper'] };
    expect(
      validateAiBankEmailMovement(email, { ...movement, subcategory: 'Súper' }, CATEGORIES, subs)
        .suggestedSubcategory,
    ).toBe('Súper');
    expect(
      validateAiBankEmailMovement(email, { ...movement, subcategory: 'Inventada' }, CATEGORIES, subs)
        .suggestedSubcategory,
    ).toBe('');
  });
});
