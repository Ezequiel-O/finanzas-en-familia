// src/modules/settings/Settings.jsx
import React, { useState, useEffect } from 'react';

import { Card } from '../../components/ui/card.jsx';
import { SectionTitle } from '../../components/ui/SectionTitle.jsx';
import { CATEGORIES } from '../../constants.js';

export function Settings({
  data,
  householdId,
  user,
  categories,
  actions,
  activeHouseholdUser,
}) {
  const [newCategory, setNewCategory] = useState('');
  const [showUserModal, setShowUserModal] = useState(false);
  const [userForm, setUserForm] = useState({
    id: null,
    name: '',
    pin: '',
    isSuperAdmin: false,
    adminPin: '',
  });

  const cats = categories && categories.length ? categories : CATEGORIES;
  const users = Array.isArray(data.householdUsers) ? data.householdUsers : [];

  // Solo es super admin si el usuario de la casa seleccionado tiene isSuperAdmin = true
  const isSuperAdmin = !!activeHouseholdUser?.isSuperAdmin;

  const superAdminUser = users.find((u) => u.isSuperAdmin) || null;
  const familyUsers = users.filter((u) => !u.isSuperAdmin);

  function displayName(u) {
    if (u.name && u.name.trim()) return u.name.trim();
    if (u.isSuperAdmin && data.superAdminEmail) return data.superAdminEmail;
    return u.isSuperAdmin ? 'Administrador' : 'Usuario';
  }

  function startCreateUser() {
    setUserForm({
      id: null,
      name: '',
      pin: '',
      isSuperAdmin: false,
      adminPin: '',
    });
    setShowUserModal(true);
  }

  function startEditUser(u) {
    setUserForm({
      id: u.id,
      name: u.name || '',
      pin: u.pin || '',
      isSuperAdmin: !!u.isSuperAdmin,
      adminPin: '',
    });
    setShowUserModal(true);
  }

  async function handleSaveUser(e) {
    e.preventDefault();
    const trimmedName = userForm.name.trim();
    const pin = (userForm.pin || '').trim();

    if (!trimmedName && !userForm.isSuperAdmin) return;

    const currentSuper = superAdminUser;
    const hasFamily = familyUsers.length > 0;

    if (userForm.isSuperAdmin) {
      if (!currentSuper) {
        alert(
          'No se encontró al administrador del hogar. Revisa tus datos en Firestore.',
        );
        return;
      }

      if (hasFamily && !pin) {
        alert(
          'Hay usuarios familiares configurados. El administrador debe tener un PIN y no puede dejarlo en blanco.',
        );
        return;
      }

      await actions.updateHouseholdUser(userForm.id, {
        name: trimmedName,
        pin,
      });

      setShowUserModal(false);
      setUserForm({
        id: null,
        name: '',
        pin: '',
        isSuperAdmin: false,
        adminPin: '',
      });

      return;
    }

    const isNew = !userForm.id;

    if (!currentSuper) {
      alert(
        'No se puede crear un usuario familiar porque no existe un administrador definido.',
      );
      return;
    }

    if (isNew && !currentSuper.pin) {
      alert(
        'Antes de crear el primer usuario familiar debes definir un PIN para el administrador.',
      );
      setShowUserModal(false);
      setTimeout(() => {
        setUserForm({
          id: currentSuper.id,
          name: currentSuper.name || '',
          pin: '',
          isSuperAdmin: true,
          adminPin: '',
        });
        setShowUserModal(true);
      }, 0);
      return;
    }

    if (isNew) {
      const adminPinInput = (userForm.adminPin || '').trim();

      if (!adminPinInput) {
        alert(
          'Debes ingresar el PIN del administrador para crear un usuario familiar.',
        );
        return;
      }

      if (adminPinInput !== currentSuper.pin) {
        alert('PIN de administrador incorrecto. No se creó el usuario.');
        return;
      }

      await actions.addHouseholdUser({
        name: trimmedName,
        pin,
        isSuperAdmin: false,
      });
    } else {
      await actions.updateHouseholdUser(userForm.id, {
        name: trimmedName,
        pin,
      });
    }

    setShowUserModal(false);
    setUserForm({
      id: null,
      name: '',
      pin: '',
      isSuperAdmin: false,
      adminPin: '',
    });
  }

  // --- Preferencias personales por usuario de la casa ---
  const [prefs, setPrefs] = useState(() => {
    const base = activeHouseholdUser?.preferences || {};
    return {
      defaultTab: base.defaultTab || 'dashboard',
      showOnlyMyMovements: !!base.showOnlyMyMovements,
      dashboardCards: {
        resumenMes: base.dashboardCards?.resumenMes ?? true,
        deudas: base.dashboardCards?.deudas ?? true,
        ahorro: base.dashboardCards?.ahorro ?? true,
        inversiones: base.dashboardCards?.inversiones ?? false, // por si en el futuro reactivas inversiones
        presupuestos: base.dashboardCards?.presupuestos ?? true,
      },
      transactionsDefaults: {
        type: base.transactionsDefaults?.type || 'gasto',
        defaultCategory:
          base.transactionsDefaults?.defaultCategory ||
          cats[0] ||
          CATEGORIES[0],
      },
      ui: {
        theme: base.ui?.theme || 'light',
        density: base.ui?.density || 'normal',
      },
    };
  });

  useEffect(() => {
    const base = activeHouseholdUser?.preferences || {};
    setPrefs({
      defaultTab: base.defaultTab || 'dashboard',
      showOnlyMyMovements: !!base.showOnlyMyMovements,
      dashboardCards: {
        resumenMes: base.dashboardCards?.resumenMes ?? true,
        deudas: base.dashboardCards?.deudas ?? true,
        ahorro: base.dashboardCards?.ahorro ?? true,
        inversiones: base.dashboardCards?.inversiones ?? false,
        presupuestos: base.dashboardCards?.presupuestos ?? true,
      },
      transactionsDefaults: {
        type: base.transactionsDefaults?.type || 'gasto',
        defaultCategory:
          base.transactionsDefaults?.defaultCategory ||
          cats[0] ||
          CATEGORIES[0],
      },
      ui: {
        theme: base.ui?.theme || 'light',
        density: base.ui?.density || 'normal',
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHouseholdUser?.id, cats.join('|')]);

  async function handleSavePreferences(e) {
    e.preventDefault();
    if (!activeHouseholdUser) return;
    await actions.updateHouseholdUser(activeHouseholdUser.id, {
      preferences: prefs,
    });
    alert('Preferencias guardadas.');
  }

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        {/* Columna izquierda: sólo super admin ve Usuarios y Día de corte */}
        <div className="space-y-4">
          {isSuperAdmin && (
            <Card>
              <SectionTitle
                right={
                  isSuperAdmin && (
                    <button
                      className="px-3 py-1.5 rounded-full border text-sm"
                      onClick={startCreateUser}
                    >
                      + Agregar
                    </button>
                  )
                }
              >
                Usuarios de la casa
              </SectionTitle>

              {users.length === 0 && (
                <div className="text-sm text-gray-600">
                  Aún no hay usuarios configurados. Usa “Agregar” para crear los
                  integrantes de la casa.
                </div>
              )}

              {users.length > 0 && (
                <ul className="mt-3 space-y-2 text-sm">
                  {users.map((u) => (
                    <li
                      key={u.id}
                      className="flex items-center justify-between border rounded-lg px-3 py-2"
                    >
                      <div>
                        <div className="font-medium">
                          {displayName(u)}{' '}
                          {u.isSuperAdmin && (
                            <span className="text-xs text-gray-500">
                              (Admin)
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500">
                          {u.isSuperAdmin && data.superAdminEmail && (
                            <span className="block">
                              Correo: {data.superAdminEmail}
                            </span>
                          )}
                          PIN:{' '}
                          {u.pin
                            ? '••••'
                            : u.isSuperAdmin
                            ? 'Sin PIN (debes configurarlo si hay familiares)'
                            : 'Sin PIN (entra solo seleccionando el usuario)'}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="text-xs text-blue-600"
                          onClick={() => startEditUser(u)}
                        >
                          Editar
                        </button>
                        {!u.isSuperAdmin && (
                          <button
                            type="button"
                            className="text-xs text-red-600"
                            onClick={async () => {
                              const ok = window.confirm(
                                `¿Eliminar al usuario "${displayName(u)}"?`,
                              );
                              if (!ok) return;
                              await actions.removeHouseholdUser(u.id);
                            }}
                          >
                            Eliminar
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          {isSuperAdmin && (
            <Card>
              <SectionTitle>Día de corte del mes</SectionTitle>
              <form
                className="grid gap-3"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const formData = new FormData(e.currentTarget);
                  const day = formData.get('cut-day') || data.budgetCutDay || 1;
                  await actions.setBudgetCutDay(day);
                  alert('Día de corte actualizado.');
                }}
              >
                <div className="grid gap-1">
                  <label className="text-sm">
                    Día (1 al 28 recomendado por meses cortos)
                  </label>
                  <input
                    type="number"
                    name="cut-day"
                    min={1}
                    max={28}
                    defaultValue={data.budgetCutDay || 1}
                    className="border rounded-lg p-2 w-32"
                  />
                  <p className="text-xs text-gray-500">
                    El presupuesto se calculará desde ese día de un mes hasta el
                    día anterior del mes siguiente.
                  </p>
                </div>
                <button className="px-3 py-2 rounded-xl border bg-gray-900 text-white text-sm">
                  Guardar día de corte
                </button>
              </form>
            </Card>
          )}

          <Card>
            <SectionTitle>Preferencias personales</SectionTitle>
            {!activeHouseholdUser && (
              <p className="text-sm text-gray-600">
                Primero selecciona quién está usando la app para configurar sus
                preferencias.
              </p>
            )}

            {activeHouseholdUser && (
              <form
                className="grid gap-3 mt-2"
                onSubmit={handleSavePreferences}
                autoComplete="off"
              >
                <div className="grid gap-1">
                  <label className="text-sm">Configurando a</label>
                  <div className="border rounded-lg p-2 bg-gray-50 dark:bg-gray-900 text-sm">
                    {displayName(activeHouseholdUser)}
                  </div>
                </div>

                <div className="border rounded-xl p-3">
                  <div className="font-medium text-sm mb-2">
                    Valores por defecto al crear movimiento
                  </div>
                  <div className="grid gap-2 text-sm">
                    <div className="grid gap-1">
                      <label>Tipo por defecto</label>
                      <select
                        className="border rounded-lg p-2"
                        value={prefs.transactionsDefaults.type}
                        onChange={(e) =>
                          setPrefs((prev) => ({
                            ...prev,
                            transactionsDefaults: {
                              ...prev.transactionsDefaults,
                              type: e.target.value,
                            },
                          }))
                        }
                      >
                        <option value="gasto">Gasto</option>
                        <option value="ingreso">Ingreso</option>
                      </select>
                    </div>
                    <div className="grid gap-1">
                      <label>Categoría por defecto (para gasto)</label>
                      <select
                        className="border rounded-lg p-2"
                        value={prefs.transactionsDefaults.defaultCategory}
                        onChange={(e) =>
                          setPrefs((prev) => ({
                            ...prev,
                            transactionsDefaults: {
                              ...prev.transactionsDefaults,
                              defaultCategory: e.target.value,
                            },
                          }))
                        }
                      >
                        {cats.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                <div className="border rounded-xl p-3">
                  <div className="font-medium text-sm mb-2">
                    Vista y filtros
                  </div>
                  <div className="grid gap-2 text-sm">
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="rounded border-gray-300"
                        checked={prefs.showOnlyMyMovements}
                        onChange={(e) =>
                          setPrefs((prev) => ({
                            ...prev,
                            showOnlyMyMovements: e.target.checked,
                          }))
                        }
                      />
                      <span>
                        Mostrar solo mis movimientos en la vista Movimientos
                      </span>
                    </label>
                  </div>
                </div>

                <div className="border rounded-xl p-3">
                  <div className="font-medium text-sm mb-2">Aspecto</div>
                  <div className="grid gap-2 text-sm">
                    <div className="grid gap-1">
                      <label>Tema</label>
                      <select
                        className="border rounded-lg p-2"
                        value={prefs.ui.theme}
                        onChange={(e) =>
                          setPrefs((prev) => ({
                            ...prev,
                            ui: { ...prev.ui, theme: e.target.value },
                          }))
                        }
                      >
                        <option value="light">Claro</option>
                        <option value="dark">Oscuro</option>
                      </select>
                    </div>
                    <div className="grid gap-1">
                      <label>Densidad</label>
                      <select
                        className="border rounded-lg p-2"
                        value={prefs.ui.density}
                        onChange={(e) =>
                          setPrefs((prev) => ({
                            ...prev,
                            ui: { ...prev.ui, density: e.target.value },
                          }))
                        }
                      >
                        <option value="normal">Normal</option>
                        <option value="compact">Compacta (más filas)</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end gap-2 mt-2">
                  <button
                    type="submit"
                    className="px-3 py-1.5 text-sm border rounded-lg bg-gray-900 text-white"
                  >
                    Guardar preferencias
                  </button>
                </div>
              </form>
            )}
          </Card>
        </div>

        {/* Columna derecha: categorías (visible para todos) */}
        <Card>
          <SectionTitle>Categorías</SectionTitle>

          <form
            className="flex gap-2 mt-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const name = newCategory.trim();
              if (!name) return;
              await actions.addCategory(name);
              setNewCategory('');
            }}
          >
            <input
              className="border rounded-lg p-2 flex-1"
              placeholder="Nueva categoría (ej. Mascotas)"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
            />
            <button
              type="submit"
              className="px-3 py-2 rounded-xl border bg-gray-900 text-white text-sm"
            >
              Agregar
            </button>
          </form>

          <ul className="list-disc pl-6 mt-4 text-sm space-y-2">
            {cats.map((c) => (
              <li key={c} className="flex items-center justify-between gap-2">
                <span>{c}</span>
                <div className="flex flex-col gap-1 sm:flex-row">
                  <button
                    type="button"
                    className="text-xs text-blue-600"
                    onClick={async () => {
                      const nuevo = window.prompt(
                        `Nuevo nombre para la categoría "${c}"`,
                        c,
                      );
                      if (!nuevo) return;
                      await actions.renameCategory(c, nuevo);
                    }}
                  >
                    Renombrar
                  </button>
                  <button
                    type="button"
                    className="text-xs text-red-600"
                    onClick={async () => {
                      const ok = window.confirm(
                        `¿Eliminar la categoría "${c}"? Los presupuestos de esa categoría se perderán.`,
                      );
                      if (!ok) return;
                      await actions.removeCategory(c);
                    }}
                  >
                    Eliminar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {/* Modal flotante para crear/editar usuario */}
      {isSuperAdmin && showUserModal && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40">
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold mb-3">
              {userForm.isSuperAdmin
                ? 'Editar administrador'
                : userForm.id
                ? 'Editar usuario'
                : 'Nuevo usuario'}
            </h3>
            <form
              className="grid gap-3"
              onSubmit={handleSaveUser}
              autoComplete="off"
            >
              {userForm.isSuperAdmin && (
                <div className="grid gap-1">
                  <label className="text-sm">Correo (no editable)</label>
                  <input
                    className="border rounded-lg p-2 bg-gray-100 dark:bg-gray-900 text-gray-600"
                    value={data.superAdminEmail || ''}
                    readOnly
                  />
                </div>
              )}

              <div className="grid gap-1">
                <label className="text-sm">
                  {userForm.isSuperAdmin ? 'Nombre (opcional)' : 'Nombre'}
                </label>
                <input
                  className="border rounded-lg p-2"
                  value={userForm.name}
                  onChange={(e) =>
                    setUserForm((prev) => ({
                      ...prev,
                      name: e.target.value,
                    }))
                  }
                  required={!userForm.isSuperAdmin}
                />
              </div>

              <div className="grid gap-1">
                <label className="text-sm">
                  PIN{' '}
                  {userForm.isSuperAdmin &&
                    familyUsers.length > 0 &&
                    '(obligatorio)'}
                </label>
                <input
                  className="border rounded-lg p-2"
                  type="text"
                  inputMode="numeric"
                  pattern="\d*"
                  name="household-pin"
                  autoComplete="off"
                  data-lpignore="true"
                  data-form-type="other"
                  style={{ WebkitTextSecurity: 'disc' }}
                  value={userForm.pin}
                  onChange={(e) =>
                    setUserForm((prev) => ({
                      ...prev,
                      pin: e.target.value,
                    }))
                  }
                />

                <p className="text-xs text-gray-500">
                  {userForm.isSuperAdmin
                    ? 'El PIN del administrador se usará para autorizar la creación de usuarios familiares y para bloquear el acceso si no se elige editor.'
                    : 'PIN opcional para este usuario. Si tiene PIN, se pedirá al entrar como este usuario.'}
                </p>
              </div>

              {!userForm.isSuperAdmin &&
                !userForm.id &&
                superAdminUser &&
                superAdminUser.pin && (
                  <div className="grid gap-1">
                    <label className="text-sm">
                      PIN del administrador (para autorizar)
                    </label>
                    <input
                      className="border rounded-lg p-2"
                      type="text"
                      inputMode="numeric"
                      pattern="\d*"
                      name="admin-authorization-pin"
                      autoComplete="off"
                      data-lpignore="true"
                      data-form-type="other"
                      style={{ WebkitTextSecurity: 'disc' }}
                      value={userForm.adminPin}
                      onChange={(e) =>
                        setUserForm((prev) => ({
                          ...prev,
                          adminPin: e.target.value,
                        }))
                      }
                      required
                    />

                    <p className="text-xs text-gray-500">
                      Escribe el PIN del administrador del hogar para confirmar
                      la creación de este usuario familiar.
                    </p>
                  </div>
                )}

              <div className="flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  className="px-3 py-1.5 text-sm border rounded-lg"
                  onClick={() => setShowUserModal(false)}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-3 py-1.5 text-sm border rounded-lg bg-gray-900 text-white"
                >
                  Guardar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
