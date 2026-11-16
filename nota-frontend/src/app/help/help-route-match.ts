// Online Stage Help: which help section explains a URL. Section routes are written like the router's paths ('customers/:id').
import { HelpSection } from './help.models';

const segmentsOf = (path: string) => path.split(/[?#]/)[0].split('/').filter(Boolean);

/** Number of literal segments when `pattern` matches `path`, or -1. */
export function routeMatchScore(pattern: string, path: string): number {
  const want = segmentsOf(pattern);
  const have = segmentsOf(path);
  if (want.length !== have.length) return -1;
  let literal = 0;
  for (let index = 0; index < want.length; index++) {
    if (want[index].startsWith(':')) continue;
    if (decodeURIComponent(have[index]) !== want[index]) return -1;
    literal++;
  }
  return literal;
}

/** The section whose routes match the URL best (most literal segments), or null. */
export function sectionForUrl(url: string, sections: readonly HelpSection[]): HelpSection | null {
  let best: { section: HelpSection; score: number } | null = null;
  for (const section of sections) {
    for (const route of section.routes) {
      const score = routeMatchScore(route, url);
      if (score >= 0 && (!best || score > best.score)) best = { section, score };
    }
  }
  return best?.section ?? null;
}
