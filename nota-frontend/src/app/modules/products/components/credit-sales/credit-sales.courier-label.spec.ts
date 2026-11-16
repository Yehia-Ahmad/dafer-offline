import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { provideFakeVat } from '../../../shop-profile/services/vat-settings.testing';
import { CreditSalesComponent } from './credit-sales.component';

/** Online Stage 4: a courier's customer account shows a "مندوب" label in the customer picker and is listed after real customers. */
describe('CreditSalesComponent: courier accounts in the customer picker (Online Stage 4)', () => {
  let fixture: any;
  let component: any;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CreditSalesComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(), provideFakeVat()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CreditSalesComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  it('couriers come last (each group keeps the server order) and carry the label', () => {
    component.onCustomerSearchInputChange({ target: { value: 'م' } } as unknown as Event);
    http.expectOne((r) => r.url === `${environment.api_base_url}customers`).flush([
      { _id: 'c1', name: 'مندوب – أحمد', phone: '0100', isCourier: true },
      { _id: 'c2', name: 'منى', phone: '0111' },
      { _id: 'c3', name: 'مندوب – سعد', phone: '0101', isCourier: true },
      { _id: 'c4', name: 'محمود', phone: '0122' },
    ]);
    expect(component.customerOptions.map((option: any) => option.id)).toEqual(['c2', 'c4', 'c1', 'c3']);
    component.showCustomerSuggestionPanel = true;
    fixture.detectChanges();
    const items: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('.nota-ac__item'));
    expect(items.map((item) => !!item.querySelector('[data-test="courier-badge"]'))).toEqual([false, false, true, true]);
  });
});
