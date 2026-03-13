import fs from 'node:fs';
import process from 'node:process';
import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const REPLACEMENT_CHAR = '\uFFFD';
const MOJIBAKE_RE = /Ã.|Â./;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const verbose = args.includes('--verbose');

const getArgValue = (name) => {
  const prefix = `${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
};

const serviceAccountPath = getArgValue('--service-account');
const projectIdArg = getArgValue('--project-id');
const householdFilter = getArgValue('--household');
const replacementsPath = getArgValue('--replacements');
const limitArg = getArgValue('--limit');
const limit = limitArg ? Number(limitArg) : 0;

if (args.includes('--help')) {
  console.log(
    [
      'Uso:',
      '  node scripts/firestore-fix-encoding.mjs [--apply] [--verbose]',
      '    [--service-account=path] [--project-id=id] [--household=id]',
      '    [--replacements=path] [--limit=n]',
      '',
      'Opciones:',
      '  --apply            Escribe cambios. Sin esto, solo dry-run.',
      '  --verbose          Muestra detalle de cada campo modificado.',
      '  --service-account  Ruta al JSON de service account.',
      '  --project-id       ID del proyecto (opcional si viene en credencial).',
      '  --household        Limita la migracion a un household.',
      '  --replacements     JSON con mapping de strings { "malo": "bueno" }.',
      '  --limit            Limita cantidad de documentos a procesar.',
    ].join('\n'),
  );
  process.exit(0);
}

const replacements = new Map();
if (replacementsPath) {
  const raw = fs.readFileSync(replacementsPath, 'utf8');
  const parsed = JSON.parse(raw);
  Object.entries(parsed).forEach(([from, to]) => {
    replacements.set(String(from), String(to));
  });
}

function fixMojibake(value) {
  if (!MOJIBAKE_RE.test(value)) return { value, changed: false };
  const decoded = Buffer.from(value, 'latin1').toString('utf8');
  if (decoded === value) return { value, changed: false };
  if (decoded.includes(REPLACEMENT_CHAR)) return { value, changed: false };
  if (MOJIBAKE_RE.test(decoded)) return { value, changed: false };
  return { value: decoded, changed: true };
}

function fixString(value) {
  let next = value;
  let changed = false;

  const mojibake = fixMojibake(next);
  if (mojibake.changed) {
    next = mojibake.value;
    changed = true;
  }

  if (replacements.size) {
    const mapped = replacements.get(next);
    if (mapped !== undefined && mapped !== next) {
      next = mapped;
      changed = true;
    }
  }

  return { value: next, changed };
}

function isSuspiciousString(value) {
  return value.includes(REPLACEMENT_CHAR) || MOJIBAKE_RE.test(value);
}

function formatPath(path) {
  return path || '(root)';
}

function normalizeBudgetEntry(entry) {
  if (typeof entry === 'number') {
    const n = Number(entry || 0);
    return { plan: n, funded: n };
  }
  if (entry && typeof entry === 'object') {
    const plan = Number(entry.plan || 0);
    const funded = Number(entry.funded ?? entry.plan ?? 0);
    const next = { plan, funded };
    if (Array.isArray(entry.breakdown)) next.breakdown = entry.breakdown;
    if (entry.isFixed !== undefined) next.isFixed = !!entry.isFixed;
    return next;
  }
  return { plan: 0, funded: 0 };
}

function mergeBudgetEntries(primary, fallback) {
  const p = normalizeBudgetEntry(primary);
  const f = normalizeBudgetEntry(fallback);
  const next = { ...p };
  if ((!next.plan || next.plan === 0) && f.plan) next.plan = f.plan;
  if ((!next.funded || next.funded === 0) && f.funded) next.funded = f.funded;
  if (
    (!Array.isArray(next.breakdown) || next.breakdown.length === 0) &&
    Array.isArray(f.breakdown) &&
    f.breakdown.length > 0
  ) {
    next.breakdown = f.breakdown;
  }
  if (next.isFixed === undefined && f.isFixed !== undefined) {
    next.isFixed = f.isFixed;
  }
  return next;
}

function fixValue(value, path, record) {
  if (typeof value === 'string') {
    const fixed = fixString(value);
    if (fixed.changed) {
      record.fixes.push({
        path: formatPath(path),
        from: value,
        to: fixed.value,
      });
    } else if (isSuspiciousString(value)) {
      record.flags.push({ path: formatPath(path), value });
    }
    return { value: fixed.changed ? fixed.value : value, changed: fixed.changed };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item, idx) => {
      const res = fixValue(item, `${path}[${idx}]`, record);
      if (res.changed) changed = true;
      return res.value;
    });
    return { value: changed ? next : value, changed };
  }

  if (value && typeof value === 'object') {
    const ctorName = value.constructor?.name;
    if (
      ctorName === 'Timestamp' ||
      ctorName === 'GeoPoint' ||
      ctorName === 'DocumentReference'
    ) {
      return { value, changed: false };
    }

    let changed = false;
    const next = {};
    for (const [key, val] of Object.entries(value)) {
      const res = fixValue(val, path ? `${path}.${key}` : key, record);
      if (res.changed) changed = true;
      next[key] = res.value;
    }
    return { value: changed ? next : value, changed };
  }

  return { value, changed: false };
}

function renameMapKeys(map, record, path, mergeFn) {
  let changed = false;
  const next = {};

  for (const [key, val] of Object.entries(map)) {
    const fixedKey = fixString(key);
    const targetKey = fixedKey.changed ? fixedKey.value : key;

    if (fixedKey.changed) {
      changed = true;
      record.fixes.push({
        path: formatPath(path ? `${path}.${key}` : key),
        from: key,
        to: targetKey,
      });
    }

    if (Object.prototype.hasOwnProperty.call(next, targetKey)) {
      const merged = mergeFn ? mergeFn(next[targetKey], val) : next[targetKey];
      next[targetKey] = merged;
      record.flags.push({
        path: formatPath(path ? `${path}.${targetKey}` : targetKey),
        value: 'conflict',
      });
      changed = true;
    } else {
      next[targetKey] = val;
    }
  }

  return { map: changed ? next : map, changed };
}

function fixHouseholdDoc(data, record) {
  let changed = false;
  const base = fixValue(data, '', record);
  let next = base.value;
  if (base.changed) changed = true;

  if (next && typeof next === 'object') {
    if (Array.isArray(next.categories)) {
      const res = fixValue(next.categories, 'categories', record);
      if (res.changed) {
        next = { ...next, categories: res.value };
        changed = true;
      }
    }

    if (next.budgets && typeof next.budgets === 'object') {
      const budgets = next.budgets;
      const nextBudgets = {};
      let budgetsChanged = false;

      for (const [key, val] of Object.entries(budgets)) {
        if (MONTH_KEY_RE.test(key) && val && typeof val === 'object') {
          const renamed = renameMapKeys(
            val,
            record,
            `budgets.${key}`,
            mergeBudgetEntries,
          );
          if (renamed.changed) budgetsChanged = true;
          nextBudgets[key] = renamed.map;
          continue;
        }

        const fixedKey = fixString(key);
        const targetKey = fixedKey.changed ? fixedKey.value : key;
        if (fixedKey.changed) {
          budgetsChanged = true;
          record.fixes.push({
            path: formatPath(`budgets.${key}`),
            from: key,
            to: targetKey,
          });
        }
        if (Object.prototype.hasOwnProperty.call(nextBudgets, targetKey)) {
          nextBudgets[targetKey] = mergeBudgetEntries(
            nextBudgets[targetKey],
            val,
          );
          record.flags.push({
            path: formatPath(`budgets.${targetKey}`),
            value: 'conflict',
          });
          budgetsChanged = true;
        } else {
          nextBudgets[targetKey] = val;
        }
      }

      if (budgetsChanged) {
        next = { ...next, budgets: nextBudgets };
        changed = true;
      }
    }

    if (next.fixedCategories && typeof next.fixedCategories === 'object') {
      const renamed = renameMapKeys(
        next.fixedCategories,
        record,
        'fixedCategories',
      );
      if (renamed.changed) {
        next = { ...next, fixedCategories: renamed.map };
        changed = true;
      }
    }
  }

  return { data: next, changed };
}

async function processDoc(ref, data, record) {
  const fixed = fixValue(data, '', record);
  return { data: fixed.value, changed: fixed.changed };
}

async function main() {
  const credential = serviceAccountPath
    ? cert(JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8')))
    : applicationDefault();
  const projectId =
    projectIdArg ||
    (serviceAccountPath
      ? JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8')).project_id
      : undefined);

  initializeApp({ credential, projectId });
  const db = getFirestore();

  let processed = 0;
  let updated = 0;
  let flagged = 0;

  async function handleDoc(ref, data, isHousehold = false) {
    const record = { fixes: [], flags: [] };
    const fixed = isHousehold
      ? fixHouseholdDoc(data, record)
      : await processDoc(ref, data, record);

    if (record.flags.length) flagged += 1;
    if (record.fixes.length) updated += 1;

    if (record.fixes.length || record.flags.length) {
      const summary = `${ref.path} (${record.fixes.length} fixes, ${record.flags.length} flags)`;
      console.log(summary);
      if (verbose) {
        record.fixes.forEach((f) => {
          console.log(`  - ${f.path}: "${f.from}" -> "${f.to}"`);
        });
        record.flags.forEach((f) => {
          console.log(`  - ${f.path}: "${f.value}"`);
        });
      }
    }

    if (apply && record.fixes.length) {
      await ref.set(fixed.data, { merge: false });
    }
  }

  async function handleCollection(colRef, isHousehold = false) {
    const snap = await colRef.get();
    for (const docSnap of snap.docs) {
      if (limit && processed >= limit) return;
      processed += 1;
      await handleDoc(docSnap.ref, docSnap.data(), isHousehold);
    }
  }

  if (householdFilter) {
    const ref = db.collection('households').doc(householdFilter);
    const snap = await ref.get();
    if (!snap.exists) {
      console.error(`No existe household: ${householdFilter}`);
      process.exit(1);
    }
    await handleDoc(ref, snap.data(), true);
    const subcollections = ['transactions', 'debts', 'savings', 'trash'];
    for (const sub of subcollections) {
      const subRef = ref.collection(sub);
      await handleCollection(subRef, false);
    }
  } else {
    await handleCollection(db.collection('profiles'), false);
    const householdsSnap = await db.collection('households').get();
    for (const docSnap of householdsSnap.docs) {
      if (limit && processed >= limit) break;
      processed += 1;
      await handleDoc(docSnap.ref, docSnap.data(), true);
      const subcollections = ['transactions', 'debts', 'savings', 'trash'];
      for (const sub of subcollections) {
        if (limit && processed >= limit) break;
        await handleCollection(docSnap.ref.collection(sub), false);
      }
    }
  }

  console.log(
    `Procesados: ${processed}. Con fixes: ${updated}. Con flags: ${flagged}.`,
  );
  console.log(apply ? 'Aplicado.' : 'Dry-run completado.');
}

main().catch((err) => {
  console.error('Error en migracion:', err);
  process.exit(1);
});
