import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';
import {
  SlugAvailabilityRequest,
  SlugAvailabilityResponse
} from '../models/seo.models';

@Injectable({ providedIn: 'root' })
export class SeoAdminService {
  private readonly baseUrl = `${environment.api_base_url}seo`;

  constructor(private readonly http: HttpClient) {}

  checkSlugAvailability(request: SlugAvailabilityRequest): Observable<SlugAvailabilityResponse> {
    let params = new HttpParams()
      .set('entityType', request.entityType)
      .set('language', request.language)
      .set('slug', request.slug);

    if (request.excludeId) {
      params = params.set('excludeId', request.excludeId);
    }

    return this.http.get<unknown>(`${this.baseUrl}/slug-availability`, { params }).pipe(
      map((response) => {
        const body = this.extractBody(response);
        return {
          available: body['available'] !== false,
          slug: String(body['slug'] || request.slug),
          language: request.language,
          entityType: request.entityType,
          message: typeof body['message'] === 'string' ? body['message'] : undefined
        };
      })
    );
  }

  private extractBody(response: unknown): Record<string, unknown> {
    if (!response || typeof response !== 'object') return {};
    const candidate = response as { data?: unknown };
    return (candidate.data && typeof candidate.data === 'object' ? candidate.data : response) as Record<string, unknown>;
  }
}
