import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { NotaCanDirective } from '../../core/auth/nota-can.directive';
import { AuthService } from '../../core/auth/auth.service';
import { LayoutService } from '../../core/layout/layout.service';
import { MarketingSettings } from './marketing.models';
import { MarketingService } from './marketing.service';

const ERRORS = ['INVALID_VALUE'];

/**
 * Online Stage 7A: the «التسويق» tab of the website settings. Pixels, cookie consent, attribution window, "عرفتنا منين؟" and the two
 * catalog feed links. It has its own save (marketing.manage) and is read-only for marketing.view.
 */
@Component({
  selector: 'app-marketing-settings',
  imports: [FormsModule, TranslatePipe, NotaCanDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!allowed()) {
      <p class="ms__muted" data-test="marketing-no-access">{{ 'marketing.settings.noAccess' | translate }}</p>
    } @else if (loaded()) {
      <section [class]="card()" data-test="marketing-pixels">
        <h2 class="ms__h">{{ 'marketing.settings.pixels' | translate }}</h2>
        <label class="ms__f">{{ 'marketing.settings.metaPixel' | translate }}
          <input [class]="input() + ' nota-num'" dir="ltr" inputmode="numeric" name="metaPixelId" data-test="meta-pixel" maxlength="16" [disabled]="!canManage()" [ngModel]="metaPixelId()" (ngModelChange)="metaPixelId.set($event)" />
          <small>{{ 'marketing.settings.metaPixelHint' | translate }}</small>
        </label>
        <label class="ms__f">{{ 'marketing.settings.tiktokPixel' | translate }}
          <input [class]="input() + ' nota-num'" dir="ltr" name="tiktokPixelId" data-test="tiktok-pixel" maxlength="32" [disabled]="!canManage()" [ngModel]="tiktokPixelId()" (ngModelChange)="tiktokPixelId.set($event)" />
          <small>{{ 'marketing.settings.tiktokPixelHint' | translate }}</small>
        </label>
        <label class="ms__check"><input type="checkbox" name="requireConsent" data-test="require-consent" [disabled]="!canManage()" [ngModel]="requireConsent()" (ngModelChange)="requireConsent.set($event)" /> {{ 'marketing.settings.requireConsent' | translate }}</label>
        <p class="ms__muted">{{ 'marketing.settings.noPersonalData' | translate }}</p>
      </section>

      <section [class]="card()" data-test="marketing-attribution">
        <h2 class="ms__h">{{ 'marketing.settings.attribution' | translate }}</h2>
        <label class="ms__f">{{ 'marketing.settings.attributionDays' | translate }}
          <input [class]="input() + ' nota-num'" type="number" inputmode="numeric" min="1" max="90" name="attributionDays" data-test="attribution-days" [disabled]="!canManage()" [ngModel]="attributionDays()" (ngModelChange)="attributionDays.set($event)" />
        </label>
        <label class="ms__check"><input type="checkbox" name="askHeardFrom" data-test="ask-heard-from" [disabled]="!canManage()" [ngModel]="askHeardFrom()" (ngModelChange)="askHeardFrom.set($event)" /> {{ 'marketing.settings.askHeardFrom' | translate }}</label>
        @if (askHeardFrom()) {
          <label class="ms__f">{{ 'marketing.settings.heardOptions' | translate }}
            <textarea [class]="input()" rows="5" name="heardFromOptions" data-test="heard-options" [disabled]="!canManage()" [ngModel]="optionsText()" (ngModelChange)="optionsText.set($event)"></textarea>
            <small>{{ 'marketing.settings.heardOptionsHint' | translate }}</small>
          </label>
        }
      </section>

      <section [class]="card()" data-test="marketing-feeds">
        <h2 class="ms__h">{{ 'marketing.settings.feeds' | translate }}</h2>
        @for (feed of feeds(); track feed.key) {
          <div class="ms__feed" [attr.data-feed]="feed.key">
            <strong>{{ 'marketing.settings.feed.' + feed.key | translate }}</strong>
            <code dir="ltr" class="ms__url">{{ feed.url }}</code>
            <button type="button" [class]="btn()" [attr.data-action]="'copy-feed-' + feed.key" (click)="copy(feed.key, feed.url)">{{ (copied() === feed.key ? 'marketing.page.copied' : 'marketing.page.copy') | translate }}</button>
            <small>{{ 'marketing.settings.feedHelp.' + feed.key | translate }}</small>
          </div>
        }
        <p class="ms__muted">{{ 'marketing.settings.feedNote' | translate }}</p>
      </section>

      @if (error()) { <p class="nota-error" role="alert" data-test="marketing-error">{{ error() | translate }}</p> }
      @if (savedOk()) { <p class="ms__ok" role="status" data-test="marketing-saved">{{ 'marketing.settings.saved' | translate }}</p> }
      <div class="ms__actions" *notaCan="'marketing.manage'">
        <button type="button" [class]="btnPrimary()" data-action="save-marketing" [disabled]="saving()" (click)="save()">{{ 'mobile.common.save' | translate }}</button>
      </div>
    } @else if (loadError()) {
      <p class="nota-error" role="alert">{{ 'marketing.loadFailed' | translate }}</p>
    }
  `,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 16px; }
    .ms__h { font-size: 16px; margin: 0 0 8px; }
    .ms__f { display: flex; flex-direction: column; gap: 4px; font-size: 13px; margin-bottom: 10px; }
    .ms__f small, .ms__muted { color: var(--text-muted, #6b7280); font-size: 12px; }
    .ms__check { display: flex; gap: 8px; align-items: center; margin: 6px 0; }
    .ms__feed { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
    .ms__feed small { flex-basis: 100%; }
    .ms__url { flex: 1 1 240px; overflow-wrap: anywhere; font-size: 12px; }
    .ms__ok { color: var(--success, #15803d); margin: 0; }
    .ms__actions { display: flex; justify-content: flex-end; }
  `],
})
export class MarketingSettingsComponent implements OnInit {
  private readonly marketing = inject(MarketingService);
  private readonly auth = inject(AuthService);
  protected readonly layout = inject(LayoutService);

  protected readonly allowed = computed(() => this.auth.has('marketing.view') || this.auth.has('marketing.manage'));
  protected readonly canManage = computed(() => this.auth.has('marketing.manage'));
  protected readonly loaded = signal(false);
  protected readonly loadError = signal(false);
  protected readonly saving = signal(false);
  protected readonly savedOk = signal(false);
  protected readonly error = signal('');
  protected readonly copied = signal('');

  protected readonly metaPixelId = signal('');
  protected readonly tiktokPixelId = signal('');
  protected readonly requireConsent = signal(true);
  protected readonly attributionDays = signal<number>(7);
  protected readonly askHeardFrom = signal(true);
  protected readonly optionsText = signal('');
  protected readonly feeds = signal<{ key: 'meta' | 'tiktok'; url: string }[]>([]);

  protected readonly card = computed(() => (this.layout.isMobile() ? 'm-card' : 'nota-card'));
  protected readonly input = computed(() => (this.layout.isMobile() ? 'm-input' : 'nota-input'));
  protected readonly btn = computed(() => (this.layout.isMobile() ? 'm-btn' : 'nota-btn'));
  protected readonly btnPrimary = computed(() => (this.layout.isMobile() ? 'm-btn m-btn--primary' : 'nota-btn nota-btn--primary'));

  ngOnInit(): void {
    if (!this.allowed()) return;
    this.marketing.settings().subscribe({ next: (s) => this.apply(s), error: () => this.loadError.set(true) });
  }

  private apply(s: MarketingSettings): void {
    this.metaPixelId.set(s.metaPixelId);
    this.tiktokPixelId.set(s.tiktokPixelId);
    this.requireConsent.set(s.requireConsent);
    this.attributionDays.set(s.attributionDays);
    this.askHeardFrom.set(s.askHeardFrom);
    this.optionsText.set(s.heardFromOptions.join('\n'));
    this.feeds.set([{ key: 'meta', url: s.feeds.meta }, { key: 'tiktok', url: s.feeds.tiktok }]);
    this.loaded.set(true);
  }

  protected save(): void {
    if (this.saving() || !this.canManage()) return;
    this.saving.set(true); this.error.set(''); this.savedOk.set(false);
    this.marketing.saveSettings({
      metaPixelId: this.metaPixelId().trim(), tiktokPixelId: this.tiktokPixelId().trim(), requireConsent: this.requireConsent(),
      attributionDays: Number(this.attributionDays()), askHeardFrom: this.askHeardFrom(),
      heardFromOptions: this.optionsText().split('\n').map((line) => line.trim()).filter(Boolean),
    }).subscribe({
      next: (s) => { this.apply(s); this.saving.set(false); this.savedOk.set(true); },
      error: (response) => { this.saving.set(false); this.error.set(ERRORS.includes(response?.error?.code) && response?.error?.message ? response.error.message : 'marketing.errors.GENERIC'); },
    });
  }

  protected async copy(key: string, url: string): Promise<void> {
    try { await navigator.clipboard.writeText(url); } catch { /* the link stays selectable */ }
    this.copied.set(key);
    setTimeout(() => this.copied.set(''), 1800);
  }
}
