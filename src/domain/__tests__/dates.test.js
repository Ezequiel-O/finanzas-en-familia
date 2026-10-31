import { describe, expect, it } from 'vitest';
import { addDaysToKey, daysBetween, toLocalDateKey, todayKey } from '../dates.js';

describe('fechas locales', () => {
  it('usa el día local, no el de UTC', () => {
    // 23:30 hora local: con toISOString() en Chile esto daría el día siguiente.
    const lateNight = new Date(2026, 9, 31, 23, 30);
    expect(toLocalDateKey(lateNight)).toBe('2026-10-31');
    expect(todayKey(lateNight)).toBe('2026-10-31');
  });

  it('cuenta días entre claves', () => {
    expect(daysBetween('2026-10-01', '2026-11-01')).toBe(31);
    expect(daysBetween('2026-11-01', '2026-10-01')).toBe(-31);
    expect(daysBetween('mal', '2026-10-01')).toBe(0);
  });

  it('suma días cruzando meses', () => {
    expect(addDaysToKey('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDaysToKey('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('rechaza fechas inválidas', () => {
    expect(toLocalDateKey(new Date('x'))).toBe('');
  });
});
