// Test fixtures: the backend's permission catalog and role templates (nota-backend/src/auth/permissions.js).
// Online Fixes 1: they are DERIVED from the generated copy of the backend catalog (scripts/export-help.mjs writes
// src/app/help/generated/permission-catalog.ts, and `--check` fails while it is stale), so these fixtures can never drift from the backend
// (they used to be hand-copied and had lost the accounting keys and the manager template's exclusions).
import { PERMISSION_CATALOG } from '../../../help/generated/permission-catalog';
import { AuthUser, PermissionCatalog, RoleKey } from '../auth.models';

export const ALL_PERMISSIONS: readonly string[] = PERMISSION_CATALOG.keys;

export const ROLE_PERMISSIONS: Record<Exclude<RoleKey, 'custom'>, string[]> = {
  owner: [...PERMISSION_CATALOG.templates['owner']],
  manager: [...PERMISSION_CATALOG.templates['manager']],
  cashier: [...PERMISSION_CATALOG.templates['cashier']],
  storekeeper: [...PERMISSION_CATALOG.templates['storekeeper']],
  accountant: [...PERMISSION_CATALOG.templates['accountant']],
};

export function fakeUser(role: RoleKey, overrides: Partial<AuthUser> = {}): AuthUser {
  const permissions = role === 'custom' ? [] : ROLE_PERMISSIONS[role];
  return {
    _id: `id-${role}`,
    name: { owner: 'أحمد', manager: 'منى', cashier: 'محمود', storekeeper: 'سيد', accountant: 'هالة', custom: 'زائر' }[role],
    username: role,
    role,
    permissions: [...permissions],
    permissionsEdited: false,
    isActive: true,
    lastLoginAt: '2026-11-05T07:02:00.000Z',
    ...overrides,
  };
}

/** GET /api/auth/permissions, as the backend returns it. */
export const FAKE_CATALOG: PermissionCatalog = {
  permissions: PERMISSION_CATALOG.keys.map((key) => ({
    key,
    group: PERMISSION_CATALOG.permissions[key].group,
    ar: PERMISSION_CATALOG.permissions[key].ar,
    en: PERMISSION_CATALOG.permissions[key].en,
  })),
  groups: Object.fromEntries(Object.keys(PERMISSION_CATALOG.groups).map((group) => [group, { ar: PERMISSION_CATALOG.groups[group], en: PERMISSION_CATALOG.groupsEn[group] }])),
  roles: (['owner', 'manager', 'cashier', 'storekeeper', 'accountant', 'custom'] as const).map((role) => ({
    role,
    ar: PERMISSION_CATALOG.roles[role],
    en: PERMISSION_CATALOG.rolesEn[role],
    permissions: role === 'custom' ? [] : [...PERMISSION_CATALOG.templates[role]],
    editable: role !== 'owner',
  })),
};
