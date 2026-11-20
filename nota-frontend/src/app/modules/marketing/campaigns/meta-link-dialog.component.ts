import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, effect, inject, input, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { Dialog } from 'primeng/dialog';
import { LayoutService } from '../../../core/layout/layout.service';
import { MobSheetComponent } from '../../mobile/mob-sheet.component';
import { NotaButtonDirective, NotaDialogShellComponent } from '../../shared/ui';
import { MetaCampaignRow } from '../marketing.models';
import { MarketingService } from '../marketing.service';

const KNOWN_ERRORS = ['ALREADY_LINKED', 'META_CAMPAIGN_NOT_FOUND', 'PLATFORM_NOT_LINKABLE', 'INVALID_META_CAMPAIGN'];

/**
 * Online Stage 7B: «اربط بحملة فيسبوك». Lists the synced Meta campaigns (search by name, status). A Meta campaign whose name contains the
 * Nota campaign's code comes first as «مقترح» (a suggestion only: nothing is linked automatically). A Meta campaign can belong to one Nota
 * campaign only; a Nota campaign can take several. Linking only labels data that was already read from Meta.
 */
@Component({
  selector: 'app-meta-link-dialog',
  imports: [FormsModule, NgTemplateOutlet, TranslatePipe, Dialog, NotaButtonDirective, NotaDialogShellComponent, MobSheetComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #body>
      <div class="ml">
        <input [class]="layout.isMobile() ? 'm-input' : 'nota-input'" type="search" name="metaSearch" data-test="meta-search" [placeholder]="'marketing.meta.link.search' | translate" [ngModel]="search()" (ngModelChange)="setSearch($event)" />
        <select [class]="layout.isMobile() ? 'm-input' : 'nota-select'" name="metaStatus" data-test="meta-status-filter" [ngModel]="status()" (ngModelChange)="setStatus($event)">
          <option value="">{{ 'marketing.campaigns.all' | translate }}</option>
          @for (s of statuses; track s) { <option [value]="s">{{ 'marketing.meta.link.statuses.' + s | translate }}</option> }
        </select>
        @if (error()) { <p class="nota-error" role="alert" data-test="meta-link-error">{{ error() | translate }}</p> }
        <div class="ml__list" data-test="meta-list">
          @for (row of rows(); track row.metaId) {
            <div class="ml__row" data-test="meta-row" [attr.data-meta-id]="row.metaId">
              <span class="ml__name" dir="auto">{{ row.name || row.metaId }}
                @if (row.suggested) { <span class="nota-pill nota-pill--ok" data-test="meta-suggested">{{ 'marketing.meta.link.suggested' | translate }}</span> }
              </span>
              <small>{{ row.status }}</small>
              @if (row.campaignId === campaignId()) {
                <span class="nota-pill" data-test="meta-here">{{ 'marketing.meta.link.linkedHere' | translate }}</span>
              } @else if (row.campaignId) {
                <span class="nota-pill nota-pill--overdue" data-test="meta-taken">{{ 'marketing.meta.link.linkedElsewhere' | translate }}</span>
              } @else {
                <button type="button" [class]="layout.isMobile() ? 'm-btn m-btn--primary' : 'nota-btn nota-btn--primary'" data-action="link-meta" [disabled]="busy()" (click)="link(row)">{{ 'marketing.meta.link.link' | translate }}</button>
              }
            </div>
          } @empty { <p class="ml__muted" data-test="meta-empty">{{ (loading() ? 'marketing.meta.link.loading' : 'marketing.meta.link.empty') | translate }}</p> }
        </div>
      </div>
    </ng-template>

    @if (layout.isMobile()) {
      <nota-mob-sheet [(open)]="visible" [title]="'marketing.meta.link.title' | translate">
        <ng-container *ngTemplateOutlet="body" />
        <div class="m-actions"><button type="button" class="m-btn" (click)="visible.set(false)">{{ 'mobile.common.close' | translate }}</button></div>
      </nota-mob-sheet>
    } @else {
      <p-dialog [(visible)]="visible" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog">
        <nota-dialog-shell [title]="'marketing.meta.link.title' | translate" [closeLabel]="'mobile.common.close' | translate" (closed)="visible.set(false)">
          <ng-container *ngTemplateOutlet="body" />
          <ng-container notaDialogFooter>
            <button type="button" notaButton (click)="visible.set(false)">{{ 'mobile.common.close' | translate }}</button>
          </ng-container>
        </nota-dialog-shell>
      </p-dialog>
    }
  `,
  styles: [`
    .ml { display: grid; gap: 10px; min-width: min(460px, 80vw); }
    .ml__list { display: flex; flex-direction: column; gap: 6px; max-height: 50vh; overflow-y: auto; }
    .ml__row { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--border, #e5e7eb); }
    .ml__name { overflow-wrap: anywhere; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .ml__muted { color: var(--text-muted, #6b7280); font-size: 13px; margin: 0; }
  `],
})
export class MetaLinkDialogComponent {
  readonly campaignId = input.required<string>();
  readonly visible = model(false);
  readonly changed = output<void>();

  protected readonly layout = inject(LayoutService);
  private readonly marketing = inject(MarketingService);
  protected readonly statuses = ['ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED'];

  protected readonly rows = signal<MetaCampaignRow[]>([]);
  protected readonly search = signal('');
  protected readonly status = signal('');
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => { if (this.visible()) { this.error.set(''); this.load(); } });
  }

  protected setSearch(value: string): void {
    this.search.set(value);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(), 250);
  }
  protected setStatus(value: string): void { this.status.set(value); this.load(); }

  private load(): void {
    this.loading.set(true);
    this.marketing.metaCampaigns({ campaignId: this.campaignId(), search: this.search().trim(), status: this.status() }).subscribe({
      next: (r) => { this.rows.set(r.data); this.loading.set(false); },
      error: () => { this.rows.set([]); this.loading.set(false); this.error.set('marketing.errors.GENERIC'); },
    });
  }

  protected link(row: MetaCampaignRow): void {
    if (this.busy()) return;
    this.busy.set(true); this.error.set('');
    this.marketing.linkMeta(this.campaignId(), row.metaId).subscribe({
      next: () => { this.busy.set(false); this.changed.emit(); this.load(); },
      error: (response) => {
        this.busy.set(false);
        const code = response?.error?.code;
        this.error.set(KNOWN_ERRORS.includes(code) ? `marketing.meta.link.errors.${code}` : 'marketing.errors.GENERIC');
        this.load();
      },
    });
  }
}
