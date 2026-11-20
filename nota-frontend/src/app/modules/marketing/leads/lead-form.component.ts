import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LayoutService } from '../../../core/layout/layout.service';
import { MobileTopBarService } from '../../mobile/mobile-topbar.service';
import { NotaButtonDirective, NotaPageHeaderComponent } from '../../shared/ui';
import { Campaign, LEAD_SOURCES, LEAD_STATUSES, Lead, LeadPayload } from '../marketing.models';
import { MarketingService } from '../marketing.service';

interface Form { name: string; phone: string; profileLink: string; source: string; campaignId: string; status: string; notes: string; lastContactDate: string }
const EMPTY = (campaignId = ''): Form => ({ name: '', phone: '', profileLink: '', source: 'facebook', campaignId, status: 'new', notes: '', lastContactDate: '' });
const ERRORS = ['INVALID_NAME', 'INVALID_PHONE', 'INVALID_PROFILE_LINK', 'INVALID_SOURCE', 'CONTACT_REQUIRED', 'INVALID_CAMPAIGN', 'INVALID_DATE', 'DUPLICATE_PHONE'];

/** Online Stage 7A: /marketing/leads/new and /marketing/leads/:id/edit. A full page on the phone. A duplicate phone links to the existing lead. */
@Component({
  selector: 'app-lead-form',
  imports: [FormsModule, NgTemplateOutlet, RouterLink, TranslatePipe, NotaButtonDirective, NotaPageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #fields>
      <label class="lf__f">{{ 'marketing.leads.name' | translate }} *
        <input [class]="input()" name="name" data-test="lead-name" maxlength="120" [ngModel]="form().name" (ngModelChange)="patch('name', $event)" />
      </label>
      <label class="lf__f">{{ 'marketing.leads.phone' | translate }}
        <input [class]="input() + ' nota-num'" type="tel" inputmode="tel" dir="ltr" name="phone" data-test="lead-phone" [ngModel]="form().phone" (ngModelChange)="patch('phone', $event)" />
      </label>
      <label class="lf__f">{{ 'marketing.leads.profileLink' | translate }}
        <input [class]="input()" type="url" dir="ltr" name="profileLink" data-test="lead-link" [ngModel]="form().profileLink" (ngModelChange)="patch('profileLink', $event)" />
        <small>{{ 'marketing.leads.profileLinkHint' | translate }}</small>
      </label>
      <label class="lf__f">{{ 'marketing.leads.source' | translate }}
        <select [class]="select()" name="source" data-test="lead-source" [ngModel]="form().source" (ngModelChange)="patch('source', $event)">
          @for (s of sources; track s) { <option [value]="s">{{ 'marketing.leadSource.' + s | translate }}</option> }
        </select>
      </label>
      <label class="lf__f">{{ 'marketing.leads.campaign' | translate }}
        <select [class]="select()" name="campaignId" data-test="lead-campaign" [ngModel]="form().campaignId" (ngModelChange)="patch('campaignId', $event)">
          <option value="">—</option>
          @for (c of campaigns(); track c._id) { <option [value]="c._id">{{ c.name }}</option> }
        </select>
      </label>
      <label class="lf__f">{{ 'marketing.leads.status' | translate }}
        <select [class]="select()" name="status" data-test="lead-status" [ngModel]="form().status" (ngModelChange)="patch('status', $event)">
          @for (s of statuses; track s) { <option [value]="s">{{ 'marketing.leadStatus.' + s | translate }}</option> }
        </select>
      </label>
      <label class="lf__f">{{ 'marketing.leads.lastContact' | translate }}
        <input [class]="input() + ' nota-num'" type="date" name="lastContactDate" data-test="lead-last-contact" [ngModel]="form().lastContactDate" (ngModelChange)="patch('lastContactDate', $event)" />
      </label>
      <label class="lf__f">{{ 'marketing.leads.notes' | translate }}
        <textarea [class]="input()" name="notes" rows="3" maxlength="2000" data-test="lead-notes" [ngModel]="form().notes" (ngModelChange)="patch('notes', $event)"></textarea>
      </label>
      @if (error()) {
        <p class="nota-error" role="alert" data-test="lead-error">{{ error() | translate }}
          @if (duplicateId()) { <a [routerLink]="['/marketing/leads', duplicateId()]" data-test="duplicate-link">{{ 'marketing.leads.openExisting' | translate }}</a> }</p>
      }
    </ng-template>

    @if (layout.isMobile()) {
      <form class="m-page" (ngSubmit)="save()" novalidate>
        <div class="m-card lf__stack"><ng-container *ngTemplateOutlet="fields" /></div>
        <div class="m-actions">
          <a class="m-btn" [routerLink]="backLink()">{{ 'mobile.common.cancel' | translate }}</a>
          <button type="submit" class="m-btn m-btn--primary" data-action="save-lead" [disabled]="!canSave()">{{ 'mobile.common.save' | translate }}</button>
        </div>
      </form>
    } @else {
      <div class="lf">
        <nota-page-header [title]="(editing() ? 'marketing.leads.editTitle' : 'marketing.leads.newTitle') | translate" />
        <form class="nota-card lf__stack" (ngSubmit)="save()" novalidate>
          <ng-container *ngTemplateOutlet="fields" />
          <div class="lf__actions">
            <a notaButton [routerLink]="backLink()">{{ 'mobile.common.cancel' | translate }}</a>
            <button type="submit" notaButton="primary" data-action="save-lead" [disabled]="!canSave()">{{ 'mobile.common.save' | translate }}</button>
          </div>
        </form>
      </div>
    }
  `,
  styles: [`
    .lf { display: flex; flex-direction: column; gap: 16px; max-width: 640px; }
    .lf__stack { display: flex; flex-direction: column; gap: 12px; }
    .lf__f { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
    .lf__f small { color: var(--text-muted, #6b7280); }
    .lf__actions { display: flex; gap: 8px; justify-content: flex-end; }
  `],
})
export class LeadFormComponent implements OnInit {
  protected readonly layout = inject(LayoutService);
  private readonly marketing = inject(MarketingService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  protected readonly sources = LEAD_SOURCES;
  protected readonly statuses = LEAD_STATUSES;

  protected readonly id = signal<string | null>(null);
  protected readonly editing = computed(() => this.id() !== null);
  protected readonly form = signal<Form>(EMPTY());
  protected readonly campaigns = signal<Campaign[]>([]);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly duplicateId = signal('');
  protected readonly input = computed(() => (this.layout.isMobile() ? 'm-input' : 'nota-input'));
  protected readonly select = computed(() => (this.layout.isMobile() ? 'm-input' : 'nota-select'));
  protected readonly backLink = computed(() => (this.id() ? ['/marketing/leads', this.id()!] : ['/marketing/leads']));
  protected readonly canSave = computed(() => !this.saving() && !!this.form().name.trim() && (!!this.form().phone.trim() || !!this.form().profileLink.trim()));

  private readonly bindTopBar = inject(MobileTopBarService).bind(() => this.layout.isMobile()
    ? { title: this.translate.instant(this.editing() ? 'marketing.leads.editTitle' : 'marketing.leads.newTitle'), hideTabs: true }
    : null);

  ngOnInit(): void {
    this.marketing.campaigns().subscribe({ next: (r) => this.campaigns.set(r.data), error: () => this.campaigns.set([]) });
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) { this.form.set(EMPTY(this.route.snapshot.queryParamMap.get('campaign') ?? '')); return; }
    this.id.set(id);
    this.marketing.lead(id).subscribe({ next: (lead) => this.form.set(this.toForm(lead)), error: () => this.error.set('marketing.loadFailed') });
  }

  protected patch<K extends keyof Form>(key: K, value: Form[K]): void {
    this.form.update((f) => ({ ...f, [key]: value }));
    this.error.set(''); this.duplicateId.set('');
  }

  private toForm(l: Lead): Form {
    return { name: l.name, phone: l.phone ?? '', profileLink: l.profileLink ?? '', source: l.source, campaignId: l.campaignId ?? '', status: l.status, notes: l.notes ?? '', lastContactDate: (l.lastContactDate ?? '').slice(0, 10) };
  }

  private payload(): LeadPayload {
    const f = this.form();
    return {
      name: f.name.trim(), phone: f.phone.trim() || null, profileLink: f.profileLink.trim() || null, source: f.source as LeadPayload['source'],
      campaignId: f.campaignId || null, status: f.status as LeadPayload['status'], notes: f.notes.trim(), lastContactDate: f.lastContactDate || null,
    };
  }

  protected save(): void {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.error.set(''); this.duplicateId.set('');
    const request = this.id() ? this.marketing.updateLead(this.id()!, this.payload()) : this.marketing.createLead(this.payload());
    request.subscribe({
      next: (lead) => { this.saving.set(false); void this.router.navigate(['/marketing/leads', lead._id]); },
      error: (response) => {
        this.saving.set(false);
        const code = response?.error?.code;
        this.error.set(ERRORS.includes(code) ? `marketing.errors.${code}` : 'marketing.errors.GENERIC');
        if (code === 'DUPLICATE_PHONE' && response?.error?.existingLeadId) this.duplicateId.set(String(response.error.existingLeadId));
      },
    });
  }
}
