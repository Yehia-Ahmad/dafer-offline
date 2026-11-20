import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LayoutService } from '../../../core/layout/layout.service';
import { MobileTopBarService } from '../../mobile/mobile-topbar.service';
import { NotaPageHeaderComponent } from '../../shared/ui';
import { Campaign, ImportField, ImportMapping, ImportPreview, ImportResult, LEAD_SOURCES, MAX_IMPORT_ROWS } from '../marketing.models';
import { MarketingService } from '../marketing.service';
import { LeadFileError, ParsedFile, parseLeadFile } from './lead-file';

const FIELDS: ImportField[] = ['name', 'phone', 'createdTime', 'campaignName', 'adName', 'platform', 'profileLink'];
const EMPTY_MAPPING = (): ImportMapping => ({ name: null, phone: null, createdTime: null, campaignName: null, adName: null, platform: null, profileLink: null });

/**
 * Online Stage 7A: /marketing/leads/import. A CSV or XLSX exported from Meta Lead Ads or TikTok lead forms: the columns are mapped
 * automatically (and can be fixed), the preview says what would happen to every row, nothing is written until the user confirms.
 */
@Component({
  selector: 'app-lead-import',
  imports: [FormsModule, NgTemplateOutlet, RouterLink, TranslatePipe, NotaPageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #body>
      <p class="li__muted">{{ 'marketing.import.intro' | translate: { max: max } }}</p>
      <label class="li__f">{{ 'marketing.import.file' | translate }}
        <input type="file" accept=".csv,.xlsx,.txt" name="file" data-test="import-file" (change)="onFile($event)" />
      </label>
      @if (error()) { <p class="nota-error" role="alert" data-test="import-error">{{ error() | translate }}</p> }

      @if (file(); as f) {
        <h2 class="li__h">{{ 'marketing.import.mapping' | translate }} <small class="nota-num">({{ f.rows.length }})</small></h2>
        @for (field of fields; track field) {
          <label class="li__f">{{ 'marketing.import.field.' + field | translate }}@if (field === 'name' || field === 'phone') { * }
            <select [class]="select()" [name]="'map-' + field" [attr.data-field]="field" [ngModel]="mapping()[field] ?? ''" (ngModelChange)="setMap(field, $event)">
              <option value="">— {{ 'marketing.import.notMapped' | translate }}</option>
              @for (h of f.headers; track h) { <option [value]="h">{{ h }}</option> }
            </select>
          </label>
        }
        <label class="li__f">{{ 'marketing.import.defaultSource' | translate }}
          <select [class]="select()" name="source" data-test="import-source" [ngModel]="source()" (ngModelChange)="source.set($event); invalidate()">
            @for (s of sources; track s) { <option [value]="s">{{ 'marketing.leadSource.' + s | translate }}</option> }
          </select>
        </label>
        <fieldset class="li__f">
          <legend>{{ 'marketing.import.existing' | translate }}</legend>
          <label><input type="radio" name="mode" value="skip" data-test="mode-skip" [ngModel]="mode()" (ngModelChange)="mode.set($event); invalidate()" /> {{ 'marketing.import.skip' | translate }}</label>
          <label><input type="radio" name="mode" value="update" data-test="mode-update" [ngModel]="mode()" (ngModelChange)="mode.set($event); invalidate()" /> {{ 'marketing.import.update' | translate }}</label>
        </fieldset>
        <label class="li__f">{{ 'marketing.import.attach' | translate }}
          <select [class]="select()" name="campaignId" data-test="import-campaign" [ngModel]="campaignId()" (ngModelChange)="campaignId.set($event)">
            <option value="">—</option>
            @for (c of campaigns(); track c._id) { <option [value]="c._id">{{ c.name }}</option> }
          </select>
        </label>
        <div class="li__actions">
          <button type="button" [class]="btn()" data-action="preview" [disabled]="!mapped() || busy()" (click)="preview()">{{ 'marketing.import.preview' | translate }}</button>
        </div>
      }

      @if (previewData(); as p) {
        <h2 class="li__h">{{ 'marketing.import.previewTitle' | translate }}</h2>
        <p data-test="preview-summary">{{ 'marketing.import.summary' | translate: p.summary }}</p>
        @for (row of p.rows; track row.index) {
          <div class="li__row" data-test="preview-row" [attr.data-status]="row.status"><span class="nota-num">{{ row.index + 2 }}</span><span dir="auto">{{ row.name }}</span><span class="nota-num" dir="ltr">{{ row.phone || '—' }}</span><span class="nota-pill">{{ 'marketing.import.status.' + row.status | translate }}</span></div>
        }
        <div class="li__actions">
          <button type="button" [class]="btnPrimary()" data-action="confirm-import" [disabled]="busy() || (p.summary.imported + p.summary.updated) === 0" (click)="commit()">{{ 'marketing.import.confirm' | translate }}</button>
        </div>
      }

      @if (result(); as r) {
        <div class="li__result" data-test="import-result" role="status">
          <strong>{{ 'marketing.import.done' | translate }}</strong>
          <span>{{ 'marketing.import.summary' | translate: r }}</span>
          @for (bad of r.invalidRows; track bad.index) { <small class="nota-num">{{ bad.index + 2 }}: {{ 'marketing.import.reason.' + bad.reason | translate }}</small> }
          <a [routerLink]="['/marketing/leads']" data-action="to-leads">{{ 'marketing.import.toLeads' | translate }}</a>
        </div>
      }
    </ng-template>

    @if (layout.isMobile()) {
      <div class="m-page"><div class="m-card li__stack"><ng-container *ngTemplateOutlet="body" /></div></div>
    } @else {
      <div class="li">
        <nota-page-header [title]="'marketing.import.title' | translate" />
        <section class="nota-card li__stack"><ng-container *ngTemplateOutlet="body" /></section>
      </div>
    }
  `,
  styles: [`
    .li { display: flex; flex-direction: column; gap: 16px; max-width: 720px; }
    .li__stack { display: flex; flex-direction: column; gap: 12px; }
    .li__f { display: flex; flex-direction: column; gap: 4px; font-size: 13px; border: 0; padding: 0; margin: 0; }
    .li__h { font-size: 16px; margin: 8px 0 0; }
    .li__muted { color: var(--text-muted, #6b7280); margin: 0; }
    .li__row { display: grid; grid-template-columns: 36px 1fr auto auto; gap: 8px; align-items: center; font-size: 13px; }
    .li__row[data-status='invalid'] { color: var(--danger, #b91c1c); }
    .li__row[data-status='skip'] { opacity: .6; }
    .li__actions { display: flex; gap: 8px; }
    .li__result { display: flex; flex-direction: column; gap: 6px; }
  `],
})
export class LeadImportComponent implements OnInit {
  protected readonly layout = inject(LayoutService);
  private readonly marketing = inject(MarketingService);
  private readonly translate = inject(TranslateService);
  protected readonly fields = FIELDS;
  protected readonly sources = LEAD_SOURCES;
  protected readonly max = MAX_IMPORT_ROWS;

  protected readonly file = signal<ParsedFile | null>(null);
  protected readonly mapping = signal<ImportMapping>(EMPTY_MAPPING());
  protected readonly mode = signal<'skip' | 'update'>('skip');
  protected readonly source = signal('facebook');
  protected readonly campaignId = signal('');
  protected readonly campaigns = signal<Campaign[]>([]);
  protected readonly previewData = signal<ImportPreview | null>(null);
  protected readonly result = signal<ImportResult | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly mapped = computed(() => !!this.mapping().name && !!this.mapping().phone);
  protected readonly btn = computed(() => (this.layout.isMobile() ? 'm-btn' : 'nota-btn'));
  protected readonly btnPrimary = computed(() => (this.layout.isMobile() ? 'm-btn m-btn--primary' : 'nota-btn nota-btn--primary'));
  protected readonly select = computed(() => (this.layout.isMobile() ? 'm-input' : 'nota-select'));

  private readonly bindTopBar = inject(MobileTopBarService).bind(() => this.layout.isMobile() ? { title: this.translate.instant('marketing.import.title'), hideTabs: true } : null);

  ngOnInit(): void {
    this.marketing.campaigns().subscribe({ next: (r) => this.campaigns.set(r.data), error: () => this.campaigns.set([]) });
  }

  protected setMap(field: ImportField, header: string): void {
    this.mapping.update((m) => ({ ...m, [field]: header || null }));
    this.invalidate();
  }

  protected invalidate(): void { this.previewData.set(null); this.result.set(null); }

  protected async onFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const picked = input.files?.[0];
    this.file.set(null); this.invalidate(); this.error.set('');
    if (!picked) return;
    try {
      const parsed = await parseLeadFile(picked.name, await picked.arrayBuffer());
      this.file.set(parsed);
      this.mapping.set(EMPTY_MAPPING());
      this.marketing.importMapping(parsed.headers).subscribe({ next: (r) => this.mapping.set({ ...EMPTY_MAPPING(), ...r.mapping }) });
    } catch (error) {
      this.error.set(error instanceof LeadFileError ? `marketing.import.errors.${error.code}` : 'marketing.import.errors.UNREADABLE');
    }
  }

  private body() {
    return { rows: this.file()?.rows ?? [], mapping: this.mapping(), mode: this.mode(), source: this.source(), ...(this.campaignId() ? { campaignId: this.campaignId() } : {}) };
  }

  private fail(response: { error?: { code?: string } }): void {
    this.busy.set(false);
    const code = response?.error?.code;
    this.error.set(code && ['NO_ROWS', 'TOO_MANY_ROWS', 'MAPPING_REQUIRED', 'INVALID_CAMPAIGN', 'INVALID_SOURCE'].includes(code) ? `marketing.import.errors.${code}` : 'marketing.errors.GENERIC');
  }

  protected preview(): void {
    if (!this.mapped() || this.busy()) return;
    this.busy.set(true); this.error.set(''); this.result.set(null);
    this.marketing.importPreview(this.body()).subscribe({ next: (p) => { this.previewData.set(p); this.busy.set(false); }, error: (r) => this.fail(r) });
  }

  protected commit(): void {
    if (this.busy()) return;
    this.busy.set(true); this.error.set('');
    this.marketing.importCommit(this.body()).subscribe({ next: (r) => { this.result.set(r); this.previewData.set(null); this.busy.set(false); }, error: (r) => this.fail(r) });
  }
}
