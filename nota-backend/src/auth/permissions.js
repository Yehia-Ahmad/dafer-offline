// Stage 13: the single source of truth for permissions and role templates.
// The route → permission map lives on the routes themselves (src/routes/*.js, requirePermission);
// test/permissions.test.js walks the router and fails if any route has none.

const PERMISSIONS = {
  "sales.create": { group: "sales", ar: "إنشاء فاتورة نقدية", en: "Create cash sales" },
  "sales.view": { group: "sales", ar: "عرض الفواتير النقدية", en: "View cash sales" },
  "sales.edit": { group: "sales", ar: "تعديل الفواتير النقدية", en: "Edit cash sales" },
  "sales.delete": { group: "sales", ar: "إلغاء فاتورة كاش", en: "Cancel cash invoice" },
  "sales.discount": { group: "sales", ar: "منح خصم على الفاتورة (نقدي وآجل)", en: "Give invoice discounts (cash and credit)" },
  "sales.priceBelowCost": { group: "sales", ar: "البيع بأقل من سعر الشراء (نقدي وآجل)", en: "Sell below purchase price (cash and credit)" },

  "credit.create": { group: "credit", ar: "إنشاء فاتورة آجلة", en: "Create credit sales" },
  "credit.view": { group: "credit", ar: "عرض الفواتير الآجلة", en: "View credit sales" },
  "credit.edit": { group: "credit", ar: "تعديل الفواتير الآجلة", en: "Edit credit sales" },
  "credit.delete": { group: "credit", ar: "إلغاء فاتورة آجل", en: "Cancel credit invoice" },
  "credit.collect": { group: "credit", ar: "تحصيل الدفعات", en: "Collect payments" },

  "returns.create": { group: "returns", ar: "تسجيل مرتجع", en: "Create returns" },
  "returns.view": { group: "returns", ar: "عرض المرتجعات", en: "View returns" },

  "customers.view": { group: "customers", ar: "عرض العملاء", en: "View customers" },
  "customers.manage": { group: "customers", ar: "إدارة العملاء", en: "Manage customers" },

  "suppliers.view": { group: "suppliers", ar: "عرض الموردين", en: "View suppliers" },
  "suppliers.manage": { group: "suppliers", ar: "إدارة الموردين", en: "Manage suppliers" },

  "products.view": { group: "products", ar: "عرض المنتجات والفئات", en: "View products and categories" },
  "products.manage": { group: "products", ar: "إدارة المنتجات", en: "Manage products" },
  "products.viewCost": { group: "products", ar: "عرض سعر الشراء والربح", en: "View purchase price and profit" },
  "products.syncPrice": { group: "products", ar: "مزامنة سعر الشراء مع الفواتير", en: "Sync purchase price to invoices" },
  "products.importExport": { group: "products", ar: "استيراد وتصدير Excel", en: "Excel import and export" },
  "categories.manage": { group: "products", ar: "إدارة الفئات", en: "Manage categories" },

  "reports.profit": { group: "reports", ar: "تقارير الأرباح", en: "Profit reports" },
  "dashboard.view": { group: "reports", ar: "عرض لوحة التحكم", en: "View the dashboard" },

  "shop.manage": { group: "admin", ar: "إدارة بيانات المتجر", en: "Manage shop profile" },
  "users.manage": { group: "admin", ar: "إدارة المستخدمين والصلاحيات", en: "Manage users and permissions" },
  "audit.view": { group: "admin", ar: "عرض سجل العمليات", en: "View the audit log" },
  // Reserved for Stage 15 (backup and restore through Electron IPC). No backend route uses it yet.
  "backup.manage": { group: "admin", ar: "النسخ الاحتياطي والاستعادة", en: "Backup and restore" },
  "accounting.view": { group: "accounting", ar: "عرض الحسابات", en: "View accounting" },
  "accounting.manage": { group: "accounting", ar: "إدارة الحسابات", en: "Manage accounting" },
};

const PERMISSION_GROUPS = {
  sales: { ar: "المبيعات النقدية", en: "Cash sales" },
  credit: { ar: "المبيعات الآجلة", en: "Credit sales" },
  returns: { ar: "المرتجعات", en: "Returns" },
  customers: { ar: "العملاء", en: "Customers" },
  suppliers: { ar: "الموردين", en: "Suppliers" },
  products: { ar: "المنتجات والمخزون", en: "Products and inventory" },
  reports: { ar: "التقارير", en: "Reports" },
  admin: { ar: "الإدارة", en: "Administration" },
  accounting: { ar: "الحسابات", en: "Accounting" },
};

const ALL_PERMISSIONS = Object.freeze(Object.keys(PERMISSIONS));

/**
 * Stage 17: a permission that needs another one. Journal and ledger amounts
 * reveal cost (COGS, inventory), so accounting.view requires products.viewCost.
 */
const PERMISSION_DEPENDENCIES = Object.freeze({ "accounting.view": Object.freeze(["products.viewCost"]) });

/** [{ permission, requires: [...] }] for every unmet dependency in `list`. */
const missingDependencies = (list) => {
  const held = new Set(list || []);
  return Object.entries(PERMISSION_DEPENDENCIES)
    .filter(([permission]) => held.has(permission))
    .map(([permission, requires]) => ({ permission, requires: requires.filter((key) => !held.has(key)) }))
    .filter((row) => row.requires.length);
};

const ROLES = ["owner", "manager", "cashier", "storekeeper", "accountant", "custom"];
const TEMPLATE_ROLES = ["manager", "cashier", "storekeeper", "accountant"];

const VIEW_PERMISSIONS = ["sales.view", "credit.view", "returns.view", "customers.view", "products.view", "dashboard.view"];

const ROLE_TEMPLATES = Object.freeze({
  owner: ALL_PERMISSIONS,
  manager: Object.freeze(ALL_PERMISSIONS.filter((key) => key !== "users.manage" && key !== "backup.manage" && key !== "accounting.manage")),
  cashier: Object.freeze([
    "sales.create",
    "sales.view",
    "credit.create",
    "credit.view",
    "credit.collect",
    "returns.create",
    "customers.view",
    "products.view",
    "dashboard.view",
  ]),
  storekeeper: Object.freeze(["products.view", "products.manage", "categories.manage", "products.importExport", "products.viewCost", "suppliers.view"]),
  accountant: Object.freeze([...VIEW_PERMISSIONS, "reports.profit", "products.viewCost", "credit.collect", "audit.view", "accounting.view", "suppliers.view"]),
});

const ROLE_LABELS = {
  owner: { ar: "المالك", en: "Owner" },
  manager: { ar: "مدير", en: "Manager" },
  cashier: { ar: "كاشير", en: "Cashier" },
  storekeeper: { ar: "أمين مخزن", en: "Storekeeper" },
  accountant: { ar: "محاسب", en: "Accountant" },
  custom: { ar: "مخصص", en: "Custom" },
};

const isValidPermission = (key) => Object.prototype.hasOwnProperty.call(PERMISSIONS, key);

/** Catalog order, duplicates removed. Unknown keys are dropped. */
const normalizePermissionList = (keys) => {
  const wanted = new Set(Array.isArray(keys) ? keys : []);
  return ALL_PERMISSIONS.filter((key) => wanted.has(key));
};

/** The template of a role (owner: everything; custom: none). */
const permissionsForRole = (role) => [...(ROLE_TEMPLATES[role] || [])];

const sameList = (left, right) => {
  const a = normalizePermissionList(left);
  const b = normalizePermissionList(right);
  return a.length === b.length && a.every((key, index) => key === b[index]);
};

/**
 * What a user may do:
 * - owner → every permission, always;
 * - custom → its own permissions list;
 * - a template role → its template, unless permissionsEdited is true (the owner saved an edited list).
 */
const effectivePermissions = (user) => {
  if (!user) return [];
  if (user.role === "owner") return [...ALL_PERMISSIONS];
  if (user.role === "custom" || user.permissionsEdited) return normalizePermissionList(user.permissions);
  return permissionsForRole(user.role);
};

const hasPermission = (user, key) => effectivePermissions(user).includes(key);

module.exports = {
  ALL_PERMISSIONS,
  PERMISSION_DEPENDENCIES,
  missingDependencies,
  PERMISSIONS,
  PERMISSION_GROUPS,
  ROLES,
  ROLE_LABELS,
  ROLE_TEMPLATES,
  TEMPLATE_ROLES,
  effectivePermissions,
  hasPermission,
  isValidPermission,
  normalizePermissionList,
  permissionsForRole,
  sameList,
};
