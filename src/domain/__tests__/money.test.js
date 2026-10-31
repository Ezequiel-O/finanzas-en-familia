import { describe, expect, it } from 'vitest';
import { formatAmountInput, formatCLP, parseAmount } from '../money.js';

describe('parseAmount', () => {
  it.each([
    ['15000', 15000],
    ['15.000', 15000],
    ['$15.000', 15000],
    ['1.250.000', 1250000],
    ['15 mil', 15000],
    ['15 lucas', 15000],
    ['una luca', 0],
    ['2 lucas', 2000],
    ['15k', 15000],
    ['1,5 millones', 1500000],
    ['2 millones', 2000000],
    ['medio millón', 500000],
    ['', 0],
    ['abc', 0],
    ['-500', 500],
  ])('%s -> %i', (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });
});

describe('formatCLP', () => {
  it('formatea con separador de miles chileno', () => {
    expect(formatCLP(1234567)).toBe('$1.234.567');
    expect(formatCLP(-2500)).toBe('-$2.500');
    expect(formatCLP(null)).toBe('$0');
  });
});

describe('formatAmountInput', () => {
  it('deja solo dígitos y agrega puntos', () => {
    expect(formatAmountInput('15000')).toBe('15.000');
    expect(formatAmountInput('$ 1a2b3')).toBe('123');
    expect(formatAmountInput('')).toBe('');
  });
});
