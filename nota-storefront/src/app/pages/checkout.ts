import { ChangeDetectionStrategy, Component, afterNextRender, computed, effect, inject, signal, untracked } from '@angular/core';
import { PixelsService } from '../core/pixels.service';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { CartService } from '../core/cart.service';
import { CheckoutForm, FormErrors, orderRequest, quoteRequest, validateCheckout } from '../core/checkout-form';
import { CheckoutFailure, CheckoutService, mapFailure } from '../core/checkout.service';
import { money } from '../core/format';
import { AR } from '../core/i18n/ar';
import { Fulfillment, PaymentMethod, Quote, Zone } from '../core/models';
import { SeoService } from '../core/seo.service';
import { SettingsStore } from '../core/settings.store';
import { CartLinesComponent } from '../ui/cart-lines';

const METHODS: PaymentMethod[] = ['cod', 'instapay', 'vodafone_cash'];

@Component({
  selector: 'app-checkout',
  imports: [FormsModule, RouterLink, CartLinesComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap page" style="gap:20px;padding-top:28px">
      <h1 class="h1">{{ t.checkout.title }}</h1>
      @if (cart.isEmpty()) {
        <div class="empty card"><strong>{{ t.cart.empty }}</strong><a class="btn" routerLink="/">{{ t.cart.continue }}</a></div>
      } @else {
        @if (!settings.orderingOn()) { <p class="alert" role="alert">{{ t.orderingOff }}</p> }
        <form class="cols" (ngSubmit)="submit()" novalidate>
          <div class="form">
            <section class="card" aria-labelledby="s1">
              <h2 id="s1"><span class="step" aria-hidden="true">١</span>{{ t.checkout.step1 }}</h2>
              @if (!auth.signedIn() && auth.ready()) { <p class="muted small"><a routerLink="/login">{{ t.auth.login }}</a> · <a routerLink="/register">{{ t.auth.register }}</a></p> }
              <div class="fields">
                <label class="lb">{{ t.checkout.name }} *
                  <input class="in" name="name" autocomplete="name" [ngModel]="form().name" (ngModelChange)="set('name', $event)" [attr.aria-invalid]="errors().name ? 'true' : null" [attr.aria-describedby]="errors().name ? 'e-name' : null" />
                  @if (errors().name) { <span class="err" id="e-name">{{ errors().name }}</span> }
                </label>
                <label class="lb">{{ t.checkout.phone }} *
                  <input class="in ltr" name="phone" type="tel" inputmode="tel" autocomplete="tel" [ngModel]="form().phone" (ngModelChange)="set('phone', $event)" [attr.aria-invalid]="errors().phone ? 'true' : null" [attr.aria-describedby]="errors().phone ? 'e-phone' : null" />
                  @if (errors().phone) { <span class="err" id="e-phone">{{ errors().phone }}</span> }
                </label>
              </div>
            </section>

            <section class="card" aria-labelledby="s2">
              <h2 id="s2"><span class="step" aria-hidden="true">٢</span>{{ t.checkout.step2 }}</h2>
              @if (fulfillments().length > 1) {
                <div class="stack" role="radiogroup" [attr.aria-label]="t.checkout.step2">
                  @if (settings.settings()?.fulfillment?.delivery) {
                    <label class="opt"><input type="radio" name="fulfillment" value="delivery" [ngModel]="form().fulfillment" (ngModelChange)="set('fulfillment', $event)" /><span><strong>{{ t.checkout.delivery }}</strong><br /><span class="sub">{{ t.checkout.deliverySub }}</span></span></label>
                  }
                  @if (settings.settings()?.fulfillment?.pickup) {
                    <label class="opt"><input type="radio" name="fulfillment" value="pickup" [ngModel]="form().fulfillment" (ngModelChange)="set('fulfillment', $event)" /><span><strong>{{ t.checkout.pickup }}</strong><br /><span class="sub">{{ t.checkout.pickupSub(settings.settings()?.shop?.address || '') }}</span></span></label>
                  }
                </div>
              }
              @if (form().fulfillment === 'delivery') {
                @if (auth.signedIn() && auth.customer()!.addresses.length) {
                  <label class="lb">{{ t.checkout.savedAddress }}
                    <select class="in" name="addressId" [ngModel]="form().addressId" (ngModelChange)="pickAddress($event)">
                      <option value="">{{ t.checkout.newAddress }}</option>
                      @for (a of auth.customer()!.addresses; track a.id) { <option [value]="a.id">{{ a.label || a.address }}</option> }
                    </select>
                  </label>
                }
                <label class="lb">{{ t.checkout.zone }} *
                  <select class="in" name="zone" [ngModel]="form().zoneId" (ngModelChange)="set('zoneId', $event)" [attr.aria-invalid]="errors().zone ? 'true' : null">
                    <option value="">{{ t.checkout.chooseZone }}</option>
                    @for (z of zones(); track z.id) { <option [value]="z.id">{{ t.checkout.zoneOption(z.name, fmt(z.fee)) }}</option> }
                  </select>
                  @if (errors().zone) { <span class="err">{{ errors().zone }}</span> }
                </label>
                @if (!form().addressId) {
                  <div class="fields">
                    <label class="lb">{{ t.checkout.street }} *
                      <input class="in" name="address" autocomplete="street-address" [ngModel]="form().address" (ngModelChange)="set('address', $event)" [attr.aria-invalid]="errors().address ? 'true' : null" />
                      @if (errors().address) { <span class="err">{{ errors().address }}</span> }
                    </label>
                    <label class="lb">{{ t.checkout.landmark }}
                      <input class="in" name="landmark" [ngModel]="form().landmark" (ngModelChange)="set('landmark', $event)" />
                    </label>
                  </div>
                  @if (auth.signedIn()) { <label class="row"><input type="checkbox" name="save" [ngModel]="saveAddress()" (ngModelChange)="saveAddress.set($event)" /> {{ t.checkout.saveAddress }}</label> }
                }
              }
            </section>

            <section class="card" aria-labelledby="s3">
              <h2 id="s3"><span class="step" aria-hidden="true">٣</span>{{ t.checkout.step3 }}</h2>
              <div class="stack" role="radiogroup" [attr.aria-label]="t.checkout.step3">
                @for (m of methods(); track m) {
                  <label class="opt"><input type="radio" name="payment" [value]="m" [ngModel]="form().paymentMethod" (ngModelChange)="set('paymentMethod', $event)" />
                    <span><strong>{{ label(m) }}</strong>@if (m !== 'cod') { <br /><span class="sub">{{ t.checkout.walletSub }}</span> }</span></label>
                }
              </div>
              <label class="lb">{{ t.checkout.notes }} ({{ t.checkout.notesHint }})
                <textarea class="in" name="notes" maxlength="500" [ngModel]="form().notes" (ngModelChange)="set('notes', $event)"></textarea>
              </label>
              @if (heardOptions().length) {
                <label class="lb">{{ t.checkout.heardFrom }} ({{ t.checkout.notesHint }})
                  <select class="in" name="heardFrom" [ngModel]="form().heardFrom ?? ''" (ngModelChange)="set('heardFrom', $event)">
                    <option value="">{{ t.checkout.heardFromNone }}</option>
                    @for (o of heardOptions(); track o) { <option [value]="o">{{ o }}</option> }
                  </select>
                </label>
              }
              @if (settings.settings()?.orderNote; as n) { <p class="note">{{ n }}</p> }
            </section>
          </div>

          <aside class="card summary" aria-labelledby="sum">
            <h2 id="sum" style="font-size:18px">{{ t.checkout.summary }}</h2>
            <app-cart-lines [editable]="false" />
            <div class="rows" aria-live="polite">
              <div class="r"><span>{{ t.checkout.items }}</span><span class="num">{{ fmt(quote()?.subtotal ?? cart.subtotal()) }}</span></div>
              @if (quote(); as q) {
                <div class="r"><span>{{ q.zone ? t.checkout.deliveryFeeZone(q.zone.name) : t.checkout.deliveryFee }}</span><span class="num">{{ q.deliveryFee > 0 ? fmt(q.deliveryFee) : t.checkout.deliveryFree }}</span></div>
                @if (q.vat > 0) { <div class="r"><span>{{ t.checkout.vat }}</span><span class="num">{{ fmt(q.vat) }}</span></div> }
                <div class="r total"><span>{{ t.checkout.total }}</span><span class="num">{{ fmt(q.total) }}</span></div>
              } @else if (quoting()) {
                <div class="r muted"><span>{{ t.checkout.pricing }}</span></div>
              }
            </div>
            @if (hint(); as h) { <p class="note small">{{ h }}</p> }
            @if (failure(); as f) {
              <p class="alert" role="alert">{{ f.message }}@if (f.minOrderAmount) { <br />{{ t.checkout.minOrder(fmt(f.minOrderAmount)) }} }</p>
            }
            @if (errors().items) { <p class="alert" role="alert">{{ errors().items }}</p> }
            <button type="submit" class="btn big block" [disabled]="!canSubmit()">{{ placing() ? t.checkout.confirming : t.checkout.confirm }}</button>
            <p class="muted small center">{{ t.checkout.reassure }}</p>
          </aside>
        </form>
      }
    </div>
  `,
  styles: [`
    .cols { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
    .form { flex: 999 1 520px; display: flex; flex-direction: column; gap: 20px; min-width: 0; }
    .summary { flex: 1 1 340px; }
    .small { font-size: 13px; }
    .rows { display: flex; flex-direction: column; gap: 8px; color: var(--text-body); }
    .r { display: flex; justify-content: space-between; gap: 12px; }
    .r.total { border-top: 1px solid var(--border); padding-top: 12px; font-size: 20px; font-weight: 800; color: var(--text); }
  `],
})
export class CheckoutPage {
  protected readonly t = AR;
  protected readonly cart = inject(CartService);
  protected readonly auth = inject(AuthService);
  protected readonly settings = inject(SettingsStore);
  private readonly api = inject(ApiService);
  private readonly checkout = inject(CheckoutService);
  private readonly router = inject(Router);
  private readonly pixels = inject(PixelsService);
  protected fmt = money;

  protected readonly form = signal<CheckoutForm>({ name: '', phone: '', fulfillment: 'delivery', zoneId: '', address: '', landmark: '', notes: '', addressId: '', paymentMethod: 'cod' });
  protected readonly zones = signal<Zone[]>([]);
  protected readonly quote = signal<Quote | null>(null);
  protected readonly quoting = signal(false);
  protected readonly failure = signal<CheckoutFailure | null>(null);
  protected readonly errors = signal<FormErrors>({});
  protected readonly placing = signal(false);
  protected readonly saveAddress = signal(false);

  protected readonly fulfillments = computed<Fulfillment[]>(() => {
    const f = this.settings.settings()?.fulfillment ?? { delivery: true, pickup: false };
    return [...(f.delivery ? ['delivery' as const] : []), ...(f.pickup ? ['pickup' as const] : [])];
  });
  protected readonly methods = computed(() => METHODS.filter((m) => (this.settings.settings()?.paymentMethods ?? ['cod']).includes(m)));
  protected readonly hint = computed(() => {
    const s = this.settings.settings();
    if (!s) return '';
    const q = this.quote();
    if (s.minOrderAmount && (q?.subtotal ?? this.cart.subtotal()) < s.minOrderAmount) return AR.checkout.minOrder(money(s.minOrderAmount));
    if (s.freeDeliveryFrom && this.form().fulfillment === 'delivery' && (q?.deliveryFee ?? 1) > 0) return AR.checkout.freeFrom(money(s.freeDeliveryFrom));
    return '';
  });
  protected readonly heardOptions = computed(() => this.settings.settings()?.marketing?.heardFromOptions ?? []);
  protected readonly canSubmit = computed(() => this.settings.orderingOn() && !this.placing() && !this.cart.isEmpty());

  private timer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;

  constructor() {
    inject(SeoService).set({ title: AR.checkout.title, path: '/checkout', noindex: true });
    void this.api.zones().then((r) => this.zones.set(r.data)).catch(() => this.zones.set([]));

    // Online Stage 7A: InitiateCheckout once per visit to this page (ids, quantities and the cart value only).
    afterNextRender(() => {
      const lines = this.cart.lines();
      if (lines.length) this.pixels.track({ name: 'InitiateCheckout', lines: lines.map((l) => ({ id: l.productId, qty: l.qty, price: l.price })), value: this.cart.subtotal() });
    });

    // The checkout only offers what the shop enabled.
    effect(() => {
      const options = this.fulfillments();
      const methods = this.methods();
      untracked(() => {
        const f = this.form();
        const patch: Partial<CheckoutForm> = {};
        if (options.length && !options.includes(f.fulfillment)) patch.fulfillment = options[0];
        if (methods.length && !methods.includes(f.paymentMethod)) patch.paymentMethod = methods[0];
        if (Object.keys(patch).length) this.form.set({ ...f, ...patch });
      });
    });

    // A signed-in customer starts with their details.
    effect(() => {
      const customer = this.auth.customer();
      if (!customer) return;
      untracked(() => {
        const f = this.form();
        this.form.set({ ...f, name: f.name || customer.name, phone: f.phone || customer.phone });
      });
    });

    // The summary is priced by the server whenever what it depends on changes (debounced).
    effect(() => {
      const f = this.form();
      const lines = this.cart.lines();
      const signedIn = this.auth.signedIn();
      clearTimeout(this.timer);
      if (!lines.length || (f.fulfillment === 'delivery' && !f.zoneId && !(signedIn && f.addressId))) { this.quote.set(null); return; }
      this.timer = setTimeout(() => void this.price(), 350);
    });
  }

  protected label(m: PaymentMethod): string { return m === 'cod' ? AR.checkout.cod : m === 'instapay' ? AR.checkout.instapay : AR.checkout.vodafone_cash; }

  protected set<K extends keyof CheckoutForm>(key: K, value: CheckoutForm[K]): void {
    this.form.update((f) => ({ ...f, [key]: value }));
    if (key in this.errors()) this.errors.update((e) => { const { [key as keyof FormErrors]: _g, ...rest } = e; return rest; });
    this.failure.set(null);
  }

  protected pickAddress(id: string): void {
    const saved = this.auth.addressById(id);
    this.form.update((f) => ({ ...f, addressId: id, ...(saved?.zoneId ? { zoneId: saved.zoneId } : {}) }));
  }

  private async price(): Promise<void> {
    const seq = ++this.seq;
    const signedIn = this.auth.signedIn();
    this.quoting.set(true);
    try {
      const result = await this.checkout.quote(quoteRequest(this.form(), this.cart.requestItems(), signedIn), signedIn);
      if (seq !== this.seq) return;
      this.quote.set(result);
      this.failure.set(null);
      this.cart.setProblems([]);
      this.cart.refreshDisplay(result.items);
    } catch (error) {
      if (seq !== this.seq) return;
      this.quote.set(null);
      this.showFailure(error);
    } finally {
      if (seq === this.seq) this.quoting.set(false);
    }
  }

  private showFailure(error: unknown): void {
    const failure = mapFailure(error);
    this.cart.setProblems(failure.lines);
    this.failure.set(failure.lines.length ? null : failure);
  }

  protected async submit(): Promise<void> {
    if (this.placing()) return; // a double click never sends twice (the key is also reused, so a retry cannot create a second order)
    const signedIn = this.auth.signedIn();
    const errors = validateCheckout(this.form(), { signedIn, itemCount: this.cart.lines().length });
    this.errors.set(errors);
    if (Object.keys(errors).length) return;
    this.placing.set(true);
    this.failure.set(null);
    try {
      const order = await this.checkout.place(orderRequest(this.form(), this.cart.requestItems(), signedIn), signedIn);
      const f = this.form();
      if (signedIn && this.saveAddress() && !f.addressId && f.fulfillment === 'delivery') {
        void this.api.addAddress({ label: '', zoneId: f.zoneId, address: f.address, notes: '' }).then(() => this.auth.refresh()).catch(() => undefined);
      }
      // Online Stage 7A: Purchase once per placed order (value = the order total, event id = the order number). No contact data.
      this.pixels.trackPurchase({
        name: 'Purchase',
        orderNumber: order.number,
        value: order.total,
        lines: (order.items ?? this.cart.lines().map((l) => ({ productId: l.productId, qty: l.qty, unitPrice: l.price }))).map((i) => ({ id: i.productId, qty: i.qty, price: i.unitPrice })),
      });
      this.cart.clear();
      await this.router.navigate(['/order', order.trackingToken]);
    } catch (error) {
      this.showFailure(error);
      this.placing.set(false);
    }
  }
}
