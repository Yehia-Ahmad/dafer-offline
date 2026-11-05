import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../environments/environment';
import { FAKE_CATALOG, fakeUser } from '../../../core/auth/testing/auth-fixtures';
import { signInAs } from '../../../core/auth/testing/sign-in';
import { rowActions } from '../user-rules';
import { UsersPageComponent } from './users-page.component';

describe('UsersPageComponent (Stage 14)', () => {
  const base = environment.api_base_url;
  let fixture: ComponentFixture<UsersPageComponent>;
  let component: UsersPageComponent;
  let http: HttpTestingController;
  const owner = fakeUser('owner', { _id: 'o1' });
  const cashier = fakeUser('cashier', { _id: 'c1', name: 'محمود', permissionsEdited: true });
  const manager = fakeUser('manager', { _id: 'm1', name: 'منى', permissions: [...fakeUser('manager').permissions, 'users.manage'], permissionsEdited: true });
  const row = (username: string) => document.querySelector(`tr[data-user="${username}"]`)!;

  const load = async (me: 'owner' | 'manager') => {
    await TestBed.configureTestingModule({
      imports: [UsersPageComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    if (me === 'owner') signInAs('owner', { _id: 'o1' });
    else signInAs('manager', { _id: 'm1', permissions: manager.permissions, permissionsEdited: true });
    fixture = TestBed.createComponent(UsersPageComponent);
    component = fixture.componentInstance;
    http.expectOne(`${base}users`).flush({ users: [owner, manager, cashier] });
    http.expectOne(`${base}auth/permissions`).flush(FAKE_CATALOG);
    fixture.detectChanges();
  };

  afterEach(() => {
    http.verify();
    fixture?.destroy();
  });

  it('table: name, username, role with the "مخصصة" badge when edited, status, last login', async () => {
    await load('owner');
    expect(row('cashier').textContent).toContain('محمود');
    expect(row('cashier').textContent).toContain('كاشير');
    expect(row('cashier').querySelector('[data-testid="customized-badge"]')).not.toBeNull();
    expect(row('owner').querySelector('[data-testid="customized-badge"]')).toBeNull();
    expect(row('cashier').textContent).toContain('users.status.active');
  });

  it('owner row: only the owner sees edit; nobody gets disable or reset on it', async () => {
    await load('owner');
    expect(row('owner').querySelector('[data-action="edit"]')).not.toBeNull();
    expect(row('owner').querySelector('[data-action="toggle-status"]')).toBeNull();
    expect(row('owner').querySelector('[data-action="reset"]')).toBeNull();
    expect(rowActions(owner, manager)).toEqual({ edit: false, resetPassword: false, toggleStatus: false });
  });

  it('own row: no reset password (use "change my password") and no disable', async () => {
    await load('manager');
    expect(row('manager').querySelector('[data-action="reset"]')).toBeNull();
    expect(row('manager').querySelector('[data-action="toggle-status"]')).toBeNull();
    expect(row('manager').querySelector('[data-action="edit"]')).not.toBeNull();
    expect(row('owner').querySelector('[data-action="edit"]')).toBeNull();
    expect(row('cashier').querySelector('[data-action="reset"]')).not.toBeNull();
  });

  it('disable asks first and says "هيتعمله خروج من كل الأجهزة"; PATCH users/:id/status {isActive:false}', async () => {
    await load('owner');
    (row('cashier').querySelector('[data-action="toggle-status"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    http.expectNone(`${base}users/c1/status`);
    expect(document.querySelector('[data-testid="logout-note"]')!.textContent).toContain('users.logoutEverywhere');
    component.confirmDisable();
    const req = http.expectOne(`${base}users/c1/status`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ isActive: false });
    req.flush({ user: { ...cashier, isActive: false } });
    fixture.detectChanges();
    expect(row('cashier').textContent).toContain('users.status.disabled');
  });

  it('enable needs no confirmation', async () => {
    await load('owner');
    component.users.update((list) => list.map((user) => (user._id === 'c1' ? { ...user, isActive: false } : user)));
    fixture.detectChanges();
    (row('cashier').querySelector('[data-action="toggle-status"]') as HTMLButtonElement).click();
    const req = http.expectOne(`${base}users/c1/status`);
    expect(req.request.body).toEqual({ isActive: true });
    req.flush({ user: cashier });
  });

  it('reset password: POST users/:id/reset-password {newPassword}; mismatch sends nothing', async () => {
    await load('owner');
    component.askReset(cashier);
    component.resetPassword.set('reset-1234');
    component.resetConfirm.set('other-1234');
    component.confirmReset();
    http.expectNone(`${base}users/c1/reset-password`);
    component.resetConfirm.set('reset-1234');
    component.confirmReset();
    const req = http.expectOne(`${base}users/c1/reset-password`);
    expect(req.request.body).toEqual({ newPassword: 'reset-1234' });
    req.flush({ user: cashier });
    expect(component.resetTarget()).toBeNull();
  });
});
