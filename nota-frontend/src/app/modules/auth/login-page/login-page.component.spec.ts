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

/** Stage 14: sign in. The owner is created on the server (npm run create-owner), so there is no owner form here. */
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
  const boot = async (info: { hasOwner: boolean }) => {
    http.expectOne(`${base}auth/bootstrap`).flush({ ...info, shop });
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
    await boot({ hasOwner: true });
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
    await boot({ hasOwner: true });
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
    await boot({ hasOwner: true });
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
    await boot({ hasOwner: true });
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
    await boot({ hasOwner: true });
    submit('login');
    http.expectNone(`${base}auth/login`);
    expect(component.fieldErrors()['username']).toBe('auth.validation.usernameRequired');
  });

  it('no owner yet: a message to create it on the server, with retry, and no form', async () => {
    await setup();
    fixture.detectChanges();
    await boot({ hasOwner: false });
    expect(el().querySelector('[data-form="no-owner"]')!.textContent).toContain('auth.noOwner.text');
    expect(el().querySelector('form')).toBeNull();
    el().querySelector<HTMLButtonElement>('[data-action="retry"]')!.click();
    await boot({ hasOwner: true });
    expect(el().querySelector('form[data-form="login"]')).not.toBeNull();
  });

  it('there is no owner setup or password recovery from the login screen', async () => {
    await setup();
    fixture.detectChanges();
    await boot({ hasOwner: true });
    expect(el().querySelector('[data-action="forgot"]')).toBeNull();
    expect('setupOwner' in component).toBeFalse();
    expect('recover' in component).toBeFalse();
  });

  it('backend unreachable: a retry screen', async () => {
    await setup();
    fixture.detectChanges();
    http.expectOne(`${base}auth/bootstrap`).error(new ProgressEvent('error'));
    fixture.detectChanges();
    expect(component.view()).toBe('unreachable');
  });
});
