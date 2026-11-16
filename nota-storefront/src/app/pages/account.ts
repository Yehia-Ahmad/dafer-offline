import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ApiError, ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { money } from '../core/format';
import { AR } from '../core/i18n/ar';
import { Address, OrderView, Zone } from '../core/models';
import { SeoService } from '../core/seo.service';

/** /account: the shell with tabs; sign-in required (client-rendered, noindex). */
@Component({
  selector: 'app-account',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap page narrow">
      <div class="row between">
        <h1 class="h1">{{ t.account.title }}</h1>
        <button type="button" class="btn outline" (click)="logout()">{{ t.auth.logout }}</button>
      </div>
      @if (!auth.ready()) {
        <p class="empty" role="status">{{ t.loading }}</p>
      } @else if (!auth.signedIn()) {
        <div class="empty card"><a class="btn" routerLink="/login">{{ t.auth.login }}</a></div>
      } @else {
        <nav class="row" [attr.aria-label]="t.account.title">
          <a class="btn outline" routerLink="/account" routerLinkActive="act" [routerLinkActiveOptions]="{ exact: true }">{{ t.account.orders }}</a>
          <a class="btn outline" routerLink="/account/addresses" routerLinkActive="act">{{ t.account.addresses }}</a>
          <a class="btn outline" routerLink="/account/profile" routerLinkActive="act">{{ t.account.profile }}</a>
        </nav>
        <router-outlet />
      }
    </div>
  `,
  styles: ['.act { background: var(--brand-tint); border-color: var(--brand); border-width: 2px; }'],
})
export class AccountPage {
  protected readonly t = AR;
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  constructor() { inject(SeoService).set({ title: AR.account.title, path: '/account', noindex: true }); }
  protected logout(): void { this.auth.logout(); void this.router.navigateByUrl('/'); }
}

@Component({
  selector: 'app-account-orders',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loading()) { <p class="empty" role="status">{{ t.loading }}</p> }
    @else if (!orders().length) { <p class="empty card">{{ t.account.noOrders }}</p> }
    @else {
      <ul class="stack" style="list-style:none;padding:0;margin:0">
        @for (o of orders(); track o.id) {
          <li><a class="card" [routerLink]="['/account/orders', o.id]" style="color:inherit">
            <span class="row between"><strong class="num">{{ t.account.order(o.number) }}</strong><span class="num">{{ fmt(o.total) }}</span></span>
            <span class="muted">{{ status(o.status) }}</span>
          </a></li>
        }
      </ul>
      @if (hasMore()) { <button type="button" class="btn outline" (click)="more()">{{ t.account.more }}</button> }
    }
  `,
})
export class AccountOrdersPage {
  protected readonly t = AR;
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  protected readonly orders = signal<OrderView[]>([]);
  protected readonly loading = signal(true);
  protected readonly hasMore = signal(false);
  private page = 1;
  protected fmt = money;
  protected status(s: string): string { return AR.order.statuses[s] ?? s; }

  constructor() {
    effect(() => { if (this.auth.signedIn()) void this.load(); });
  }

  private async load(): Promise<void> {
    try {
      const r = await this.api.myOrders(1);
      this.orders.set(r.data); this.hasMore.set(r.pagination.hasNextPage); this.page = 1;
    } finally { this.loading.set(false); }
  }
  protected async more(): Promise<void> {
    const r = await this.api.myOrders(this.page + 1);
    this.page += 1; this.orders.update((rows) => [...rows, ...r.data]); this.hasMore.set(r.pagination.hasNextPage);
  }
}

@Component({
  selector: 'app-account-order',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a routerLink="/account">← {{ t.account.back }}</a>
    @if (order(); as o) {
      <section class="card">
        <div class="row between"><h2 style="font-size:20px" class="num">{{ t.account.order(o.number) }}</h2><strong>{{ st(o.status) }}</strong></div>
        @for (i of o.items ?? []; track i.productId) { <div class="row between"><span>{{ i.name }} <span class="muted num">× {{ i.qty }}</span></span><span class="num">{{ fmt(i.lineTotal) }}</span></div> }
        <div class="row between"><span>{{ t.order.deliveryFee }}</span><span class="num">{{ fmt(o.deliveryFee) }}</span></div>
        <div class="row between" style="font-weight:800;font-size:18px"><span>{{ t.order.total }}</span><span class="num">{{ fmt(o.total) }}</span></div>
        @if (o.statusHistory?.length) {
          <h3 style="font-size:15px">{{ t.order.history }}</h3>
          <ul style="margin:0;padding-inline-start:20px">@for (h of o.statusHistory; track h.at) { <li>{{ st(h.status) }} <span class="muted num">{{ h.at.slice(0, 16).replace('T', ' ') }}</span></li> }</ul>
        }
        @if (o.status === 'new') { <button type="button" class="btn outline" (click)="cancel()">{{ t.account.cancel }}</button> }
        @if (message()) { <p class="alert" role="alert">{{ message() }}</p> }
      </section>
    } @else if (!loading()) { <p class="empty card">{{ t.order.notFound }}</p> }
  `,
})
export class AccountOrderPage {
  protected readonly t = AR;
  protected st(s: string): string { return AR.order.statuses[s] || s; }
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  readonly id = input.required<string>();
  protected readonly order = signal<OrderView | null>(null);
  protected readonly loading = signal(true);
  protected readonly message = signal('');
  protected fmt = money;

  constructor() {
    effect(() => { if (this.auth.signedIn()) void this.load(); });
  }
  private async load(): Promise<void> {
    try { this.order.set(await this.api.myOrder(this.id())); } catch { this.order.set(null); } finally { this.loading.set(false); }
  }
  protected async cancel(): Promise<void> {
    if (typeof confirm !== 'undefined' && !confirm(AR.account.cancelConfirm)) return;
    try { this.order.set(await this.api.cancelOrder(this.id())); this.message.set(''); }
    catch (error) { this.message.set(AR.account.cancelErrors[error instanceof ApiError ? error.code : 'default'] || AR.account.cancelErrors['default']); }
  }
}

@Component({
  selector: 'app-account-addresses',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (a of addresses(); track a.id) {
      <section class="card">
        <strong>{{ a.label || t.account.address }}</strong>
        <span>{{ a.address }}</span>
        <div class="row"><button type="button" class="btn outline" (click)="edit(a)">{{ t.account.edit }}</button><button type="button" class="btn outline" (click)="remove(a)">{{ t.account.delete }}</button></div>
      </section>
    } @empty { <p class="empty card">{{ t.account.noAddresses }}</p> }
    <form class="card" (ngSubmit)="save()" novalidate>
      <h2 style="font-size:18px">{{ t.account.addAddress }}</h2>
      <label class="lb">{{ t.account.label }}<input class="in" name="label" [(ngModel)]="label" /></label>
      <label class="lb">{{ t.checkout.zone }}
        <select class="in" name="zone" [(ngModel)]="zoneId"><option value="">{{ t.checkout.chooseZone }}</option>@for (z of zones(); track z.id) { <option [value]="z.id">{{ z.name }}</option> }</select>
      </label>
      <label class="lb">{{ t.account.address }} *<input class="in" name="address" [(ngModel)]="address" /></label>
      @if (error()) { <p class="alert" role="alert">{{ error() }}</p> }
      <button type="submit" class="btn" [disabled]="busy()">{{ t.account.save }}</button>
    </form>
  `,
})
export class AccountAddressesPage {
  protected readonly t = AR;
  private readonly api = inject(ApiService);
  protected readonly auth = inject(AuthService);
  protected readonly addresses = computed<Address[]>(() => this.auth.customer()?.addresses ?? []);
  protected readonly zones = signal<Zone[]>([]);
  protected label = ''; protected zoneId = ''; protected address = '';
  private editing: string | null = null;
  protected readonly error = signal('');
  protected readonly busy = signal(false);

  constructor() { void this.api.zones().then((r) => this.zones.set(r.data)).catch(() => undefined); }

  protected edit(a: Address): void { this.editing = a.id; this.label = a.label; this.zoneId = a.zoneId ?? ''; this.address = a.address; }
  protected async remove(a: Address): Promise<void> { try { await this.api.deleteAddress(a.id); await this.auth.refresh(); } catch { this.error.set(AR.checkout.errors['default']); } }
  protected async save(): Promise<void> {
    if (!this.address.trim()) { this.error.set(AR.checkout.required); return; }
    this.busy.set(true); this.error.set('');
    const body = { label: this.label.trim(), zoneId: this.zoneId || null, address: this.address.trim(), notes: '' };
    try {
      if (this.editing) await this.api.updateAddress(this.editing, body); else await this.api.addAddress(body);
      await this.auth.refresh();
      this.editing = null; this.label = ''; this.zoneId = ''; this.address = '';
    } catch (error) { this.error.set(error instanceof ApiError && error.message ? error.message : AR.checkout.errors['default']); }
    finally { this.busy.set(false); }
  }
}

@Component({
  selector: 'app-account-profile',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="card" (ngSubmit)="save()" novalidate>
      <label class="lb">{{ t.auth.name }}<input class="in" name="name" [(ngModel)]="name" /></label>
      <label class="lb">{{ t.auth.phone }}<input class="in ltr" name="phone" [ngModel]="auth.customer()?.phone" disabled /></label>
      <label class="lb">{{ t.account.newPassword }}<input class="in ltr" name="pw" type="password" autocomplete="new-password" [(ngModel)]="password" /><span class="muted" style="font-size:12px">{{ t.auth.passwordHint }}</span></label>
      @if (message()) { <p class="note" role="status">{{ message() }}</p> }
      <button type="submit" class="btn" [disabled]="busy()">{{ t.account.save }}</button>
    </form>
  `,
})
export class AccountProfilePage {
  protected readonly t = AR;
  private readonly api = inject(ApiService);
  protected readonly auth = inject(AuthService);
  protected name = this.auth.customer()?.name ?? '';
  protected password = '';
  protected readonly message = signal('');
  protected readonly busy = signal(false);

  protected async save(): Promise<void> {
    this.busy.set(true);
    try {
      const body: { name?: string; newPassword?: string } = { name: this.name.trim() };
      if (this.password) body.newPassword = this.password;
      const result = await this.api.updateMe(body);
      if (result.token) { const { storage } = await import('../core/storage'); storage.set((await import('../core/api.service')).TOKEN_KEY, result.token); }
      await this.auth.refresh();
      this.password = ''; this.message.set(AR.account.saved);
    } catch (error) { this.message.set(error instanceof ApiError && error.message ? error.message : AR.auth.errors['default']); }
    finally { this.busy.set(false); }
  }
}
