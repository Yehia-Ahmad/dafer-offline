import {
  buildInvoiceFooterHtml,
  buildInvoiceHeaderHtml,
  INVOICE_BRANDING_STYLES,
  InvoiceBranding
} from '../../../shop-profile/utils/invoice-branding.util';

export type InvoiceHistoryItem = {
  /** Stage 21: "معفى من الضريبة" (absent = taxable). */
  vatExempt?: boolean;
  id: string;
  invoiceId: string;
  productId: string;
  productCode: string;
  productName: string;
  categoryName: string;
  customerName: string;
  customerPhone: string;
  sellingDate: string | null;
  quantity: number | null;
  returnedQuantity?: number | null;
  unitPrice: number | null;
  totalPrice: number | null;
};

export type InvoiceHistoryRow = {
  id: string;
  /** Stage 14: who created the invoice (sent by the backend with auth on). Display only. */
  createdByName?: string | null;
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  customerPhone: string;
  // customerAddress: string;
  sellingDate: string | null;
  itemCount: number | null;
  totalQuantity: number | null;
  subtotal: number | null;
  discountAmount: number | null;
  discountPercentage: number | null;
  shippingFees: number | null;
  totalPrice: number | null;
  netTotal?: number | null;
  /** Stage 21: the VAT stored on the invoice (absent for an invoice saved with VAT off). */
  vat?: InvoiceVatInfo;
  /** Stage 21: the customer's tax number, when the invoice has one (B2B). */
  customerTaxNumber?: string | null;
  status?: 'active' | 'cancelled' | string;
  cancellationReason?: string | null;
  /** Display only: the box that paid a cancelled cash sale's refund. */
  cancelRefundAmount?: number | null;
  cancelRefundBoxName?: string | null;
  items: InvoiceHistoryItem[];
  /** Display only (Stage 10 detail panel); not used by the print. */
  refundStatus?: 'none' | 'partial' | 'full' | string;
  refundedAmount?: number | null;
  refunds?: Array<{ id: string; refundDate: string | null; totalAmount: number | null; items: Array<{ productName: string; quantity: number | null }> }>;
};

export type InvoicePrintLanguage = 'ar' | 'en';

import { InvoiceVatInfo, VAT_PRINT_CSS, customerTaxRow, exemptMark, taxInvoiceBanner, taxInvoiceTitle, vatTotalsHtml } from '../../../shared/vat/vat-print';

type InvoiceDocumentLabels = {
  toolbarPrint: string;
  toolbarClose: string;
  customerSection: string;
  customerName: string;
  customerPhone: string;
  invoiceSection: string;
  invoiceNumber: string;
  invoiceDate: string;
  invoiceTime: string;
  itemCount: string;
  totalQuantity: string;
  subtotal: string;
  discountPercentage: string;
  shippingFees: string;
  invoiceTotal: string;
  tableIndex: string;
  tableCode: string;
  tableProduct: string;
  tableCategory: string;
  tableUnit: string;
  tableQuantity: string;
  tableUnitPrice: string;
  tableTotal: string;
};

export function buildInvoiceDocument(params: {
  selling: InvoiceHistoryRow;
  language: InvoicePrintLanguage;
  branding: InvoiceBranding;
  /** Alexandria woff2 URLs (Arabic + Latin subsets) for the print document. */
  fontUrls: { arabic: string; latin: string };
}): string {
  const { selling, language, branding, fontUrls } = params;
  const isArabic = language === 'ar';
  const direction = isArabic ? 'rtl' : 'ltr';
  const labels = getInvoiceLabels(language);
  const invoiceNumber = escapeHtml(
    selling.invoiceNumber || buildFallbackInvoiceNumber(selling.invoiceId || selling.id)
  );
  const customerName = escapeHtml(selling.customerName || getInvoiceFallbackValue(language));
  const customerPhone = escapeHtml(selling.customerPhone || getInvoiceFallbackValue(language));
  const invoiceDate = formatInvoiceDate(selling.sellingDate, language);
  const invoiceTime = formatInvoiceTime(selling.sellingDate, language);
  const itemCount = formatInvoiceMetric(selling.itemCount, language);
  const totalQuantity = formatInvoiceMetric(selling.totalQuantity, language);
  const subtotal = formatInvoiceMetric(selling.subtotal ?? selling.totalPrice, language);
  const hasDiscountPercentage = hasInvoiceValue(selling.discountPercentage);
  const hasShippingFees = hasInvoiceValue(selling.shippingFees);
  const discountPercentage = hasDiscountPercentage
    ? formatInvoicePercentage(selling.discountPercentage)
    : '';
  const shippingFees = hasShippingFees
    ? formatInvoiceMetric(selling.shippingFees, language)
    : '';
  const totalPrice = formatInvoiceMetric(selling.totalPrice, language);
  const unitLabel = isArabic ? 'قطعة' : 'Piece';
  const title = taxInvoiceTitle(isArabic ? `فاتورة ${invoiceNumber}` : `Invoice ${invoiceNumber}`, selling.vat, language);
  const escapedArabicFontUrl = escapeCssString(fontUrls.arabic);
  const escapedLatinFontUrl = escapeCssString(fontUrls.latin);
  const tableRows = buildInvoiceTableRows(selling.items, language, unitLabel, selling.vat);
  const discountSummaryItem = hasDiscountPercentage
    ? `<div class="summary-item">
                <p class="summary-label">${labels.discountPercentage}</p>
                <p class="summary-value">${discountPercentage}</p>
              </div>`
    : '';
  const shippingSummaryItem = hasShippingFees
    ? `<div class="summary-item">
                <p class="summary-label">${labels.shippingFees}</p>
                <p class="summary-value">${shippingFees}</p>
              </div>`
    : '';
  const discountTotalItem = hasDiscountPercentage
    ? `<div>
              <span>${labels.discountPercentage}</span>
              <strong>${discountPercentage}</strong>
            </div>`
    : '';
  const shippingTotalItem = hasShippingFees
    ? `<div>
              <span>${labels.shippingFees}</span>
              <strong>${shippingFees}</strong>
            </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="${language}" dir="${direction}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      @font-face {
        font-family: 'Alexandria';
        src: url("${escapedArabicFontUrl}") format('woff2');
        font-weight: 100 900;
        font-style: normal;
        font-display: swap;
        unicode-range: U+0600-06FF, U+0750-077F, U+0870-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FEFC;
      }

      @font-face {
        font-family: 'Alexandria';
        src: url("${escapedLatinFontUrl}") format('woff2');
        font-weight: 100 900;
        font-style: normal;
        font-display: swap;
        unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
      }

      :root {
        color-scheme: light;
        --invoice-blue: #0d6efd;
        --invoice-red: #8b0b1a;
        --invoice-border: #c9d3e6;
        --invoice-muted: #566074;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        padding: 24px;
        background: #eef2f8;
        color: #132238;
        font-family: 'Alexandria', Tahoma, Arial, sans-serif;
      }

      .screen-toolbar {
        display: flex;
        justify-content: flex-end;
        gap: 12px;
        margin-bottom: 18px;
      }

      .screen-toolbar button {
        border: 0;
        border-radius: 999px;
        padding: 10px 18px;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
      }

      .screen-toolbar .primary {
        background: var(--invoice-blue);
        color: #fff;
      }

      .screen-toolbar .secondary {
        background: #d9e1ef;
        color: #132238;
      }

      .invoice-sheet {
        width: 100%;
        max-width: 1100px;
        margin: 0 auto;
        background: #fff;
        border: 1px solid var(--invoice-border);
        border-radius: 24px;
        overflow: hidden;
        box-shadow: 0 18px 45px rgba(15, 35, 60, 0.12);
      }

      .invoice-body {
        padding: 28px;
      }

      .invoice-header {
        display: grid;
        direction: ltr;
        grid-template-columns: 160px 1fr;
        gap: 24px;
        align-items: center;
        padding-bottom: 22px;
        border-bottom: 1px solid var(--invoice-border);
      }

      .logo-box {
        height: 160px;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        border: 1px solid var(--invoice-border);
        border-radius: 20px;
        background:
          linear-gradient(135deg, rgba(13, 110, 253, 0.06), rgba(255, 255, 255, 0.85)),
          linear-gradient(45deg, rgba(139, 11, 26, 0.04), rgba(255, 255, 255, 0.96));
      }

      .logo-box img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
      }

      .company-heading {
        display: flex;
        flex-direction: column;
        gap: 8px;
        direction: ${direction};
        text-align: ${isArabic ? 'right' : 'left'};
      }

      .company-name {
        margin: 0;
        color: var(--invoice-red);
        font-size: 44px;
        line-height: 1;
        font-weight: 900;
        font-variation-settings: 'wght' 900;
      }

      .company-subtitle,
      .company-meta {
        margin: 0;
        color: #233248;
        font-size: 16px;
      }

      .company-meta {
        color: var(--invoice-muted);
      }
${INVOICE_BRANDING_STYLES}
      .info-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(320px, 1.08fr);
        gap: 10px;
        margin-top: 12px;
        align-items: start;
      }

      .info-card {
        border: 1px solid var(--invoice-border);
        border-radius: 14px;
        overflow: hidden;
        background: #fff;
      }

      .info-card h2 {
        margin: 0;
        padding: 6px 10px;
        background: linear-gradient(135deg, #0d6efd, #2b7cff);
        color: #fff;
        font-size: 13px;
        line-height: 1.2;
        font-weight: 800;
      }

      .info-grid {
        display: grid;
        grid-template-columns: 190px 1fr;
      }

      .info-card--customer .info-grid {
        grid-template-columns: 96px 1fr;
      }

      .info-label,
      .info-value {
        padding: 6px 10px;
        border-top: 1px solid var(--invoice-border);
        font-size: 12px;
        line-height: 1.15;
      }

      .info-label {
        background: #f5f8fd;
        color: #20314b;
        font-weight: 700;
      }

      .info-card--invoice .summary-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .summary-item {
        display: flex;
        flex-direction: column;
        align-items: ${isArabic ? 'flex-end' : 'flex-start'};
        justify-content: center;
        gap: 3px;
        padding: 8px 10px;
        border-top: 1px solid var(--invoice-border);
        border-inline-start: 1px solid var(--invoice-border);
        min-height: 50px;
      }

      .summary-item:nth-child(3n + 1) {
        border-inline-start: 0;
      }

      .summary-label {
        margin: 0;
        color: var(--invoice-muted);
        font-size: 10px;
        font-weight: 700;
        line-height: 1.1;
        width: 100%;
        text-align: ${isArabic ? 'right' : 'left'};
      }

      .summary-value {
        margin: 0;
        color: #10233f;
        font-size: 13px;
        line-height: 1.15;
        font-weight: 800;
        width: 100%;
        text-align: ${isArabic ? 'right' : 'left'};
        white-space: normal;
        overflow-wrap: anywhere;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 16px;
      }

      th,
      td {
        border: 1px solid var(--invoice-border);
        padding: 14px 12px;
        text-align: ${isArabic ? 'right' : 'left'};
      }

      thead th {
        background: linear-gradient(135deg, #0d6efd, #2b7cff);
        color: #fff;
        font-size: 14px;
        font-weight: 800;
      }

      tbody td {
        font-size: 15px;
      }

      tbody tr:nth-child(even) td {
        background: #f7faff;
      }

      .total-row {
        display: flex;
        justify-content: ${isArabic ? 'flex-start' : 'flex-end'};
        margin-top: 18px;
      }

      .total-box {
        min-width: 320px;
        border: 1px solid var(--invoice-border);
        border-radius: 18px;
        overflow: hidden;
      }

      .total-box div {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 18px;
        font-size: 16px;
      }

      .total-box div + div {
        border-top: 1px solid var(--invoice-border);
      }

      .total-box .grand-total {
        background: #f5f8fd;
        font-size: 20px;
        font-weight: 800;
      }

      .invoice-note {
        margin-top: 18px;
        color: var(--invoice-muted);
        font-size: 14px;
        text-align: center;
      }

      @page {
        size: A4;
        margin: 12mm;
      }

      @media print {
        body {
          padding: 0;
          background: #fff;
        }

        .screen-toolbar {
          display: none;
        }

        .invoice-sheet {
          max-width: none;
          border-radius: 0;
          box-shadow: none;
          border: 0;
        }
      }
${VAT_PRINT_CSS}    </style>
  </head>
  <body>
    <div class="screen-toolbar">
      <button class="primary" type="button" onclick="window.print()">${labels.toolbarPrint}</button>
      <button class="secondary" type="button" onclick="window.close()">${labels.toolbarClose}</button>
    </div>

    <main class="invoice-sheet">
      <section class="invoice-body">
        ${buildInvoiceHeaderHtml(branding)}
        ${taxInvoiceBanner(selling.vat, language)}

        <section class="info-layout">
          <article class="info-card info-card--customer">
            <h2>${labels.customerSection}</h2>
            <div class="info-grid">
              <div class="info-label">${labels.customerName}</div>
              <div class="info-value">${customerName}</div>
              <div class="info-label">${labels.customerPhone}</div>
              <div class="info-value">${customerPhone}</div>
              ${customerTaxRow(selling.customerTaxNumber, language)}
            </div>
          </article>

          <article class="info-card info-card--invoice">
            <h2>${labels.invoiceSection}</h2>
            <div class="summary-grid">
              <div class="summary-item">
                <p class="summary-label">${labels.invoiceNumber}</p>
                <p class="summary-value">${invoiceNumber}</p>
              </div>
              <div class="summary-item">
                <p class="summary-label">${labels.invoiceDate}</p>
                <p class="summary-value">${invoiceDate}</p>
              </div>
              <div class="summary-item">
                <p class="summary-label">${labels.invoiceTime}</p>
                <p class="summary-value">${invoiceTime}</p>
              </div>
              <div class="summary-item">
                <p class="summary-label">${labels.itemCount}</p>
                <p class="summary-value">${itemCount}</p>
              </div>
              <div class="summary-item">
                <p class="summary-label">${labels.totalQuantity}</p>
                <p class="summary-value">${totalQuantity}</p>
              </div>
              ${discountSummaryItem}
              ${shippingSummaryItem}
              <div class="summary-item">
                <p class="summary-label">${labels.invoiceTotal}</p>
                <p class="summary-value">${totalPrice}</p>
              </div>
            </div>
          </article>
        </section>

        <table>
          <thead>
            <tr>
              <th>${labels.tableIndex}</th>
              <th>${labels.tableCode}</th>
              <th>${labels.tableProduct}</th>
              <th>${labels.tableCategory}</th>
              <th>${labels.tableUnit}</th>
              <th>${labels.tableQuantity}</th>
              <th>${labels.tableUnitPrice}</th>
              <th>${labels.tableTotal}</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>

        <div class="total-row">
          <div class="total-box">
            <div>
              <span>${labels.subtotal}</span>
              <strong>${subtotal}</strong>
            </div>
            ${discountTotalItem}
            ${shippingTotalItem}
            ${vatTotalsHtml(selling.vat, language, (value) => formatInvoiceMetric(value, language))}
            <div class="grand-total">
              <span>${labels.invoiceTotal}</span>
              <strong>${totalPrice}</strong>
            </div>
          </div>
        </div>

        ${buildInvoiceFooterHtml(branding)}
      </section>
    </main>

    <script>
      window.addEventListener('load', function () {
        window.setTimeout(function () {
          window.print();
        }, 250);
      });
    </script>
  </body>
</html>`;
}

export function buildFallbackInvoiceNumber(id: string): string {
  const normalizedId = String(id || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (!normalizedId) {
    return 'INV-0000';
  }

  return `INV-${normalizedId.slice(-6)}`;
}

function getInvoiceLabels(language: InvoicePrintLanguage): InvoiceDocumentLabels {
  if (language === 'ar') {
    return {
      toolbarPrint: 'طباعة / حفظ PDF',
      toolbarClose: 'إغلاق',
      customerSection: 'بيانات العميل',
      customerName: 'الاسم',
      customerPhone: 'التليفون',
      invoiceSection: 'الفاتورة',
      invoiceNumber: 'رقم الفاتورة',
      invoiceDate: 'التاريخ',
      invoiceTime: 'الوقت',
      itemCount: 'عدد الأصناف',
      totalQuantity: 'إجمالي الكمية',
      subtotal: 'الإجمالي الفرعي',
      discountPercentage: 'نسبة الخصم',
      shippingFees: 'رسوم الشحن',
      invoiceTotal: 'الإجمالي',
      tableIndex: 'م',
      tableCode: 'الكود',
      tableProduct: 'الصنف',
      tableCategory: 'الفئة',
      tableUnit: 'الوحدة',
      tableQuantity: 'الكمية',
      tableUnitPrice: 'السعر',
      tableTotal: 'الإجمالي'
    };
  }

  return {
    toolbarPrint: 'Print / Save PDF',
    toolbarClose: 'Close',
    customerSection: 'Customer Details',
    customerName: 'Name',
    customerPhone: 'Phone',
    invoiceSection: 'Invoice',
    invoiceNumber: 'Invoice Number',
    invoiceDate: 'Date',
    invoiceTime: 'Time',
    itemCount: 'Items Count',
    totalQuantity: 'Total Quantity',
    subtotal: 'Subtotal',
    discountPercentage: 'Discount %',
    shippingFees: 'Shipping Fees',
    invoiceTotal: 'Total',
    tableIndex: '#',
    tableCode: 'Code',
    tableProduct: 'Product',
    tableCategory: 'Category',
    tableUnit: 'Unit',
    tableQuantity: 'Qty',
    tableUnitPrice: 'Unit Price',
    tableTotal: 'Total'
  };
}

function formatInvoiceDate(value: string | null, language: InvoicePrintLanguage): string {
  const parsedDate = parseInvoiceDate(value);
  if (!parsedDate) {
    return getInvoiceFallbackValue(language);
  }

  return parsedDate.toLocaleDateString(language === 'ar' ? 'ar-EG' : 'en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

function formatInvoiceTime(value: string | null, language: InvoicePrintLanguage): string {
  if (!value || !/[T ]\d{2}:\d{2}/.test(value)) {
    return getInvoiceFallbackValue(language);
  }

  const parsedDate = parseInvoiceDate(value);
  if (!parsedDate) {
    return getInvoiceFallbackValue(language);
  }

  return parsedDate.toLocaleTimeString(language === 'ar' ? 'ar-EG' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function parseInvoiceDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }

  const parsedDate = new Date(value);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

function getInvoiceFallbackValue(language: InvoicePrintLanguage): string {
  return language === 'ar' ? 'غير متوفر' : 'N/A';
}

function formatInvoiceNumber(value: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '0.00';
  }

  return value.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2
  });
}

function formatInvoiceMetric(value: number | null, language: InvoicePrintLanguage): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return getInvoiceFallbackValue(language);
  }

  return formatInvoiceNumber(value);
}

function formatInvoicePercentage(value: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '0%';
  }

  return `${formatInvoiceNumber(value)}%`;
}

function hasInvoiceValue(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value !== 0;
}

function buildInvoiceTableRows(
  items: InvoiceHistoryItem[],
  language: InvoicePrintLanguage,
  unitLabel: string,
  vat?: InvoiceVatInfo
): string {
  const fallback = getInvoiceFallbackValue(language);

  if (!items.length) {
    return `<tr>
      <td>1</td>
      <td>${fallback}</td>
      <td>${fallback}</td>
      <td>${fallback}</td>
      <td>${unitLabel}</td>
      <td>${fallback}</td>
      <td>${fallback}</td>
      <td>${fallback}</td>
    </tr>`;
  }

  return items
    .map((item, index) => {
      const productCode = escapeHtml(item.productCode || fallback);
      const productName = escapeHtml(item.productName || fallback) + exemptMark(item.vatExempt, vat, language);
      const categoryName = escapeHtml(item.categoryName || fallback);
      const quantity = formatInvoiceMetric(item.quantity, language);
      const unitPrice = formatInvoiceMetric(item.unitPrice, language);
      const totalPrice = formatInvoiceMetric(item.totalPrice, language);

      return `<tr>
        <td>${index + 1}</td>
        <td>${productCode}</td>
        <td>${productName}</td>
        <td>${categoryName}</td>
        <td>${unitLabel}</td>
        <td>${quantity}</td>
        <td>${unitPrice}</td>
        <td>${totalPrice}</td>
      </tr>`;
    })
    .join('');
}

function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeCssString(value: string): string {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}
