import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';

@Component({ selector: 'app-accounting-accounts', standalone: true, imports: [CommonModule, FormsModule, TranslateModule], templateUrl: './accounts.component.html', styleUrl: './accounts.component.scss' })
export class AccountsComponent {
  private http = inject(HttpClient); private router = inject(Router); private translate = inject(TranslateService); private cdr = inject(ChangeDetectorRef);
  accounts: any[] = []; loading = true; error = ''; asOf = new Date().toISOString().slice(0, 10); expanded = new Set<string>();
  ngOnInit(): void { this.load(); }
  get rows(): any[] { const out: any[] = []; const visit = (items: any[], level: number) => items.forEach(account => { out.push({ ...account, level }); if (this.expanded.has(account._id)) visit(account.children || [], level + 1); if (account.systemKey === 'CUSTOMERS' && this.expanded.has(account._id)) (account.virtualCustomers || []).forEach((customer: any) => out.push({ ...customer, level: level + 1, customer: true, parentAccountId: account._id, code: '' })); }); visit(this.accounts, 0); return out; }
  name(row: any): string { return row.customer ? row.name : (this.translate.currentLang || this.translate.defaultLang) === 'en' ? row.nameEn : row.nameAr; }
  load(): void { this.loading = true; this.error = ''; this.http.get<any>(`${environment.api_base_url}accounting/accounts`, { params: { asOf: this.asOf } }).subscribe({ next: response => { this.accounts = response.accounts || []; this.accounts.forEach(account => this.expanded.add(account._id)); this.loading = false; this.cdr.detectChanges(); }, error: error => { this.error = error?.error?.message || 'Unable to load accounts'; this.loading = false; this.cdr.detectChanges(); } }); }
  activate(row: any): void { if (row.customer) { this.router.navigate(['/accounting/accounts', row.parentAccountId, 'ledger'], { queryParams: { partyId: row._id } }); return; } if (row.isGroup || row.systemKey === 'CUSTOMERS') { this.expanded.has(row._id) ? this.expanded.delete(row._id) : this.expanded.add(row._id); return; } this.router.navigate(['/accounting/accounts', row._id, 'ledger']); }
}
