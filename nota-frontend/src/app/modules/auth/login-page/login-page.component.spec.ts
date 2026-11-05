import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/auth/auth.service';
import { fakeUser, ROLE_PERMISSIONS } from '../../../core/auth/testing/auth-fixtures';
import { LoginPageComponent } from './login-page.component';

/** Stage 14: login, first run (main PC vs client PC), forgot password, recovery-code screen. */
describe('LoginPageComponent (Stage 14)', () => {
  const base = environment.api_base_url;
  let fixture: ComponentFixture<LoginPageComponent>;
  let component: LoginPageComponent;
  let http: HttpTestingController;
  let navigateByUrl: jasmine.Spy;
  const el = () => fixture.nativeElement as HTMLElement;
  const shop = { name: 'محل النور', logo: '' };

  const setup = async (query: Record<string, string> = {}) => {
    sessionStorage.clear();
    await TestBed.configureTestingModule({
      imports: [LoginPageComponent, TranslateModule.forRoot()],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations(),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    navigateByUrl = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
    fixture = TestBed.createComponent(LoginPageComponent);
    component = fixture.componentInstance;
  };

  // Template-driven controls are wired up in a microtask: wait before typing.
  const boot = async (info: { hasOwner: boolean; isLocal: boolean }) => {
    http.expectOne(`${base}auth/bootstrap`).flush({ ...info, shop });
    fixture.detectChanges();
    await fixture.whenStable();
  };
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
  };

  const type = (selector: string, value: string) => {
    const input = el().querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };

  const submit = (form: string) => {
    el().querySelector<HTMLFormElement>(`form[data-form="${form}"]`)!.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
  };

  afterEach(() => {
    http.verify();
    sessionStorage.clear();
  });

  it('shows the shop name from bootstrap, username + password + show/hide + "دخول", focuses the username', async () => {
    await setup();
    fixture.detectChanges();
    await boot({ hasOwner: true, isLocal: false });
    await new Promise((resolve) => setTimeout(resolve));
    expect(el().textContent).toContain('محل النور');
    expect(el().querySelector('#loginUser')).not.toBeNull();
    expect(el().querySelector<HTMLInputElement>('#loginPass')!.type).toBe('password');
    el().querySelector<HTMLButtonElement>('[data-action="toggle-password"]')!.click();
    fixture.detectChanges();
    expect(el().querySelector<HTMLInputElement>('#loginPass')!.type).toBe('text');
    expect(document.activeElement?.id).toBe('loginUser');
    // language and theme toggles
    expect(el().querySelectorAll('.nota-auth__segmented button').length).toBe(2);
  });

  it('Enter (form submit) sends POST auth/login and goes to the first allowed page', async () => {
    await setup();
    fixture.detectChanges();
    await boot({ hasOwner: true, isLocal: true });
    type('#loginUser', ' mahmoud ');
    type('#loginPass', 'secret-1');
    submit('login');
    const req = http.expectOne(`${base}auth/login`);
    expect(req.request.body).toEqual({ username: 'mahmoud', password: 'secret-1' });
    req.flush({ user: fakeUser('storekeeper'), token: 'tok-store', permissions: ROLE_PERMISSIONS.storekeeper });
    expect(navigateByUrl).toHaveBeenCalledWith('/products');
  });

  it('returnUrl (after a session expired) wins over the first allowed page; the "expired" notice shows', async () => {
    await setup({ reason: 'expired', returnUrl: '/customers/c1' });
    fixture.detectChanges();
    await boot({ hasOwner: true, isLocal: true });
    expect(el().querySelector('.nota-auth__notice')).not.toBeNull();
    type('#loginUser', 'owner');
    type('#loginPass', 'owner-pass');
    submit('login');
    http.expectOne(`${base}auth/login`).flush({ user: fakeUser('owner'), token: 'tok', permissions: ROLE_PERMISSIONS.owner });
    expect(navigateByUrl).toHaveBeenCalledWith('/customers/c1');
  });

  it('error per code: INVALID_CREDENTIALS, LOGIN_LOCKED (minutes)', async () => {
    await setup();
    fixture.detectChanges();
    await boot({ hasOwner: true, isLocal: true });
    type('#loginUser', 'x');
    type('#loginPass', 'bad-pass');
    submit('login');
    http.expectOne(`${base}auth/login`).flush({ code: 'INVALID_CREDENTIALS' }, { status: 401, statusText: 'Unauthorized' });
    fixture.detectChanges();
    expect(el().querySelector('[role="alert"]')!.textContent).toContain('auth.errors.INVALID_CREDENTIALS');
    expect(TestBed.inject(AuthService).signedIn()).toBeFalse();

    type('#loginPass', 'bad-pass');
    submit('login');
    http.expectOne(`${base}auth/login`).flush({ code: 'LOGIN_LOCKED', retryAfterSeconds: 240 }, { status: 429, statusText: 'Too Many' });
    fixture.detectChanges();
    expect(component.error()).toBe('auth.errors.LOGIN_LOCKED');
  });

  it('empty fields: no request', async () => {
    await setup();
    fixture.detectChanges();
    await boot({ hasOwner: true, isLocal: true });
    submit('login');
    http.expectNone(`${base}auth/login`);
    expect(component.fieldErrors()['username']).toBe('auth.validation.usernameRequired');
  });

  it('first run on the main PC (isLocal): owner form → POST setup-owner → recovery code shown once', async () => {
    await setup();
    fixture.detectChanges();
    await boot({ hasOwner: false, isLocal: true });
    expect(el().querySelector('form[data-form="setup"]')).not.toBeNull();
    type('#ownerName', 'أحمد');
    type('#ownerUser', 'ahmed');
    type('#ownerPass', 'owner-pass');
    type('#ownerConfirm', 'owner-pass');
    submit('setup');
    const req = http.expectOne(`${base}auth/setup-owner`);
    expect(req.request.body).toEqual({ name: 'أحمد', username: 'ahmed', password: 'owner-pass' });
    req.flush({ user: fakeUser('owner'), token: 'tok', permissions: ROLE_PERMISSIONS.owner, recoveryCode: 'ABCD-EFGH-JKLM-NPQR' });
    fixture.detectChanges();
    expect(el().querySelector('[data-testid="recovery-code"]')!.textContent).toBe('ABCD-EFGH-JKLM-NPQR');
  });

  it('first run: passwords that differ send nothing', async () => {
    await setup();
    fixture.detectChanges();
    await boot({ hasOwner: false, isLocal: true });
    type('#ownerName', 'أحمد');
    type('#ownerUser', 'ahmed');
    type('#ownerPass', 'owner-pass');
    type('#ownerConfirm', 'other-pass');
    submit('setup');
    http.expectNone(`${base}auth/setup-owner`);
    expect(component.fieldErrors()['confirm']).toBe('auth.validation.passwordMismatch');
  });

  it('first run on a client PC: the "no owner yet" message with retry, no form', async () => {
    await setup();
    fixture.detectChanges();
    await boot({ hasOwner: false, isLocal: false });
    expect(el().querySelector('[data-form="no-owner-client"]')!.textContent).toContain('auth.noOwnerClient.text');
    expect(el().querySelector('form')).toBeNull();
    el().querySelector<HTMLButtonElement>('[data-action="retry"]')!.click();
    await boot({ hasOwner: true, isLocal: false });
    expect(el().querySelector('form[data-form="login"]')).not.toBeNull();
  });

  it('recovery-code screen: "متابعة" stays disabled until the checkbox is ticked', async () => {
    await setup();
    fixture.detectChanges();
    await boot({ hasOwner: false, isLocal: true });
    component.ownerName.set('أحمد');
    component.username.set('ahmed');
    component.password.set('owner-pass');
    component.confirmPassword.set('owner-pass');
    component.setupOwner();
    http.expectOne(`${base}auth/setup-owner`).flush({ user: fakeUser('owner'), token: 'tok', permissions: ROLE_PERMISSIONS.owner, recoveryCode: 'ABCD-EFGH-JKLM-NPQR' });
    fixture.detectChanges();
    const cont = () => el().querySelector<HTMLButtonElement>('[data-action="continue"]')!;
    expect(cont().disabled).toBeTrue();
    cont().click();
    expect(navigateByUrl).not.toHaveBeenCalled();
    const ack = el().querySelector<HTMLInputElement>('[data-testid="ack"]')!;
    ack.checked = true;
    ack.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(cont().disabled).toBeFalse();
    cont().click();
    expect(navigateByUrl).toHaveBeenCalledWith('/home');
    // copy and print are offered
    expect(el().querySelector('[data-action="copy-code"]')).not.toBeNull();
    expect(el().querySelector('[data-action="print-code"]')).not.toBeNull();
  });

  it('forgot password on the main PC: POST recover → the new code, with "the old code no longer works"', async () => {
    await setup();
    fixture.detectChanges();
    await boot({ hasOwner: true, isLocal: true });
    el().querySelector<HTMLButtonElement>('[data-action="forgot"]')!.click();
    await settle();
    type('#recUser', 'ahmed');
    type('#recCode', 'abcd-efgh-jklm-npqr');
    type('#recPass', 'new-pass-1');
    type('#recConfirm', 'new-pass-1');
    submit('recover');
    const req = http.expectOne(`${base}auth/recover`);
    expect(req.request.body).toEqual({ username: 'ahmed', recoveryCode: 'abcd-efgh-jklm-npqr', newPassword: 'new-pass-1' });
    req.flush({ user: fakeUser('owner'), token: 'tok', permissions: ROLE_PERMISSIONS.owner, recoveryCode: 'WXYZ-WXYZ-WXYZ-WXYZ' });
    fixture.detectChanges();
    expect(el().querySelector('[data-testid="recovery-code"]')!.textContent).toBe('WXYZ-WXYZ-WXYZ-WXYZ');
    expect(el().textContent).toContain('auth.recoveryCode.oldCodeInvalid');
  });

  it('forgot password on a client PC: a message to use the main PC, no form', async () => {
    await setup();
    fixture.detectChanges();
    await boot({ hasOwner: true, isLocal: false });
    el().querySelector<HTMLButtonElement>('[data-action="forgot"]')!.click();
    fixture.detectChanges();
    expect(el().querySelector('form[data-form="recover"]')).toBeNull();
    expect(el().querySelector('[data-form="recover-client"]')!.textContent).toContain('auth.recover.clientText');
  });

  it('a wrong recovery code shows INVALID_RECOVERY', async () => {
    await setup();
    fixture.detectChanges();
    await boot({ hasOwner: true, isLocal: true });
    component.openRecover();
    component.username.set('ahmed');
    component.recoveryCode.set('AAAA-AAAA-AAAA-AAAA');
    component.password.set('new-pass-1');
    component.confirmPassword.set('new-pass-1');
    component.recover();
    http.expectOne(`${base}auth/recover`).flush({ code: 'INVALID_RECOVERY' }, { status: 401, statusText: 'Unauthorized' });
    expect(component.error()).toBe('auth.errors.INVALID_RECOVERY');
    expect(component.view()).toBe('recover');
  });

  it('backend unreachable: a retry screen', async () => {
    await setup();
    fixture.detectChanges();
    http.expectOne(`${base}auth/bootstrap`).error(new ProgressEvent('error'));
    fixture.detectChanges();
    expect(component.view()).toBe('unreachable');
  });
});
