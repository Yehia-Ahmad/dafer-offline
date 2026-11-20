// Online Stage 7A: which campaign brought the visitor. Last click wins, kept in first-party storage for the attribution window.
// Nothing personal is stored: a campaign code, utm source/medium, a timestamp and a random session id.
import { Injectable, inject } from '@angular/core';
import { ApiService } from './api.service';
import { storage } from './storage';

export const ATTRIBUTION_KEY = 'nota.store.attribution';
export const SESSION_KEY = 'nota.store.sid';
export const VISIT_KEY = 'nota.store.visits';
export const DEFAULT_WINDOW_DAYS = 7;
const CODE = /^[A-Za-z0-9_-]{3,40}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Attribution { code: string; source: string; medium: string; landedAt: string }

/** The utm parameters of a landing URL (`search` = location.search), or null without a valid utm_campaign. */
export const parseLanding = (search: string, now: Date = new Date()): Attribution | null => {
  const params = new URLSearchParams(search);
  const code = (params.get('utm_campaign') ?? '').trim();
  if (!CODE.test(code)) return null;
  return { code: code.toLowerCase(), source: (params.get('utm_source') ?? '').slice(0, 40), medium: (params.get('utm_medium') ?? '').slice(0, 40), landedAt: now.toISOString() };
};

/** The visitor's local calendar day (the shop's day), never a UTC slice. */
export const localDay = (date: Date = new Date()): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const randomId = (): string => {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  const bytes = new Uint8Array(12);
  if (c) c.getRandomValues(bytes); else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

@Injectable({ providedIn: 'root' })
export class AttributionService {
  private readonly api = inject(ApiService);

  /** Call with location.search on landing (browser only). A new campaign landing replaces the old one: last click wins. */
  capture(search: string, now: Date = new Date()): Attribution | null {
    const landing = parseLanding(search, now);
    if (!landing) return null;
    storage.setJson(ATTRIBUTION_KEY, landing);
    return landing;
  }

  /** The stored attribution while it is inside the window (an expired one is removed). */
  current(windowDays: number = DEFAULT_WINDOW_DAYS, now: Date = new Date()): Attribution | null {
    const stored = storage.getJson<Attribution>(ATTRIBUTION_KEY);
    if (!stored || typeof stored.code !== 'string' || !CODE.test(stored.code)) return null;
    const landed = new Date(stored.landedAt).getTime();
    if (Number.isNaN(landed) || now.getTime() - landed > Math.max(1, windowDays) * DAY_MS || landed > now.getTime() + 5 * 60 * 1000) {
      storage.remove(ATTRIBUTION_KEY);
      return null;
    }
    return stored;
  }

  /** What an order request carries: only the code and the landing time (the server takes source and medium from the campaign). */
  forOrder(windowDays: number = DEFAULT_WINDOW_DAYS, now: Date = new Date()): { code: string; landedAt: string } | null {
    const current = this.current(windowDays, now);
    return current ? { code: current.code, landedAt: current.landedAt } : null;
  }

  private sessionId(): string {
    const stored = storage.get(SESSION_KEY);
    if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) return stored;
    const id = randomId();
    storage.set(SESSION_KEY, id);
    return id;
  }

  /** One visit per campaign per local day per browser (a random session id, no IP). Fire and forget. */
  recordVisit(code: string, now: Date = new Date()): boolean {
    const day = localDay(now);
    const seen = storage.getJson<Record<string, string>>(VISIT_KEY) ?? {};
    if (seen[code] === day) return false;
    storage.setJson(VISIT_KEY, { ...seen, [code]: day });
    void this.api.visit(code, this.sessionId()).catch(() => undefined);
    return true;
  }
}
