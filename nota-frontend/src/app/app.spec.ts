import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter, Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { App } from './app';
import { signInAs } from './core/auth/testing/sign-in';

@Component({ template: '<p class="page">page</p>' })
class PageStub {}

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App, TranslateModule.forRoot()],
      providers: [
        provideRouter([
          { path: 'selling', component: PageStub },
          { path: 'returns', component: PageStub },
          { path: 'ui-kit', component: PageStub, data: { frame: false } },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideNoopAnimations(),
      ],
    }).compileComponents();
  });

  it('should create the app', () => {
    signInAs('owner'); // Stage 14: as the owner, every action shows as before
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render the router outlet', () => {
    signInAs('owner'); // Stage 14: as the owner, every action shows as before
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('router-outlet')).not.toBeNull();
  });

  it('should set <html lang dir> at startup', () => {
    signInAs('owner'); // Stage 14: as the owner, every action shows as before
    TestBed.createComponent(App);
    const root = document.documentElement;
    expect(root.dir).toBe(root.lang === 'ar' ? 'rtl' : 'ltr');
  });

  it('renders the frame once around the page; data.frame === false renders the page alone', async () => {
    signInAs('owner'); // Stage 14: as the owner, every action shows as before
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    const el = fixture.nativeElement as HTMLElement;

    await router.navigateByUrl('/selling');
    fixture.detectChanges();
    // Stage 15: the signed-in window reads the shop's auto-lock setting once.
    TestBed.inject(HttpTestingController).expectOne((r) => r.url.endsWith('shop-profile')).flush({ autoLockMinutes: 10 });
    await fixture.whenStable();
    expect(el.querySelectorAll('app-side-nav').length).toBe(1);
    expect(el.querySelector('.nota-shell__content .page')).not.toBeNull();

    // The sidebar stays mounted across navigation: one categories request, not one per page.
    await router.navigateByUrl('/returns');
    fixture.detectChanges();
    await fixture.whenStable();
    const http = TestBed.inject(HttpTestingController);
    expect(http.match((r) => r.url.endsWith('categories')).length).toBe(1);

    await router.navigateByUrl('/ui-kit');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('app-side-nav')).toBeNull();
    expect(el.querySelector('.page')).not.toBeNull();
  });
});
