// Stage 26 test helpers (specs only): answer the HTTP calls of ScanService.lookup in order.
import { HttpTestingController } from '@angular/common/http/testing';
import { environment } from '../../../environments/environment';

const base = environment.api_base_url;

/** Lets the pending promise continuations run (the lookup makes its next request after an await). */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

export type ScanOutcome =
  | { barcode: Record<string, unknown> } // found by its barcode
  | { code: Record<string, unknown> } // not a barcode, found by its exact internal code
  | 'notFound'
  | 'archived';

/** Answers the by-barcode request (and the code search after it) for `code` the way the server would. */
export async function answerScan(http: HttpTestingController, code: string, outcome: ScanOutcome): Promise<void> {
  const byBarcode = http.expectOne(`${base}products/by-barcode/${encodeURIComponent(code)}`);
  if (typeof outcome === 'object' && 'barcode' in outcome) {
    byBarcode.flush(outcome.barcode);
    await tick();
    return;
  }
  byBarcode.flush({ code: 'BARCODE_NOT_FOUND', barcode: code, archived: outcome === 'archived' }, { status: 404, statusText: 'Not Found' });
  await tick();
  if (outcome === 'archived') return;
  const search = http.expectOne((request) => request.url === `${base}products/search` && request.params.get('code') === code);
  search.flush(typeof outcome === 'object' ? [outcome.code] : []);
  await tick();
}

/** An Enter keydown whose target is the given input (default: a fresh input holding the value). The target stays re-definable. */
export const enterEvent = (value: string, target?: HTMLInputElement): { event: Event; input: HTMLInputElement } => {
  const input = target ?? document.createElement('input');
  if (!target) { input.value = value; document.body.appendChild(input); }
  const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
  Object.defineProperty(event, 'target', { value: input, configurable: true });
  return { event, input };
};
