import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { DialogModule } from 'primeng/dialog';
import { WebsiteCustomer } from '../../orders/orders.models';
import { OrdersService } from '../../orders/orders.service';
import { NotaButtonDirective, NotaDialogShellComponent, NotaPageHeaderComponent } from '../../shared/ui';

/**
 * Online Stage 4: /website/customers. Search by name or phone, orders count, deactivate/activate, and reset password:
 * a temporary password is shown ONCE to the staff member; the customer's sessions end.
 */
@Component({
  selector: 'app-website-customers',
  imports: [TranslatePipe, FormsModule, DatePipe, DialogModule, NotaButtonDirective, NotaDialogShellComponent, NotaPageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wc">
      <nota-page-header [title]="'websiteCustomers.title' | translate" [subtitle]="'websiteCustomers.subtitle' | translate" />
      <div class="wc__filters">
        <input class="nota-input" type="search" data-test="customer-search" [placeholder]="'websiteCustomers.search' | translate" [ngModel]="q()" (ngModelChange)="q.set($event)" (keyup.enter)="reload()" />
        <button type="button" notaButton data-action="search" (click)="reload()">{{ 'websiteCustomers.searchAction' | translate }}</button>
      </div>
      @if (loadError()) { <div class="wc__alert" role="alert">{{ 'websiteCustomers.loadFailed' | translate }}</div> }
      @if (errorMessage()) { <div class="wc__alert" role="alert">{{ errorMessage() }}</div> }
      <div class="nota-table-wrap">
        <table class="nota-table">
          <thead><tr>
            <th>{{ 'websiteCustomers.columns.name' | translate }}</th><th>{{ 'websiteCustomers.columns.phone' | translate }}</th>
            <th class="num">{{ 'websiteCustomers.columns.orders' | translate }}</th><th>{{ 'websiteCustomers.columns.joined' | translate }}</th>
            <th>{{ 'websiteCustomers.columns.status' | translate }}</th><th><span class="nota-sr-only">{{ 'tableHeaders.actions' | translate }}</span></th>
          </tr></thead>
          <tbody>
            @for (customer of rows(); track customer.id) {
              <tr data-test="customer-row" [class.is-off]="!customer.isActive">
                <td>{{ customer.name }}</td>
                <td class="nota-num wc__ltr">{{ customer.phone }}</td>
                <td class="nota-num">{{ customer.ordersCount }}</td>
                <td class="nota-num">{{ customer.createdAt | date: 'mediumDate' }}</td>
                <td><span class="nota-pill" [class.nota-pill--ok]="customer.isActive">{{ (customer.isActive ? 'websiteCustomers.active' : 'websiteCustomers.inactive') | translate }}</span></td>
                <td class="wc__actions">
                  <button type="button" notaButton data-action="reset-password" (click)="askReset(customer)">{{ 'websiteCustomers.resetPassword' | translate }}</button>
                  <button type="button" notaButton data-action="toggle-active" (click)="toggle(customer)">{{ (customer.isActive ? 'websiteCustomers.deactivate' : 'websiteCustomers.activate') | translate }}</button>
                </td>
              </tr>
            } @empty {
              @if (!loading()) { <tr><td colspan="6" class="wc__empty">{{ 'websiteCustomers.empty' | translate }}</td></tr> }
            }
          </tbody>
        </table>
      </div>
      @if (totalPages() > 1) {
        <div class="wc__pager">
          <button type="button" notaButton [disabled]="page() <= 1" (click)="go(page() - 1)">‹</button>
          <span class="nota-num">{{ page() }} / {{ totalPages() }}</span>
          <button type="button" notaButton [disabled]="page() >= totalPages()" (click)="go(page() + 1)">›</button>
        </div>
      }
    </div>

    <p-dialog [visible]="resetting() !== null" (visibleChange)="$event ? null : closeReset()" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog">
      <nota-dialog-shell [title]="'websiteCustomers.resetPassword' | translate" [closeLabel]="'websiteCustomers.close' | translate" (closed)="closeReset()">
        @if (temporaryPassword(); as password) {
          <p>{{ 'websiteCustomers.passwordShownOnce' | translate }}</p>
          <p class="wc__password nota-num" data-test="temporary-password">{{ password }}</p>
        } @else {
          <p>{{ 'websiteCustomers.resetConfirm' | translate: { name: resetting()?.name } }}</p>
        }
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="closeReset()">{{ 'websiteCustomers.close' | translate }}</button>
          @if (!temporaryPassword()) {
            <button type="button" notaButton="primary" data-action="confirm-reset" [disabled]="busy()" (click)="confirmReset()">{{ 'websiteCustomers.resetPassword' | translate }}</button>
          }
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>
  `,
  styles: `
    :host { display: block; }
    .wc { display: flex; flex-direction: column; gap: var(--space-gap); }
    .wc__filters { display: flex; gap: 10px; flex-wrap: wrap; }
    .wc__alert { padding: 14px 16px; border-radius: 12px; background: var(--danger-soft); color: var(--danger-text); }
    .wc__ltr { direction: ltr; text-align: start; }
    .wc__actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .wc__empty { text-align: center; color: var(--text-muted); padding: 24px; }
    .wc__pager { display: flex; gap: 12px; align-items: center; justify-content: center; }
    .wc__password { font-size: 26px; font-weight: 800; letter-spacing: 1px; direction: ltr; text-align: center; padding: 14px; border-radius: 12px; background: var(--brand-soft); user-select: all; }
    tr.is-off td { color: var(--text-muted); }
  `,
})
export class WebsiteCustomersComponent implements OnInit {
  private readonly service = inject(OrdersService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly rows = signal<WebsiteCustomer[]>([]);
  protected readonly q = signal('');
  protected readonly page = signal(1);
  protected readonly totalPages = signal(1);
  protected readonly loading = signal(true);
  protected readonly loadError = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly busy = signal(false);
  protected readonly resetting = signal<WebsiteCustomer | null>(null);
  protected readonly temporaryPassword = signal('');

  ngOnInit(): void {
    this.load();
  }

  protected reload(): void { this.page.set(1); this.load(); }
  protected go(page: number): void { this.page.set(page); this.load(); }

  protected load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.service.listWebsiteCustomers(this.q(), this.page()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response) => { this.rows.set(response.data); this.totalPages.set(response.pagination.totalPages || 1); this.loading.set(false); },
      error: () => { this.loadError.set(true); this.loading.set(false); },
    });
  }

  protected toggle(customer: WebsiteCustomer): void {
    this.errorMessage.set('');
    this.service.setWebsiteCustomerActive(customer.id, !customer.isActive).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.load(),
      error: (response) => this.errorMessage.set(typeof response?.error?.message === 'string' ? response.error.message : ''),
    });
  }

  protected askReset(customer: WebsiteCustomer): void {
    this.temporaryPassword.set('');
    this.resetting.set(customer);
  }

  protected confirmReset(): void {
    const customer = this.resetting();
    if (!customer) return;
    this.busy.set(true);
    this.service.resetWebsiteCustomerPassword(customer.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response) => { this.busy.set(false); this.temporaryPassword.set(response.temporaryPassword); },
      error: (response) => { this.busy.set(false); this.resetting.set(null); this.errorMessage.set(typeof response?.error?.message === 'string' ? response.error.message : ''); },
    });
  }

  /** The password lives only in this signal: closing the dialog forgets it for good. */
  protected closeReset(): void {
    this.temporaryPassword.set('');
    this.resetting.set(null);
  }
}
