import { ShopProfile } from '../models/shop-profile.model';

// Header and footer of the printed invoices (cash and credit). The shop's own details come
// from the shop profile; without one the invoice gets a neutral header with no logo or brand.

export type InvoiceBrandingTexts = {
  /** Shown as the header title when there is no shop profile, e.g. "Sales Invoice". */
  neutralTitle: string;
  /** Always printed at the very bottom, without any brand name. */
  systemNote: string;
  taxNumberLabel: string;
  commercialRegisterLabel: string;
};

export type InvoiceBranding = {
  /** null when no profile is saved or it could not be loaded. */
  shop: ShopProfile | null;
  texts: InvoiceBrandingTexts;
};

/** The profile to print, or null when it has no name (nothing saved yet). */
export function toPrintableShop(profile: ShopProfile | null | undefined): ShopProfile | null {
  return profile && typeof profile.name === 'string' && profile.name.trim() ? profile : null;
}

/** CSS shared by both invoices for the parts this helper renders. */
export const INVOICE_BRANDING_STYLES = `
      .invoice-header--no-logo {
        grid-template-columns: 1fr;
      }

      .company-details {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin: 0;
        padding: 0;
        list-style: none;
        color: #233248;
        font-size: 15px;
      }

      .invoice-footer-text {
        margin: 24px 0 0;
        color: #233248;
        font-size: 15px;
        text-align: center;
        white-space: pre-line;
      }
`;

export function buildInvoiceHeaderHtml(branding: InvoiceBranding): string {
  const shop = toPrintableShop(branding.shop);

  if (!shop) {
    return `<header class="invoice-header invoice-header--no-logo">
          <div class="company-heading">
            <h1 class="company-name">${escapeHtml(branding.texts.neutralTitle)}</h1>
          </div>
        </header>`;
  }

  const logoSrc = toImageSrc(shop.logo);
  const phones = (shop.phones || []).map((phone) => String(phone || '').trim()).filter(Boolean);
  const details = [
    textOrEmpty(shop.address),
    phones.length ? phones.join(' - ') : '',
    textOrEmpty(shop.taxNumber) ? `${branding.texts.taxNumberLabel}: ${shop.taxNumber.trim()}` : '',
    textOrEmpty(shop.commercialRegister)
      ? `${branding.texts.commercialRegisterLabel}: ${shop.commercialRegister.trim()}`
      : '',
  ].filter(Boolean);

  const logoBox = logoSrc
    ? `<div class="logo-box">
            <img src="${escapeHtml(logoSrc)}" alt="${escapeHtml(shop.name)}" />
          </div>

          `
    : '';
  const detailList = details.length
    ? `
            <ul class="company-details">
              ${details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join('\n              ')}
            </ul>`
    : '';

  return `<header class="invoice-header${logoSrc ? '' : ' invoice-header--no-logo'}">
          ${logoBox}<div class="company-heading">
            <h1 class="company-name">${escapeHtml(shop.name.trim())}</h1>${detailList}
          </div>
        </header>`;
}

export function buildInvoiceFooterHtml(branding: InvoiceBranding): string {
  const footer = textOrEmpty(toPrintableShop(branding.shop)?.invoiceFooter);
  const footerText = footer ? `<p class="invoice-footer-text">${escapeHtml(footer)}</p>\n        ` : '';
  return `${footerText}<p class="invoice-note">${escapeHtml(branding.texts.systemNote)}</p>`;
}

function textOrEmpty(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toImageSrc(logo: string | null | undefined): string {
  const value = textOrEmpty(logo);
  if (!value) return '';
  // The backend accepts raw base64 as well as data URIs.
  return value.startsWith('data:image/') ? value : `data:image/png;base64,${value}`;
}

function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
