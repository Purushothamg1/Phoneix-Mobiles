import fs from 'node:fs';
import path from 'node:path';
import { PDF_DIR } from './config.js';

function escapePdfText(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function createPdf(lines, prefix = 'invoice') {
  const fileName = `${prefix}-${Date.now()}.pdf`;
  const fullPath = path.join(PDF_DIR, fileName);
  const lineCommands = lines
    .map((line, i) => `BT /F1 11 Tf 50 ${780 - i * 16} Td (${escapePdfText(line)}) Tj ET`)
    .join('\n');

  const stream = `${lineCommands}\n`;
  const objects = [
    '1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj',
    '2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj',
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>endobj',
    '4 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj',
    `5 0 obj<< /Length ${Buffer.byteLength(stream, 'utf8')} >>stream\n${stream}endstream endobj`
  ];

  let offset = 0;
  const body = [];
  const offsets = [0];
  const header = '%PDF-1.4\n';
  offset += Buffer.byteLength(header, 'utf8');

  for (const obj of objects) {
    offsets.push(offset);
    const s = `${obj}\n`;
    body.push(s);
    offset += Buffer.byteLength(s, 'utf8');
  }

  const xrefStart = offset;
  const xref = [`xref`, `0 ${objects.length + 1}`, `0000000000 65535 f `]
    .concat(offsets.slice(1).map((n) => `${String(n).padStart(10, '0')} 00000 n `))
    .join('\n');
  const trailer = `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  const pdf = header + body.join('') + xref + '\n' + trailer;

  fs.writeFileSync(fullPath, Buffer.from(pdf, 'utf8'));
  return { fileName, fullPath, relativePath: `/invoices/${fileName}` };
}
