import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { DesktopConnectionState, getDesktopBridge } from '../core/runtime/runtime-config';

/**
 * Offline edition only: covers the app while the server cannot be reached, without
 * reloading it, so unsaved work on the page (such as an invoice) is still there afterwards.
 * Always Arabic, whatever the UI language, because it is shown to every shop PC user.
 */
@Component({
  selector: 'app-connection-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div
        class="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-4"
        dir="rtl"
        lang="ar"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="connection-overlay-title"
      >
        <div class="w-full max-w-md rounded-2xl bg-white p-6 text-center text-[#2f2f2f] shadow-2xl">
          <h2 id="connection-overlay-title" class="mb-3 text-xl font-bold">{{ title() }}</h2>
          <p class="mb-2 leading-7">{{ message() }}</p>
          <p class="mb-5 text-sm text-gray-500">بياناتك على هذه الصفحة محفوظة وستعود عند عودة الاتصال.</p>
          @if (!waitOnly()) {
            <div class="flex flex-wrap justify-center gap-3">
              <button
                type="button"
                class="rounded-lg bg-[#FF9933] px-5 py-2 font-semibold disabled:opacity-60"
                [disabled]="retrying()"
                (click)="retry()"
              >
                {{ retrying() ? 'جاري المحاولة...' : 'إعادة المحاولة' }}
              </button>
              @if (state().role === 'client') {
                <button type="button" class="rounded-lg px-5 py-2 outline outline-1 outline-gray-400" (click)="changeAddress()">
                  تغيير عنوان الجهاز الرئيسي
                </button>
              }
            </div>
          } @else {
            <div class="mx-auto h-6 w-6 animate-spin rounded-full border-4 border-gray-300 border-t-[#FF9933]"></div>
          }
        </div>
      </div>
    }
  `,
})
export class ConnectionOverlayComponent {
  private readonly bridge = getDesktopBridge();
  protected readonly state = signal<DesktopConnectionState>({ connected: true });
  protected readonly retrying = signal(false);
  protected readonly visible = computed(() => !this.state().connected);
  /** The main PC is restarting or pausing its own server: nothing to do but wait. */
  protected readonly waitOnly = computed(() =>
    ['server-restarting', 'server-maintenance'].includes(this.state().reason ?? '')
  );

  protected readonly title = computed(() => {
    switch (this.state().reason) {
      case 'server-restarting':
        return 'جاري إعادة تشغيل الخادم';
      case 'server-maintenance':
        return 'جاري حفظ النسخة الاحتياطية اليومية';
      default:
        return 'لا يوجد اتصال بالجهاز الرئيسي';
    }
  });

  protected readonly message = computed(() => {
    const { reason, address } = this.state();
    switch (reason) {
      case 'server-restarting':
        return 'توقف الخادم على هذا الجهاز وتتم إعادة تشغيله الآن. انتظر قليلاً.';
      case 'server-maintenance':
        return 'يتوقف الخادم لثوانٍ أثناء حفظ النسخة الاحتياطية اليومية، ثم يعود تلقائياً.';
      case 'unauthorized':
        return 'تم تغيير كلمة سر الشبكة على الجهاز الرئيسي. أدخل كلمة السر الجديدة.';
      default:
        return `تعذر الوصول إلى الجهاز الرئيسي${address ? ` (${address})` : ''}. تأكد أنه يعمل وأن البرنامج مفتوح عليه، وأن الجهازين على نفس الشبكة.`;
    }
  });

  constructor() {
    if (!this.bridge?.onConnection) return;
    const unsubscribe = this.bridge.onConnection((state) => this.state.set(state));
    inject(DestroyRef).onDestroy(unsubscribe);
    this.bridge.getConnection?.().then((state) => this.state.set(state));
  }

  protected async retry(): Promise<void> {
    if (!this.bridge?.retryConnection) return;
    this.retrying.set(true);
    try {
      this.state.set(await this.bridge.retryConnection());
    } finally {
      this.retrying.set(false);
    }
  }

  protected changeAddress(): void {
    this.bridge?.changeServerAddress?.();
  }
}
