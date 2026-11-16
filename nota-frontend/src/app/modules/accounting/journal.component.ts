import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpParams } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { ActivatedRoute } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';
import { LayoutService } from '../../core/layout/layout.service';
import { FilterChip, MobFilterChipsComponent, MobFilterSheetComponent } from '../mobile/mob-sheet.component';
import { MobDatePipe, formatMobDate } from '../mobile/mob-date.pipe';
import { MobDateInputComponent } from '../mobile/mob-date-input.component';
import { NotaMoneyPipe } from '../shared/ui';
import { environment } from '../../../environments/environment';
/** Journal entry types; labels come from accounting.entryTypes.<type> (ar/en). */
export const JOURNAL_ENTRY_TYPES = ['auto', 'reversal', 'legacy_reversal', 'opening'] as const;
@Component({ selector: 'app-accounting-journal', standalone: true, imports: [CommonModule, FormsModule, RouterLink, TranslateModule, NotaMoneyPipe, MobFilterChipsComponent, MobFilterSheetComponent, MobDatePipe, MobDateInputComponent], templateUrl: './journal.component.html', styleUrl: './journal.component.scss' })
export class JournalComponent {
  readonly entryTypes = JOURNAL_ENTRY_TYPES;
  protected readonly layout = inject(LayoutService);
  private readonly translateService = inject(TranslateService);
  /** Phone only (Online Stage 6B): the filter sheet and the active-filter chips over the same filter fields. */
  protected readonly filtersOpen = signal(false);
  protected activeChips(): FilterChip[] {
    const chips: FilterChip[] = [];
    const lang = this.translateService.currentLang || 'ar';
    if (this.filters.from) chips.push({ key: 'from', label: formatMobDate(this.filters.from, lang) });
    if (this.filters.to) chips.push({ key: 'to', label: formatMobDate(this.filters.to, lang) });
    if (this.filters.type) chips.push({ key: 'type', label: this.translateService.instant('accounting.entryTypes.' + this.filters.type) });
    if (this.filters.sourceType) chips.push({ key: 'sourceType', label: this.filters.sourceType });
    if (this.filters.number) chips.push({ key: 'number', label: this.filters.number });
    return chips;
  }
  protected removeChip(key: string): void { (this.filters as Record<string, string>)[key] = ''; this.load(1); }
  protected clearFilters(): void { this.filters = { from: '', to: '', type: '', sourceType: '', number: '' }; this.load(1); }
  private http = inject(HttpClient); private route = inject(ActivatedRoute); private cdr = inject(ChangeDetectorRef); entries: any[] = []; pagination = { page: 1, totalPages: 1, totalItems: 0 }; loading = true; error = ''; sourceId = ''; sourceNumber = ''; filters = { from: '', to: '', type: '', sourceType: '', number: '' };
  ngOnInit(): void { const query = this.route.snapshot.queryParamMap; this.filters.sourceType = query.get('sourceType') || ''; this.sourceId = query.get('sourceId') || ''; this.sourceNumber = query.get('sourceNumber') || ''; this.load(1); }
  sourceLink(entry: any): any[] | null { if (entry.source?.type === 'sale') return ['/invoice-history']; if (entry.source?.type === 'credit_sale') return ['/credit-sales']; if (entry.source?.type === 'return') return ['/returns']; return null; }
  load(page = 1): void { let params = new HttpParams().set('page', page); Object.entries(this.filters).forEach(([key, value]) => { if (value) params = params.set(key, value); }); if (this.sourceId) params = params.set('sourceId', this.sourceId); if (this.sourceNumber) params = params.set('sourceNumber', this.sourceNumber); this.loading = true; this.http.get<any>(`${environment.api_base_url}accounting/journal`, { params }).subscribe({ next: response => { this.entries = response.data || []; this.pagination = response.pagination; this.loading = false; this.cdr.detectChanges(); }, error: error => { this.error = error?.error?.message || 'Unable to load journal'; this.loading = false; this.cdr.detectChanges(); } }); }
}
