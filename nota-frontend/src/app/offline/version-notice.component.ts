import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { getDesktopRuntimeConfig } from '../core/runtime/runtime-config';

/**
 * Offline edition only: shows this PC's version, and warns when a client PC runs a different
 * version from the main PC (the warning does not block work).
 */
@Component({
  selector: 'app-version-notice',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (mismatch() && !dismissed()) {
      <div
        class="fixed inset-x-0 top-0 z-[9999] flex items-center justify-center gap-4 px-4 py-2 text-sm shadow"
        style="background: var(--warning-soft); color: var(--warning-text)"
        dir="rtl"
        lang="ar"
        role="status"
      >
        <span>
          إصدار البرنامج على هذا الجهاز ({{ appVersion }}) يختلف عن إصدار الجهاز الرئيسي ({{ serverVersion }}).
          يُنصح بتثبيت نفس الإصدار على كل الأجهزة.
        </span>
        <button type="button" class="rounded px-2 font-bold" aria-label="إخفاء" (click)="dismissed.set(true)">×</button>
      </div>
    }
    <!-- Bottom corner on the page side (away from the sidebar) in both directions; styles: _shell.scss. -->
    <div
      class="nota-version-label"
      dir="ltr"
      aria-hidden="true"
    >
      v{{ appVersion }}
    </div>
  `,
})
export class VersionNoticeComponent {
  private readonly config = getDesktopRuntimeConfig();
  protected readonly appVersion = this.config?.appVersion ?? '';
  protected readonly serverVersion = this.config?.serverVersion ?? '';
  protected readonly dismissed = signal(false);
  protected readonly mismatch = computed(
    () => Boolean(this.appVersion && this.serverVersion && this.appVersion !== this.serverVersion)
  );
}
