// src/services/households.js
// Funciones compartidas para crear y unir hogares en Firestore
import { db } from '../firebase';
import {
  arrayUnion,
  doc,
  getDoc,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { CATEGORIES } from '../constants/categories';

export const createDefaultBudgets = () =>
  CATEGORIES.reduce((acc, c) => {
    acc[c] = 0;
    return acc;
  }, {});

export async function createHousehold(uid, displayName, householdName) {
  const id = uid.slice(0, 6) + Math.random().toString(36).slice(2, 5);
  const ref = doc(db, 'households', id);
  await setDoc(ref, {
    id,
    name:
      (householdName && householdName.trim()) ||
      `Hogar de ${displayName || 'Usuario'}`,
    members: [uid],
    memberInfo: { [uid]: { name: displayName || 'Usuario' } },
    budgets: createDefaultBudgets(),
    createdAt: Date.now(),
  });
  return id;
}

export async function joinHousehold(uid, code, displayName) {
  const ref = doc(db, 'households', code.trim());
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Código de hogar inválido');
  const data = snap.data();
  if (!data.members.includes(uid)) {
    await updateDoc(ref, {
      members: arrayUnion(uid),
      memberInfo: {
        ...(data.memberInfo || {}),
        [uid]: { name: displayName || 'Usuario' },
      },
    });
  }
  return code.trim();
}

