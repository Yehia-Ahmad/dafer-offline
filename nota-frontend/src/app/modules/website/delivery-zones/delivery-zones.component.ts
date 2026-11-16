import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { DialogModule } from 'primeng/dialog';
import { NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaMoneyPipe, NotaPageHeaderComponent } from '../../shared/ui';
import { DeliveryZone, DeliveryZonePayload, WEBSITE_LIMITS } from '../website.models';
import { WebsiteService } from '../website.service';

/**
 * Online Stage 3: /website/delivery-zones. List + add/edit dialog (name, fee, estimated time, active, order).
 * A zone that an order used cannot be deleted: the page offers "deactivate" for it (GET /api/website/delivery-zones says `used`).
 */
@Component({
  selector: 'app-delivery-zones',
  imports: [TranslatePipe, ReactiveFormsModule, DialogModule, NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaMoneyPipe, NotaPageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './delivery-zones.component.html',
  styleUrl: './delivery-zones.component.scss',
})
export class DeliveryZonesComponent implements OnInit {
  private readonly service = inject(WebsiteService);
  private readonly formBuilder = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly limits = WEBSITE_LIMITS;
  protected readonly zones = signal<DeliveryZone[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal(false);
  protected readonly saving = signal(false);
  protected readonly dialogOpen = signal(false);
  protected readonly editing = signal<DeliveryZone | null>(null);
  protected readonly deleting = signal<DeliveryZone | null>(null);
  protected readonly errorMessage = signal('');

  protected readonly form = this.formBuilder.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(WEBSITE_LIMITS.zoneName)]],
    // A string while typing; 0 or more, 2 decimals.
    fee: ['', [Validators.required, Validators.pattern(/^\d{1,9}(\.\d{1,2})?$/)]],
    estimatedTime: ['', Validators.maxLength(WEBSITE_LIMITS.zoneTime)],
    isActive: [true],
    sortOrder: ['0', Validators.pattern(/^-?\d{1,6}$/)],
  });

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.service.listZones().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (zones) => {
        this.zones.set(zones);
        this.loading.set(false);
      },
      error: () => {
        this.loadError.set(true);
        this.loading.set(false);
      },
    });
  }

  protected openAdd(): void {
    this.editing.set(null);
    this.errorMessage.set('');
    this.form.reset({ name: '', fee: '', estimatedTime: '', isActive: true, sortOrder: String(this.zones().length + 1) });
    this.dialogOpen.set(true);
  }

  protected openEdit(zone: DeliveryZone): void {
    this.editing.set(zone);
    this.errorMessage.set('');
    this.form.reset({ name: zone.name, fee: String(zone.fee), estimatedTime: zone.estimatedTime || '', isActive: zone.isActive, sortOrder: String(zone.sortOrder || 0) });
    this.dialogOpen.set(true);
  }

  protected closeDialog(): void {
    this.dialogOpen.set(false);
  }

  protected showError(control: 'name' | 'fee' | 'sortOrder'): boolean {
    const field = this.form.controls[control];
    return field.invalid && (field.touched || field.dirty);
  }

  protected save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const raw = this.form.getRawValue();
    const payload: DeliveryZonePayload = {
      name: raw.name.trim(),
      fee: Number(raw.fee),
      estimatedTime: raw.estimatedTime.trim(),
      isActive: raw.isActive,
      sortOrder: Number(raw.sortOrder || 0),
    };
    const zone = this.editing();
    this.saving.set(true);
    this.errorMessage.set('');
    (zone ? this.service.updateZone(zone.id, payload) : this.service.createZone(payload))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.dialogOpen.set(false);
          this.load();
        },
        error: (error) => {
          this.saving.set(false);
          this.errorMessage.set(typeof error?.error?.message === 'string' ? error.error.message : '');
        },
      });
  }

  /** A used zone: only deactivation. An unused one is deleted after a confirmation. */
  protected deactivate(zone: DeliveryZone): void {
    this.service.updateZone(zone.id, { isActive: false }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.load(),
      error: () => this.loadError.set(true),
    });
  }

  protected activate(zone: DeliveryZone): void {
    this.service.updateZone(zone.id, { isActive: true }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.load(),
      error: () => this.loadError.set(true),
    });
  }

  protected askDelete(zone: DeliveryZone): void {
    this.errorMessage.set('');
    this.deleting.set(zone);
  }

  protected cancelDelete(): void {
    this.deleting.set(null);
  }

  protected confirmDelete(): void {
    const zone = this.deleting();
    if (!zone) return;
    this.saving.set(true);
    this.service.deleteZone(zone.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.saving.set(false);
        this.deleting.set(null);
        this.load();
      },
      error: (error) => {
        this.saving.set(false);
        this.errorMessage.set(typeof error?.error?.message === 'string' ? error.error.message : '');
        this.deleting.set(null);
        this.load();
      },
    });
  }
}
