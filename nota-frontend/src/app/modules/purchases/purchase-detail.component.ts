import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { NotaCanDirective } from '../../core/auth/nota-can.directive';
import { LockedActionComponent } from '../../core/auth/locked-action.component';
import { NotaButtonDirective, NotaMoneyPipe, NotaPageHeaderComponent, NotaStatusPillComponent } from '../shared/ui';
import { PurchaseReturnDialogComponent } from './purchase-return-dialog.component';
import { PurchaseDetail } from './purchases.models';
import { PurchasesService } from './purchases.service';

/**
 * Stage 20: one purchase. Lines with the cost per unit, the returns made, the PV, "مرتجع لمورد", cancel (a reason is
 * required; locked pattern without purchases.cancel) and "عرض القيد" (accounting.view). Editing a posted purchase is
 * not possible: cancel and enter a new one.
 */
@Component({
  selector: 'app-purchase-detail',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterLink, TranslatePipe, NotaCanDirective, LockedActionComponent, NotaButtonDirective, NotaMoneyPipe, NotaPageHeaderComponent, NotaStatusPillComponent, PurchaseReturnDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pd">
      @if (purchase(); as p) {
        <nota-page-header [title]="p.number" [subtitle]="p.supplierName || ''">
          <div notaPageActions>
            <a notaButton routerLink="/purchases" data-action="back">{{ 'purchases.title' | translate }}</a>
            <a *notaCan="'accounting.view'" notaButton [routerLink]="['/accounting/journal']" [queryParams]="{ sourceType: 'purchase', sourceId: p._id, sourceNumber: p.number }" data-action="journal">{{ 'purchases.detail.journal' | translate }}</a>
          </div>
        </nota-page-header>

        @if (pv()) { <p class="pd__saved" role="status" data-test="saved-pv">{{ 'purchases.detail.savedWithPv' | translate: { pv: pv() } }}</p> }

        <section class="nota-card pd__card">
          <dl class="pd__facts">
            <div><dt>{{ 'purchases.columns.status' | translate }}</dt><dd><nota-status-pill [variant]="p.status === 'posted' ? 'ok' : 'overdue'">{{ 'purchases.status.' + p.status | translate }}</nota-status-pill></dd></div>
            <div><dt>{{ 'purchases.columns.date' | translate }}</dt><dd class="nota-num">{{ p.date | date: 'yyyy-MM-dd' }}</dd></div>
            <div><dt>{{ 'purchases.columns.supplierInvoiceNo' | translate }}</dt><dd dir="ltr">{{ p.supplierInvoiceNo || '—' }}</dd></div>
            <div><dt>{{ 'purchases.columns.total' | translate }}</dt><dd class="nota-num" data-test="total">{{ p.total | notaMoney }}</dd></div>
            <div><dt>{{ 'purchases.columns.paid' | translate }}</dt><dd class="nota-num" data-test="paid">{{ p.paidAmount | notaMoney }}
              @if (p.payment) { <small>({{ p.payment.number }}@if (p.boxName) { · {{ p.boxName }} }@if (p.payment.status === 'cancelled') { · {{ 'purchases.status.cancelled' | translate }} })</small> }</dd></div>
          </dl>
          @if (p.status === 'cancelled') { <p class="nota-error" data-test="cancel-reason">{{ 'purchases.detail.cancelledBecause' | translate }}: {{ p.cancelReason }}</p> }
        </section>

        <section class="nota-card">
          <div class="nota-table-wrap">
            <table class="nota-table" data-test="items">
              <thead><tr>
                <th>{{ 'purchases.new.item' | translate }}</th>
                <th class="nota-num">{{ 'purchases.new.qty' | translate }}</th>
                <th class="nota-num">{{ 'purchases.new.unitPrice' | translate }}</th>
                <th class="nota-num">{{ 'purchases.detail.unitCost' | translate }}</th>
                <th class="nota-num">{{ 'purchases.new.lineTotal' | translate }}</th>
                <th class="nota-num">{{ 'purchases.detail.returned' | translate }}</th>
              </tr></thead>
              <tbody>
                @for (item of p.items; track item._id) {
                  <tr [attr.data-item]="item.code">
                    <td><strong>{{ item.name }}</strong><div class="pd__meta">{{ item.code }}</div></td>
                    <td class="nota-num">{{ item.qty }}</td>
                    <td class="nota-num">{{ item.unitPrice | notaMoney }}</td>
                    <td class="nota-num">{{ item.unitCost | notaMoney }}</td>
                    <td class="nota-num">{{ item.lineCost | notaMoney }}</td>
                    <td class="nota-num">{{ item.returnedQty }}</td>
                  </tr>
                }
              </tbody>
              <tfoot>
                <tr><td colspan="4">{{ 'purchases.detail.subtotal' | translate }}</td><td class="nota-num" colspan="2">{{ p.subtotal | notaMoney }}</td></tr>
                @if (p.discountAmount) { <tr><td colspan="4">{{ 'purchases.new.discount' | translate }}</td><td class="nota-num" colspan="2">− {{ p.discountAmount | notaMoney }}</td></tr> }
                @if (p.otherCosts) { <tr><td colspan="4">{{ 'purchases.new.otherCosts' | translate }}</td><td class="nota-num" colspan="2">+ {{ p.otherCosts | notaMoney }}</td></tr> }
                @if (p.vatAmount !== undefined && p.vatAmount !== null) {
                  <tr data-test="vat-net"><td colspan="4">{{ 'vat.totals.net' | translate }}</td><td class="nota-num" colspan="2">{{ (p.netTotal ?? p.total) | notaMoney }}</td></tr>
                  <tr data-test="vat-input"><td colspan="4">{{ 'vat.purchase.input' | translate }}</td><td class="nota-num" colspan="2">{{ p.vatAmount | notaMoney }}</td></tr>
                }
              </tfoot>
            </table>
          </div>
        </section>

        @if (p.returns.length) {
          <section class="nota-card pd__card" data-test="returns">
            <h3 class="pd__h">{{ 'purchases.detail.returns' | translate }}</h3>
            @for (r of p.returns; track r._id) {
              <div class="pd__return"><span><strong>{{ r.number }}</strong> · {{ r.date | date: 'yyyy-MM-dd' }}@if (r.reason) { · {{ r.reason }} }</span><span class="nota-num">{{ r.total | notaMoney }}</span></div>
            }
          </section>
        }

        @if (p.status === 'posted') {
          <section class="pd__actions">
            <button *notaCan="'purchases.create'" type="button" notaButton data-action="return" [disabled]="!hasReturnable(p)" (click)="returnOpen.set(true)">{{ 'purchases.detail.return' | translate }}</button>
            <ng-container *notaCan="'purchases.cancel'; else locked">
              @if (!cancelling()) {
                <button type="button" notaButton="danger" data-action="cancel" (click)="cancelling.set(true)">{{ 'purchases.detail.cancel' | translate }}</button>
              } @else {
                <div class="pd__cancel" data-test="cancel-form">
                  <input class="nota-input" type="text" name="reason" maxlength="500" data-test="cancel-reason-input" [attr.aria-label]="'purchases.detail.reason' | translate" [placeholder]="'purchases.detail.reason' | translate" [(ngModel)]="reason" />
                  <button type="button" notaButton="danger" data-action="confirm-cancel" [disabled]="reason.trim().length < 3 || busy()" (click)="cancel()">{{ 'purchases.detail.confirmCancel' | translate }}</button>
                  <button type="button" notaButton (click)="cancelling.set(false)">{{ 'purchases.cancelAction' | translate }}</button>
                </div>
              }
            </ng-container>
            <ng-template #locked><nota-locked-action [label]="'purchases.detail.cancel' | translate" /></ng-template>
          </section>
          @if (p.payment && p.status === 'posted') { <p class="pd__meta" data-test="pv-note">{{ 'purchases.detail.pvNote' | translate }}</p> }
        }
        @if (error()) { <p class="nota-error" role="alert" data-test="detail-error">{{ error() | translate }}</p> }
        <app-purchase-return-dialog [(visible)]="returnOpen" [purchase]="purchase()" (done)="load()" />
      } @else if (loadError()) {
        <p class="nota-error" role="alert">{{ 'purchases.loadFailed' | translate }}</p>
        <button type="button" notaButton (click)="load()">{{ 'purchases.retry' | translate }}</button>
      } @else {
        <p role="status">{{ 'purchases.loading' | translate }}</p>
      }
    </div>
  `,
  styles: `
    .pd { display: flex; flex-direction: column; gap: 16px; }
    .pd__card { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .pd__facts { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
    .pd__facts dt { font-size: 12px; color: var(--text-muted); } .pd__facts dd { margin: 4px 0 0; font-weight: 700; }
    .pd__facts small { font-weight: 400; color: var(--text-muted); }
    .pd__meta { font-size: 12px; color: var(--text-muted); margin: 0; }
    .pd__h { margin: 0; font-size: 15px; }
    .pd__return { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }
    .pd__actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .pd__cancel { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; } .pd__cancel .nota-input { min-width: 220px; }
    .pd__saved { margin: 0; padding: 10px 12px; border-radius: var(--radius-control); background: var(--success-soft); color: var(--success-text); font-weight: 700; }
  `,
})
export class PurchaseDetailComponent implements OnInit {
  private readonly service = inject(PurchasesService);
  private readonly route = inject(ActivatedRoute);

  readonly purchase = signal<PurchaseDetail | null>(null);
  readonly loadError = signal(false);
  readonly returnOpen = signal(false);
  readonly cancelling = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly pv = signal<string | null>(null);
  reason = '';

  ngOnInit(): void {
    this.pv.set(this.route.snapshot.queryParamMap.get('pv'));
    this.load();
  }

  load(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) return;
    this.loadError.set(false);
    this.service.get(id).subscribe({ next: (row) => this.purchase.set(row), error: () => this.loadError.set(true) });
  }

  hasReturnable(p: PurchaseDetail): boolean {
    return p.items.some((item) => item.qty - item.returnedQty > 0);
  }

  cancel(): void {
    const p = this.purchase();
    if (!p || this.reason.trim().length < 3) return;
    this.busy.set(true);
    this.error.set('');
    this.service.cancel(p._id, this.reason.trim()).subscribe({
      next: () => { this.busy.set(false); this.cancelling.set(false); this.reason = ''; this.load(); },
      error: (response) => {
        this.busy.set(false);
        const code = response?.error?.code;
        this.error.set(code === 'STOCK_ALREADY_USED' || code === 'HAS_RETURNS' ? `purchases.errors.${code}` : 'purchases.errors.cancelFailed');
      },
    });
  }
}
