// Stage 14: the session token lives in memory and sessionStorage only. A reload keeps the user
// signed in; closing the app (the window) signs them out. Never localStorage: shop PCs are shared.

const KEY = 'nota.session';

export function readStoredToken(): string | null {
  try {
    const value = sessionStorage.getItem(KEY);
    return value && value.length > 10 ? value : null;
  } catch {
    return null;
  }
}

export function writeStoredToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(KEY, token);
    else sessionStorage.removeItem(KEY);
  } catch {
    // storage blocked: the in-memory token still works until the page reloads
  }
}

// Stage 15: the lock screen survives a reload of a locked window (the same window keeps its
// sessionStorage); closing the app clears it together with the session.
const LOCK_KEY = 'nota.locked';

export function readLockedFlag(): boolean {
  try {
    return sessionStorage.getItem(LOCK_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeLockedFlag(locked: boolean): void {
  try {
    if (locked) sessionStorage.setItem(LOCK_KEY, '1');
    else sessionStorage.removeItem(LOCK_KEY);
  } catch {
    // storage blocked: the lock still holds until the page reloads
  }
}
