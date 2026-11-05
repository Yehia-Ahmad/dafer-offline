import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../environments/environment';
import { fakeUser, ROLE_PERMISSIONS } from '../../../core/auth/testing/auth-fixtures';
import { signInAs } from '../../../core/auth/testing/sign-in';
import { ChangePasswordDialogComponent } from './change-password-dialog.component';
import { AuthService } from '../../../core/auth/auth.service';

describe('ChangePasswordDialogComponent (Stage 14)', () => {
  const base = environment.api_base_url;
  let http: HttpTestingController;
  let component: ChangePasswordDialogComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChangePasswordDialogComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    signInAs('cashier');
    component = TestBed.createComponent(ChangePasswordDialogComponent).componentInstance;
    component.open.set(true);
  });

  afterEach(() => http.verify());

  it('POST auth/change-password {currentPassword, newPassword}; stays signed in with the new token; closes', () => {
    component.current.set('old-pass');
    component.next.set('new-pass-1');
    component.confirm.set('new-pass-1');
    component.submit();
    const req = http.expectOne(`${base}auth/change-password`);
    expect(req.request.body).toEqual({ currentPassword: 'old-pass', newPassword: 'new-pass-1' });
    req.flush({ user: fakeUser('cashier'), token: 'new-token-123', permissions: ROLE_PERMISSIONS.cashier });
    expect(TestBed.inject(AuthService).token()).toBe('new-token-123');
    expect(TestBed.inject(AuthService).signedIn()).toBeTrue();
    expect(component.open()).toBeFalse();
  });

  it('confirm mismatch or a short password: nothing is sent', () => {
    component.current.set('old-pass');
    component.next.set('abc');
    component.confirm.set('abd');
    component.submit();
    http.expectNone(`${base}auth/change-password`);
    expect(component.fieldErrors().next).toBe('auth.validation.passwordLength');
    expect(component.fieldErrors().confirm).toBe('auth.validation.passwordMismatch');
  });

  it('WRONG_PASSWORD → error on the current-password field; still signed in with the old token', () => {
    component.current.set('wrong');
    component.next.set('new-pass-1');
    component.confirm.set('new-pass-1');
    component.submit();
    http.expectOne(`${base}auth/change-password`).flush({ code: 'WRONG_PASSWORD' }, { status: 400, statusText: 'Bad Request' });
    expect(component.fieldErrors().current).toBe('auth.errors.WRONG_PASSWORD');
    expect(component.open()).toBeTrue();
    expect(TestBed.inject(AuthService).token()).toBe('test-token-cashier');
  });
});
