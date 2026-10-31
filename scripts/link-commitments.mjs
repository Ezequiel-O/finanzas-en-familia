// Migración de precisión para Compromisos.
//
// 1) Aportes de ahorro antiguos que solo tienen `meta.savingName`: si el nombre
//    corresponde a UNA sola meta del hogar, agrega `meta.savingId` (vínculo por id,
//    que no se rompe si la meta se renombra).
// 2) Deudas: compara el `remaining` guardado con el saldo real calculado desde los
//    pagos y, con --apply, actualiza el valor guardado (solo informativo; la app
//    ya no lo usa para los totales).
//
// Por defecto es solo lectura (dry-run). Haz un respaldo antes de usar --apply:
//   gcloud firestore export gs://<bucket>/respaldo-$(date +%F)
import fs from 'node:fs';
import process from 'node:process';
import { applicationDefault, cert, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { buildDebtPaidIndex, buildSavingResolver, debtProgress } from '../src/domain/commitments.js';
import { SAVINGS_CATEGORY } from '../src/constants.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const verbose = args.includes('--verbose');
const getArg = (name) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
};

if (args.includes('--help')) {
  console.log(
    [
      'Uso:',
      '  node scripts/link-commitments.mjs [--apply] [--verbose]',
      '    [--service-account=ruta.json] [--project-id=id] [--household=id]',
      '',
      'Sin --apply solo muestra lo que cambiaría.',
    ].join('\n'),
  );
  process.exit(0);
}

const serviceAccountPath = getArg('--service-account');
const serviceAccount = serviceAccountPath ? JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8')) : null;
initializeApp({
  credential: serviceAccount ? cert(serviceAccount) : applicationDefault(),
  projectId: getArg('--project-id') || serviceAccount?.project_id,
});
const db = getFirestore();
const onlyHousehold = getArg('--household');

const BATCH_LIMIT = 400;

async function commitInChunks(updates) {
  for (let i = 0; i < updates.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    updates.slice(i, i + BATCH_LIMIT).forEach(({ ref, data }) => batch.update(ref, data));
    await batch.commit();
  }
}

async function processHousehold(hid) {
  const base = db.collection('households').doc(hid);
  const [txSnap, savingsSnap, debtsSnap] = await Promise.all([
    base.collection('transactions').get(),
    base.collection('savings').get(),
    base.collection('debts').get(),
  ]);
  const transactions = txSnap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));
  const savings = savingsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const debts = debtsSnap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));

  // 1) Vincular aportes por id
  const resolve = buildSavingResolver(savings);
  const savingLinks = [];
  let ambiguous = 0;
  transactions.forEach((t) => {
    if (t.category !== SAVINGS_CATEGORY || t.meta?.savingId || !t.meta?.savingName) return;
    const savingId = resolve(t);
    if (!savingId) {
      ambiguous += 1;
      return;
    }
    savingLinks.push({ ref: t.ref, data: { 'meta.savingId': savingId } });
    if (verbose) console.log(`  [ahorro] ${t.id}: "${t.meta.savingName}" -> ${savingId}`);
  });

  // 2) Saldos de deudas
  const index = buildDebtPaidIndex(transactions);
  const debtFixes = [];
  debts.forEach((d) => {
    if (d.isSubscription) return;
    const p = debtProgress(d, index);
    const stored = Number(d.remaining || 0);
    if (Math.round(stored) === Math.round(p.remaining)) return;
    debtFixes.push({ ref: d.ref, data: { remaining: p.remaining } });
    console.log(`  [deuda] ${d.name || d.id}: guardado ${stored} · real ${p.remaining} (diferencia ${stored - p.remaining})`);
  });

  console.log(
    `Hogar ${hid}: ${savingLinks.length} aportes a vincular, ${ambiguous} sin vínculo posible (nombre repetido o inexistente), ${debtFixes.length} deudas con saldo desactualizado.`,
  );
  if (apply) {
    await commitInChunks([...savingLinks, ...debtFixes]);
    console.log(`  Aplicado.`);
  }
  return { links: savingLinks.length, debts: debtFixes.length };
}

const households = onlyHousehold
  ? [onlyHousehold]
  : (await db.collection('households').get()).docs.map((d) => d.id);

let totalLinks = 0;
let totalDebts = 0;
for (const hid of households) {
  const r = await processHousehold(hid);
  totalLinks += r.links;
  totalDebts += r.debts;
}
console.log(
  `\n${apply ? 'Listo' : 'Dry-run'}: ${totalLinks} aportes vinculados, ${totalDebts} saldos de deuda corregidos en ${households.length} hogares.`,
);
if (!apply) console.log('Revisa el resultado y vuelve a correr con --apply para escribir los cambios.');
