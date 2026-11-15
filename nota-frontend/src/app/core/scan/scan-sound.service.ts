import { Injectable, inject } from '@angular/core';
import { PrintSettingsService } from '../print/print-settings.service';

/**
 * Stage 26: one short "ok" beep and one "error" buzz for scanning, made locally with the Web Audio API (nothing is
 * downloaded, nothing is bundled). Mute is a per-device setting (print/device settings). Never throws: no audio
 * device, a blocked AudioContext or a headless test run simply stay silent.
 */
@Injectable({ providedIn: 'root' })
export class ScanSoundService {
  private readonly settings = inject(PrintSettingsService);
  private context: AudioContext | null = null;

  get muted(): boolean {
    return this.settings.scanSoundMuted;
  }

  ok(): void {
    this.tone([{ frequency: 1480, ms: 70, type: 'sine' }]);
  }

  error(): void {
    this.tone([{ frequency: 260, ms: 140, type: 'square' }, { frequency: 180, ms: 220, type: 'square' }]);
  }

  private tone(parts: Array<{ frequency: number; ms: number; type: OscillatorType }>): void {
    if (this.muted) return;
    try {
      const AudioCtor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) return;
      this.context ??= new AudioCtor();
      const context = this.context;
      if (context.state === 'suspended') void context.resume().catch(() => undefined);
      let at = context.currentTime;
      for (const part of parts) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = part.type;
        oscillator.frequency.value = part.frequency;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.18, at + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + part.ms / 1000);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(at);
        oscillator.stop(at + part.ms / 1000 + 0.02);
        at += part.ms / 1000;
      }
    } catch {
      /* silent */
    }
  }
}
