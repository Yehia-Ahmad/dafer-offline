import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ShopProfileService } from '../../modules/shop-profile/services/shop-profile.service';
import { AuthService } from '../auth/auth.service';
import { ToastService } from '../auth/toast.service';
import { DesktopPrintJob, getDesktopBridge } from '../runtime/runtime-config';
import { documentTestPage, receiptCalibrationPage, receiptTestPage } from './documents/test-page';
import { PrintFontService } from './print-fonts.service';
import { VatSettingsService } from '../../modules/shop-profile/services/vat-settings.service';
import { LabelEntry, LabelLimitError, LabelVat, planLabelJob, productLabelRoll, productLabelSheet } from './documents/product-label';
import { LabelOptions, LabelRollSettings, LabelSheetSettings, DEFAULT_LABEL_OPTIONS, normalizeLabelOptions, normalizeRoll, normalizeSheet } from './label-layout';
import { PrintContext, PrintDocument, buildPrintHtml, labelPageSize, toShopInfo } from './print-kit';
import { measureRollHeightMm, printInFrame } from './print-render';
import { PrintSettingsService } from './print-settings.service';

/**
 * What a screen asks for. `build` makes the document from the print context (the service calls it again with
 * the "نسخة" mark when the server says this is a reprint). `number` is the document number of a numbered
 * 80mm receipt or A4/A5 invoice/voucher. Copies are RESERVED, then confirmed or released:
 *   reserve (the server takes the next number of that document and class: 1 = the original, 2+ = reprints, marked "نسخة")
 *   -> render -> print / save the PDF -> confirm on success (3 retries with backoff, then a warning toast: the counter is
 *   already advanced, so the next print is correctly a copy), release on cancel or failure (the number goes back).
 * The dev browser reserves before window.print() and confirms when the dialog opens.
 */
export interface PrintRequest {
  build: (ctx: PrintContext) => PrintDocument;
  number?: string;
  /** The document has no shop data (the recovery code sheet: the shop may not exist yet and nobody is signed in): the profile is not read. */
  noShop?: boolean;
}

export type PrintMode = 'print' | 'pdf';
export type PrintOutcome = { ok: true; cancelled?: boolean; silent?: boolean; copy?: number } | { ok: false; message: string };

/** Stage 23: the one print pipeline: context → document → (log) → HTML → Electron print / PDF, or the dev-browser fallback. */
@Injectable({ providedIn: 'root' })
export class PrintService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly shop = inject(ShopProfileService);
  private readonly translate = inject(TranslateService);
  private readonly fonts = inject(PrintFontService);
  private readonly toast = inject(ToastService);
  private readonly settings = inject(PrintSettingsService);
  private readonly vatSettings = inject(VatSettingsService);

  /** True while a print is being prepared (buttons disable themselves). */
  readonly busy = signal(false);

  /** The print language is the UI language (Arabic RTL or English LTR). */
  language(): 'ar' | 'en' {
    return (this.translate.currentLang || this.translate.defaultLang) === 'en' ? 'en' : 'ar';
  }

  async context(copy?: PrintContext['copy'], skipShop = false): Promise<PrintContext> {
    let profile = skipShop ? null : this.shop.profile();
    if (!profile && !skipShop) {
      try {
        profile = await firstValueFrom(this.shop.getProfile());
      } catch {
        profile = null; // a neutral header without shop data
      }
    }
    const saved = this.settings.settings() ?? (await this.settings.load());
    return {
      lang: this.language(),
      shop: toShopInfo(profile),
      printedBy: this.auth.user()?.name || '',
      printedAt: new Date(),
      fontCss: await this.fonts.css(),
      copy: copy || null,
      receipt: { widthMm: saved?.receiptWidthMm ?? 80, offsetMm: saved?.receiptOffsetMm ?? 0 },
    };
  }

  /** "طباعة". */
  print(request: PrintRequest, options: { quiet?: boolean } = {}): Promise<PrintOutcome> {
    return this.run(request, 'print', options);
  }

  /** "حفظ PDF" (a real vector PDF through the desktop app's save dialog). */
  savePdf(request: PrintRequest): Promise<PrintOutcome> {
    return this.run(request, 'pdf', {});
  }

  /** After a sale: prints the receipt only when this PC has "اطبع الإيصال تلقائي بعد البيع" on. Never throws, never blocks the sale. */
  async autoPrintReceipt(load: () => PrintRequest | Promise<PrintRequest>): Promise<PrintOutcome | null> {
    try {
      const current = await this.settings.load();
      if (!current || !current.autoPrintReceipt) return null;
      return await this.print(await load());
    } catch {
      return null;
    }
  }

  /** "اطبع صفحة تجربة": straight to the printer chosen in the settings (shop.manage, checked in the desktop app). */
  async testPage(kind: 'receipt' | 'document', printer?: string): Promise<PrintOutcome> {
    const bridge = getDesktopBridge()?.print;
    if (!bridge) return this.fail(this.translate.instant('print.desktopOnly'));
    try {
      const ctx = await this.context();
      // The printer picked in the dropdown right now is sent with the request; the saved one only when none is given.
      if (printer === undefined) {
        const saved = await this.settings.load();
        printer = (kind === 'receipt' ? saved?.receiptPrinter : saved?.documentPrinter) || '';
      }
      const doc = kind === 'receipt' ? receiptTestPage(ctx, printer) : documentTestPage(ctx, printer);
      const heightMm = doc.paper === '80mm' ? await measureRollHeightMm(buildPrintHtml(ctx, doc)) : undefined;
      const result = await bridge.testPage(this.auth.token(), { kind, html: buildPrintHtml(ctx, doc, heightMm), heightMm, printer });
      if (result.ok === false) return this.fail(result.error.message);
      return { ok: true, cancelled: Boolean(result.value?.cancelled) };
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  /** Stage 25: the receipt printer calibration sheet (ruler in mm, shop header, Arabic and English text, Code 128, a long item line, a cut line). */
  async calibrationPage(printer?: string): Promise<PrintOutcome> {
    const bridge = getDesktopBridge()?.print;
    if (!bridge) return this.fail(this.translate.instant('print.desktopOnly'));
    try {
      const ctx = await this.context();
      if (printer === undefined) printer = (await this.settings.load())?.receiptPrinter || '';
      const doc = receiptCalibrationPage(ctx, printer);
      const heightMm = await measureRollHeightMm(buildPrintHtml(ctx, doc));
      const result = await bridge.testPage(this.auth.token(), { kind: 'receipt', html: buildPrintHtml(ctx, doc, heightMm), heightMm, printer });
      if (result.ok === false) return this.fail(result.error.message);
      return { ok: true, cancelled: Boolean(result.value?.cancelled) };
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  // ---------------------------------------------------------------- Stage 26: product labels

  /** Today's VAT display rule for a label price (null: VAT off, or not started yet). */
  private labelVat(): LabelVat | null {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const vat = this.vatSettings.contextFor(today);
    return vat ? { enabled: true, rate: vat.rate, pricesIncludeVat: vat.included } : null;
  }

  /** This PC's label settings (roll, sheet, remembered options), normalised; the defaults outside the desktop app. */
  async labelSettings(): Promise<{ roll: LabelRollSettings; sheet: LabelSheetSettings; options: LabelOptions; printer: string }> {
    const saved = this.settings.settings() ?? (await this.settings.load());
    return {
      roll: normalizeRoll(saved?.labelRoll),
      sheet: normalizeSheet(saved?.labelSheet),
      options: normalizeLabelOptions(this.settings.savedLabelOptions ?? DEFAULT_LABEL_OPTIONS),
      printer: saved?.labelPrinter || '',
    };
  }

  /**
   * "اطبع ملصقات": the labels of `entries` on the label roll or on A4 sticker sheets (options.target). Not a numbered
   * document: no copy counter, no audit entry. Over 2,000 labels is refused with a clear message.
   */
  async printLabels(entries: LabelEntry[], options: LabelOptions, extra: { startAt?: number } = {}): Promise<PrintOutcome> {
    const job = planLabelJob(entries);
    if (job.tooMany) return this.fail(this.translate.instant('labels.tooMany', { max: 2000, total: job.total }));
    if (!job.total) return this.fail(this.translate.instant('labels.nothing'));
    const vat = this.labelVat();
    const saved = await this.labelSettings();
    const build = (ctx: PrintContext): PrintDocument => {
      try {
        return options.target === 'sheet'
          ? productLabelSheet(ctx, job.entries, { sheet: saved.sheet, options, startAt: extra.startAt, vat })
          : productLabelRoll(ctx, job.entries, { roll: saved.roll, options, vat });
      } catch (error) {
        if (error instanceof LabelLimitError) throw new Error(this.translate.instant('labels.tooMany', { max: 2000, total: error.total }));
        throw error;
      }
    };
    return this.print({ build }, { quiet: false });
  }

  /** "اطبع ملصق تجربة" on the label printer (the printer picked now, or the saved one). */
  async labelTestPage(printer?: string): Promise<PrintOutcome> {
    const bridge = getDesktopBridge()?.print;
    if (!bridge) return this.fail(this.translate.instant('print.desktopOnly'));
    try {
      const ctx = await this.context();
      const saved = await this.labelSettings();
      const sample = { name: this.translate.instant('labels.sampleName'), code: 'TEST-1', barcode: '2000000000015', retailPrice: 123.5, wholesalePrice: 100, priceAfterDiscount: 111.15, vatExempt: false };
      const doc = productLabelRoll(ctx, [{ item: sample, copies: 1 }], { roll: saved.roll, options: { ...saved.options, target: 'roll', internalCode: true }, vat: this.labelVat() });
      const result = await bridge.testPage(this.auth.token(), { kind: 'label', html: buildPrintHtml(ctx, doc), labelPage: labelPageSize(doc), printer });
      if (result.ok === false) return this.fail(result.error.message);
      return { ok: true, cancelled: Boolean(result.value?.cancelled) };
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  /** "اطبع ورقة اختبار الحدود": label borders only, on plain A4, to check the sticker sheet alignment. */
  async outlineSheet(printer?: string): Promise<PrintOutcome> {
    const bridge = getDesktopBridge()?.print;
    if (!bridge) return this.fail(this.translate.instant('print.desktopOnly'));
    try {
      const ctx = await this.context();
      const saved = await this.labelSettings();
      const doc = productLabelSheet(ctx, [], { sheet: saved.sheet, options: saved.options, outline: true });
      const result = await bridge.testPage(this.auth.token(), { kind: 'sheet', html: buildPrintHtml(ctx, doc), printer });
      if (result.ok === false) return this.fail(result.error.message);
      return { ok: true, cancelled: Boolean(result.value?.cancelled) };
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  private async run(request: PrintRequest, mode: PrintMode, options: { quiet?: boolean }): Promise<PrintOutcome> {
    if (this.busy()) return { ok: false, message: '' };
    this.busy.set(true);
    let reservation: { id: string; copyNo: number } | null = null;
    let settled = false;
    /** Confirms (the print / PDF save went out) or releases (cancelled, failed) the reserved copy number, once. */
    const settle = async (printed: boolean): Promise<void> => {
      if (!reservation || settled) return;
      settled = true;
      if (printed) await this.confirmWithRetry(reservation.id);
      else await this.releaseQuietly(reservation.id);
    };
    try {
      let ctx = await this.context(undefined, request.noShop);
      let doc = request.build(ctx);
      if (request.number) {
        reservation = await this.reserve(request.number, doc.paper);
        // copyNo 1 is the original; 2 and up are reprints ("نسخة n", n = the copy number, the same as the audit).
        if (reservation.copyNo > 1) {
          ctx = await this.context({ n: reservation.copyNo, at: new Date() }, request.noShop);
          doc = request.build(ctx);
        }
      }
      const copy = (): number => (reservation ? reservation.copyNo : 0);
      let heightMm: number | undefined;
      if (doc.paper === '80mm') heightMm = await measureRollHeightMm(buildPrintHtml(ctx, doc));
      const html = buildPrintHtml(ctx, doc, heightMm);
      const job: DesktopPrintJob = { html, paper: doc.paper, heightMm, title: doc.title };
      if (doc.paper === 'label') job.labelPage = labelPageSize(doc);
      if (doc.paper === 'A4' && doc.fullBleed) job.noMargins = true;
      const bridge = getDesktopBridge()?.print;
      if (!bridge) {
        // Dev browser: the browser's own print dialog (it cannot tell us whether the user printed): confirmed when the dialog opens.
        await printInFrame(html);
        await settle(true);
        return { ok: true, copy: copy() };
      }
      const token = this.auth.token();
      const result = mode === 'print' ? await bridge.print(token, job) : await bridge.savePdf(token, job, { suggestedName: doc.title });
      if (result.ok === false) {
        await settle(false);
        return this.fail(result.error.message);
      }
      const value = (result.value || {}) as { printed?: boolean; saved?: boolean; cancelled?: boolean; silent?: boolean; path?: string };
      if (mode === 'pdf') {
        // Confirmed only when the file was really saved; a cancelled save dialog releases the number.
        await settle(Boolean(value.saved));
        if (value.saved) this.toast.show(this.translate.instant('print.saved'), 'success');
        return { ok: true, cancelled: !value.saved, copy: copy() };
      }
      // Confirmed only when Electron's print callback said success; a cancelled dialog releases the number.
      await settle(Boolean(value.printed));
      if (value.printed && !options.quiet && value.silent) this.toast.show(this.translate.instant('print.sent'), 'success', 2500);
      return { ok: true, cancelled: Boolean(value.cancelled), silent: Boolean(value.silent), copy: copy() };
    } catch (error) {
      await settle(false); // no-op when it was already confirmed
      return this.fail(this.errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  /** Takes the next copy number of this document and paper class (1 = the original). Written down on the server as a reservation. */
  private async reserve(number: string, paper: string): Promise<{ id: string; copyNo: number }> {
    const paperClass = paper === '80mm' ? 'receipt' : 'page';
    const response = await firstValueFrom(this.http.post<{ reservationId: string; copyNo: number }>(`${environment.api_base_url}print/reserve`, { number, paperClass }));
    return { id: response.reservationId, copyNo: Math.max(1, Number(response.copyNo) || 1) };
  }

  /** Delays (ms) between the retries of a failed confirm: 3 retries with a growing wait. */
  confirmRetryDelaysMs: number[] = [300, 900, 2000];

  /** The print really went out: record it. 3 retries with backoff (none for 403 / 404 / 409); if it still fails the user is told (the counter is already advanced, so the next print is correctly a copy). */
  private async confirmWithRetry(reservationId: string): Promise<void> {
    for (let attempt = 0; attempt <= this.confirmRetryDelaysMs.length; attempt += 1) {
      try {
        await firstValueFrom(this.http.post(`${environment.api_base_url}print/confirm`, { reservationId }));
        return;
      } catch (error) {
        // 403 / 404 / 409 can never succeed on a retry (not allowed, unknown reservation, already released): warn at once.
        const status = (error as { status?: number })?.status;
        if (status === 403 || status === 404 || status === 409) break;
        if (attempt < this.confirmRetryDelaysMs.length) await new Promise((resolve) => setTimeout(resolve, this.confirmRetryDelaysMs[attempt]));
      }
    }
    this.toast.show(this.translate.instant('print.notRecorded'), 'error', 10000);
  }

  /** Cancelled or failed: give the number back. A failed release is harmless (the number stays counted: a gap is an over-count, the safe side). */
  private async releaseQuietly(reservationId: string): Promise<void> {
    try {
      await firstValueFrom(this.http.post(`${environment.api_base_url}print/release`, { reservationId }));
    } catch {
      /* stays reserved */
    }
  }

  private errorMessage(error: unknown): string {
    const http = error as { error?: { message?: string }; message?: string };
    return (http && http.error && http.error.message) || (error instanceof Error ? error.message : '') || this.translate.instant('print.failed');
  }

  private fail(message: string): PrintOutcome {
    const text = message || this.translate.instant('print.failed');
    this.toast.error(text);
    return { ok: false, message: text };
  }
}
