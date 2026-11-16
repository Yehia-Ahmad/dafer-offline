import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { DialogModule } from 'primeng/dialog';
import { AuthService } from '../../../core/auth/auth.service';
import { LayoutService } from '../../../core/layout/layout.service';
import { invoiceHintKey, mobilePillClass, orderSteps } from '../../mobile/mobile-utils';
import { ToastService } from '../../../core/auth/toast.service';
import { deliveryNote80, deliveryNoteA4, DeliveryNoteData } from '../../../core/print/documents/delivery-note';
import { PrintActionItem, PrintActionsComponent } from '../../../core/print/print-actions.component';
import { NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaMoneyPipe, NotaPageHeaderComponent, NotaStatusPillComponent } from '../../shared/ui';
import { NotaPillVariant } from '../../shared/ui/status-pill.component';
import { estimateCollect, returnsEverything } from '../collect-estimate';
import { PaymentBoxSelectComponent } from '../../cashbox/payment-box-select.component';
import { PaymentBoxService } from '../../cashbox/payment-box.service';
import { OrderAction, allowedOrderActions, canReturnLines, whatsappLink } from '../order-actions';
import { whatsappConfirmLink } from '../order-whatsapp';
import { Courier, OrderDetail, OrderEditPayload, OrderHistoryEntry } from '../orders.models';
import { OrdersService } from '../orders.service';
import { ORDER_STATUS_VARIANT } from '../orders-list/orders-list.component';

interface EditLine { productId: string; name: string; qty: number; unitPrice: number | null; isNew: boolean }
interface EditDraft { name: string; phone: string; address: string; notes: string; zoneId: string; deliveryFee: number | string }

/**
 * Online Stage 4: /orders/:id. Contact (copy + WhatsApp), lines with stock and reserved info, totals, history, and the actions
 * the status and the user's permissions allow. Edit mode follows decision 7 (until the order leaves with the courier).
 */
@Component({
  selector: 'app-order-page',
  imports: [TranslatePipe, FormsModule, DatePipe, DialogModule, PaymentBoxSelectComponent, PrintActionsComponent, NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaMoneyPipe, NotaPageHeaderComponent, NotaStatusPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="op">
      @if (!layout.isMobile() || editing()) {
      <nota-page-header [title]="('orders.page.title' | translate) + ' ' + (order()?.number || '')" [subtitle]="order() ? (order()!.createdAt | date: 'medium') : ''" backLink="/orders" [backLabel]="'orders.title' | translate">
        <div notaPageActions>
          @if (order(); as o) {
            <nota-status-pill [variant]="variant(o.status)" data-test="order-status">{{ 'orders.status.' + o.status | translate }}</nota-status-pill>
            <nota-status-pill variant="neutral" data-test="order-fulfillment">{{ 'orders.fulfillment.' + o.fulfillment | translate }}</nota-status-pill>
            <nota-status-pill variant="neutral" data-test="order-method">{{ 'orders.method.' + o.paymentMethod | translate }}</nota-status-pill>
            @if (o.payment.status) {
              <nota-status-pill [variant]="o.payment.status === 'verified' ? 'ok' : 'due'" data-test="order-payment">{{ 'orders.payment.' + o.payment.status | translate }}</nota-status-pill>
            }
          }
        </div>
      </nota-page-header>
      }

      @if (loadError()) { <div class="op__alert" role="alert">{{ 'orders.loadFailed' | translate }} <button type="button" notaButton (click)="load()">{{ 'orders.retry' | translate }}</button></div> }
      @if (errorMessage()) { <div class="op__alert" role="alert" data-test="order-error">{{ errorMessage() }}</div> }

      @if (order(); as o) {
        @if (layout.isMobile() && !editing()) {
          <!-- Online Stage 6A, MobOrder: the same order, actions and rules, laid out for the phone. -->
          <div class="m-page" data-testid="m-order">
            <section class="m-card">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px">
                <b class="nota-num">{{ o.number }}</b>
                <span style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
                  <span class="m-pill m-pill--muted">{{ 'orders.fulfillment.' + o.fulfillment | translate }}</span>
                  <span [class]="pillClass(o.status)" data-test="order-status">{{ 'orders.status.' + o.status | translate }}</span>
                </span>
              </div>
              @if (stepInfo(o); as s) {
                @if (!s.closed) {
                  <div class="m-steps" data-testid="m-steps">
                    @for (key of s.keys; track key; let i = $index) {
                      <div class="m-step" [class.is-done]="i < s.done">{{ key | translate }}</div>
                    }
                  </div>
                }
              }
            </section>

            <section class="m-card" data-test="order-contact">
              <div class="m-card__title">{{ 'orders.page.contact' | translate }}</div>
              <div class="m-row" style="padding:0;border:0">
                <span class="m-avatar">{{ o.contact.name.trim().charAt(0) || '؟' }}</span>
                <div class="m-row__body"><div class="m-row__title">{{ o.contact.name }}</div><div class="m-row__sub nota-num" dir="ltr" style="text-align:start">{{ o.contact.phone }}</div></div>
              </div>
              <div style="display:flex;gap:8px;margin-top:10px">
                <a class="m-btn" style="flex:1" [href]="'tel:' + o.contact.phone" data-action="call">{{ 'mobile.order.call' | translate }}</a>
                <a class="m-btn" style="flex:1" data-action="whatsapp" [href]="whatsapp(o.contact.phone)" target="_blank" rel="noopener noreferrer">{{ 'orders.page.whatsapp' | translate }}</a>
              </div>
              @if (o.fulfillment === 'pickup') {
                <p style="margin-top:10px" data-test="order-pickup">{{ 'orders.page.pickupAtShop' | translate }}</p>
              } @else {
                <p style="margin-top:10px">{{ o.contact.address }}</p>
                @if (o.zone) { <p class="m-muted">{{ 'orders.page.zone' | translate }}: {{ o.zone.name }}</p> }
              }
              @if (o.contact.notes) { <p class="m-muted">{{ o.contact.notes }}</p> }
              @if (o.courier) { <p>{{ 'orders.page.courier' | translate }}: <b>{{ o.courier.name }}</b></p> }
              @if (o.reason) { <p class="m-muted">{{ 'orders.page.reason' | translate }}: {{ o.reason }}</p> }
              @if (o.status !== 'cancelled' && o.status !== 'rejected' && o.status !== 'refused') {
                <p style="margin-top:8px"><a class="m-btn m-btn--block" data-test="whatsapp-confirm" [href]="confirmLink(o)" target="_blank" rel="noopener noreferrer">{{ 'orders.actions.whatsappConfirm' | translate }}</a></p>
              }
            </section>

            <section class="m-card m-card--flush">
              <div class="m-card__title" style="padding:12px 14px 0">{{ 'orders.page.lines' | translate }}</div>
              @for (line of o.items; track line.productId) {
                <div class="m-row" data-test="order-line">
                  <div class="m-row__body"><div class="m-row__title">{{ line.name }}</div><div class="m-row__sub nota-num">{{ line.qty }} × {{ line.unitPrice | notaMoney }}</div></div>
                  <div class="m-row__end nota-num">{{ line.lineTotal | notaMoney }}</div>
                </div>
              }
            </section>

            <section class="m-card">
              <dl class="op__totals nota-num">
                <dt>{{ 'orders.page.subtotal' | translate }}</dt><dd>{{ o.subtotal | notaMoney }}</dd>
                @if (o.vat) { <dt>{{ 'orders.page.vat' | translate }}</dt><dd>{{ o.vat | notaMoney }}</dd> }
                @if (o.fulfillment !== 'pickup') { <dt>{{ 'orders.page.deliveryFee' | translate }}</dt><dd>{{ o.deliveryFee | notaMoney }}</dd> }
                <dt class="op__grand">{{ 'orders.page.total' | translate }}</dt><dd class="op__grand" data-test="order-total">{{ o.total | notaMoney }}</dd>
                @if (o.invoice) { <dt>{{ 'orders.page.invoice' | translate }}</dt><dd data-test="order-invoice">{{ o.invoice.number }}</dd> }
                @if (o.collectedAmount !== null) { <dt>{{ 'orders.page.collected' | translate }}</dt><dd>{{ o.collectedAmount | notaMoney }}</dd> }
              </dl>
              <p style="margin-top:8px" data-test="order-payment">
                {{ 'orders.method.' + o.paymentMethod | translate }}
                @if (o.payment.status) { <span [class]="o.payment.status === 'verified' ? 'm-pill m-pill--ok' : 'm-pill m-pill--warn'">{{ 'orders.payment.' + o.payment.status | translate }}</span> }
              </p>
              @if (invoiceHint(o); as hint) { <p class="m-muted" style="margin-top:8px" data-testid="invoice-hint">{{ hint | translate }}</p> }
            </section>

            <section class="m-card m-card--flush" data-test="order-history">
              <div class="m-card__title" style="padding:12px 14px 0">{{ 'orders.page.history' | translate }}</div>
              @for (entry of o.statusHistory; track $index) {
                <div class="m-row">
                  <div class="m-row__body">
                    <div class="m-row__title">{{ entry.type === 'edit' ? ('orders.page.edited' | translate) : entry.type === 'payment' ? ('orders.page.paymentVerified' | translate) : ('orders.status.' + entry.status | translate) }}</div>
                    <div class="m-row__sub">{{ entry.at | date: 'short' }}@if (entry.byName || entry.by) { · {{ entry.byName || entry.by }} }</div>
                  </div>
                </div>
              }
            </section>

            @if (o.fulfillment !== 'pickup' && (o.status === 'out_for_delivery' || o.status === 'confirmed' || o.status === 'preparing' || o.status === 'delivered')) {
              <section class="m-card"><nota-print-actions [items]="printItems()" /></section>
            }
          </div>
          @if (actions().length) {
            <div class="m-actions" data-test="order-actions" data-testid="m-order-actions">
              @for (action of actions(); track action) {
                <button type="button" class="m-btn" [class.m-btn--primary]="action === primaryAction()" [class.m-btn--danger]="action === 'reject' || action === 'cancel' || action === 'refuse'"
                  [attr.data-action]="action" [disabled]="busy()" (click)="run(action)">{{ 'orders.actions.' + action | translate }}</button>
              }
            </div>
          }
        } @else {
        <div class="op__actions" data-test="order-actions">
          @for (action of actions(); track action) {
            <button type="button" notaButton [attr.data-action]="action" [disabled]="busy()" [class.is-danger]="action === 'reject' || action === 'cancel' || action === 'refuse'" (click)="run(action)">{{ 'orders.actions.' + action | translate }}</button>
          }
          @if (o.fulfillment !== 'pickup' && (o.status === 'out_for_delivery' || o.status === 'confirmed' || o.status === 'preparing' || o.status === 'delivered')) {
            <nota-print-actions [items]="printItems()" />
          }
        </div>

        <div class="op__grid">
          <section class="op__card" data-test="order-contact">
            <h2>{{ 'orders.page.contact' | translate }}</h2>
            @if (!editing()) {
              <p><b>{{ o.contact.name }}</b></p>
              <p class="op__ltr nota-num">{{ o.contact.phone }}
                <button type="button" notaButton data-action="copy-phone" (click)="copy(o.contact.phone)">{{ 'orders.page.copy' | translate }}</button>
                <a notaButton data-action="whatsapp" [href]="whatsapp(o.contact.phone)" target="_blank" rel="noopener noreferrer">{{ 'orders.page.whatsapp' | translate }}</a>
              </p>
              <!-- Online Stage 5A: opens wa.me with the shop's confirmation message in a new tab (no WhatsApp API). -->
              @if (o.status !== 'cancelled' && o.status !== 'rejected' && o.status !== 'refused') {
                <p><a notaButton data-test="whatsapp-confirm" [href]="confirmLink(o)" target="_blank" rel="noopener noreferrer">{{ 'orders.actions.whatsappConfirm' | translate }}</a></p>
              }
              @if (o.fulfillment === 'pickup') {
                <p data-test="order-pickup">{{ 'orders.page.pickupAtShop' | translate }}</p>
                @if (o.contact.address) { <p>{{ o.contact.address }}</p> }
              } @else {
                <p>{{ o.contact.address }} <button type="button" notaButton data-action="copy-address" (click)="copy(o.contact.address)">{{ 'orders.page.copy' | translate }}</button></p>
                <p>{{ 'orders.page.zone' | translate }}: {{ o.zone?.name }}</p>
              }
              @if (o.contact.notes) { <p class="op__muted">{{ o.contact.notes }}</p> }
              @if (o.courier) { <p>{{ 'orders.page.courier' | translate }}: <b>{{ o.courier.name }}</b></p> }
              @if (o.reason) { <p class="op__muted">{{ 'orders.page.reason' | translate }}: {{ o.reason }}</p> }
            } @else {
              <div class="op__form">
                <nota-form-field [label]="'orders.page.name' | translate" forId="eName"><input id="eName" class="nota-input" name="name" [ngModel]="draft().name" (ngModelChange)="patchDraft({ name: $event })" /></nota-form-field>
                <nota-form-field [label]="'orders.page.phone' | translate" forId="ePhone"><input id="ePhone" class="nota-input" name="phone" [ngModel]="draft().phone" (ngModelChange)="patchDraft({ phone: $event })" /></nota-form-field>
                <nota-form-field [label]="'orders.page.address' | translate" forId="eAddress"><input id="eAddress" class="nota-input" name="address" [ngModel]="draft().address" (ngModelChange)="patchDraft({ address: $event })" /></nota-form-field>
                <nota-form-field [label]="'orders.page.notes' | translate" forId="eNotes"><input id="eNotes" class="nota-input" name="notes" [ngModel]="draft().notes" (ngModelChange)="patchDraft({ notes: $event })" /></nota-form-field>
                @if (o.fulfillment !== 'pickup') {
                  <nota-form-field [label]="'orders.page.zone' | translate" forId="eZone">
                    <select id="eZone" class="nota-select" name="zone" data-test="edit-zone" [ngModel]="draft().zoneId" (ngModelChange)="patchDraft({ zoneId: $event })">
                      @for (zone of zones(); track zone.id) { <option [value]="zone.id">{{ zone.name }} — {{ zone.fee }}</option> }
                    </select>
                  </nota-form-field>
                  <nota-form-field [label]="'orders.page.deliveryFee' | translate" forId="eFee"><input id="eFee" class="nota-input nota-num" type="number" min="0" step="0.01" name="fee" data-test="edit-fee" [ngModel]="draft().deliveryFee" (ngModelChange)="patchDraft({ deliveryFee: $event })" /></nota-form-field>
                }
              </div>
            }
          </section>

          <section class="op__card">
            <h2>{{ 'orders.page.totals' | translate }}</h2>
            <dl class="op__totals nota-num">
              <dt>{{ 'orders.page.subtotal' | translate }}</dt><dd>{{ o.subtotal | notaMoney }}</dd>
              @if (o.vat) { <dt>{{ 'orders.page.vat' | translate }}</dt><dd>{{ o.vat | notaMoney }}</dd> }
              @if (o.fulfillment !== 'pickup') { <dt>{{ 'orders.page.deliveryFee' | translate }}</dt><dd>{{ o.deliveryFee | notaMoney }}</dd> }
              <dt class="op__grand">{{ 'orders.page.total' | translate }}</dt><dd class="op__grand" data-test="order-total">{{ o.total | notaMoney }}</dd>
              @if (o.invoice) { <dt>{{ 'orders.page.invoice' | translate }}</dt><dd data-test="order-invoice">{{ o.invoice.number }}</dd> }
              @if (o.payment.reference) { <dt>{{ 'orders.page.transferRef' | translate }}</dt><dd class="op__ltr">{{ o.payment.reference }}</dd> }
              @if (o.collectedAmount !== null) { <dt>{{ 'orders.page.collected' | translate }}</dt><dd>{{ o.collectedAmount | notaMoney }}</dd> }
            </dl>
          </section>
        </div>

        <section class="op__card">
          <h2>{{ 'orders.page.lines' | translate }}</h2>
          <div class="nota-table-wrap">
            <table class="nota-table">
              <thead><tr>
                <th>{{ 'orders.page.item' | translate }}</th>
                <th class="num">{{ 'orders.page.qty' | translate }}</th>
                <th class="num">{{ 'orders.page.unitPrice' | translate }}</th>
                <th class="num">{{ 'orders.page.lineTotal' | translate }}</th>
                <th class="num">{{ 'orders.page.stock' | translate }}</th>
                <th class="num">{{ 'orders.page.reserved' | translate }}</th>
                @if (editing()) { <th><span class="nota-sr-only">{{ 'tableHeaders.actions' | translate }}</span></th> }
              </tr></thead>
              <tbody>
                @if (!editing()) {
                  @for (line of o.items; track line.productId) {
                    <tr data-test="order-line" [class.op__short]="short(line)">
                      <td>{{ line.name }}</td>
                      <td class="nota-num">{{ line.qty }}</td>
                      <td class="nota-num">{{ line.unitPrice | notaMoney }}</td>
                      <td class="nota-num">{{ line.lineTotal | notaMoney }}</td>
                      <td class="nota-num">{{ line.inventoryCount ?? '—' }}</td>
                      <td class="nota-num">{{ line.reservedByOthers }}</td>
                    </tr>
                  }
                } @else {
                  @for (line of editLines(); track line.productId) {
                    <tr data-test="edit-line">
                      <td>{{ line.name }}</td>
                      <td class="num"><input class="nota-input nota-num op__qty" type="number" min="1" step="1" [attr.data-test]="'edit-qty-' + line.productId" [ngModel]="line.qty" (ngModelChange)="setQty(line.productId, $event)" /></td>
                      <td class="nota-num">{{ line.unitPrice === null ? '—' : (line.unitPrice | notaMoney) }}</td>
                      <td class="nota-num">—</td>
                      <td class="nota-num">{{ stockOf(line.productId) }}</td>
                      <td class="nota-num">{{ reservedOf(line.productId) }}</td>
                      <td><button type="button" notaButton="danger" data-action="remove-line" (click)="removeLine(line.productId)">{{ 'orders.page.remove' | translate }}</button></td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>
          @if (editing()) {
            <div class="op__add">
              <input class="nota-input" type="search" data-test="add-product-search" [placeholder]="'orders.page.addProduct' | translate" [ngModel]="productQuery()" (ngModelChange)="searchProducts($event)" />
              @if (productResults().length) {
                <ul class="op__results" data-test="product-results">
                  @for (product of productResults(); track product._id) {
                    <li><button type="button" class="op__result" (click)="addProduct(product)">{{ product.name }} <span class="nota-num">{{ product.retailPrice | notaMoney }}</span></button></li>
                  }
                </ul>
              }
            </div>
            <div class="op__editbar">
              <button type="button" notaButton="primary" data-action="save-edit" [disabled]="busy()" (click)="saveEdit()">{{ 'orders.page.saveEdit' | translate }}</button>
              <button type="button" notaButton data-action="cancel-edit" (click)="editing.set(false)">{{ 'orders.page.cancelEdit' | translate }}</button>
            </div>
          }
        </section>

        <section class="op__card" data-test="order-history">
          <h2>{{ 'orders.page.history' | translate }}</h2>
          <ol class="op__history">
            @for (entry of o.statusHistory; track $index) {
              <li>
                <span class="nota-num">{{ entry.at | date: 'short' }}</span>
                <b>{{ entry.type === 'edit' ? ('orders.page.edited' | translate) : entry.type === 'payment' ? ('orders.page.paymentVerified' | translate) : ('orders.status.' + entry.status | translate) }}</b>
                @if (entry.byName || entry.by) { <span class="op__muted">{{ entry.byName || entry.by }}</span> }
                @if (entry.note) { <span>{{ entry.note }}</span> }
                @if (entry.type === 'edit') { <span class="op__muted">{{ editSummary(entry) }}</span> }
              </li>
            }
          </ol>
        </section>
        }
      }
    </div>

    <p-dialog [visible]="reasonFor() !== null" (visibleChange)="$event ? null : reasonFor.set(null)" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog">
      <nota-dialog-shell [title]="('orders.actions.' + (reasonFor() || 'reject')) | translate" [closeLabel]="'orders.close' | translate" (closed)="reasonFor.set(null)">
        <nota-form-field [label]="'orders.page.reason' | translate" forId="reason" [required]="reasonFor() !== 'refuse'">
          <textarea id="reason" class="nota-input" rows="3" maxlength="500" data-test="reason-input" [ngModel]="reason()" (ngModelChange)="reason.set($event)"></textarea>
        </nota-form-field>
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="reasonFor.set(null)">{{ 'orders.close' | translate }}</button>
          <button type="button" notaButton="primary" data-action="submit-reason" [disabled]="busy() || (reasonFor() !== 'refuse' && reason().trim().length < 3)" (click)="submitReason()">{{ 'orders.confirm' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>

    <p-dialog [visible]="dispatchOpen()" (visibleChange)="$event ? null : dispatchOpen.set(false)" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog">
      <nota-dialog-shell [title]="'orders.actions.dispatch' | translate" [closeLabel]="'orders.close' | translate" (closed)="dispatchOpen.set(false)">
        <nota-form-field [label]="'orders.page.chooseCourier' | translate" forId="courier" [required]="true">
          <select id="courier" class="nota-select" data-test="dispatch-courier" [ngModel]="courierId()" (ngModelChange)="courierId.set($event)">
            <option value="">—</option>
            @for (courier of activeCouriers(); track courier.id) { <option [value]="courier.id">{{ courier.name }}</option> }
          </select>
        </nota-form-field>
        @if (!activeCouriers().length) { <p class="op__muted">{{ 'orders.page.noCouriers' | translate }}</p> }
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="dispatchOpen.set(false)">{{ 'orders.close' | translate }}</button>
          <button type="button" notaButton="primary" data-action="submit-dispatch" [disabled]="busy() || !courierId()" (click)="submitDispatch()">{{ 'orders.actions.dispatch' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>

    <!-- Online Stage 5A: confirm the transfer (optional reference). Nothing is posted by it. -->
    <p-dialog [visible]="verifyOpen()" (visibleChange)="$event ? null : verifyOpen.set(false)" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog">
      <nota-dialog-shell [title]="'orders.actions.verifyPayment' | translate" [closeLabel]="'orders.close' | translate" (closed)="verifyOpen.set(false)">
        @if (order(); as o) { <p data-test="verify-amount">{{ 'orders.page.verifyAmount' | translate }}: <b class="nota-num">{{ o.total | notaMoney }}</b></p> }
        <p class="op__muted">{{ 'orders.page.verifyHint' | translate }}</p>
        <nota-form-field [label]="'orders.page.transferRef' | translate" forId="transferRef">
          <input id="transferRef" class="nota-input" maxlength="100" data-test="transfer-reference" [ngModel]="reference()" (ngModelChange)="reference.set($event)" />
        </nota-form-field>
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="verifyOpen.set(false)">{{ 'orders.close' | translate }}</button>
          <button type="button" notaButton="primary" data-action="submit-verify" [disabled]="busy()" (click)="submitVerify()">{{ 'orders.confirm' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>

    <!-- Online Stage 5A: picked up = a cash sale. Cash on pickup: the staff member picks the box (their device's box by default). A wallet order goes into the wallet's box. -->
    <p-dialog [visible]="pickupOpen()" (visibleChange)="$event ? null : pickupOpen.set(false)" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog">
      <nota-dialog-shell [title]="'orders.actions.pickup' | translate" [closeLabel]="'orders.close' | translate" (closed)="pickupOpen.set(false)">
        @if (order(); as o) {
          <p class="op__collect" data-test="pickup-amount">{{ 'orders.page.amountToCollect' | translate }}: <b class="nota-num">{{ o.total | notaMoney }}</b></p>
          @if (o.paymentMethod === 'cod') {
            <!-- Only while the dialog is open: projected content is created even for a closed p-dialog, and the selector loads the boxes. -->
            @if (pickupOpen()) { <nota-payment-box-select /> }
          } @else {
            <p class="op__muted" data-test="pickup-wallet">{{ 'orders.page.walletBoxNote' | translate }}</p>
          }
        }
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="pickupOpen.set(false)">{{ 'orders.close' | translate }}</button>
          <button type="button" notaButton="primary" data-action="submit-pickup" [disabled]="busy()" (click)="submitPickup()">{{ 'orders.actions.pickup' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>

    <p-dialog [visible]="deliverOpen()" (visibleChange)="$event ? null : deliverOpen.set(false)" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog">
      <nota-dialog-shell [title]="'orders.actions.deliver' | translate" [closeLabel]="'orders.close' | translate" (closed)="deliverOpen.set(false)">
        @if (order(); as o) {
          @if (canReturn()) {
            <label class="op__check"><input type="checkbox" data-test="with-returns" [ngModel]="withReturns()" (ngModelChange)="withReturns.set($event)" /> {{ 'orders.page.withReturns' | translate }}</label>
          }
          @if (withReturns()) {
            <table class="nota-table">
              <thead><tr><th>{{ 'orders.page.item' | translate }}</th><th class="num">{{ 'orders.page.qty' | translate }}</th><th class="num">{{ 'orders.page.returnQty' | translate }}</th></tr></thead>
              <tbody>
                @for (line of o.items; track line.productId) {
                  <tr>
                    <td>{{ line.name }}</td><td class="nota-num">{{ line.qty }}</td>
                    <td class="num"><input class="nota-input nota-num op__qty" type="number" min="0" [max]="line.qty" step="1" [attr.data-test]="'return-qty-' + line.productId" [ngModel]="returned()[line.productId] || 0" (ngModelChange)="setReturned(line.productId, $event, line.qty)" /></td>
                  </tr>
                }
              </tbody>
            </table>
            @if (allReturned()) { <p class="op__alert" data-test="use-refuse">{{ 'orders.page.useRefuse' | translate }}</p> }
          }
          @if (o.paymentMethod === 'cod') {
            <p class="op__collect" data-test="amount-to-collect">{{ 'orders.page.amountToCollect' | translate }}: <b class="nota-num">{{ collectEstimate() | notaMoney }}</b></p>
            <nota-form-field [label]="'orders.page.collectedOverride' | translate" forId="collected">
              <input id="collected" class="nota-input nota-num" type="number" min="0" step="0.01" data-test="collected-amount" [ngModel]="collected()" (ngModelChange)="collected.set($event)" />
            </nota-form-field>
          } @else {
            <!-- Online Stage 5A: a wallet order was paid before it left; the courier collects nothing. -->
            <p class="op__muted" data-test="nothing-to-collect">{{ 'orders.page.nothingToCollect' | translate }}</p>
          }
        }
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="deliverOpen.set(false)">{{ 'orders.close' | translate }}</button>
          <button type="button" notaButton="primary" data-action="submit-deliver" [disabled]="busy() || allReturned()" (click)="submitDeliver()">{{ 'orders.page.recordDelivery' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>
  `,
  styles: `
    :host { display: block; }
    .op { display: flex; flex-direction: column; gap: var(--space-gap); }
    .op__alert { padding: 14px 16px; border-radius: 12px; background: var(--danger-soft); color: var(--danger-text); display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .op__actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .op__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--space-gap); }
    .op__card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 18px; display: flex; flex-direction: column; gap: 8px; }
    .op__card h2 { margin: 0 0 6px; font-size: 16px; }
    .op__card p { margin: 0; line-height: 1.8; }
    .op__ltr { direction: ltr; text-align: start; }
    .op__muted { color: var(--text-muted); }
    .op__totals { display: grid; grid-template-columns: 1fr auto; gap: 6px 16px; margin: 0; }
    .op__totals dd { margin: 0; text-align: end; }
    .op__grand { font-weight: 800; font-size: 17px; }
    .op__short td { color: var(--danger-text); }
    .op__form { display: flex; flex-direction: column; gap: 12px; }
    .op__qty { width: 90px; }
    .op__add { position: relative; }
    .op__results { list-style: none; margin: 6px 0 0; padding: 0; border: 1px solid var(--border); border-radius: 12px; max-height: 220px; overflow: auto; }
    .op__result { width: 100%; text-align: start; padding: 8px 12px; background: transparent; border: 0; font: inherit; color: inherit; cursor: pointer; display: flex; justify-content: space-between; }
    .op__result:hover { background: var(--brand-soft); }
    .op__editbar { display: flex; gap: 8px; }
    .op__history { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
    .op__history li { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; }
    .op__check { display: flex; gap: 8px; align-items: center; font-weight: 600; margin-bottom: 10px; }
    .op__collect { font-size: 18px; margin: 12px 0; }
  `,
})
export class OrderPageComponent implements OnInit {
  private readonly service = inject(OrdersService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly layout = inject(LayoutService);
  protected readonly order = signal<OrderDetail | null>(null);
  protected readonly loadError = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly busy = signal(false);

  protected readonly actions = computed(() => {
    const order = this.order();
    return order ? allowedOrderActions(order, (key) => this.auth.has(key)) : [];
  });

  // Online Stage 5A: confirm the transfer, and pick the order up (a cash sale)
  protected readonly verifyOpen = signal(false);
  protected readonly reference = signal('');
  protected readonly pickupOpen = signal(false);
  private readonly paymentBox = inject(PaymentBoxService);

  // reason dialog (reject / cancel / refuse)
  protected readonly reasonFor = signal<'reject' | 'cancel' | 'refuse' | null>(null);
  protected readonly reason = signal('');
  // dispatch
  protected readonly dispatchOpen = signal(false);
  protected readonly courierId = signal('');
  protected readonly couriers = signal<Courier[]>([]);
  protected readonly activeCouriers = computed(() => this.couriers().filter((courier) => courier.isActive));
  // deliver
  protected readonly deliverOpen = signal(false);
  protected readonly withReturns = signal(false);
  protected readonly returned = signal<Record<string, number>>({});
  protected readonly collected = signal<number | null>(null);
  protected readonly canReturn = computed(() => canReturnLines((key) => this.auth.has(key)));
  protected readonly allReturned = computed(() => {
    const order = this.order();
    return Boolean(order) && this.withReturns() && Object.values(this.returned()).some((qty) => qty > 0) && returnsEverything(order!, this.returned());
  });
  protected readonly collectEstimate = computed(() => {
    const order = this.order();
    if (!order) return 0;
    return estimateCollect(order, this.withReturns() ? this.returned() : {}, order.creditSale?.remainingAmount);
  });
  // edit
  protected readonly editing = signal(false);
  protected readonly editLines = signal<EditLine[]>([]);
  protected readonly draft = signal<EditDraft>({ name: '', phone: '', address: '', notes: '', zoneId: '', deliveryFee: 0 });
  protected readonly zones = signal<Array<{ id: string; name: string; fee: number }>>([]);
  protected readonly productQuery = signal('');
  protected readonly productResults = signal<Array<{ _id: string; name: string; code?: string; retailPrice: number; discountPercentage?: number; inventoryCount: number }>>([]);
  private readonly extraStock = new Map<string, number>();

  ngOnInit(): void {
    this.load();
  }

  protected stepInfo(order: OrderDetail) { return orderSteps(order); }
  protected invoiceHint(order: OrderDetail): string | null { return invoiceHintKey(order); }
  protected pillClass(status: OrderDetail['status']): string { return mobilePillClass(this.variant(status)); }
  /** The one action the sticky bar highlights: the first allowed action that is not a refusal. */
  protected primaryAction = computed<OrderAction | null>(() => this.actions().find((action) => action !== 'reject' && action !== 'cancel' && action !== 'refuse' && action !== 'edit') ?? null);

  protected variant(status: OrderDetail['status']): NotaPillVariant {
    return ORDER_STATUS_VARIANT[status] ?? 'neutral';
  }

  protected load(): void {
    const id = this.route.snapshot.paramMap.get('id') || '';
    this.loadError.set(false);
    this.service.get(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (order) => this.order.set(order),
      error: () => this.loadError.set(true),
    });
  }

  protected whatsapp(phone: string): string {
    return whatsappLink(phone);
  }

  /** The "send confirmation on WhatsApp" link: the shop's template filled with this order's values. */
  protected confirmLink(order: OrderDetail): string {
    return whatsappConfirmLink(order.contact.phone, order.whatsappTemplate, { name: order.contact.name, number: order.number, total: order.total, deliveryTime: order.deliveryTime || '' });
  }

  protected async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.show(this.translate.instant('orders.page.copied'), 'success', 2000);
    } catch {
      this.toast.error(this.translate.instant('orders.page.copyFailed'));
    }
  }

  protected short(line: OrderDetail['items'][number]): boolean {
    const order = this.order();
    if (!order || !['new', 'confirmed', 'preparing'].includes(order.status) || line.inventoryCount === null) return false;
    return line.qty > Math.max(0, line.inventoryCount - line.reservedByOthers);
  }

  protected editSummary(entry: OrderHistoryEntry): string {
    const details = (entry.details || {}) as { total?: { from: number; to: number }; lines?: unknown[] };
    const parts: string[] = [];
    if (details.lines?.length) parts.push(this.translate.instant('orders.page.linesChanged', { n: details.lines.length }));
    if (details.total) parts.push(`${details.total.from} → ${details.total.to}`);
    return parts.join(' · ');
  }

  // ------------------------------------------------------------------ actions

  protected run(action: OrderAction): void {
    this.errorMessage.set('');
    const order = this.order();
    if (!order) return;
    switch (action) {
      case 'confirm': return this.apply(this.service.confirm(order.id));
      case 'prepare': return this.apply(this.service.prepare(order.id));
      case 'ready': return this.apply(this.service.ready(order.id));
      case 'verifyPayment': this.reference.set(''); this.verifyOpen.set(true); return;
      case 'pickup': this.pickupOpen.set(true); return;
      case 'reject': case 'cancel': case 'refuse': this.reason.set(''); this.reasonFor.set(action); return;
      case 'dispatch': this.courierId.set(''); this.dispatchOpen.set(true); this.service.listCouriers().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (list) => this.couriers.set(list), error: () => undefined }); return;
      case 'deliver': this.withReturns.set(false); this.returned.set({}); this.collected.set(null); this.deliverOpen.set(true); return;
      case 'edit': this.startEdit(order); return;
    }
  }

  private apply(request: ReturnType<OrdersService['confirm']>): void {
    this.busy.set(true);
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (order) => {
        this.busy.set(false);
        this.order.set(order);
        this.editing.set(false);
        this.reasonFor.set(null); this.dispatchOpen.set(false); this.deliverOpen.set(false); this.verifyOpen.set(false); this.pickupOpen.set(false);
      },
      error: (response) => {
        this.busy.set(false);
        this.errorMessage.set(this.messageOf(response));
        // Someone else changed the order (409): show what it is now.
        if (response?.status === 409) this.load();
      },
    });
  }

  protected submitReason(): void {
    const order = this.order(); const action = this.reasonFor();
    if (!order || !action) return;
    const text = this.reason().trim();
    this.apply(action === 'reject' ? this.service.reject(order.id, text) : action === 'cancel' ? this.service.cancel(order.id, text) : this.service.refuse(order.id, text));
  }

  protected submitVerify(): void {
    const order = this.order();
    if (order) this.apply(this.service.verifyPayment(order.id, this.reference()));
  }

  /** Cash on pickup sends the box only when staff chose another than their default (the server then picks this device's box). */
  protected submitPickup(): void {
    const order = this.order();
    if (!order) return;
    const boxId = order.paymentMethod === 'cod' ? this.paymentBox.boxId() : undefined;
    this.apply(this.service.pickup(order.id, boxId ? { boxId } : {}));
  }

  protected submitDispatch(): void {
    const order = this.order();
    if (order && this.courierId()) this.apply(this.service.dispatch(order.id, this.courierId()));
  }

  protected setReturned(productId: string, value: number | string, max: number): void {
    const qty = Math.min(Math.max(0, Math.floor(Number(value) || 0)), max);
    this.returned.update((map) => ({ ...map, [productId]: qty }));
  }

  protected submitDeliver(): void {
    const order = this.order();
    if (!order || this.allReturned()) return;
    const returns = this.withReturns() ? Object.entries(this.returned()).filter(([, qty]) => qty > 0).map(([productId, qty]) => ({ productId, qty })) : [];
    const collected = this.collected();
    this.apply(this.service.deliver(order.id, { ...(returns.length ? { returns } : {}), ...(collected !== null && String(collected) !== '' ? { collectedAmount: Number(collected) } : {}) }));
  }

  // ------------------------------------------------------------------ edit mode

  private startEdit(order: OrderDetail): void {
    this.editLines.set(order.items.map((line) => ({ productId: line.productId, name: line.name, qty: line.qty, unitPrice: line.unitPrice, isNew: false })));
    this.draft.set({ name: order.contact.name, phone: order.contact.phone, address: order.contact.address, notes: order.contact.notes, zoneId: order.zone?.id ?? '', deliveryFee: order.deliveryFee });
    this.productQuery.set(''); this.productResults.set([]); this.extraStock.clear();
    this.editing.set(true);
    this.service.zones().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (zones) => this.zones.set(zones), error: () => undefined });
  }

  protected patchDraft(patch: Partial<EditDraft>): void {
    this.draft.update((current) => ({ ...current, ...patch }));
  }

  protected setQty(productId: string, value: number | string): void {
    const qty = Math.max(1, Math.floor(Number(value) || 1));
    this.editLines.update((lines) => lines.map((line) => (line.productId === productId ? { ...line, qty } : line)));
  }

  protected removeLine(productId: string): void {
    this.editLines.update((lines) => lines.filter((line) => line.productId !== productId));
  }

  protected stockOf(productId: string): number | string {
    const known = this.order()?.items.find((line) => line.productId === productId)?.inventoryCount;
    return known ?? this.extraStock.get(productId) ?? '—';
  }

  protected reservedOf(productId: string): number {
    return this.order()?.items.find((line) => line.productId === productId)?.reservedByOthers ?? 0;
  }

  protected searchProducts(q: string): void {
    this.productQuery.set(q);
    if (q.trim().length < 2 || !this.auth.has('products.view')) { this.productResults.set([]); return; }
    this.service.searchProducts(q.trim()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (rows) => this.productResults.set(rows.slice(0, 8)), error: () => this.productResults.set([]) });
  }

  protected addProduct(product: { _id: string; name: string; retailPrice: number; discountPercentage?: number; inventoryCount: number }): void {
    if (this.editLines().some((line) => line.productId === product._id)) { this.productResults.set([]); return; }
    this.extraStock.set(product._id, product.inventoryCount);
    // The server prices an added line at the current price; the screen shows nothing but "—" until it saves.
    this.editLines.update((lines) => [...lines, { productId: product._id, name: product.name, qty: 1, unitPrice: null, isNew: true }]);
    this.productQuery.set(''); this.productResults.set([]);
  }

  protected saveEdit(): void {
    const order = this.order();
    if (!order) return;
    const draft = this.draft();
    const payload: OrderEditPayload = {
      items: this.editLines().map((line) => ({ productId: line.productId, qty: line.qty })),
      contact: { name: draft.name, phone: draft.phone, address: draft.address, notes: draft.notes },
      // A pickup order has no zone and no fee: the server refuses both.
      ...(order.fulfillment !== 'pickup' && draft.zoneId && draft.zoneId !== order.zone?.id ? { zoneId: draft.zoneId } : {}),
      ...(order.fulfillment !== 'pickup' && Number(draft.deliveryFee) !== order.deliveryFee ? { deliveryFee: Number(draft.deliveryFee) } : {}),
    };
    this.apply(this.service.edit(order.id, payload));
  }

  // ------------------------------------------------------------------ print

  protected readonly printItems = computed<PrintActionItem[]>(() => [
    { key: 'delivery-note-80', label: '80mm', load: async () => this.noteRequest(deliveryNote80) },
    { key: 'delivery-note-a4', label: 'A4', load: async () => this.noteRequest(deliveryNoteA4) },
  ]);

  private noteRequest(build: typeof deliveryNote80) {
    const order = this.order();
    if (!order) return null;
    const data: DeliveryNoteData = {
      number: order.number, date: order.createdAt, customerName: order.contact.name, customerPhone: order.contact.phone, address: order.contact.address,
      zone: order.zone?.name ?? '', notes: order.contact.notes, courierName: order.courier?.name ?? null,
      items: order.items.map((line) => ({ name: line.name, qty: line.qty, unitPrice: line.unitPrice, total: line.lineTotal })),
      subtotal: order.subtotal, vat: order.vat, deliveryFee: order.deliveryFee, amountToCollect: order.total,
    };
    return { build: (ctx: Parameters<typeof deliveryNote80>[0]) => build(ctx, data) };
  }

  private messageOf(response: { error?: { message?: string; code?: string; lines?: Array<{ name?: string; available?: number }> } }): string {
    const body = response?.error;
    if (body?.code === 'ORDER_ITEMS_INVALID' && body.lines?.length) {
      return `${body.message || ''} ${body.lines.map((line) => `${line.name ?? ''} (${line.available ?? 0})`).join('، ')}`.trim();
    }
    return body?.message || this.translate.instant('orders.page.actionFailed');
  }
}
