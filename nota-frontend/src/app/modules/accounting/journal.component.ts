import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';

@Component({ selector: 'app-accounting-journal', standalone: true, imports: [CommonModule, TranslateModule], template: `
<section class="nota-page accounting-page"><header><h1>{{ 'accounting.journal.title' | translate }}</h1><input [value]="number" (input)="number=$any($event.target).value;load()" placeholder="JE-000001"></header><div *ngIf="loading" role="status">{{ 'common.loading' | translate }}</div><div *ngIf="error" role="alert">{{ error }}</div><table *ngIf="!loading"><thead><tr><th>{{ 'accounting.number' | translate }}</th><th>{{ 'accounting.date' | translate }}</th><th>{{ 'accounting.total' | translate }}</th></tr></thead><tbody><tr *ngFor="let entry of entries" (click)="selected=entry"><td dir="ltr">{{ entry.number }}</td><td>{{ entry.date | date }}</td><td>{{ entry.totalDebit | number:'1.2-2' }}</td></tr></tbody></table><article *ngIf="selected"><h2>{{ selected.number }}</h2><p>{{ selected.memo }}</p><div *ngFor="let line of selected.lines"><span dir="ltr">{{ line.accountCode }}</span> {{ line.accountName }} {{ line.partyName || '' }} <b>{{ line.debit | number:'1.2-2' }}</b> <b>{{ line.credit | number:'1.2-2' }}</b></div></article></section>` })
export class JournalComponent {
  private http = inject(HttpClient); entries: any[] = []; selected: any; loading = true; error = ''; number = '';
  ngOnInit(): void { this.load(); }
  load(): void { this.loading = true; this.http.get<any>(`${environment.api_base_url}accounting/journal`, { params: this.number ? { number: this.number } : {} }).subscribe({ next: (r) => { this.entries = r.data || []; this.loading = false; }, error: (e) => { this.error = e?.error?.message || 'Unable to load journal'; this.loading = false; } }); }
}
