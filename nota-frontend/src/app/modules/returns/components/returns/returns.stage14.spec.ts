import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { signInAs } from '../../../../core/auth/testing/sign-in';
import { ReturnsComponent } from './returns.component';

/** Stage 14: the cashier template records returns but cannot list them (returns.view). */
describe('ReturnsComponent permissions (Stage 14)', () => {
  const base = environment.api_base_url;

  const create = async (role: 'cashier' | 'accountant') => {
    await TestBed.configureTestingModule({
      imports: [ReturnsComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    signInAs(role);
    const fixture = TestBed.createComponent(ReturnsComponent);
    fixture.detectChanges();
    return { fixture, http: TestBed.inject(HttpTestingController) };
  };

  it('cashier: opens on the new-return wizard; no GET returns / summary; no "back to the log"', async () => {
    const { fixture, http } = await create('cashier');
    http.expectNone((r) => r.url.startsWith(`${base}returns`));
    expect(fixture.componentInstance.view).toBe('wizard');
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('returnsPage.s10.wizard.backToLog');
    http.verify();
  });

  it('accountant (returns.view, no returns.create): the log, without "new return"', async () => {
    const { fixture, http } = await create('accountant');
    http.match((r) => r.url.startsWith(`${base}returns`)).forEach((r) =>
      r.flush(r.request.url.endsWith('summary') ? {} : { success: true, data: [], pagination: { page: 1, limit: 10, totalItems: 0, totalPages: 0 } }));
    fixture.detectChanges();
    expect(fixture.componentInstance.view).toBe('log');
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('returnsPage.s10.newReturn');
  });
});
