// Deja un hogar "desde cero": borra sus registros financieros en Firestore.
//
// - Exige --household=<id>; nunca borra todos los hogares.
// - Sin --apply solo cuenta lo que borraría (dry-run).
// - Con --apply, ANTES de borrar guarda un respaldo JSON en backups/ (fuera de git).
//
// Alcance (--scope):
//   finanzas (por defecto)  movimientos, presupuestos, deudas, metas de ahorro y papelera.
//                           Conserva el hogar, sus miembros, invitaciones, categorías y día de corte.
//   todo                    lo anterior + configuración del hogar (categorías, día de corte).
//                           El hogar y sus miembros se conservan igual.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { applicationDefault, cert, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const args = process.argv.slice(2);
const getArg = (name) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
};

const SCOPES = {
  finanzas: ['transactions', 'budgets', 'debts', 'savings', 'trash'],
  todo: ['transactions', 'budgets', 'debts', 'savings', 'trash', 'meta'],
};

const householdId = getArg('--household');
const scope = getArg('--scope') || 'finanzas';
const apply = args.includes('--apply');

if (args.includes('--help') || !householdId || !SCOPES[scope] || !/^[A-Za-z0-9_-]{1,64}$/.test(householdId)) {
  console.log(
    [
      'Uso:',
      '  node scripts/reset-household.mjs --household=<id> [--scope=finanzas|todo] [--apply]',
      '    [--service-account=ruta.json] [--project-id=id]',
      '',
      'Sin --apply solo muestra cuántos documentos se borrarían.',
    ].join('\n'),
  );
  process.exit(householdId ? 0 : 1);
}

const serviceAccountPath = getArg('--service-account');
const serviceAccount = serviceAccountPath ? JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8')) : null;
initializeApp({
  credential: serviceAccount ? cert(serviceAccount) : applicationDefault(),
  projectId: getArg('--project-id') || serviceAccount?.project_id,
});
const db = getFirestore();

const householdRef = db.collection('households').doc(householdId);
const householdSnap = await householdRef.get();
if (!householdSnap.exists) {
  console.error(`No existe el hogar "${householdId}". No se borró nada.`);
  process.exit(1);
}
const hh = householdSnap.data() || {};
console.log(`Hogar: ${hh.name || householdId} · miembros: ${(hh.members || []).length}`);
console.log(`Alcance: ${scope} -> ${SCOPES[scope].join(', ')}\n`);

const snapshots = {};
let total = 0;
for (const col of SCOPES[scope]) {
  const snap = await householdRef.collection(col).get();
  snapshots[col] = snap;
  total += snap.size;
  console.log(`  ${col.padEnd(13)} ${snap.size} documentos`);
}
console.log(`\nTotal: ${total} documentos.`);

if (!apply) {
  console.log('\nDry-run: no se borró nada. Agrega --apply para borrar (se guardará un respaldo antes).');
  process.exit(0);
}
if (total === 0) {
  console.log('Nada que borrar.');
  process.exit(0);
}

// Respaldo local antes de borrar (contiene datos financieros: no subir a git ni compartir).
const backupDir = path.resolve('backups');
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDir, `${householdId}-${stamp}.json`);
const backup = { householdId, scope, createdAt: new Date().toISOString(), collections: {} };
for (const [col, snap] of Object.entries(snapshots)) {
  backup.collections[col] = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}
fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), { mode: 0o600 });
console.log(`\nRespaldo guardado en ${backupPath}`);

const BATCH_LIMIT = 400;
let deleted = 0;
for (const [col, snap] of Object.entries(snapshots)) {
  for (let i = 0; i < snap.docs.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    snap.docs.slice(i, i + BATCH_LIMIT).forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += Math.min(BATCH_LIMIT, snap.docs.length - i);
  }
  console.log(`  ${col}: borrados ${snap.size}`);
}
console.log(`\nListo: ${deleted} documentos borrados del hogar ${householdId}.`);
