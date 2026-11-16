// Online Stage Help: the shape of the help content (one TS object per section under content/<locale>/).
// Text fields are plain strings with a tiny inline markup (see inline-parse.ts): **bold**, [[/route|label]] (a page link)
// and [[#section-id|label]] (a link to another help section). Nothing is ever rendered as HTML.
import type { RouteRule } from '../core/auth/route-permissions';

/** A line of text with the inline markup. */
export type HelpText = string;

export type HelpBlock =
  /** A sub-heading inside the section (the ten parts of a page section use the fixed titles in HELP_PART_TITLES). */
  | { type: 'heading'; text: HelpText; part?: HelpPart }
  | { type: 'paragraph'; text: HelpText }
  /** Numbered steps of one task ("إزاي تعمل فاتورة آجل"). */
  | { type: 'steps'; title: HelpText; items: HelpText[] }
  | { type: 'bullets'; title?: HelpText; items: HelpText[] }
  | { type: 'tip'; text: HelpText }
  | { type: 'warning'; text: HelpText }
  /** "ورا الكواليس": what Nota records (money, stock, accounts), with an optional example entry. */
  | { type: 'behind'; title: HelpText; text: HelpText[]; entry?: HelpEntryLine[] }
  /** Field → meaning → the rules the user will hit. */
  | { type: 'fields'; title?: HelpText; rows: { field: HelpText; meaning: HelpText; rules?: HelpText }[] }
  /** Button / action → what it does → when it is hidden or disabled. */
  | { type: 'actions'; title?: HelpText; rows: { action: HelpText; does: HelpText; when?: HelpText }[] }
  /** Status → meaning → what you can do. */
  | { type: 'statuses'; title?: HelpText; rows: { status: HelpText; meaning: HelpText; next?: HelpText }[] }
  /** "ليه مش قادر؟": the rule (often the exact message) → what to do. */
  | { type: 'blockers'; title?: HelpText; rows: { rule: HelpText; fix: HelpText }[] }
  | { type: 'faq'; items: { q: HelpText; a: HelpText }[] }
  /** Generic two-column table (glossary, permission catalog). */
  | { type: 'table'; title?: HelpText; head: [HelpText, HelpText] | [HelpText, HelpText, HelpText]; rows: HelpText[][] };

/** One line of an example journal entry. */
export interface HelpEntryLine {
  account: HelpText;
  debit?: number;
  credit?: number;
}

/** The parts every page section must contain (the brief's list). The integrity spec checks they are there. */
export type HelpPart = 'what' | 'tasks' | 'fields' | 'actions' | 'statuses' | 'behind' | 'blocked' | 'mistakes' | 'faq' | 'phone';

export const HELP_PART_TITLES: Record<HelpPart, string> = {
  what: 'الصفحة دي بتعمل إيه؟',
  tasks: 'إزاي تعمل كل حاجة',
  fields: 'الخانات ومعناها',
  actions: 'الأزرار والإجراءات',
  statuses: 'الحالات',
  behind: 'ورا الكواليس',
  blocked: 'ليه مش قادر؟',
  mistakes: 'غلطت؟ إزاي تصلّح',
  faq: 'أسئلة متكررة',
  phone: 'على الموبايل',
};

/** Parts a page section may skip when it really has nothing for them (e.g. a page with no statuses). */
export const OPTIONAL_PARTS: readonly HelpPart[] = ['fields', 'statuses', 'behind'];

export interface HelpSection {
  /** Stable id, used in the URL (/help/<id>). */
  id: string;
  title: string;
  /** One line under the title on the cards and in search results. */
  summary: string;
  /** page = explains app pages (must contain the parts); guide = start here, glossary, printing… */
  kind: 'page' | 'guide';
  /** Every app route this section explains, as written in app.routes.ts (e.g. 'customers/:id'). */
  routes: readonly string[];
  /** Who sees it by default (the same rule shape as the route guards); none = every signed-in user. */
  permissions?: RouteRule;
  keywords: readonly string[];
  /** Related section ids. */
  related: readonly string[];
  blocks: readonly HelpBlock[];
}

/** The content of one language. */
export interface HelpContent {
  locale: 'ar';
  sections: readonly HelpSection[];
}
