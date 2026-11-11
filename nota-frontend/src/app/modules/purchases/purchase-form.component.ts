import { LockDateService } from '../../core/accounting-lock/lock-date.service';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { Subject, debounceTime, distinctUntilChanged, of, switchMap, catchError } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { NotaCanDirective } from '../../core/auth/nota-can.directive';
import { PaymentBoxSelectComponent } from '../cashbox/payment-box-select.component';
import { PaymentBoxService } from '../cashbox/payment-box.service';
import { NotaBalancePipe, NotaButtonDirective, NotaFormFieldComponent, NotaMoneyPipe, NotaPageHeaderComponent, NotaLockBannerComponent, NotaLockedDateDirective } from '../shared/ui';
import { Supplier, SuppliersService } from '../suppliers/suppliers.service';
import { PaymentMode, allocateCosts, defaultPurchaseVat, journalPreview, paymentModeOf, round2, weightedAverage } from './purchase-math';
import { VatSettingsService } from '../shop-profile/services/vat-settings.service';
import { hasMoneyPrecision } from '../shared/price-precision';
import { PurchaseProduct } from './purchases.models';
import { PurchasesService } from './purchases.service';
import { localDateKey } from '../../core/utilities/local-date';

interface Line {
  key: number;
  product: PurchaseProduct;
  qty: number | null;
  unitPrice: number | null;
}

/**
 * Stage 20: the new purchase invoice (docs/design/screens/Purchases.dc.html). Goods enter stock when it is saved.
 * Every number on the screen comes from purchase-math.ts, which mirrors the backend rules (discount and other costs
 * allocated by line value, moving weighted average), so the preview, the "new cost" hint and the saved invoice agree.
 */
@Component({
  selector: 'app-purchase-form',
  standalone: true,
  imports: [NotaLockBannerComponent, NotaLockedDateDirective, FormsModule, RouterLink, TranslatePipe, NotaCanDirective, NotaButtonDirective, NotaFormFieldComponent, NotaMoneyPipe, NotaBalancePipe, NotaPageHeaderComponent, PaymentBoxSelectComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pf">
      <nota-page-header [title]="'purchases.new.title' | translate" [subtitle]="'purchases.new.subtitle' | translate">
        <div notaPageActions><a notaButton routerLink="/purchases" data-action="back">{{ 'purchases.title' | translate }}</a></div>
      </nota-page-header>

      <section class="nota-card pf__card">
        <div class="pf__grid">
          <nota-form-field [label]="'purchases.new.supplier' | translate" forId="pfSupplier" [required]="true">
            <select id="pfSupplier" class="nota-select" name="supplier" data-test="supplier" [ngModel]="supplierId()" (ngModelChange)="supplierId.set($event)">
              <option value="">—</option>
              @for (row of suppliers(); track row._id) { <option [value]="row._id">{{ row.name }}</option> }
            </select>
          </nota-form-field>
          <nota-form-field [label]="'purchases.new.supplierInvoiceNo' | translate" forId="pfInvoiceNo">
            <input id="pfInvoiceNo" class="nota-input" type="text" name="invoiceNo" maxlength="60" data-test="supplier-invoice-no" [ngModel]="supplierInvoiceNo()" (ngModelChange)="supplierInvoiceNo.set($event)" />
          </nota-form-field>
          <nota-form-field [label]="'purchases.new.date' | translate" forId="pfDate">
            <input id="pfDate" class="nota-input nota-num" type="date" notaLockedDate name="date" data-test="date" [ngModel]="date()" (ngModelChange)="date.set($event)" />
      <nota-lock-banner [selected]="date()" />
          </nota-form-field>
        </div>
        @if (supplier(); as s) {
          @let shown = balanceBefore() | notaBalance;
          <p class="pf__balance" data-test="balance-before">
            {{ 'purchases.new.balanceBefore' | translate }}:
            <b class="nota-num">{{ shown.text }} {{ 'suppliers.currency' | translate }}</b>
            {{ (shown.side === 'credit' ? 'suppliers.weOwe' : 'suppliers.theyOwe') | translate }}
          </p>
        }
      </section>

      <section class="nota-card pf__card">
        <div class="pf__search">
          <input class="nota-input" type="search" name="productSearch" autocomplete="off" data-test="product-search"
            [placeholder]="'purchases.new.searchProduct' | translate" [attr.aria-label]="'purchases.new.searchProduct' | translate"
            [ngModel]="query()" (ngModelChange)="onQuery($event)" />
          <button *notaCan="['products.manage', 'products.viewCost']" type="button" notaButton data-action="new-product" (click)="toggleNewProduct()">+ {{ 'purchases.new.newProduct' | translate }}</button>
        </div>
        @if (results().length) {
          <ul class="pf__results" data-test="product-results">
            @for (p of results(); track p._id) {
              <li><button type="button" class="pf__result" data-action="add-product" (click)="addProduct(p)">
                <span>{{ p.name }} <small>{{ p.code }}</small></span>
                <span class="nota-num">{{ 'purchases.new.inStock' | translate: { count: p.inventoryCount } }}</span>
              </button></li>
            }
          </ul>
        }
        @if (newProductOpen()) {
          <div class="pf__newproduct" data-test="new-product-form">
            <nota-form-field [label]="'purchases.new.productName' | translate" forId="npName" [required]="true">
              <input id="npName" class="nota-input" name="npName" data-test="np-name" [ngModel]="np().name" (ngModelChange)="setNp('name', $event)" />
            </nota-form-field>
            <nota-form-field [label]="'purchases.new.productCode' | translate" forId="npCode" [required]="true">
              <input id="npCode" class="nota-input" name="npCode" data-test="np-code" [ngModel]="np().code" (ngModelChange)="setNp('code', $event)" />
            </nota-form-field>
            <nota-form-field [label]="'purchases.new.productCategory' | translate" forId="npCategory" [required]="true">
              <select id="npCategory" class="nota-select" name="npCategory" data-test="np-category" [ngModel]="np().categoryId" (ngModelChange)="setNp('categoryId', $event)">
                <option value="">—</option>
                @for (c of categories(); track c._id) { <option [value]="c._id">{{ c.name }}</option> }
              </select>
            </nota-form-field>
            <nota-form-field [label]="'purchases.new.productWholesale' | translate" forId="npWholesale" [required]="true">
              <input id="npWholesale" class="nota-input nota-num" type="number" min="0" step="0.01" name="npWholesale" data-test="np-wholesale" [ngModel]="np().wholesalePrice" (ngModelChange)="setNp('wholesalePrice', $event)" />
            </nota-form-field>
            <nota-form-field [label]="'purchases.new.productRetail' | translate" forId="npRetail" [required]="true">
              <input id="npRetail" class="nota-input nota-num" type="number" min="0" step="0.01" name="npRetail" data-test="np-retail" [ngModel]="np().retailPrice" (ngModelChange)="setNp('retailPrice', $event)" />
            </nota-form-field>
            @if (newProductError()) { <p class="nota-error" role="alert" data-test="np-error">{{ newProductError() | translate }}</p> }
            <button type="button" notaButton="primary" data-action="create-product" [disabled]="!newProductValid() || busy()" (click)="createProduct()">{{ 'purchases.new.createProduct' | translate }}</button>
          </div>
        }

        <div class="nota-table-wrap">
          <table class="nota-table" data-test="lines">
            <thead><tr>
              <th>{{ 'purchases.new.item' | translate }}</th>
              <th class="nota-num">{{ 'purchases.new.qty' | translate }}</th>
              <th class="nota-num">{{ 'purchases.new.unitPrice' | translate }}</th>
              <th class="nota-num">{{ 'purchases.new.lineTotal' | translate }}</th>
              <th class="nota-num">{{ 'purchases.new.stockAfter' | translate }}</th>
              <th><span class="nota-sr-only">{{ 'tableHeaders.actions' | translate }}</span></th>
            </tr></thead>
            <tbody>
              @for (row of lines(); track row.key; let i = $index) {
                <tr [attr.data-line]="row.product.code">
                  <td class="pf__name">
                    <strong>{{ row.product.name }}</strong>
                    <div class="pf__meta">{{ row.product.code }}</div>
                    @if (hints()[i]; as hint) {
                      <div class="pf__hint" data-test="new-cost">{{ 'purchases.new.newCost' | translate }} ≈ <span class="nota-num">{{ hint.newCost | notaMoney }}</span></div>
                      @if (hint.aboveRetail) { <div class="pf__warn" role="alert" data-test="cost-warning">{{ 'purchases.new.costAboveRetail' | translate }}</div> }
                    }
                  </td>
                  <td class="nota-num"><input class="nota-input nota-num pf__qty" type="number" min="1" step="1" name="qty{{ row.key }}" data-test="qty" [attr.aria-label]="'purchases.new.qty' | translate"
                    [ngModel]="row.qty" (ngModelChange)="setLine(row.key, 'qty', $event)" /></td>
                  <td class="nota-num"><input class="nota-input nota-num pf__price" type="number" min="0" step="0.01" name="price{{ row.key }}" [attr.aria-invalid]="hasMoneyPrecision(row.unitPrice) ? null : true" data-test="unit-price" [attr.aria-label]="'purchases.new.unitPrice' | translate"
                    [ngModel]="row.unitPrice" (ngModelChange)="setLine(row.key, 'unitPrice', $event)" /></td>
                  <td class="nota-num" data-test="line-total">{{ lineTotals()[i] | notaMoney }}</td>
                  <td class="nota-num" data-test="stock-after">{{ stocks()[i].before }} ← <b>{{ stocks()[i].after }}</b></td>
                  <td><button type="button" notaButton="danger" data-action="remove-line" (click)="removeLine(row.key)">×</button></td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="pf__empty" data-test="no-lines">{{ 'purchases.new.noLines' | translate }}</td></tr>
              }
            </tbody>
          </table>
        </div>

        <details class="pf__extras" [open]="extrasOpen()" (toggle)="extrasOpen.set($any($event.target).open)">
          <summary data-test="extras-toggle">{{ 'purchases.new.extras' | translate }}</summary>
          <div class="pf__grid pf__grid--2">
            <nota-form-field [label]="'purchases.new.discount' | translate" forId="pfDiscount">
              <input id="pfDiscount" class="nota-input nota-num" type="number" min="0" step="0.01" name="discount" data-test="discount" [ngModel]="discount()" (ngModelChange)="discount.set($event)" />
            </nota-form-field>
            <nota-form-field [label]="'purchases.new.otherCosts' | translate" forId="pfOther">
              <input id="pfOther" class="nota-input nota-num" type="number" min="0" step="0.01" name="otherCosts" data-test="other-costs" [ngModel]="otherCosts()" (ngModelChange)="otherCosts.set($event)" />
            </nota-form-field>
          </div>
          <p class="pf__note">{{ 'purchases.new.extrasNote' | translate }}</p>
        </details>
        @if (vatContext(); as ctx) {
          <div class="pf__vat" data-test="vat-block">
            <label class="pf__check"><input type="checkbox" name="vatRegistered" data-test="vat-registered" [ngModel]="vatRegistered()" (ngModelChange)="setVatRegistered($event)" /> {{ 'vat.purchase.registered' | translate }}</label>
            @if (vatRegistered()) {
              <nota-form-field [label]="'vat.purchase.amount' | translate: { rate: ctx.rate }" forId="pfVat" [hint]="'vat.purchase.amountHint' | translate"
                [error]="vatInvalid() ? ('vat.purchase.invalid' | translate) : null">
                <input id="pfVat" class="nota-input nota-num" type="number" min="0" step="0.01" name="vatAmount" data-test="vat-amount" [ngModel]="vatAmount()" (ngModelChange)="setVatAmount($event)" />
              </nota-form-field>
            }
          </div>
          <div class="pf__vat-rows">
            <div><span>{{ 'vat.totals.net' | translate }}</span><b class="nota-num" data-test="net">{{ allocation().total | notaMoney }}</b></div>
            <div><span>{{ 'vat.purchase.input' | translate }}</span><b class="nota-num" data-test="vat">{{ vatAmount() | notaMoney }}</b></div>
          </div>
        }
        <div class="pf__total"><span>{{ 'purchases.new.total' | translate }}</span><b class="nota-num" data-test="total">{{ grandTotal() | notaMoney }}</b></div>
      </section>

      <section class="nota-card pf__card">
        <div class="pf__modes" role="radiogroup" [attr.aria-label]="'purchases.new.payment' | translate">
          @for (m of modes; track m) {
            <button type="button" class="pf__mode" role="radio" [attr.aria-checked]="mode() === m" [class.pf__mode--on]="mode() === m"
              [disabled]="m !== 'all_credit' && !canPay()" [attr.data-mode]="m" (click)="setMode(m)">{{ 'purchases.new.modes.' + m | translate }}</button>
          }
        </div>
        @if (!canPay()) { <p class="pf__note" data-test="credit-only">{{ 'purchases.new.creditOnly' | translate }}</p> }
        @if (mode() === 'part_cash') {
          <nota-form-field [label]="'purchases.new.paid' | translate" forId="pfPaid" [required]="true" [error]="paidInvalid() ? ('purchases.errors.paidRange' | translate) : null">
            <input id="pfPaid" class="nota-input nota-num" type="number" min="0" step="0.01" name="paid" data-test="paid" [ngModel]="paidInput()" (ngModelChange)="paidInput.set($event)" />
          </nota-form-field>
        }
        @if (paid() > 0) { <nota-payment-box-select labelKey="purchases.new.fromBox" /> }
        <p class="pf__remaining" data-test="remaining">{{ 'purchases.new.remaining' | translate }}: <b class="nota-num">{{ remaining() | notaMoney }}</b> {{ 'suppliers.currency' | translate }}</p>
      </section>

      @if (preview().length) {
        <section class="nota-card pf__card" data-test="journal-preview">
          <h3 class="pf__h">{{ 'purchases.new.journalTitle' | translate }}</h3>
          <ul class="pf__journal">
            @for (row of preview(); track $index) {
              <li><span>{{ (row.side === 'debit' ? 'purchases.new.from' : 'purchases.new.to') | translate }} {{ accountName(row.account) }}</span>
                <span class="nota-num">{{ row.amount | notaMoney }} {{ (row.side === 'debit' ? 'purchases.new.debit' : 'purchases.new.credit') | translate }}</span></li>
            }
          </ul>
        </section>
      }

      @if (priceDecimalsInvalid()) { <p class="nota-error" role="alert" data-test="price-decimals">{{ 'vat.priceDecimals' | translate }}</p> }
      @if (vatChanged(); as changed) { <p class="nota-error" role="alert" data-test="vat-changed">{{ 'vat.purchaseChanged' | translate: { current: (changed.current | notaMoney), expected: (changed.expected | notaMoney) } }}</p> }
      @if (error()) { <p class="nota-error" role="alert" data-test="save-error">{{ error() | translate }}</p> }
      <div class="pf__footer">
        <button type="button" notaButton="primary" size="lg" data-action="save-purchase" [disabled]="!valid() || busy()" (click)="save()">{{ (busy() ? 'purchases.new.saving' : 'purchases.new.save') | translate }}</button>
        @if (supplier()) {
          @let after = balanceAfter() | notaBalance;
          <span class="pf__after" data-test="balance-after">{{ 'purchases.new.balanceAfter' | translate }}: <b class="nota-num">{{ after.text }} {{ 'suppliers.currency' | translate }}</b>
            {{ (after.side === 'credit' ? 'suppliers.weOwe' : 'suppliers.theyOwe') | translate }}</span>
        }
      </div>
    </div>
  `,
  styles: `
    .pf { display: flex; flex-direction: column; gap: 16px; }
    .pf__card { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .pf__grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .pf__grid--2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .pf__balance, .pf__remaining { margin: 0; font-size: 14px; color: var(--text-muted); }
    .pf__balance b, .pf__remaining b { color: var(--text); }
    .pf__search { display: flex; gap: 10px; flex-wrap: wrap; }
    .pf__search .nota-input { flex: 1 1 220px; }
    .pf__results { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-control); max-height: 240px; overflow: auto; }
    .pf__result { display: flex; justify-content: space-between; gap: 12px; width: 100%; padding: 10px 12px; background: none; border: 0; border-bottom: 1px solid var(--border); cursor: pointer; color: var(--text); font: inherit; text-align: start; }
    .pf__result:hover, .pf__result:focus-visible { background: var(--surface-alt, var(--brand-soft)); }
    .pf__newproduct { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; padding: 12px; border: 1px dashed var(--border); border-radius: var(--radius-control); align-items: end; }
    .pf__meta, .pf__hint, .pf__note { font-size: 12px; color: var(--text-muted); margin: 0; }
    .pf__hint { color: var(--brand); }
    .pf__warn { margin: 4px 0 0; font-size: 12px; font-weight: 700; color: var(--warning-text); background: var(--warning-soft); padding: 4px 8px; border-radius: var(--radius-control); }
    .pf__qty { width: 90px; } .pf__price { width: 120px; }
    .pf__name { min-width: 150px; }
    .nota-table { min-width: 560px; }
    .pf__vat { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px dashed var(--border); border-radius: var(--radius-control); }
    .pf__check { display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
    .pf__vat-rows { display: flex; flex-direction: column; gap: 4px; font-size: 14px; color: var(--text-muted); }
    .pf__vat-rows div { display: flex; justify-content: space-between; } .pf__vat-rows b { color: var(--text); }
    .pf__empty { text-align: center; color: var(--text-muted); padding: 24px; }
    .pf__extras summary { cursor: pointer; font-weight: 700; padding: 6px 0; }
    .pf__total { display: flex; justify-content: space-between; align-items: center; font-size: 18px; font-weight: 800; padding-top: 8px; border-top: 1px solid var(--border); }
    .pf__modes { display: flex; gap: 8px; flex-wrap: wrap; }
    .pf__mode { min-height: 44px; padding: 0 18px; border-radius: var(--radius-control); border: 1px solid var(--border); background: var(--surface); color: var(--text); font: inherit; font-weight: 600; cursor: pointer; }
    .pf__mode--on { background: var(--brand); border-color: var(--brand); color: var(--on-brand, #fff); }
    .pf__mode:disabled { opacity: .5; cursor: not-allowed; }
    .pf__remaining { font-size: 15px; }
    .pf__h { margin: 0; font-size: 15px; }
    .pf__journal { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .pf__journal li { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }
    .pf__footer { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }
    .pf__after { color: var(--text-muted); font-size: 14px; } .pf__after b { color: var(--text); }
    @media (max-width: 640px) { .pf__grid, .pf__grid--2 { grid-template-columns: minmax(0, 1fr); } .pf__footer { flex-direction: column; align-items: stretch; } .pf__qty, .pf__price { width: 100%; min-width: 72px; } }
  `,
})
export class PurchaseFormComponent implements OnInit {
  /** Stage 22: a date inside a closed period cannot be submitted (the banner explains, the server refuses too). */
  private readonly lock = inject(LockDateService);
  private readonly service = inject(PurchasesService);
  private readonly suppliersService = inject(SuppliersService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);
  private readonly paymentBox = inject(PaymentBoxService);
  private readonly destroyRef = inject(DestroyRef);

  readonly modes: readonly PaymentMode[] = ['all_cash', 'part_cash', 'all_credit'];

  readonly suppliers = signal<Supplier[]>([]);
  readonly supplierId = signal('');
  readonly supplierInvoiceNo = signal('');
  readonly date = signal(localDateKey());
  readonly lines = signal<Line[]>([]);
  readonly discount = signal<number | null>(null);
  readonly otherCosts = signal<number | null>(null);
  readonly extrasOpen = signal(false);
  readonly mode = signal<PaymentMode>('all_credit');
  readonly paidInput = signal<number | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');

  readonly query = signal('');
  readonly results = signal<PurchaseProduct[]>([]);
  private readonly query$ = new Subject<string>();
  private nextKey = 1;

  readonly newProductOpen = signal(false);
  readonly categories = signal<{ _id: string; name: string }[]>([]);
  readonly np = signal({ name: '', code: '', categoryId: '', wholesalePrice: null as number | null, retailPrice: null as number | null });

  // ---- Stage 21: VAT. Only while the shop has VAT on and the purchase date is on/after its start date; otherwise nothing below shows.
  private readonly vatSettings = inject(VatSettingsService);
  readonly vatContext = computed(() => this.vatSettings.contextFor(this.date()));
  /** Stage 21 review: the VAT settings changed on another PC; the form now shows the server's VAT and asks to save again. */
  readonly vatChanged = signal<{ expected: number; current: number } | null>(null);
  readonly hasMoneyPrecision = hasMoneyPrecision;
  /** A unit price has at most two decimals (the server refuses more with PRICE_PRECISION). */
  readonly priceDecimalsInvalid = computed(() => this.lines().some((row) => !hasMoneyPrecision(row.unitPrice)));
  /** null = follow the supplier's flag ("المورد مسجل ضريبيًا" default). */
  private readonly vatRegisteredChoice = signal<boolean | null>(null);
  readonly vatRegistered = computed(() => this.vatRegisteredChoice() ?? Boolean(this.supplier()?.vatRegistered));
  /** null = the shop rate on the net total; a number = the supplier's printed amount. */
  readonly vatOverride = signal<number | null>(null);
  readonly vatAmount = computed(() => {
    const context = this.vatContext();
    if (!context || !this.vatRegistered()) return 0;
    return this.vatOverride() ?? defaultPurchaseVat(this.allocation().total, context.rate);
  });
  readonly vatInvalid = computed(() => this.vatAmount() < 0 || this.vatAmount() > this.allocation().total);
  /** What we owe the supplier: the net total plus the VAT (the net alone with VAT off). */
  readonly grandTotal = computed(() => round2(this.allocation().total + this.vatAmount()));
  setVatRegistered(value: boolean): void {
    this.vatRegisteredChoice.set(value);
    this.vatOverride.set(null);
  }
  setVatAmount(value: number | null): void {
    this.vatOverride.set(value === null || (value as unknown) === '' ? null : Number(value));
  }
  readonly newProductError = signal('');

  readonly supplier = computed(() => this.suppliers().find((row) => row._id === this.supplierId()) ?? null);
  /** Signed like the Stage 18 list: the API balance is positive when we owe, the balance pipe wants debit − credit. */
  readonly balanceBefore = computed(() => ({ balance: -(this.supplier()?.balance ?? 0), normalSide: 'credit' as const }));
  readonly canPay = computed(() => this.auth.has('suppliers.pay'));

  readonly lineTotals = computed(() => this.lines().map((row) => round2((row.qty ?? 0) * (row.unitPrice ?? 0))));
  readonly allocation = computed(() => allocateCosts(this.lineTotals(), this.discount() ?? 0, this.otherCosts() ?? 0));
  /** Per line: the product's average cost after this line (lines of one product build on each other). */
  readonly hints = computed(() => {
    const { lineCosts } = this.allocation();
    const state = new Map<string, { qty: number; cost: number }>();
    return this.lines().map((row, index) => {
      const qty = row.qty ?? 0;
      if (qty <= 0 || row.unitPrice === null) return null;
      const before = state.get(row.product._id) ?? { qty: row.product.inventoryCount, cost: row.product.purchasePrice };
      const newCost = weightedAverage(before.qty, before.cost, qty, lineCosts[index]);
      state.set(row.product._id, { qty: before.qty + qty, cost: newCost });
      // Only a warning: saving is never blocked. The product's retail price is checked against the new average cost.
      const retail = row.product.retailPrice;
      return { newCost, aboveRetail: retail !== undefined && retail !== null && retail > 0 && newCost > retail };
    });
  });

  /** "المخزون بعد" per line: the product's stock plus the earlier lines of the same product (like the cost hint). */
  readonly stocks = computed(() => {
    const running = new Map<string, number>();
    return this.lines().map((row) => {
      const before = running.get(row.product._id) ?? row.product.inventoryCount;
      const after = before + (row.qty ?? 0);
      running.set(row.product._id, after);
      return { before, after };
    });
  });

  readonly paid = computed(() => {
    const total = this.grandTotal();
    if (this.mode() === 'all_cash') return total;
    if (this.mode() === 'part_cash') return round2(this.paidInput() ?? 0);
    return 0;
  });
  readonly paidInvalid = computed(() => this.mode() === 'part_cash' && (this.paid() <= 0 || this.paid() >= this.grandTotal()));
  readonly remaining = computed(() => round2(this.grandTotal() - this.paid()));
  readonly balanceAfter = computed(() => ({ balance: -round2((this.supplier()?.balance ?? 0) + this.remaining()), normalSide: 'credit' as const }));
  readonly preview = computed(() => journalPreview(this.grandTotal(), this.paid(), this.vatAmount()));

  readonly valid = computed(() => {
    const rows = this.lines();
    return Boolean(this.supplierId()) && rows.length > 0 && rows.every((row) => (row.qty ?? 0) > 0 && Number.isInteger(row.qty) && row.unitPrice !== null && row.unitPrice >= 0 && hasMoneyPrecision(row.unitPrice))
      && this.allocation().total > 0 && !this.paidInvalid() && (this.discount() ?? 0) <= this.allocation().subtotal && !this.vatInvalid() && !this.lock.isLocked(this.date());
  });
  readonly newProductValid = computed(() => {
    const value = this.np();
    return Boolean(value.name.trim() && value.code.trim() && value.categoryId) && (value.retailPrice ?? -1) >= 0 && (value.wholesalePrice ?? -1) >= 0;
  });

  ngOnInit(): void {
    // Stage 21 review: another PC may have changed the VAT settings since this one signed in.
    this.vatSettings.refresh();
    this.paymentBox.load();
    this.suppliersService.list().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => {
        this.suppliers.set(rows.filter((row) => row.isActive));
        const preset = this.route.snapshot.queryParamMap.get('supplier');
        if (preset && rows.some((row) => row._id === preset)) this.supplierId.set(preset);
      },
      error: () => this.error.set('purchases.errors.loadSuppliers'),
    });
    this.query$.pipe(debounceTime(250), distinctUntilChanged(), switchMap((q) => (q.trim().length >= 1 ? this.service.searchProducts(q.trim()).pipe(catchError(() => of([] as PurchaseProduct[]))) : of([] as PurchaseProduct[]))), takeUntilDestroyed(this.destroyRef))
      .subscribe((rows) => this.results.set(rows.slice(0, 8)));
  }

  onQuery(value: string): void {
    this.query.set(value);
    this.query$.next(value);
  }

  addProduct(product: PurchaseProduct): void {
    const existing = this.lines().find((row) => row.product._id === product._id);
    if (existing) this.setLine(existing.key, 'qty', (existing.qty ?? 0) + 1);
    else this.lines.update((rows) => [...rows, { key: this.nextKey++, product, qty: 1, unitPrice: product.purchasePrice ?? 0 }]);
    this.query.set('');
    this.results.set([]);
  }

  setLine(key: number, field: 'qty' | 'unitPrice', value: number | null): void {
    this.lines.update((rows) => rows.map((row) => (row.key === key ? { ...row, [field]: value === null || value === ('' as unknown) ? null : Number(value) } : row)));
  }

  removeLine(key: number): void {
    this.lines.update((rows) => rows.filter((row) => row.key !== key));
  }

  setMode(mode: PaymentMode): void {
    if (mode !== 'all_credit' && !this.canPay()) return;
    this.mode.set(mode);
    if (mode === 'part_cash' && this.paidInput() === null) this.paidInput.set(null);
  }

  accountName(account: 'inventory' | 'box' | 'supplier' | 'adjustment' | 'vat'): string {
    if (account === 'supplier') return this.supplier()?.name ?? '';
    if (account === 'vat') return 'ضريبة مدخلات قابلة للخصم';
    if (account === 'box') return this.paymentBox.effective()?.name ?? '';
    return account === 'inventory' ? this.translateInventory : '';
  }

  /** The inventory account label is a fixed ledger name. */
  readonly translateInventory = 'المخزون';

  setNp(field: 'name' | 'code' | 'categoryId' | 'wholesalePrice' | 'retailPrice', value: string | number | null): void {
    this.np.update((current) => ({ ...current, [field]: value }));
  }

  /** "صنف جديد": a product with stock 0; the purchase itself adds its stock and sets its cost. */
  createProduct(): void {
    if (!this.newProductValid()) return;
    const value = this.np();
    this.busy.set(true);
    this.newProductError.set('');
    this.service.createProduct({
      name: value.name.trim(), code: value.code.trim(), categoryId: value.categoryId, inventoryCount: 0, purchasePrice: 0,
      wholesalePrice: Number(value.wholesalePrice), retailPrice: Number(value.retailPrice),
    }).subscribe({
      next: (created) => {
        this.busy.set(false);
        this.newProductOpen.set(false);
        this.np.set({ name: '', code: '', categoryId: '', wholesalePrice: null, retailPrice: null });
        this.addProduct({ _id: created._id, name: created.name, code: created.code, inventoryCount: 0, purchasePrice: 0, retailPrice: Number(value.retailPrice) });
      },
      error: () => { this.busy.set(false); this.newProductError.set('purchases.errors.productFailed'); },
    });
    if (!this.categories().length) this.loadCategories();
  }

  toggleNewProduct(): void {
    this.newProductOpen.update((open) => !open);
    if (this.newProductOpen() && !this.categories().length) this.loadCategories();
  }

  private loadCategories(): void {
    this.service.categories().subscribe({ next: (rows) => this.categories.set(rows), error: () => this.newProductError.set('purchases.errors.loadCategories') });
  }

  save(): void {
    if (!this.valid()) return;
    this.busy.set(true);
    this.error.set('');
    const paid = this.paid();
    const payload = {
      supplierId: this.supplierId(),
      ...(this.supplierInvoiceNo().trim() ? { supplierInvoiceNo: this.supplierInvoiceNo().trim() } : {}),
      ...(this.date() ? { date: this.date() } : {}),
      items: this.lines().map((row) => ({ productId: row.product._id, qty: Number(row.qty), unitPrice: Number(row.unitPrice) })),
      ...((this.discount() ?? 0) > 0 ? { discountAmount: Number(this.discount()) } : {}),
      ...((this.otherCosts() ?? 0) > 0 ? { otherCosts: Number(this.otherCosts()) } : {}),
      ...(paid > 0 ? this.paymentBox.withBox({ paidAmount: paid }) : {}),
      // Stage 21: only while VAT applies; the amount only when the user typed the supplier's printed one.
      ...(this.vatContext() ? { vatRegistered: this.vatRegistered(), ...(this.vatRegistered() && this.vatOverride() !== null ? { vatAmount: this.vatOverride() as number } : {}) } : {}),
      // The VAT this form shows; the server answers 409 VAT_CHANGED when its VAT settings now give another figure.
      expectedVat: this.vatAmount(),
    };
    this.vatChanged.set(null);
    this.service.create(payload).subscribe({
      next: (created) => {
        this.busy.set(false);
        this.router.navigate(['/purchases', created._id], { queryParams: created.pvNumber ? { pv: created.pvNumber } : {} });
      },
      error: (response) => {
        this.busy.set(false);
        const code = response?.error?.code;
        if (response?.status === 409 && code === 'VAT_CHANGED') {
          // Take the server's settings; the form recomputes its VAT and the user reviews it before saving again.
          this.vatSettings.applyServerVat(response.error.vat);
          this.vatChanged.set({ expected: Number(response.error.expected ?? payload.expectedVat ?? 0), current: this.vatAmount() });
          return;
        }
        const known = ['INSUFFICIENT_BALANCE', 'NO_OPEN_SHIFT', 'BOX_INACTIVE', 'PAY_NOT_ALLOWED', 'PAID_EXCEEDS_TOTAL', 'BOX_NOT_ALLOWED', 'SUPPLIER_INACTIVE', 'PRODUCT_ARCHIVED'];
        this.error.set(known.includes(code) ? `purchases.errors.${code}` : 'purchases.errors.saveFailed');
      },
    });
  }
}
