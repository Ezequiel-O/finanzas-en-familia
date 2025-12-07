// src/lib/household.js

import { doc, setDoc, getDoc, updateDoc, arrayUnion } from 'firebase/firestore';
import { db } from '../firebase';
import { CATEGORIES } from '../constants.js';
import { monthKey } from '../utils/budgetPeriod.js';

// Crea un hogar nuevo con presupuesto inicial y usuario administrador
async function createHousehold(uid, displayName, email) {
  const id = uid.slice(0, 6) + Math.random().toString(36).slice(2, 5);
  const ref = doc(db, 'households', id);
  const categories = [...CATEGORIES];
  const currentMonth = monthKey(); // ej: "2024-12"

  const budgets = {
    [currentMonth]: categories.reduce((acc, c) => {
      acc[c] = { plan: 0, funded: 0 };
      return acc;
    }, {}),
  };

  const superUser = {
    id: 'super-admin',
    name: '',
    pin: '',
    isSuperAdmin: true,
    preferences: {
      defaultTab: 'dashboard',
      showOnlyMyMovements: false,
      dashboardCards: {
        resumenMes: true,
        deudas: true,
        ahorro: true,
        presupuestos: true,
      },
      transactionsDefaults: {
        type: 'gasto',
        defaultCategory: categories[0],
      },
      ui: {
        theme: 'light',
        density: 'normal',
      },
    },
  };

  await setDoc(ref, {
    id,
    members: [uid],
    memberInfo: { [uid]: { name: displayName || email || 'Administrador' } },
    categories,
    budgets,
    createdAt: Date.now(),
    superAdminUid: uid,
    superAdminEmail: email || null,
    householdUsers: [superUser],
    budgetCutDay: 1,
  });

  return id;
}

// Garantiza un solo hogar principal por usuario
export async function ensureSingleHouseholdForUser(user) {
  const uid = user.uid;
  const email = user.email || '';
  const displayName = user.displayName || email || 'Administrador';

  const profRef = doc(db, 'profiles', uid);
  const profSnap = await getDoc(profRef);

  let householdId = null;

  if (profSnap.exists()) {
    const prof = profSnap.data() || {};
    householdId =
      prof.householdId ||
      prof.defaultHouseholdId ||
      (Array.isArray(prof.householdIds) && prof.householdIds[0]) ||
      null;
  }

  if (!householdId) {
    householdId = await createHousehold(uid, displayName, email);
  }

  await setDoc(
    profRef,
    {
      name: displayName,
      householdId,
    },
    { merge: true },
  );

  return householdId;
}

// Unirse a un hogar existente por código
export async function joinHousehold(uid, code, displayName) {
  const ref = doc(db, 'households', code);
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
  return code;
}
