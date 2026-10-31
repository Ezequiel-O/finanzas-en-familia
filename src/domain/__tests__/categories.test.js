import { describe, expect, it } from 'vitest';
import { isSystemCategory, validateCategoryChange } from '../categories.js';

describe('categorías del sistema', () => {
  it('reconoce Deudas y Ahorro sin importar mayúsculas', () => {
    expect(isSystemCategory('ahorro')).toBe(true);
    expect(isSystemCategory(' Deudas ')).toBe(true);
    expect(isSystemCategory('Hogar')).toBe(false);
  });

  it('impide renombrar o borrar categorías del sistema', () => {
    expect(validateCategoryChange({ action: 'rename', from: 'Ahorro', to: 'Ahorros' })).toMatch(/sistema/);
    expect(validateCategoryChange({ action: 'remove', from: 'Deudas' })).toMatch(/sistema/);
  });

  it('impide usar un nombre reservado o duplicado', () => {
    expect(validateCategoryChange({ action: 'rename', from: 'Otros', to: 'ahorro' })).toMatch(/reservado/);
    expect(validateCategoryChange({ action: 'add', to: 'hogar', existing: ['Hogar'] })).toMatch(/Ya existe/);
    expect(validateCategoryChange({ action: 'rename', from: 'Hogar', to: 'Casa', existing: ['Hogar'] })).toBeNull();
  });
});
