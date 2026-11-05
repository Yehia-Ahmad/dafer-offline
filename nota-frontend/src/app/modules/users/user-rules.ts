import { AuthUser } from '../../core/auth/auth.models';

/** What the signed-in user may do on one row of /users (the backend enforces the same rules). */
export interface RowActions {
  edit: boolean;
  resetPassword: boolean;
  toggleStatus: boolean;
}

export function rowActions(row: AuthUser, me: AuthUser | null): RowActions {
  const isMe = !!me && row._id === me._id;
  const meIsOwner = me?.role === 'owner';
  if (row.role === 'owner') {
    // Only the owner edits the owner (name only); nobody disables or resets it through /users.
    return { edit: meIsOwner, resetPassword: false, toggleStatus: false };
  }
  return {
    edit: true,
    // Your own password: "change my password" in the sidebar (needs the current one).
    resetPassword: !isMe,
    // Nobody disables themselves.
    toggleStatus: !isMe,
  };
}

/** Same list, ignoring order. */
export function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((key) => set.has(key));
}
