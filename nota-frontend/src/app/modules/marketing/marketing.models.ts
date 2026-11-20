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
  /** The delivery fee of the completed orders (net of its VAT): revenue on its own, never part of gross profit. */
  deliveryRevenue: number;
  conversionRate: number | null;
  averageOrderValue: number | null;
  /** For a campaign linked to Meta this is Meta's spend (converted to EGP); otherwise the recorded expenses (7A). */
  spend: number;
  costPerOrder: number | null;
  returnOnSpend: number | null;
  grossProfit?: number;
  profitAfterAds?: number;
  // Online Stage 7B: only present when the row holds a campaign linked to Meta.
  /** «المدفوع المسجّل»: the expenses linked to the campaign. Never added to the Meta spend. */
  recordedSpend?: number;
  meta?: MetaFigures;
  /** Part of the Meta spend has no exchange rate: cost per order, return and profit after ads are null. */
  needsRate?: boolean;
}

/** Online Stage 7B: the synced Meta numbers of a row (read-only; nothing here is posted). */
export interface MetaFigures {
  spend: number;
  originalSpend: number;
  originalCurrency: string;
  needsRate: boolean;
  impressions: number;
  reach: number;
  linkClicks: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
}

export interface UnlinkedMetaCampaign {
  metaId: string;
  name: string;
  status: string;
  spend: number;
  originalSpend: number;
  originalCurrency: string;
  needsRate: boolean;
  impressions: number;
  linkClicks: number;
}

/** What the marketing pages need to show the banners and the unlinked list. */
export interface MetaState {
  connected: boolean;
  currency: string;
  timezoneName: string;
  timezoneNote: boolean;
  accountStatus: number | null;
  lastSyncAt: string | null;
  lastSyncOkAt: string | null;
  lastError: { code: string; message: string; at: string } | null;
  paused: boolean;
  needsRate: boolean;
  unlinked?: UnlinkedMetaCampaign[];
  unlinkedSpend?: number;
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

export interface CampaignList { range: { from: string; to: string }; data: Campaign[]; meta?: MetaState }

export interface CampaignResultsRow extends ResultsRow { campaignId: string; name: string; code: string; platform: Platform; type: CampaignType; status: CampaignStatus }
export interface DailyPoint { day: string; visits: number; orders: number; sales: number; metaSpend?: number; metaNeedsRate?: boolean }
export interface Results {
  meta?: MetaState;
  range: { from: string; to: string };
  includeProfit: boolean;
  totals: ResultsRow;
  campaigns: CampaignResultsRow[];
  platforms: (ResultsRow & { platform: Platform })[];
  direct: ResultsRow;
  heardFrom: (ResultsRow & { answer: string })[];
  daily: DailyPoint[];
}
export interface CampaignResults { range: { from: string; to: string }; includeProfit: boolean; campaign: CampaignResultsRow | null; daily: DailyPoint[]; meta?: MetaState }

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

// --- Online Stage 7B: the Meta ad account connection (never carries the token or app secret, only their last 4 characters)
export interface MetaAccountInfo { name: string; currency: string; timezoneName: string; accountStatus: number; disableReason?: number }
export interface MetaConnectionView {
  connected: boolean;
  adAccountId: string | null;
  tokenLast4: string | null;
  hasAppSecret: boolean;
  appSecretLast4: string | null;
  account: MetaAccountInfo | null;
  accountStatusWarning: boolean;
  scopes: string[];
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastSyncOkAt: string | null;
  lastError: { code: string; message: string; at: string } | null;
  paused: boolean;
  syncing: boolean;
  nextManualSyncAt: string | null;
}
export interface MetaTestResult {
  ok: boolean;
  account: MetaAccountInfo;
  accountStatusWarning: boolean;
  scopes: string[];
  hasAdsRead: boolean;
  neverExpires: boolean;
  expiresAt: string | null;
}
export interface MetaConnectPayload { adAccountId: string; token?: string; appSecret?: string }
export interface MetaCampaignRow { metaId: string; name: string; status: string; objective: string; campaignId: string | null; linkedAt: string | null; suggested: boolean }
export interface ExchangeRateRow { _id: string; currency: string; rate: number; effectiveFrom: string; createdByName: string }
export interface ExchangeRates { currency: string | null; required: boolean; data: ExchangeRateRow[] }
