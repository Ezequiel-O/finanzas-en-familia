import { describe, expect, it } from 'vitest';
import { parseQuickEntry, rankCategories } from '../quickEntry.js';

const categories = ['Deudas', 'Ahorro', 'Hogar', 'Alimentación', 'Transporte', 'Salud', 'Servicios (luz/agua/internet)', 'Otros'];
const today = '2026-10-30';

describe('parseQuickEntry', () => {
  it('entiende "súper 15 lucas"', () => {
    expect(parseQuickEntry('súper 15 lucas', { categories, today })).toEqual({
      type: 'gasto',
      amount: 15000,
      category: 'Alimentación',
      description: 'Súper',
      date: today,
    });
  });

  it('entiende fechas relativas y montos con "mil"', () => {
    const r = parseQuickEntry('bencina 30 mil ayer', { categories, today });
    expect(r).toMatchObject({ amount: 30000, category: 'Transporte', date: '2026-10-29', description: 'Bencina' });
  });

  it('usa el nombre de la categoría si aparece', () => {
    expect(parseQuickEntry('salud $12.990', { categories, today }).category).toBe('Salud');
    expect(parseQuickEntry('cuenta de luz 25000', { categories, today }).category).toBe('Servicios (luz/agua/internet)');
  });

  it('aprende de descripciones anteriores', () => {
    const transactions = [
      { type: 'gasto', category: 'Hogar', description: 'Maestro gasfíter' },
      { type: 'gasto', category: 'Hogar', description: 'Maestro pintor' },
    ];
    expect(parseQuickEntry('maestro 40 mil', { categories, transactions, today }).category).toBe('Hogar');
  });

  it('detecta ingresos', () => {
    expect(parseQuickEntry('sueldo 900 mil', { categories, today })).toMatchObject({ type: 'ingreso', amount: 900000, category: '' });
  });

  it('nunca propone categorías del sistema', () => {
    expect(parseQuickEntry('ahorro 10000', { categories, today }).category).toBe('');
  });
});

describe('rankCategories', () => {
  it('ordena por uso reciente y excluye las del sistema', () => {
    const transactions = [
      { type: 'gasto', category: 'Transporte', date: '2026-10-20' },
      { type: 'gasto', category: 'Transporte', date: '2026-10-21' },
      { type: 'gasto', category: 'Salud', date: '2026-10-22' },
      { type: 'gasto', category: 'Hogar', date: '2025-01-01' }, // antiguo, no cuenta
    ];
    const ranked = rankCategories(categories, transactions, { today });
    expect(ranked.slice(0, 3)).toEqual(['Transporte', 'Salud', 'Hogar']);
    expect(ranked).not.toContain('Deudas');
    expect(ranked).not.toContain('Ahorro');
  });
});
