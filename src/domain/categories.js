// src/domain/categories.js
import { DEBT_CATEGORY, SAVINGS_CATEGORY } from '../constants.js';

// Categorías que el sistema usa para vincular pagos de cuotas y aportes de ahorro.
// Renombrarlas o borrarlas rompería esos vínculos, así que no se permite.
export const SYSTEM_CATEGORIES = Object.freeze([DEBT_CATEGORY, SAVINGS_CATEGORY]);

export function isSystemCategory(name) {
  const key = String(name || '').trim().toLowerCase();
  return SYSTEM_CATEGORIES.some((c) => c.toLowerCase() === key);
}

// Devuelve un mensaje de error si la operación no está permitida, o null si se puede.
export function validateCategoryChange({ action, from, to, existing = [] }) {
  const source = String(from || '').trim();
  const target = String(to || '').trim();
  if ((action === 'remove' || action === 'rename') && isSystemCategory(source)) {
    return `"${source}" es una categoría del sistema y no se puede ${
      action === 'remove' ? 'eliminar' : 'renombrar'
    }.`;
  }
  if (action === 'rename' || action === 'add') {
    if (!target) return 'Escribe un nombre para la categoría.';
    if (target.length > 60) return 'El nombre es demasiado largo (máximo 60 caracteres).';
    if (isSystemCategory(target) && target.toLowerCase() !== source.toLowerCase()) {
      return `"${target}" está reservado para el sistema.`;
    }
    const lower = target.toLowerCase();
    if (existing.some((c) => String(c).trim().toLowerCase() === lower && c !== source)) {
      return `Ya existe una categoría llamada "${target}".`;
    }
  }
  return null;
}
