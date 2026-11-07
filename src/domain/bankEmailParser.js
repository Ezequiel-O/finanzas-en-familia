function parseAmount(value) {
  const digits = String(value || '').replace(/\D/g, '');
  const amount = Number(digits);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function parseDate(value) {
  const match = String(value || '').match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (!match) return '';
  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return '';
  }
  return `${yearText}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dateKeyParts(value) {
  const text = String(value || '');
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  return parseDate(text);
}

const MONTHS = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
  jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12,
};

// "$1.790" o "$1.790,00" → 1790 (los decimales del peso no se cuentan).
function moneyValue(text) {
  return Number(String(text).replace(/,\d{1,2}$/, '').replace(/\D/g, ''));
}

// Montos que figuran en el aviso: con signo $ o CLP, o tras una etiqueta de monto
// (con o sin dos puntos, también en la línea siguiente como en las tablas HTML).
function amountEvidence(body) {
  const text = String(body || '');
  const patterns = [
    /(?:\$|CLP)\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/gi,
    /(?:monto(?:\s+transferido|\s+de\s+(?:la\s+)?compra)?|valor(?:\s+de\s+(?:la\s+)?compra)?|importe|total(?:\s+compra|\s+pagado)?|cargo|abono)\s*:?\s*(?:CLP\s*)?\$?\s*(\d[\d.]*(?:,\d{1,2})?)/gi,
  ];
  const amounts = patterns.flatMap((pattern) =>
    Array.from(text.matchAll(pattern), ([, value]) => moneyValue(value)),
  );
  return new Set(amounts.filter((value) => Number.isSafeInteger(value) && value > 0));
}

function isoDate(year, month, day) {
  const fullYear = year < 100 ? 2000 + year : year;
  const date = new Date(fullYear, month - 1, day);
  if (date.getFullYear() !== fullYear || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return '';
  }
  return `${fullYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Fechas que figuran en el aviso (dd/mm/aaaa, dd/mm/aa, aaaa-mm-dd, "7 de noviembre
// de 2026") más el día en que llegó el correo en Chile, para avisos sin fecha escrita.
function dateEvidence(body, receivedAt) {
  const text = String(body || '');
  const dates = [
    ...Array.from(text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g), ([, y, m, d]) =>
      isoDate(Number(y), Number(m), Number(d)),
    ),
    ...Array.from(text.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})\b/g), ([, d, m, y]) =>
      isoDate(Number(y), Number(m), Number(d)),
    ),
    ...Array.from(
      text.matchAll(/\b(\d{1,2})\s*(?:de\s+|-)?([a-záéíóú]{3,})\.?\s*(?:de\s+|-)?(\d{4})\b/gi),
      ([, d, month, y]) => {
        const m = MONTHS[month.slice(0, 3).toLowerCase()];
        return m ? isoDate(Number(y), m, Number(d)) : '';
      },
    ),
  ];
  const received = new Date(receivedAt || '');
  if (!Number.isNaN(received.getTime())) {
    dates.push(received.toLocaleDateString('en-CA', { timeZone: 'America/Santiago' }));
  }
  return new Set(dates.filter(Boolean));
}

// Nombre del destinatario (gasto) o de quien envía (ingreso) en una transferencia.
export function transferCounterpart(body, type) {
  const text = String(body || '');
  const section =
    type === 'ingreso'
      ? text.split(/Desde\s*:/i)[1]?.split(/Hacia\s*:/i)[0] || ''
      : text.split(/Hacia\s*:/i)[1] || '';
  const name = section
    .match(
      /Nombre\s*:\s*(.+?)(?=\s+(?:RUT|Banco|N[°º]\s+de\s+cuenta|Producto|E-mail|Comentario)\s*:|\r?\n|$)/i,
    )?.[1]
    ?.trim();
  return name && !/oculto/i.test(name) ? name.slice(0, 120) : '';
}

export function sanitizeBankEmailForAI({ subject = '', body = '' } = {}) {
  const sanitize = (value) =>
    String(value)
    .replace(
      /((?:N[°º]\s*(?:de\s*)?(?:cuenta|TEF)|RUT|E-?mail|correo|Nombre)\s*:\s*).*?(?=\s+(?:N[°º]\s*(?:de\s*)?(?:cuenta|TEF)|RUT|E-?mail|correo|Fecha|Monto|Desde|Hacia|Producto|Banco|Comentario|Nombre)\s*:|[\r\n]|$)/gi,
      '$1[oculto]',
    )
    .replace(/\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/g, '[RUT oculto]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[correo oculto]');
  const sanitizedBody = sanitize(body).slice(0, 12000);
  return `Asunto: ${sanitize(subject).slice(0, 300)}\n${sanitizedBody}`;
}

export function validateAiBankEmailMovement(email, movement, categories = []) {
  if (!movement || typeof movement !== 'object' || movement.hasMovement !== true) {
    return null;
  }
  const amount = Number(movement.amount);
  const date = dateKeyParts(movement.date);
  const type = movement.type;
  const description = String(movement.description || '').trim().slice(0, 500);
  const problems = [
    (!Number.isSafeInteger(amount) || amount <= 0) && 'monto inválido',
    Number.isSafeInteger(amount) &&
      amount > 0 &&
      !amountEvidence(email?.body).has(amount) &&
      'el monto no aparece en el aviso',
    !date && 'fecha inválida',
    date && !dateEvidence(email?.body, email?.receivedAt).has(date) && 'la fecha no aparece en el aviso',
    !['gasto', 'ingreso'].includes(type) && 'tipo inválido',
    !description && 'sin descripción',
  ].filter(Boolean);
  if (problems.length) {
    throw new Error(`Gemini devolvió campos que no coinciden con el aviso (${problems.join(', ')}).`);
  }

  // Gemini no ve el nombre del destinatario (se oculta antes de enviarlo); se agrega aquí.
  const counterpart = /transferencia|TEF/i.test(`${email?.subject} ${email?.body}`)
    ? transferCounterpart(email?.body, type)
    : '';
  const category = String(movement.category || '').trim();
  return {
    type,
    amount,
    date,
    description: counterpart
      ? `${type === 'ingreso' ? 'Transferencia de' : 'Transferencia a'} ${counterpart}`
      : description,
    suggestedCategory: type === 'gasto' && categories.includes(category) ? category : '',
  };
}

function inferType(text) {
  const incomingSection = String(text || '').split(/Hacia\s*:/i)[1] || '';
  if (/Producto\s*:\s*CuentaRUT/i.test(incomingSection)) return 'ingreso';
  if (/\b(recibiste|abono|dep[oó]sito|transferencia recibida)\b/i.test(text)) {
    return 'ingreso';
  }
  return 'gasto';
}

export function parseBankEmail({ subject = '', body = '' } = {}) {
  const text = `${subject}\n${body}`;
  const amountMatch = text.match(
    /(?:Monto\s+transferido|Monto(?:\s+de\s+(?:la\s+)?compra)?|Valor(?:\s+de\s+(?:la\s+)?compra)?|Importe|Total\s+compra)\s*:\s*(?:CLP\s*)?\$?\s*([\d.,]+)/i,
  );
  const dateMatch =
    text.match(
      /Fecha(?:\s+y\s+Hora(?:\s+de\s+TEF)?)?\s*:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    ) || text.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s+\d{1,2}:\d{2}/);
  const amount = parseAmount(amountMatch?.[1]);
  const date = parseDate(dateMatch?.[1]);
  if (!amount || !date) return null;

  const isTransfer = /transferencia|transferencia electr[oó]nica|TEF/i.test(text);
  const recipient = transferCounterpart(text, 'gasto');
  return {
    amount,
    date,
    type: inferType(text),
    description: isTransfer
      ? recipient
        ? `Transferencia a ${recipient}`.slice(0, 500)
        : 'Transferencia BancoEstado'
      : String(subject).trim().slice(0, 500),
  };
}
