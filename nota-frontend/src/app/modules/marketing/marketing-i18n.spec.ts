import ar from '../../../assets/i18n/ar.json';
import en from '../../../assets/i18n/en.json';
import { BACKEND_AUDIT_ACTIONS } from '../../help/generated/audit-actions';

type Tree = { [key: string]: string | Tree };
const flatten = (value: Tree, prefix = ''): string[] =>
  Object.entries(value).flatMap(([key, item]) => (typeof item === 'string' ? [`${prefix}${key}`] : flatten(item, `${prefix}${key}.`)));
const get = (tree: Tree, path: string): string | undefined => path.split('.').reduce<string | Tree | undefined>((node, key) => (node && typeof node === 'object' ? node[key] : undefined), tree) as string | undefined;

describe('Online Stage 7A strings', () => {
  const arMarketing = (ar as unknown as { marketing: Tree }).marketing;
  const enMarketing = (en as unknown as { marketing: Tree }).marketing;

  it('the marketing block has the same keys in Arabic and English, none empty', () => {
    expect(flatten(arMarketing).sort()).toEqual(flatten(enMarketing).sort());
    for (const key of flatten(arMarketing)) {
      expect(get(arMarketing, key)).withContext(`ar ${key}`).toBeTruthy();
      expect(get(enMarketing, key)).withContext(`en ${key}`).toBeTruthy();
    }
  });

  it('every key the screens use exists: nav labels, the settings tab and the new audit actions', () => {
    for (const tree of [ar, en] as unknown as { nav: { groups: Tree; items: Tree }; website: { settings: { tabs: Tree } }; audit: { actions?: Tree } }[]) {
      expect(tree.nav.groups['marketing']).toBeTruthy();
      for (const key of ['campaigns', 'marketingResults', 'leads']) expect(tree.nav.items[key]).withContext(key).toBeTruthy();
      expect(tree.website.settings.tabs['marketing']).toBeTruthy();
    }
    const codes = ['campaign.created', 'campaign.updated', 'lead.created', 'lead.updated', 'lead.imported', 'marketing.settings.updated'];
    for (const code of codes) expect(BACKEND_AUDIT_ACTIONS as readonly string[]).withContext(code).toContain(code);
    const text = JSON.stringify(ar);
    for (const code of codes) expect(text).withContext(code).toContain(`"${code}"`);
  });
});
