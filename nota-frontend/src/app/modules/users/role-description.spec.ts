import { ALL_PERMISSIONS, FAKE_CATALOG, ROLE_PERMISSIONS } from '../../core/auth/testing/auth-fixtures';
import { PERMISSION_CATALOG } from '../../help/generated/permission-catalog';
import { roleDescription } from './role-description';

/** Online Fixes 1: the role descriptions and the auth fixtures come from the backend role templates (the generated catalog copy). */
describe('role descriptions and fixtures (Online Fixes 1)', () => {
  it('«المدير» lists exactly what it cannot do, taken from its template', () => {
    const missing = PERMISSION_CATALOG.keys.filter((key) => !PERMISSION_CATALOG.templates['manager'].includes(key));
    expect(missing.sort()).toEqual(['accounting.close', 'accounting.manage', 'backup.manage', 'marketing.connect', 'marketing.publish', 'owner.drawings', 'users.manage']);
    const text = roleDescription('manager', 'ar');
    expect(text.startsWith('كل حاجة ما عدا')).toBeTrue();
    for (const key of missing) expect(text).withContext(key).toContain(PERMISSION_CATALOG.permissions[key].ar);
    // …and nothing it can do is listed as forbidden.
    for (const key of PERMISSION_CATALOG.templates['manager']) expect(text).withContext(key).not.toContain(PERMISSION_CATALOG.permissions[key].ar);
    expect(roleDescription('manager', 'en').startsWith('Everything except')).toBeTrue();
  });

  it('the other roles name the groups their template touches; owner and custom have their own lines', () => {
    expect(roleDescription('cashier', 'ar')).toContain('المبيعات النقدية');
    expect(roleDescription('cashier', 'ar')).not.toContain('الإدارة');
    expect(roleDescription('storekeeper', 'ar')).toContain('المنتجات والمخزون');
    expect(roleDescription('accountant', 'ar')).toContain('الحسابات');
    expect(roleDescription('cashier', 'en').startsWith('Works with')).toBeTrue();
    expect(roleDescription('owner', 'ar')).toBe('كل حاجة، دايمًا');
    expect(roleDescription('custom', 'ar')).toBe('تختار الصلاحيات بنفسك');
    expect(roleDescription('unknown', 'ar')).toBe('');
  });

  it('the fixtures are the backend catalog and role templates (49 permissions, the manager template without its exclusions)', () => {
    expect(ALL_PERMISSIONS.length).toBe(PERMISSION_CATALOG.keys.length);
    expect(ALL_PERMISSIONS).toContain('accounting.close');
    expect(ROLE_PERMISSIONS.owner.length).toBe(PERMISSION_CATALOG.keys.length);
    expect(ROLE_PERMISSIONS.manager).not.toContain('accounting.manage');
    expect(ROLE_PERMISSIONS.manager).not.toContain('users.manage');
    expect(ROLE_PERMISSIONS.accountant).toContain('reports.financial');
    expect(FAKE_CATALOG.permissions.length).toBe(PERMISSION_CATALOG.keys.length);
    expect(FAKE_CATALOG.roles.find((role) => role.role === 'manager')!.permissions).toEqual(ROLE_PERMISSIONS.manager);
  });
});
