import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { signInAs } from '../../../../core/auth/testing/sign-in';
import { CustomersComponent } from './customers.component';

/** Online Stage 4: courier accounts carry a "مندوب" label in the customers list. */
describe('CustomersComponent: courier label (Online Stage 4)', () => {
  it('a courier account shows the label; an ordinary customer does not', () => {
    TestBed.configureTestingModule({
      imports: [CustomersComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    });
    signInAs('owner');
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(CustomersComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${environment.api_base_url}customers` && r.method === 'GET').flush([
      { _id: 'c1', name: 'منى', phone: '0111', isIndebted: false },
      { _id: 'c2', name: 'مندوب – أحمد', phone: '0100', isIndebted: true, isCourier: true },
    ]);
    fixture.detectChanges();
    const badges = Array.from(fixture.nativeElement.querySelectorAll('tbody tr')).map((row) => !!(row as HTMLElement).querySelector('[data-test="courier-badge"]'));
    expect(badges).toEqual([false, true]);
    http.verify();
  });
});
