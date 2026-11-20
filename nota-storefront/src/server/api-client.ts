// A tiny server-side client for the public API, used by the Express middleware (sitemap, slug redirects, robots).
// Internal URL (NOTA_API_INTERNAL), 3 s timeout, one retry for a GET that fails on the network, in-memory cache; errors are never cached.
export class UpstreamError extends Error {
  constructor(public status: number, message = '') { super(message); }
}

export interface ApiClientOptions {
  base?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class ServerApi {
  private readonly cache = new Map<string, { exp: number; value: unknown }>();
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: ApiClientOptions = {}) {
    this.base = (options.base ?? process.env['NOTA_API_INTERNAL'] ?? 'http://127.0.0.1:5000').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async once(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.base}/api/store${path}`, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) throw new UpstreamError(response.status);
      return await response.json();
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(0, 'unreachable');
    } finally {
      clearTimeout(timer);
    }
  }

  /** A POST is never retried (it is not idempotent: a retried click would count twice). */
  async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.base}/api/store${path}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new UpstreamError(response.status);
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(0, 'unreachable');
    } finally {
      clearTimeout(timer);
    }
  }

  async get<T>(path: string, ttlSeconds = 0): Promise<T> {
    const hit = this.cache.get(path);
    if (hit && hit.exp > this.now()) return hit.value as T;
    let value: unknown;
    try {
      value = await this.once(path);
    } catch (error) {
      if (!(error instanceof UpstreamError) || error.status !== 0) throw error;
      value = await this.once(path); // one retry, network failures only
    }
    if (ttlSeconds > 0) this.cache.set(path, { exp: this.now() + ttlSeconds * 1000, value });
    return value as T;
  }
}
