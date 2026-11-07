// Test fixtures: the backend's role templates (nota-backend/src/auth/permissions.js, Stage 13),
// copied so the frontend specs can check what each role sees. If the backend templates change,
// update this file too.
import { AuthUser, PermissionCatalog, RoleKey } from '../auth.models';

export const ALL_PERMISSIONS = [
  'sales.create', 'sales.view', 'sales.edit', 'sales.delete', 'sales.discount', 'sales.priceBelowCost',
  'credit.create', 'credit.view', 'credit.edit', 'credit.delete', 'credit.collect',
  'returns.create', 'returns.view',
  'customers.view', 'customers.manage',
  'suppliers.view', 'suppliers.manage', 'suppliers.pay', 'purchases.view', 'purchases.create', 'purchases.cancel',
  'products.view', 'products.manage', 'products.viewCost', 'products.syncPrice', 'products.importExport', 'categories.manage',
  'reports.profit', 'dashboard.view',
  'shop.manage', 'users.manage', 'audit.view', 'backup.manage',
  // Stage 19 (the Stage 17/18 accounting keys are not mirrored here: no spec needs them)
  'cashbox.view', 'cashbox.manage', 'shift.operate', 'shift.manage', 'expenses.create', 'expenses.manage', 'owner.drawings',
  // Stage 21
  'vat.file',
] as const;

const VIEW = ['sales.view', 'credit.view', 'returns.view', 'customers.view', 'products.view', 'dashboard.view'];

export const ROLE_PERMISSIONS: Record<Exclude<RoleKey, 'custom'>, string[]> = {
  owner: [...ALL_PERMISSIONS],
  manager: ALL_PERMISSIONS.filter((key) => key !== 'users.manage' && key !== 'backup.manage' && key !== 'owner.drawings'),
  cashier: ['sales.create', 'sales.view', 'credit.create', 'credit.view', 'credit.collect', 'returns.create', 'customers.view', 'products.view', 'dashboard.view', 'shift.operate', 'expenses.create'],
  storekeeper: ['products.view', 'products.manage', 'categories.manage', 'products.importExport', 'products.viewCost', 'suppliers.view', 'purchases.view', 'purchases.create'],
  accountant: [...VIEW, 'reports.profit', 'products.viewCost', 'credit.collect', 'audit.view', 'suppliers.view', 'purchases.view', 'suppliers.pay', 'cashbox.view', 'expenses.create', 'expenses.manage', 'vat.file'],
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

const LABELS: Record<string, string> = {
  'sales.create': 'إنشاء فاتورة نقدية', 'sales.view': 'عرض الفواتير النقدية', 'sales.edit': 'تعديل الفواتير النقدية',
  'sales.delete': 'حذف الفواتير النقدية', 'sales.discount': 'منح خصم على الفاتورة (نقدي وآجل)',
  'sales.priceBelowCost': 'البيع بأقل من سعر الشراء (نقدي وآجل)', 'credit.create': 'إنشاء فاتورة آجلة',
  'credit.view': 'عرض الفواتير الآجلة', 'credit.edit': 'تعديل الفواتير الآجلة', 'credit.delete': 'حذف الفواتير الآجلة',
  'credit.collect': 'تحصيل الدفعات', 'returns.create': 'تسجيل مرتجع', 'returns.view': 'عرض المرتجعات',
  'customers.view': 'عرض العملاء', 'customers.manage': 'إدارة العملاء', 'suppliers.view': 'عرض الموردين', 'suppliers.manage': 'إدارة الموردين',
  'suppliers.pay': 'سداد الموردين واسترداد منهم', 'purchases.view': 'عرض فواتير الشراء', 'purchases.create': 'تسجيل فاتورة شراء ومرتجع', 'purchases.cancel': 'إلغاء فاتورة شراء', 'products.view': 'عرض المنتجات والفئات',
  'products.manage': 'إدارة المنتجات', 'products.viewCost': 'عرض سعر الشراء والربح',
  'products.syncPrice': 'مزامنة سعر الشراء مع الفواتير', 'products.importExport': 'استيراد وتصدير Excel',
  'categories.manage': 'إدارة الفئات', 'reports.profit': 'تقارير الأرباح', 'dashboard.view': 'عرض لوحة التحكم',
  'shop.manage': 'إدارة بيانات المتجر', 'users.manage': 'إدارة المستخدمين والصلاحيات', 'audit.view': 'عرض سجل العمليات',
  'backup.manage': 'النسخ الاحتياطي والاستعادة', 'vat.file': 'تقديم الإقرار الضريبي وسداد الضريبة',
  'cashbox.view': 'عرض الخزائن وأرصدتها', 'cashbox.manage': 'إدارة الخزائن والتحويلات', 'shift.operate': 'فتح وإغلاق ورديتك',
  'shift.manage': 'عرض كل الورديات وإغلاق وردية غيرك', 'expenses.create': 'تسجيل مصروف', 'expenses.manage': 'إلغاء المصروفات وإدارة البنود', 'owner.drawings': 'سحب المالك',
};

/** GET /api/auth/permissions, as the backend returns it. */
export const FAKE_CATALOG: PermissionCatalog = {
  permissions: ALL_PERMISSIONS.map((key) => {
    const group = key === 'vat.file' ? 'accounting' : ['cashbox', 'shift', 'expenses', 'owner'].includes(key.split('.')[0]) ? 'cashbox' : key.startsWith('purchases') ? 'suppliers' : key.startsWith('categories') ? 'products' : key.startsWith('dashboard') ? 'reports'
      : ['shop', 'users', 'audit', 'backup'].includes(key.split('.')[0]) ? 'admin' : key.split('.')[0];
    return { key, group, ar: LABELS[key], en: key };
  }),
  groups: {
    sales: { ar: 'المبيعات النقدية', en: 'Cash sales' },
    cashbox: { ar: 'الخزنة', en: 'Cash' },
    credit: { ar: 'المبيعات الآجلة', en: 'Credit sales' },
    returns: { ar: 'المرتجعات', en: 'Returns' },
    customers: { ar: 'العملاء', en: 'Customers' },
    products: { ar: 'المنتجات والمخزون', en: 'Products and inventory' },
    reports: { ar: 'التقارير', en: 'Reports' },
    admin: { ar: 'الإدارة', en: 'Administration' },
  },
  roles: [
    { role: 'owner', ar: 'المالك', en: 'Owner', permissions: ROLE_PERMISSIONS.owner, editable: false },
    { role: 'manager', ar: 'مدير', en: 'Manager', permissions: ROLE_PERMISSIONS.manager, editable: true },
    { role: 'cashier', ar: 'كاشير', en: 'Cashier', permissions: ROLE_PERMISSIONS.cashier, editable: true },
    { role: 'storekeeper', ar: 'أمين مخزن', en: 'Storekeeper', permissions: ROLE_PERMISSIONS.storekeeper, editable: true },
    { role: 'accountant', ar: 'محاسب', en: 'Accountant', permissions: ROLE_PERMISSIONS.accountant, editable: true },
    { role: 'custom', ar: 'مخصص', en: 'Custom', permissions: [], editable: true },
  ],
};
