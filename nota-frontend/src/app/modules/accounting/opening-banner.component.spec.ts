import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/auth/auth.service';
import { NotaCanDirective } from '../../core/auth/nota-can.directive';
import { OpeningBannerComponent } from './opening-banner.component';

const base = environment.api_base_url;

/** The dashboard's own wiring: the banner only for users who hold both permissions. */
@Component({
  standalone: true,
  imports: [OpeningBannerComponent, NotaCanDirective],
  template: `<app-opening-banner *notaCan="['accounting.manage', 'accounting.view']" />`,
})
class HostComponent {}

describe('OpeningBannerComponent (dashboard banner)', () => {
  let http: HttpTestingController;

  const setup = (permissions: string[]) => {
    TestBed.configureTestingModule({
      imports: [HostComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    const auth = TestBed.inject(AuthService);
    spyOn(auth, 'hasAll').and.callFake((...keys: string[]) => keys.every((key) => permissions.includes(key)));
    spyOn(auth, 'hasAny').and.callFake((...keys: string[]) => keys.some((key) => permissions.includes(key)));
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return fixture;
  };

  it('shows "لسه مسجلتش رصيد بداية المحل" while the status is setup, with a link to the wizard', async () => {
    const fixture = setup(['accounting.manage', 'accounting.view']);
    http.expectOne(`${base}accounting/opening`).flush({ status: 'setup' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const banner = fixture.nativeElement.querySelector('[data-test="opening-banner"]');
    expect(banner).toBeTruthy();
    expect(banner.querySelector('[data-action="open-wizard"]').getAttribute('href')).toBe('/accounting/opening');
    http.verify();
  });

  it('is hidden once the opening is finalized', async () => {
    const fixture = setup(['accounting.manage', 'accounting.view']);
    http.expectOne(`${base}accounting/opening`).flush({ status: 'finalized' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-test="opening-banner"]')).toBeNull();
    http.verify();
  });

  it('is not shown, and sends no request, to a user without accounting.manage', () => {
    const fixture = setup(['accounting.view']);
    expect(fixture.nativeElement.querySelector('app-opening-banner')).toBeNull();
    http.expectNone(`${base}accounting/opening`);
  });

  it('shows nothing when the request fails', () => {
    const fixture = setup(['accounting.manage', 'accounting.view']);
    http.expectOne(`${base}accounting/opening`).flush({}, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-test="opening-banner"]')).toBeNull();
  });
});
