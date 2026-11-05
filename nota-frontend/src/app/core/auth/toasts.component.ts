import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { ToastService } from './toast.service';

@Component({
  selector: 'nota-toasts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  host: { class: 'nota-toasts', 'aria-live': 'polite', role: 'status' },
  template: `
    @for (toast of service.toasts(); track toast.id) {
      <div class="nota-toast" [class.is-error]="toast.kind === 'error'" [class.is-success]="toast.kind === 'success'">
        <span class="nota-toast__text">{{ toast.text }}</span>
        <button type="button" class="nota-toast__close" [attr.aria-label]="'auth.close' | translate" (click)="service.dismiss(toast.id)">×</button>
      </div>
    }
  `,
})
export class ToastsComponent {
  protected readonly service = inject(ToastService);
}
