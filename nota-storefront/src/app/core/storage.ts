// localStorage that never throws and never exists on the server: on the server every call is a no-op / null, so the cart,
// the customer token and the checkout key are never read while rendering. Private windows and blocked storage also fall back to null.
const available = (): Storage | null => {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
};

export const storage = {
  get(key: string): string | null {
    try { return available()?.getItem(key) ?? null; } catch { return null; }
  },
  set(key: string, value: string): void {
    try { available()?.setItem(key, value); } catch { /* quota or blocked */ }
  },
  remove(key: string): void {
    try { available()?.removeItem(key); } catch { /* blocked */ }
  },
  getJson<T>(key: string): T | null {
    const raw = this.get(key);
    if (!raw) return null;
    try { return JSON.parse(raw) as T; } catch { return null; }
  },
  setJson(key: string, value: unknown): void { this.set(key, JSON.stringify(value)); },
};
