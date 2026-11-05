import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../environments/environment';
import { FAKE_CATALOG, ROLE_PERMISSIONS, fakeUser } from '../../../core/auth/testing/auth-fixtures';
import { signInAs, signInWith } from '../../../core/auth/testing/sign-in';
import { UserFormDialogComponent } from './user-form-dialog.component';

/** Stage 14: AddUser.dc.html — template fill, edited state, disabled permissions, error mapping, payloads. */
describe('UserFormDialogComponent (Stage 14)', () => {
  const base = environment.api_base_url;
  let fixture: ComponentFixture<UserFormDialogComponent>;
  let component: UserFormDialogComponent;
  let http: HttpTestingController;
  const el = () => document.body;

  const open = async (user: ReturnType<typeof fakeUser> | null, me: () => void = () => signInAs('owner')) => {
    await TestBed.configureTestingModule({
      imports: [UserFormDialogComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    me();
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
    http.verify();
    fixture?.destroy();
  });

  it('new user: cashier by default, its template filled in; choosing a role fills that template', async () => {
    await open(null);
    expect(component.role()).toBe('cashier');
    expect([...component.selected()].sort()).toEqual([...ROLE_PERMISSIONS.cashier].sort());
    expect(component.edited()).toBeFalse();
    component.chooseRole('storekeeper');
    expect([...component.selected()].sort()).toEqual([...ROLE_PERMISSIONS.storekeeper].sort());
    expect(component.edited()).toBeFalse();
  });

  it('changing a checkbox marks the list as edited and shows "رجوع لصلاحيات الدور"; reverting clears it', async () => {
    await open(null);
    component.toggle('sales.discount', true);
    fixture.detectChanges();
    expect(component.edited()).toBeTrue();
    expect(el().querySelector('[data-testid="edited-badge"]')).not.toBeNull();
    expect(el().querySelector('[data-action="revert-template"]')).not.toBeNull();
    component.revertToTemplate();
    fixture.detectChanges();
    expect(component.edited()).toBeFalse();
    expect(el().querySelector('[data-action="revert-template"]')).toBeNull();
  });

  it('create payload: template role → no permissions key; edited → the list', async () => {
    await open(null);
    component.name.set(' يوسف ');
    component.username.set('youssef');
    component.password.set('pass-1234');
    component.confirm.set('pass-1234');
    expect(component.buildPayload()).toEqual({ name: 'يوسف', username: 'youssef', password: 'pass-1234', role: 'cashier' });
    component.toggle('sales.discount', true);
    const payload = component.buildPayload() as { permissions: string[] };
    expect(payload.permissions).toContain('sales.discount');
    component.submit();
    const req = http.expectOne(`${base}users`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body.permissions).toContain('sales.discount');
    req.flush({ user: fakeUser('cashier', { name: 'يوسف', permissionsEdited: true }) });
    expect(component.open()).toBeFalse();
  });

  it('permissions the signed-in user does not hold are disabled, with a note', async () => {
    // A manager with users.manage added (not the owner): no backup.manage.
    await open(null, () => signInWith([...ROLE_PERMISSIONS.manager, 'users.manage']));
    const backup = el().querySelector<HTMLInputElement>('input[data-perm="backup.manage"]')!;
    const sales = el().querySelector<HTMLInputElement>('input[data-perm="sales.create"]')!;
    expect(backup.disabled).toBeTrue();
    expect(sales.disabled).toBeFalse();
    expect(el().querySelector('[data-testid="unheld-note"]')).not.toBeNull();
    component.toggle('backup.manage', true);
    expect(component.selected()).not.toContain('backup.manage');
  });

  it('server errors map to fields: USERNAME_TAKEN, PERMISSION_NOT_HELD (keys marked), OWNER_PROTECTED, CANNOT_CHANGE_SELF', async () => {
    await open(null);
    component.name.set('x');
    component.username.set('taken');
    component.password.set('pass-1234');
    component.confirm.set('pass-1234');

    component.submit();
    http.expectOne(`${base}users`).flush({ code: 'USERNAME_TAKEN' }, { status: 409, statusText: 'Conflict' });
    expect(component.errors().username).toBe('users.errors.USERNAME_TAKEN');

    component.submit();
    http.expectOne(`${base}users`).flush({ code: 'PERMISSION_NOT_HELD', permissions: ['backup.manage'] }, { status: 403, statusText: 'Forbidden' });
    expect(component.errors().permissions).toBe('users.errors.PERMISSION_NOT_HELD');
    expect(component.refusedKeys()).toEqual(['backup.manage']);

    component.submit();
    http.expectOne(`${base}users`).flush({ code: 'OWNER_PROTECTED' }, { status: 403, statusText: 'Forbidden' });
    expect(component.errors().role).toBe('users.errors.OWNER_PROTECTED');

    component.submit();
    http.expectOne(`${base}users`).flush({ code: 'CANNOT_CHANGE_SELF' }, { status: 400, statusText: 'Bad Request' });
    expect(component.errors().permissions).toBe('users.errors.CANNOT_CHANGE_SELF');
  });

  it('edit: a role/permission change asks first ("هيتعمله خروج من كل الأجهزة"), then PUT users/:id', async () => {
    await open(fakeUser('cashier', { _id: 'u7', name: 'محمود' }));
    component.chooseRole('accountant');
    component.submit();
    fixture.detectChanges();
    http.expectNone(`${base}users/u7`);
    expect(el().querySelector('[data-testid="logout-confirm"]')!.textContent).toContain('users.logoutEverywhere');
    component.submit();
    const req = http.expectOne(`${base}users/u7`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ name: 'محمود', role: 'accountant' });
    req.flush({ user: fakeUser('accountant', { _id: 'u7', name: 'محمود' }) });
  });

  it('edit: a name-only change saves without the logout warning', async () => {
    await open(fakeUser('cashier', { _id: 'u7', name: 'محمود' }));
    component.name.set('محمود سعيد');
    component.submit();
    const req = http.expectOne(`${base}users/u7`);
    expect(req.request.body).toEqual({ name: 'محمود سعيد', role: 'cashier' });
    req.flush({ user: fakeUser('cashier', { _id: 'u7', name: 'محمود سعيد' }) });
  });

  it('owner row (by the owner): name only; role and permissions fixed', async () => {
    await open(fakeUser('owner', { _id: 'o1' }));
    expect(el().querySelector('input[name="role"]')).toBeNull();
    expect(el().querySelector<HTMLInputElement>('input[data-perm="sales.create"]')!.disabled).toBeTrue();
    expect(component.buildPayload()).toEqual({ name: 'أحمد' });
  });
});
