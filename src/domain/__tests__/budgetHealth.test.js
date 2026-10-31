import { describe, expect, it } from 'vitest';
import { budgetLevel, periodPace, spendingOutlook } from '../budgetHealth.js';

describe('budgetLevel', () => {
  it('aplica el semáforo', () => {
    expect(budgetLevel(50, 100)).toBe('ok');
    expect(budgetLevel(80, 100)).toBe('warn');
    expect(budgetLevel(100, 100)).toBe('warn');
    expect(budgetLevel(101, 100)).toBe('over');
    expect(budgetLevel(10, 0)).toBe('over');
    expect(budgetLevel(0, 0)).toBe('none');
  });
});

describe('periodPace', () => {
  // Periodo "2026-10" con corte día 1: 1 oct a 31 oct (31 días).
  it('cuenta hoy como transcurrido y como restante', () => {
    const first = periodPace('2026-10', 1, '2026-10-01');
    expect(first.totalDays).toBe(31);
    expect(first.elapsedDays).toBe(1);
    expect(first.daysLeft).toBe(31);

    const last = periodPace('2026-10', 1, '2026-10-31');
    expect(last.elapsedDays).toBe(31);
    expect(last.daysLeft).toBe(1);
  });

  it('respeta el día de corte', () => {
    // Corte 25: periodo "2026-10" va del 25 oct al 24 nov.
    const p = periodPace('2026-10', 25, '2026-11-24');
    expect(p.start).toBe('2026-10-25');
    expect(p.end).toBe('2026-11-25');
    expect(p.daysLeft).toBe(1);
    expect(p.isCurrent).toBe(true);
  });

  it('periodos pasados y futuros', () => {
    expect(periodPace('2026-09', 1, '2026-10-15')).toMatchObject({ isPast: true, daysLeft: 0 });
    expect(periodPace('2026-11', 1, '2026-10-15')).toMatchObject({ isCurrent: false, elapsedDays: 0, daysLeft: 30 });
  });
});

describe('spendingOutlook', () => {
  it('calcula lo disponible por día y la proyección', () => {
    // Día 10 de 31, gastado 100.000 de 310.000.
    const o = spendingOutlook({ planned: 310000, spent: 100000, periodKey: '2026-10', cutDay: 1, today: '2026-10-10' });
    expect(o.remaining).toBe(210000);
    expect(o.daysLeft).toBe(22);
    expect(o.perDay).toBe(Math.floor(210000 / 22));
    expect(o.projected).toBe(310000);
    expect(o.projectedOver).toBe(0);
    expect(o.level).toBe('ok');
  });

  it('avisa si el ritmo excede el presupuesto', () => {
    const o = spendingOutlook({ planned: 100000, spent: 60000, periodKey: '2026-10', cutDay: 1, today: '2026-10-10' });
    expect(o.projected).toBe(186000);
    expect(o.projectedOver).toBe(86000);
  });

  it('no multiplica los gastos fijos por el ritmo diario', () => {
    // Día 3 de 31: se pagaron 50.000 de un fijo de 500.000 y se gastaron 30.000 variables.
    const o = spendingOutlook({
      planned: 800000,
      spent: 80000,
      fixedPlanned: 500000,
      fixedSpent: 50000,
      periodKey: '2026-10',
      cutDay: 1,
      today: '2026-10-03',
    });
    expect(o.projected).toBe(500000 + Math.round((30000 / 3) * 31));
    expect(o.canProject).toBe(false);
    const later = spendingOutlook({ planned: 800000, spent: 80000, periodKey: '2026-10', cutDay: 1, today: '2026-10-07' });
    expect(later.canProject).toBe(true);
  });

  it('no sugiere gastar más de la plata que hay hoy', () => {
    // Día 10 de 31: quedan 210.000 de presupuesto pero solo hay 44.000 en caja.
    const o = spendingOutlook({ planned: 310000, spent: 100000, cashAvailable: 44000, periodKey: '2026-10', cutDay: 1, today: '2026-10-10' });
    expect(o.limitedByCash).toBe(true);
    expect(o.perDay).toBe(2000);
    const ok = spendingOutlook({ planned: 310000, spent: 100000, cashAvailable: 900000, periodKey: '2026-10', cutDay: 1, today: '2026-10-10' });
    expect(ok.limitedByCash).toBe(false);
    expect(ok.perDay).toBe(Math.floor(210000 / 22));
  });

  it('sin saldo no sugiere gasto diario', () => {
    const o = spendingOutlook({ planned: 100, spent: 150, periodKey: '2026-10', cutDay: 1, today: '2026-10-10' });
    expect(o.perDay).toBe(0);
    expect(o.level).toBe('over');
  });
});
