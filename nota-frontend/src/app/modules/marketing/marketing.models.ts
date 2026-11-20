// Online Stage 7A: campaigns, results, leads and the marketing settings (nota-backend /api/campaigns, /api/leads, /api/website/marketing-settings).
export type Platform = 'facebook' | 'instagram' | 'tiktok' | 'whatsapp' | 'messenger' | 'other';
export const PLATFORMS: readonly Platform[] = ['facebook', 'instagram', 'tiktok', 'whatsapp', 'messenger', 'other'];
export type CampaignType = 'paid' | 'organic';
export type CampaignStatus = 'active' | 'ended' | 'archived';
export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = ['active', 'ended', 'archived'];
export type LandingKind = 'home' | 'product' | 'category' | 'path';

export interface Landing { kind: LandingKind; ref?: string; path?: string }

/** The numbers of one campaign / platform / direct for a date range. Profit fields are absent without the cost/profit permission. */
export interface ResultsRow {
  clicks: number;
  visits: number | null;
  ordersPlaced: number;
  ordersCompleted: number;
  ordersCancelled: number;
  ordersRejected: number;
  ordersRefused: number;
  sales: number;
  conversionRate: number | null;
  averageOrderValue: number | null;
  spend: number;
  costPerOrder: number | null;
  returnOnSpend: number | null;
  grossProfit?: number;
  profitAfterAds?: number;
}

export interface Campaign {
  _id: string;
  name: string;
  code: string;
  platform: Platform;
  type: CampaignType;
  landing: Landing;
  startDate: string;
  endDate?: string | null;
  plannedBudget?: number | null;
  notes?: string;
  status: CampaignStatus;
  fullLink: string;
  shortLink: string;
  codeEditable: boolean;
  kpis?: ResultsRow | null;
  createdByName?: string;
}

export interface CampaignPayload {
  name: string;
  platform: Platform;
  type: CampaignType;
  landing: Landing;
  startDate: string;
  endDate?: string | null;
  plannedBudget?: number | null;
  notes?: string;
  status?: CampaignStatus;
  code?: string;
}

export interface CampaignList { range: { from: string; to: string }; data: Campaign[] }

export interface CampaignResultsRow extends ResultsRow { campaignId: string; name: string; code: string; platform: Platform; type: CampaignType; status: CampaignStatus }
export interface DailyPoint { day: string; visits: number; orders: number; sales: number }
export interface Results {
  range: { from: string; to: string };
  includeProfit: boolean;
  totals: ResultsRow;
  campaigns: CampaignResultsRow[];
  platforms: (ResultsRow & { platform: Platform })[];
  direct: ResultsRow;
  heardFrom: (ResultsRow & { answer: string })[];
  daily: DailyPoint[];
}
export interface CampaignResults { range: { from: string; to: string }; includeProfit: boolean; campaign: CampaignResultsRow | null; daily: DailyPoint[] }

export interface SpendRow { _id: string; number: string; date: string; amount: number; vatAmount: number; net: number; note: string; status: 'posted' | 'cancelled' }
export interface SpendList { range: { from: string; to: string }; data: SpendRow[]; total: number }
export interface AdCategory { accountId: string; code: string; nameAr: string; nameEn: string }

export type LeadSource = 'facebook' | 'instagram' | 'tiktok' | 'whatsapp' | 'messenger' | 'website' | 'walk_in' | 'other';
export const LEAD_SOURCES: readonly LeadSource[] = ['facebook', 'instagram', 'tiktok', 'whatsapp', 'messenger', 'website', 'walk_in', 'other'];
export type LeadStatus = 'new' | 'contacted' | 'interested' | 'not_interested';
export const LEAD_STATUSES: readonly LeadStatus[] = ['new', 'contacted', 'interested', 'not_interested'];

export interface Lead {
  _id: string;
  name: string;
  phone?: string | null;
  profileLink?: string | null;
  source: LeadSource;
  campaignId?: string | null;
  campaignName?: string | null;
  status: LeadStatus;
  notes?: string;
  lastContactDate?: string | null;
  noteLog?: { at: string; byName?: string; text: string }[];
  createdAt: string;
}
export interface LeadPurchaseDoc { type: 'web_order' | 'credit_sale' | 'cash_sale'; id: string; number: string; date: string; total: number; status?: string }
export interface LeadDetail extends Lead {
  purchases: { bought: boolean; count: number; total: number; documents: LeadPurchaseDoc[] };
  whatsappLink: string | null;
  callLink: string | null;
}
export interface LeadPayload {
  name: string;
  phone?: string | null;
  profileLink?: string | null;
  source: LeadSource;
  campaignId?: string | null;
  status?: LeadStatus;
  notes?: string;
  lastContactDate?: string | null;
}
export interface LeadList { data: Lead[]; pagination: { page: number; limit: number; totalItems: number; totalPages: number } }

export type ImportField = 'name' | 'phone' | 'createdTime' | 'campaignName' | 'adName' | 'platform' | 'profileLink';
export type ImportMapping = Record<ImportField, string | null>;
export interface ImportSummary { total: number; imported: number; updated: number; skipped: number; invalid: number }
export interface ImportPreview { summary: ImportSummary; rows: { index: number; status: 'new' | 'update' | 'skip' | 'invalid'; reason?: string; name: string; phone: string | null }[] }
export interface ImportResult extends ImportSummary { invalidRows: { index: number; reason: string; name: string }[] }
export const MAX_IMPORT_ROWS = 5000;

export interface MarketingSettings {
  metaPixelId: string;
  tiktokPixelId: string;
  requireConsent: boolean;
  attributionDays: number;
  askHeardFrom: boolean;
  heardFromOptions: string[];
  feeds: { meta: string; tiktok: string };
}
export type MarketingSettingsPayload = Partial<Omit<MarketingSettings, 'feeds'>>;
