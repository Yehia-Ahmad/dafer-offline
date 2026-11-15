import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { cleanCode, normalizeScan } from './scan-normalize';

/** A product as the API sends it (the screens map it with their own mapper). */
export type ScannedProduct = Record<string, unknown> & { _id?: string; id?: string; code?: string; barcodes?: string[] };

export type ScanResult =
  | { kind: 'product'; product: ScannedProduct; matchedBy: 'barcode' | 'code'; code: string }
  /** Only an archived product has this barcode ("المنتج ده متأرشف"). */
  | { kind: 'archived'; code: string }
  | { kind: 'notFound'; code: string }
  /** The server could not be asked (network / 5xx): the screen shows its own error. */
  | { kind: 'error'; code: string; message: string };

/**
 * Stage 26: the ONE scan lookup every screen uses (POS, credit sales, purchases, products page):
 *   1. the code is normalised (Arabic keyboard layout, Arabic-Indic digits, invisible characters);
 *   2. an exact product BARCODE (GET products/by-barcode/:code, non-archived only);
 *   3. then an exact product CODE (the shop's internal code).
 * Only exact matches count, never a partial match: a typed search that is not an exact code is left to the
 * screen's normal (partial) search. Same permission and fields as the POS product search, so no cost leaks.
 */
@Injectable({ providedIn: 'root' })
export class ScanService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.api_base_url;

  async lookup(raw: unknown): Promise<ScanResult> {
    const scan = normalizeScan(raw);
    const code = scan.primary;
    if (!code) return { kind: 'notFound', code: '' };
    const readings = [scan.primary, ...scan.alternates];
    let archived = false;
    try {
      for (const reading of readings) {
        try {
          const product = await firstValueFrom(this.http.get<ScannedProduct>(`${this.base}products/by-barcode/${encodeURIComponent(reading)}`));
          return { kind: 'product', product, matchedBy: 'barcode', code: reading };
        } catch (error) {
          const response = error as { status?: number; error?: { archived?: boolean } };
          if (response?.status !== 404) throw error;
          if (response.error?.archived) archived = true;
        }
      }
      if (archived) return { kind: 'archived', code };
      // An internal product code: the text as typed first (a code may be Arabic), then the normalised readings.
      const codes = [...new Set([cleanCode(raw), ...readings])].filter(Boolean);
      for (const candidate of codes) {
        const found = await firstValueFrom(this.http.get<ScannedProduct[]>(`${this.base}products/search`, { params: { code: candidate } }));
        const exact = (Array.isArray(found) ? found : []).filter((product) => product?.code === candidate);
        if (exact.length === 1) return { kind: 'product', product: exact[0], matchedBy: 'code', code: candidate };
      }
      return { kind: 'notFound', code };
    } catch (error) {
      const message = (error as { error?: { message?: string }; message?: string })?.error?.message || (error as Error)?.message || '';
      return { kind: 'error', code, message };
    }
  }
}
