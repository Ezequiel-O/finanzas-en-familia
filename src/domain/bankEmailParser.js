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

function amountEvidence(body) {
  const matches = String(body || '').matchAll(
    /(?:monto(?:\s+transferido|\s+de\s+(?:la\s+)?compra)?|valor(?:\s+de\s+(?:la\s+)?compra)?|importe|total\s+compra|cargo|abono)\s*:\s*(?:CLP\s*)?\$?\s*([\d.,]+)/gi,
  );
  return new Set(
    Array.from(matches, ([, value]) => Number(String(value).replace(/\D/g, ''))).filter(
      (value) => Number.isSafeInteger(value) && value > 0,
    ),
  );
}

function dateEvidence(body) {
  const matches = String(body || '').matchAll(
    /\b(\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{4}-\d{2}-\d{2})\b/g,
  );
  return new Set(Array.from(matches, ([value]) => dateKeyParts(value)).filter(Boolean));
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
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !date ||
    !['gasto', 'ingreso'].includes(type) ||
    !description ||
    !amountEvidence(email?.body).has(amount) ||
    !dateEvidence(email?.body).has(date)
  ) {
    throw new Error('Gemini devolvió campos que no coinciden con el aviso.');
  }

  const category = String(movement.category || '').trim();
  return {
    type,
    amount,
    date,
    description,
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
  const toSection = text.split(/Hacia\s*:/i)[1] || '';
  const recipient = toSection
    .match(
      /Nombre\s*:\s*(.+?)(?=\s+(?:RUT|Banco|N[°º]\s+de\s+cuenta|Producto|E-mail|Comentario)\s*:|\r?\n|$)/i,
    )?.[1]
    ?.trim();
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
