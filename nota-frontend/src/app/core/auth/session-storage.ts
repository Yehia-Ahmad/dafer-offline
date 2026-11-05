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
