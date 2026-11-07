// Interpreta el Markdown básico que devuelve Gemini (párrafos, listas, títulos,
// negrita, cursiva y código) como datos. La UI arma elementos de React con
// ellos: nunca se inserta HTML, así que el texto del modelo no puede inyectar marcado.

const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^[*\-•]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;
const INLINE = /\*\*(.+?)\*\*|__(.+?)__|\*(?!\s)(.+?)(?<!\s)\*|`([^`]+)`/g;

export function parseBlocks(text) {
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'p', text: paragraph.join(' ') });
    paragraph = [];
  };

  for (const rawLine of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      flush();
      blocks.push({ type: 'h', text: heading[1] });
      continue;
    }
    const bullet = line.match(BULLET);
    const numbered = bullet ? null : line.match(NUMBERED);
    if (bullet || numbered) {
      flush();
      const type = bullet ? 'ul' : 'ol';
      const item = (bullet || numbered)[1];
      const last = blocks[blocks.length - 1];
      if (last?.type === type) last.items.push(item);
      else blocks.push({ type, items: [item] });
      continue;
    }
    // Línea cortada dentro de un ítem de lista: se suma a ese ítem.
    const last = blocks[blocks.length - 1];
    if (!paragraph.length && /^\s/.test(rawLine) && (last?.type === 'ul' || last?.type === 'ol')) {
      last.items[last.items.length - 1] += ` ${line}`;
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

export function parseInline(text) {
  const value = String(text || '');
  const segments = [];
  let cursor = 0;
  for (const match of value.matchAll(INLINE)) {
    if (match.index > cursor) segments.push({ text: value.slice(cursor, match.index) });
    const [, bold, boldAlt, italic, code] = match;
    if (bold ?? boldAlt) segments.push({ text: bold ?? boldAlt, bold: true });
    else if (italic) segments.push({ text: italic, italic: true });
    else segments.push({ text: code, code: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) segments.push({ text: value.slice(cursor) });
  return segments;
}
