import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { DialogModule } from 'primeng/dialog';
import { AuthService } from '../../core/auth/auth.service';
import { NotaCanDirective } from '../../core/auth/nota-can.directive';
import { CashBox } from '../cashbox/cashbox.models';
import { CashboxService } from '../cashbox/cashbox.service';
import { TransferDialogComponent } from '../cashbox/transfer-dialog.component';
import { Courier } from '../orders/orders.models';
import { OrdersService } from '../orders/orders.service';
import { LayoutService } from '../../core/layout/layout.service';
import { MobSheetComponent } from '../mobile/mob-sheet.component';
import { NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaMoneyPipe, NotaPageHeaderComponent } from '../shared/ui';

/**
 * Online Stage 4: /website/couriers. A courier = a name and phone plus his own cash box and customer account (created with him).
 * "Hand in cash" opens the existing transfer dialog (courier box → main box), pre-filled: no new money logic.
 */
@Component({
  selector: 'app-couriers-page',
  imports: [TranslatePipe, FormsModule, RouterLink, DialogModule, NotaCanDirective, TransferDialogComponent, NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaMoneyPipe, NotaPageHeaderComponent, MobSheetComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
@if (layout.isMobile()) {
    <!-- Online Stage 6B (phone): the same couriers. The whole card opens the courier; "تسليم الفلوس" sits on the card; edit and (de)activate in the ⋯ menu; "+ مندوب" adds. -->
    @if (loadError()) { <div class="m-card m-empty" style="margin:12px 14px" role="alert"><span class="nota-error">{{ 'couriers.loadFailed' | translate }}</span> <button type="button" class="m-btn" (click)="load()">{{ 'couriers.retry' | translate }}</button></div> }
    @if (errorMessage() && !dialogOpen()) { <div class="nota-error m-note" role="alert" data-test="courier-error">{{ errorMessage() }}</div> }
    <div class="m-page" style="padding-top:12px">
      @if (loading()) { <div class="m-skel m-skel-row" style="margin:0" role="status"></div> }
      <div class="m-card m-card--flush">
        @for (courier of couriers(); track courier.id) {
          <div class="m-row m-stretch-host" style="flex-wrap:wrap" data-test="courier-row" [class.m-muted]="!courier.isActive">
            <span class="m-avatar">{{ courier.name.charAt(0) || '؟' }}</span>
            <a class="m-row__open m-stretch" [routerLink]="['/website/couriers', courier.id]">
              <span class="m-row__title" style="display:block" dir="auto">{{ courier.name }}</span>
              <span class="m-row__sub nota-num" dir="ltr" style="display:block;text-align:start">{{ courier.phone }}</span>
              <span class="m-row__sub nota-num" style="display:block;white-space:normal">{{ 'couriers.columns.box' | translate }} <span data-test="box-balance">{{ courier.boxBalance | notaMoney }}</span> · {{ 'couriers.columns.owed' | translate }} <span data-test="amount-owed">{{ courier.amountOwed | notaMoney }}</span> · {{ 'couriers.columns.open' | translate }} {{ courier.openOrders }}</span>
            </a>
            <span [class]="courier.isActive ? 'm-pill m-pill--ok' : 'm-pill m-pill--muted'">{{ (courier.isActive ? 'couriers.active' : 'couriers.inactive') | translate }}</span>
            <button *notaCan="['website.manage', 'customers.manage']" type="button" class="m-more" (click)="menuCourier.set(courier)" [attr.aria-label]="'mobile.b.common.moreActions' | translate" data-testid="m-courier-menu">⋯</button>
            <button type="button" class="m-btn" style="width:100%" data-action="hand-in" *notaCan="'cashbox.manage'" [disabled]="courier.boxBalance <= 0" (click)="handIn(courier)">{{ 'couriers.handIn' | translate }}</button>
          </div>
        } @empty {
          @if (!loading()) { <div class="m-empty">{{ 'couriers.empty' | translate }}</div> }
        }
      </div>
    </div>
    <button type="button" class="m-fab" data-action="add-courier" *notaCan="['website.manage', 'customers.manage']" (click)="openAdd()">+ {{ 'couriers.add' | translate }}</button>
    <nota-mob-sheet [open]="menuCourier() !== null" (openChange)="$event || menuCourier.set(null)" [title]="menuCourier()?.name ?? ''">
      @if (menuCourier(); as courier) {
        <div class="m-menu">
          <button type="button" class="m-row" data-action="edit-courier" (click)="menuCourier.set(null); openEdit(courier)">{{ 'couriers.edit' | translate }}</button>
          @if (courier.isActive) { <button type="button" class="m-row m-row--danger" data-action="deactivate-courier" (click)="menuCourier.set(null); setActive(courier, false)">{{ 'couriers.deactivate' | translate }}</button> }
          @else { <button type="button" class="m-row" data-action="activate-courier" (click)="menuCourier.set(null); setActive(courier, true)">{{ 'couriers.activate' | translate }}</button> }
        </div>
      }
    </nota-mob-sheet>

    <p-dialog [visible]="dialogOpen()" (visibleChange)="$event ? null : dialogOpen.set(false)" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog">
      <nota-dialog-shell [title]="(editing() ? 'couriers.edit' : 'couriers.add') | translate" [closeLabel]="'couriers.close' | translate" (closed)="dialogOpen.set(false)">
        <label class="m-field">{{ 'couriers.columns.name' | translate }} *<input id="cNameM" class="m-input" name="nameM" data-test="courier-name" maxlength="120" [ngModel]="name()" (ngModelChange)="name.set($event)" /></label>
        <label class="m-field">{{ 'couriers.columns.phone' | translate }} *<input id="cPhoneM" class="m-input nota-num" type="tel" inputmode="tel" dir="ltr" name="phoneM" data-test="courier-phone" maxlength="30" [ngModel]="phone()" (ngModelChange)="phone.set($event)" /></label>
        @if (!editing()) { <p class="m-note" style="padding:0">{{ 'couriers.createHint' | translate }}</p> }
        @if (errorMessage()) { <p class="nota-error" role="alert" data-test="courier-form-error">{{ errorMessage() }}</p> }
        <ng-container notaDialogFooter>
          <button type="button" class="m-btn" (click)="dialogOpen.set(false)">{{ 'couriers.close' | translate }}</button>
          <button type="button" class="m-btn m-btn--primary" data-action="save-courier" [disabled]="saving() || !name().trim() || phone().trim().length < 5" (click)="save()">{{ 'couriers.save' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>

    <app-transfer-dialog [(visible)]="transferOpen" [boxes]="boxes()" [presetFromId]="handInFrom()" [presetToId]="handInTo()" [presetAmount]="handInAmount()" (done)="load()" />
} @else {

    <div class="cp">
      <nota-page-header [title]="'couriers.title' | translate" [subtitle]="'couriers.subtitle' | translate">
        <div notaPageActions>
          <button type="button" notaButton="primary" data-action="add-courier" *notaCan="['website.manage', 'customers.manage']" (click)="openAdd()">+ {{ 'couriers.add' | translate }}</button>
        </div>
      </nota-page-header>

      @if (loadError()) { <div class="cp__alert" role="alert">{{ 'couriers.loadFailed' | translate }} <button type="button" notaButton (click)="load()">{{ 'couriers.retry' | translate }}</button></div> }
      @if (errorMessage() && !dialogOpen()) { <div class="cp__alert" role="alert" data-test="courier-error">{{ errorMessage() }}</div> }

      <div class="nota-table-wrap">
        <table class="nota-table">
          <thead><tr>
            <th>{{ 'couriers.columns.name' | translate }}</th>
            <th>{{ 'couriers.columns.phone' | translate }}</th>
            <th class="num">{{ 'couriers.columns.box' | translate }}</th>
            <th class="num">{{ 'couriers.columns.owed' | translate }}</th>
            <th class="num">{{ 'couriers.columns.open' | translate }}</th>
            <th>{{ 'couriers.columns.status' | translate }}</th>
            <th><span class="nota-sr-only">{{ 'tableHeaders.actions' | translate }}</span></th>
          </tr></thead>
          <tbody>
            @for (courier of couriers(); track courier.id) {
              <tr data-test="courier-row" [class.is-off]="!courier.isActive">
                <td><a [routerLink]="['/website/couriers', courier.id]" class="cp__name">{{ courier.name }}</a></td>
                <td class="nota-num cp__ltr">{{ courier.phone }}</td>
                <td class="nota-num" data-test="box-balance">{{ courier.boxBalance | notaMoney }}</td>
                <td class="nota-num" data-test="amount-owed">{{ courier.amountOwed | notaMoney }}</td>
                <td class="nota-num">{{ courier.openOrders }}</td>
                <td><span class="nota-pill" [class.nota-pill--ok]="courier.isActive">{{ (courier.isActive ? 'couriers.active' : 'couriers.inactive') | translate }}</span></td>
                <td class="cp__actions">
                  <button type="button" notaButton data-action="hand-in" *notaCan="'cashbox.manage'" [disabled]="courier.boxBalance <= 0" (click)="handIn(courier)">{{ 'couriers.handIn' | translate }}</button>
                  <ng-container *notaCan="['website.manage', 'customers.manage']">
                    <button type="button" notaButton data-action="edit-courier" (click)="openEdit(courier)">{{ 'couriers.edit' | translate }}</button>
                    @if (courier.isActive) {
                      <button type="button" notaButton data-action="deactivate-courier" (click)="setActive(courier, false)">{{ 'couriers.deactivate' | translate }}</button>
                    } @else {
                      <button type="button" notaButton data-action="activate-courier" (click)="setActive(courier, true)">{{ 'couriers.activate' | translate }}</button>
                    }
                  </ng-container>
                </td>
              </tr>
            } @empty {
              @if (!loading()) { <tr><td colspan="7" class="cp__empty">{{ 'couriers.empty' | translate }}</td></tr> }
            }
          </tbody>
        </table>
      </div>
      @if (loading()) { <p class="cp__muted" role="status">{{ 'couriers.loading' | translate }}</p> }
    </div>

    <p-dialog [visible]="dialogOpen()" (visibleChange)="$event ? null : dialogOpen.set(false)" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog">
      <nota-dialog-shell [title]="(editing() ? 'couriers.edit' : 'couriers.add') | translate" [closeLabel]="'couriers.close' | translate" (closed)="dialogOpen.set(false)">
        <div class="cp__form">
          <nota-form-field [label]="'couriers.columns.name' | translate" forId="cName" [required]="true"><input id="cName" class="nota-input" name="name" data-test="courier-name" maxlength="120" [ngModel]="name()" (ngModelChange)="name.set($event)" /></nota-form-field>
          <nota-form-field [label]="'couriers.columns.phone' | translate" forId="cPhone" [required]="true"><input id="cPhone" class="nota-input nota-num" name="phone" data-test="courier-phone" maxlength="30" [ngModel]="phone()" (ngModelChange)="phone.set($event)" /></nota-form-field>
          @if (!editing()) { <p class="cp__muted">{{ 'couriers.createHint' | translate }}</p> }
          @if (errorMessage()) { <p class="cp__error" role="alert" data-test="courier-form-error">{{ errorMessage() }}</p> }
        </div>
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="dialogOpen.set(false)">{{ 'couriers.close' | translate }}</button>
          <button type="button" notaButton="primary" data-action="save-courier" [disabled]="saving() || !name().trim() || phone().trim().length < 5" (click)="save()">{{ 'couriers.save' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>

    <app-transfer-dialog [(visible)]="transferOpen" [boxes]="boxes()" [presetFromId]="handInFrom()" [presetToId]="handInTo()" [presetAmount]="handInAmount()" (done)="load()" />
  }
  `,
  styles: `
    :host { display: block; }
    .cp { display: flex; flex-direction: column; gap: var(--space-gap); }
    .cp__alert { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 14px 16px; border-radius: 12px; background: var(--danger-soft); color: var(--danger-text); }
    .cp__name { font-weight: 600; }
    .cp__ltr { direction: ltr; text-align: start; }
    .cp__actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .cp__empty { text-align: center; color: var(--text-muted); padding: 24px; }
    .cp__muted { margin: 0; color: var(--text-muted); }
    .cp__form { display: flex; flex-direction: column; gap: 14px; min-width: min(420px, 80vw); }
    .cp__error { margin: 0; color: var(--danger); }
    tr.is-off .cp__name { color: var(--text-muted); }
  `,
})
export class CouriersPageComponent implements OnInit {
  private readonly service = inject(OrdersService);
  protected readonly layout = inject(LayoutService);
  /** Phone only (Online Stage 6B): the courier whose ⋯ menu is open. */
  protected readonly menuCourier = signal<Courier | null>(null);
  private readonly cashbox = inject(CashboxService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly couriers = signal<Courier[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly dialogOpen = signal(false);
  protected readonly editing = signal<Courier | null>(null);
  protected readonly saving = signal(false);
  protected readonly name = signal('');
  protected readonly phone = signal('');

  protected readonly transferOpen = signal(false);
  protected readonly boxes = signal<CashBox[]>([]);
  protected readonly handInFrom = signal('');
  protected readonly handInTo = signal('');
  protected readonly handInAmount = signal<number | null>(null);
  protected readonly canManage = computed(() => this.auth.hasAll('website.manage', 'customers.manage'));

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.service.listCouriers().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (list) => { this.couriers.set(list); this.loading.set(false); },
      error: () => { this.loadError.set(true); this.loading.set(false); },
    });
  }

  protected openAdd(): void {
    this.editing.set(null); this.name.set(''); this.phone.set(''); this.errorMessage.set('');
    this.dialogOpen.set(true);
  }

  protected openEdit(courier: Courier): void {
    this.editing.set(courier); this.name.set(courier.name); this.phone.set(courier.phone); this.errorMessage.set('');
    this.dialogOpen.set(true);
  }

  protected save(): void {
    const courier = this.editing();
    const payload = { name: this.name().trim(), phone: this.phone().trim() };
    this.saving.set(true);
    this.errorMessage.set('');
    (courier ? this.service.updateCourier(courier.id, payload) : this.service.createCourier(payload)).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.dialogOpen.set(false); this.load(); },
      error: (response) => { this.saving.set(false); this.errorMessage.set(typeof response?.error?.message === 'string' ? response.error.message : ''); },
    });
  }

  /** A courier with open orders, cash or a balance is refused by the server (409); the message says which. */
  protected setActive(courier: Courier, isActive: boolean): void {
    this.errorMessage.set('');
    this.service.updateCourier(courier.id, { isActive }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.load(),
      error: (response) => this.errorMessage.set(typeof response?.error?.message === 'string' ? response.error.message : ''),
    });
  }

  /** "Hand in cash": the existing transfer dialog, courier box → main box, with the box balance as the amount. */
  protected handIn(courier: Courier): void {
    this.cashbox.boxes().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response) => {
        const active = response.data.filter((box) => box.isActive);
        this.boxes.set(active);
        const main = active.find((box) => box.isMain);
        const own = active.find((box) => box._id === courier.boxId);
        this.handInFrom.set(courier.boxId);
        this.handInTo.set(main?._id ?? '');
        this.handInAmount.set(own?.balance ?? courier.boxBalance);
        this.transferOpen.set(true);
      },
      error: () => undefined,
    });
  }
}
