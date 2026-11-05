import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';

@Component({ selector: 'app-accounting-accounts', standalone: true, imports: [CommonModule, TranslateModule], template: `
<section class="nota-page accounting-page"><header><h1>{{ 'accounting.accounts.title' | translate }}</h1><label>{{ 'accounting.asOf' | translate }} <input type="date" [value]="asOf" (change)="load($any($event.target).value)"></label></header>
<div *ngIf="loading" role="status">{{ 'common.loading' | translate }}</div><div *ngIf="error" role="alert">{{ error }}</div>
<ul *ngIf="!loading"><ng-container *ngFor="let account of accounts"><li><button type="button" (click)="open(account)"><span dir="ltr">{{ account.code }}</span> {{ account.nameEn }} <strong>{{ account.balance | number:'1.2-2' }}</strong></button><ul *ngIf="account.children?.length"><li *ngFor="let child of account.children"><span dir="ltr">{{ child.code }}</span> {{ child.nameEn }} <strong>{{ child.balance | number:'1.2-2' }}</strong></li></ul><ul *ngIf="account.virtualCustomers?.length"><li *ngFor="let customer of account.virtualCustomers">{{ customer.name }} <strong>{{ customer.balance | number:'1.2-2' }}</strong></li></ul></li></ng-container></ul></section>` })
export class AccountsComponent {
  private http = inject(HttpClient); accounts: any[] = []; loading = true; error = ''; asOf = new Date().toISOString().slice(0, 10);
  ngOnInit(): void { this.load(this.asOf); }
  load(asOf: string): void { this.asOf = asOf; this.loading = true; this.error = ''; this.http.get<any>(`${environment.api_base_url}accounting/accounts`, { params: { asOf } }).subscribe({ next: (r) => { this.accounts = r.accounts || []; this.loading = false; }, error: (e) => { this.error = e?.error?.message || 'Unable to load accounts'; this.loading = false; } }); }
  open(account: any): void { if (!account.isGroup) account.open = !account.open; }
}
