import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { whatsappLink } from '../core/format';
import { AR } from '../core/i18n/ar';
import { SettingsStore } from '../core/settings.store';

@Component({
  selector: 'app-footer',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <footer class="ft" id="contact">
      <div class="wrap">
        <div class="ft-grid">
          <div class="stack">
            <strong class="ft-name">{{ shop() }}</strong>
            @if (shop$().shop?.address; as address) { <span>{{ address }}</span> }
            @if (shop$().openingHours; as hours) { <span class="muted-f">{{ t.footer.hours }}: {{ hours }}</span> }
          </div>
          <div class="stack">
            <strong class="ft-h">{{ t.footer.contact }}</strong>
            @if (phone(); as p) { <a class="ft-a ltr" [href]="'tel:' + p">{{ p }}</a> }
            @if (wa(); as link) { <a class="ft-wa" [href]="link" rel="noopener" target="_blank">{{ t.footer.whatsapp }}</a> }
            @for (s of social(); track s.url) { <a class="ft-a" [href]="s.url" rel="noopener" target="_blank">{{ s.label }}</a> }
          </div>
          <div class="stack">
            <strong class="ft-h">{{ t.footer.info }}</strong>
            <a class="ft-a" routerLink="/policies/returns">{{ t.footer.returns }}</a>
            <a class="ft-a" routerLink="/policies/terms">{{ t.footer.terms }}</a>
            <a class="ft-a" routerLink="/delivery">{{ t.footer.delivery }}</a>
          </div>
        </div>
        <div class="ft-bottom">
          <span>{{ t.footer.copyright(year, shop()) }}</span>
          <span class="powered">{{ t.footer.poweredBy }}
            <svg width="16" height="16" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="24" fill="#0E4D45"/><path d="M25 42 C25 80 75 80 75 42" fill="none" stroke="#F5F3EE" stroke-width="12" stroke-linecap="round"/><circle cx="50" cy="25" r="8.5" fill="#E4572E"/></svg>
            {{ t.footer.nota }}</span>
        </div>
      </div>
    </footer>
  `,
  styles: [`
    .ft { background: var(--footer-bg); color: var(--footer-text); padding: 44px 0 28px; margin-top: auto; }
    .ft-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 28px; padding-bottom: 28px; }
    .ft-name { font-size: 20px; font-weight: 800; }
    .ft-h { font-size: 15px; font-weight: 700; }
    .muted-f { color: var(--footer-muted); font-size: 14px; }
    .ft-a, .ft-wa { color: var(--footer-text); font-size: 14px; min-height: 32px; display: inline-flex; align-items: center; }
    .ft-wa { color: var(--footer-link); font-weight: 700; }
    .ft-a:hover, .ft-wa:hover { color: #fff; text-decoration: underline; }
    .ft-bottom { border-top: 1px solid rgba(227, 239, 235, 0.14); padding-top: 18px; display: flex; flex-wrap: wrap; gap: 8px 24px; justify-content: space-between; font-size: 12px; color: #c4d4cf; }
    .powered { display: inline-flex; align-items: center; gap: 6px; }
  `],
})
export class FooterComponent {
  protected readonly t = AR;
  private readonly settings = inject(SettingsStore);
  protected readonly year = new Date().getFullYear();
  protected readonly shop$ = computed(() => this.settings.settings() ?? { enabled: true });
  protected readonly shop = computed(() => this.settings.shopName() || AR.brandFallbackName);
  protected readonly phone = computed(() => this.settings.settings()?.shop?.phones?.[0] || '');
  protected readonly wa = computed(() => whatsappLink(this.settings.whatsapp()));
  protected readonly social = computed(() => {
    const c = this.settings.settings()?.contact || {};
    return [
      c.facebook ? { label: 'Facebook', url: c.facebook } : null,
      c.instagram ? { label: 'Instagram', url: c.instagram } : null,
      c.tiktok ? { label: 'TikTok', url: c.tiktok } : null,
    ].filter((x): x is { label: string; url: string } => !!x && /^https?:\/\//.test(x.url));
  });
}
