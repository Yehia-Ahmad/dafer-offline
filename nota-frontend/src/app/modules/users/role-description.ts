import { PERMISSION_CATALOG } from '../../help/generated/permission-catalog';

/**
 * Online Fixes 1: the one-line description of a role in the user form, GENERATED from the backend role templates (the copy of
 * nota-backend/src/auth/permissions.js that scripts/export-help.mjs writes), so it can never disagree with what a role really holds.
 *  - owner: everything, always;  custom: the permissions are picked by hand;
 *  - manager (everything but a few): "everything except …" listing exactly the permissions its template lacks;
 *  - the other roles: the permission groups the template touches.
 */
export function roleDescription(role: string, lang: 'ar' | 'en'): string {
  const ar = lang === 'ar';
  const catalog = PERMISSION_CATALOG;
  if (role === 'owner') return ar ? 'كل حاجة، دايمًا' : 'Everything, always';
  if (role === 'custom') return ar ? 'تختار الصلاحيات بنفسك' : 'You pick the permissions yourself';
  const template = new Set(catalog.templates[role] ?? []);
  if (!template.size) return '';
  const label = (key: string) => (ar ? catalog.permissions[key].ar : catalog.permissions[key].en);
  const missing = catalog.keys.filter((key) => !template.has(key));
  // A role that holds nearly everything is described by what it can NOT do.
  if (missing.length && missing.length <= catalog.keys.length / 4) {
    return `${ar ? 'كل حاجة ما عدا' : 'Everything except'}: ${missing.map(label).join(ar ? '، ' : ', ')}`;
  }
  if (!missing.length) return ar ? 'كل حاجة' : 'Everything';
  const groups = [...new Set(catalog.keys.filter((key) => template.has(key)).map((key) => catalog.permissions[key].group))];
  const names = groups.map((group) => (ar ? catalog.groups[group] : catalog.groupsEn[group]) ?? group);
  return `${ar ? 'بيشتغل في' : 'Works with'}: ${names.join(ar ? '، ' : ', ')}`;
}
