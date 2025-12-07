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
// Por ahora la importamos desde donde esté:
import { ensureSingleHouseholdForUser } from '../../lib/household.js';
// ↑ si aún NO tienes este archivo, luego lo creamos.
// por ahora déjalo así, aunque falle el import. Ya lo resolvemos.

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
    if (code.includes('invalid-email')) return 'Email inválido.';
    if (code.includes('missing-password')) return 'Falta la contraseña.';
    if (code.includes('operation-not-allowed'))
      return 'El método Email/Password no está habilitado en Firebase.';
    if (code.includes('network-request-failed'))
      return 'Error de red. Revisa tu conexión.';
    if (code.includes('too-many-requests'))
      return 'Demasiados intentos. Intenta más tarde.';
    if (code.includes('invalid-api-key'))
      return 'API key inválida en la configuración de Firebase.';
    if (code.includes('domain-config-required'))
      return 'Agrega este dominio a “Authorized domains” en Firebase.';
    return `No se pudo iniciar sesión (${code}).`;
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
        setResetError('El email no es válido.');
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

        <Card>
          <h3 className="text-lg font-semibold mb-3">Tu centro de control</h3>
          <ul className="space-y-2 text-sm ext-gray-900 dark:text-gray-100">
            <li>✅ Presupuestos por categoría con % de avance</li>
            <li>✅ Movimientos y conciliación rápida</li>
            <li>✅ Deudas y ahorro</li>
            <li>✅ Sesión familiar compartida</li>
          </ul>
        </Card>
      </div>
    );

  return null;
}
