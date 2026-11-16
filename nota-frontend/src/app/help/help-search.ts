// Online Stage Help: search over titles, keywords and text with Arabic normalization.
import { HelpSection } from './help.models';
import { sectionParagraphs } from './help-text';
import { normalizeArabic, normalizeWithMap } from './normalize-arabic';

export interface HelpSearchHit {
  section: HelpSection;
  /** The matching paragraph (plain text), or the summary when only the title / keywords matched. */
  paragraph: string;
  /** The paragraph split into plain and highlighted parts (rendered with {{ }} and <mark>, never as HTML). */
  parts: { text: string; mark: boolean }[];
  score: number;
}

interface IndexedParagraph { text: string; norm: string }
export interface HelpSearchIndex {
  entries: { section: HelpSection; title: string; keywords: string; paragraphs: IndexedParagraph[] }[];
}

export function buildSearchIndex(sections: readonly HelpSection[]): HelpSearchIndex {
  return {
    entries: sections.map((section) => ({
      section,
      title: normalizeArabic(section.title),
      keywords: normalizeArabic(section.keywords.join(' ')),
      paragraphs: [section.summary, ...sectionParagraphs(section)].map((text) => ({ text, norm: normalizeArabic(text) })),
    })),
  };
}

export function queryTerms(query: string): string[] {
  return normalizeArabic(query).split(' ').filter((term) => term.length > 0);
}

/** Splits `text` into highlighted / plain parts for every occurrence of the (normalized) terms. */
export function highlight(text: string, terms: readonly string[]): { text: string; mark: boolean }[] {
  const { text: norm, map } = normalizeWithMap(text);
  const marked = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    let from = 0;
    while (term && (from = norm.indexOf(term, from)) !== -1) {
      const start = map[from];
      const end = map[from + term.length - 1];
      for (let index = start; index <= end; index++) marked[index] = true;
      from += term.length;
    }
  }
  const parts: { text: string; mark: boolean }[] = [];
  for (let index = 0; index < text.length; index++) {
    const last = parts[parts.length - 1];
    if (last && last.mark === marked[index]) last.text += text[index];
    else parts.push({ text: text[index], mark: marked[index] });
  }
  return parts;
}

/**
 * All terms must appear (in the title, the keywords or one paragraph). Title hits rank first, then keywords, then text.
 * One result per matching paragraph, at most `limit` results.
 */
export function searchHelp(index: HelpSearchIndex, query: string, limit = 30): HelpSearchHit[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const hits: HelpSearchHit[] = [];
  for (const entry of index.entries) {
    const head = `${entry.title} ${entry.keywords}`;
    const titleAll = terms.every((term) => entry.title.includes(term));
    const keywordsAll = terms.every((term) => head.includes(term));
    let found = false;
    for (const paragraph of entry.paragraphs) {
      if (!terms.every((term) => paragraph.norm.includes(term) || head.includes(term))) continue;
      if (!terms.some((term) => paragraph.norm.includes(term))) continue;
      found = true;
      const score = (titleAll ? 100 : keywordsAll ? 50 : 0) + terms.filter((term) => paragraph.norm.includes(term)).length;
      hits.push({ section: entry.section, paragraph: paragraph.text, parts: highlight(paragraph.text, terms), score });
    }
    if (!found && keywordsAll) {
      hits.push({ section: entry.section, paragraph: entry.section.summary, parts: highlight(entry.section.summary, terms), score: titleAll ? 100 : 50 });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
