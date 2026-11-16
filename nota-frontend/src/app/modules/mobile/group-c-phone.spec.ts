import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { LayoutService } from '../../core/layout/layout.service';
import { signInAs, signInWith } from '../../core/auth/testing/sign-in';
import { flushPaymentBoxes } from '../cashbox/testing/payment-boxes.testing';
import { PurchaseFormComponent } from '../purchases/purchase-form.component';
import { provideFakeVat } from '../shop-profile/services/vat-settings.testing';
import { CategoryToolsComponent } from '../category/components/category-tools/category-tools.component';

/** Online Stage 6B, group C: the phone templates over the same components. */
const phone = (mobile: boolean) => ({ provide: LayoutService, useValue: { isMobile: signal(mobile) } });
const base = environment.api_base_url;
const digits = (value: string) => value.replace(/[^\d٠-٩]/g, '');

const SUPPLIER = { _id: 's1', name: 'مورد', phones: [], isActive: true, paymentTermsDays: 30, balance: 4200, openingAmount: 4200, ledgerAccountId: 'acc21' };
const LED = { _id: 'p-led', name: 'لمبة', code: 'LED12', inventoryCount: 32, purchasePrice: 70 };
const CHARGER = { _id: 'p-chg', name: 'شاحن', code: 'CHG25', inventoryCount: 13, purchasePrice: 240 };

describe('new purchase on the phone (Online Stage 6B)', () => {
  async function render(mobile: boolean): Promise<{ total: string; grand: number; cards: number; rows: number }> {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [PurchaseFormComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations(), provideFakeVat(), phone(mobile),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({}), queryParamMap: convertToParamMap({}) } } }],
    }).compileComponents();
    signInAs('owner');
    const http = TestBed.inject(HttpTestingController);
    const fixture: ComponentFixture<PurchaseFormComponent> = TestBed.createComponent(PurchaseFormComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${base}suppliers`).flush([SUPPLIER]);
    flushPaymentBoxes(http);
    const component = fixture.componentInstance;
    const add = (product: typeof LED, qty: number, price: number) => {
      component.addProduct(product);
      const row = component.lines().find((line) => line.product._id === product._id)!;
      component.setLine(row.key, 'qty', qty);
      component.setLine(row.key, 'unitPrice', price);
    };
    component.supplierId.set('s1');
    add(LED, 20, 70);
    add(CHARGER, 10, 240);
    component.discount.set(100);
    component.otherCosts.set(50);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return {
      total: digits(el.querySelector('[data-test="total"]')?.textContent ?? ''),
      grand: component.grandTotal(),
      cards: el.querySelectorAll('.m-card[data-line]').length,
      rows: el.querySelectorAll('tr[data-line]').length,
    };
  }

  it('shows the same total as the desktop layout for the same lines (lines are cards, not table rows)', async () => {
    const desktop = await render(false);
    const mobile = await render(true);
    expect(desktop.grand).toBe(3750); // 20 × 70 + 10 × 240 − 100 + 50
    expect(mobile.grand).toBe(desktop.grand);
    expect(mobile.total).toBe(desktop.total);
    expect(desktop.rows).toBe(2);
    expect(mobile.rows).toBe(0);
    expect(mobile.cards).toBe(2);
  });
});

describe('category page on the phone (Online Stage 6B)', () => {
  it('the red delete button of the edit page closes it and asks in the delete confirmation', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [CategoryToolsComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations(), phone(true)],
    }).overrideComponent(CategoryToolsComponent, { set: { template: '', imports: [] } }).compileComponents();
    signInAs('owner');
    const component = TestBed.createComponent(CategoryToolsComponent).componentInstance;
    const category = { id: 'c1', label: 'لمبات', category: { name: 'لمبات' } };
    component.editingCategory = category;
    component.visible = true;
    component.removeFromPage();
    expect(component.visible).toBeFalse();
    expect(component.deleteCategoryVisible).toBeTrue();
    expect(component.categoryToDelete).toBe(category);
  });
});

describe('category delete on the phone follows the desktop rule (Online Stage 6B)', () => {
  async function deleteButtonShown(permissions: string[], editingId: string, openCategoryId: string): Promise<boolean> {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [CategoryToolsComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations(), phone(true)],
    }).compileComponents();
    signInWith(permissions);
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(CategoryToolsComponent);
    fixture.componentRef.setInput('openCategoryId', openCategoryId);
    fixture.detectChanges();
    http.match(() => true).forEach((request) => request.flush([]));
    const component = fixture.componentInstance;
    component.editingCategory = { id: editingId, label: 'لمبات', category: { name: 'لمبات' } };
    component.visible = true;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const found = document.querySelector('[data-action="delete-category"]') !== null;
    component.visible = false;
    fixture.detectChanges();
    return found;
  }

  it('shows "حذف الفئة" only for a category that is not the open one, and only with categories.manage + products.manage', async () => {
    const both = ['categories.manage', 'products.manage'];
    expect(await deleteButtonShown(both, 'c1', 'c2')).toBeTrue();       // another category is open: deletable
    expect(await deleteButtonShown(both, 'c1', '')).toBeTrue();         // "كل الأصناف": deletable
    expect(await deleteButtonShown(both, 'c1', 'c1')).toBeFalse();      // the open category: hidden (same as the desktop list)
    expect(await deleteButtonShown(['categories.manage'], 'c1', 'c2')).toBeFalse();
    expect(await deleteButtonShown(['products.manage'], 'c1', 'c2')).toBeFalse();
  });
});
