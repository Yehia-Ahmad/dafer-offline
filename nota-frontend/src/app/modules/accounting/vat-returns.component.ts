import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { Dialog } from 'primeng/dialog';
import { AuthService } from '../../core/auth/auth.service';
import { localDateKey } from '../../core/utilities/local-date';
import { PaymentBoxSelectComponent } from '../cashbox/payment-box-select.component';
import { PaymentBoxService } from '../cashbox/payment-box.service';
import { NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaKpiCardComponent, NotaMoneyPipe, NotaPageHeaderComponent, NotaStatusPillComponent } from '../shared/ui';
import { NotaPillVariant } from '../shared/ui/status-pill.component';
import { PrintActionItem, PrintActionsComponent } from '../../core/print/print-actions.component';
import { PrintDataService } from '../../core/print/print-data.service';
import { TranslateService } from '@ngx-translate/core';
import { VatReturnsService } from './vat-returns.service';
import { LayoutService } from '../../core/layout/layout.service';
import { MobSheetComponent } from '../mobile/mob-sheet.component';
import { MobNumberInputComponent } from '../mobile/mob-number-input.component';
import { MobDatePipe } from '../mobile/mob-date.pipe';
import { VAT_LINE_GROUPS, VatLine, VatLineGroup, VatReturnDetail, VatReturnList, VatReturnRow, VatReturnStatus } from './vat.models';

const PILL: Record<VatReturnStatus, NotaPillVariant> = { open: 'neutral', filed: 'info', partial: 'due', paid: 'ok' };
const KNOWN_ERRORS = ['OUT_OF_ORDER', 'ALREADY_FILED', 'PERIOD_NOT_ENDED', 'EXCEEDS_REMAINING', 'NOTHING_DUE', 'NOT_FILED', 'NOT_LATEST', 'HAS_PAYMENTS', 'OWNER_ONLY',
  'INSUFFICIENT_BALANCE', 'NO_OPEN_SHIFT', 'BOX_INACTIVE', 'BOX_NOT_ALLOWED'];

/**
 * Stage 21: "الإقرار الضريبي" (/accounting/vat). One row per month: output VAT (sales - returns), input VAT (purchases + expenses -
 * purchase returns), the credit carried in, and the net. A month opens into its documents (sales, returns, purchases, purchase
 * returns, expenses) with an Excel export. vat.file: file the return (one posting: Dr 22 / Cr 115 = the offset), pay what is
 * owed from a box (partly or fully), unfile the latest return (owner only, with a reason, only while nothing was paid).
 */
@Component({
  selector: 'app-vat-returns',
  standalone: true,
  imports: [PrintActionsComponent, DatePipe, FormsModule, TranslatePipe, Dialog, NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaKpiCardComponent, NotaMoneyPipe, NotaPageHeaderComponent, NotaStatusPillComponent, PaymentBoxSelectComponent, MobSheetComponent, MobNumberInputComponent, MobDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
@if (layout.isMobile()) {
    <!-- Online Stage 6B (phone): the same VAT returns. One card per month (tap = that month's return in a sheet: figures, the documents by group as cards, payments, and the file / pay / unfile actions). -->
    @if (loadError()) { <p class="nota-error m-note" role="alert" data-test="load-error">{{ 'vat.returns.loadFailed' | translate }}</p> }
    @if (list(); as l) {
      @if (!l.settings.enabled && !l.data.length) { <p class="m-pill m-pill--muted" style="white-space:normal;margin:12px 14px" data-test="vat-off">{{ 'vat.returns.off' | translate }}</p> }
      <div class="m-page" style="padding-top:12px" data-test="months">
        <div class="m-card m-card--flush">
          @for (row of l.data; track row.period) {
            <div class="m-row m-stretch-host" [attr.data-period]="row.period">
              <button type="button" class="m-row__open m-stretch" (click)="open(row.period)">
                <span class="m-row__title nota-num" dir="ltr" style="display:block;text-align:start"><strong>{{ row.period }}</strong>@if (row.number) { <small class="m-row__sub"> {{ row.number }}</small> }</span>
                <span class="m-row__sub nota-num" style="display:block;white-space:normal">{{ 'vat.returns.output' | translate }} {{ row.output | notaMoney }} · {{ 'vat.returns.input' | translate }} {{ row.input | notaMoney }}</span>
              </button>
              <span class="m-row__end nota-num">
                <strong [class.m-in]="row.net < 0" style="display:block">{{ abs(row.net) | notaMoney }}</strong>
                @if (row.net < 0) { <span class="m-row__sub" style="display:block">{{ 'vat.returns.creditTag' | translate }}</span> }
                <span [class]="row.status === 'paid' ? 'm-pill m-pill--ok' : row.status === 'open' ? 'm-pill m-pill--muted' : 'm-pill m-pill--warn'">{{ 'vat.status.' + row.status | translate }}</span>
              </span>
            </div>
          } @empty { <div class="m-empty">{{ 'vat.returns.noLines' | translate }}</div> }
        </div>
      </div>
    } @else if (!loadError()) {
      <div class="m-page" style="padding-top:12px"><div class="m-skel" style="height:120px" data-test="loading"></div></div>
    }
    @if (error()) { <p class="nota-error m-note" role="alert" data-test="action-error">{{ error() | translate }}</p> }

    <nota-mob-sheet [open]="detail() !== null" (openChange)="$event || closeDetail()" [title]="detail()?.period ?? ''">
      @if (detail(); as d) {
        <div data-test="detail" [attr.data-period]="d.period" style="display:flex;flex-direction:column;gap:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <span [class]="d.status === 'paid' ? 'm-pill m-pill--ok' : d.status === 'open' ? 'm-pill m-pill--muted' : 'm-pill m-pill--warn'">{{ 'vat.status.' + d.status | translate }}</span>
            @if (d.number) { <span class="m-row__sub" dir="ltr">{{ d.number }}</span> }
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="m-card" style="padding:12px" data-kpi="output"><div class="m-row__sub">{{ 'vat.returns.output' | translate }}</div><strong class="nota-num">{{ d.output | notaMoney }}</strong></div>
            <div class="m-card" style="padding:12px" data-kpi="input"><div class="m-row__sub">{{ 'vat.returns.input' | translate }}</div><strong class="nota-num">{{ d.input | notaMoney }}</strong></div>
            <div class="m-card" style="padding:12px" data-kpi="carried"><div class="m-row__sub">{{ 'vat.returns.carried' | translate }}</div><strong class="nota-num">{{ d.carriedIn | notaMoney }}</strong></div>
            <div class="m-card" style="padding:12px;background:var(--brand);color:var(--on-brand)" data-kpi="net"><div class="m-row__sub" style="color:inherit;opacity:.85">{{ (d.net < 0 ? 'vat.returns.creditForward' : 'vat.returns.payable') | translate }}</div><strong class="nota-num">{{ abs(d.net) | notaMoney }}</strong></div>
          </div>
          @if (d.status !== 'open') { <p class="m-note" style="padding:0" class="nota-num">{{ 'vat.returns.paid' | translate }}: {{ d.paid | notaMoney }} · {{ 'vat.returns.remaining' | translate }}: {{ d.remaining | notaMoney }}</p> }
          @if (d.status === 'open' && !d.canFile) { <p class="m-pill m-pill--muted" style="white-space:normal" data-test="order-note">{{ (d.period === list()?.nextPeriod ? 'vat.returns.notEnded' : 'vat.returns.orderRule') | translate: { next: list()?.nextPeriod } }}</p> }
          <div style="display:flex;flex-direction:column;gap:8px">
            <nota-print-actions [items]="returnPrintItems(d)" data-test="vat-print" />
            <button type="button" class="m-btn" data-action="export" [disabled]="exporting()" (click)="exportExcel(d)">{{ 'vat.returns.export' | translate }}</button>
            @if (canFile() && d.canFile) { <button type="button" class="m-btn m-btn--primary" data-action="file" (click)="fileOpen.set(true)">{{ 'vat.returns.file' | translate }}</button> }
            @if (canFile() && d.status !== 'open' && d.remaining > 0) { <button type="button" class="m-btn m-btn--primary" data-action="pay" (click)="openPay(d)">{{ 'vat.returns.pay' | translate }}</button> }
            @if (isOwner() && d.canUnfile) { <button type="button" class="m-btn m-btn--danger" data-action="unfile" (click)="unfileOpen.set(true)">{{ 'vat.returns.unfile' | translate }}</button> }
          </div>

          <div class="m-chips" style="padding:0" role="tablist" [attr.aria-label]="'vat.returns.documents' | translate">
            @for (group of groups; track group) {
              <button type="button" role="tab" class="m-chip" [class.is-active]="tab() === group" [attr.aria-selected]="tab() === group" [attr.data-tab]="group" (click)="tab.set(group)">{{ 'vat.groups.' + group | translate }} <span class="m-chip__count nota-num">{{ d.lines[group].length }}</span></button>
            }
          </div>
          <div class="m-card m-card--flush" data-test="lines">
            @for (line of lines(); track $index) {
              <div class="m-row"><span class="m-row__body"><span class="m-row__title" dir="ltr" style="text-align:start">{{ line.number || '—' }}</span><span class="m-row__sub" style="white-space:normal">{{ 'vat.kinds.' + line.kind | translate }} · {{ line.date | mobDate }} · {{ 'vat.returns.lineNet' | translate }} {{ line.net | notaMoney }}</span></span><strong class="nota-num">{{ line.vat | notaMoney }}</strong></div>
            } @empty { <div class="m-empty">{{ 'vat.returns.noLines' | translate }}</div> }
            <div class="m-row"><strong class="m-row__body">{{ 'vat.returns.total' | translate }}</strong><span class="nota-num">{{ lineTotals().net | notaMoney }} · <strong>{{ lineTotals().vat | notaMoney }}</strong></span></div>
          </div>

          @if (d.payments.length) {
            <div class="m-section-label">{{ 'vat.returns.payments' | translate }}</div>
            <div class="m-card m-card--flush" data-test="payments">
              @for (p of d.payments; track p._id) {
                <div class="m-row" style="flex-wrap:wrap"><span class="m-row__body"><span class="m-row__title" dir="ltr" style="text-align:start">{{ p.number }}</span><span class="m-row__sub" style="white-space:normal">{{ p.date | mobDate }}@if (p.boxName) { · {{ p.boxName }} }@if (p.reference) { · {{ p.reference }} }</span></span><strong class="nota-num">{{ p.amount | notaMoney }}</strong><nota-print-actions [items]="paymentPrintItems(d, p)" /></div>
              }
            </div>
          }
        </div>
      }
    </nota-mob-sheet>

    <!-- File: shows the posting first. -->
    <p-dialog [visible]="fileOpen()" (visibleChange)="fileOpen.set($event)" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog">
      <nota-dialog-shell [title]="'vat.file.title' | translate: { period: detail()?.period }" [closeLabel]="'vat.close' | translate" (closed)="fileOpen.set(false)">
        @if (detail(); as d) {
          <dl class="vr__facts" data-test="file-figures">
            <div><dt>{{ 'vat.returns.output' | translate }}</dt><dd class="nota-num">{{ d.output | notaMoney }}</dd></div>
            <div><dt>{{ 'vat.returns.input' | translate }}</dt><dd class="nota-num">{{ d.input | notaMoney }}</dd></div>
            <div><dt>{{ 'vat.returns.carried' | translate }}</dt><dd class="nota-num">{{ d.carriedIn | notaMoney }}</dd></div>
            <div class="vr__strong"><dt>{{ (d.net < 0 ? 'vat.returns.creditForward' : 'vat.returns.payable') | translate }}</dt><dd class="nota-num">{{ abs(d.net) | notaMoney }}</dd></div>
          </dl>
          <h3 class="vr__h">{{ 'vat.file.posting' | translate }}</h3>
          <ul class="vr__posting" data-test="file-posting">
            @if (d.offset < 0) {
              <li data-test="posting-negative"><span>{{ 'vat.file.debitInput' | translate }}</span><b class="nota-num">{{ abs(d.offset) | notaMoney }}</b></li>
              <li><span>{{ 'vat.file.creditPayable' | translate }}</span><b class="nota-num">{{ abs(d.offset) | notaMoney }}</b></li>
            } @else {
              <li><span>{{ 'vat.file.debit' | translate }}</span><b class="nota-num">{{ d.offset | notaMoney }}</b></li>
              <li><span>{{ 'vat.file.credit' | translate }}</span><b class="nota-num">{{ d.offset | notaMoney }}</b></li>
            }
          </ul>
          @if (d.offset < 0) { <p class="vr__note" data-test="negative-note">{{ 'vat.file.negativeNote' | translate }}</p> }
          <p class="vr__note">{{ (d.net < 0 ? 'vat.file.creditNote' : 'vat.file.payableNote') | translate }}</p>
        }
        @if (error()) { <p class="nota-error" role="alert" data-test="dialog-error">{{ error() | translate }}</p> }
        <ng-container notaDialogFooter>
          <button type="button" class="m-btn" (click)="fileOpen.set(false)">{{ 'vat.cancel' | translate }}</button>
          <button type="button" class="m-btn m-btn--primary" data-action="confirm-file" [disabled]="busy()" (click)="confirmFile()">{{ 'vat.file.confirm' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>

    <!-- Pay: from a box, amount up to what is left. -->
    <p-dialog [visible]="payOpen()" (visibleChange)="payOpen.set($event)" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog">
      <nota-dialog-shell [title]="'vat.pay.title' | translate: { period: detail()?.period }" [closeLabel]="'vat.close' | translate" (closed)="payOpen.set(false)">
        @if (detail(); as d) {
          <p class="vr__note" data-test="pay-remaining">{{ 'vat.pay.remaining' | translate }}: <b class="nota-num">{{ d.remaining | notaMoney }}</b></p>
          <label class="m-field">{{ 'vat.pay.amount' | translate }} *
            <nota-mob-number inputId="vrPayAmount" data-test="pay-amount" [min]="0" [decimals]="2" [ngModel]="payAmount()" (ngModelChange)="payAmount.set($event)" [ngModelOptions]="{ standalone: true }" /></label>
          @if (payInvalid()) { <p class="nota-error" role="alert">{{ 'vat.pay.invalid' | translate }}</p> }
          <nota-payment-box-select labelKey="vat.pay.fromBox" />
          <label class="m-field">{{ 'vat.pay.reference' | translate }}
            <input id="vrPayRef" class="m-input" type="text" name="payRef" maxlength="100" data-test="pay-reference" [ngModel]="payReference()" (ngModelChange)="payReference.set($event)" /></label>
          <label class="m-field">{{ 'vat.pay.note' | translate }}
            <input id="vrPayNote" class="m-input" type="text" name="payNote" maxlength="500" data-test="pay-note" [ngModel]="payNote()" (ngModelChange)="payNote.set($event)" /></label>
        }
        @if (error()) { <p class="nota-error" role="alert" data-test="dialog-error">{{ error() | translate }}</p> }
        <ng-container notaDialogFooter>
          <button type="button" class="m-btn" (click)="payOpen.set(false)">{{ 'vat.cancel' | translate }}</button>
          <button type="button" class="m-btn m-btn--primary" data-action="confirm-pay" [disabled]="payInvalid() || busy() || payment.needsShift()" (click)="confirmPay()">{{ 'vat.pay.confirm' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>

    <!-- Unfile: owner only, a reason. -->
    <p-dialog [visible]="unfileOpen()" (visibleChange)="unfileOpen.set($event)" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog">
      <nota-dialog-shell [title]="'vat.unfile.title' | translate: { period: detail()?.period }" [closeLabel]="'vat.close' | translate" (closed)="unfileOpen.set(false)">
        <p class="vr__note">{{ 'vat.unfile.note' | translate }}</p>
        <label class="m-field">{{ 'vat.unfile.reason' | translate }} *
          <textarea id="vrUnfileReason" class="m-input" rows="2" name="unfileReason" maxlength="500" data-test="unfile-reason" [ngModel]="unfileReason()" (ngModelChange)="unfileReason.set($event)"></textarea></label>
        @if (error()) { <p class="nota-error" role="alert" data-test="dialog-error">{{ error() | translate }}</p> }
        <ng-container notaDialogFooter>
          <button type="button" class="m-btn" (click)="unfileOpen.set(false)">{{ 'vat.cancel' | translate }}</button>
          <button type="button" class="m-btn m-btn--danger" data-action="confirm-unfile" [disabled]="unfileReason().trim().length < 3 || busy()" (click)="confirmUnfile()">{{ 'vat.unfile.confirm' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>
} @else {

    <div class="vr">
      <nota-page-header [title]="'vat.returns.title' | translate" [subtitle]="'vat.returns.subtitle' | translate" />

      @if (loadError()) { <p class="nota-error" role="alert" data-test="load-error">{{ 'vat.returns.loadFailed' | translate }}</p> }

      @if (list(); as l) {
        @if (!l.settings.enabled && !l.data.length) { <p class="vr__note" data-test="vat-off">{{ 'vat.returns.off' | translate }}</p> }

        <section class="vr__list nota-card" data-test="months">
          <div class="nota-table-wrap">
            <table class="nota-table vr__table">
              <thead><tr>
                <th>{{ 'vat.returns.period' | translate }}</th>
                <th class="nota-num">{{ 'vat.returns.output' | translate }}</th>
                <th class="nota-num">{{ 'vat.returns.input' | translate }}</th>
                <th class="nota-num">{{ 'vat.returns.carried' | translate }}</th>
                <th class="nota-num">{{ 'vat.returns.net' | translate }}</th>
                <th>{{ 'vat.returns.status' | translate }}</th>
                <th>{{ 'vat.returns.filedAt' | translate }}</th>
              </tr></thead>
              <tbody>
                @for (row of l.data; track row.period) {
                  <tr class="vr__row" [class.vr__row--on]="selected() === row.period" [attr.data-period]="row.period" tabindex="0" role="button"
                    (click)="open(row.period)" (keydown.enter)="open(row.period)">
                    <td class="nota-num" dir="ltr"><strong>{{ row.period }}</strong>@if (row.number) { <small class="vr__muted"> {{ row.number }}</small> }</td>
                    <td class="nota-num">{{ row.output | notaMoney }}</td>
                    <td class="nota-num">{{ row.input | notaMoney }}</td>
                    <td class="nota-num">{{ row.carriedIn | notaMoney }}</td>
                    <td class="nota-num" [class.vr__credit]="row.net < 0"><strong>{{ abs(row.net) | notaMoney }}</strong>@if (row.net < 0) { <small> {{ 'vat.returns.creditTag' | translate }}</small> }</td>
                    <td><nota-status-pill [variant]="pill(row.status)">{{ 'vat.status.' + row.status | translate }}</nota-status-pill></td>
                    <td class="nota-num">{{ row.filedAt ? (row.filedAt | date: 'yyyy-MM-dd') : '—' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      } @else if (!loadError()) {
        <p class="vr__note" data-test="loading">…</p>
      }

      @if (detail(); as d) {
        <section class="nota-card vr__detail" data-test="detail" [attr.data-period]="d.period">
          <header class="vr__head">
            <div>
              <h2 class="vr__title"><span class="nota-num" dir="ltr">{{ d.period }}</span> <nota-status-pill [variant]="pill(d.status)">{{ 'vat.status.' + d.status | translate }}</nota-status-pill></h2>
              @if (d.number) { <p class="vr__muted" dir="ltr">{{ d.number }}</p> }
            </div>
            <div class="vr__actions">
              <nota-print-actions [items]="returnPrintItems(d)" data-test="vat-print" />
              <button type="button" notaButton data-action="export" [disabled]="exporting()" (click)="exportExcel(d)">{{ 'vat.returns.export' | translate }}</button>
              @if (canFile() && d.canFile) { <button type="button" notaButton="primary" data-action="file" (click)="fileOpen.set(true)">{{ 'vat.returns.file' | translate }}</button> }
              @if (canFile() && d.status !== 'open' && d.remaining > 0) { <button type="button" notaButton="primary" data-action="pay" (click)="openPay(d)">{{ 'vat.returns.pay' | translate }}</button> }
              @if (isOwner() && d.canUnfile) { <button type="button" notaButton="danger" data-action="unfile" (click)="unfileOpen.set(true)">{{ 'vat.returns.unfile' | translate }}</button> }
            </div>
          </header>

          <div class="vr__kpis">
            <nota-kpi-card [label]="'vat.returns.output' | translate" [value]="(d.output | notaMoney)" data-kpi="output" />
            <nota-kpi-card [label]="'vat.returns.input' | translate" [value]="(d.input | notaMoney)" data-kpi="input" />
            <nota-kpi-card [label]="'vat.returns.carried' | translate" [value]="(d.carriedIn | notaMoney)" data-kpi="carried" />
            <nota-kpi-card [label]="(d.net < 0 ? 'vat.returns.creditForward' : 'vat.returns.payable') | translate" [value]="(abs(d.net) | notaMoney)" data-kpi="net"
              [note]="d.status === 'open' ? '' : ((('vat.returns.paid' | translate) + ': ' + (d.paid | notaMoney)) + ' · ' + (('vat.returns.remaining' | translate) + ': ' + (d.remaining | notaMoney)))" />
          </div>
          @if (d.status === 'open' && !d.canFile) {
            <p class="vr__note" data-test="order-note">{{ (d.period === list()?.nextPeriod ? 'vat.returns.notEnded' : 'vat.returns.orderRule') | translate: { next: list()?.nextPeriod } }}</p>
          }

          <div class="vr__tabs" role="tablist" [attr.aria-label]="'vat.returns.documents' | translate">
            @for (group of groups; track group) {
              <button type="button" role="tab" class="vr__tab" [class.vr__tab--on]="tab() === group" [attr.aria-selected]="tab() === group" [attr.data-tab]="group" (click)="tab.set(group)">
                {{ 'vat.groups.' + group | translate }} <span class="vr__count nota-num">{{ d.lines[group].length }}</span>
              </button>
            }
          </div>
          <div class="nota-table-wrap">
            <table class="nota-table" data-test="lines">
              <thead><tr>
                <th>{{ 'vat.returns.number' | translate }}</th><th>{{ 'vat.returns.date' | translate }}</th>
                <th class="nota-num">{{ 'vat.returns.lineNet' | translate }}</th><th class="nota-num">{{ 'vat.returns.lineVat' | translate }}</th>
              </tr></thead>
              <tbody>
                @for (line of lines(); track $index) {
                  <tr><td dir="ltr">{{ line.number || '—' }}<small class="vr__muted"> {{ 'vat.kinds.' + line.kind | translate }}</small></td>
                    <td class="nota-num">{{ line.date | date: 'yyyy-MM-dd' }}</td>
                    <td class="nota-num">{{ line.net | notaMoney }}</td><td class="nota-num">{{ line.vat | notaMoney }}</td></tr>
                } @empty { <tr><td colspan="4" class="vr__empty">{{ 'vat.returns.noLines' | translate }}</td></tr> }
              </tbody>
              <tfoot><tr><td colspan="2">{{ 'vat.returns.total' | translate }}</td><td class="nota-num">{{ lineTotals().net | notaMoney }}</td><td class="nota-num"><strong>{{ lineTotals().vat | notaMoney }}</strong></td></tr></tfoot>
            </table>
          </div>

          @if (d.payments.length) {
            <h3 class="vr__h">{{ 'vat.returns.payments' | translate }}</h3>
            <ul class="vr__payments" data-test="payments">
              @for (p of d.payments; track p._id) {
                <li><span dir="ltr">{{ p.number }}</span><span class="vr__muted">{{ p.date | date: 'yyyy-MM-dd' }}@if (p.boxName) { · {{ p.boxName }} }@if (p.reference) { · {{ p.reference }} }</span><strong class="nota-num">{{ p.amount | notaMoney }}</strong><nota-print-actions [items]="paymentPrintItems(d, p)" /></li>
              }
            </ul>
          }
        </section>
      }

      @if (error()) { <p class="nota-error" role="alert" data-test="action-error">{{ error() | translate }}</p> }
    </div>

    <!-- File: shows the posting first. -->
    <p-dialog [visible]="fileOpen()" (visibleChange)="fileOpen.set($event)" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog vr-dialog">
      <nota-dialog-shell [title]="'vat.file.title' | translate: { period: detail()?.period }" [closeLabel]="'vat.close' | translate" (closed)="fileOpen.set(false)">
        @if (detail(); as d) {
          <dl class="vr__facts" data-test="file-figures">
            <div><dt>{{ 'vat.returns.output' | translate }}</dt><dd class="nota-num">{{ d.output | notaMoney }}</dd></div>
            <div><dt>{{ 'vat.returns.input' | translate }}</dt><dd class="nota-num">{{ d.input | notaMoney }}</dd></div>
            <div><dt>{{ 'vat.returns.carried' | translate }}</dt><dd class="nota-num">{{ d.carriedIn | notaMoney }}</dd></div>
            <div class="vr__strong"><dt>{{ (d.net < 0 ? 'vat.returns.creditForward' : 'vat.returns.payable') | translate }}</dt><dd class="nota-num">{{ abs(d.net) | notaMoney }}</dd></div>
          </dl>
          <h3 class="vr__h">{{ 'vat.file.posting' | translate }}</h3>
          <ul class="vr__posting" data-test="file-posting">
            @if (d.offset < 0) {
              <li data-test="posting-negative"><span>{{ 'vat.file.debitInput' | translate }}</span><b class="nota-num">{{ abs(d.offset) | notaMoney }}</b></li>
              <li><span>{{ 'vat.file.creditPayable' | translate }}</span><b class="nota-num">{{ abs(d.offset) | notaMoney }}</b></li>
            } @else {
              <li><span>{{ 'vat.file.debit' | translate }}</span><b class="nota-num">{{ d.offset | notaMoney }}</b></li>
              <li><span>{{ 'vat.file.credit' | translate }}</span><b class="nota-num">{{ d.offset | notaMoney }}</b></li>
            }
          </ul>
          @if (d.offset < 0) { <p class="vr__note" data-test="negative-note">{{ 'vat.file.negativeNote' | translate }}</p> }
          <p class="vr__note">{{ (d.net < 0 ? 'vat.file.creditNote' : 'vat.file.payableNote') | translate }}</p>
        }
        @if (error()) { <p class="nota-error" role="alert" data-test="dialog-error">{{ error() | translate }}</p> }
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="fileOpen.set(false)">{{ 'vat.cancel' | translate }}</button>
          <button type="button" notaButton="primary" data-action="confirm-file" [disabled]="busy()" (click)="confirmFile()">{{ 'vat.file.confirm' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>

    <!-- Pay: from a box, amount up to what is left. -->
    <p-dialog [visible]="payOpen()" (visibleChange)="payOpen.set($event)" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog vr-dialog">
      <nota-dialog-shell [title]="'vat.pay.title' | translate: { period: detail()?.period }" [closeLabel]="'vat.close' | translate" (closed)="payOpen.set(false)">
        @if (detail(); as d) {
          <p class="vr__note" data-test="pay-remaining">{{ 'vat.pay.remaining' | translate }}: <b class="nota-num">{{ d.remaining | notaMoney }}</b></p>
          <nota-form-field [label]="'vat.pay.amount' | translate" forId="vrPayAmount" [required]="true" [error]="payInvalid() ? ('vat.pay.invalid' | translate) : null">
            <input id="vrPayAmount" class="nota-input nota-num" type="number" min="0" step="0.01" name="payAmount" data-test="pay-amount" [ngModel]="payAmount()" (ngModelChange)="payAmount.set($event)" />
          </nota-form-field>
          <nota-payment-box-select labelKey="vat.pay.fromBox" />
          <nota-form-field [label]="'vat.pay.reference' | translate" forId="vrPayRef">
            <input id="vrPayRef" class="nota-input" type="text" name="payRef" maxlength="100" data-test="pay-reference" [ngModel]="payReference()" (ngModelChange)="payReference.set($event)" />
          </nota-form-field>
          <nota-form-field [label]="'vat.pay.note' | translate" forId="vrPayNote">
            <input id="vrPayNote" class="nota-input" type="text" name="payNote" maxlength="500" data-test="pay-note" [ngModel]="payNote()" (ngModelChange)="payNote.set($event)" />
          </nota-form-field>
        }
        @if (error()) { <p class="nota-error" role="alert" data-test="dialog-error">{{ error() | translate }}</p> }
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="payOpen.set(false)">{{ 'vat.cancel' | translate }}</button>
          <button type="button" notaButton="primary" data-action="confirm-pay" [disabled]="payInvalid() || busy() || payment.needsShift()" (click)="confirmPay()">{{ 'vat.pay.confirm' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>

    <!-- Unfile: owner only, a reason. -->
    <p-dialog [visible]="unfileOpen()" (visibleChange)="unfileOpen.set($event)" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog vr-dialog">
      <nota-dialog-shell [title]="'vat.unfile.title' | translate: { period: detail()?.period }" [closeLabel]="'vat.close' | translate" (closed)="unfileOpen.set(false)">
        <p class="vr__note">{{ 'vat.unfile.note' | translate }}</p>
        <nota-form-field [label]="'vat.unfile.reason' | translate" forId="vrUnfileReason" [required]="true">
          <textarea id="vrUnfileReason" class="nota-textarea" rows="2" name="unfileReason" maxlength="500" data-test="unfile-reason" [ngModel]="unfileReason()" (ngModelChange)="unfileReason.set($event)"></textarea>
        </nota-form-field>
        @if (error()) { <p class="nota-error" role="alert" data-test="dialog-error">{{ error() | translate }}</p> }
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="unfileOpen.set(false)">{{ 'vat.cancel' | translate }}</button>
          <button type="button" notaButton="danger" data-action="confirm-unfile" [disabled]="unfileReason().trim().length < 3 || busy()" (click)="confirmUnfile()">{{ 'vat.unfile.confirm' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>
  }
  `,
  styles: `
    .vr { display: flex; flex-direction: column; gap: 16px; }
    .vr__list, .vr__detail { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
    .vr__row { cursor: pointer; }
    .vr__row:hover, .vr__row:focus-visible { background: var(--brand-soft); }
    .vr__row--on { background: var(--brand-soft); }
    .vr__muted { color: var(--text-muted); font-weight: 400; font-size: 12px; }
    .vr__credit { color: var(--success); }
    .vr__note { margin: 0; font-size: 13px; color: var(--text-muted); }
    .vr__head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .vr__title { margin: 0; display: flex; align-items: center; gap: 10px; font-size: 20px; }
    .vr__actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .vr__kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
    .vr__tabs { display: flex; flex-wrap: wrap; gap: 6px; }
    .vr__tab { min-height: 40px; padding: 0 14px; border-radius: var(--radius-control); border: 1px solid var(--border); background: var(--surface); color: var(--text); font: inherit; font-weight: 600; cursor: pointer; }
    .vr__tab--on { background: var(--brand); border-color: var(--brand); color: var(--on-brand); }
    .vr__count { margin-inline-start: 6px; font-size: 12px; opacity: .85; }
    .vr__empty { text-align: center; color: var(--text-muted); padding: 18px; }
    .vr__h { margin: 4px 0 0; font-size: 15px; }
    .vr__payments, .vr__posting { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .vr__payments li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; font-size: 14px; }
    .vr__posting li { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }
    .vr__facts { margin: 0 0 8px; display: flex; flex-direction: column; gap: 6px; }
    .vr__facts div { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }
    .vr__facts dt { color: var(--text-muted); } .vr__facts dd { margin: 0; }
    .vr__strong { font-weight: 800; padding-top: 6px; border-top: 1px solid var(--border); }
    @media (max-width: 640px) { .vr__actions { width: 100%; } .vr__actions > * { flex: 1 1 120px; } .vr__table { min-width: 560px; } }
  `,
})
export class VatReturnsComponent implements OnInit {
  private readonly service = inject(VatReturnsService);
  protected readonly layout = inject(LayoutService);
  private readonly printData = inject(PrintDataService);
  private readonly translate = inject(TranslateService);

  /** Stage 23: the one-page A4 VAT return of the month. */
  returnPrintItems(d: VatReturnDetail): PrintActionItem[] {
    return [{ key: 'vat', load: async () => this.printData.vatReturn(d) }];
  }

  /** Stage 23: the A5 VAT payment voucher (VP). */
  paymentPrintItems(d: VatReturnDetail, p: VatReturnDetail['payments'][number]): PrintActionItem[] {
    return [{ key: 'vp-' + p.number, label: this.translate.instant('print.voucherA5'), load: async () => {
      const journalNumber = await this.printData.journalNumber(p.number);
      return this.printData.voucher({ type: 'VP', number: p.number, date: p.date, amount: p.amount, party: this.translate.currentLang === 'en' ? 'Tax Authority' : 'مصلحة الضرائب', reason: `${this.translate.instant('vat.returns.payments')} ${d.period}`, method: p.boxName, journalNumber });
    } }];
  }
  private readonly auth = inject(AuthService);
  protected readonly payment = inject(PaymentBoxService);

  readonly groups = VAT_LINE_GROUPS;
  readonly list = signal<VatReturnList | null>(null);
  readonly detail = signal<VatReturnDetail | null>(null);
  readonly selected = signal<string | null>(null);
  readonly tab = signal<VatLineGroup>('sales');
  readonly loadError = signal(false);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly exporting = signal(false);

  readonly fileOpen = signal(false);
  readonly payOpen = signal(false);
  readonly unfileOpen = signal(false);
  readonly payAmount = signal<number | null>(null);
  readonly payReference = signal('');
  readonly payNote = signal('');
  readonly unfileReason = signal('');

  readonly canFile = computed(() => this.auth.has('vat.file'));
  readonly isOwner = computed(() => this.auth.user()?.role === 'owner');
  readonly lines = computed<VatLine[]>(() => this.detail()?.lines[this.tab()] ?? []);
  readonly lineTotals = computed(() => {
    const rows = this.lines();
    const sum = (field: 'net' | 'vat') => Math.round(rows.reduce((total, row) => total + row[field], 0) * 100) / 100;
    return { net: sum('net'), vat: sum('vat') };
  });
  readonly payInvalid = computed(() => {
    const amount = this.payAmount() ?? 0;
    return amount <= 0 || amount > (this.detail()?.remaining ?? 0);
  });

  ngOnInit(): void {
    this.reload();
  }

  abs(value: number): number {
    return Math.abs(value);
  }

  pill(status: VatReturnStatus): NotaPillVariant {
    return PILL[status];
  }

  /** The list, then (re)open the selected month, else the month that can be filed next. */
  reload(keepSelection = true): void {
    this.service.list().subscribe({
      next: (list) => {
        this.list.set(list);
        this.loadError.set(false);
        // The month to show first: the one that can be filed next, unless it has not started yet; then the latest filed one.
        const current = localDateKey().slice(0, 7);
        const fallback = list.nextPeriod <= current ? list.nextPeriod : (list.data.find((entry) => entry.returnId)?.period ?? list.nextPeriod);
        const target = (keepSelection && this.selected()) || fallback;
        if (target) this.open(target);
      },
      error: () => this.loadError.set(true),
    });
  }

  /** Phone only (Online Stage 6B): closing the month's sheet. */
  protected closeDetail(): void { this.detail.set(null); this.selected.set(null); }

  open(period: string): void {
    this.selected.set(period);
    this.error.set('');
    this.service.get(period).subscribe({ next: (detail) => this.detail.set(detail), error: () => this.error.set('vat.errors.loadFailed') });
  }

  confirmFile(): void {
    const d = this.detail();
    if (!d) return;
    this.run(this.service.file(d.period), () => this.fileOpen.set(false));
  }

  openPay(d: VatReturnDetail): void {
    this.error.set('');
    this.payAmount.set(d.remaining);
    this.payReference.set('');
    this.payNote.set('');
    this.payment.load();
    this.payOpen.set(true);
  }

  confirmPay(): void {
    const d = this.detail();
    if (!d || this.payInvalid()) return;
    const payload = this.payment.withBox({
      amount: Number(this.payAmount()), date: localDateKey(),
      ...(this.payReference().trim() ? { reference: this.payReference().trim() } : {}),
      ...(this.payNote().trim() ? { note: this.payNote().trim() } : {}),
    });
    this.run(this.service.pay(d.period, payload), () => { this.payOpen.set(false); this.payment.load(true); });
  }

  confirmUnfile(): void {
    const d = this.detail();
    if (!d) return;
    this.run(this.service.unfile(d.period, this.unfileReason().trim()), () => { this.unfileOpen.set(false); this.unfileReason.set(''); });
  }

  exportExcel(d: VatReturnDetail): void {
    this.exporting.set(true);
    this.service.export(d.period).subscribe({
      next: (blob) => {
        this.exporting.set(false);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `vat-${d.period}.xlsx`;
        anchor.click();
        URL.revokeObjectURL(url);
      },
      error: () => { this.exporting.set(false); this.error.set('vat.errors.exportFailed'); },
    });
  }

  private run(request: import('rxjs').Observable<unknown>, done: () => void): void {
    this.busy.set(true);
    this.error.set('');
    request.subscribe({
      next: () => { this.busy.set(false); done(); this.reload(); },
      error: (response) => {
        this.busy.set(false);
        const code = response?.error?.code;
        this.error.set(KNOWN_ERRORS.includes(code) ? `vat.errors.${code}` : 'vat.errors.generic');
      },
    });
  }
}
