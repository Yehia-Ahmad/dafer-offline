// Online Stage Help: every readable paragraph of a section, one string per paragraph / row (used by search and the specs).
import { HELP_PART_TITLES, HelpBlock, HelpSection } from './help.models';
import { plainText } from './inline-parse';

const money = (value: number | undefined) => (value === undefined ? '' : value.toFixed(2));

/** The paragraphs of one block, as raw markup strings (links still in [[…]] form). */
export function blockParagraphs(block: HelpBlock): string[] {
  switch (block.type) {
    case 'heading': return [block.text || (block.part ? HELP_PART_TITLES[block.part] : '')];
    case 'paragraph': case 'tip': case 'warning': return [block.text];
    case 'steps': return [block.title, ...block.items];
    case 'bullets': return [...(block.title ? [block.title] : []), ...block.items];
    case 'behind': return [block.title, ...block.text, ...(block.entry ?? []).map((line) => `${line.account} ${money(line.debit)} ${money(line.credit)}`.trim())];
    case 'fields': return [...(block.title ? [block.title] : []), ...block.rows.map((row) => [row.field, row.meaning, row.rules].filter(Boolean).join(' — '))];
    case 'actions': return [...(block.title ? [block.title] : []), ...block.rows.map((row) => [row.action, row.does, row.when].filter(Boolean).join(' — '))];
    case 'statuses': return [...(block.title ? [block.title] : []), ...block.rows.map((row) => [row.status, row.meaning, row.next].filter(Boolean).join(' — '))];
    case 'blockers': return [...(block.title ? [block.title] : []), ...block.rows.map((row) => `${row.rule} — ${row.fix}`)];
    case 'faq': return block.items.map((item) => `${item.q} — ${item.a}`);
    case 'table': return [...(block.title ? [block.title] : []), ...block.rows.map((row) => row.join(' — '))];
  }
}

/** Every raw string in the section that may hold inline markup (for the link checks). */
export function sectionStrings(section: HelpSection): string[] {
  return [section.summary, ...section.blocks.flatMap((block) => blockParagraphs(block))];
}

/** Plain paragraphs of a section (what a reader sees). */
export function sectionParagraphs(section: HelpSection): string[] {
  return section.blocks.flatMap((block) => blockParagraphs(block)).map(plainText).filter((text) => text.trim().length > 0);
}
