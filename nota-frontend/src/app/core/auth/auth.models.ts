// Stage 14: shapes of /api/auth and /api/users (nota-backend, Stage 13).

export type RoleKey = 'owner' | 'manager' | 'cashier' | 'storekeeper' | 'accountant' | 'custom';

export interface AuthUser {
  _id: string;
  name: string;
  username: string;
  role: RoleKey;
  /** Effective permission keys. */
  permissions: string[];
  /** A template role whose list was edited (owner/custom: always false). */
  permissionsEdited: boolean;
  isActive: boolean;
  /** Stage 15: largest invoice discount in percent; absent = no limit (never set for the owner). */
  maxDiscountPercent?: number | null;
  lastLoginAt?: string | null;
  createdAt?: string;
}

/** login / setup-owner / recover / change-password. */
export interface AuthResult {
  user: AuthUser;
  token: string;
  permissions: string[];
  /** setup-owner and recover only; shown once. */
  recoveryCode?: string;
  /** Stage 22: the last closed business day (YYYY-MM-DD), present only while a period is closed (login, /me and refresh). */
  lockedThrough?: string;
}

export interface BootstrapInfo {
  hasOwner: boolean;
  /** The request came over loopback: this is the main PC itself. */
  isLocal: boolean;
  shop: { name: string; logo: string };
}

export interface CatalogPermission {
  key: string;
  group: string;
  ar: string;
  en: string;
}

export interface CatalogRole {
  role: RoleKey;
  ar: string;
  en: string;
  permissions: string[];
  editable: boolean;
}

export interface PermissionCatalog {
  permissions: CatalogPermission[];
  groups: Record<string, { ar: string; en: string }>;
  roles: CatalogRole[];
}

/** Error codes the backend sends in `error.code`. */
export const AUTH_ERROR_CODES = [
  'INVALID_CREDENTIALS',
  'LOGIN_LOCKED',
  'SESSION_EXPIRED',
  'FORBIDDEN',
  'LOCAL_ONLY',
  'OWNER_EXISTS',
  'PASSWORD_INVALID',
  'WRONG_PASSWORD',
  'INVALID_RECOVERY',
  'VALIDATION_ERROR',
  'USERNAME_TAKEN',
  'PERMISSION_NOT_HELD',
  'OWNER_PROTECTED',
  'CANNOT_CHANGE_SELF',
  'DISCOUNT_LIMIT',
] as const;
