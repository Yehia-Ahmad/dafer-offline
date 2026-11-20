// Online Stage 7A: reads a Meta Lead Ads / TikTok lead form export (CSV or XLSX) into { headers, rows }. Pure helpers, no Angular.
import { MAX_IMPORT_ROWS } from '../marketing.models';

export interface ParsedFile { headers: string[]; rows: Record<string, string>[] }

export class LeadFileError extends Error {
  constructor(public readonly code: 'EMPTY' | 'TOO_MANY_ROWS' | 'UNSUPPORTED' | 'UNREADABLE') { super(code); }
}

/** UTF-8 (with or without BOM) or UTF-16 (Meta's export): the BOM decides. */
export const decodeText = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes);
  if (view[0] === 0xff && view[1] === 0xfe) return new TextDecoder('utf-16le').decode(view.subarray(2));
  if (view[0] === 0xfe && view[1] === 0xff) return new TextDecoder('utf-16be').decode(view.subarray(2));
  const text = new TextDecoder('utf-8').decode(view);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
};

const delimiterOf = (firstLine: string): string => {
  const counts = [',', ';', '\t'].map((d) => ({ d, n: firstLine.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ',';
};

/** RFC 4180 with quotes, doubled quotes and line breaks inside a quoted cell; the delimiter is detected from the header line. */
export const parseCsv = (text: string): ParsedFile => {
  const delimiter = delimiterOf(text.split(/\r?\n/, 1)[0] ?? '');
  const table: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false; } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) table.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) table.push(row);
  return toFile(table);
};

const toFile = (table: string[][]): ParsedFile => {
  if (table.length < 2) throw new LeadFileError('EMPTY');
  const headers = table[0].map((h) => h.trim());
  if (table.length - 1 > MAX_IMPORT_ROWS) throw new LeadFileError('TOO_MANY_ROWS');
  const rows = table.slice(1).map((cells) => Object.fromEntries(headers.map((h, index) => [h, (cells[index] ?? '').trim()])));
  return { headers, rows };
};

/** A cell value of exceljs as the text the server will normalize (a phone must not become 1.0e10). */
const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const v = value as { text?: unknown; result?: unknown; richText?: { text: string }[] };
    if (v.richText) return v.richText.map((part) => part.text).join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    return '';
  }
  return String(value);
};

export const parseXlsx = async (bytes: ArrayBuffer): Promise<ParsedFile> => {
  const { Workbook } = await import('exceljs');
  const workbook = new Workbook();
  try { await workbook.xlsx.load(bytes); } catch { throw new LeadFileError('UNREADABLE'); }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new LeadFileError('EMPTY');
  const table: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, column) => { cells[column - 1] = cellText(cell.value); });
    table.push(Array.from(cells, (c) => c ?? ''));
  });
  return toFile(table);
};

/** Picks the reader by the file name / type. */
export const parseLeadFile = async (name: string, bytes: ArrayBuffer): Promise<ParsedFile> => {
  const lower = name.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) return parseCsv(decodeText(bytes));
  if (lower.endsWith('.xlsx')) return parseXlsx(bytes);
  throw new LeadFileError('UNSUPPORTED');
};
