import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpParams } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { ActivatedRoute } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
/** Journal entry types; labels come from accounting.entryTypes.<type> (ar/en). */
export const JOURNAL_ENTRY_TYPES = ['auto', 'reversal', 'legacy_reversal', 'opening'] as const;
@Component({ selector: 'app-accounting-journal', standalone: true, imports: [CommonModule, FormsModule, RouterLink, TranslateModule], templateUrl: './journal.component.html', styleUrl: './journal.component.scss' })
export class JournalComponent {
  readonly entryTypes = JOURNAL_ENTRY_TYPES;
  private http = inject(HttpClient); private route = inject(ActivatedRoute); private cdr = inject(ChangeDetectorRef); entries: any[] = []; pagination = { page: 1, totalPages: 1, totalItems: 0 }; loading = true; error = ''; sourceId = ''; sourceNumber = ''; filters = { from: '', to: '', type: '', sourceType: '', number: '' };
  ngOnInit(): void { const query = this.route.snapshot.queryParamMap; this.filters.sourceType = query.get('sourceType') || ''; this.sourceId = query.get('sourceId') || ''; this.sourceNumber = query.get('sourceNumber') || ''; this.load(1); }
  sourceLink(entry: any): any[] | null { if (entry.source?.type === 'sale') return ['/invoice-history']; if (entry.source?.type === 'credit_sale') return ['/credit-sales']; if (entry.source?.type === 'return') return ['/returns']; return null; }
  load(page = 1): void { let params = new HttpParams().set('page', page); Object.entries(this.filters).forEach(([key, value]) => { if (value) params = params.set(key, value); }); if (this.sourceId) params = params.set('sourceId', this.sourceId); if (this.sourceNumber) params = params.set('sourceNumber', this.sourceNumber); this.loading = true; this.http.get<any>(`${environment.api_base_url}accounting/journal`, { params }).subscribe({ next: response => { this.entries = response.data || []; this.pagination = response.pagination; this.loading = false; this.cdr.detectChanges(); }, error: error => { this.error = error?.error?.message || 'Unable to load journal'; this.loading = false; this.cdr.detectChanges(); } }); }
}
