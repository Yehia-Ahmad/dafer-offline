import { HELP_SECTIONS_AR } from './content/ar';
import { HelpSection } from './help.models';
import { buildSearchIndex, highlight, searchHelp } from './help-search';
import { normalizeArabic, normalizeWithMap } from './normalize-arabic';
import { parseInline, plainText } from './inline-parse';

describe('help search normalization (Online Stage Help)', () => {
  it('أ / إ / آ are ا', () => {
    expect(normalizeArabic('أحمد')).toBe(normalizeArabic('احمد'));
    expect(normalizeArabic('إلغاء')).toBe('الغاء');
    expect(normalizeArabic('آجل')).toBe('اجل');
  });

  it('ة is ه and ى is ي', () => {
    expect(normalizeArabic('فاتورة')).toBe(normalizeArabic('فاتوره'));
    expect(normalizeArabic('مستشفى')).toBe(normalizeArabic('مستشفي'));
  });

  it('tashkeel and tatweel are removed', () => {
    expect(normalizeArabic('فَاتُورَةٌ')).toBe(normalizeArabic('فاتورة'));
    expect(normalizeArabic('مـــرتجع')).toBe('مرتجع');
    expect(normalizeArabic('الضَّرِيبَة')).toBe(normalizeArabic('الضريبة'));
  });

  it('Arabic-Indic and Eastern digits are the same as English digits', () => {
    expect(normalizeArabic('٨٠مم')).toBe('80مم');
    expect(normalizeArabic('۱۴٪')).toBe('14٪');
    expect(normalizeArabic('INV-000125')).toBe('inv-000125');
  });

  it('the position map points back to the original characters', () => {
    const { text, map } = normalizeWithMap('فَاتُورَة  ١٠');
    expect(text).toBe('فاتوره 10');
    expect(map.length).toBe(text.length);
    expect(highlight('فَاتُورَة', ['فاتوره']).every((part) => part.mark)).toBeTrue();
  });
});

describe('help search (Online Stage Help)', () => {
  const sample: HelpSection = {
    id: 'demo', title: 'إلغاء الفاتورة', summary: 'شرح', kind: 'guide', routes: [], keywords: ['شطب'], related: [],
    blocks: [
      { type: 'paragraph', text: 'لو عايز تلغي **فاتورة** آجل اكتب السبب.' },
      { type: 'paragraph', text: 'الطباعة على ورق ٨٠ مم.' },
    ],
  };
  const index = buildSearchIndex([sample]);

  it('finds a paragraph through every spelling variant and returns the section and the paragraph', () => {
    for (const query of ['فاتوره', 'فاتورة', 'فَاتُورَة', 'فاتـــورة']) {
      const hits = searchHelp(index, query);
      expect(hits.length).withContext(query).toBeGreaterThan(0);
      expect(hits[0].section.id).toBe('demo');
    }
    const digits = searchHelp(index, '80');
    expect(digits.map((hit) => hit.paragraph)).toContain('الطباعة على ورق ٨٠ مم.');
    expect(searchHelp(index, 'الغاء')[0].score).toBeGreaterThanOrEqual(100); // a title hit ranks first
  });

  it('every word of the query must match, and keywords count', () => {
    expect(searchHelp(index, 'فاتورة السبب').length).toBe(1);
    expect(searchHelp(index, 'فاتورة مندوب').length).toBe(0);
    expect(searchHelp(index, 'شطب').length).toBe(1);
  });

  it('the real help answers the common questions', () => {
    const real = buildSearchIndex(HELP_SECTIONS_AR);
    expect(searchHelp(real, 'وردية').some((hit) => hit.section.id === 'cashbox')).toBeTrue();
    expect(searchHelp(real, 'الغاء فاتوره').length).toBeGreaterThan(0);
    expect(searchHelp(real, 'انستاباي').length).toBeGreaterThan(0);
  });

  it('inline markup becomes tokens, never HTML', () => {
    const tokens = parseInline('اضغط **حفظ** في [[/selling|نقطة البيع]] أو اقرا [[#returns|المرتجعات]] و [[/products?category=1|فئة]] <b>x</b>');
    expect(tokens.map((token) => token.kind)).toEqual(['text', 'bold', 'text', 'page', 'text', 'section', 'text', 'page', 'text']);
    expect(tokens[3]).toEqual({ kind: 'page', route: '/selling', text: 'نقطة البيع' });
    expect(tokens[7]).toEqual({ kind: 'page', route: '/products', text: 'فئة', query: { category: '1' } });
    expect(plainText('**ا** [[#x|ب]]')).toBe('ا ب');
  });
});
