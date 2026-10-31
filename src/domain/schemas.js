// src/domain/schemas.js
// Validación de lo que se escribe en Firestore. Los campos principales se validan
// estrictamente; `meta` se acepta como objeto porque guarda vínculos de distintas
// versiones de la app (cuotas, subcategorías, metas de ahorro). Se conservan otros
// campos existentes para no romper datos antiguos, pero nunca los que pone el sistema.
import { z } from 'zod';

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Fecha inválida');
const money = z.number().finite().nonnegative().max(1e12);

const transactionFields = {
  type: z.enum(['gasto', 'ingreso']),
  amount: money,
  category: z.string().max(60).optional(),
  description: z.string().max(500).optional(),
  date: dateKey,
  createdAt: z.union([z.string(), z.number()]).optional(),
  ownerId: z.string().max(128).nullable().optional(),
  ownerName: z.string().max(200).nullable().optional(),
  ownerEmail: z.string().max(320).nullable().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
};

// Los ingresos se guardan sin categoría; los gastos la necesitan.
export const transactionSchema = z
  .looseObject(transactionFields)
  .refine((t) => t.type !== 'gasto' || String(t.category || '').trim().length > 0, {
    message: 'Elige una categoría',
    path: ['category'],
  });
export const transactionPatchSchema = z.looseObject(transactionFields).partial();

// Campos que solo escribe el sistema (id del documento y auditoría).
const SYSTEM_FIELDS = ['id', 'updatedAt', 'updatedBy'];

export function stripSystemFields(value) {
  const copy = { ...(value || {}) };
  SYSTEM_FIELDS.forEach((k) => delete copy[k]);
  return copy;
}

// Devuelve { ok: true, data } o { ok: false, message } con un mensaje legible.
export function validate(schema, value) {
  const result = schema.safeParse(stripSystemFields(value));
  if (result.success) return { ok: true, data: result.data };
  const first = result.error.issues[0];
  const field = first?.path?.join('.') || 'dato';
  return { ok: false, message: `${first?.message || 'Dato inválido'} (${field})` };
}
