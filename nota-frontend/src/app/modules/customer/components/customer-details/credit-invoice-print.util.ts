import {
  buildInvoiceFooterHtml,
  buildInvoiceHeaderHtml,
  INVOICE_BRANDING_STYLES,
  InvoiceBranding
} from '../../../shop-profile/utils/invoice-branding.util';

export type CreditInvoicePrintLanguage = 'ar' | 'en';

import { InvoiceVatInfo, VAT_PRINT_CSS, customerTaxRow, exemptMark, taxInvoiceBanner, taxInvoiceTitle, vatTotalsHtml } from '../../../shared/vat/vat-print';

export type CreditInvoicePrintItem = {
  /** Stage 21: "معفى من الضريبة" (absent = taxable). */
  vatExempt?: boolean;
  id: string;
  productCode: string;
  productName: string;
  categoryName: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
};

export type CreditInvoicePrintData = {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  customerPhone: string;
  sellingDate: string | null;
  dueDate: string | null;
  statusLabel: string;
  itemCount: number;
  totalQuantity: number;
  subtotal: number;
  discountPercentage: number | null;
  shippingFees: number | null;
  totalPrice: number;
  paidAmount: number;
  remainingAmount: number;
  items: CreditInvoicePrintItem[];
  /** Stage 21: the VAT stored on the invoice (absent for an invoice saved with VAT off). */
  vat?: InvoiceVatInfo;
  /** Stage 21: the customer's tax number, when there is one (B2B). */
  customerTaxNumber?: string | null;
};

type CreditInvoiceDocumentLabels = {
  toolbarPrint: string;
  toolbarClose: string;
  customerSection: string;
  customerName: string;
  customerPhone: string;
  invoiceSection: string;
  invoiceNumber: string;
  invoiceDate: string;
  invoiceTime: string;
  dueDate: string;
  status: string;
  itemCount: string;
  totalQuantity: string;
  subtotal: string;
  discountPercentage: string;
  shippingFees: string;
  invoiceTotal: string;
  paidAmount: string;
  remainingAmount: string;
  tableIndex: string;
  tableCode: string;
  tableProduct: string;
  tableCategory: string;
  tableUnit: string;
  tableQuantity: string;
  tableUnitPrice: string;
  tableTotal: string;
};

export function buildCreditInvoiceDocument(params: {
  invoice: CreditInvoicePrintData;
  language: CreditInvoicePrintLanguage;
  branding: InvoiceBranding;
  /** Alexandria woff2 URLs (Arabic + Latin subsets) for the print document. */
  fontUrls: { arabic: string; latin: string };
}): string {
  const { invoice, language, branding, fontUrls } = params;
  const isArabic = language === 'ar';
  const direction = isArabic ? 'rtl' : 'ltr';
  const labels = getCreditInvoiceLabels(language);
  const invoiceNumber = escapeHtml(
    invoice.invoiceNumber || buildFallbackCreditInvoiceNumber(invoice.invoiceId || invoice.id)
  );
  const customerName = escapeHtml(invoice.customerName || getCreditInvoiceFallbackValue(language));
  const customerPhone = escapeHtml(invoice.customerPhone || getCreditInvoiceFallbackValue(language));
  const invoiceDate = formatCreditInvoiceDate(invoice.sellingDate, language);
  const invoiceTime = formatCreditInvoiceTime(invoice.sellingDate, language);
  const dueDate = formatCreditInvoiceDate(invoice.dueDate, language);
  const statusLabel = escapeHtml(invoice.statusLabel || getCreditInvoiceFallbackValue(language));
  const itemCount = formatCreditInvoiceMetric(invoice.itemCount, language);
  const totalQuantity = formatCreditInvoiceMetric(invoice.totalQuantity, language);
  const subtotal = formatCreditInvoiceMetric(invoice.subtotal, language);
  const hasDiscountPercentage = hasCreditInvoiceValue(invoice.discountPercentage);
  const hasShippingFees = hasCreditInvoiceValue(invoice.shippingFees);
  const discountPercentage = hasDiscountPercentage
    ? formatCreditInvoicePercentage(invoice.discountPercentage)
    : '';
  const shippingFees = hasShippingFees
    ? formatCreditInvoiceMetric(invoice.shippingFees, language)
    : '';
  const totalPrice = formatCreditInvoiceMetric(invoice.totalPrice, language);
  const paidAmount = formatCreditInvoiceMetric(invoice.paidAmount, language);
  const remainingAmount = formatCreditInvoiceMetric(invoice.remainingAmount, language);
  const unitLabel = isArabic ? 'قطعة' : 'Piece';
  const title = escapeHtml(taxInvoiceTitle(
    isArabic ? `فاتورة آجل ${invoiceNumber}` : `Credit Invoice ${invoiceNumber}`, invoice.vat, language
  ));
  const escapedArabicFontUrl = escapeCssString(fontUrls.arabic);
  const escapedLatinFontUrl = escapeCssString(fontUrls.latin);
  const tableRows = buildCreditInvoiceTableRows(invoice.items, language, unitLabel, invoice.vat);
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
        color: #232323;
        font-size: 44px;
        line-height: 1;
        font-weight: 900;
        font-variation-settings: 'wght' 900;
        margin-inline-start: 5rem;
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
        grid-template-columns: 96px 1fr;
      }

      .info-label,
      .info-value {
        padding: 6px 10px;
        border-top: 1px solid var(--invoice-border);
        font-size: 22px;
        line-height: 1.15;
      }

      .info-label {
        background: #f5f8fd;
        color: #20314b;
        font-weight: 700;
      }

      .summary-grid {
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
        ${taxInvoiceBanner(invoice.vat, language)}

        <section class="info-layout">
          <article class="info-card">
            <h2>${labels.customerSection}</h2>
            <div class="info-grid">
              <div class="info-label">${labels.customerName}</div>
              <div class="info-value">${customerName}</div>
              <div class="info-label">${labels.customerPhone}</div>
              <div class="info-value">${customerPhone}</div>
              ${customerTaxRow(invoice.customerTaxNumber, language)}
            </div>
          </article>

          <article class="info-card">
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
                <p class="summary-label">${labels.dueDate}</p>
                <p class="summary-value">${dueDate}</p>
              </div>
              <div class="summary-item">
                <p class="summary-label">${labels.status}</p>
                <p class="summary-value">${statusLabel}</p>
              </div>
              <div class="summary-item">
                <p class="summary-label">${labels.itemCount}</p>
                <p class="summary-value">${itemCount}</p>
              </div>
              <div class="summary-item">
                <p class="summary-label">${labels.totalQuantity}</p>
                <p class="summary-value">${totalQuantity}</p>
              </div>
              <div class="summary-item">
                <p class="summary-label">${labels.subtotal}</p>
                <p class="summary-value">${subtotal}</p>
              </div>
              ${discountSummaryItem}
              ${shippingSummaryItem}
              <div class="summary-item">
                <p class="summary-label">${labels.paidAmount}</p>
                <p class="summary-value">${paidAmount}</p>
              </div>
              <div class="summary-item">
                <p class="summary-label">${labels.remainingAmount}</p>
                <p class="summary-value">${remainingAmount}</p>
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
            ${vatTotalsHtml(invoice.vat, language, (value) => formatCreditInvoiceMetric(value, language))}
            <div>
              <span>${labels.invoiceTotal}</span>
              <strong>${totalPrice}</strong>
            </div>
            <div>
              <span>${labels.paidAmount}</span>
              <strong>${paidAmount}</strong>
            </div>
            <div class="grand-total">
              <span>${labels.remainingAmount}</span>
              <strong>${remainingAmount}</strong>
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

function getCreditInvoiceLabels(language: CreditInvoicePrintLanguage): CreditInvoiceDocumentLabels {
  if (language === 'ar') {
    return {
      toolbarPrint: 'طباعة / حفظ PDF',
      toolbarClose: 'إغلاق',
      customerSection: 'بيانات العميل',
      customerName: 'الاسم',
      customerPhone: 'التليفون',
      invoiceSection: 'فاتورة البيع الآجل',
      invoiceNumber: 'رقم الفاتورة',
      invoiceDate: 'التاريخ',
      invoiceTime: 'الوقت',
      dueDate: 'تاريخ الاستحقاق',
      status: 'الحالة',
      itemCount: 'عدد الأصناف',
      totalQuantity: 'إجمالي الكمية',
      subtotal: 'الإجمالي الفرعي',
      discountPercentage: 'نسبة الخصم',
      shippingFees: 'رسوم الشحن',
      invoiceTotal: 'إجمالي الفاتورة',
      paidAmount: 'المدفوع',
      remainingAmount: 'المتبقي',
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
    invoiceSection: 'Credit Invoice',
    invoiceNumber: 'Invoice Number',
    invoiceDate: 'Date',
    invoiceTime: 'Time',
    dueDate: 'Due Date',
    status: 'Status',
    itemCount: 'Items Count',
    totalQuantity: 'Total Quantity',
    subtotal: 'Subtotal',
    discountPercentage: 'Discount %',
    shippingFees: 'Shipping Fees',
    invoiceTotal: 'Invoice Total',
    paidAmount: 'Paid Amount',
    remainingAmount: 'Remaining Amount',
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

function buildFallbackCreditInvoiceNumber(id: string): string {
  const normalizedId = String(id || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (!normalizedId) {
    return 'INV-0000';
  }

  return `INV-${normalizedId.slice(-6)}`;
}

function formatCreditInvoiceDate(value: string | null, language: CreditInvoicePrintLanguage): string {
  const parsedDate = parseCreditInvoiceDate(value);
  if (!parsedDate) {
    return getCreditInvoiceFallbackValue(language);
  }

  return parsedDate.toLocaleDateString(language === 'ar' ? 'ar-EG' : 'en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

function formatCreditInvoiceTime(value: string | null, language: CreditInvoicePrintLanguage): string {
  if (!value || !/[T ]\d{2}:\d{2}/.test(value)) {
    return getCreditInvoiceFallbackValue(language);
  }

  const parsedDate = parseCreditInvoiceDate(value);
  if (!parsedDate) {
    return getCreditInvoiceFallbackValue(language);
  }

  return parsedDate.toLocaleTimeString(language === 'ar' ? 'ar-EG' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function parseCreditInvoiceDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }

  const parsedDate = new Date(value);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

function getCreditInvoiceFallbackValue(language: CreditInvoicePrintLanguage): string {
  return language === 'ar' ? 'غير متوفر' : 'N/A';
}

function formatCreditInvoiceNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '0.00';
  }

  return value.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2
  });
}

function formatCreditInvoiceMetric(
  value: number | null | undefined,
  language: CreditInvoicePrintLanguage
): string {
  if (!hasCreditInvoiceValue(value)) {
    return getCreditInvoiceFallbackValue(language);
  }

  return formatCreditInvoiceNumber(value);
}

function formatCreditInvoicePercentage(value: number | null | undefined): string {
  if (!hasCreditInvoiceValue(value)) {
    return '0%';
  }

  return `${formatCreditInvoiceNumber(value)}%`;
}

function hasCreditInvoiceValue(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value !== 0;
}

function buildCreditInvoiceTableRows(
  items: CreditInvoicePrintItem[],
  language: CreditInvoicePrintLanguage,
  unitLabel: string,
  vat?: InvoiceVatInfo
): string {
  const fallback = getCreditInvoiceFallbackValue(language);

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
      const quantity = formatCreditInvoiceMetric(item.quantity, language);
      const unitPrice = formatCreditInvoiceMetric(item.unitPrice, language);
      const totalPrice = formatCreditInvoiceMetric(item.totalPrice, language);

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
