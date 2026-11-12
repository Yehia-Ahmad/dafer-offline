import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ShopProfileService } from '../../modules/shop-profile/services/shop-profile.service';
import { AuthService } from '../auth/auth.service';
import { ToastService } from '../auth/toast.service';
import { DesktopPrintJob, getDesktopBridge } from '../runtime/runtime-config';
import { documentTestPage, receiptTestPage } from './documents/test-page';
import { PrintFontService } from './print-fonts.service';
import { PrintContext, PrintDocument, buildPrintHtml, toShopInfo } from './print-kit';
import { measureRollHeightMm, printInFrame } from './print-render';
import { PrintSettingsService } from './print-settings.service';

/**
 * What a screen asks for. `build` makes the document from the print context (the service calls it again with
 * the "نسخة" mark when the server says this is a reprint). `number` is the document number of a numbered
 * 80mm receipt or A4/A5 invoice/voucher: it is logged on the server (document.printed) BEFORE anything prints.
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
    return {
      lang: this.language(),
      shop: toShopInfo(profile),
      printedBy: this.auth.user()?.name || '',
      printedAt: new Date(),
      fontCss: await this.fonts.css(),
      copy: copy || null,
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
  async testPage(kind: 'receipt' | 'document'): Promise<PrintOutcome> {
    const bridge = getDesktopBridge()?.print;
    if (!bridge) return this.fail(this.translate.instant('print.desktopOnly'));
    try {
      const ctx = await this.context();
      const saved = await this.settings.load();
      const printer = (kind === 'receipt' ? saved?.receiptPrinter : saved?.documentPrinter) || '';
      const doc = kind === 'receipt' ? receiptTestPage(ctx, printer) : documentTestPage(ctx, printer);
      const heightMm = doc.paper === '80mm' ? await measureRollHeightMm(buildPrintHtml(ctx, doc)) : undefined;
      const result = await bridge.testPage(this.auth.token(), { kind, html: buildPrintHtml(ctx, doc, heightMm), heightMm });
      if (result.ok === false) return this.fail(result.error.message);
      return { ok: true, cancelled: Boolean(result.value?.cancelled) };
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  private async run(request: PrintRequest, mode: PrintMode, options: { quiet?: boolean }): Promise<PrintOutcome> {
    if (this.busy()) return { ok: false, message: '' };
    this.busy.set(true);
    try {
      let copy = 0;
      let ctx = await this.context(undefined, request.noShop);
      let doc = request.build(ctx);
      if (request.number) {
        const logged = await this.logPrint(request.number, doc.paper);
        copy = logged.copy;
        if (copy > 0) {
          ctx = await this.context({ n: copy, at: new Date(logged.printedAt) }, request.noShop);
          doc = request.build(ctx);
        }
      }
      let heightMm: number | undefined;
      if (doc.paper === '80mm') heightMm = await measureRollHeightMm(buildPrintHtml(ctx, doc));
      const html = buildPrintHtml(ctx, doc, heightMm);
      const job: DesktopPrintJob = { html, paper: doc.paper, heightMm, title: doc.title };
      const bridge = getDesktopBridge()?.print;
      if (!bridge) {
        await printInFrame(html); // dev browser: the browser's own print dialog
        return { ok: true, copy };
      }
      const token = this.auth.token();
      const result = mode === 'print' ? await bridge.print(token, job) : await bridge.savePdf(token, job, { suggestedName: doc.title });
      if (result.ok === false) return this.fail(result.error.message);
      const value = (result.value || {}) as { printed?: boolean; saved?: boolean; cancelled?: boolean; silent?: boolean; path?: string };
      if (mode === 'pdf') {
        if (value.saved) this.toast.show(this.translate.instant('print.saved'), 'success');
        return { ok: true, cancelled: !value.saved, copy };
      }
      if (value.printed && !options.quiet && value.silent) this.toast.show(this.translate.instant('print.sent'), 'success', 2500);
      return { ok: true, cancelled: Boolean(value.cancelled), silent: Boolean(value.silent), copy };
    } catch (error) {
      return this.fail(this.errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  private async logPrint(number: string, paper: string): Promise<{ copy: number; printedAt: string }> {
    const response = await firstValueFrom(this.http.post<{ copy: number; printedAt: string }>(`${environment.api_base_url}print/log`, { number, paper }));
    return { copy: Number(response.copy) || 0, printedAt: response.printedAt };
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
