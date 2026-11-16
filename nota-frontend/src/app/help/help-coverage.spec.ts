import { Route } from '@angular/router';
import { routes } from '../app.routes';
import { HELP_SECTIONS_AR } from './content/ar';
import { PERMISSION_HELP } from './content/ar/users';
import { PERMISSION_CATALOG } from './generated/permission-catalog';
import { HELP_PART_TITLES, HelpPart, OPTIONAL_PARTS } from './help.models';
import { routeMatchScore, sectionForUrl } from './help-route-match';
import { sectionStrings } from './help-text';
import { parseInline } from './inline-parse';

/** Routes the brief leaves out of the coverage check (plus every redirect and the wildcard). */
const EXCLUDED = new Set(['login', 'no-access', 'ui-kit']);

/** Every routed path of the app (children joined to their parents), with redirects marked. */
function walk(list: readonly Route[], parent = ''): { path: string; redirect: boolean }[] {
  return list.flatMap((route) => {
    const path = [parent, route.path ?? ''].filter(Boolean).join('/');
    const self = { path, redirect: route.redirectTo !== undefined };
    return [self, ...(route.children ? walk(route.children, path) : [])];
  });
}

const allRoutes = walk(routes);
const pageRoutes = allRoutes.filter((route) => !route.redirect && route.path !== '' && route.path !== '**' && !EXCLUDED.has(route.path));
const sections = HELP_SECTIONS_AR;
const byId = new Map(sections.map((section) => [section.id, section]));

describe('help coverage (Online Stage Help)', () => {
  it('every app route (except login, no-access, ui-kit and redirects) is explained by some section', () => {
    const covered = new Set(sections.flatMap((section) => section.routes));
    const missing = pageRoutes.map((route) => route.path).filter((path) => !covered.has(path));
    expect(missing).withContext('routes with no help section').toEqual([]);
    expect(pageRoutes.length).toBeGreaterThan(40);
  });

  it('no section lists a route that does not exist, and no route is claimed by two sections', () => {
    const real = new Set(allRoutes.map((route) => route.path));
    const claimed = sections.flatMap((section) => section.routes.map((route) => ({ route, id: section.id })));
    expect(claimed.filter((row) => !real.has(row.route)).map((row) => `${row.id}: ${row.route}`)).toEqual([]);
    const seen = new Map<string, string>();
    const twice: string[] = [];
    for (const row of claimed) {
      if (seen.has(row.route)) twice.push(`${row.route}: ${seen.get(row.route)} + ${row.id}`);
      seen.set(row.route, row.id);
    }
    expect(twice).toEqual([]);
  });

  it('every concrete URL finds its section (route → section matching)', () => {
    expect(sectionForUrl('/customers/65f0a1b2c3d4e5f6a7b8c9d0', sections)?.id).toBe('customers');
    expect(sectionForUrl('/products/profit-report', sections)?.id).toBe('profit-report');
    expect(sectionForUrl('/products/edit/abc?x=1', sections)?.id).toBe('products');
    expect(sectionForUrl('/accounting/accounts/abc/ledger', sections)?.id).toBe('accounts');
    expect(sectionForUrl('/orders/xyz#top', sections)?.id).toBe('orders');
    expect(sectionForUrl('/more', sections)?.id).toBe('mobile-app');
    expect(sectionForUrl('/help/selling', sections)?.id).toBe('support');
    for (const route of pageRoutes) {
      const url = '/' + route.path.replace(/:[^/]+/g, 'x1');
      expect(sectionForUrl(url, sections)).withContext(url).not.toBeNull();
    }
  });

  it('section ids are unique and every related id exists', () => {
    expect(new Set(sections.map((section) => section.id)).size).toBe(sections.length);
    const broken = sections.flatMap((section) => section.related.filter((id) => !byId.has(id) || id === section.id).map((id) => `${section.id} → ${id}`));
    expect(broken).toEqual([]);
  });

  it('every in-content link points to an existing section or app route', () => {
    const patterns = allRoutes.map((route) => route.path).filter((path) => path !== '**');
    const broken: string[] = [];
    for (const section of sections) {
      for (const text of sectionStrings(section)) {
        for (const token of parseInline(text)) {
          if (token.kind === 'section' && !byId.has(token.id)) broken.push(`${section.id}: #${token.id}`);
          if (token.kind === 'page' && !patterns.some((pattern) => routeMatchScore(pattern, token.route) >= 0)) broken.push(`${section.id}: ${token.route}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('every page section has the parts the brief asks for', () => {
    const required = (Object.keys(HELP_PART_TITLES) as HelpPart[]).filter((name) => !OPTIONAL_PARTS.includes(name));
    const problems: string[] = [];
    for (const section of sections.filter((item) => item.kind === 'page')) {
      const parts = new Set(section.blocks.flatMap((block) => (block.type === 'heading' && block.part ? [block.part] : [])));
      for (const name of required) if (!parts.has(name)) problems.push(`${section.id}: ${name}`);
      if (!section.blocks.some((block) => block.type === 'steps')) problems.push(`${section.id}: no numbered task`);
      if (!section.blocks.some((block) => block.type === 'actions')) problems.push(`${section.id}: no action table`);
      if (!section.blocks.some((block) => block.type === 'faq')) problems.push(`${section.id}: no FAQ`);
    }
    expect(problems).toEqual([]);
  });

  it('every permission in the catalog is explained in the permissions section', () => {
    const missing = PERMISSION_CATALOG.keys.filter((key) => !PERMISSION_HELP[key]?.trim());
    expect(missing).withContext('catalog keys with no explanation').toEqual([]);
    const extra = Object.keys(PERMISSION_HELP).filter((key) => !PERMISSION_CATALOG.keys.includes(key));
    expect(extra).withContext('explained keys that are not in the catalog').toEqual([]);
    const usersText = sectionStrings(byId.get('users')!).join('\n');
    const notInTable = PERMISSION_CATALOG.keys.filter((key) => !usersText.includes(PERMISSION_CATALOG.permissions[key].ar));
    expect(notInTable).toEqual([]);
    expect(PERMISSION_CATALOG.keys.length).toBe(49);
  });

  it('section permission rules only use real permission keys', () => {
    const bad = sections.flatMap((section) => [...(section.permissions?.all ?? []), ...(section.permissions?.any ?? [])]
      .filter((key) => !PERMISSION_CATALOG.keys.includes(key)).map((key) => `${section.id}: ${key}`));
    expect(bad).toEqual([]);
  });
});
