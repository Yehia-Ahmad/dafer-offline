import { DatePipe } from '@angular/common';
import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { concat, last, of } from 'rxjs';
import { NotaButtonDirective, NotaFormFieldComponent, NotaMoneyPipe, NotaNumberPipe, NotaPageHeaderComponent, formatNotaNumber } from '../shared/ui';
import { LanguageService } from '../shared/services/translation.service';
import { CustomersService } from '../customer/services/customers.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { OpeningProduct, OpeningSavePayload, OpeningService, OpeningState } from './opening.service';

export type WizardStep = 1 | 2 | 3 | 4 | 5;
export const WIZARD_STEPS: readonly WizardStep[] = [1, 2, 3, 4, 5];

export interface BankRow { accountId?: string; code?: string; name: string; type: 'bank' | 'wallet'; amount: number | null }
export interface PartyRow { id: string; name: string; phone?: string; amount: number | null; collected?: number }
export interface InventoryRow { id: string; code: string; name: string; quantity: number; price: number; originalQuantity: number; originalPrice: number }

export interface ReviewInput {
  cash: number;
  banks: number[];
  fixedAssets: number;
  inventory: number;
  customers: number[];
  /** Customer balances from invoices before the ledger start, carried as they are. */
  carriedCustomers: number[];
  suppliers: number[];
}

export interface ReviewTotals {
  cash: number;
  banks: number;
  inventory: number;
  fixedAssets: number;
  customers: number;
  /** Negative customers: we owe them. */
  customerCredits: number;
  suppliers: number;
  /** Negative suppliers: they owe us (an advance). */
  supplierAdvances: number;
  assets: number;
  liabilities: number;
  capital: number;
}

const cents = (value: number) => Math.round(value * 100) / 100;
const sum = (values: number[], pick: (value: number) => number) => cents(values.reduce((total, value) => total + pick(value), 0));

/** Two decimals at most (the backend rejects more). */
export function isMoney(value: number | null | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

/**
 * The review's arithmetic (it mirrors the backend entry): what the shop has − what it owes = the owner's capital.
 * Customers with a negative opening and suppliers with a negative opening move to the other side.
 */
export function computeReview(input: ReviewInput): ReviewTotals {
  const customersAll = [...input.customers, ...input.carriedCustomers];
  const customers = sum(customersAll, (value) => Math.max(0, value));
  const customerCredits = sum(customersAll, (value) => Math.max(0, -value));
  const suppliers = sum(input.suppliers, (value) => Math.max(0, value));
  const supplierAdvances = sum(input.suppliers, (value) => Math.max(0, -value));
  const banks = sum(input.banks, (value) => value);
  const assets = cents(input.cash + banks + input.inventory + input.fixedAssets + customers + supplierAdvances);
  const liabilities = cents(suppliers + customerCredits);
  return { cash: input.cash, banks, inventory: input.inventory, fixedAssets: input.fixedAssets, customers, customerCredits, suppliers, supplierAdvances, assets, liabilities, capital: cents(assets - liabilities) };
}

/**
 * Stage 18: the opening-balance wizard "رصيد بداية المحل" (docs/design/screens/Opening.dc.html).
 * Steps: الخزائن → المخزون → العملاء → الموردين → المراجعة. Saving can be repeated (the backend reverses the
 * current opening entry and posts a new one); finalizing makes it read-only for good.
 */
@Component({
  selector: 'app-opening-wizard',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterLink, TranslatePipe, NotaButtonDirective, NotaFormFieldComponent, NotaMoneyPipe, NotaNumberPipe, NotaPageHeaderComponent],
  templateUrl: './opening-wizard.component.html',
  styleUrl: './opening-wizard.component.scss',
})
export class OpeningWizardComponent implements OnInit {
  private readonly opening = inject(OpeningService);
  private readonly customersService = inject(CustomersService);
  private readonly suppliersService = inject(SuppliersService);
  private readonly translate = inject(TranslateService);
  private readonly language = inject(LanguageService);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly steps = WIZARD_STEPS;
  step: WizardStep = 1;
  state: OpeningState | null = null;
  loading = true;
  loadError = false;

  cash: number | null = 0;
  fixedAssets: number | null = 0;
  banks: BankRow[] = [];
  inventoryRows: InventoryRow[] = [];
  inventoryLoading = false;
  inventoryError = '';
  /** Difference between the inventory the entry will carry and the plain stock value (older adjustments the backend keeps). */
  private inventoryOffset = 0;
  customers: PartyRow[] = [];
  suppliers: PartyRow[] = [];
  customerOptions: { _id: string; name: string; phone: string }[] = [];
  supplierOptions: { _id: string; name: string }[] = [];
  pickCustomerId = '';
  pickSupplierId = '';
  newCustomer = { name: '', phone: '' };
  newSupplier = { name: '', phone: '' };
  partyError = '';

  confirmed = false;
  saving = false;
  saveError = '';
  saveErrorParams: Record<string, unknown> = {};
  savedJson: string | null = null;
  savedNumber: string | null = null;
  finalizeAsk = false;
  finalizing = false;

  ngOnInit(): void {
    this.load();
  }

  get readOnly(): boolean {
    return this.state?.status === 'finalized';
  }

  /** Stock typed in during setup mode is opening stock; afterwards the inventory is carried and read-only. */
  get inventoryEditable(): boolean {
    return !!this.state?.setupMode && !this.readOnly;
  }

  load(): void {
    this.loading = true;
    this.loadError = false;
    this.opening.get().subscribe({
      next: (state) => { this.apply(state); this.loading = false; this.refresh(); },
      error: () => { this.loadError = true; this.loading = false; this.refresh(); },
    });
    this.customersService.getCustomers().subscribe({ next: (rows: any) => { this.customerOptions = Array.isArray(rows) ? rows : rows?.data ?? []; this.refresh(); }, error: () => undefined });
    this.suppliersService.list().subscribe({ next: (rows) => { this.supplierOptions = rows; this.refresh(); }, error: () => undefined });
  }

  /** The app runs without zone.js: after an async answer, ask Angular to render again. */
  private refresh(): void {
    this.cdr.markForCheck();
  }

  private apply(state: OpeningState): void {
    this.state = state;
    const figures = state.figures;
    this.cash = figures.cash;
    this.fixedAssets = figures.fixedAssets;
    this.banks = figures.banks.map((bank) => ({ accountId: bank.accountId, code: bank.code, name: bank.name, type: bank.kind === 'wallet' ? 'wallet' : 'bank', amount: bank.amount }));
    this.customers = figures.customers.map((row) => ({ id: row.customerId as string, name: row.name, phone: row.phone, amount: row.amount, collected: row.collected }));
    this.suppliers = figures.suppliers.map((row) => ({ id: row.supplierId as string, name: row.name, amount: row.amount }));
    this.inventoryOffset = cents((figures.inventory.amount ?? 0) - (figures.inventory.stockValue ?? figures.inventory.amount ?? 0));
    if (state.setupMode && !this.inventoryRows.length) this.loadInventory();
    this.savedJson = state.savedAt ? this.payloadJson() : null;
    this.savedNumber = state.entry?.number ?? null;
  }

  // ------------------------------------------------------------ inventory step

  private loadInventory(page = 1, rows: InventoryRow[] = []): void {
    this.inventoryLoading = true;
    this.opening.listProducts(page).subscribe({
      next: (response) => {
        const next = [...rows, ...(response.data || []).filter((product) => Number(product.inventoryCount || 0) > 0).map((product) => this.toRow(product))];
        if (response.pagination?.hasNextPage) { this.loadInventory(page + 1, next); return; }
        this.inventoryRows = next;
        this.inventoryLoading = false;
        this.refresh();
      },
      error: () => { this.inventoryError = 'openingWizard.inventory.loadFailed'; this.inventoryLoading = false; this.refresh(); },
    });
  }

  private toRow(product: OpeningProduct): InventoryRow {
    const quantity = Number(product.inventoryCount || 0);
    const price = Number(product.purchasePrice || 0);
    return { id: product._id, code: product.code || '', name: product.name, quantity, price, originalQuantity: quantity, originalPrice: price };
  }

  get dirtyInventoryRows(): InventoryRow[] {
    return this.inventoryRows.filter((row) => row.quantity !== row.originalQuantity || row.price !== row.originalPrice);
  }

  inventoryValue(row: InventoryRow): number {
    return cents(Number(row.quantity || 0) * Number(row.price || 0));
  }

  /** Live total of the table plus whatever older adjustments the backend keeps outside the opening entry. */
  get inventoryTotal(): number {
    if (!this.inventoryEditable) return this.state?.figures.inventory.amount ?? 0;
    return cents(this.inventoryRows.reduce((total, row) => total + Number(row.quantity || 0) * Number(row.price || 0), 0) + this.inventoryOffset);
  }

  get inventoryRowsValid(): boolean {
    return this.inventoryRows.every((row) => Number.isInteger(row.quantity) && row.quantity >= 0 && isMoney(row.price) && row.price >= 0);
  }

  /** Saves edited rows through the normal product update (one request per edited product), then runs `done`. */
  saveInventoryEdits(done: () => void, failed: () => void = () => undefined): void {
    const dirty = this.dirtyInventoryRows;
    if (!dirty.length) { done(); return; }
    this.inventoryError = '';
    const calls = dirty.map((row) => this.opening.updateProduct(row.id, { inventoryCount: row.quantity, purchasePrice: row.price }));
    concat(...calls, of(null)).pipe(last()).subscribe({
      next: () => { dirty.forEach((row) => { row.originalQuantity = row.quantity; row.originalPrice = row.price; }); done(); this.refresh(); },
      error: (error) => { this.inventoryError = error?.error?.message || 'openingWizard.inventory.saveFailed'; failed(); this.refresh(); },
    });
  }

  // ------------------------------------------------------------ parties

  addCustomerRow(): void {
    this.partyError = '';
    const option = this.customerOptions.find((row) => row._id === this.pickCustomerId);
    if (!option) return;
    if (this.customers.some((row) => row.id === option._id)) { this.partyError = 'openingWizard.customers.duplicate'; return; }
    this.customers = [...this.customers, { id: option._id, name: option.name, phone: option.phone, amount: null }];
    this.pickCustomerId = '';
  }

  createCustomerRow(): void {
    this.partyError = '';
    const name = this.newCustomer.name.trim(); const phone = this.newCustomer.phone.trim();
    if (!name || !phone) { this.partyError = 'openingWizard.customers.nameAndPhone'; return; }
    this.customersService.createCustomer({ name, phone }).subscribe({
      next: (created: any) => {
        this.customerOptions = [...this.customerOptions, created];
        this.customers = [...this.customers, { id: created._id, name: created.name, phone: created.phone, amount: null }];
        this.newCustomer = { name: '', phone: '' };
        this.refresh();
      },
      error: (error) => { this.partyError = error?.error?.message || 'openingWizard.customers.createFailed'; this.refresh(); },
    });
  }

  addSupplierRow(): void {
    this.partyError = '';
    const option = this.supplierOptions.find((row) => row._id === this.pickSupplierId);
    if (!option) return;
    if (this.suppliers.some((row) => row.id === option._id)) { this.partyError = 'openingWizard.suppliers.duplicate'; return; }
    this.suppliers = [...this.suppliers, { id: option._id, name: option.name, amount: null }];
    this.pickSupplierId = '';
  }

  createSupplierRow(): void {
    this.partyError = '';
    const name = this.newSupplier.name.trim();
    if (!name) { this.partyError = 'openingWizard.suppliers.nameRequired'; return; }
    this.suppliersService.create({ name, phone: this.newSupplier.phone.trim() }).subscribe({
      next: (created) => {
        this.supplierOptions = [...this.supplierOptions, { _id: created._id, name: created.name }];
        this.suppliers = [...this.suppliers, { id: created._id, name: created.name, amount: null }];
        this.newSupplier = { name: '', phone: '' };
        this.refresh();
      },
      error: (error) => { this.partyError = error?.error?.message || 'openingWizard.suppliers.createFailed'; this.refresh(); },
    });
  }

  removeCustomer(row: PartyRow): void {
    this.customers = this.customers.filter((item) => item !== row);
  }

  removeSupplier(row: PartyRow): void {
    this.suppliers = this.suppliers.filter((item) => item !== row);
  }

  get availableCustomerOptions() {
    return this.customerOptions.filter((option) => !this.customers.some((row) => row.id === option._id));
  }

  get availableSupplierOptions() {
    return this.supplierOptions.filter((option) => !this.suppliers.some((row) => row.id === option._id));
  }

  // ------------------------------------------------------------ banks

  addBank(type: 'bank' | 'wallet' = 'bank'): void {
    this.banks = [...this.banks, { name: '', type, amount: null }];
  }

  removeBank(row: BankRow): void {
    if (row.accountId) { row.amount = 0; return; } // an account that exists stays; its opening goes to zero
    this.banks = this.banks.filter((item) => item !== row);
  }

  // ------------------------------------------------------------ validation

  private amountOf(value: number | null): number {
    return Number(value ?? 0);
  }

  get cashValid(): boolean {
    return isMoney(this.amountOf(this.cash)) && this.amountOf(this.cash) >= 0 && isMoney(this.amountOf(this.fixedAssets)) && this.amountOf(this.fixedAssets) >= 0;
  }

  bankError(row: BankRow): string | null {
    const amount = this.amountOf(row.amount);
    if (!isMoney(amount) || amount < 0) return 'openingWizard.errors.amount';
    if (!row.accountId && amount !== 0 && !row.name.trim()) return 'openingWizard.errors.bankName';
    return null;
  }

  get banksValid(): boolean {
    return this.banks.every((row) => !this.bankError(row));
  }

  partyAmountError(row: PartyRow): string | null {
    return isMoney(this.amountOf(row.amount)) ? null : 'openingWizard.errors.amount';
  }

  get customersValid(): boolean {
    return this.customers.every((row) => !this.partyAmountError(row));
  }

  get suppliersValid(): boolean {
    return this.suppliers.every((row) => !this.partyAmountError(row));
  }

  stepValid(step: WizardStep): boolean {
    if (step === 1) return this.cashValid && this.banksValid;
    if (step === 2) return !this.inventoryEditable || this.inventoryRowsValid;
    if (step === 3) return this.customersValid;
    if (step === 4) return this.suppliersValid;
    return true;
  }

  // ------------------------------------------------------------ navigation

  goTo(step: WizardStep): void {
    this.step = step;
  }

  next(): void {
    if (!this.stepValid(this.step)) return;
    const advance = () => { if (this.step < 5) this.step = (this.step + 1) as WizardStep; };
    if (this.step === 2 && this.inventoryEditable) { this.saveInventoryEdits(advance); return; }
    advance();
  }

  back(): void {
    if (this.step > 1) this.step = (this.step - 1) as WizardStep;
  }

  // ------------------------------------------------------------ review

  get review(): ReviewTotals {
    const carried = (this.state?.figures.carriedCustomers ?? []).map((row) => row.amount);
    return computeReview({
      cash: this.amountOf(this.cash),
      banks: this.banks.map((row) => this.amountOf(row.amount)),
      fixedAssets: this.amountOf(this.fixedAssets),
      inventory: this.inventoryTotal,
      customers: this.customers.map((row) => this.amountOf(row.amount)),
      carriedCustomers: carried,
      suppliers: this.suppliers.map((row) => this.amountOf(row.amount)),
    });
  }

  get customerCount(): number {
    return this.customers.filter((row) => this.amountOf(row.amount) !== 0).length + (this.state?.figures.carriedCustomers.length ?? 0);
  }

  get supplierCount(): number {
    return this.suppliers.filter((row) => this.amountOf(row.amount) !== 0).length;
  }

  get stockLines(): number {
    return this.inventoryRows.length;
  }

  money(value: number): string {
    return formatNotaNumber(value, this.language.selectedLanguage(), 'money');
  }

  // ------------------------------------------------------------ save / finalize

  buildPayload(): OpeningSavePayload {
    return {
      cash: this.amountOf(this.cash),
      fixedAssets: this.amountOf(this.fixedAssets),
      banks: this.banks.map((row) => (row.accountId
        ? { accountId: row.accountId, amount: this.amountOf(row.amount) }
        : { name: row.name.trim(), type: row.type, amount: this.amountOf(row.amount) })),
      customers: this.customers.filter((row) => this.amountOf(row.amount) !== 0).map((row) => ({ customerId: row.id, amount: this.amountOf(row.amount) })),
      suppliers: this.suppliers.filter((row) => this.amountOf(row.amount) !== 0).map((row) => ({ supplierId: row.id, amount: this.amountOf(row.amount) })),
    };
  }

  private payloadJson(): string {
    return JSON.stringify(this.buildPayload());
  }

  get dirty(): boolean {
    return this.savedJson === null || this.savedJson !== this.payloadJson() || this.dirtyInventoryRows.length > 0;
  }

  get canSave(): boolean {
    return !this.readOnly && !this.saving && this.confirmed && this.stepValid(1) && this.stepValid(2) && this.stepValid(3) && this.stepValid(4);
  }

  get canFinalize(): boolean {
    return !this.readOnly && !this.finalizing && this.confirmed && this.savedJson !== null && !this.dirty;
  }

  save(): void {
    if (!this.canSave) return;
    this.saveError = '';
    this.saveErrorParams = {};
    this.saving = true;
    const post = () => this.opening.save(this.buildPayload()).subscribe({
      next: (state) => { this.saving = false; this.apply(state); this.savedJson = this.payloadJson(); this.refresh(); },
      error: (error) => { this.saving = false; this.showError(error); this.refresh(); },
    });
    this.saveInventoryEdits(post, () => { this.saving = false; this.refresh(); });
  }

  askFinalize(): void {
    if (this.canFinalize) this.finalizeAsk = true;
  }

  cancelFinalize(): void {
    this.finalizeAsk = false;
  }

  /** The second confirmation: it cannot be undone. */
  finalize(): void {
    if (!this.finalizeAsk || !this.canFinalize) return;
    this.finalizing = true;
    this.opening.finalize().subscribe({
      next: (state) => { this.finalizing = false; this.finalizeAsk = false; this.apply(state); this.refresh(); },
      error: (error) => { this.finalizing = false; this.finalizeAsk = false; this.showError(error); this.refresh(); },
    });
  }

  private showError(error: any): void {
    const code = error?.error?.code;
    if (code === 'OPENING_FINALIZED') this.saveError = 'openingWizard.errors.finalized';
    else if (code === 'OPENING_BELOW_COLLECTED') {
      this.saveError = 'openingWizard.errors.belowCollected';
      this.saveErrorParams = { name: error.error.customerName ?? '', amount: this.money(Number(error.error.collected ?? 0)) };
    } else this.saveError = error?.error?.message || 'openingWizard.errors.saveFailed';
  }

  errorText(key: string, params: Record<string, unknown> = {}): string {
    return this.translate.instant(key, params);
  }

  reloadInventory(): void {
    this.inventoryRows = [];
    this.inventoryError = '';
    this.loadInventory();
  }
}
