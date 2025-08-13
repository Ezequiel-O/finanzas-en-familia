import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: 'AIzaSyBvUbqOY1RtfNV8PRHnPI_9glT3NxdvnTk',
  authDomain: 'finanzas-en-familia.firebaseapp.com',
  projectId: 'finanzas-en-familia',
  storageBucket: 'finanzas-en-familia.firebasestorage.app',
  messagingSenderId: '17591421570',
  appId: '1:17591421570:web:294c3f157670e1bf48829b',
  measurementId: 'G-6X9XM5SDEE',
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
