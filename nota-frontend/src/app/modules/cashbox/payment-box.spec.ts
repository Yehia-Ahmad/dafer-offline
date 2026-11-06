import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { signInAs } from '../../core/auth/testing/sign-in';
import { PaymentBox, PaymentBoxesResponse } from './cashbox.models';
import { PaymentBoxSelectComponent } from './payment-box-select.component';
import { PaymentBoxService } from './payment-box.service';
import { MAIN_ONLY_BOXES } from './testing/payment-boxes.testing';

const base = environment.api_base_url;
const url = `${base}cashbox/payment-boxes`;

const payBox = (overrides: Partial<PaymentBox>): PaymentBox => ({
  _id: 'b-main', name: 'الخزنة الرئيسية', type: 'cash', isMain: true, shiftsEnabled: false, isDefault: false, openShift: null, needsShift: false, ...overrides,
});
const DRAWER = payBox({ _id: 'b-d1', name: 'درج الكاشير ١', isMain: false, shiftsEnabled: true, isDefault: true, needsShift: true });
const OPEN_DRAWER = payBox({ ...DRAWER, needsShift: false, openShift: { _id: 's1', number: 'SH-000001', userName: 'محمود', openedAt: '2026-11-06T07:00:00Z' } });
const WALLET = payBox({ _id: 'b-w1', name: 'فودافون كاش', type: 'wallet', isMain: false });

/** What the backend answers for each role (Stage 19: a cashier never gets the main box while their PC has a drawer). */
const cashierOnDrawerPc = (drawer = DRAWER): PaymentBoxesResponse => ({
  defaultBoxId: 'b-d1', deviceId: 'device-aaaa-0001', mainBox: { _id: 'b-main', name: 'الخزنة الرئيسية' }, data: [drawer, WALLET],
});
const managerAnywhere: PaymentBoxesResponse = {
  defaultBoxId: 'b-main', deviceId: null, mainBox: { _id: 'b-main', name: 'الخزنة الرئيسية' },
  data: [payBox({ isDefault: true }), payBox({ ...DRAWER, isDefault: false }), WALLET],
};

@Component({ standalone: true, imports: [PaymentBoxSelectComponent], template: '<nota-payment-box-select />' })
class HostComponent {}

describe('PaymentBoxService (Stage 19)', () => {
  let service: PaymentBoxService;
  let http: HttpTestingController;
  const setup = (role: 'cashier' | 'manager' | 'storekeeper' = 'cashier', stored: string | null = null) => {
    sessionStorage.removeItem('nota.paymentBox');
    if (stored) sessionStorage.setItem('nota.paymentBox', stored);
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    signInAs(role);
    service = TestBed.inject(PaymentBoxService);
    http = TestBed.inject(HttpTestingController);
  };
  afterEach(() => { http.verify(); sessionStorage.removeItem('nota.paymentBox'); });

  it('asks the backend once, lists what it answers and defaults to the default box', () => {
    setup();
    service.load(); service.load();
    http.expectOne(url).flush(cashierOnDrawerPc());
    service.load();
    expect(service.boxes().map((box) => box.name)).toEqual(['درج الكاشير ١', 'فودافون كاش']);
    expect(service.effective()!._id).toBe('b-d1');
    expect(service.boxId()).toBeUndefined();
    expect(service.mainBox()!._id).toBe('b-main');
  });

  it('a manager is offered every box (including the main box and every drawer)', () => {
    setup('manager');
    service.load();
    http.expectOne(url).flush(managerAnywhere);
    expect(service.boxes().length).toBe(3);
    expect(service.effective()!.isMain).toBeTrue();
  });

  it('no request without a signed-in user', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(PaymentBoxService);
    http = TestBed.inject(HttpTestingController);
    service.load();
    http.expectNone(url);
  });

  it('only a non-default choice is sent; choosing the default again sends nothing; withBox adds it', () => {
    setup();
    service.load();
    http.expectOne(url).flush(cashierOnDrawerPc());
    expect(service.withBox({ amount: 5 })).toEqual({ amount: 5 });
    service.select('b-w1');
    expect(service.boxId()).toBe('b-w1');
    expect(service.withBox({ amount: 5 })).toEqual({ amount: 5, boxId: 'b-w1' });
    service.select('b-d1');
    expect(service.boxId()).toBeUndefined();
    expect(service.withBox({ amount: 5 })).toEqual({ amount: 5 });
  });

  it('the choice is remembered for the session on this PC, and forgotten when that box is no longer offered', () => {
    setup('cashier', 'b-w1');
    service.load();
    http.expectOne(url).flush(cashierOnDrawerPc());
    expect(service.effective()!._id).toBe('b-w1');
    expect(sessionStorage.getItem('nota.paymentBox')).toBe('b-w1');
    service.load(true);
    http.expectOne(url).flush({ ...cashierOnDrawerPc(), data: [DRAWER] });
    expect(service.effective()!._id).toBe('b-d1');
    expect(sessionStorage.getItem('nota.paymentBox')).toBeNull();
  });

  it('a drawer that needs a shift blocks, an open one does not; a failed list does not throw', () => {
    setup();
    service.load();
    http.expectOne(url).flush(cashierOnDrawerPc());
    expect(service.needsShift()).toBeTrue();
    service.load(true);
    http.expectOne(url).flush(cashierOnDrawerPc(OPEN_DRAWER));
    expect(service.needsShift()).toBeFalse();
    service.load(true);
    http.expectOne(url).flush({}, { status: 500, statusText: 'Server Error' });
    expect(service.loadFailed()).toBeTrue();
  });
});

describe('PaymentBoxSelectComponent (Stage 19)', () => {
  let http: HttpTestingController;
  const render = async (role: 'cashier' | 'manager' | 'storekeeper', response: PaymentBoxesResponse) => {
    sessionStorage.removeItem('nota.paymentBox');
    await TestBed.configureTestingModule({
      imports: [HostComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    signInAs(role);
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    http.expectOne(url).flush(response);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  };
  const el = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
  afterEach(() => { http.verify(); sessionStorage.removeItem('nota.paymentBox'); });

  it('a shop with one box shows nothing at all (the cashier sees no change)', async () => {
    const fixture = await render('cashier', MAIN_ONLY_BOXES);
    expect(el(fixture).querySelector('[data-test="payment-box"]')).toBeNull();
    expect(el(fixture).querySelector('[data-test="no-shift-banner"]')).toBeNull();
    expect(el(fixture).querySelector('[data-action="shift"]')).toBeNull();
  });

  it('a cashier on a drawer PC without a shift sees the drawer first, the wallet, the banner and the open-shift button', async () => {
    const fixture = await render('cashier', cashierOnDrawerPc());
    const options = Array.from(el(fixture).querySelectorAll('[data-test="payment-box"] option')).map((option) => option.textContent!.replace(/\s+/g, ' ').trim());
    expect(options).toEqual(['درج الكاشير ١ · cashbox.types.cash', 'فودافون كاش · cashbox.types.wallet']);
    expect(el(fixture).querySelector('[data-test="no-shift-banner"]')!.textContent).toContain('cashbox.noShiftBanner');
    expect(el(fixture).querySelector('[data-action="shift"]')!.textContent).toContain('cashbox.shift.openButton');
  });

  it('choosing the wallet hides the banner; with an open shift the button is the small "الوردية" one', async () => {
    const fixture = await render('cashier', cashierOnDrawerPc());
    const service = TestBed.inject(PaymentBoxService);
    service.select('b-w1');
    fixture.detectChanges();
    expect(el(fixture).querySelector('[data-test="no-shift-banner"]')).toBeNull();
    expect(el(fixture).querySelector('[data-action="shift"]')).toBeNull();
    service.select(null);
    service.load(true);
    http.expectOne(url).flush(cashierOnDrawerPc(OPEN_DRAWER));
    fixture.detectChanges();
    expect(el(fixture).querySelector('[data-test="no-shift-banner"]')).toBeNull();
    expect(el(fixture).querySelector('[data-action="shift"]')!.textContent).toContain('cashbox.shift.button');
  });

  it('a user without a shift permission gets the banner but no shift button', async () => {
    const fixture = await render('storekeeper', cashierOnDrawerPc());
    expect(el(fixture).querySelector('[data-test="no-shift-banner"]')).not.toBeNull();
    expect(el(fixture).querySelector('[data-action="shift"]')).toBeNull();
  });
});
