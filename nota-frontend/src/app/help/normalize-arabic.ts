// Online Stage Help: Arabic search normalization (brief: أ/إ/آ → ا، ة → ه، ى → ي، tashkeel and tatweel removed,
// Arabic and English digits treated the same).

const TASHKEEL = /[ً-ٰٟ]/g;
const TATWEEL = /ـ/g;

export function normalizeArabic(value: string): string {
  return (value ?? '')
    .replace(TASHKEEL, '')
    .replace(TATWEEL, '')
    .replace(/[آأإٱ]/g, 'ا') // آ أ إ ٱ → ا
    .replace(/ة/g, 'ه') // ة → ه
    .replace(/ى/g, 'ي') // ى → ي
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660)) // ٠-٩
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0)) // ۰-۹
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Where each character of the normalized string came from in the original, so a match found in the normalized text can be
 * highlighted in the original text. normalizeArabic only removes or replaces single characters (and collapses spaces), so a
 * per-character walk gives the same string.
 */
export function normalizeWithMap(value: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  const source = value ?? '';
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (/\s/.test(char)) {
      if (text.length === 0 || text.endsWith(' ')) continue;
      text += ' ';
      map.push(index);
      continue;
    }
    const normalized = normalizeArabic(char);
    if (!normalized) continue;
    text += normalized;
    for (let k = 0; k < normalized.length; k++) map.push(index);
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    map.pop();
  }
  return { text, map };
}
