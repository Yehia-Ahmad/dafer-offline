import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { NotaButtonDirective } from '../../../shared/ui';
import { AuthService } from '../../../../core/auth/auth.service';
import { DesktopAbout, getDesktopBridge, getDesktopRuntimeConfig } from '../../../../core/runtime/runtime-config';

/**
 * Stage 25: the "عن البرنامج" card of the shop profile (every user): version and build number, the main PC's version on a client PC,
 * and this version's notes on demand. (The diagnostics export joins this card in the same stage.)
 */
@Component({
  selector: 'app-about-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, NotaButtonDirective],
  template: `
    <section class="about" data-test="about-card" aria-labelledby="about-title">
      <h2 id="about-title" class="nota-section-title">{{ 'about.title' | translate }}</h2>
      @if (about(); as info) {
        <dl class="about__grid">
          <div><dt>{{ 'about.version' | translate }}</dt><dd dir="ltr" class="nota-num" data-field="about-version">{{ info.version }}</dd></div>
          <div><dt>{{ 'about.build' | translate }}</dt><dd dir="ltr" class="nota-num" data-field="about-build">{{ info.build }}</dd></div>
          @if (serverVersion && serverVersion !== info.version) {
            <div><dt>{{ 'about.serverVersion' | translate }}</dt><dd dir="ltr" class="nota-num" data-field="about-server-version">{{ serverVersion }}</dd></div>
          }
        </dl>
        <button type="button" notaButton data-action="about-whats-new" (click)="showNotes()">{{ 'about.whatsNew' | translate }}</button>
        @if (notes().length) {
          <ul class="about__notes" data-test="about-notes">
            @for (line of notes(); track $index) { <li>{{ line }}</li> }
          </ul>
        }
        @if (notesEmpty()) { <p class="nota-hint" data-test="about-no-notes">{{ 'about.noWhatsNew' | translate }}</p> }

        @if (canExport) {
          <h3 class="about__sub">{{ 'diagnostics.title' | translate }}</h3>
          <p class="nota-hint">{{ 'diagnostics.hint' | translate }}</p>
          <button type="button" notaButton data-action="export-diagnostics" [disabled]="exporting()" (click)="exportDiagnostics()">{{ 'diagnostics.export' | translate }}</button>
          @if (exportResult(); as result) {
            <p role="status" data-test="diagnostics-status" [class.nota-error]="result.error">{{ result.text }}</p>
          }
        }
      } @else {
        <p class="nota-hint" data-test="about-desktop-only">{{ 'about.desktopOnly' | translate }}</p>
      }
    </section>
  `,
  styles: `
    .about__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 12px; margin: 0 0 12px; }
    .about__grid dt { opacity: 0.7; font-size: 0.85rem; }
    .about__grid dd { margin: 0; font-weight: 700; }
    .about__notes { padding-inline-start: 20px; line-height: 1.9; }
    .about__sub { margin: 16px 0 4px; font-size: 1rem; }
  `,
})
export class AboutCardComponent {
  private readonly translate = inject(TranslateService);
  private readonly auth = inject(AuthService);
  protected readonly about = signal<DesktopAbout | null>(null);
  protected readonly notes = signal<string[]>([]);
  protected readonly notesEmpty = signal(false);
  protected readonly serverVersion = getDesktopRuntimeConfig()?.serverVersion ?? '';
  protected readonly exporting = signal(false);
  protected readonly exportResult = signal<{ text: string; error: boolean } | null>(null);

  /** Owner or manager (shop.manage) on the desktop app; the desktop app checks it again with the backend before it writes anything. */
  protected get canExport(): boolean {
    return Boolean(getDesktopBridge()?.diagnostics) && this.auth.has('shop.manage');
  }

  constructor() {
    const bridge = getDesktopBridge();
    if (bridge?.about) {
      bridge.about().then((info) => this.about.set(info)).catch(() => undefined);
    } else {
      const config = getDesktopRuntimeConfig();
      if (config) this.about.set({ productName: 'Nota', version: config.appVersion, build: config.appBuild || 'dev', builtAt: null, packaged: false });
    }
  }

  protected async exportDiagnostics(): Promise<void> {
    const bridge = getDesktopBridge()?.diagnostics;
    if (!bridge || this.exporting()) return;
    this.exporting.set(true);
    this.exportResult.set(null);
    try {
      const result = await bridge.export(this.auth.token());
      if (result.ok === false) this.exportResult.set({ text: result.error.message, error: true });
      else if (result.value) this.exportResult.set({ text: this.translate.instant('diagnostics.saved', { path: result.value.path }), error: false });
    } catch {
      this.exportResult.set({ text: this.translate.instant('diagnostics.failed'), error: true });
    } finally {
      this.exporting.set(false);
    }
  }

  protected showNotes(): void {
    const current = getDesktopBridge()?.whatsNew?.current;
    if (!current) { this.notesEmpty.set(true); return; }
    current().then((entry) => {
      const lang = (this.translate.currentLang || 'ar') === 'en' ? 'en' : 'ar';
      const lines = entry ? (entry[lang].length ? entry[lang] : entry[lang === 'en' ? 'ar' : 'en']) : [];
      this.notes.set(lines);
      this.notesEmpty.set(!lines.length);
    }).catch(() => this.notesEmpty.set(true));
  }
}
