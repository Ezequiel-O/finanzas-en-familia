import React, { useState, useEffect } from 'react';

import { Card } from '../../components/ui/card.jsx';

import {
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  updatePassword,
} from 'firebase/auth';
import {
  arrayUnion,
  deleteDoc,
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';

import { auth, db } from '../../firebase';
import { hashInviteToken } from '../../lib/invites.js';

const TEMP_LOGIN_DOMAIN = 'finanzasenfamilia.com';

// Esta función debe existir en tu App.jsx actual
// y DEBE ser movida después.
// Por ahora déjalo así, aunque falle el import. Ya lo resolvemos.
import { ensureSingleHouseholdForUser } from '../../lib/household.js';
// Si aún NO tienes este archivo, luego lo creamos.
// Por ahora déjalo así, aunque falle el import. Ya lo resolvemos.

export function AuthGate({ onReady }) {
  const [phase, setPhase] = useState('loading'); // loading | auth | ready
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [tip, setTip] = useState('');
  const [resetMsg, setResetMsg] = useState('');
  const [resetError, setResetError] = useState('');
  const [isResettingPassword, setIsResettingPassword] = useState(false);
  const [inviteToken, setInviteToken] = useState('');
  const [inviteHouseholdId, setInviteHouseholdId] = useState('');
  const [inviteId, setInviteId] = useState('');
  const [inviteFrom, setInviteFrom] = useState('');
  const [lastInviteInfo, setLastInviteInfo] = useState(null);
  const [showInviteDebug, setShowInviteDebug] = useState(false);
  const [pendingAccess, setPendingAccess] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordChangeError, setPasswordChangeError] = useState('');
  const [passwordChangeBusy, setPasswordChangeBusy] = useState(false);
  const isInviteMode = Boolean(
    inviteToken || inviteHouseholdId || inviteId || inviteFrom,
  );
  const inviteLabel = inviteFrom || 'superadministrador';
  const authTitle = isInviteMode
    ? `Acceder a sesión de ${inviteLabel}`
    : isResettingPassword
      ? 'Recuperar contrasena'
      : isRegister
        ? 'Crear cuenta'
        : 'Inicio de sesión';
  const submitLabel = isResettingPassword
    ? 'Enviar correo'
    : isInviteMode
      ? 'Acceder a presupuesto'
      : isRegister
        ? 'Crear cuenta'
        : 'Entrar';
  const inviteDebugInfo =
    lastInviteInfo ||
    (inviteToken || inviteHouseholdId || inviteId || inviteFrom
      ? {
          url: typeof window !== 'undefined' ? window.location.href : '',
          token: inviteToken,
          inviteId,
          householdId: inviteHouseholdId,
          invitedBy: inviteFrom,
        }
      : null);
  const showInviteLinkHint = !!inviteDebugInfo?.url && (isInviteMode || tip);

  function getPasswordCheck(value) {
    const passValue = String(value || '');
    const hasLower = /[a-z]/.test(passValue);
    const hasUpper = /[A-Z]/.test(passValue);
    const hasNumber = /[0-9]/.test(passValue);
    const hasSymbol = /[^A-Za-z0-9]/.test(passValue);
    const longEnough = passValue.length >= 6;
    const score = [hasLower, hasUpper, hasNumber, hasSymbol, longEnough].filter(
      Boolean,
    ).length;
    const percent = Math.round((score / 5) * 100);
    const label = score <= 2 ? 'Debil' : score === 3 ? 'Media' : 'Fuerte';
    const isStrong =
      hasLower && hasUpper && hasNumber && hasSymbol && longEnough;
    return {
      hasLower,
      hasUpper,
      hasNumber,
      hasSymbol,
      longEnough,
      score,
      percent,
      label,
      isStrong,
    };
  }

  const passwordCheck = getPasswordCheck(pass);
  const newPasswordCheck = getPasswordCheck(newPassword);

  useEffect(() => {
    if (!isInviteMode) return;
    setIsRegister(true);
    setIsResettingPassword(false);
  }, [isInviteMode]);

  function clearInviteFromUrl() {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.pathname = '/';
    url.search = '';
    window.history.replaceState({}, '', url.toString());
  }

  function normalizeLoginEmail(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.includes('@')) return raw;
    return `${raw}@${TEMP_LOGIN_DOMAIN}`;
  }

  function openInviteDebug() {
    if (!inviteDebugInfo) {
      setTip('No hay datos de invitación para revisar.');
      return;
    }
    setShowInviteDebug(true);
  }

  async function isHouseholdMember(uid, hid) {
    if (!uid || !hid) return false;
    try {
      const snap = await getDoc(doc(db, 'households', hid));
      if (!snap.exists()) return false;
      const members = snap.data()?.members || [];
      return Array.isArray(members) && members.includes(uid);
    } catch (err) {
      return false;
    }
  }
  async function markTempAccessUsed(hid, uid) {
    if (!hid || !uid) return;
    const ref = doc(db, 'households', hid);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const data = snap.data() || {};
      const base = Array.isArray(data.householdUsers)
        ? data.householdUsers
        : [];
      let touched = false;
      const next = base.map((u) => {
        if (u.authUid === uid || u.id === uid) {
          touched = true;
          return {
            ...u,
            tempAccessActive: false,
            tempAccessUsedAtMs: Date.now(),
          };
        }
        return u;
      });
      if (!touched) return;
      tx.update(ref, {
        householdUsers: next,
        updatedAt: serverTimestamp(),
        updatedBy: uid,
      });
    });
  }

  async function createJoinRequest(u, hid, invite, token) {
    const tokenHash = await hashInviteToken(token);
    const displayName = u.displayName || u.email || 'Usuario';
    const email = u.email || '';
    const emailLower = email ? email.toLowerCase() : '';
    const reqRef = doc(db, 'households', hid, 'joinRequests', u.uid);
    await setDoc(reqRef, {
      uid: u.uid,
      inviteId: invite,
      tokenHash,
      status: 'pending',
      createdAtMs: Date.now(),
      displayName,
      email,
      emailLower,
    });
    try {
      await setDoc(
        doc(db, 'profiles', u.uid),
        {
          pendingHouseholdId: hid,
          invitedBy: inviteFrom || '',
          invitedAtMs: Date.now(),
          inviteOnly: true,
        },
        { merge: true },
      );
    } catch (err) {
      console.warn('No se pudo guardar el estado de invitacion:', err);
    }
  }

  async function acceptInvite(u, hid, invite, token) {
    const reqRef = doc(db, 'households', hid, 'joinRequests', u.uid);
    const reqSnap = await getDoc(reqRef);
    let needsRequest = true;
    if (reqSnap.exists()) {
      const current = reqSnap.data() || {};
      const status = current.status || 'pending';
      if ((current.inviteId || '') !== invite) {
        try {
          await deleteDoc(reqRef);
        } catch (err) {
          throw new Error('invite-mismatch');
        }
      } else {
        needsRequest = false;
        if (status === 'rejected') {
          throw new Error('invite-rejected');
        }
        if (status === 'accepted') {
          throw new Error('invite-used');
        }
      }
    }

    if (needsRequest) {
      await createJoinRequest(u, hid, invite, token);
    }

    const displayName = u.displayName || u.email || 'Usuario';
    const email = u.email || '';
    await updateDoc(doc(db, 'households', hid), {
      members: arrayUnion(u.uid),
      [`memberInfo.${u.uid}`]: {
        name: displayName,
        ...(email ? { email } : {}),
      },
      updatedAt: serverTimestamp(),
      updatedBy: u.uid,
    });

    await updateDoc(reqRef, {
      status: 'accepted',
      acceptedAtMs: Date.now(),
      acceptedByUid: u.uid,
    });

    await updateDoc(doc(db, 'households', hid, 'invites', invite), {
      status: 'accepted',
      acceptedAtMs: Date.now(),
      acceptedByUid: u.uid,
    });
  }

  async function finalizeInvite(u, hid) {
    const displayName = u.displayName || u.email || 'Usuario';
    await setDoc(
      doc(db, 'profiles', u.uid),
      {
        householdId: hid,
        defaultHouseholdId: hid,
        name: displayName,
        pendingHouseholdId: null,
      },
      { merge: true },
    );
    setPhase('ready');
    onReady({ user: u, householdId: hid });
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (!url.pathname.startsWith('/invite')) return;
    const token = url.searchParams.get('token');
    const hid = url.searchParams.get('hid');
    const invite = url.searchParams.get('invite');
    const invitedBy = url.searchParams.get('by') || '';
    setLastInviteInfo({
      url: url.toString(),
      token: token || '',
      inviteId: invite || '',
      householdId: hid || '',
      invitedBy,
    });
    if (token && hid && invite) {
      setInviteToken(token);
      setInviteHouseholdId(hid);
      setInviteId(invite);
      setInviteFrom(invitedBy);
      setIsRegister(true);
      setIsResettingPassword(false);
      setTip(
        'Tienes una invitacion pendiente. Crea tu cuenta para continuar.',
      );
      return;
    }
    if (invitedBy) setInviteFrom(invitedBy);
    setTip('Link de invitacion incompleto.');
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        setPhase('auth');
        setPendingAccess(null);
        setNewPassword('');
        setConfirmPassword('');
        setPasswordChangeError('');
        return;
      }

      setPhase('loading');

      try {
        if (inviteToken && inviteHouseholdId && inviteId) {
          const alreadyMember = await isHouseholdMember(
            u.uid,
            inviteHouseholdId,
          );
          if (alreadyMember) {
            clearInviteFromUrl();
            setInviteToken('');
            setInviteHouseholdId('');
            setInviteId('');
            setInviteFrom('');
            await finalizeInvite(u, inviteHouseholdId);
            return;
          }

          try {
            await acceptInvite(u, inviteHouseholdId, inviteId, inviteToken);
            setInviteToken('');
            setInviteHouseholdId('');
            setInviteId('');
            setInviteFrom('');
            clearInviteFromUrl();
            await finalizeInvite(u, inviteHouseholdId);
            return;
          } catch (err) {
            console.error('Error aceptando invitacion:', err);
            const code = String(err?.code || '');
            const message = String(err?.message || '');
            if (message.includes('invite-rejected')) {
              setTip('Esta invitación fue cancelada. Pide un nuevo enlace.');
            } else if (message.includes('invite-used')) {
              setTip('Este enlace ya fue usado. Pide uno nuevo.');
            } else if (message.includes('invite-mismatch')) {
              setTip('El enlace no coincide con tu invitación. Pide uno nuevo.');
            } else if (code.includes('permission-denied')) {
              setTip('Este enlace ya fue usado o venció. Pide uno nuevo.');
            } else {
              setTip('No se pudo activar la invitación. Revisa el enlace.');
            }
            setInviteToken('');
            setInviteHouseholdId('');
            setInviteId('');
            setInviteFrom('');
            clearInviteFromUrl();
            try {
              await signOut(auth);
            } catch (signOutErr) {
              console.error(
                'Error cerrando sesion tras fallo de invitacion:',
                signOutErr,
              );
            }
            setPhase('auth');
            return;
          }
        }

        const profileSnap = await getDoc(doc(db, 'profiles', u.uid));
        const profile = profileSnap.exists() ? profileSnap.data() || {} : {};
        if (profile.mustChangePassword) {
          const hid =
            profile.householdId ||
            profile.defaultHouseholdId ||
            (Array.isArray(profile.householdIds) && profile.householdIds[0]) ||
            null;
          if (hid) {
            try {
              await markTempAccessUsed(hid, u.uid);
            } catch (err) {
              console.warn('No se pudo marcar la invitacion como usada:', err);
            }
          }
          setPendingAccess({ user: u, householdId: hid });
          setNewPassword('');
          setConfirmPassword('');
          setPasswordChangeError('');
          setPhase('password');
          return;
        }

        const hid = await ensureSingleHouseholdForUser(u);
        if (!hid) {
          setTip('Tu acceso es solo por invitación. Pide un nuevo enlace.');
          try {
            await signOut(auth);
          } catch (signOutErr) {
            console.error('Error cerrando sesion:', signOutErr);
          }
          setPhase('auth');
          return;
        }
        setPhase('ready');
        onReady({ user: u, householdId: hid });
      } catch (e) {
        console.error('Error asegurando hogar unico:', e);
        setTip('No se pudo cargar tus datos. Intenta mas tarde.');
        setPhase('auth');
      }
    });

    return () => unsub();
  }, [onReady, inviteToken, inviteHouseholdId, inviteId]);

  function mapAuthError(err) {
    const code = String(err?.code || '');
    if (code.includes('invalid-credential') || code.includes('wrong-password'))
      return 'Credenciales inválidas.';
    if (code.includes('user-not-found')) return 'Usuario no encontrado.';
    if (code.includes('email-already-in-use'))
      return 'El email ya está registrado.';
    if (code.includes('invalid-email')) return 'Email inválido.';
    if (code.includes('missing-password')) return 'Falta la contraseña.';
    if (code.includes('operation-not-allowed'))
      return 'El método Correo/Contraseña no está habilitado en Firebase.';
    if (code.includes('network-request-failed'))
      return 'Error de red. Revisa tu conexión.';
    if (code.includes('too-many-requests'))
      return 'Demasiados intentos. Intenta más tarde.';
    if (code.includes('invalid-api-key'))
      return 'API key inválida en la configuración de Firebase.';
    if (code.includes('domain-config-required'))
      return 'Agrega este dominio a "Authorized domains" en Firebase.';
    return `No se pudo iniciar sesión (${code}).`;
  }
  async function handleLogin(e) {
    e.preventDefault();

    if (!email?.trim() || !pass?.trim()) {
      setTip('Ingresa usuario o email y contrasena validos');
      return;
    }
    const inviteMode = isInviteMode;
    if ((isRegister || inviteMode) && !passwordCheck.isStrong) {
      setTip(
        'La contrasena debe tener 6+ caracteres, mayuscula, minuscula, numero y simbolo.',
      );
      return;
    }
    setTip('');

    const loginEmail = normalizeLoginEmail(email);

    try {
      if (isRegister || inviteMode) {
        const cred = await createUserWithEmailAndPassword(
          auth,
          loginEmail,
          pass,
        );
        setPhase('loading');
      } else {
        await signInWithEmailAndPassword(auth, loginEmail, pass);
      }
    } catch (err) {
      console.error(err);
      const code = String(err?.code || '');
      if (inviteMode && code.includes('email-already-in-use')) {
        try {
          await signInWithEmailAndPassword(auth, loginEmail, pass);
          return;
        } catch (loginErr) {
          console.error(loginErr);
          setTip(mapAuthError(loginErr));
          return;
        }
      }
      setTip(mapAuthError(err));
    }
  }

  async function handleResetPassword() {
    setResetMsg('');
    setResetError('');
    setTip('');

    const mail = (email || '').trim();
    if (!mail) {
      setResetError(
        'Escribe tu email para enviarte el enlace de recuperacion.',
      );
      return;
    }

    const normalizedMail = normalizeLoginEmail(mail).toLowerCase();
    if (normalizedMail.endsWith(`@${TEMP_LOGIN_DOMAIN}`)) {
      setResetError(
        'Este usuario fue creado por el superadministrador. Habla con el superadministrador para que te entregue una clave temporal.',
      );
      return;
    }

    try {
      await sendPasswordResetEmail(auth, mail);
      setResetMsg(
        'Te enviamos un correo con el enlace para restablecer tu contrasena. Revisa tambien tu carpeta de Spam o Correos no deseados.',
      );
    } catch (err) {
      console.error('Error reset password:', err);
      const code = String(err?.code || '');
      if (code.includes('user-not-found')) {
        setResetError('No existe un usuario registrado con ese email.');
      } else if (code.includes('invalid-email')) {
        setResetError('El email no es valido.');
      } else {
        setResetError(
          'No se pudo enviar el correo de recuperacion. Intenta mas tarde.',
        );
      }
    }
  }

  async function handlePasswordChange(e) {
    e.preventDefault();
    if (!pendingAccess?.user) return;
    if (!newPassword || !confirmPassword) {
      setPasswordChangeError('Completa ambos campos.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordChangeError('Las contraseñas no coinciden.');
      return;
    }
    if (!newPasswordCheck.isStrong) {
      setPasswordChangeError(
        'La contrasena debe tener 6+ caracteres, mayuscula, minuscula, numero y simbolo.',
      );
      return;
    }

    setPasswordChangeBusy(true);
    setPasswordChangeError('');
    try {
      await updatePassword(pendingAccess.user, newPassword);
      await setDoc(
        doc(db, 'profiles', pendingAccess.user.uid),
        {
          mustChangePassword: false,
          passwordUpdatedAtMs: Date.now(),
        },
        { merge: true },
      );
      await markTempAccessUsed(pendingAccess.householdId, pendingAccess.user.uid);
      const finalHid =
        pendingAccess.householdId ||
        (await ensureSingleHouseholdForUser(pendingAccess.user));
      setPendingAccess(null);
      setNewPassword('');
      setConfirmPassword('');
      setPhase('ready');
      onReady({ user: pendingAccess.user, householdId: finalHid });
    } catch (err) {
      console.error('Error actualizando contrasena:', err);
      const code = String(err?.code || '');
      if (code.includes('weak-password')) {
        setPasswordChangeError('La contrasena es muy debil.');
      } else if (code.includes('requires-recent-login')) {
        setPasswordChangeError(
          'Tu sesion expiro. Inicia sesion de nuevo.',
        );
        try {
          await signOut(auth);
        } catch (signOutErr) {
          console.error('Error cerrando sesion:', signOutErr);
        }
        setPendingAccess(null);
        setPhase('auth');
      } else {
        setPasswordChangeError(
          'No se pudo actualizar la contrasena. Intenta de nuevo.',
        );
      }
    } finally {
      setPasswordChangeBusy(false);
    }
  }

  if (phase === 'loading')
    return <div className="p-8 text-center">Cargando...</div>;

  if (phase === 'password')
    return (
      <div className="max-w-md mx-auto flex flex-col gap-6 py-10 px-4">
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-[color:var(--text)] mb-2">
            Actualiza tu contrasena
          </h2>
          <p className="text-sm text-[color:var(--text-muted)] mb-4">
            Debes cambiar tu clave temporal para continuar.
          </p>
          {pendingAccess?.user?.email && (
            <p className="text-xs text-[color:var(--text-muted)] mb-3">
              Usuario: {pendingAccess.user.email}
            </p>
          )}
          <form className="grid gap-3" onSubmit={handlePasswordChange}>
            <input
              className="border rounded-lg p-2"
              placeholder="Nueva contrasena"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
            <input
              className="border rounded-lg p-2"
              placeholder="Confirmar contrasena"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
            <div className="grid gap-1 text-xs text-[color:var(--text-muted)]">
              <div className="flex items-center gap-2">
                <div className="h-2 flex-1 rounded-full bg-[color:var(--border)] overflow-hidden">
                  <div
                    className="h-full transition-all"
                    style={{
                      width: `${newPasswordCheck.percent}%`,
                      backgroundColor:
                        newPasswordCheck.score <= 2
                          ? 'var(--danger)'
                          : newPasswordCheck.score === 3
                            ? '#f59e0b'
                            : 'var(--success)',
                    }}
                  />
                </div>
                <span className="min-w-[48px] text-right">
                  {newPasswordCheck.label}
                </span>
              </div>
              <div>
                Requiere: 6+ caracteres, mayuscula, minuscula, numero y simbolo.
              </div>
            </div>
            {passwordChangeError && (
              <div className="mt-1 bg-[color:var(--danger)]/15 text-[color:var(--danger)] border border-[color:var(--danger)]/30 rounded-md px-3 py-2 text-sm shadow-sm">
                {passwordChangeError}
              </div>
            )}
            <button
              className="px-3 py-2 rounded-xl border bg-[color:var(--primary)] text-[color:var(--primary-contrast)] transition active:scale-[0.98] active:brightness-95 disabled:opacity-60 disabled:cursor-not-allowed"
              disabled={passwordChangeBusy || !newPasswordCheck.isStrong}
            >
              {passwordChangeBusy ? 'Actualizando...' : 'Guardar y continuar'}
            </button>
            <button
              type="button"
              className="text-xs text-[color:var(--text-muted)] text-left"
              onClick={async () => {
                try {
                  await signOut(auth);
                } catch (err) {
                  console.error('Error cerrando sesion:', err);
                }
                setPendingAccess(null);
                setPhase('auth');
              }}
            >
              Cerrar sesion
            </button>
          </form>
        </Card>
      </div>
    );

  if (phase === 'auth')
    return (
      <div className="max-w-6xl mx-auto flex flex-col gap-8 py-8 px-4">
        <div className="flex flex-col items-center text-center">
          <div className="flex items-center justify-center gap-4 mb-4">
            <img
              src="/logo-finanzas-en-familia.png"
              alt="Finanzas en Familia"
              className="h-20 md:h-24 w-auto object-contain"
              decoding="async"
            />
            <div
              style={{
                fontFamily:
                  'Inter, Roboto, ui-sans-serif, system-ui, sans-serif',
              }}
              className="text-left"
            >
              <h1 className="text-3xl md:text-4xl leading-tight text-[color:var(--primary)] font-semibold">
                <span className="block">Finanzas</span>
                <span className="block">en Familia</span>
              </h1>
            </div>
          </div>
          <p className="text-base md:text-lg text-[color:var(--text-muted)]">
            Tu panel de control financiero familiar
          </p>
        </div>

        <div className={`grid gap-8 items-start ${isInviteMode ? '' : 'md:grid-cols-2'}`}>
          <Card className="w-full max-w-xl mx-auto md:max-w-none p-6">
            <h2 className="text-lg font-semibold text-[color:var(--text)] mb-4">
              {authTitle}
            </h2>
            {inviteFrom && isInviteMode && (
              <div className="mb-3 rounded-lg border px-3 py-2 text-sm text-[color:var(--text-muted)]">
                Tienes una invitacion al presupuesto de{' '}
                <span className="font-semibold">{inviteFrom}</span>.
              </div>
            )}
            <form
              onSubmit={(e) => {
                if (isResettingPassword) {
                  e.preventDefault();
                  handleResetPassword();
                  return;
                }
                handleLogin(e);
              }}
              className="grid gap-3"
              autoComplete="on"
            >
              <input
                className="border rounded-lg p-2"
                placeholder="Correo (usuario@finanzasenfamilia.com)"
                type="email"
                name="username"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              {!isResettingPassword && (
                <>
                  <input
                    className="border rounded-lg p-2"
                    placeholder="Contrasena"
                    type="password"
                    name="password"
                    autoComplete={
                      isRegister ? 'new-password' : 'current-password'
                    }
                    value={pass}
                    onChange={(e) => setPass(e.target.value)}
                    required
                  />
                  {isRegister && (
                    <div className="grid gap-1 text-xs text-[color:var(--text-muted)]">
                      <div className="flex items-center gap-2">
                        <div className="h-2 flex-1 rounded-full bg-[color:var(--border)] overflow-hidden">
                          <div
                            className="h-full transition-all"
                            style={{
                              width: `${passwordCheck.percent}%`,
                              backgroundColor:
                                passwordCheck.score <= 2
                                  ? 'var(--danger)'
                                  : passwordCheck.score === 3
                                    ? '#f59e0b'
                                    : 'var(--success)',
                            }}
                          />
                        </div>
                        <span className="min-w-[48px] text-right">
                          {passwordCheck.label}
                        </span>
                      </div>
                      <div>
                        Requiere: 6+ caracteres, mayuscula, minuscula, numero y
                        simbolo.
                      </div>
                    </div>
            )}
                </>
              )}
              <button
                className="px-3 py-2 rounded-xl border bg-[color:var(--primary)] text-[color:var(--primary-contrast)] transition active:scale-[0.98] active:brightness-95 disabled:opacity-60 disabled:cursor-not-allowed"
                disabled={(isRegister || isInviteMode) && !passwordCheck.isStrong}
              >
                {submitLabel}
              </button>
              {(isInviteMode || inviteDebugInfo) && (
                <button
                  type="button"
                  className="text-xs text-[color:var(--primary)] text-left"
                  onClick={openInviteDebug}
                >
                  Revisar ID de invitación y token
                </button>
              )}

              {tip && (
                <div className="mt-2 bg-[color:var(--danger)]/15 text-[color:var(--danger)] border border-[color:var(--danger)]/30 rounded-md px-3 py-2 text-sm shadow-sm">
                  {tip}
                </div>
            )}
            {showInviteLinkHint && (
              <div className="mt-2 rounded-md border px-3 py-2 text-xs">
                <div className="font-semibold mb-1">Link usado</div>
                <div className="break-all">{inviteDebugInfo.url}</div>
                <button
                  type="button"
                  className="mt-2 text-xs text-[color:var(--primary)]"
                  onClick={openInviteDebug}
                >
                  Ver detalle
                </button>
              </div>
            )}
            </form>

            {!isInviteMode && (
              <div className="mt-3 flex flex-col gap-1 text-sm">
                {!isRegister && !isResettingPassword && (
                  <button
                    type="button"
                    className="text-[color:var(--primary)] text-left"
                    onClick={() => {
                      setIsResettingPassword(true);
                      setIsRegister(false);
                      setPass('');
                      setTip('');
                      setResetMsg('');
                      setResetError('');
                    }}
                  >
                    Olvidaste tu contrasena?
                  </button>
                )}
                {!isRegister && isResettingPassword && (
                  <button
                    type="button"
                    className="text-[color:var(--primary)] text-left"
                    onClick={() => {
                      setIsResettingPassword(false);
                      setResetMsg('');
                      setResetError('');
                    }}
                  >
                    Volver a iniciar sesion
                  </button>
                )}

                {isResettingPassword && resetMsg && (
                  <div className="text-xs text-[color:var(--success)]">
                    {resetMsg}
                  </div>
                )}
                {isResettingPassword && resetError && (
                  <div className="text-xs text-[color:var(--danger)]">
                    {resetError}
                  </div>
                )}
              </div>
            )}

            {!isInviteMode && (
              <button
                className="text-sm mt-4"
                onClick={() => {
                  setIsRegister(!isRegister);
                  setIsResettingPassword(false);
                  setResetMsg('');
                  setResetError('');
                  setTip('');
                }}
              >
                {isRegister
                  ? 'Ya tienes cuenta? Inicia sesion'
                  : 'No tienes cuenta? Registrate'}
              </button>
            )}
          </Card>

          {!isInviteMode && (
            <Card className="bg-[color:var(--surface-1)] border border-[color:var(--border)] shadow-[var(--shadow)]">
            <h3 className="text-xl font-semibold mb-2 text-[color:var(--text)]">
              Lo que puedes hacer con Finanzas en Familia
            </h3>
            <p className="text-sm text-[color:var(--text-muted)] mb-4 leading-snug">
              Controla los gastos de tu hogar sin planillas ni enredos. Finanzas
              en Familia es una app de presupuesto familiar que te ayuda a
              ordenar ingresos, gastos, deudas y ahorros en un solo lugar, de
              forma simple y compartida.
            </p>
            <div className="space-y-3 text-sm text-[color:var(--text)]">
              {[
                [
                  'Presupuesto familiar por categorías',
                  'Define montos mensuales por gasto y revisa el avance real según el periodo que tú elijas.',
                ],
                [
                  'Registro claro de gastos e ingresos',
                  'Centraliza todos los movimientos del hogar, edítalos cuando sea necesario y mantén tus números siempre claros.',
                ],
                [
                  'Control de deudas y ahorro planificado',
                  'Organiza cuotas, pagos pendientes y metas de ahorro con un seguimiento simple y ordenado.',
                ],
                [
                  'Finanzas compartidas con tu familia',
                  'Accede desde distintos dispositivos y mantén a todos al día con la situación financiera del hogar.',
                ],
                [
                  'Decisiones financieras con información real',
                  'Reduce el desorden, evita discusiones y toma mejores decisiones con una visión clara del dinero familiar.',
                ],
              ].map(([title, description]) => (
                <div key={title} className="flex gap-3">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[color:var(--primary)]/15 text-[color:var(--primary)] text-xs font-semibold">
                    ?
                  </span>
                  <div>
                    <p className="font-semibold text-[color:var(--text)]">
                      {title}
                    </p>
                    <p className="text-[color:var(--text-muted)]">
                      {description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
          )}
        </div>

        {showInviteDebug && inviteDebugInfo && (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4">
            <div className="bg-[color:var(--surface-1)] rounded-2xl shadow-[var(--shadow)] p-6 w-full max-w-md">
              <h3 className="text-lg font-semibold mb-2">
                Debug de invitacion (temporal)
              </h3>
              <div className="grid gap-2 text-xs">
                <div className="rounded-lg border px-3 py-2">
                  <div className="font-semibold mb-1">Link completo</div>
                  <div className="break-all">{inviteDebugInfo.url}</div>
                </div>
                <div className="rounded-lg border px-3 py-2">
                  <div className="font-semibold mb-1">Datos del enlace</div>
                  <div className="break-all">
                    ID de invitación: {inviteDebugInfo.inviteId || '-'}
                  </div>
                  <div className="break-all">
                    Token: {inviteDebugInfo.token || '-'}
                  </div>
                  <div className="break-all">
                    Hogar: {inviteDebugInfo.householdId || '-'}
                  </div>
                  <div className="break-all">
                    Invitado por: {inviteDebugInfo.invitedBy || '-'}
                  </div>
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  className="px-3 py-1.5 text-sm border rounded-lg"
                  onClick={() => {
                    setShowInviteDebug(false);
                  }}
                >
                  Cerrar
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );

  return null;
}




































