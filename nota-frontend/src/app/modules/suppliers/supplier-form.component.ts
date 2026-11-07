import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { NotaButtonDirective, NotaFormFieldComponent, NotaPageHeaderComponent } from '../shared/ui';
import { Supplier, SupplierPayload, SuppliersService } from './suppliers.service';

export type PaymentTermsChoice = 'none' | 'cash' | '30' | '60' | 'custom';

/** The form's payment-terms choice → the stored number of days (0 = cash). Exported for the payload spec. */
export function paymentTermsToDays(choice: PaymentTermsChoice, custom: number | null): number | null {
  if (choice === 'cash') return 0;
  if (choice === '30') return 30;
  if (choice === '60') return 60;
  if (choice === 'custom') return custom !== null && Number.isInteger(custom) && custom >= 0 ? custom : null;
  return null;
}

/** The stored number of days → the form's choice. */
export function daysToPaymentTerms(days: number | null | undefined): { choice: PaymentTermsChoice; custom: number | null } {
  if (days === null || days === undefined) return { choice: 'none', custom: null };
  if (days === 0) return { choice: 'cash', custom: null };
  if (days === 30 || days === 60) return { choice: String(days) as PaymentTermsChoice, custom: null };
  return { choice: 'custom', custom: days };
}

/**
 * Stage 18: add / edit a supplier (docs/design/screens/AddSupplier.dc.html). Only the name is required;
 * the other fields (phone, contact person, address, what they supply, tax number, payment terms) are optional.
 * The balance is never typed here: old balances enter once through the opening wizard.
 */
@Component({
  selector: 'app-supplier-form',
  standalone: true,
  imports: [ReactiveFormsModule, TranslatePipe, NotaButtonDirective, NotaFormFieldComponent, NotaPageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './supplier-form.component.html',
  styleUrl: './supplier-form.component.scss',
})
export class SupplierFormComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly service = inject(SuppliersService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly supplierId = this.route.snapshot.paramMap.get('id');
  readonly saving = signal(false);
  readonly loadError = signal(false);
  readonly saveError = signal('');
  readonly submitted = signal(false);

  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(200)]],
    contactPerson: ['', Validators.maxLength(120)],
    phone: ['', Validators.maxLength(30)],
    address: ['', Validators.maxLength(300)],
    supplies: ['', Validators.maxLength(300)],
    taxNumber: ['', Validators.maxLength(50)],
    vatRegistered: [false],
    termsChoice: ['none' as PaymentTermsChoice],
    termsCustom: [null as number | null],
    notes: ['', Validators.maxLength(1000)],
  });

  ngOnInit(): void {
    if (!this.supplierId) return;
    this.service.get(this.supplierId).subscribe({
      next: (supplier) => this.patch(supplier),
      error: () => this.loadError.set(true),
    });
  }

  /** Stage 21: what the supplier had when it was loaded (an edit that clears the flag must send false). */
  private hadVatRegistered = false;

  private patch(supplier: Supplier): void {
    this.hadVatRegistered = Boolean(supplier.vatRegistered);
    const terms = daysToPaymentTerms(supplier.paymentTermsDays);
    this.form.patchValue({
      name: supplier.name, contactPerson: supplier.contactPerson ?? '', phone: supplier.phones?.[0] ?? '', address: supplier.address ?? '',
      supplies: supplier.supplies ?? '', taxNumber: supplier.taxNumber ?? '', vatRegistered: Boolean(supplier.vatRegistered), termsChoice: terms.choice, termsCustom: terms.custom, notes: supplier.notes ?? '',
    });
  }

  /** The request body. Empty optional fields are sent as '' so an edit can clear them. */
  buildPayload(): SupplierPayload {
    const value = this.form.getRawValue();
    return {
      name: value.name.trim(),
      phone: value.phone.trim(),
      contactPerson: value.contactPerson.trim(),
      address: value.address.trim(),
      supplies: value.supplies.trim(),
      taxNumber: value.taxNumber.trim(),
      ...(value.vatRegistered || this.hadVatRegistered ? { vatRegistered: value.vatRegistered } : {}),
      paymentTermsDays: paymentTermsToDays(value.termsChoice, value.termsCustom),
      notes: value.notes.trim(),
    };
  }

  save(): void {
    this.submitted.set(true);
    this.saveError.set('');
    if (this.form.invalid || (this.form.controls.termsChoice.value === 'custom' && paymentTermsToDays('custom', this.form.controls.termsCustom.value) === null)) return;
    this.saving.set(true);
    const payload = this.buildPayload();
    const request = this.supplierId ? this.service.update(this.supplierId, payload) : this.service.create(payload);
    request.subscribe({
      next: () => { this.saving.set(false); this.router.navigate(['/suppliers']); },
      error: (error) => { this.saving.set(false); this.saveError.set(error?.error?.message || 'suppliers.form.saveFailed'); },
    });
  }

  cancel(): void {
    this.router.navigate(['/suppliers']);
  }
}
