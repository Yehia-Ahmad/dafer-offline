import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  AdCategory, Campaign, CampaignList, CampaignPayload, CampaignResults, ImportMapping, ImportPreview, ImportResult, Lead, LeadDetail, LeadList, LeadPayload,
  MarketingSettings, MarketingSettingsPayload, Results, SpendList,
} from './marketing.models';

const params = (query: Record<string, string | number | null | undefined>): HttpParams => {
  let out = new HttpParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== '') out = out.set(key, String(value));
  return out;
};

/** Online Stage 7A: /api/campaigns, /api/leads and /api/website/marketing-settings. */
@Injectable({ providedIn: 'root' })
export class MarketingService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.api_base_url;

  // --- campaigns
  campaigns(query: { status?: string; platform?: string; from?: string; to?: string } = {}): Observable<CampaignList> {
    return this.http.get<CampaignList>(`${this.api}campaigns`, { params: params(query) });
  }
  campaign(id: string): Observable<Campaign> { return this.http.get<Campaign>(`${this.api}campaigns/${id}`); }
  createCampaign(payload: CampaignPayload): Observable<Campaign> { return this.http.post<Campaign>(`${this.api}campaigns`, payload); }
  updateCampaign(id: string, payload: Partial<CampaignPayload>): Observable<Campaign> { return this.http.put<Campaign>(`${this.api}campaigns/${id}`, payload); }
  results(query: { from?: string; to?: string } = {}): Observable<Results> { return this.http.get<Results>(`${this.api}campaigns/results`, { params: params(query) }); }
  campaignResults(id: string, query: { from?: string; to?: string } = {}): Observable<CampaignResults> {
    return this.http.get<CampaignResults>(`${this.api}campaigns/${id}/results`, { params: params(query) });
  }
  spend(id: string, query: { from?: string; to?: string } = {}): Observable<SpendList> { return this.http.get<SpendList>(`${this.api}campaigns/${id}/spend`, { params: params(query) }); }
  adCategory(): Observable<AdCategory> { return this.http.get<AdCategory>(`${this.api}campaigns/ad-category`); }

  // --- landing pickers (the public catalog: only what the website shows)
  storeCategories(): Observable<{ data: { id: string; name: string }[] }> { return this.http.get<{ data: { id: string; name: string }[] }>(`${this.api}store/categories`); }
  storeProducts(q: string): Observable<{ data: { id: string; name: string }[] }> {
    return this.http.get<{ data: { id: string; name: string }[] }>(`${this.api}store/products`, { params: params({ q, limit: 10 }) });
  }

  // --- leads
  leads(query: { search?: string; status?: string; source?: string; campaign?: string; page?: number } = {}): Observable<LeadList> {
    return this.http.get<LeadList>(`${this.api}leads`, { params: params(query) });
  }
  lead(id: string): Observable<LeadDetail> { return this.http.get<LeadDetail>(`${this.api}leads/${id}`); }
  createLead(payload: LeadPayload): Observable<Lead> { return this.http.post<Lead>(`${this.api}leads`, payload); }
  updateLead(id: string, payload: Partial<LeadPayload>): Observable<Lead> { return this.http.put<Lead>(`${this.api}leads/${id}`, payload); }
  addLeadNote(id: string, text: string): Observable<{ noteLog: NonNullable<Lead['noteLog']> }> { return this.http.post<{ noteLog: NonNullable<Lead['noteLog']> }>(`${this.api}leads/${id}/notes`, { text }); }
  importMapping(headers: string[]): Observable<{ mapping: ImportMapping; maxRows: number }> { return this.http.post<{ mapping: ImportMapping; maxRows: number }>(`${this.api}leads/import/mapping`, { headers }); }
  importPreview(body: ImportBody): Observable<ImportPreview> { return this.http.post<ImportPreview>(`${this.api}leads/import/preview`, body); }
  importCommit(body: ImportBody): Observable<ImportResult> { return this.http.post<ImportResult>(`${this.api}leads/import`, body); }

  // --- settings
  settings(): Observable<MarketingSettings> { return this.http.get<MarketingSettings>(`${this.api}website/marketing-settings`); }
  saveSettings(payload: MarketingSettingsPayload): Observable<MarketingSettings> { return this.http.put<MarketingSettings>(`${this.api}website/marketing-settings`, payload); }
}

export interface ImportBody {
  rows: Record<string, unknown>[];
  mapping: ImportMapping;
  mode: 'skip' | 'update';
  source: string;
  campaignId?: string | null;
}
