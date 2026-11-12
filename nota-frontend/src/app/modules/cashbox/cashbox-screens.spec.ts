import { Type } from '@angular/core';
import { lockRefreshSpy } from '../../test-setup.spec';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { signInAs, signInWith } from '../../core/auth/testing/sign-in';
import { LanguageService } from '../shared/services/translation.service';
import { AddBoxDialogComponent } from './add-box-dialog.component';
import { BoxDetailComponent } from './box-detail.component';
import { CashBox, ShiftReport } from './cashbox.models';
import { CashboxPageComponent } from './cashbox-page.component';
import { DrawingDialogComponent } from './drawing-dialog.component';
import { OpenShiftDialogComponent } from './open-shift-dialog.component';
import { ShiftPanelComponent } from './shift-panel.component';
import { TransferDialogComponent } from './transfer-dialog.component';

const base = environment.api_base_url;

const box = (overrides: Partial<CashBox>): CashBox => ({
  _id: 'b-main', name: 'الخزنة الرئيسية', type: 'cash', accountId: 'a1', accountCode: '1111', isMain: true, deviceId: null, deviceName: null,
  shiftsEnabled: false, isActive: true, sortOrder: 0, balance: 18400, openShift: null, ...overrides,
});
const MAIN = box({});
const DRAWER = box({
  _id: 'b-d1', name: 'درج الكاشير ١', accountId: 'a2', accountCode: '11102', isMain: false, shiftsEnabled: true, balance: 7550, deviceId: 'device-aaaa-0001', deviceName: 'كاشير 1',
  openShift: { _id: 's1', number: 'SH-000001', userId: 'id-owner', userName: 'محمود', openedAt: '2026-11-06T07:00:00.000Z', openingFloat: 500 },
});
const WALLET = box({ _id: 'b-w1', name: 'فودافون كاش', type: 'wallet', accountId: 'a3', accountCode: '11201', isMain: false, balance: 2300 });
const BANK = box({ _id: 'b-bk', name: 'بنك مصر', type: 'bank', accountId: 'a4', accountCode: '11202', isMain: false, balance: 41000 });

const REPORT: ShiftReport = {
  _id: 's1', number: 'SH-000001', boxId: 'b-d1', boxName: 'درج الكاشير ١', userId: 'id-owner', userName: 'محمود', openedAt: '2026-11-06T07:00:00.000Z',
  openingFloat: 500, openingBalance: 500, closedAt: null, closedByName: null, expected: 7550, counted: null, difference: null, differenceNote: null,
  depositBoxId: null, depositAmount: 0, status: 'open', remaining: null,
  lines: [
    { key: 'float', amount: 500 }, { key: 'sales', amount: 6820 }, { key: 'receipts', amount: 600 }, { key: 'transfersIn', amount: 0 },
    { key: 'refunds', amount: 120 }, { key: 'expenses', amount: 250 }, { key: 'transfersOut', amount: 0 }, { key: 'payouts', amount: 0 }, { key: 'drawings', amount: 0 },
  ],
};

const text = (fixture: ComponentFixture<unknown>) => (fixture.nativeElement as HTMLElement).textContent ?? '';
const settle = async (fixture: ComponentFixture<unknown>) => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };

async function render<T>(component: Type<T>, signIn: () => void = () => signInAs('owner'), route?: object) {
  await TestBed.configureTestingModule({
    imports: [component, TranslateModule.forRoot()],
    providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(),
      ...(route ? [{ provide: ActivatedRoute, useValue: route }] : [])],
  }).compileComponents();
  TestBed.inject(LanguageService).selectedLanguage.set('en');
  signIn();
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(component);
  return { fixture, http, component: fixture.componentInstance };
}

describe('CashboxPageComponent (Stage 19)', () => {
  const open = async (signIn?: () => void) => {
    const ctx = await render(CashboxPageComponent, signIn);
    ctx.fixture.detectChanges();
    ctx.http.expectOne(`${base}cashbox/boxes`).flush({ data: [MAIN, DRAWER, WALLET, BANK], cashTotal: 25950 });
    await settle(ctx.fixture);
    return ctx;
  };

  it('shows a card per box: name, type, balance, the open shift and the bound PC', async () => {
    const { fixture, http } = await open();
    http.expectOne(`${base}shifts/s1`).flush(REPORT);
    await settle(fixture);
    const cards = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('[data-box]')) as HTMLElement[];
    expect(cards.map((card) => card.getAttribute('data-box'))).toEqual(['الخزنة الرئيسية', 'درج الكاشير ١', 'فودافون كاش', 'بنك مصر']);
    expect(cards[1].textContent).toContain('cashbox.types.cash');
    expect(cards[1].textContent).toContain('7,550');
    expect(cards[1].classList).toContain('cb__card--shift');
    expect(cards[2].textContent).toContain('cashbox.types.wallet');
    expect(cards[3].textContent).toContain('cashbox.types.bank');
    expect(cards[0].classList).not.toContain('cb__card--shift');
    http.verify();
  });

  it('the shift panel of the open shift shows the design lines and the expected cash', async () => {
    const { fixture, http } = await open();
    http.expectOne(`${base}shifts/s1`).flush(REPORT);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(Array.from(el.querySelectorAll('[data-line]')).map((row) => row.getAttribute('data-line'))).toEqual(['float', 'sales', 'receipts', 'refunds', 'expenses']);
    expect(el.querySelector('[data-test="expected"]')!.textContent).toContain('7,550');
    http.verify();
  });

  it('owner sees transfer, new box and owner drawing; a viewer sees none; a drawer without a shift can open one', async () => {
    const owner = await open();
    owner.http.expectOne(`${base}shifts/s1`).flush(REPORT);
    await settle(owner.fixture);
    const el = owner.fixture.nativeElement as HTMLElement;
    expect(['transfer', 'new-box', 'drawing'].map((action) => !!el.querySelector(`[data-action="${action}"]`))).toEqual([true, true, true]);
    expect(el.querySelectorAll('[data-action="open-shift"]').length).toBe(0);
    owner.http.verify();
    TestBed.resetTestingModule();

    const viewer = await open(() => signInWith(['cashbox.view']));
    const view = viewer.fixture.nativeElement as HTMLElement;
    expect(['transfer', 'new-box', 'drawing', 'open-shift', 'show-shift'].map((action) => !!view.querySelector(`[data-action="${action}"]`))).toEqual([false, false, false, false, false]);
    viewer.http.verify();
    TestBed.resetTestingModule();

    const quiet = box({ ...DRAWER, openShift: null });
    const ctx = await render(CashboxPageComponent, () => signInAs('manager'));
    ctx.fixture.detectChanges();
    ctx.http.expectOne(`${base}cashbox/boxes`).flush({ data: [MAIN, quiet], cashTotal: 25950 });
    await settle(ctx.fixture);
    expect((ctx.fixture.nativeElement as HTMLElement).querySelectorAll('[data-action="open-shift"]').length).toBe(1);
    ctx.http.verify();
  });
});

describe('AddBoxDialogComponent (Stage 19)', () => {
  const open = async () => {
    const ctx = await render(AddBoxDialogComponent);
    ctx.fixture.detectChanges();
    ctx.component.visible.set(true);
    return ctx;
  };

  it('lists the PCs with "الجهاز ده" marked and those already bound disabled', async () => {
    const { fixture, http, component } = await open();
    component.loadDevices();
    http.expectOne(`${base}devices`).flush({ currentDeviceId: 'device-aaaa-0001', data: [
      { deviceId: 'device-aaaa-0001', name: 'كاشير 1', role: 'client', lastSeenAt: '2026-11-06T07:00:00Z', isCurrent: true, boxId: null, boxName: null },
      { deviceId: 'device-bbbb-0002', name: 'كاشير 2', role: 'client', lastSeenAt: '2026-11-06T07:00:00Z', isCurrent: false, boxId: 'b-x', boxName: 'درج ٣' },
    ] });
    await settle(fixture);
    const devices = document.body.querySelectorAll('[data-test="box-device"] option');
    expect(Array.from(devices).map((option) => option.textContent!.replace(/\s+/g, ' ').trim())).toEqual([
      'cashbox.add.anyDevice', 'كاشير 1 · cashbox.add.thisDevice', 'كاشير 2 · درج ٣',
    ]);
    expect((devices[2] as HTMLOptionElement).disabled).toBeTrue();
    http.verify();
  });

  it('a drawer sends the PC, the shifts flag and the opening amount; a wallet sends neither PC nor shifts flag', async () => {
    const { http, component } = await open();
    component.name.set('  درج الكاشير ٢ ');
    component.deviceId.set('device-aaaa-0001');
    component.opening.set(500);
    expect(component.payload()).toEqual({ name: 'درج الكاشير ٢', type: 'cash', deviceId: 'device-aaaa-0001', shiftsEnabled: true, openingAmount: 500 });
    component.shifts.set(false);
    expect(component.payload().shiftsEnabled).toBeFalse();
    component.type.set('wallet');
    expect(component.payload()).toEqual({ name: 'درج الكاشير ٢', type: 'wallet', openingAmount: 500 });
    component.opening.set(0);
    expect(component.payload()).toEqual({ name: 'درج الكاشير ٢', type: 'wallet' });
    http.verify();
  });

  it('save posts the box, closes and announces it; DEVICE_ALREADY_BOUND stays on the form', async () => {
    const { http, component } = await open();
    const created: CashBox[] = [];
    component.created.subscribe((row) => created.push(row));
    component.name.set('درج جديد');
    component.save();
    http.expectOne(`${base}cashbox/boxes`).flush({ code: 'DEVICE_ALREADY_BOUND' }, { status: 409, statusText: 'Conflict' });
    expect(component.error()).toBe('DEVICE_ALREADY_BOUND');
    expect(component.visible()).toBeTrue();
    component.save();
    http.expectOne(`${base}cashbox/boxes`).flush(DRAWER);
    expect(created).toEqual([DRAWER]);
    expect(component.visible()).toBeFalse();
    expect(component.name()).toBe('');
    http.verify();
  });
});

describe('TransferDialogComponent (Stage 19)', () => {
  const open = async () => {
    const ctx = await render(TransferDialogComponent);
    ctx.fixture.componentRef.setInput('boxes', [MAIN, WALLET, BANK]);
    ctx.fixture.detectChanges();
    ctx.component.visible.set(true);
    return ctx;
  };

  it('re-reads the lock date when it opens (Stage 22 review)', async () => {
    const { fixture } = await open();
    await settle(fixture);
    expect(lockRefreshSpy()).toHaveBeenCalled();
  });

  it('shows both balances before and after, and refuses more than the from-box holds', async () => {
    const { fixture, component } = await open();
    component.fromId.set('b-main'); component.toId.set('b-bk'); component.amount.set(10000);
    await settle(fixture);
    expect([component.fromAfter(), component.toAfter()]).toEqual([8400, 51000]);
    const from = document.body.querySelector('[data-test="from-balance"]')!.textContent!;
    const to = document.body.querySelector('[data-test="to-balance"]')!.textContent!;
    expect(from).toContain('18,400'); expect(from).toContain('8,400');
    expect(to).toContain('41,000'); expect(to).toContain('51,000');
    expect(component.valid()).toBeTrue();
    component.amount.set(18400.01);
    expect(component.insufficient()).toBeTrue();
    expect(component.valid()).toBeFalse();
    component.amount.set(10);
    component.toId.set('b-main');
    expect(component.sameBox()).toBeTrue();
    expect(component.valid()).toBeFalse();
  });

  it('posts the exact transfer body and announces it', async () => {
    const { http, component } = await open();
    const done: unknown[] = [];
    component.done.subscribe((row) => done.push(row));
    component.fromId.set('b-main'); component.toId.set('b-bk'); component.amount.set(10000); component.date.set('2026-11-03'); component.note.set(' إيداع في البنك ');
    expect(component.payload()).toEqual({ fromBoxId: 'b-main', toBoxId: 'b-bk', amount: 10000, date: '2026-11-03', note: 'إيداع في البنك' });
    component.save();
    http.expectOne(`${base}cashbox/transfers`).flush({ number: 'TR-000001' });
    expect(done.length).toBe(1);
    expect(component.visible()).toBeFalse();
    http.verify();
  });

  it('a server INSUFFICIENT_BALANCE shows the balance message', async () => {
    const { http, component } = await open();
    component.fromId.set('b-main'); component.toId.set('b-bk'); component.amount.set(10);
    component.save();
    http.expectOne(`${base}cashbox/transfers`).flush({ code: 'INSUFFICIENT_BALANCE' }, { status: 409, statusText: 'Conflict' });
    expect(component.error()).toBe('cashbox.errors.INSUFFICIENT_BALANCE');
    http.verify();
  });
});

describe('DrawingDialogComponent (Stage 19, owner drawings)', () => {
  it('posts boxId, amount, date and note', async () => {
    const { http, component, fixture } = await render(DrawingDialogComponent);
    fixture.componentRef.setInput('boxes', [MAIN, WALLET]);
    fixture.detectChanges();
    component.visible.set(true);
    component.boxId.set('b-main'); component.amount.set(2500); component.date.set('2026-11-06'); component.note.set('سحب شخصي');
    expect(component.payload()).toEqual({ boxId: 'b-main', amount: 2500, date: '2026-11-06', note: 'سحب شخصي' });
    component.save();
    http.expectOne(`${base}cashbox/drawings`).flush({ number: 'DR-000001' });
    expect(component.visible()).toBeFalse();
    http.verify();
  });
});

describe('OpenShiftDialogComponent (Stage 19)', () => {
  it('opens with the float; a different balance asks for confirmation, then sends confirmFloat', async () => {
    const { http, component, fixture } = await render(OpenShiftDialogComponent);
    fixture.componentRef.setInput('boxId', 'b-d1');
    fixture.componentRef.setInput('boxName', 'درج الكاشير ١');
    fixture.detectChanges();
    component.visible.set(true);
    const opened: unknown[] = [];
    component.opened.subscribe((shift) => opened.push(shift));
    component.float.set(480);
    component.submit();
    const first = http.expectOne(`${base}shifts`);
    expect(first.request.body).toEqual({ boxId: 'b-d1', openingFloat: 480 });
    first.flush({ code: 'FLOAT_MISMATCH', balance: 500, openingFloat: 480, difference: -20 }, { status: 409, statusText: 'Conflict' });
    expect(component.mismatch()).toEqual({ balance: 500, openingFloat: 480, difference: -20 });
    expect(component.visible()).toBeTrue();
    // The confirmed difference needs a note: without one nothing is sent.
    component.submit();
    http.expectNone(`${base}shifts`);
    expect(component.busy()).toBeFalse(); // a missing note never leaves the dialog locked
    component.note.set('  20 ناقصة في العد ');
    component.submit();
    const second = http.expectOne(`${base}shifts`);
    expect(second.request.body).toEqual({ boxId: 'b-d1', openingFloat: 480, confirmFloat: true, openingNote: '20 ناقصة في العد' });
    second.flush({ _id: 's2', number: 'SH-000002' });
    expect(opened.length).toBe(1);
    expect(component.visible()).toBeFalse();
    http.verify();
  });

  it('changing the float again drops the confirmation', async () => {
    const { http, component, fixture } = await render(OpenShiftDialogComponent);
    fixture.componentRef.setInput('boxId', 'b-d1');
    fixture.detectChanges();
    component.mismatch.set({ balance: 500, openingFloat: 480, difference: -20 });
    component.float.set(500);
    component.mismatch.set(null);
    component.submit();
    expect(http.expectOne(`${base}shifts`).request.body).toEqual({ boxId: 'b-d1', openingFloat: 500 });
  });
});

describe('ShiftPanelComponent (Stage 19)', () => {
  const open = async (report: ShiftReport = REPORT) => {
    const ctx = await render(ShiftPanelComponent);
    ctx.fixture.componentRef.setInput('shiftId', 's1');
    ctx.fixture.componentRef.setInput('depositOptions', [{ _id: 'b-d1', name: 'درج الكاشير ١' }, { _id: 'b-main', name: 'الخزنة الرئيسية' }]);
    ctx.fixture.detectChanges();
    ctx.http.expectOne(`${base}shifts/s1`).flush(report);
    await settle(ctx.fixture);
    return ctx;
  };

  it('the live difference: 7,500 counted against 7,550 is a shortage of 50, and a note is then required', async () => {
    const { fixture, component } = await open();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="difference"]')).toBeNull();
    component.counted.set(7500);
    await settle(fixture);
    expect(component.difference()).toBe(-50);
    expect(component.diffKind()).toBe('short');
    const diff = el.querySelector('[data-test="difference"]')!;
    expect(diff.textContent).toContain('cashbox.shift.diff.short');
    expect(diff.textContent).toContain('50');
    expect(component.needsNote()).toBeTrue();
    expect(component.canClose()).toBeFalse();
    component.note.set('فكّة ناقصة');
    expect(component.canClose()).toBeTrue();
    component.counted.set(7600);
    expect(component.diffKind()).toBe('over');
    component.counted.set(7550);
    expect(component.diffKind()).toBe('even');
    expect(component.needsNote()).toBeFalse();
  });

  it('the deposit is capped by the counted amount and needs a box; the rest stays in the drawer', async () => {
    const { fixture, component } = await open();
    component.counted.set(7500);
    component.note.set('عجز');
    component.deposit.set(7000);
    expect(component.depositInvalid()).toBeTrue();
    expect(component.options().map((option) => option._id)).toEqual(['b-main']);
    component.depositBoxId.set('b-main');
    expect(component.depositInvalid()).toBeFalse();
    expect(component.remaining()).toBe(500);
    await settle(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="remaining"]')!.textContent).toContain('cashbox.shift.remaining');
    component.deposit.set(7600);
    expect(component.depositInvalid()).toBeTrue();
    expect(component.canClose()).toBeFalse();
  });

  it('close posts the counted amount, the note and the deposit, then shows the summary without a print button', async () => {
    const { fixture, http, component } = await open();
    const closed: ShiftReport[] = [];
    component.closed.subscribe((report) => closed.push(report));
    component.counted.set(7500); component.note.set('عجز'); component.depositBoxId.set('b-main'); component.deposit.set(7000);
    component.close();
    const request = http.expectOne(`${base}shifts/s1/close`);
    expect(request.request.body).toEqual({ counted: 7500, differenceNote: 'عجز', depositBoxId: 'b-main', depositAmount: 7000 });
    request.flush({ ...REPORT, status: 'closed', counted: 7500, difference: -50, differenceNote: 'عجز', depositAmount: 7000, depositBoxId: 'b-main', remaining: 500, closedAt: '2026-11-06T15:00:00Z' });
    await settle(fixture);
    expect(closed.length).toBe(1);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="shift-summary"]')!.textContent).toContain('500');
    expect(el.querySelector('[data-action="close-shift"]')).toBeNull();
    expect(el.querySelector('[data-action="print-shift"]')).toBeTruthy(); // Stage 23: PrShiftClose
    expect(el.querySelector('[data-action="pdf-shift"]')).toBeTruthy();
    http.verify();
  });

  it('a zero difference sends no note and no deposit', async () => {
    const { http, component } = await open();
    component.counted.set(7550);
    component.close();
    expect(http.expectOne(`${base}shifts/s1/close`).request.body).toEqual({ counted: 7550 });
  });

  it('a shift opened with a confirmed float difference shows that line (posted to cash over/short) in its report', async () => {
    const { fixture } = await open({ ...REPORT, openingFloat: 930, openingBalance: 960, openingDifference: -30, openingNote: '30 ناقصة' });
    const row = (fixture.nativeElement as HTMLElement).querySelector('[data-line="openingDifference"]')!;
    expect(row.textContent).toContain('cashbox.shift.openingDifferenceLine');
    expect(row.textContent).toContain('30 ناقصة');
    expect(row.textContent).toContain('30');
    expect(row.querySelector('.sp__minus')).not.toBeNull();
  });

  it('a shift with an even float has no opening-difference line', async () => {
    const { fixture } = await open();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-line="openingDifference"]')).toBeNull();
  });

  it('a closed shift opens as the summary', async () => {
    const { fixture } = await open({ ...REPORT, status: 'closed', counted: 7550, difference: 0, remaining: 7550 });
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="shift-summary"]')).not.toBeNull();
    expect(text(fixture)).toContain('cashbox.shift.status.closed');
  });
});

describe('BoxDetailComponent (Stage 19)', () => {
  it('shows the ledger with a running balance and source numbers, and the shifts of the box', async () => {
    const { fixture, http } = await render(BoxDetailComponent, () => signInAs('owner'), { snapshot: { paramMap: convertToParamMap({ id: 'b-d1' }) } });
    fixture.detectChanges();
    http.expectOne(`${base}cashbox/boxes/b-d1`).flush({ ...DRAWER, shifts: [
      { _id: 's1', number: 'SH-000001', boxId: 'b-d1', userName: 'محمود', openedAt: '2026-11-06T07:00:00Z', expected: null, counted: null, difference: null, status: 'open', openingFloat: 500 },
      { _id: 's0', number: 'SH-000000', boxId: 'b-d1', userName: 'محمود', openedAt: '2026-11-05T07:00:00Z', expected: 7550, counted: 7500, difference: -50, status: 'closed', openingFloat: 500 },
    ] });
    http.expectOne(`${base}cashbox/boxes/b-d1/ledger`).flush({ openingBalance: 0, balance: 7550, side: 'debit', absBalance: 7550, lines: [
      { entryId: 'e1', number: 'JE-000001', date: '2026-11-06T08:00:00Z', source: { type: 'sale', id: 'x1', number: 'INV-000001' }, debit: 7000, credit: 0, balance: 7000 },
      { entryId: 'e2', number: 'JE-000002', date: '2026-11-06T09:00:00Z', source: { type: 'expense', id: 'x2', number: 'EX-000001' }, debit: 0, credit: 250, balance: 6750 },
      { entryId: 'e3', number: 'JE-000003', date: '2026-11-06T10:00:00Z', source: { type: 'transfer', id: 'x3', number: 'TR-000001' }, debit: 800, credit: 0, balance: 7550 },
    ] });
    http.expectOne(`${base}cashbox/boxes`).flush({ data: [MAIN, DRAWER], cashTotal: 0 });
    fixture.detectChanges();
    http.expectOne(`${base}shifts/s1`).flush(REPORT);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const rows = Array.from(el.querySelectorAll('[data-test="ledger"] tbody tr'));
    expect(rows.length).toBe(3);
    expect(Array.from(el.querySelectorAll('[data-test="line-balance"]')).map((cell) => cell.textContent!.trim())).toEqual(['7,000.00', '6,750.00', '7,550.00']);
    expect(rows[0].querySelector('a[href="/invoice-history"]')!.textContent).toContain('INV-000001');
    expect(rows[1].querySelector('a[href="/expenses"]')).not.toBeNull();
    expect(rows[2].querySelector('a[href^="/accounting/journal"]')).not.toBeNull();
    expect(el.querySelector('[data-test="detail-balance"]')!.textContent).toContain('7,550');
    expect(el.querySelectorAll('[data-test="shifts"] tbody tr').length).toBe(2);
    http.verify();
  });

  it('a negative running balance gets the warning style', async () => {
    const { fixture, http } = await render(BoxDetailComponent, () => signInAs('owner'), { snapshot: { paramMap: convertToParamMap({ id: 'b-w1' }) } });
    fixture.detectChanges();
    http.expectOne(`${base}cashbox/boxes/b-w1`).flush({ ...WALLET, shifts: [] });
    http.expectOne(`${base}cashbox/boxes/b-w1/ledger`).flush({ openingBalance: 0, balance: -100, side: 'credit', absBalance: 100, lines: [
      { entryId: 'e1', number: 'JE-000009', date: '2026-11-06T08:00:00Z', source: { type: 'return', id: 'r1', number: 'RT-000001' }, debit: 0, credit: 100, balance: -100 },
    ] });
    http.expectOne(`${base}cashbox/boxes`).flush({ data: [WALLET], cashTotal: 0 });
    await settle(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="line-balance"]')!.classList).toContain('bd__warn');
    http.verify();
  });
});
