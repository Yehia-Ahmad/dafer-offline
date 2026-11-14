import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { NotaButtonDirective } from '../../../shared/ui';
import { LicenseInfo, LicenseService } from '../../services/license.service';
import { ShopProfileService } from '../../services/shop-profile.service';

const REASONS = new Set(['MALFORMED', 'BAD_SIGNATURE', 'WRONG_MACHINE', 'UNKNOWN_TYPE', 'UNKNOWN_VERSION', 'NO_MACHINE_ID']);

/**
 * Stage 24: the "الترخيص" card of the shop profile. The owner sees the license (shop name, license ID, type, client PCs used /
 * allowed, Machine ID, issue date), can replace it, and sees the paired client PCs with an unpair button that frees a slot.
 * Everyone else sees only the shop name (the locked name field above). The backend enforces all of it; this only shows it.
 */
@Component({
  selector: 'app-license-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, TranslatePipe, NotaButtonDirective],
  template: `
    <section class="lic" data-test="license-card" aria-labelledby="lic-title">
      <h2 id="lic-title" class="nota-section-title">{{ 'license.title' | translate }}</h2>
      @if (loadFailed()) {
        <p class="nota-error" role="alert" data-test="license-load-failed">{{ 'license.loadFailed' | translate }}</p>
      } @else if (info(); as license) {
        <dl class="lic__grid">
          <div><dt>{{ 'license.shopName' | translate }}</dt><dd data-field="license-shop">{{ license.shopName }}</dd></div>
          <div><dt>{{ 'license.licenseId' | translate }}</dt><dd dir="ltr" class="nota-num" data-field="license-id">{{ license.licenseId }}</dd></div>
          <div><dt>{{ 'license.type' | translate }}</dt><dd data-field="license-type">{{ (license.type === 'lifetime' ? 'license.lifetime' : 'license.otherType') | translate }}</dd></div>
          <div><dt>{{ 'license.maxClients' | translate }}</dt>
            <dd class="nota-num" data-field="license-clients">{{ 'license.clientsOf' | translate: { used: license.clientsUsed, max: license.maxClients } }}</dd></div>
          <div><dt>{{ 'license.machineId' | translate }}</dt><dd dir="ltr" class="nota-num" data-field="license-machine">{{ license.machineId }}</dd></div>
          <div><dt>{{ 'license.issuedAt' | translate }}</dt><dd class="nota-num" data-field="license-issued">{{ license.issuedAt | date: 'yyyy-MM-dd' }}</dd></div>
        </dl>

        <h3 class="lic__sub">{{ 'license.clients' | translate }}</h3>
        @if (!license.clients.length) {
          <p class="nota-hint" data-test="license-no-clients">{{ 'license.noClients' | translate }}</p>
        } @else {
          <ul class="lic__clients">
            @for (client of license.clients; track client.deviceId) {
              <li data-test="license-client">
                <span class="lic__client-name">{{ client.name || client.deviceId }}</span>
                @if (client.lastSeenAt) {
                  <span class="nota-hint">{{ 'license.lastSeen' | translate }}: <span class="nota-num">{{ client.lastSeenAt | date: 'yyyy-MM-dd HH:mm' }}</span></span>
                }
                <button type="button" notaButton="danger" data-action="unpair" [disabled]="busy()" (click)="unpair(client.deviceId)">{{ 'license.unpair' | translate }}</button>
              </li>
            }
          </ul>
          <p class="nota-hint">{{ 'license.unpairHint' | translate }}</p>
        }

        @if (license.revoked?.length) {
          <h3 class="lic__sub">{{ 'license.revoked' | translate }}</h3>
          <ul class="lic__clients">
            @for (client of license.revoked; track client.deviceId) {
              <li data-test="license-revoked">
                <span class="lic__client-name">{{ client.name || client.deviceId }}</span>
                <button type="button" notaButton data-action="allow" [disabled]="busy()" (click)="allow(client.deviceId)">{{ 'license.allow' | translate }}</button>
              </li>
            }
          </ul>
          <p class="nota-hint">{{ 'license.revokedHint' | translate }}</p>
        }

        @if (!replacing()) {
          <button type="button" notaButton data-action="replace-license" (click)="startReplace()">{{ 'license.replace' | translate }}</button>
        } @else {
          <div class="lic__replace" data-test="license-replace">
            <p class="nota-hint">{{ 'license.replaceHint' | translate }}</p>
            <textarea class="nota-textarea" dir="ltr" rows="3" spellcheck="false" name="licenseText" data-field="license-text" placeholder="NOTA1...."
              [ngModel]="text()" (ngModelChange)="text.set($event)"></textarea>
            <div class="lic__row">
              <label class="nota-btn nota-btn--secondary">
                {{ 'license.loadFile' | translate }}
                <input type="file" accept=".lic,text/plain" hidden data-field="license-file" (change)="onFile($event)" />
              </label>
              <button type="button" notaButton="primary" data-action="activate-license" [disabled]="busy() || !text().trim()" (click)="replace()">{{ 'license.activate' | translate }}</button>
              <button type="button" notaButton data-action="cancel-replace" [disabled]="busy()" (click)="cancelReplace()">{{ 'license.cancel' | translate }}</button>
            </div>
          </div>
        }
        @if (message(); as result) {
          <p role="status" data-test="license-status" [class.nota-error]="result.error">{{ result.text }}</p>
        }
      } @else {
        <p role="status">{{ 'license.loading' | translate }}</p>
      }
    </section>
  `,
  styles: [
    `
      .lic { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--surface-2); }
      .lic__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px 20px; margin: 0; width: 100%; }
      .lic__grid dt { font-size: 12px; color: var(--text-muted); }
      .lic__grid dd { margin: 2px 0 0; font-weight: 600; overflow-wrap: anywhere; }
      .lic__sub { margin: 4px 0 0; font-size: 14px; }
      .lic__clients { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; width: 100%; }
      .lic__clients li { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
      .lic__client-name { font-weight: 600; margin-inline-end: auto; }
      .lic__replace { display: flex; flex-direction: column; gap: 10px; width: 100%; }
      .lic__replace textarea { width: 100%; }
      .lic__row { display: flex; flex-wrap: wrap; gap: 8px; }
    `,
  ],
})
export class LicenseCardComponent implements OnInit {
  private readonly license = inject(LicenseService);
  private readonly shopProfile = inject(ShopProfileService);
  private readonly translate = inject(TranslateService);

  protected readonly info = signal<LicenseInfo | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly busy = signal(false);
  protected readonly replacing = signal(false);
  protected readonly text = signal('');
  protected readonly message = signal<{ text: string; error: boolean } | null>(null);

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.license.info().subscribe({
      next: (info) => { this.info.set(info); this.loadFailed.set(false); },
      error: () => this.loadFailed.set(true),
    });
  }

  protected startReplace(): void { this.message.set(null); this.text.set(''); this.replacing.set(true); }
  protected cancelReplace(): void { this.replacing.set(false); this.text.set(''); }

  /** "Load nota.lic": reads the picked file into the text box (the backend still verifies it). */
  protected onFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 8192) {
      this.message.set({ text: this.translate.instant('license.errors.MALFORMED'), error: true });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === 'string') this.text.set(reader.result.trim()); };
    reader.onerror = () => this.message.set({ text: this.translate.instant('license.errors.UNREADABLE'), error: true });
    reader.readAsText(file);
  }

  protected replace(): void {
    this.busy.set(true);
    this.message.set(null);
    this.license.replace(this.text().trim()).subscribe({
      next: () => {
        this.busy.set(false);
        this.replacing.set(false);
        this.text.set('');
        this.message.set({ text: this.translate.instant('license.replaced'), error: false });
        this.load();
        this.shopProfile.refresh(); // the shop name comes from the license
      },
      error: (error) => {
        this.busy.set(false);
        const reason = error?.error?.reason;
        const key = typeof reason === 'string' && REASONS.has(reason) ? `license.errors.${reason}` : 'license.errors.DEFAULT';
        this.message.set({ text: this.translate.instant(key), error: true });
      },
    });
  }

  protected allow(deviceId: string): void {
    this.busy.set(true);
    this.message.set(null);
    this.license.allow(deviceId).subscribe({
      next: () => { this.busy.set(false); this.message.set({ text: this.translate.instant('license.allowed'), error: false }); this.load(); },
      error: () => { this.busy.set(false); this.message.set({ text: this.translate.instant('license.errors.DEFAULT'), error: true }); },
    });
  }

  protected unpair(deviceId: string): void {
    this.busy.set(true);
    this.message.set(null);
    this.license.unpair(deviceId).subscribe({
      next: () => { this.busy.set(false); this.message.set({ text: this.translate.instant('license.unpaired'), error: false }); this.load(); },
      error: () => { this.busy.set(false); this.message.set({ text: this.translate.instant('license.errors.DEFAULT'), error: true }); },
    });
  }
}
