// src/lib/household.js

import {
  collection,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  arrayUnion,
  getDocs,
  query,
  where,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase';
import { CATEGORIES } from '../constants.js';
import { monthKey } from '../utils/budgetPeriod.js';

// Crea un hogar nuevo con presupuesto inicial y usuario base
async function createHousehold(uid, displayName, email) {
  const id = uid.slice(0, 6) + Math.random().toString(36).slice(2, 5);
  const ref = doc(db, 'households', id);
  const currentMonth = monthKey(); // ej: "2024-12"
  const configRef = doc(db, 'households', id, 'meta', 'config');
  const budgetsRef = doc(db, 'households', id, 'budgets', currentMonth);
  const categories = [...CATEGORIES];

  const budgetItems = categories.reduce((acc, c) => {
    acc[c] = { plan: 0, funded: 0 };
    return acc;
  }, {});

  const defaultUser = {
    id: uid,
    name: displayName || email || 'Usuario',
    email: email || '',
    authUid: uid,
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
    ownerUid: uid,
    members: [uid],
    memberInfo: { [uid]: { name: displayName || email || 'Usuario' } },
    createdAt: Date.now(),
    householdUsers: [defaultUser],
    budgetCutDay: 1,
    migrations: {
      budgetsToSubcollection: true,
      configToSubcollection: true,
    },
  });
  await setDoc(configRef, {
    categories,
    fixedCategories: {},
    updatedAt: serverTimestamp(),
    updatedBy: uid,
  });
  await setDoc(budgetsRef, {
    monthKey: currentMonth,
    items: budgetItems,
    updatedAt: serverTimestamp(),
    updatedBy: uid,
  });

  return id;
}

// Garantiza un solo hogar principal por usuario
export async function ensureSingleHouseholdForUser(user) {
  const uid = user.uid;
  const email = user.email || '';
  const displayName = user.displayName || email || 'Usuario';

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
    if (!householdId && prof.inviteOnly) {
      return null;
    }
  }

  if (!householdId) {
    try {
      const q = query(
        collection(db, 'households'),
        where('members', 'array-contains', uid),
      );
      const snap = await getDocs(q);
      if (!snap.empty) {
        householdId = snap.docs[0].id;
      }
    } catch (err) {
      console.error('Error buscando hogares existentes:', err);
    }
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
