import { DatePipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { NotaCanDirective } from '../../../core/auth/nota-can.directive';
import { LayoutService } from '../../../core/layout/layout.service';
import { MobileTopBarService } from '../../mobile/mobile-topbar.service';
import { NotaButtonDirective, NotaPageHeaderComponent } from '../../shared/ui';
import { LEAD_STATUSES, LeadDetail, LeadPurchaseDoc } from '../marketing.models';
import { MarketingService } from '../marketing.service';

/**
 * Online Stage 7A: /marketing/leads/:id. A WhatsApp button, a call button, "اشترى؟" (computed when the page loads from the lead's phone and
 * creation date: website orders, cash and credit sales; never stored) and the notes history.
 */
@Component({
  selector: 'app-lead-page',
  imports: [FormsModule, NgTemplateOutlet, RouterLink, DatePipe, DecimalPipe, TranslatePipe, NotaCanDirective, NotaButtonDirective, NotaPageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #body>
      @if (lead(); as l) {
        <div class="lp__contact">
          @if (l.whatsappLink) { <a [class]="btn()" data-action="whatsapp" [href]="l.whatsappLink" target="_blank" rel="noopener noreferrer">{{ 'marketing.leads.whatsapp' | translate }}</a> }
          @if (l.callLink) { <a [class]="btn()" data-action="call" [href]="l.callLink">{{ 'marketing.leads.call' | translate }}</a> }
          @if (l.profileLink) { <a [class]="btn()" data-action="profile" [href]="l.profileLink" target="_blank" rel="noopener noreferrer">{{ 'marketing.leads.profile' | translate }}</a> }
        </div>
        <dl class="lp__facts">
          <dt>{{ 'marketing.leads.phone' | translate }}</dt><dd class="nota-num" dir="ltr">{{ l.phone || '—' }}</dd>
          <dt>{{ 'marketing.leads.source' | translate }}</dt><dd>{{ 'marketing.leadSource.' + l.source | translate }}</dd>
          <dt>{{ 'marketing.leads.campaign' | translate }}</dt><dd>{{ l.campaignName || '—' }}</dd>
          <dt>{{ 'marketing.leads.lastContact' | translate }}</dt><dd class="nota-num">{{ l.lastContactDate ? (l.lastContactDate | date: 'mediumDate') : '—' }}</dd>
          <dt>{{ 'marketing.leads.created' | translate }}</dt><dd class="nota-num">{{ l.createdAt | date: 'mediumDate' }}</dd>
        </dl>
        @if (l.notes) { <p class="lp__notes" dir="auto">{{ l.notes }}</p> }
        <label class="lp__status" *notaCan="'leads.manage'">{{ 'marketing.leads.status' | translate }}
          <select [class]="select()" name="status" data-test="lead-status" [ngModel]="l.status" (ngModelChange)="setStatus($event)">
            @for (s of statuses; track s) { <option [value]="s">{{ 'marketing.leadStatus.' + s | translate }}</option> }
          </select>
        </label>

        <h2 class="lp__h">{{ 'marketing.leads.bought' | translate }}</h2>
        @if (l.purchases.bought) {
          <p data-test="bought"><span class="nota-pill nota-pill--ok">{{ 'marketing.leads.boughtYes' | translate }}</span>
            {{ 'marketing.leads.boughtSummary' | translate: { count: l.purchases.count, total: (l.purchases.total | number: '1.0-2') } }}</p>
          @for (doc of l.purchases.documents; track doc.id) {
            <div class="lp__doc" data-test="purchase-doc">
              <span>{{ 'marketing.leads.docType.' + doc.type | translate }} <strong class="nota-num">{{ doc.number }}</strong></span>
              <span class="nota-num">{{ doc.date | date: 'mediumDate' }}</span>
              <strong class="nota-num">{{ doc.total | number: '1.0-2' }}</strong>
              @if (docLink(doc); as link) { <a [routerLink]="link">{{ 'marketing.leads.openDoc' | translate }}</a> }
            </div>
          }
        } @else { <p class="lp__muted" data-test="not-bought">{{ 'marketing.leads.boughtNo' | translate }}</p> }

        <h2 class="lp__h">{{ 'marketing.leads.noteHistory' | translate }}</h2>
        @for (n of l.noteLog ?? []; track $index) {
          <div class="lp__note" data-test="note-row"><small class="nota-num">{{ n.at | date: 'short' }} · {{ n.byName }}</small><span dir="auto">{{ n.text }}</span></div>
        } @empty { <p class="lp__muted">{{ 'marketing.leads.noNotes' | translate }}</p> }
        <div *notaCan="'leads.manage'" class="lp__add">
          <input [class]="input()" name="note" data-test="note-input" maxlength="1000" [placeholder]="'marketing.leads.addNote' | translate" [ngModel]="note()" (ngModelChange)="note.set($event)" (keyup.enter)="addNote()" />
          <button type="button" [class]="btn()" data-action="add-note" [disabled]="!note().trim()" (click)="addNote()">{{ 'marketing.leads.addNoteAction' | translate }}</button>
        </div>
      } @else if (loadError()) { <p class="nota-error" role="alert">{{ 'marketing.loadFailed' | translate }}</p> }
    </ng-template>

    @if (layout.isMobile()) {
      <div class="m-page">
        <div class="m-card lp__stack"><ng-container *ngTemplateOutlet="body" /></div>
        @if (lead(); as l) {
          <div class="m-actions"><a *notaCan="'leads.manage'" class="m-btn" data-action="edit-lead" [routerLink]="['/marketing/leads', l._id, 'edit']">{{ 'marketing.page.edit' | translate }}</a></div>
        }
      </div>
    } @else {
      <div class="lp">
        <nota-page-header [title]="lead()?.name ?? ''" [subtitle]="lead() ? ('marketing.leadStatus.' + lead()!.status | translate) : ''">
          <div notaPageActions><a *notaCan="'leads.manage'" notaButton data-action="edit-lead" [routerLink]="['/marketing/leads', lead()?._id, 'edit']">{{ 'marketing.page.edit' | translate }}</a></div>
        </nota-page-header>
        <section class="nota-card lp__stack"><ng-container *ngTemplateOutlet="body" /></section>
      </div>
    }
  `,
  styles: [`
    .lp { display: flex; flex-direction: column; gap: 16px; max-width: 760px; }
    .lp__stack { display: flex; flex-direction: column; gap: 12px; }
    .lp__contact { display: flex; flex-wrap: wrap; gap: 8px; }
    .lp__facts { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0; }
    .lp__facts dt { color: var(--text-muted, #6b7280); }
    .lp__facts dd { margin: 0; }
    .lp__h { font-size: 16px; margin: 8px 0 0; }
    .lp__doc { display: grid; grid-template-columns: 1fr auto auto auto; gap: 10px; align-items: center; }
    .lp__note { display: flex; flex-direction: column; gap: 2px; border-inline-start: 3px solid var(--border, #d1d5db); padding-inline-start: 10px; }
    .lp__add { display: flex; gap: 8px; }
    .lp__add input { flex: 1; min-width: 0; }
    .lp__muted { color: var(--text-muted, #6b7280); margin: 0; }
    .lp__notes { white-space: pre-wrap; margin: 0; }
    .lp__status { display: flex; flex-direction: column; gap: 4px; font-size: 13px; max-width: 260px; }
  `],
})
export class LeadPageComponent implements OnInit {
  protected readonly layout = inject(LayoutService);
  private readonly marketing = inject(MarketingService);
  private readonly route = inject(ActivatedRoute);
  private readonly translate = inject(TranslateService);
  protected readonly statuses = LEAD_STATUSES;

  protected readonly lead = signal<LeadDetail | null>(null);
  protected readonly loadError = signal(false);
  protected readonly note = signal('');
  protected readonly btn = computed(() => (this.layout.isMobile() ? 'm-btn' : 'nota-btn'));
  protected readonly input = computed(() => (this.layout.isMobile() ? 'm-input' : 'nota-input'));
  protected readonly select = computed(() => (this.layout.isMobile() ? 'm-input' : 'nota-select'));

  private readonly bindTopBar = inject(MobileTopBarService).bind(() => this.layout.isMobile() ? { title: this.lead()?.name || this.translate.instant('marketing.leads.title') } : null);

  ngOnInit(): void { this.load(); }

  private load(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) return;
    this.loadError.set(false);
    this.marketing.lead(id).subscribe({ next: (l) => this.lead.set(l), error: () => this.loadError.set(true) });
  }

  protected docLink(doc: LeadPurchaseDoc): string[] | null {
    return doc.type === 'web_order' ? ['/orders', doc.id] : null;
  }

  protected setStatus(status: string): void {
    const l = this.lead();
    if (!l) return;
    this.marketing.updateLead(l._id, { status: status as LeadDetail['status'] }).subscribe({ next: () => this.lead.set({ ...l, status: status as LeadDetail['status'] }), error: () => this.load() });
  }

  protected addNote(): void {
    const l = this.lead();
    const text = this.note().trim();
    if (!l || !text) return;
    this.marketing.addLeadNote(l._id, text).subscribe({ next: (r) => { this.lead.set({ ...l, noteLog: r.noteLog }); this.note.set(''); } });
  }
}
