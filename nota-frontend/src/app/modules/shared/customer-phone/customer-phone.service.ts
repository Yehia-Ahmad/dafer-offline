import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

/** Online Fixes 1: GET /api/sellings/customer-by-phone?phone= (sales.create or credit.create) answers only { exists, name }. */
export interface CustomerByPhone {
  exists: boolean;
  name?: string;
}

@Injectable({ providedIn: 'root' })
export class CustomerPhoneService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.api_base_url;

  lookup(phone: string): Observable<CustomerByPhone> {
    return this.http.get<CustomerByPhone>(`${this.api}sellings/customer-by-phone`, { params: { phone } });
  }
}
