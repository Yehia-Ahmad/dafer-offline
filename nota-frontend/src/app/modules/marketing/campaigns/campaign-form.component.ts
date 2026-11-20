import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LayoutService } from '../../../core/layout/layout.service';
import { localDateKey } from '../../../core/utilities/local-date';
import { MobileTopBarService } from '../../mobile/mobile-topbar.service';
import { NotaButtonDirective, NotaPageHeaderComponent } from '../../shared/ui';
import { CAMPAIGN_STATUSES, Campaign, CampaignPayload, LandingKind, PLATFORMS } from '../marketing.models';
import { MarketingService } from '../marketing.service';

interface Form {
  name: string; platform: string; type: string; landingKind: LandingKind; landingRef: string; landingPath: string;
  startDate: string; endDate: string; plannedBudget: number | null; notes: string; status: string; code: string;
}

const EMPTY = (): Form => ({ name: '', platform: 'facebook', type: 'paid', landingKind: 'home', landingRef: '', landingPath: '/', startDate: localDateKey(), endDate: '', plannedBudget: null, notes: '', status: 'active', code: '' });
const ERRORS = ['CODE_TAKEN', 'CODE_LOCKED', 'INVALID_CODE', 'INVALID_LANDING', 'INVALID_DATE', 'INVALID_NAME', 'INVALID_BUDGET'];

/** Online Stage 7A: /marketing/campaigns/new and /marketing/campaigns/:id/edit. A full page on the phone (top bar title + action bar). */
@Component({
  selector: 'app-campaign-form',
  imports: [FormsModule, NgTemplateOutlet, RouterLink, TranslatePipe, NotaButtonDirective, NotaPageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #fields>
      <label class="cf__f">{{ 'marketing.form.name' | translate }} *
        <input [class]="input()" name="name" data-test="campaign-name" maxlength="120" [ngModel]="form().name" (ngModelChange)="patch('name', $event)" />
      </label>
      <label class="cf__f">{{ 'marketing.campaigns.platform' | translate }}
        <select [class]="select()" name="platform" data-test="campaign-platform" [ngModel]="form().platform" (ngModelChange)="patch('platform', $event)">
          @for (p of platforms; track p) { <option [value]="p">{{ 'marketing.platform.' + p | translate }}</option> }
        </select>
      </label>
      <label class="cf__f">{{ 'marketing.form.type' | translate }}
        <select [class]="select()" name="type" data-test="campaign-type" [ngModel]="form().type" (ngModelChange)="patch('type', $event)">
          <option value="paid">{{ 'marketing.type.paid' | translate }}</option>
          <option value="organic">{{ 'marketing.type.organic' | translate }}</option>
        </select>
      </label>
      <label class="cf__f">{{ 'marketing.form.landing' | translate }}
        <select [class]="select()" name="landingKind" data-test="campaign-landing" [ngModel]="form().landingKind" (ngModelChange)="patch('landingKind', $event)">
          <option value="home">{{ 'marketing.landing.home' | translate }}</option>
          <option value="product">{{ 'marketing.landing.product' | translate }}</option>
          <option value="category">{{ 'marketing.landing.category' | translate }}</option>
          <option value="path">{{ 'marketing.landing.path' | translate }}</option>
        </select>
      </label>
      @if (form().landingKind === 'category') {
        <label class="cf__f">{{ 'marketing.landing.category' | translate }}
          <select [class]="select()" name="landingRefCategory" data-test="landing-category" [ngModel]="form().landingRef" (ngModelChange)="patch('landingRef', $event)">
            <option value="">—</option>
            @for (c of categories(); track c.id) { <option [value]="c.id">{{ c.name }}</option> }
          </select>
        </label>
      }
      @if (form().landingKind === 'product') {
        <label class="cf__f">{{ 'marketing.landing.searchProduct' | translate }}
          <input [class]="input()" name="productSearch" data-test="landing-product-search" [ngModel]="productQuery()" (ngModelChange)="searchProducts($event)" />
        </label>
        @if (productChoices().length) {
          <label class="cf__f">{{ 'marketing.landing.product' | translate }}
            <select [class]="select()" name="landingRefProduct" data-test="landing-product" [ngModel]="form().landingRef" (ngModelChange)="patch('landingRef', $event)">
              <option value="">—</option>
              @for (p of productChoices(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
            </select>
          </label>
        }
      }
      @if (form().landingKind === 'path') {
        <label class="cf__f">{{ 'marketing.landing.pathLabel' | translate }}
          <input [class]="input() + ' nota-num'" dir="ltr" name="landingPath" data-test="landing-path" [ngModel]="form().landingPath" (ngModelChange)="patch('landingPath', $event)" />
          <small>{{ 'marketing.landing.pathHint' | translate }}</small>
        </label>
      }
      <label class="cf__f">{{ 'marketing.form.startDate' | translate }}
        <input [class]="input() + ' nota-num'" type="date" name="startDate" data-test="campaign-start" [ngModel]="form().startDate" (ngModelChange)="patch('startDate', $event)" />
      </label>
      <label class="cf__f">{{ 'marketing.form.endDate' | translate }}
        <input [class]="input() + ' nota-num'" type="date" name="endDate" data-test="campaign-end" [ngModel]="form().endDate" (ngModelChange)="patch('endDate', $event)" />
      </label>
      <label class="cf__f">{{ 'marketing.form.plannedBudget' | translate }}
        <input [class]="input() + ' nota-num'" type="number" inputmode="decimal" min="0" step="0.01" name="plannedBudget" data-test="campaign-budget" [ngModel]="form().plannedBudget" (ngModelChange)="patch('plannedBudget', $event === '' ? null : $event)" />
      </label>
      @if (!editing() || codeEditable()) {
        <label class="cf__f">{{ 'marketing.form.code' | translate }}
          <input [class]="input() + ' nota-num'" dir="ltr" name="code" data-test="campaign-code" maxlength="32" [ngModel]="form().code" (ngModelChange)="patch('code', $event)" [placeholder]="'marketing.form.codeAuto' | translate" />
          <small>{{ 'marketing.form.codeHint' | translate }}</small>
        </label>
      } @else {
        <p class="cf__f" data-test="code-locked">{{ 'marketing.form.code' | translate }}: <strong class="nota-num" dir="ltr">{{ form().code }}</strong> — {{ 'marketing.form.codeLocked' | translate }}</p>
      }
      @if (editing()) {
        <label class="cf__f">{{ 'marketing.campaigns.status' | translate }}
          <select [class]="select()" name="status" data-test="campaign-status" [ngModel]="form().status" (ngModelChange)="patch('status', $event)">
            @for (s of statuses; track s) { <option [value]="s">{{ 'marketing.status.' + s | translate }}</option> }
          </select>
        </label>
      }
      <label class="cf__f">{{ 'marketing.form.notes' | translate }}
        <textarea [class]="input()" name="notes" rows="3" maxlength="1000" data-test="campaign-notes" [ngModel]="form().notes" (ngModelChange)="patch('notes', $event)"></textarea>
      </label>
      @if (error()) { <p class="nota-error" role="alert" data-test="campaign-error">{{ error() | translate }}</p> }
    </ng-template>

    @if (layout.isMobile()) {
      <form class="m-page" (ngSubmit)="save()" novalidate>
        <div class="m-card cf__stack"><ng-container *ngTemplateOutlet="fields" /></div>
        <div class="m-actions">
          <a class="m-btn" [routerLink]="backLink()">{{ 'mobile.common.cancel' | translate }}</a>
          <button type="submit" class="m-btn m-btn--primary" data-action="save-campaign" [disabled]="!canSave()">{{ 'mobile.common.save' | translate }}</button>
        </div>
      </form>
    } @else {
      <div class="cf">
        <nota-page-header [title]="(editing() ? 'marketing.form.editTitle' : 'marketing.form.newTitle') | translate" />
        <form class="nota-card cf__stack" (ngSubmit)="save()" novalidate>
          <ng-container *ngTemplateOutlet="fields" />
          <div class="cf__actions">
            <a notaButton [routerLink]="backLink()">{{ 'mobile.common.cancel' | translate }}</a>
            <button type="submit" notaButton="primary" data-action="save-campaign" [disabled]="!canSave()">{{ 'mobile.common.save' | translate }}</button>
          </div>
        </form>
      </div>
    }
  `,
  styles: [`
    .cf { display: flex; flex-direction: column; gap: 16px; max-width: 640px; }
    .cf__stack { display: flex; flex-direction: column; gap: 12px; }
    .cf__f { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
    .cf__f small { color: var(--text-muted, #6b7280); }
    .cf__actions { display: flex; gap: 8px; justify-content: flex-end; }
  `],
})
export class CampaignFormComponent implements OnInit {
  protected readonly layout = inject(LayoutService);
  private readonly marketing = inject(MarketingService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  protected readonly platforms = PLATFORMS;
  protected readonly statuses = CAMPAIGN_STATUSES;

  protected readonly id = signal<string | null>(null);
  protected readonly editing = computed(() => this.id() !== null);
  protected readonly codeEditable = signal(true);
  protected readonly form = signal<Form>(EMPTY());
  protected readonly categories = signal<{ id: string; name: string }[]>([]);
  protected readonly productChoices = signal<{ id: string; name: string }[]>([]);
  protected readonly productQuery = signal('');
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly input = computed(() => (this.layout.isMobile() ? 'm-input' : 'nota-input'));
  protected readonly select = computed(() => (this.layout.isMobile() ? 'm-input' : 'nota-select'));
  protected readonly backLink = computed(() => (this.id() ? ['/marketing/campaigns', this.id()!] : ['/marketing/campaigns']));
  protected readonly canSave = computed(() => {
    const f = this.form();
    if (this.saving() || !f.name.trim() || !f.startDate) return false;
    if ((f.landingKind === 'product' || f.landingKind === 'category') && !f.landingRef) return false;
    if (f.landingKind === 'path' && (!f.landingPath.startsWith('/') || f.landingPath.startsWith('//') || /[\\\s]/.test(f.landingPath) || f.landingPath.includes('://'))) return false;
    return !f.endDate || f.endDate >= f.startDate;
  });

  private readonly bindTopBar = inject(MobileTopBarService).bind(() => this.layout.isMobile()
    ? { title: this.translate.instant(this.editing() ? 'marketing.form.editTitle' : 'marketing.form.newTitle'), hideTabs: true }
    : null);

  ngOnInit(): void {
    this.marketing.storeCategories().subscribe({ next: (r) => this.categories.set(r.data), error: () => this.categories.set([]) });
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) return;
    this.id.set(id);
    this.marketing.campaign(id).subscribe({
      next: (c) => { this.codeEditable.set(c.codeEditable); this.form.set(this.toForm(c)); },
      error: () => this.error.set('marketing.loadFailed'),
    });
  }

  protected patch<K extends keyof Form>(key: K, value: Form[K]): void {
    this.form.update((f) => ({ ...f, [key]: value }));
    this.error.set('');
  }

  protected searchProducts(q: string): void {
    this.productQuery.set(q);
    if (q.trim().length < 2) { this.productChoices.set([]); return; }
    this.marketing.storeProducts(q.trim()).subscribe({ next: (r) => this.productChoices.set(r.data), error: () => this.productChoices.set([]) });
  }

  private toForm(c: Campaign): Form {
    return {
      name: c.name, platform: c.platform, type: c.type, landingKind: c.landing?.kind ?? 'home', landingRef: c.landing?.ref ?? '', landingPath: c.landing?.path ?? '/',
      startDate: (c.startDate || '').slice(0, 10), endDate: (c.endDate || '').slice(0, 10), plannedBudget: c.plannedBudget ?? null, notes: c.notes ?? '', status: c.status, code: c.code,
    };
  }

  private payload(): CampaignPayload {
    const f = this.form();
    const landing = f.landingKind === 'home' ? { kind: 'home' as const } : f.landingKind === 'path' ? { kind: 'path' as const, path: f.landingPath.trim() } : { kind: f.landingKind, ref: f.landingRef };
    return {
      name: f.name.trim(), platform: f.platform as CampaignPayload['platform'], type: f.type as CampaignPayload['type'], landing,
      startDate: f.startDate, endDate: f.endDate || null, plannedBudget: f.plannedBudget === null || (f.plannedBudget as unknown) === '' ? null : Number(f.plannedBudget), notes: f.notes.trim(),
      ...(this.editing() ? { status: f.status as CampaignPayload['status'] } : {}),
      ...(f.code.trim() && (!this.editing() || this.codeEditable()) ? { code: f.code.trim().toLowerCase() } : {}),
    };
  }

  protected save(): void {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.error.set('');
    const request = this.id() ? this.marketing.updateCampaign(this.id()!, this.payload()) : this.marketing.createCampaign(this.payload());
    request.subscribe({
      next: (campaign) => { this.saving.set(false); void this.router.navigate(['/marketing/campaigns', campaign._id]); },
      error: (response) => {
        this.saving.set(false);
        const code = response?.error?.code;
        this.error.set(ERRORS.includes(code) ? `marketing.errors.${code}` : 'marketing.errors.GENERIC');
      },
    });
  }
}
