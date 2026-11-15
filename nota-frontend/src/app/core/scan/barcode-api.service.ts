import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { environment } from '../../../environments/environment';
import { BarcodeType } from './scan-normalize';

/** Stage 26: the product barcode endpoints (generate, bulk generate, save a product's barcode list). */
@Injectable({ providedIn: 'root' })
export class BarcodeApiService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.api_base_url}products/`;

  /** One new in-store EAN-13 (prefix 2); the caller adds it to the product's list and saves. */
  generate() {
    return this.http.post<{ barcode: string; type: BarcodeType }>(`${this.base}barcodes/generate`, {});
  }

  /** How many non-archived products (of the category, or all) have no barcode. */
  missingCount(categoryId?: string) {
    return this.http.get<{ count: number }>(`${this.base}barcodes/missing-count`, { params: categoryId ? { categoryId } : {} });
  }

  /** One generated barcode for each such product, in batches on the server; resolves how many were done. */
  generateMissing(categoryId?: string) {
    return this.http.post<{ done: number }>(`${this.base}barcodes/generate-missing`, categoryId ? { categoryId } : {});
  }

  /** Saves only the barcode list of a product (409 BARCODE_TAKEN names the product that has it). */
  setBarcodes(productId: string, barcodes: string[]) {
    return this.http.put<{ barcodes?: string[] }>(`${this.base}${productId}`, { barcodes });
  }
}
