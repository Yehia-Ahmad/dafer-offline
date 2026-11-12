import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpParams } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { NotaBalancePipe } from '../shared/ui';
@Component({ selector: 'app-account-ledger', standalone: true, imports: [CommonModule, FormsModule, RouterLink, TranslateModule, NotaBalancePipe], templateUrl: './ledger.component.html', styleUrl: './ledger.component.scss' })
export class LedgerComponent {
  private http = inject(HttpClient); private route = inject(ActivatedRoute); private translate = inject(TranslateService); private cdr = inject(ChangeDetectorRef); account: any; parties: any[] = []; lines: any[] = []; openingBalance = 0; balance = 0; side: 'debit' | 'credit' = 'debit'; absBalance = 0; openingSide: 'debit' | 'credit' = 'debit'; openingAbs = 0; from = ''; to = ''; partyId = ''; loading = true;
  /** Stage 22: the income statement's links pass excludeClosing, so the ledger leaves out the year-end closing entry like the statement does. */
  excludeClosing = false;
  ngOnInit(): void { const query = this.route.snapshot.queryParamMap; this.partyId = query.get('partyId') || ''; this.from = query.get('from') || this.from; this.to = query.get('to') || this.to; this.excludeClosing = ['1', 'true'].includes(query.get('excludeClosing') || ''); this.load(); }
  get accountName(): string { return (this.translate.currentLang || this.translate.defaultLang) === 'en' ? this.account?.nameEn : this.account?.nameAr; }
  /** The ledger shows every balance on the account's normal side rule: a positive number labelled debit / credit. */
  shown(source: any) { return { ...source, normalSide: this.account?.normalSide }; }
  lineName(line: any): string { return (this.translate.currentLang || this.translate.defaultLang) === 'en' ? (line.accountNameEn || line.accountName) : (line.accountNameAr || line.accountName); }
  sourceLink(line: any): any[] | null { if (line.source?.type === 'sale') return ['/invoice-history']; if (line.source?.type === 'credit_sale') return ['/credit-sales']; if (line.source?.type === 'return') return ['/returns']; return null; }
  load(): void { let params = new HttpParams(); if (this.from) params = params.set('from', this.from); if (this.to) params = params.set('to', this.to); if (this.partyId) params = params.set('partyId', this.partyId); if (this.excludeClosing) params = params.set('excludeClosing', '1'); this.http.get<any>(`${environment.api_base_url}accounting/accounts/${this.route.snapshot.paramMap.get('id')}/ledger`, { params }).subscribe(response => { this.account = response.account; this.parties = response.parties || []; this.lines = response.lines; this.openingBalance = response.openingBalance; this.balance = response.balance; this.side = response.side; this.absBalance = response.absBalance; this.openingSide = response.openingSide; this.openingAbs = response.openingAbsBalance; this.loading = false; this.cdr.detectChanges(); }); }
}
