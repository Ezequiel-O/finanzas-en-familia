import React, { useState, useEffect } from 'react';

import { Card } from '../../components/ui/card.jsx';

import {
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
} from 'firebase/auth';

import { auth } from '../../firebase';

// Esta función debe existir en tu App.jsx actual
// y DEBE ser movida después.
// Por ahora déjalo así, aunque falle el import. Ya lo resolvemos.
import { ensureSingleHouseholdForUser } from '../../lib/household.js';
// â†‘ si aÃºn NO tienes este archivo, luego lo creamos.
// por ahora dÃ©jalo asÃ­, aunque falle el import. Ya lo resolvemos.

export function AuthGate({ onReady }) {
  const [phase, setPhase] = useState('loading'); // loading | auth | ready
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [tip, setTip] = useState('');
  const [resetMsg, setResetMsg] = useState('');
  const [resetError, setResetError] = useState('');

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        setUser(null);
        setPhase('auth');
        return;
      }

      setUser(u);
      setPhase('loading');

      try {
        const hid = await ensureSingleHouseholdForUser(u);
        setPhase('ready');
        onReady({ user: u, householdId: hid });
      } catch (e) {
        console.error('Error asegurando hogar único:', e);
        setTip('No se pudo cargar tus datos. Intenta más tarde.');
        setPhase('auth');
      }
    });

    return () => unsub();
  }, [onReady]);

  function mapAuthError(err) {
    const code = String(err?.code || '');
    if (code.includes('invalid-credential') || code.includes('wrong-password'))
      return 'Credenciales inválidas.';
    if (code.includes('user-not-found')) return 'Usuario no encontrado.';
    if (code.includes('invalid-email')) return 'Email invÃ¡lido.';
    if (code.includes('missing-password')) return 'Falta la contraseña.';
    if (code.includes('operation-not-allowed'))
      return 'El mÃ©todo Email/Password no estÃ¡ habilitado en Firebase.';
    if (code.includes('network-request-failed'))
      return 'Error de red. Revisa tu conexiÃ³n.';
    if (code.includes('too-many-requests'))
      return 'Demasiados intentos. Intenta mÃ¡s tarde.';
    if (code.includes('invalid-api-key'))
      return 'API key invÃ¡lida en la configuraciÃ³n de Firebase.';
    if (code.includes('domain-config-required'))
      return 'Agrega este dominio a â€œAuthorized domainsâ€ en Firebase.';
    return `No se pudo iniciar sesiÃ³n (${code}).`;
  }

  async function handleLogin(e) {
    e.preventDefault();

    if (!email?.trim() || !pass?.trim()) {
      setTip('Ingresa un email y contraseña válidos');
      return;
    }
    setTip('');

    try {
      if (isRegister) {
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        const hid = await ensureSingleHouseholdForUser(cred.user);
        setUser(cred.user);
        setPhase('ready');
        onReady({ user: cred.user, householdId: hid });
      } else {
        await signInWithEmailAndPassword(auth, email, pass);
      }
    } catch (err) {
      console.error(err);
      setTip(mapAuthError(err));
    }
  }

  async function handleResetPassword() {
    setResetMsg('');
    setResetError('');

    const mail = (email || '').trim();
    if (!mail) {
      setResetError(
        'Escribe tu email para enviarte el enlace de recuperación.',
      );
      return;
    }

    try {
      await sendPasswordResetEmail(auth, mail);
      setResetMsg(
        'Te enviamos un correo con el enlace para restablecer tu contraseña. Revisa también tu carpeta de Spam o Correos no deseados.',
      );
    } catch (err) {
      console.error('Error reset password:', err);
      const code = String(err?.code || '');
      if (code.includes('user-not-found')) {
        setResetError('No existe un usuario registrado con ese email.');
      } else if (code.includes('invalid-email')) {
        setResetError('El email no es vÃ¡lido.');
      } else {
        setResetError(
          'No se pudo enviar el correo de recuperación. Intenta más tarde.',
        );
      }
    }
  }

  if (phase === 'loading')
    return <div className="p-8 text-center">Cargando…</div>;

  if (phase === 'auth')
    return (
      <div className="max-w-6xl mx-auto grid md:grid-cols-2 items-start gap-10 py-8 px-4">
        <Card className="w-full max-w-xl mx-auto md:mx-0">
          <h1 className="text-2xl font-bold mb-4">Inicia sesión</h1>
          <form onSubmit={handleLogin} className="grid gap-3 relative">
            <input
              className="border rounded-lg p-2"
              placeholder="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <input
              className="border rounded-lg p-2"
              placeholder="Contraseña"
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              required
            />
            <button className="px-3 py-2 rounded-xl border bg-gray-900 text-white">
              {isRegister ? 'Crear cuenta' : 'Entrar'}
            </button>

            {tip && (
              <div className="absolute -bottom-10 left-0 bg-red-50 text-red-700 border border-red-200 rounded-md px-3 py-2 text-sm shadow-sm dark:shadow-none">
                {tip}
              </div>
            )}
          </form>

          <div className="mt-3 flex flex-col gap-1 text-sm">
            <button
              type="button"
              className="text-blue-600 text-left"
              onClick={handleResetPassword}
            >
              ¿Olvidaste tu contraseña?
            </button>

            {resetMsg && (
              <div className="text-xs text-green-700">{resetMsg}</div>
            )}
            {resetError && (
              <div className="text-xs text-red-600">{resetError}</div>
            )}
          </div>

          <button
            className="text-sm mt-4"
            onClick={() => setIsRegister(!isRegister)}
          >
            {isRegister
              ? '¿Ya tienes cuenta? Inicia sesión'
              : '¿No tienes cuenta? Regístrate'}
          </button>
        </Card>

        <Card className="bg-gradient-to-br from-gray-50 to-white dark:from-gray-800 dark:to-gray-900 border border-gray-200 dark:border-gray-700 shadow-md">
          <h3 className="text-xl font-bold mb-2 text-gray-900 dark:text-gray-50">
            Finanzas en Familia
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
            Tu panel de mando para coordinar presupuesto, movimientos y metas
            con toda la familia.
          </p>
          <div className="grid gap-2 text-sm text-gray-800 dark:text-gray-100">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-200 text-xs"></span>
              Presupuestos por categoría con avance en tiempo real
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-200 text-xs"></span>
              Movimientos claros y conciliación rápida
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-200 text-xs"></span>
              Deudas y ahorro ordenados en un solo lugar
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-200 text-xs"></span>
              Sesión familiar compartida para que todos estén al día
            </div>
          </div>
        </Card>
      </div>
    );

  return null;
}
