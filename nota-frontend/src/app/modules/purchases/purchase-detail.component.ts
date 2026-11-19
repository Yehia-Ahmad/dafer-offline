import { PrintActionItem, PrintActionsComponent } from '../../core/print/print-actions.component';
import { PrintDataService } from '../../core/print/print-data.service';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { NotaCanDirective } from '../../core/auth/nota-can.directive';
import { LockedActionComponent } from '../../core/auth/locked-action.component';
import { NotaButtonDirective, NotaCancelReasonDialogComponent, NotaMoneyPipe, NotaPageHeaderComponent, NotaStatusPillComponent, correctionErrorText } from '../shared/ui';
import { TranslateService } from '@ngx-translate/core';
import { PurchaseReturnDialogComponent } from './purchase-return-dialog.component';
import { PurchaseDetail } from './purchases.models';
import { PurchasesService } from './purchases.service';
import { LayoutService } from '../../core/layout/layout.service';
import { MobBarComponent, MobSheetComponent } from '../mobile/mob-sheet.component';
import { MobDatePipe } from '../mobile/mob-date.pipe';

/**
 * Stage 20: one purchase. Lines with the cost per unit, the returns made, the PV, "مرتجع لمورد", cancel (a reason is
 * required; locked pattern without purchases.cancel) and "عرض القيد" (accounting.view). Editing a posted purchase is
 * not possible: cancel and enter a new one.
 */
@Component({
  selector: 'app-purchase-detail',
  standalone: true,
  imports: [NotaCancelReasonDialogComponent, PrintActionsComponent, DatePipe, FormsModule, RouterLink, TranslatePipe, NotaCanDirective, LockedActionComponent, NotaButtonDirective, NotaMoneyPipe, NotaPageHeaderComponent, NotaStatusPillComponent, PurchaseReturnDialogComponent, MobBarComponent, MobSheetComponent, MobDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
@if (layout.isMobile()) {
    <!-- Online Stage 6B (phone): the same purchase. The number and supplier are in the top bar; lines as cards; return and cancel (a red sheet asking for the reason) with the same rules. -->
    @if (purchase(); as p) {
      <nota-mob-bar [title]="p.number" [subtitle]="p.supplierName || ''" />
      <div class="m-page" style="padding-top:12px">
        @if (pv()) { <p class="m-pill m-pill--ok" style="white-space:normal;align-self:flex-start" role="status" data-test="saved-pv">{{ 'purchases.detail.savedWithPv' | translate: { pv: pv() } }}</p> }
        <section class="m-card m-card--flush">
          <div class="m-row"><span class="m-row__body">{{ 'purchases.columns.status' | translate }}</span><span [class]="p.status === 'posted' ? 'm-pill m-pill--ok' : 'm-pill m-pill--warn'">{{ 'purchases.status.' + p.status | translate }}</span></div>
          <div class="m-row"><span class="m-row__body">{{ 'purchases.columns.date' | translate }}</span><span>{{ p.date | mobDate }}</span></div>
          <div class="m-row"><span class="m-row__body">{{ 'purchases.columns.supplierInvoiceNo' | translate }}</span><span dir="ltr">{{ p.supplierInvoiceNo || '—' }}</span></div>
          <div class="m-row"><span class="m-row__body">{{ 'purchases.columns.total' | translate }}</span><strong class="nota-num" data-test="total">{{ p.total | notaMoney }} {{ 'suppliers.currency' | translate }}</strong></div>
          <div class="m-row"><span class="m-row__body">{{ 'purchases.columns.paid' | translate }}
            @if (p.payment) { <span class="m-row__sub" style="white-space:normal">{{ p.payment.number }}@if (p.boxName) { · {{ p.boxName }} }@if (p.payment.status === 'cancelled') { · {{ 'purchases.status.cancelled' | translate }} }</span> }</span>
            <strong class="nota-num m-in" data-test="paid">{{ p.paidAmount | notaMoney }}</strong></div>
        </section>
        @if (p.status === 'cancelled') { <p class="m-pill m-pill--warn" style="white-space:normal" data-test="cancel-reason">{{ 'purchases.detail.cancelledBecause' | translate }}: {{ p.cancelReason }}</p> }

        <div class="m-section-label">{{ 'purchases.new.item' | translate }}</div>
        <section class="m-card m-card--flush" data-test="items">
          @for (item of p.items; track item._id) {
            <div class="m-row" [attr.data-item]="item.code">
              <span class="m-row__body">
                <span class="m-row__title" style="white-space:normal" dir="auto">{{ item.name }}</span>
                <span class="m-row__sub nota-num" style="white-space:normal"><span dir="ltr">{{ item.code }}</span> · {{ item.qty }} × {{ item.unitPrice | notaMoney }} · {{ 'purchases.detail.unitCost' | translate }} {{ item.unitCost | notaMoney }}@if (item.returnedQty) { · {{ 'purchases.detail.returned' | translate }} {{ item.returnedQty }} }</span>
              </span>
              <strong class="nota-num">{{ item.lineCost | notaMoney }}</strong>
            </div>
          }
          <div class="m-row"><span class="m-row__body">{{ 'purchases.detail.subtotal' | translate }}</span><span class="nota-num">{{ p.subtotal | notaMoney }}</span></div>
          @if (p.discountAmount) { <div class="m-row"><span class="m-row__body">{{ 'purchases.new.discount' | translate }}</span><span class="nota-num">− {{ p.discountAmount | notaMoney }}</span></div> }
          @if (p.otherCosts) { <div class="m-row"><span class="m-row__body">{{ 'purchases.new.otherCosts' | translate }}</span><span class="nota-num">+ {{ p.otherCosts | notaMoney }}</span></div> }
          @if (p.vatAmount !== undefined && p.vatAmount !== null) {
            <div class="m-row" data-test="vat-net"><span class="m-row__body">{{ 'vat.totals.net' | translate }}</span><span class="nota-num">{{ (p.netTotal ?? p.total) | notaMoney }}</span></div>
            <div class="m-row" data-test="vat-input"><span class="m-row__body">{{ 'vat.purchase.input' | translate }}</span><span class="nota-num">{{ p.vatAmount | notaMoney }}</span></div>
          }
        </section>

        @if (p.returns.length) {
          <div class="m-section-label">{{ 'purchases.detail.returns' | translate }}</div>
          <section class="m-card m-card--flush" data-test="returns">
            @for (r of p.returns; track r._id) {
              <div class="m-row"><span class="m-row__body" style="white-space:normal"><strong dir="ltr">{{ r.number }}</strong> · {{ r.date | mobDate }}@if (r.reason) { · {{ r.reason }} }</span><span class="nota-num m-out">{{ r.total | notaMoney }}</span></div>
            }
          </section>
        }

        <div style="display:flex;flex-direction:column;gap:8px">
          <nota-print-actions [items]="printItems(p._id)" data-test="purchase-print" />
          <a *notaCan="'accounting.view'" class="m-btn" [routerLink]="['/accounting/journal']" [queryParams]="{ sourceType: 'purchase', sourceId: p._id, sourceNumber: p.number }" data-action="journal">{{ 'purchases.detail.journal' | translate }}</a>
          @if (p.status === 'posted') {
            <button *notaCan="'purchases.create'" type="button" class="m-btn" data-action="return" [disabled]="!hasReturnable(p)" (click)="returnOpen.set(true)">{{ 'purchases.detail.return' | translate }}</button>
            <button *notaCan="'purchases.cancel'; else lockedM" type="button" class="m-btn m-btn--danger" data-action="cancel" (click)="cancelling.set(true)">{{ 'purchases.detail.cancel' | translate }}</button>
            <ng-template #lockedM><nota-locked-action [label]="'purchases.detail.cancel' | translate" /></ng-template>
          }
        </div>
        @if (p.status === 'posted' && p.payment) {
          <p class="m-note" style="padding:0" data-test="pv-note">{{ 'purchases.detail.pvNote' | translate }}</p>
          @if (p.payment.status === 'posted') { <button *notaCan="'suppliers.pay'" type="button" class="m-btn m-btn--danger" data-action="cancel-pv" (click)="pvError.set(''); pvOpen.set(true)">{{ 'purchases.detail.cancelPv' | translate }}</button> }
        }
        @if (error()) { <p class="nota-error" role="alert" data-test="detail-error">{{ error() | translate }}</p> }
      </div>
      <nota-mob-sheet [open]="cancelling()" (openChange)="cancelling.set($event)" [title]="'purchases.detail.cancel' | translate">
        <div data-test="cancel-form" style="display:flex;flex-direction:column;gap:12px">
          <label class="m-field">{{ 'purchases.detail.reason' | translate }}
            <input class="m-input" type="text" name="reasonM" maxlength="500" data-test="cancel-reason-input" [placeholder]="'purchases.detail.reason' | translate" [(ngModel)]="reason" />
          </label>
          @if (error()) { <p class="nota-error" role="alert" data-test="cancel-error">{{ error() | translate }}</p> }
          <div class="m-actions m-actions--sheet" style="padding:0;border:0">
            <button type="button" class="m-btn" (click)="cancelling.set(false)">{{ 'purchases.cancelAction' | translate }}</button>
            <button type="button" class="m-btn m-btn--danger" data-action="confirm-cancel" [disabled]="reason.trim().length < 3 || busy()" (click)="cancel()">{{ 'purchases.detail.confirmCancel' | translate }}</button>
          </div>
        </div>
      </nota-mob-sheet>
      <app-purchase-return-dialog [(visible)]="returnOpen" [purchase]="purchase()" (done)="load()" />
    } @else if (loadError()) {
      <div class="m-page" style="padding-top:12px"><div class="m-card m-empty"><p class="nota-error" role="alert">{{ 'purchases.loadFailed' | translate }}</p>
        <button type="button" class="m-btn" (click)="load()">{{ 'purchases.retry' | translate }}</button></div></div>
    } @else {
      <div class="m-page" style="padding-top:12px"><div class="m-skel" style="height:160px" role="status" [attr.aria-label]="'purchases.loading' | translate"></div><div class="m-skel" style="height:120px"></div></div>
    }
} @else {

    <div class="pd">
      @if (purchase(); as p) {
        <nota-page-header [title]="p.number" [subtitle]="p.supplierName || ''">
          <div notaPageActions>
            <a notaButton routerLink="/purchases" data-action="back">{{ 'purchases.title' | translate }}</a>
            <nota-print-actions [items]="printItems(p._id)" data-test="purchase-print" />
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
          @if (p.payment && p.status === 'posted') {
            <p class="pd__meta" data-test="pv-note">{{ 'purchases.detail.pvNote' | translate }}</p>
            @if (p.payment.status === 'posted') { <div><button *notaCan="'suppliers.pay'" type="button" notaButton="danger" data-action="cancel-pv" (click)="pvError.set(''); pvOpen.set(true)">{{ 'purchases.detail.cancelPv' | translate }}</button></div> }
          }
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
  }
  <!-- Online Fixes 1: cancel the payment voucher made with this purchase (a reversal; the box must still be active). -->
  <nota-cancel-reason-dialog [open]="pvOpen()" [title]="'purchases.detail.cancelPvTitle' | translate: { number: purchase()?.payment?.number }" [text]="'purchases.detail.cancelPvText' | translate"
    [confirmLabel]="'purchases.detail.cancelPv' | translate" [busy]="pvBusy()" [error]="pvError()" (confirmed)="cancelPv($event)" (closed)="pvOpen.set(false)" />
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
  protected readonly layout = inject(LayoutService);
  private readonly printData = inject(PrintDataService);
  /** Stage 23: the A4 purchase invoice (PrPurchaseInvoice). */
  printItems(id: string): PrintActionItem[] {
    return [{ key: 'purchase', load: () => this.printData.purchaseInvoice(id) }];
  }
  private readonly route = inject(ActivatedRoute);

  readonly purchase = signal<PurchaseDetail | null>(null);
  readonly loadError = signal(false);
  readonly returnOpen = signal(false);
  readonly cancelling = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly pv = signal<string | null>(null);
  /** Online Fixes 1: cancelling the payment voucher (PV) made with the purchase. */
  readonly pvOpen = signal(false);
  readonly pvBusy = signal(false);
  readonly pvError = signal('');
  private readonly translate = inject(TranslateService);
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

  cancelPv(reason: string): void {
    const payment = this.purchase()?.payment;
    if (!payment) return;
    this.pvBusy.set(true);
    this.pvError.set('');
    this.service.cancelPayment(payment._id, reason).subscribe({
      next: () => { this.pvBusy.set(false); this.pvOpen.set(false); this.load(); },
      error: (response) => { this.pvBusy.set(false); this.pvError.set(correctionErrorText(response, this.translate)); },
    });
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
