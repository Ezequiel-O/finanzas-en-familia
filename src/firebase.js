import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from 'firebase/app-check';

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const secondaryApp =
  getApps().find((existing) => existing.name === 'secondary') ||
  initializeApp(firebaseConfig, 'secondary');
const appCheckSiteKey = String(
  import.meta.env.VITE_FIREBASE_APP_CHECK_SITE_KEY || '',
).trim();

export const auth = getAuth(app);
export const db = getFirestore(app);
export const appCheckConfigured = !!appCheckSiteKey;
export const appCheck = appCheckConfigured
  ? initializeAppCheck(app, {
      // reCAPTCHA Classic (v3) está obsoleto en App Check; se usa
      // Fraud Defense (reCAPTCHA Enterprise).
      provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
      isTokenAutoRefreshEnabled: true,
    })
  : null;
export const secondaryAuth = getAuth(secondaryApp);
export const secondaryDb = getFirestore(secondaryApp);
