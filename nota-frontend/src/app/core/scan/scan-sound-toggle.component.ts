import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { PrintSettingsService } from '../print/print-settings.service';
import { NotaButtonDirective } from '../../modules/shared/ui';

/** Header shortcut for the same per-device scanSoundMuted preference used by print/device settings. */
@Component({
  selector: 'nota-scan-sound-toggle',
  standalone: true,
  imports: [TranslatePipe, NotaButtonDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" notaButton data-action="toggle-scan-sound" [attr.aria-pressed]="muted()" (click)="toggle()">
      <span aria-hidden="true">{{ muted() ? '🔇' : '🔊' }}</span>
      {{ (muted() ? 'labels.settings.soundOff' : 'labels.settings.soundOn') | translate }}
    </button>
  `,
})
export class ScanSoundToggleComponent implements OnInit {
  private readonly settings = inject(PrintSettingsService);
  readonly muted = signal(this.settings.scanSoundMuted);

  async ngOnInit(): Promise<void> {
    await this.settings.load();
    this.muted.set(this.settings.scanSoundMuted);
  }

  async toggle(): Promise<void> {
    const muted = !this.muted();
    this.muted.set(muted);
    await this.settings.savePrefs({ scanSoundMuted: muted });
    this.muted.set(this.settings.scanSoundMuted);
  }
}
