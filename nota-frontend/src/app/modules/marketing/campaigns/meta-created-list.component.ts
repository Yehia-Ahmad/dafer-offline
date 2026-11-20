import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { Observable } from 'rxjs';
import { NotaCanDirective } from '../../../core/auth/nota-can.directive';
import { LayoutService } from '../../../core/layout/layout.service';
import { MetaCampaignRow, PublishOptions } from '../marketing.models';
import { MarketingService } from '../marketing.service';
import { PUBLISH_ERROR_CODES } from './meta-publish-wizard.component';

const MANAGE_ERROR_CODES = [...PUBLISH_ERROR_CODES, 'CONFIRM_REQUIRED', 'CAMPAIGN_CLOSED', 'NOT_CREATED_BY_NOTA', 'INVALID_STATUS'];

/**
 * Online Stage 7C: the Facebook campaigns Nota created for this campaign, with «تشغيل» / «إيقاف», the budget, the end date and «أرشفة»
 * (marketing.publish). Campaigns that were only synced from Meta are NOT here: they stay read-only (manage them in Ads Manager).
 * «تشغيل» opens a confirmation that says in words and numbers what will be spent; the button stays disabled until the box is ticked.
 */
@Component({
  selector: 'app-meta-created-list',
  imports: [FormsModule, DatePipe, DecimalPipe, TranslatePipe, NotaCanDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (row of rows(); track row.metaId) {
      <div class="mc" data-test="meta-created-row" [attr.data-meta-id]="row.metaId" [attr.data-status]="row.status">
        <div class="mc__head">
          <span dir="auto" class="mc__name" data-test="created-name">{{ displayName(row) }}</span>
          <span [class]="row.status === 'ACTIVE' ? 'nota-pill nota-pill--ok' : 'nota-pill'" data-test="created-status">{{ statusKey(row.status) | translate }}</span>
        </div>
        <small class="mc__muted" data-test="created-budget">
          @if (row.dailyBudgetMinor) { {{ 'marketing.publish.budget.daily' | translate }}: <b class="nota-num">{{ row.dailyBudgetMinor / 100 | number: '1.0-2' }} {{ currency() }}</b> }
          @else if (row.lifetimeBudgetMinor) { {{ 'marketing.publish.budget.lifetime' | translate }}: <b class="nota-num">{{ row.lifetimeBudgetMinor / 100 | number: '1.0-2' }} {{ currency() }}</b> }
          @if (row.endTime) { · {{ 'marketing.publish.manage.endsOn' | translate }} <b class="nota-num">{{ row.endTime | date: 'd/M/yyyy HH:mm' }}</b> }
        </small>
        <div class="mc__actions" *notaCan="'marketing.publish'">
          @if (isOpen(row)) {
            @if (row.status === 'ACTIVE') { <button type="button" [class]="btn()" data-action="meta-pause" [disabled]="busy()" (click)="pause(row)">{{ 'marketing.publish.manage.pause' | translate }}</button> }
            @else { <button type="button" [class]="btnPrimary()" data-action="meta-switch-on" [disabled]="busy()" (click)="askSwitchOn(row)">{{ 'marketing.publish.manage.switchOn' | translate }}</button> }
            <button type="button" [class]="btn()" data-action="meta-edit-budget" [disabled]="busy()" (click)="startEdit(row, 'budget')">{{ 'marketing.publish.manage.budget' | translate }}</button>
            <button type="button" [class]="btn()" data-action="meta-edit-end" [disabled]="busy()" (click)="startEdit(row, 'end')">{{ 'marketing.publish.manage.endDate' | translate }}</button>
            <button type="button" [class]="btn()" data-action="meta-archive" [disabled]="busy()" (click)="archiveAsk.set(row.metaId)">{{ 'marketing.publish.manage.archive' | translate }}</button>
          }
        </div>
        @if (editing()?.metaId === row.metaId) {
          <div class="mc__edit" data-test="meta-edit">
            @if (editing()!.kind === 'budget') {
              <label class="mc__f">{{ 'marketing.publish.manage.newBudget' | translate }} ({{ currency() }})
                <input [class]="input() + ' nota-num'" type="number" min="1" step="0.01" name="newBudget" data-test="new-budget" [ngModel]="editValue()" (ngModelChange)="editValue.set($event)" />
              </label>
              @if (options()) { <small class="mc__muted" data-test="manage-ceiling">{{ 'marketing.publish.budget.ceilingDaily' | translate: { amount: options()!.ceiling.dailyEgp } }} · {{ 'marketing.publish.budget.ceilingTotal' | translate: { amount: options()!.ceiling.totalEgp } }}</small> }
            } @else {
              <label class="mc__f">{{ 'marketing.publish.manage.newEnd' | translate }}
                <input [class]="input() + ' nota-num'" type="datetime-local" name="newEnd" data-test="new-end" [ngModel]="editValue()" (ngModelChange)="editValue.set($event)" />
              </label>
            }
            <div class="mc__actions">
              <button type="button" [class]="btn()" (click)="editing.set(null)">{{ 'mobile.common.cancel' | translate }}</button>
              <button type="button" [class]="btnPrimary()" data-action="meta-edit-save" [disabled]="busy() || !editValue()" (click)="saveEdit(row)">{{ 'mobile.common.save' | translate }}</button>
            </div>
          </div>
        }
        @if (archiveAsk() === row.metaId) {
          <div class="mc__confirm" role="alertdialog" data-test="archive-confirm">
            <p>{{ 'marketing.publish.manage.archiveConfirm' | translate }}</p>
            <div class="mc__actions">
              <button type="button" [class]="btn()" (click)="archiveAsk.set('')">{{ 'mobile.common.cancel' | translate }}</button>
              <button type="button" [class]="btnPrimary()" data-action="meta-archive-yes" [disabled]="busy()" (click)="archive(row)">{{ 'marketing.publish.manage.archive' | translate }}</button>
            </div>
          </div>
        }
        @if (switchOn()?.metaId === row.metaId) {
          <div class="mc__confirm mc__confirm--money" role="alertdialog" aria-modal="true" data-test="switch-on-confirm">
            <p data-test="switch-on-text"><strong>{{ 'marketing.publish.manage.confirmTitle' | translate }}</strong><br />{{ spendText(switchOn()!) }}</p>
            <p class="mc__muted">{{ 'marketing.publish.manage.confirmPay' | translate }}</p>
            <label class="mc__check"><input type="checkbox" name="understand" data-test="switch-on-understand" [ngModel]="understood()" (ngModelChange)="understood.set($event)" /> {{ 'marketing.publish.manage.confirmCheck' | translate }}</label>
            <div class="mc__actions">
              <button type="button" [class]="btn()" data-action="switch-on-cancel" (click)="closeSwitchOn()">{{ 'mobile.common.cancel' | translate }}</button>
              <button type="button" [class]="btnPrimary()" data-action="switch-on-yes" [disabled]="busy() || !understood()" (click)="confirmSwitchOn(row)">{{ 'marketing.publish.manage.switchOn' | translate }}</button>
            </div>
          </div>
        }
      </div>
    }
    @if (error()) { <p class="nota-error" role="alert" data-test="meta-manage-error">{{ error() | translate }}</p> }
    @if (rows().length) { <p class="mc__muted" data-test="meta-read-only-note">{{ 'marketing.publish.manage.readOnlyNote' | translate }}</p> }
  `,
  styles: [`
    :host { display: block; }
    .mc { display: flex; flex-direction: column; gap: 6px; padding: 8px 0; border-bottom: 1px solid var(--border, #e5e7eb); }
    .mc__head { display: flex; gap: 8px; justify-content: space-between; align-items: center; flex-wrap: wrap; }
    .mc__name { overflow-wrap: anywhere; }
    .mc__muted { color: var(--text-muted, #6b7280); font-size: 12px; margin: 0; }
    .mc__actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .mc__edit, .mc__confirm { display: grid; gap: 8px; padding: 10px 12px; border-radius: 8px; background: var(--surface-muted, #f1f5f9); }
    .mc__confirm--money { background: #fef3c7; }
    .mc__f { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
    .mc__check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; }
  `],
})
export class MetaCreatedListComponent implements OnInit {
  readonly campaignId = input.required<string>();
  readonly rows = input.required<MetaCampaignRow[]>();
  readonly changed = output<void>();

  protected readonly layout = inject(LayoutService);
  private readonly marketing = inject(MarketingService);

  protected readonly options = signal<PublishOptions | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly editing = signal<{ metaId: string; kind: 'budget' | 'end' } | null>(null);
  protected readonly editValue = signal<string | number | null>(null);
  protected readonly archiveAsk = signal('');
  protected readonly switchOn = signal<MetaCampaignRow | null>(null);
  protected readonly understood = signal(false);

  protected readonly currency = computed(() => this.options()?.currency ?? '');
  protected readonly input = computed(() => (this.layout.isMobile() ? 'm-input' : 'nota-input'));
  protected readonly btn = computed(() => (this.layout.isMobile() ? 'm-btn' : 'nota-btn'));
  protected readonly btnPrimary = computed(() => (this.layout.isMobile() ? 'm-btn m-btn--primary' : 'nota-btn nota-btn--primary'));

  ngOnInit(): void {
    // Only the currency and the ceiling are needed here; a user without marketing.publish gets a 403 and simply sees no actions.
    this.marketing.publishOptions(this.campaignId()).subscribe({ next: (o) => this.options.set(o), error: () => this.options.set(null) });
  }

  /** The name Meta holds ends with Nota's hidden tag [nota:<id>] (used to find the campaign again after a timeout): never shown. */
  protected displayName(row: MetaCampaignRow): string { return (row.name || row.metaId).replace(/\s*\[nota:[a-f0-9]+\]\s*$/, ''); }

  protected isOpen(row: MetaCampaignRow): boolean { return !['ARCHIVED', 'DELETED'].includes(row.status); }
  protected statusKey(status: string): string { return `marketing.meta.link.statuses.${['ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED'].includes(status) ? status : 'PAUSED'}`; }

  /** «هيتصرف لحد 300 جنيه في اليوم من بطاقة حساب الإعلانات» (or the total and the end date), in the account's currency. */
  protected spendText(row: MetaCampaignRow): string {
    const currency = this.currency();
    const daily = row.dailyBudgetMinor ? row.dailyBudgetMinor / 100 : 0;
    const total = row.lifetimeBudgetMinor ? row.lifetimeBudgetMinor / 100 : 0;
    const unit = currency === 'EGP' ? 'جنيه' : currency;
    if (daily) return `هيتصرف لحد ${daily} ${unit} في اليوم من بطاقة حساب الإعلانات`;
    const end = row.endTime ? new Date(row.endTime) : null;
    const date = end ? ` لحد ${end.getDate()}/${end.getMonth() + 1}/${end.getFullYear()}` : '';
    return `هيتصرف لحد ${total} ${unit} إجمالًا${date} من بطاقة حساب الإعلانات`;
  }

  private fail(response: { error?: { code?: string } }): void {
    this.busy.set(false);
    const code = response?.error?.code ?? '';
    this.error.set(MANAGE_ERROR_CODES.includes(code) ? `marketing.publish.errors.${code}` : 'marketing.errors.GENERIC');
  }

  private done(): void { this.busy.set(false); this.error.set(''); this.editing.set(null); this.archiveAsk.set(''); this.closeSwitchOn(); this.changed.emit(); }

  protected askSwitchOn(row: MetaCampaignRow): void { this.error.set(''); this.understood.set(false); this.switchOn.set(row); }
  protected closeSwitchOn(): void { this.switchOn.set(null); this.understood.set(false); }

  protected confirmSwitchOn(row: MetaCampaignRow): void {
    if (this.busy() || !this.understood()) return;
    this.busy.set(true); this.error.set('');
    this.marketing.metaSetStatus(this.campaignId(), row.metaId, 'ACTIVE', true).subscribe({ next: () => this.done(), error: (response) => { this.closeSwitchOn(); this.fail(response); } });
  }

  protected pause(row: MetaCampaignRow): void {
    if (this.busy()) return;
    this.busy.set(true); this.error.set('');
    this.marketing.metaSetStatus(this.campaignId(), row.metaId, 'PAUSED').subscribe({ next: () => this.done(), error: (response) => this.fail(response) });
  }

  protected startEdit(row: MetaCampaignRow, kind: 'budget' | 'end'): void {
    this.error.set(''); this.editValue.set(null);
    this.editing.set({ metaId: row.metaId, kind });
  }

  protected saveEdit(row: MetaCampaignRow): void {
    const edit = this.editing();
    if (!edit || this.busy() || !this.editValue()) return;
    this.busy.set(true); this.error.set('');
    const call: Observable<unknown> = edit.kind === 'budget'
      ? this.marketing.metaSetBudget(this.campaignId(), row.metaId, Number(this.editValue()))
      : this.marketing.metaSetEndTime(this.campaignId(), row.metaId, String(this.editValue()));
    call.subscribe({ next: () => this.done(), error: (response) => this.fail(response) });
  }

  protected archive(row: MetaCampaignRow): void {
    if (this.busy()) return;
    this.busy.set(true); this.error.set('');
    this.marketing.metaArchive(this.campaignId(), row.metaId).subscribe({ next: () => this.done(), error: (response) => this.fail(response) });
  }
}
