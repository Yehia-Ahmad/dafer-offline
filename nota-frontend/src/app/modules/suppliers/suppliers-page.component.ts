import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { NotaCanDirective } from '../../core/auth/nota-can.directive';
import { NotaBalancePipe, NotaButtonDirective, NotaMoneyPipe, NotaPageHeaderComponent } from '../shared/ui';
import { SupplierPaymentDialogComponent } from './supplier-payment-dialog.component';
import { SupplierStatementComponent } from './supplier-statement.component';
import { Supplier, SuppliersService } from './suppliers.service';

/**
 * Stage 18: the suppliers list (docs/design/screens/Suppliers.dc.html). The balance is the ledger party
 * balance of account 21. The supplier statement, purchases and payments are Stage 20: for now the row
 * links to the ledger of account 21 filtered by that supplier.
 */
@Component({
  selector: 'app-suppliers-page',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterLink, TranslatePipe, NotaCanDirective, NotaButtonDirective, NotaMoneyPipe, NotaBalancePipe, NotaPageHeaderComponent, SupplierStatementComponent, SupplierPaymentDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './suppliers-page.component.html',
  styleUrl: './suppliers-page.component.scss',
})
export class SuppliersPageComponent implements OnInit {
  private readonly service = inject(SuppliersService);
  private readonly router = inject(Router);

  readonly suppliers = signal<Supplier[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal(false);
  readonly deleteError = signal('');
  /** Stage 20: the supplier whose statement panel is open, and the payment dialog. */
  readonly selectedId = signal<string | null>(null);
  readonly payOpen = signal(false);
  readonly refreshKey = signal(0);
  readonly selected = computed(() => this.suppliers().find((row) => row._id === this.selectedId()) ?? null);
  search = '';

  /** What we owe all suppliers (the design's header figure). Only positive balances are debts. */
  readonly totalWeOwe = computed(() => Math.round(this.suppliers().reduce((sum, row) => sum + Math.max(0, row.balance), 0) * 100) / 100);

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.service.list(this.search).subscribe({
      next: (rows) => { this.suppliers.set(rows); this.loading.set(false); },
      error: () => { this.loadError.set(true); this.loading.set(false); },
    });
  }

  select(row: Supplier): void {
    this.selectedId.set(row._id);
  }

  /** A payment was saved: the list (one balance source) and the statement both reload. */
  paid(): void {
    this.refreshKey.update((value) => value + 1);
    this.load();
  }

  /** The ledger shows credit as negative; the party balance here is positive when we owe the supplier. */
  display(row: Supplier) {
    return { balance: -row.balance, normalSide: 'credit' as const };
  }

  terms(row: Supplier): string | null {
    if (row.paymentTermsDays === undefined || row.paymentTermsDays === null) return null;
    return row.paymentTermsDays === 0 ? 'cash' : String(row.paymentTermsDays);
  }

  edit(row: Supplier): void {
    this.router.navigate(['/suppliers/edit', row._id]);
  }

  remove(row: Supplier): void {
    this.deleteError.set('');
    this.service.remove(row._id).subscribe({
      next: () => this.load(),
      error: (error) => this.deleteError.set(error?.error?.code === 'SUPPLIER_HAS_BALANCE' ? 'suppliers.deleteBlocked' : error?.error?.code === 'SUPPLIER_HAS_DOCUMENTS' ? 'suppliers.deleteHasDocuments' : 'suppliers.deleteFailed'),
    });
  }
}
