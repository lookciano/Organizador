import mammoth from 'mammoth';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export const MAX_SOURCE_TEXT = 180_000;

function ensureSize(value) {
  if (value.length > MAX_SOURCE_TEXT) {
    throw new Error('O documento contém texto demais para uma análise completa. Divida-o em arquivos menores e envie cada parte.');
  }
  return value;
}

export async function extractFileText(fileData, contentType) {
  if (!fileData) return '';
  if (contentType === 'text/plain' || contentType === 'text/markdown') {
    return ensureSize(fileData.toString('utf8'));
  }
  if (contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await mammoth.extractRawText({ buffer: fileData });
    return ensureSize(result.value);
  }
  if (contentType === 'application/pdf') {
    const task = getDocument({ data: new Uint8Array(fileData), useSystemFonts: true });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 200) throw new Error('O PDF tem mais de 200 páginas. Divida-o em arquivos menores.');
      let result = '';
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const { items } = await page.getTextContent();
        const text = items.map((item) => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim();
        if (text) result += `\n\n[Página ${pageNumber}]\n${text}`;
        ensureSize(result);
        page.cleanup();
      }
      return result.trim();
    } finally { await task.destroy(); }
  }
  return '';
}

export function splitForAnalysis(value, maxChars = 12_000) {
  const text = ensureSize(value.replace(/\r\n?/g, '\n').trim());
  if (!text) return [''];
  const chunks = [];
  let position = 0;
  while (position < text.length) {
    let end = Math.min(position + maxChars, text.length);
    if (end < text.length) {
      for (const marker of ['\n\n', '\n', '. ', '; ', ' ']) {
        const boundary = text.lastIndexOf(marker, end);
        if (boundary >= position + Math.floor(maxChars * 0.65)) {
          end = boundary + marker.length;
          break;
        }
      }
    }
    const chunk = text.slice(position, end).trim();
    if (chunk) chunks.push(chunk);
    position = end;
  }
  return chunks;
}
