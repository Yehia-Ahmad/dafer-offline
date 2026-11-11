import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
@Component({ selector: 'app-journal-detail', standalone: true, imports: [CommonModule, RouterLink, TranslateModule], templateUrl: './journal-detail.component.html', styleUrl: './journal-detail.component.scss' })
export class JournalDetailComponent {
  private http = inject(HttpClient); private route = inject(ActivatedRoute); private translate = inject(TranslateService); private cdr = inject(ChangeDetectorRef); entry: any; loading = true;
  ngOnInit(): void { this.http.get<any>(`${environment.api_base_url}accounting/journal/${this.route.snapshot.paramMap.get('id')}`).subscribe(entry => { this.entry = entry; this.loading = false; this.cdr.detectChanges(); }); }
  name(line: any): string { return (this.translate.currentLang || this.translate.defaultLang) === 'en' ? (line.accountNameEn || line.accountName) : (line.accountNameAr || line.accountName); }
  sourceLink(): any[] | null { const source = this.entry?.source; if (!source) return null; if (source.type === 'manual') return ['/accounting/manual-entry', source.id]; if (source.type === 'sale') return ['/invoice-history']; if (source.type === 'credit_sale') return ['/credit-sales', source.id]; if (source.type === 'return') return ['/returns']; return null; }
}
