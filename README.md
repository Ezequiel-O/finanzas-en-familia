# Finanzas en Familia

App web (instalable en el celular) para que un hogar maneje su plata en conjunto:
registro de gastos e ingresos, plan del mes con presupuesto por categoría, cuotas
de deudas y metas de ahorro. Montos en pesos chilenos.

## Pestañas

| Pestaña | Para qué sirve |
|---|---|
| **Inicio** | Resumen del periodo y lo que vence esta semana, con pago en un toque. |
| **Movimientos** | Registro completo de gastos e ingresos, filtros, exportar/importar Excel. |
| **Plan del mes** | Cuánto te queda por día, semáforo por categoría, compromisos del mes (cuotas y aportes) y presupuesto por categoría. |
| **Compromisos** | Deudas y metas de ahorro: cuota N de M, fecha de término, avance y aporte sugerido. |
| **Ajustes** | Miembros del hogar, categorías, día de corte, preferencias. |

El botón **+** (abajo al centro en el celular, arriba en escritorio) abre el registro
rápido: monto, categoría y listo. También entiende frases como “súper 15 lucas” o
“bencina 30 mil ayer”.

## Desarrollo

```bash
npm install
# Crea .env.local con: VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN,
#   VITE_FIREBASE_PROJECT_ID, VITE_FIREBASE_STORAGE_BUCKET,
#   VITE_FIREBASE_MESSAGING_SENDER_ID, VITE_FIREBASE_APP_ID
npm run dev                  # servidor local
npm test                     # tests de la capa de dominio (Vitest)
npm run lint
npm run build
```

Requiere Node 22.

### Importar avisos de BancoEstado desde Gmail

En **Movimientos → Gmail**, la app puede buscar los 100 avisos más recientes de
`notificaciones@correo.bancoestado.cl` y `noreply@correo.bancoestado.cl`. El
elige qué avisos enviar a Firebase AI Logic (Gemini Developer API) para extraer
monto, fecha, tipo y descripción. Nombres, RUT, correos y números de cuenta
detectables se ocultan localmente antes del envío. Revisa cada propuesta y confirma antes
de guardarla. No se conservan cuerpos de correo ni tokens; el ID de Gmail se
guarda únicamente para evitar duplicados.

Para habilitarlo:

1. En Firebase Console → AI Services → AI Logic, configura Gemini Developer API.
   El SDK `firebase` ya está instalado; no hace falta volver a instalarlo ni
   copiar una clave de Gemini al frontend.
2. Registra la app web en Firebase App Check con el proveedor reCAPTCHA
   Enterprise (Fraud Defense) y configura los dominios autorizados. Agrega su
   clave de sitio pública a `.env.local` como
   `VITE_FIREBASE_APP_CHECK_SITE_KEY=...`.
3. En Google Cloud Console, habilita Gmail API y crea un cliente OAuth de tipo
   **Aplicación web**. Agrega los orígenes autorizados de desarrollo y producción.
4. Configura la pantalla de consentimiento y agrega el alcance
   `https://www.googleapis.com/auth/gmail.readonly`.
5. Agrega el ID del cliente a `.env.local` como
   `VITE_GOOGLE_OAUTH_CLIENT_ID=...` y reinicia Vite.
6. Reconstruye y publica la app para aplicar las variables y Content Security
   Policy de `firebase.json`.

El botón flotante con el logo abre el asistente Gemini. Las consultas de texto
reciben contexto agregado del periodo y presupuestos cargados, sin nombres ni
descripciones individuales. Para crear/editar/eliminar movimientos y asignar
presupuestos se conserva el parser de acciones existente y siempre se muestra
una confirmación antes de escribir en Firestore.

Google solicita permiso de lectura del buzón, aunque esta función consulta solo
los dos remitentes anteriores. No se guardan tokens ni cuerpos de correo. Google
puede exigir verificación OAuth para publicar la aplicación con ese alcance.
Gemini procesa únicamente los avisos que selecciones; si no puede extraer los
campos o no coinciden con el monto y fecha explícitos del correo, no propone el
movimiento. Las compras con tarjeta de crédito se excluyen por el criterio de
base caja de la app. La consulta se limita a los 100 avisos más recientes.

## Estructura

```
src/
  domain/        Reglas de negocio puras y testeadas (fechas locales, montos,
                 semáforo de presupuesto, compromisos, validación con zod).
  features/      Funcionalidades nuevas: registro rápido, plan del mes, compromisos.
  modules/       Pantallas por pestaña (Movimientos, Presupuestos, Deudas, Ahorro, …).
  hooks/         useHouseholdData: suscripciones y escrituras a Firestore.
  components/    UI compartida, avisos (toasts / confirmación) y navegación.
  navigation/    Pestañas sincronizadas con la URL (#inicio, #plan, …).
functions/       Cloud Functions (invitaciones, inactividad, correos).
scripts/         Migraciones con firebase-admin (dry-run por defecto).
```

### Criterio contable (base caja)

Un gasto se registra **cuando sale la plata**. Toda la app usa un solo libro
(`src/domain/ledger.js`):

```
saldo actual = saldo anterior + ingresos + reembolsos + retiros de ahorro
               − consumo − suscripciones − cuotas de deudas − aportes a ahorro
               ± ajustes de conciliación
```

| Movimiento | Cómo se cuenta |
|---|---|
| Compra con tarjeta de crédito | **No se registra.** El gasto es la cuota cuando se paga (Deudas). |
| Aporte a una meta | Sale del saldo, pero no es consumo. |
| Retiro de una meta | Vuelve al saldo y baja la meta; no es ingreso. |
| Reembolso | Descuenta el gasto de su categoría; no es ingreso. |
| Traspaso entre miembros | No cambia el saldo del hogar. |
| Ajuste de conciliación | Corrige el saldo; no es ingreso ni gasto. |
| Suscripción | Gasto fijo; no cuenta en la carga financiera. |

Un periodo **cerrado y conciliado** (Plan del mes → Cierre del periodo) no admite
cambios hasta que el dueño lo reabra. Cada creación, edición o borrado queda en
`auditLog`, que nadie puede modificar.

### Regla de precisión

Lo pagado en una deuda y lo ahorrado en una meta **se calcula siempre desde los
movimientos vinculados** (`meta.debtId` + `meta.debtQuotaIds`, `meta.savingId`).
Los campos guardados `remaining` y `schedule[].paidAmount` son copias históricas y
no se usan para totales. Las categorías del sistema *Deudas* y *Ahorro* no se
pueden renombrar ni borrar porque sostienen esos vínculos.

## Migraciones

```bash
# Ver qué cambiaría (no escribe nada)
npm run migrate:link-commitments -- --service-account=ruta/credencial.json
# Aplicar (haz un respaldo de Firestore antes)
npm run migrate:link-commitments -- --service-account=ruta/credencial.json --apply
```

## Despliegue

```bash
npm run build
firebase deploy --only hosting,firestore:rules
```

`firebase.json` define los headers de seguridad (CSP, HSTS, `X-Frame-Options`,
`nosniff`) y `public/sw.js` el service worker para uso sin conexión.
