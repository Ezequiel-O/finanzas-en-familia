function parseAmount(value) {
  const digits = String(value || '').replace(/\D/g, '');
  const amount = Number(digits);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function parseDate(value) {
  const match = String(value || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
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
