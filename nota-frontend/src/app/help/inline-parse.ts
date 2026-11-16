// Online Stage Help: the inline markup of help text → tokens. Templates render the tokens with {{ }} and routerLink only,
// so no help text can ever become HTML.
//   **bold**              → { kind: 'bold' }
//   [[/route|label]]      → { kind: 'page', route } (an app page; the integrity spec checks the route exists)
//   [[#section-id|label]] → { kind: 'section', id } (another help section)

export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'page'; text: string; route: string; query?: Record<string, string> }
  | { kind: 'section'; text: string; id: string };

const PATTERN = /\*\*([^*]+)\*\*|\[\[([^\]|]+)\|([^\]]+)\]\]/g;

export function parseInline(source: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  for (const match of (source ?? '').matchAll(PATTERN)) {
    const at = match.index ?? 0;
    if (at > last) tokens.push({ kind: 'text', text: source.slice(last, at) });
    if (match[1] !== undefined) {
      tokens.push({ kind: 'bold', text: match[1] });
    } else {
      const target = match[2].trim();
      const text = match[3].trim();
      if (target.startsWith('#')) {
        tokens.push({ kind: 'section', id: target.slice(1), text });
      } else {
        const [path, query] = target.split('?');
        const token: InlineToken = { kind: 'page', route: path, text };
        if (query) token.query = Object.fromEntries(new URLSearchParams(query));
        tokens.push(token);
      }
    }
    last = at + match[0].length;
  }
  if (last < (source ?? '').length) tokens.push({ kind: 'text', text: source.slice(last) });
  return tokens;
}

/** The text a reader sees (links and bold without their markup): used by search and by the Markdown export of plain cells. */
export function plainText(source: string): string {
  return parseInline(source).map((token) => token.text).join('');
}
