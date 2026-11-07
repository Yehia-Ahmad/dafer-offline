import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { flushPaymentBoxes } from './modules/cashbox/testing/payment-boxes.testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../environments/environment';
import { AuthService } from './core/auth/auth.service';
import { CartRescueService } from './core/auth/cart-rescue.service';
import { isOverDiscountLimit } from './core/auth/discount-limit';
import { FAKE_CATALOG, fakeUser } from './core/auth/testing/auth-fixtures';
import { signInAs, signInWith } from './core/auth/testing/sign-in';
import { ToastService } from './core/auth/toast.service';
import { OtherMainPc } from './core/runtime/runtime-config';
import { UnsavedWorkService } from './core/unsaved-work/unsaved-work.service';
import { LoginPageComponent } from './modules/auth/login-page/login-page.component';
import { CreditSalesComponent } from './modules/products/components/credit-sales/credit-sales.component';
import { PosSnapshot, SellingComponent } from './modules/products/components/selling/selling.component';
import { ShopProfileComponent } from './modules/shop-profile/components/shop-profile/shop-profile.component';
import { UserFormDialogComponent } from './modules/users/user-form-dialog/user-form-dialog.component';
import { OtherMainBannerComponent } from './offline/other-main-banner.component';
import { provideFakeVat } from './modules/shop-profile/services/vat-settings.testing';

/** Stage 15 screens: max discount (POS, credit, user form), cart restore, security card, restore notice, other main PC banner. */
const base = environment.api_base_url;
const providers = () => [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(), provideFakeVat()];
const product = { id: 'p1', name: 'لمبة', displayLabel: 'لمبة', categoryName: 'لمبات', wholesalePrice: 100, retailPrice: 120, inventoryCount: 9 } as never;

describe('Stage 15: discount limit helper', () => {
  it('blocks above the limit with a 0.01 tolerance; no limit never blocks', () => {
    expect(isOverDiscountLimit(10, 100, 10)).toBeFalse();
    expect(isOverDiscountLimit(10.001, 100, 10)).toBeFalse();
    expect(isOverDiscountLimit(15, 100, 10)).toBeTrue();
    expect(isOverDiscountLimit(5, 0, 10)).toBeTrue();
    expect(isOverDiscountLimit(0, 0, 10)).toBeFalse();
    expect(isOverDiscountLimit(90, 100, null)).toBeFalse();
  });
});

describe('Stage 15: POS max discount and cart restore', () => {
  let fixture: ComponentFixture<SellingComponent>;
  let component: SellingComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;

  const create = async (setup: () => void) => {
    await TestBed.configureTestingModule({ imports: [SellingComponent, TranslateModule.forRoot()], providers: providers() }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    setup();
    fixture = TestBed.createComponent(SellingComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  };
  afterEach(() => (flushPaymentBoxes(http), http.verify()));

  it('a manager with a 10% limit sees "أقصى خصم: 10٪"; 15% is blocked before sending', async () => {
    await create(() => signInAs('manager', { maxDiscountPercent: 10 }));
    component.addProductToInvoice(product);
    component.sellingForm.patchValue({ customerName: 'عميل', discountAmount: 10 });
    fixture.detectChanges();
    expect(el().querySelector('[data-testid="discount-limit"]')!.textContent).toContain('session.discount.limitHintShort');
    expect(component.discountOverLimit).toBeFalse();

    component.sellingForm.patchValue({ discountAmount: 15 });
    fixture.detectChanges();
    expect(component.discountOverLimit).toBeTrue();
    expect(el().querySelector('#posDiscount')?.closest('nota-form-field')?.textContent).toContain('session.discount.overLimit');
    expect((el().querySelector('.pos__pay') as HTMLButtonElement).disabled).toBeTrue();
    component.saveSelling();
    http.expectNone(`${base}sellings`);

    component.sellingForm.patchValue({ discountAmount: 10 });
    component.saveSelling();
    http.expectOne(`${base}sellings`);
  });

  it('no limit (and the owner) shows no hint and never blocks', async () => {
    await create(() => signInAs('owner', { maxDiscountPercent: 5 }));
    component.addProductToInvoice(product);
    component.sellingForm.patchValue({ discountAmount: 50 });
    fixture.detectChanges();
    expect(el().querySelector('[data-testid="discount-limit"]')).toBeNull();
    expect(component.discountOverLimit).toBeFalse();
  });

  it('an open cart counts as unsaved work', async () => {
    await create(() => signInAs('cashier'));
    const unsaved = TestBed.inject(UnsavedWorkService);
    expect(unsaved.hasUnsavedWork()).toBeFalse();
    component.addProductToInvoice(product);
    expect(unsaved.hasUnsavedWork()).toBeTrue();
  });

  it('after the session expired, the same user gets the open invoice back with a toast', async () => {
    const saved: PosSnapshot = {
      customerName: 'م. سامي', customerPhone: '0100', customerSearch: 'م. سامي', discountAmount: 5, shippingFees: 0,
      lines: [{ product, priceType: 'retailPrice', price: 120, quantity: 3 }],
    };
    await create(() => {
      signInAs('cashier');
      const rescue = TestBed.inject(CartRescueService);
      const off = rescue.register(() => saved);
      rescue.capture('id-cashier');
      off();
    });
    expect(component.invoiceItemStates[0].selectedProduct?.id).toBe('p1');
    expect(Number(component.getInvoiceItem(0).getRawValue().quantity)).toBe(3);
    expect(Number(component.getInvoiceItem(0).getRawValue().price)).toBe(120);
    expect(component.sellingForm.getRawValue().customerName).toBe('م. سامي');
    expect(component.invoiceDiscountAmount).toBe(5);
    expect(TestBed.inject(ToastService).toasts().map((t) => t.text)).toContain('session.cartRestored');
  });

  it('another user signing in gets an empty POS', async () => {
    await create(() => {
      signInAs('manager');
      const rescue = TestBed.inject(CartRescueService);
      const off = rescue.register(() => ({ customerName: 'x', customerPhone: '', customerSearch: '', discountAmount: 0, shippingFees: 0, lines: [{ product, priceType: 'wholesalePrice', price: 100, quantity: 1 }] }));
      rescue.capture('id-cashier');
      off();
    });
    expect(component.hasOpenCart()).toBeFalse();
    expect(TestBed.inject(ToastService).toasts().length).toBe(0);
    expect(TestBed.inject(CartRescueService).hasSaved()).toBeFalse();
  });
});

describe('Stage 15: new credit sale max discount', () => {
  let fixture: ComponentFixture<CreditSalesComponent>;
  let component: CreditSalesComponent;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [CreditSalesComponent, TranslateModule.forRoot()], providers: providers() }).compileComponents();
    signInAs('manager', { maxDiscountPercent: 10 });
    fixture = TestBed.createComponent(CreditSalesComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('shows the limit and blocks review above it', () => {
    component.itemsSubtotal = 200;
    component.discountAmount = 30;
    fixture.detectChanges();
    expect(el().querySelector('[data-testid="discount-limit"]')!.textContent).toContain('session.discount.limitHintShort');
    expect(component.discountOverLimit).toBeTrue();
    expect((el().querySelector('.cs__primary') as HTMLButtonElement).disabled).toBeTrue();
    component.discountAmount = 20;
    expect(component.discountOverLimit).toBeFalse();
  });

  it('a started credit sale counts as unsaved work', () => {
    expect(TestBed.inject(UnsavedWorkService).hasUnsavedWork()).toBeFalse();
    component.creditSaleForm.get('customerName')!.setValue('عميل');
    component.creditSaleForm.markAsDirty();
    expect(TestBed.inject(UnsavedWorkService).hasUnsavedWork()).toBeTrue();
  });
});

describe('Stage 15: user form max discount', () => {
  let fixture: ComponentFixture<UserFormDialogComponent>;
  let component: UserFormDialogComponent;
  let http: HttpTestingController;

  const open = async (user: ReturnType<typeof fakeUser> | null) => {
    await TestBed.configureTestingModule({
      imports: [UserFormDialogComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    signInAs('owner');
    fixture = TestBed.createComponent(UserFormDialogComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('catalog', FAKE_CATALOG);
    fixture.componentRef.setInput('user', user);
    component.open.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  afterEach(() => {
    (flushPaymentBoxes(http), http.verify());
    fixture?.destroy();
  });

  it('shows only with sales.discount; a new manager with 10 sends maxDiscountPercent: 10', async () => {
    await open(null);
    expect(component.showMaxDiscount()).toBeFalse(); // cashier template: no discount
    expect(document.body.querySelector('[data-testid="max-discount"]')).toBeNull();
    component.chooseRole('manager');
    fixture.detectChanges();
    expect(document.body.querySelector('[data-testid="max-discount"]')).not.toBeNull();
    component.name.set('منى');
    component.username.set('mona');
    component.password.set('pass-1234');
    component.confirm.set('pass-1234');
    component.maxDiscount.set('10');
    expect(component.buildPayload()).toEqual({ name: 'منى', username: 'mona', password: 'pass-1234', role: 'manager', maxDiscountPercent: 10 });
  });

  it('edit: unchanged limit is not sent; cleared → null; out of range → field error', async () => {
    await open(fakeUser('manager', { maxDiscountPercent: 10 }));
    expect(component.maxDiscount()).toBe('10');
    expect(component.buildPayload()).toEqual({ name: 'منى', role: 'manager' });
    component.maxDiscount.set('');
    expect(component.buildPayload()).toEqual({ name: 'منى', role: 'manager', maxDiscountPercent: null });
    component.maxDiscount.set('١٥');
    expect(component.buildPayload()).toEqual({ name: 'منى', role: 'manager', maxDiscountPercent: 15 });
    component.maxDiscount.set('150');
    component.submit();
    expect(component.errors().maxDiscount).toBe('session.discount.limitInvalid');
    http.expectNone(() => true);
  });

  it('the open form with changes is dirty (unsaved work)', async () => {
    await open(null);
    expect(component.isDirty()).toBeFalse();
    component.name.set('x');
    expect(component.isDirty()).toBeTrue();
  });
});

describe('Stage 15: shop profile security card', () => {
  it('shows the auto-lock choice; the chosen value is saved and read back', async () => {
    await TestBed.configureTestingModule({ imports: [ShopProfileComponent, TranslateModule.forRoot()], providers: providers() }).compileComponents();
    signInAs('owner');
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ShopProfileComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url.endsWith('shop-profile')).flush({ name: 'النور', address: '', phones: [], logo: null, taxNumber: '', commercialRegister: '', invoiceFooter: '', autoLockMinutes: 15 });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="security-card"]')!.textContent).toContain('session.security.title');
    const select = el.querySelector('#sp-autolock') as HTMLSelectElement;
    expect(select.options.length).toBe(6);
    const component = fixture.componentInstance as unknown as { form: { controls: { autoLockMinutes: { value: number; setValue(v: number): void; markAsDirty(): void } } }; save(): void };
    expect(component.form.controls.autoLockMinutes.value).toBe(15);

    component.form.controls.autoLockMinutes.setValue(0);
    component.form.controls.autoLockMinutes.markAsDirty();
    expect(TestBed.inject(UnsavedWorkService).hasUnsavedWork()).toBeTrue();
    component.save();
    const put = http.expectOne((r) => r.method === 'PUT');
    expect(put.request.body.autoLockMinutes).toBe(0);
    put.flush({ ...put.request.body });
    expect(component.form.controls.autoLockMinutes.value).toBe(0);
    expect(TestBed.inject(UnsavedWorkService).hasUnsavedWork()).toBeFalse();
    (flushPaymentBoxes(http), http.verify());
  });
});

describe('Stage 15: login after a restore', () => {
  it('reason=restored shows "تم استرجاع النسخة..."; a backup without users shows the first-run owner screen', async () => {
    await TestBed.configureTestingModule({
      imports: [LoginPageComponent, TranslateModule.forRoot()],
      providers: [...providers(), { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({ reason: 'restored' }) } } }],
    }).compileComponents();
    spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
    const http = TestBed.inject(HttpTestingController);
    let fixture = TestBed.createComponent(LoginPageComponent);
    http.expectOne(`${base}auth/bootstrap`).flush({ hasOwner: true, isLocal: true, shop: { name: '', logo: '' } });
    fixture.detectChanges();
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="restored-notice"]')!.textContent).toContain('session.restoredNotice');

    fixture = TestBed.createComponent(LoginPageComponent);
    http.expectOne(`${base}auth/bootstrap`).flush({ hasOwner: false, isLocal: true, shop: { name: '', logo: '' } });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.view()).toBe('setup');
  });
});

describe('Stage 15: another main PC banner', () => {
  const original = window.notaDesktop;
  let push: (list: OtherMainPc[]) => void;
  const other: OtherMainPc = { instanceId: 'x', shopName: 'محل تاني', address: '192.168.1.20', port: 5055 };

  beforeEach(async () => {
    window.notaDesktop = {
      getRuntimeConfig: async () => ({}) as never,
      getOtherMainPcs: async () => [],
      onOtherMainPcs: (callback) => {
        push = callback;
        return () => undefined;
      },
    };
    await TestBed.configureTestingModule({ imports: [OtherMainBannerComponent, TranslateModule.forRoot()], providers: providers() }).compileComponents();
  });
  afterEach(() => (window.notaDesktop = original));

  const render = async () => {
    const fixture = TestBed.createComponent(OtherMainBannerComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  };

  it('shown to shop.manage when another main PC answers; the help explains what to do; gone when it stops', async () => {
    signInAs('owner');
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="other-main-banner"]')).toBeNull();
    push([other]);
    fixture.detectChanges();
    expect(el.querySelector('[data-test="other-main-banner"]')!.textContent).toContain('192.168.1.20:5055');
    (el.querySelector('[data-test="other-main-help"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelector('[data-test="other-main-explain"]')).not.toBeNull();
    push([]);
    fixture.detectChanges();
    expect(el.querySelector('[data-test="other-main-banner"]')).toBeNull();
  });

  it('not shown to a user without shop.manage', async () => {
    signInWith(['sales.create', 'sales.view']);
    const fixture = await render();
    push([other]);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="other-main-banner"]')).toBeNull();
    expect(TestBed.inject(AuthService).has('shop.manage')).toBeFalse();
  });
});
