import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { OpeningWizardComponent, computeReview, isMoney } from './opening-wizard.component';
import { OpeningState } from './opening.service';
import { LanguageService } from '../shared/services/translation.service';

const base = environment.api_base_url;

const stateOf = (overrides: Partial<OpeningState> = {}, figures: Partial<OpeningState['figures']> = {}): OpeningState => ({
  status: 'setup', setupMode: true, ledgerStartAt: '2026-11-05T08:00:00.000Z', finalizedAt: null, savedAt: null, entry: null,
  figures: { cash: 0, banks: [], fixedAssets: 0, inventory: { mode: 'live', editable: true, amount: 0, stockValue: 0 }, customers: [], suppliers: [], carriedCustomers: [], ...figures },
  totals: { cash: 0, banks: 0, inventory: 0, fixedAssets: 0, customers: 0, customerCredits: 0, suppliers: 0, supplierDebits: 0, assets: 0, liabilities: 0, capital: 0 },
  ...overrides,
});

describe('computeReview (the review arithmetic)', () => {
  const design = { cash: 15000, banks: [30000], fixedAssets: 0, inventory: 84200, customers: [4000, 2300], carriedCustomers: [], suppliers: [6650, 1850] };

  it('the design numbers: 135,500 − 8,500 = capital 127,000', () => {
    const totals = computeReview(design);
    expect(totals.assets).toBe(135500);
    expect(totals.liabilities).toBe(8500);
    expect(totals.capital).toBe(127000);
  });

  it('a negative customer is a liability and a negative supplier is an asset; carried invoice balances count as customers', () => {
    const totals = computeReview({ ...design, customers: [4000, -300], carriedCustomers: [200], suppliers: [6650, -200] });
    expect(totals.customers).toBe(4200);
    expect(totals.customerCredits).toBe(300);
    expect(totals.supplierAdvances).toBe(200);
    expect(totals.assets).toBe(15000 + 30000 + 84200 + 4200 + 200);
    expect(totals.liabilities).toBe(6650 + 300);
    expect(totals.capital).toBe(totals.assets - totals.liabilities);
  });

  it('capital can be negative', () => {
    expect(computeReview({ cash: 0, banks: [], fixedAssets: 0, inventory: 0, customers: [], carriedCustomers: [], suppliers: [500] }).capital).toBe(-500);
  });

  it('isMoney accepts up to two decimals only', () => {
    expect(isMoney(10.25)).toBeTrue();
    expect(isMoney(10.255)).toBeFalse();
    expect(isMoney(null)).toBeFalse();
    expect(isMoney(NaN)).toBeFalse();
  });
});

describe('OpeningWizardComponent', () => {
  let fixture: ComponentFixture<OpeningWizardComponent>;
  let component: OpeningWizardComponent;
  let http: HttpTestingController;

  const products = [
    { _id: 'p1', code: 'PNL-24', name: 'بانل', inventoryCount: 10, purchasePrice: 100 },
    { _id: 'p2', code: 'CBL-2', name: 'سلك', inventoryCount: 0, purchasePrice: 5 },
    { _id: 'p3', code: 'CHG-1', name: 'شاحن', inventoryCount: 4, purchasePrice: 50 },
  ];

  const text = (selector: string) => (fixture.nativeElement.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const click = (selector: string) => { (fixture.nativeElement.querySelector(selector) as HTMLElement).click(); fixture.detectChanges(); };
  const type = (selector: string, value: string) => {
    const input = fixture.nativeElement.querySelector(selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };

  /** Creates the component and answers its requests. `state` is the GET /accounting/opening answer. */
  const open = async (state: OpeningState, productRows = products) => {
    fixture = TestBed.createComponent(OpeningWizardComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne(`${base}accounting/opening`).flush(state);
    http.expectOne((req) => req.url === `${base}customers`).flush([{ _id: 'c1', name: 'أحمد', phone: '0100' }, { _id: 'c2', name: 'منى', phone: '0101' }]);
    http.expectOne((req) => req.url === `${base}suppliers`).flush([{ _id: 's1', name: 'مورد 1' }]);
    if (state.setupMode) {
      const req = http.expectOne((r) => r.url === `${base}products`);
      expect(req.request.params.get('limit')).toBe('100');
      req.flush({ data: productRows, pagination: { page: 1, totalPages: 1, hasNextPage: false } });
    }
    await settle();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [OpeningWizardComponent, TranslateModule.forRoot()], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(LanguageService).selectedLanguage.set('en');
  });

  afterEach(() => http.verify());

  it('shows the five steps and starts on the cash step', async () => {
    await open(stateOf());
    expect(fixture.nativeElement.querySelectorAll('[data-step]').length).toBe(5);
    expect(fixture.nativeElement.querySelector('[data-test="step-cash"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-step="1"]').getAttribute('aria-current')).toBe('step');
  });

  it('cash step: validates amounts (2 decimals, not negative) and blocks next until valid', async () => {
    await open(stateOf());
    type('[data-field="cash"]', '10.255');
    expect(component.cashValid).toBeFalse();
    expect((fixture.nativeElement.querySelector('[data-action="next"]') as HTMLButtonElement).disabled).toBeTrue();
    type('[data-field="cash"]', '-5');
    expect(component.cashValid).toBeFalse();
    type('[data-field="cash"]', '15000');
    expect(component.cashValid).toBeTrue();
    expect((fixture.nativeElement.querySelector('[data-action="next"]') as HTMLButtonElement).disabled).toBeFalse();
  });

  it('cash step: a new bank or wallet needs a name once it has an amount', async () => {
    await open(stateOf());
    click('[data-action="add-bank"]');
    click('[data-action="add-wallet"]');
    expect(component.banks.map((row) => row.type)).toEqual(['bank', 'wallet']);
    type('[data-bank="0"] [data-field="bank-amount"]', '30000');
    expect(component.banksValid).toBeFalse();
    type('[data-bank="0"] [data-field="bank-name"]', 'بنك مصر');
    expect(component.banksValid).toBeTrue();
    expect(component.review.banks).toBe(30000);
  });

  it('inventory step in setup mode: a table of products with stock, editable, with a live total and links to add and import', async () => {
    await open(stateOf({}, { inventory: { mode: 'live', editable: true, amount: 1200, stockValue: 1200 } }));
    click('[data-step="2"]');
    const rows = fixture.nativeElement.querySelectorAll('[data-test="inventory-table"] tbody tr');
    expect(rows.length).toBe(2); // the product without stock is not listed
    expect(text('[data-test="inventory-total"]')).toContain('1,200');
    type('[data-product="PNL-24"] [data-field="qty"]', '20');
    expect(component.inventoryTotal).toBe(2200);
    type('[data-product="CHG-1"] [data-field="price"]', '60');
    expect(component.inventoryTotal).toBe(2240);
    expect(fixture.nativeElement.querySelector('[data-action="add-products"]').getAttribute('href')).toBe('/products/new');
    expect(fixture.nativeElement.querySelector('[data-action="import-excel"]').getAttribute('href')).toBe('/products');
  });

  it('inventory edits go through the normal product update, one request per edited product, before the next step', async () => {
    await open(stateOf({}, { inventory: { mode: 'live', editable: true, amount: 1200, stockValue: 1200 } }));
    click('[data-step="2"]');
    type('[data-product="PNL-24"] [data-field="qty"]', '20');
    type('[data-product="CHG-1"] [data-field="price"]', '60');
    click('[data-action="next"]');
    const first = http.expectOne(`${base}products/p1`);
    expect(first.request.method).toBe('PUT');
    expect(first.request.body).toEqual({ inventoryCount: 20, purchasePrice: 100 });
    first.flush({});
    await settle();
    const second = http.expectOne(`${base}products/p3`);
    expect(second.request.body).toEqual({ inventoryCount: 4, purchasePrice: 60 });
    second.flush({});
    await settle();
    expect(component.step).toBe(3);
    expect(component.dirtyInventoryRows.length).toBe(0);
  });

  it('inventory step outside setup mode is read-only and shows the inventory carried in the opening entry', async () => {
    await open(stateOf({ setupMode: false }, { inventory: { mode: 'carried', editable: false, amount: 160 } }));
    click('[data-step="2"]');
    expect(fixture.nativeElement.querySelector('[data-test="inventory-table"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-test="inventory-readonly"]')).toBeTruthy();
    expect(text('[data-test="inventory-total"]')).toContain('160');
    expect(fixture.nativeElement.querySelector('[data-field="qty"]')).toBeNull();
    expect(component.inventoryEditable).toBeFalse();
  });

  it('customers step: shows the opening date, picks an existing customer and creates one inline', async () => {
    await open(stateOf());
    click('[data-step="3"]');
    expect(text('[data-test="opening-date"]')).toContain('2026');
    expect(fixture.nativeElement.querySelector('[data-test="customers-empty"]')).toBeTruthy();
    component.pickCustomerId = 'c1';
    component.addCustomerRow();
    fixture.detectChanges();
    expect(component.customers.map((row) => row.name)).toEqual(['أحمد']);
    expect(component.availableCustomerOptions.map((row) => row._id)).toEqual(['c2']);
    type('[data-field="new-customer-name"]', 'سامي');
    type('[data-field="new-customer-phone"]', '01234');
    click('[data-action="create-customer"]');
    const req = http.expectOne(`${base}customers`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ name: 'سامي', phone: '01234' });
    req.flush({ _id: 'c9', name: 'سامي', phone: '01234' });
    await settle();
    expect(component.customers.map((row) => row.id)).toEqual(['c1', 'c9']);
    type('[data-customer="أحمد"] [data-field="customer-amount"]', '4000');
    type('[data-customer="سامي"] [data-field="customer-amount"]', '-300');
    expect(component.review.customers).toBe(4000);
    expect(component.review.customerCredits).toBe(300);
  });

  it('customers step: a customer cannot be added twice and a new customer needs a name and phone', async () => {
    await open(stateOf());
    click('[data-step="3"]');
    component.pickCustomerId = 'c1'; component.addCustomerRow();
    component.pickCustomerId = 'c1'; component.addCustomerRow();
    expect(component.customers.length).toBe(1);
    expect(component.partyError).toBe('openingWizard.customers.duplicate');
    component.createCustomerRow();
    expect(component.partyError).toBe('openingWizard.customers.nameAndPhone');
  });

  it('suppliers step: picks an existing supplier and creates one inline; negative means an advance', async () => {
    await open(stateOf());
    click('[data-step="4"]');
    component.pickSupplierId = 's1';
    component.addSupplierRow();
    fixture.detectChanges();
    type('[data-field="new-supplier-name"]', 'مورد جديد');
    click('[data-action="create-supplier"]');
    const req = http.expectOne(`${base}suppliers`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ name: 'مورد جديد', phone: '' });
    req.flush({ _id: 's2', name: 'مورد جديد' });
    await settle();
    type('[data-supplier="مورد 1"] [data-field="supplier-amount"]', '6650');
    type('[data-supplier="مورد جديد"] [data-field="supplier-amount"]', '-200');
    expect(component.review.suppliers).toBe(6650);
    expect(component.review.supplierAdvances).toBe(200);
  });

  it('review: the capital formula, the totals and the buttons that wait for the confirm checkbox', async () => {
    await open(stateOf({}, { inventory: { mode: 'live', editable: true, amount: 84200, stockValue: 84200 } }));
    component.cash = 15000;
    component.banks = [{ name: 'بنك مصر', type: 'bank', amount: 30000 }];
    component.customers = [{ id: 'c1', name: 'أحمد', amount: 6300 }];
    component.suppliers = [{ id: 's1', name: 'مورد 1', amount: 8500 }];
    component.inventoryRows = [{ id: 'p1', code: 'X', name: 'x', quantity: 842, price: 100, originalQuantity: 842, originalPrice: 100 }];
    click('[data-step="5"]');
    expect(text('[data-test="total-assets"]')).toContain('135,500');
    expect(text('[data-test="total-liabilities"]')).toContain('8,500');
    expect(text('[data-test="capital-value"]')).toContain('127,000');
    expect(text('[data-test="capital-formula"]')).toContain('135,500');
    expect(text('[data-test="capital-formula"]')).toContain('8,500');
    expect((fixture.nativeElement.querySelector('[data-action="save"]') as HTMLButtonElement).disabled).toBeTrue();
    expect((fixture.nativeElement.querySelector('[data-action="finalize"]') as HTMLButtonElement).disabled).toBeTrue();
    click('[data-field="confirm"]');
    expect((fixture.nativeElement.querySelector('[data-action="save"]') as HTMLButtonElement).disabled).toBeFalse();
    expect((fixture.nativeElement.querySelector('[data-action="finalize"]') as HTMLButtonElement).disabled).toBeTrue();
  });

  it('save posts the amounts: zero rows dropped, existing bank accounts by id, new ones by name and type', async () => {
    await open(stateOf({}, { banks: [{ accountId: 'a1', code: '1121', name: 'بنك قديم', kind: 'bank', amount: 100 }] }));
    component.cash = 15000;
    component.fixedAssets = 500;
    component.banks = [...component.banks, { name: ' محفظة ', type: 'wallet', amount: 25.5 }];
    component.customers = [{ id: 'c1', name: 'أحمد', amount: 4000 }, { id: 'c2', name: 'منى', amount: 0 }];
    component.suppliers = [{ id: 's1', name: 'مورد 1', amount: -200 }];
    expect(component.buildPayload()).toEqual({
      cash: 15000, fixedAssets: 500,
      banks: [{ accountId: 'a1', amount: 100 }, { name: 'محفظة', type: 'wallet', amount: 25.5 }],
      customers: [{ customerId: 'c1', amount: 4000 }],
      suppliers: [{ supplierId: 's1', amount: -200 }],
    });
    component.confirmed = true;
    component.save();
    const saveReq: TestRequest = http.expectOne(`${base}accounting/opening`);
    expect(saveReq.request.method).toBe('POST');
    expect(saveReq.request.body.cash).toBe(15000);
    saveReq.flush({ ...stateOf({ savedAt: '2026-11-05T09:00:00.000Z', entry: { _id: 'e1', number: 'OB-000002' } }), number: 'OB-000002' });
    await settle();
    expect(component.savedNumber).toBe('OB-000002');
    expect(component.saving).toBeFalse();
  });

  it('save error OPENING_BELOW_COLLECTED names the customer and the collected amount', async () => {
    await open(stateOf());
    component.confirmed = true;
    component.save();
    http.expectOne(`${base}accounting/opening`).flush({ code: 'OPENING_BELOW_COLLECTED', customerName: 'أحمد', collected: 400 }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(component.saveError).toBe('openingWizard.errors.belowCollected');
    expect(component.saveErrorParams['name']).toBe('أحمد');
    expect(String(component.saveErrorParams['amount'])).toContain('400');
  });

  it('finalize needs a saved, unchanged opening and a second, explicit confirmation', async () => {
    await open(stateOf({ savedAt: '2026-11-05T09:00:00.000Z', entry: { _id: 'e1', number: 'OB-000002' } }));
    component.confirmed = true;
    expect(component.canFinalize).toBeTrue();
    component.cash = 1; // an edit after the save: save again before finalizing
    expect(component.canFinalize).toBeFalse();
    component.cash = 0;
    expect(component.canFinalize).toBeTrue();
    click('[data-step="5"]');
    click('[data-action="finalize"]');
    expect(fixture.nativeElement.querySelector('[data-test="finalize-confirm"]')).toBeTruthy();
    http.expectNone(`${base}accounting/opening/finalize`); // one click does not finalize
    click('[data-action="finalize-cancel"]');
    expect(fixture.nativeElement.querySelector('[data-test="finalize-confirm"]')).toBeNull();
    click('[data-action="finalize"]');
    click('[data-action="finalize-confirm"]');
    const req = http.expectOne(`${base}accounting/opening/finalize`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ confirm: true });
    req.flush(stateOf({ status: 'finalized', setupMode: false, finalizedAt: '2026-11-05T10:00:00.000Z', savedAt: '2026-11-05T09:00:00.000Z', entry: { _id: 'e1', number: 'OB-000002' } }, { inventory: { mode: 'carried', editable: false, amount: 0 } }));
    await settle();
    expect(component.readOnly).toBeTrue();
  });

  it('a finalized opening is read-only on every step', async () => {
    await open(stateOf({ status: 'finalized', setupMode: false, finalizedAt: '2026-11-05T10:00:00.000Z', savedAt: '2026-11-05T09:00:00.000Z', entry: { _id: 'e1', number: 'OB-000002' } },
      { cash: 15000, banks: [{ accountId: 'a1', code: '1121', name: 'بنك', kind: 'bank', amount: 30000 }], inventory: { mode: 'carried', editable: false, amount: 84200 }, customers: [{ customerId: 'c1', name: 'أحمد', amount: 6300 }] }));
    expect(fixture.nativeElement.querySelector('[data-test="finalized-banner"]')).toBeTruthy();
    expect((fixture.nativeElement.querySelector('[data-field="cash"]') as HTMLInputElement).disabled).toBeTrue();
    expect(fixture.nativeElement.querySelector('[data-action="add-bank"]')).toBeNull();
    click('[data-step="3"]');
    await settle();
    expect((fixture.nativeElement.querySelector('[data-field="customer-amount"]') as HTMLInputElement).disabled).toBeTrue();
    expect(fixture.nativeElement.querySelector('[data-action="create-customer"]')).toBeNull();
    click('[data-step="5"]');
    expect(fixture.nativeElement.querySelector('[data-action="save"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-action="finalize"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-field="confirm"]')).toBeNull();
  });
});
