import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { DialogModule } from 'primeng/dialog';
import { Router } from '@angular/router';
import { SideNavComponent } from '../../../layout/components/side-nav/side-nav.component';
import { ThemeService } from '../../../shared/services/theme.service';
import { ErrorIconComponent } from '../../../assets/error/error-icon.component';
import { WarnComponent } from '../../../assets/warn/warn.component';
import { Customer, CustomerQueryParams, CustomersService } from '../../services/customers.service';
import { LanguageService } from '../../../shared/services/translation.service';

interface CustomerDeleteConfirmation {
  message?: string;
  relatedCreditInvoiceCount?: number;
  deletedCreditInvoiceCount?: number;
  confirmationField?: string;
}

@Component({
  selector: 'app-customers',
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule, DialogModule, SideNavComponent, TranslatePipe, ErrorIconComponent, WarnComponent],
  templateUrl: './customers.component.html'
})
export class CustomersComponent implements OnInit {
  isDarkMode$;
  customerForm: FormGroup;
  customers: Customer[] = [];
  searchTerm = '';
  selectedCustomerId: string | null = null;
  customerToDelete: Customer | null = null;
  deleteVisible = false;
  restoreCreditInvoicesVisible = false;
  deleteConfirmation: CustomerDeleteConfirmation | null = null;
  errorVisible = false;
  errorMessage = '';
  isFetching = false;
  isSubmitting = false;
  isDeleting = false;
  isLoadingCustomer = false;

  constructor(
    private _themeService: ThemeService,
    private _formBuilder: FormBuilder,
    private _customersService: CustomersService,
    private _languageService: LanguageService,
    private _router: Router,
    private _cdr: ChangeDetectorRef
  ) {
    this.isDarkMode$ = this._themeService.isDarkMode$;
    this.customerForm = this._formBuilder.group({
      name: [null, Validators.required],
      phone: [null, Validators.required]
    });
  }

  ngOnInit(): void {
    this.loadCustomers();
  }

  get isEditMode(): boolean {
    return !!this.selectedCustomerId;
  }

  get isFormBusy(): boolean {
    return this.isSubmitting || this.isLoadingCustomer;
  }

  loadCustomers(params?: CustomerQueryParams): void {
    this.isFetching = true;
    this._customersService.getCustomers(params).subscribe({
      next: (response: any) => {
        this.customers = this.extractCustomers(response);
        this.isFetching = false;
        this._cdr.markForCheck();
      },
      error: (error: any) => {
        this.isFetching = false;
        this.showError(this.extractErrorMessage(error, 'load'));
      }
    });
  }

  searchCustomers(): void {
    this.loadCustomers(this.buildListParams());
  }

  clearSearch(): void {
    this.searchTerm = '';
    this.loadCustomers();
  }

  saveCustomer(): void {
    if (this.customerForm.invalid || this.isFormBusy || this.isDeleting) {
      this.customerForm.markAllAsTouched();
      return;
    }

    this.isSubmitting = true;
    const payload = this.customerForm.getRawValue() as Pick<Customer, 'name' | 'phone'>;
    const request$ = this.selectedCustomerId
      ? this._customersService.updateCustomer(this.selectedCustomerId, payload)
      : this._customersService.createCustomer(payload);

    request$.subscribe({
      next: () => {
        this.isSubmitting = false;
        this.resetForm();
        this.loadCustomers(this.buildListParams());
      },
      error: (error: any) => {
        this.isSubmitting = false;
        this.showError(this.extractErrorMessage(error, 'save'));
      }
    });
  }

  editCustomer(customer: Customer): void {
    if (!customer?._id || this.isFormBusy || this.isDeleting) {
      return;
    }

    this.isLoadingCustomer = true;
    this._customersService.getCustomerById(customer._id).subscribe({
      next: (response: any) => {
        const customerDetails = this.extractCustomer(response) ?? customer;
        this.selectedCustomerId = customerDetails._id ?? customer._id ?? null;
        this.customerForm.patchValue({
          name: customerDetails.name ?? '',
          phone: customerDetails.phone ?? ''
        });
        this.isLoadingCustomer = false;
      },
      error: (error: any) => {
        this.isLoadingCustomer = false;
        this.showError(this.extractErrorMessage(error, 'load'));
      }
    });
  }

  promptDelete(customer: Customer): void {
    if (!customer?._id) {
      return;
    }

    this.customerToDelete = customer;
    this.deleteVisible = true;
  }

  openCustomerDetails(customer: Customer): void {
    if (!customer?._id) {
      return;
    }

    this._router.navigate(['/customers', customer._id]);
  }

  closeDeleteDialog(): void {
    this.deleteVisible = false;
    if (!this.restoreCreditInvoicesVisible) {
      this.customerToDelete = null;
    }
  }

  closeRestoreCreditInvoicesDialog(): void {
    if (this.isDeleting) {
      return;
    }

    this.restoreCreditInvoicesVisible = false;
    this.deleteConfirmation = null;
    this.customerToDelete = null;
  }

  deleteCustomer(): void {
    const customerId = this.customerToDelete?._id;
    if (!customerId || this.isDeleting) {
      return;
    }

    this.isDeleting = true;
    this._customersService.deleteCustomer(customerId).subscribe({
      next: () => {
        this.completeCustomerDeletion(customerId);
        this._cdr.markForCheck();
      },
      error: (error: any) => {
        this.isDeleting = false;
        if (this.shouldAskForCreditInvoiceRestore(error)) {
          this.openRestoreCreditInvoicesDialog(error);
          return;
        }
        this.showError(this.extractErrorMessage(error, 'delete'));
        this._cdr.markForCheck();
      }
    });
  }

  confirmDeleteWithCreditInvoices(restoreCreditInvoices: boolean): void {
    const customerId = this.customerToDelete?._id;
    if (!customerId || this.isDeleting) {
      return;
    }

    this.isDeleting = true;
    this._customersService.deleteCustomer(customerId, { restoreCreditInvoices }).subscribe({
      next: () => {
        this.completeCustomerDeletion(customerId);
        this._cdr.markForCheck();
      },
      error: (error: any) => {
        this.isDeleting = false;
        this.showError(this.extractErrorMessage(error, 'delete'));
        this._cdr.markForCheck();
      }
    });
  }

  resetForm(): void {
    this.selectedCustomerId = null;
    this.customerForm.reset();
    this._cdr.markForCheck();
  }

  closeErrorDialog(): void {
    this.errorVisible = false;
    this._cdr.markForCheck();
  }

  private buildListParams(): CustomerQueryParams | undefined {
    const search = this.searchTerm.trim();
    return search ? { search } : undefined;
  }

  private extractCustomers(response: any): Customer[] {
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.data?.customers)) return response.data.customers;
    if (Array.isArray(response?.customers)) return response.customers;
    if (Array.isArray(response?.data)) return response.data;
    return [];
  }

  private extractCustomer(response: any): Customer | null {
    if (!response) return null;
    if (response?._id) return response;
    if (response?.data?.customer?._id) return response.data.customer;
    if (response?.customer?._id) return response.customer;
    if (response?.data?._id) return response.data;
    return null;
  }

  private extractErrorMessage(error: any, action: 'load' | 'save' | 'delete'): string {
    if (typeof error?.error === 'string') return error.error;
    if (typeof error?.error?.message === 'string') return error.error.message;
    if (typeof error?.message === 'string') return error.message;
    return this.defaultMessage(action);
  }

  private defaultMessage(action: 'load' | 'save' | 'delete'): string {
    const isArabic = this._languageService.selectedLanguage() === 'ar';

    if (action === 'load') {
      return isArabic ? 'فشل تحميل العملاء.' : 'Failed to load customers.';
    }

    if (action === 'save') {
      return isArabic ? 'فشل حفظ العميل.' : 'Failed to save customer.';
    }

    return isArabic ? 'فشل حذف العميل.' : 'Failed to delete customer.';
  }

  private shouldAskForCreditInvoiceRestore(error: any): boolean {
    const payload = this.extractErrorPayload(error);
    return error?.status === 409 && payload?.requiresConfirmation === true;
  }

  private openRestoreCreditInvoicesDialog(error: any): void {
    this.deleteConfirmation = this.extractDeleteConfirmation(error);

    setTimeout(() => {
      this.deleteVisible = false;
      this.restoreCreditInvoicesVisible = true;
      this._cdr.markForCheck();
    });
  }

  private extractDeleteConfirmation(error: any): CustomerDeleteConfirmation {
    const payload = this.extractErrorPayload(error);
    return {
      message: typeof payload?.message === 'string' ? payload.message : undefined,
      relatedCreditInvoiceCount: this.toOptionalNumber(payload?.relatedCreditInvoiceCount ?? payload?.creditInvoiceCount),
      deletedCreditInvoiceCount: this.toOptionalNumber(payload?.deletedCreditInvoiceCount),
      confirmationField: typeof payload?.confirmationField === 'string' ? payload.confirmationField : undefined
    };
  }

  private extractErrorPayload(error: any): any {
    if (typeof error?.error === 'object' && error.error !== null) return error.error;
    return error;
  }

  private completeCustomerDeletion(customerId: string): void {
    this.isDeleting = false;
    this.restoreCreditInvoicesVisible = false;
    this.deleteConfirmation = null;
    if (this.selectedCustomerId === customerId) {
      this.resetForm();
    }
    this.closeDeleteDialog();
    this.customerToDelete = null;
    this.loadCustomers(this.buildListParams());
  }

  private toOptionalNumber(value: any): number | undefined {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : undefined;
  }

  private showError(message: string): void {
    this.errorMessage = message;
    this.errorVisible = true;
  }
}
