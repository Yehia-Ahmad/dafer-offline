import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { NotaBalancePipe } from '../shared/ui';
import { localDateKey } from '../../core/utilities/local-date';
import { AuthService } from '../../core/auth/auth.service';
import { NotaCanDirective } from '../../core/auth/nota-can.directive';
import { AdminAccount } from './account-admin/account-admin.service';
import { AccountDialogComponent, TreeAccount } from './account-admin/account-dialog.component';

@Component({ selector: 'app-accounting-accounts', standalone: true, imports: [CommonModule, FormsModule, RouterLink, TranslateModule, NotaBalancePipe, NotaCanDirective, AccountDialogComponent], templateUrl: './accounts.component.html', styleUrl: './accounts.component.scss' })
export class AccountsComponent {
  private http = inject(HttpClient); private router = inject(Router); private translate = inject(TranslateService); private cdr = inject(ChangeDetectorRef);
  accounts: any[] = []; loading = true; error = ''; asOf = localDateKey(); expanded = new Set<string>();
  // Stage 22: stopped accounts are hidden unless asked for; "+ حساب" and the edit action open the account dialog.
  private auth = inject(AuthService); showInactive = false; dialogOpen = false; editing: AdminAccount | null = null;
  get canManage(): boolean { return this.auth.has('accounting.manage'); }
  get chart(): TreeAccount[] { const out: TreeAccount[] = []; const visit = (items: any[]) => items.forEach(account => { out.push(account); visit(account.children || []); }); visit(this.accounts); return out; }
  refresh(): void { this.cdr.detectChanges(); }
  openAdd(): void { this.editing = null; this.dialogOpen = true; }
  openEdit(row: any): void { this.editing = row as AdminAccount; this.dialogOpen = true; }
  closeDialog(): void { this.dialogOpen = false; this.editing = null; this.cdr.detectChanges(); }
  saved(_account: AdminAccount | null): void { this.closeDialog(); this.load(); }
  ngOnInit(): void { this.load(); }
  get rows(): any[] { const out: any[] = []; const visit = (items: any[], level: number) => items.filter(account => this.showInactive || account.isActive !== false).forEach(account => { out.push({ ...account, level }); if (this.expanded.has(account._id)) visit(account.children || [], level + 1); if (account.systemKey === 'CUSTOMERS' && this.expanded.has(account._id)) (account.virtualCustomers || []).forEach((customer: any) => out.push({ ...customer, level: level + 1, customer: true, parentAccountId: account._id, code: '' })); }); visit(this.accounts, 0); return out; }
  name(row: any): string { return row.customer ? row.name : (this.translate.currentLang || this.translate.defaultLang) === 'en' ? row.nameEn : row.nameAr; }
  load(): void { this.loading = true; this.error = ''; this.http.get<any>(`${environment.api_base_url}accounting/accounts`, { params: { asOf: this.asOf } }).subscribe({ next: response => { this.accounts = response.accounts || []; this.accounts.forEach(account => this.expanded.add(account._id)); this.loading = false; this.cdr.detectChanges(); }, error: error => { this.error = error?.error?.message || 'Unable to load accounts'; this.loading = false; this.cdr.detectChanges(); } }); }
  activate(row: any): void { if (row.customer) { this.router.navigate(['/accounting/accounts', row.parentAccountId, 'ledger'], { queryParams: { partyId: row._id } }); return; } if (row.isGroup || row.systemKey === 'CUSTOMERS') { this.expanded.has(row._id) ? this.expanded.delete(row._id) : this.expanded.add(row._id); return; } this.router.navigate(['/accounting/accounts', row._id, 'ledger']); }
}
