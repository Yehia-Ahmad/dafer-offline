import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { CatalogStateService } from '../../layout/nav/catalog-state.service';
import { signInAs } from '../../../core/auth/testing/sign-in';
import { SellingComponent } from './selling/selling.component';
import { CreditSalesComponent } from './credit-sales/credit-sales.component';

/**
 * Stage 14: the invoice discount needs sales.discount (cash and credit). Without it the POS and the
 * new credit sale show the permission-locked pattern and the discount stays 0 (which never needs
 * the permission on the server). There is no invoice edit screen in the frontend (STEP 0.4).
 */
describe('Stage 14 — discount lock', () => {
  const render = async (component: typeof SellingComponent | typeof CreditSalesComponent, role: 'cashier' | 'manager') => {
    await TestBed.configureTestingModule({
      imports: [component, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    TestBed.inject(CatalogStateService).categories.set([]);
    signInAs(role);
    const fixture = TestBed.createComponent(component as typeof SellingComponent);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).match(() => true).forEach((r) => r.flush([]));
    fixture.detectChanges();
    return fixture;
  };

  it('POS as a cashier: no discount input, the locked note; discount stays 0', async () => {
    const fixture = await render(SellingComponent, 'cashier');
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#posDiscount')).toBeNull();
    expect(el.querySelector('[data-testid="discount-locked"]')!.textContent).toContain('auth.locked.discount');
    expect(fixture.componentInstance.sellingForm.get('discountAmount')!.value).toBe(0);
    expect(fixture.componentInstance.invoiceDiscountAmount).toBe(0);
  });

  it('POS as a manager (sales.discount): the discount input as before', async () => {
    const fixture = await render(SellingComponent, 'manager');
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#posDiscount')).not.toBeNull();
    expect(el.querySelector('[data-testid="discount-locked"]')).toBeNull();
  });

  it('new credit sale as a cashier: locked; as a manager: the input', async () => {
    let fixture = await render(CreditSalesComponent as never, 'cashier');
    let el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#csDiscount')).toBeNull();
    expect(el.querySelector('[data-testid="discount-locked"]')).not.toBeNull();
    TestBed.resetTestingModule();
    fixture = await render(CreditSalesComponent as never, 'manager');
    el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#csDiscount')).not.toBeNull();
  });
});
