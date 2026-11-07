import { describe, expect, it } from 'vitest';
import { parseBlocks, parseInline } from '../richText.js';

describe('parseBlocks', () => {
  it('turns the assistant answer into paragraphs and lists', () => {
    const blocks = parseBlocks(`Hay desviaciones en tu presupuesto:
* **Deudas:** Registraste pagos por $77.578 CLP.
* **Salud:** Tuviste gastos por $30.650 CLP
  sin presupuesto previo.

*Nota: Este balance es una estimación
basada en 26 transacciones.*`);

    expect(blocks).toEqual([
      { type: 'p', text: 'Hay desviaciones en tu presupuesto:' },
      {
        type: 'ul',
        items: [
          '**Deudas:** Registraste pagos por $77.578 CLP.',
          '**Salud:** Tuviste gastos por $30.650 CLP sin presupuesto previo.',
        ],
      },
      {
        type: 'p',
        text: '*Nota: Este balance es una estimación basada en 26 transacciones.*',
      },
    ]);
  });

  it('recognizes headings and numbered lists', () => {
    expect(parseBlocks('## Resumen\n1. Primero\n2) Segundo')).toEqual([
      { type: 'h', text: 'Resumen' },
      { type: 'ol', items: ['Primero', 'Segundo'] },
    ]);
  });
});

describe('parseInline', () => {
  it('splits bold, italic and code without leaving asterisks', () => {
    expect(parseInline('**Deudas:** pagos y *nota* con `código`')).toEqual([
      { text: 'Deudas:', bold: true },
      { text: ' pagos y ' },
      { text: 'nota', italic: true },
      { text: ' con ' },
      { text: 'código', code: true },
    ]);
  });

  it('keeps loose asterisks and markup as plain text', () => {
    expect(parseInline('2 * 3 = 6')).toEqual([{ text: '2 * 3 = 6' }]);
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([
      { text: '<img src=x onerror=alert(1)>' },
    ]);
  });
});
