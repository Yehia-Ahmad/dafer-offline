import { LeadFileError, decodeText, parseCsv, parseLeadFile } from './lead-file';

const bytes = (text: string, encoding: 'utf8' | 'utf16le' = 'utf8', bom = false): ArrayBuffer => {
  if (encoding === 'utf16le') {
    const out = new Uint8Array((text.length + 1) * 2);
    out[0] = 0xff; out[1] = 0xfe;
    for (let i = 0; i < text.length; i += 1) { out[2 + i * 2] = text.charCodeAt(i) & 0xff; out[3 + i * 2] = text.charCodeAt(i) >> 8; }
    return out.buffer;
  }
  const body = new TextEncoder().encode(text);
  if (!bom) return body.buffer as ArrayBuffer;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]); out.set(body, 3);
  return out.buffer;
};

describe('lead file parsing', () => {
  it('reads a Meta-style CSV: quotes, commas and line breaks inside a cell, and the p: phone prefix as plain text', () => {
    const file = parseCsv('created_time,full_name,phone_number,ad_name\r\n2026-11-01T10:00:00+02:00,"سلمى, أحمد",p:+201000000002,"إعلان\nأول"\r\n2026-11-02,ليلى,01000000003,\r\n');
    expect(file.headers).toEqual(['created_time', 'full_name', 'phone_number', 'ad_name']);
    expect(file.rows.length).toBe(2);
    expect(file.rows[0]['full_name']).toBe('سلمى, أحمد');
    expect(file.rows[0]['phone_number']).toBe('p:+201000000002');
    expect(file.rows[0]['ad_name']).toBe('إعلان\nأول');
    expect(file.rows[1]['ad_name']).toBe('');
  });

  it('detects tab and semicolon delimiters and skips blank lines', () => {
    expect(parseCsv('full_name\tphone_number\nمنى\t0100\n\n').rows).toEqual([{ full_name: 'منى', phone_number: '0100' }]);
    expect(parseCsv('name;phone\nمنى;0100').rows[0]).toEqual({ name: 'منى', phone: '0100' });
  });

  it('decodes UTF-8 with and without a BOM, and UTF-16 (Meta exports)', () => {
    expect(decodeText(bytes('الاسم', 'utf8', true))).toBe('الاسم');
    expect(decodeText(bytes('الاسم', 'utf8'))).toBe('الاسم');
    expect(decodeText(bytes('full_name,phone\nمنى,0100', 'utf16le'))).toBe('full_name,phone\nمنى,0100');
  });

  it('refuses an empty file, a file over 5000 rows and an unknown type', async () => {
    expect(() => parseCsv('full_name,phone\n')).toThrowMatching((e) => e instanceof LeadFileError && e.code === 'EMPTY');
    const many = `full_name,phone\n${Array.from({ length: 5001 }, (_, i) => `n${i},0100${i}`).join('\n')}`;
    expect(() => parseCsv(many)).toThrowMatching((e) => e instanceof LeadFileError && e.code === 'TOO_MANY_ROWS');
    const ok = `full_name,phone\n${Array.from({ length: 5000 }, (_, i) => `n${i},0100${i}`).join('\n')}`;
    expect(parseCsv(ok).rows.length).toBe(5000);
    await expectAsync(parseLeadFile('leads.pdf', new ArrayBuffer(4))).toBeRejectedWithError();
  });

  it('picks the reader by the file name', async () => {
    const file = await parseLeadFile('Leads.CSV', bytes('full_name,phone_number\nمنى,0100'));
    expect(file.rows[0]['full_name']).toBe('منى');
  });
});
