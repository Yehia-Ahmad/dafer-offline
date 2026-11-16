import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { signInAs, signInWith } from '../../core/auth/testing/sign-in';
import { Courier } from '../orders/orders.models';
import { CouriersPageComponent } from './couriers-page.component';

/** Online Stage 4: /website/couriers: the list with box balance, amount owed and open orders; add/edit/deactivate; "hand in cash". */
describe('CouriersPageComponent (Online Stage 4)', () => {
  const url = `${environment.api_base_url}couriers`;
  let http: HttpTestingController;
  let fixture: any;
  let component: any;

  const courier = (over: Partial<Courier>): Courier => ({ id: 'c1', name: 'أحمد', phone: '01000000001', isActive: true, boxId: 'b1', customerId: 'u1', boxBalance: 230, amountOwed: 100, openOrders: 2, ...over });
  const list = [courier({}), courier({ id: 'c2', name: 'محمود', phone: '01000000002', boxId: 'b2', customerId: 'u2', boxBalance: 0, amountOwed: 0, openOrders: 0, isActive: false })];

  async function open(role: 'owner' | 'cashier' | string[]) {
    await TestBed.configureTestingModule({
      imports: [CouriersPageComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations()],
    }).compileComponents();
    if (Array.isArray(role)) signInWith(role); else signInAs(role);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CouriersPageComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne((r) => r.url === url && r.method === 'GET').flush({ data: list });
    fixture.detectChanges();
  }
  afterEach(() => http.verify());

  const rows = (): HTMLElement[] => Array.from(fixture.nativeElement.querySelectorAll('[data-test="courier-row"]'));
  const actionsOf = (row: HTMLElement) => Array.from(row.querySelectorAll('[data-action]')).map((el) => (el as HTMLElement).dataset['action']);

  it('lists name, phone, box balance, amount owed and open orders', async () => {
    await open('owner');
    expect(rows().length).toBe(2);
    expect(rows()[0].textContent).toContain('أحمد');
    const latin = (s: string) => s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
    expect(latin(rows()[0].querySelector('[data-test="box-balance"]')!.textContent!)).toContain('230');
    expect(latin(rows()[0].querySelector('[data-test="amount-owed"]')!.textContent!)).toContain('100');
    expect(rows()[1].classList).toContain('is-off');
  });

  it('owner: edit, deactivate/activate and hand in cash (only with cash in the box); a cashier only reads', async () => {
    await open('owner');
    expect(actionsOf(rows()[0])).toEqual(['hand-in', 'edit-courier', 'deactivate-courier']);
    expect((rows()[0].querySelector('[data-action="hand-in"]') as HTMLButtonElement).disabled).toBeFalse();
    expect(actionsOf(rows()[1])).toEqual(['hand-in', 'edit-courier', 'activate-courier']);
    expect((rows()[1].querySelector('[data-action="hand-in"]') as HTMLButtonElement).disabled).toBeTrue();
    expect(fixture.nativeElement.querySelector('[data-action="add-courier"]')).not.toBeNull();
  });

  it('a cashier (no website.manage, no customers.manage, no cashbox.manage) sees the list without any action', async () => {
    await open('cashier');
    expect(actionsOf(rows()[0])).toEqual([]);
    expect(fixture.nativeElement.querySelector('[data-action="add-courier"]')).toBeNull();
  });

  it('add: POST name and phone, then the list reloads', async () => {
    await open('owner');
    component.openAdd();
    component.name.set('  سعيد ');
    component.phone.set(' 01000000009 ');
    component.save();
    const request = http.expectOne((r) => r.url === url && r.method === 'POST');
    expect(request.request.body).toEqual({ name: 'سعيد', phone: '01000000009' });
    request.flush(courier({ id: 'c3' }));
    http.expectOne((r) => r.url === url && r.method === 'GET').flush({ data: list });
    expect(component.dialogOpen()).toBeFalse();
  });

  it('a phone that belongs to another customer is refused with the server message', async () => {
    await open('owner');
    component.openAdd();
    component.name.set('سعيد'); component.phone.set('01000000001');
    component.save();
    http.expectOne((r) => r.url === url && r.method === 'POST').flush({ message: 'رقم الموبايل ده مستخدم لعميل تاني', code: 'PHONE_IN_USE' }, { status: 409, statusText: 'Conflict' });
    expect(component.errorMessage()).toBe('رقم الموبايل ده مستخدم لعميل تاني');
    expect(component.dialogOpen()).toBeTrue();
  });

  it('deactivate: a courier with open orders, cash or a balance is refused and the message is shown', async () => {
    await open('owner');
    component.setActive(list[0], false);
    const request = http.expectOne((r) => r.url === `${url}/c1` && r.method === 'PUT');
    expect(request.request.body).toEqual({ isActive: false });
    request.flush({ message: 'المندوب معاه طلبات خارجة للتوصيل', code: 'COURIER_HAS_OPEN_ORDERS' }, { status: 409, statusText: 'Conflict' });
    fixture.detectChanges();
    expect(component.errorMessage()).toBe('المندوب معاه طلبات خارجة للتوصيل');
    expect(fixture.nativeElement.querySelector('[data-test="courier-error"]')).not.toBeNull();
  });

  it('hand in cash opens the existing transfer dialog filled in: courier box → main box, the whole balance', async () => {
    await open('owner');
    component.handIn(list[0]);
    http.expectOne(`${environment.api_base_url}cashbox/boxes`).flush({
      data: [
        { _id: 'main', name: 'الخزنة الرئيسية', type: 'cash', isMain: true, isActive: true, balance: 1000, shiftsEnabled: false, openShift: null, accountId: 'a0', deviceId: null, deviceName: null, sortOrder: 0 },
        { _id: 'b1', name: 'مندوب – أحمد', type: 'cash', isMain: false, isActive: true, balance: 230, shiftsEnabled: false, openShift: null, accountId: 'a1', deviceId: null, deviceName: null, sortOrder: 1 },
      ],
      cashTotal: 1230,
    });
    fixture.detectChanges();
    expect(component.transferOpen()).toBeTrue();
    expect(component.handInFrom()).toBe('b1');
    expect(component.handInTo()).toBe('main');
    expect(component.handInAmount()).toBe(230);
    const dialog = fixture.debugElement.query((d: any) => d.name === 'app-transfer-dialog').componentInstance;
    expect(dialog.fromId()).toBe('b1');
    expect(dialog.toId()).toBe('main');
    expect(dialog.amount()).toBe(230);
  });
});
