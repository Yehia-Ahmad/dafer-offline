import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { LanguageService } from '../../../shared/services/translation.service';
import {
  NotaButtonDirective,
  NotaEmptyStateComponent,
  NotaKpiNoteTone,
  NotaMoneyPipe,
  NotaNumberPipe,
  NotaPillVariant,
  formatNotaNumber,
  notaLocale,
} from '../../../shared/ui';
import { DashboardService, DashboardSummary } from '../../services/dashboard.service';

export interface DashboardKpi {
  key: string;
  labelKey: string;
  value: string;
  note: string;
  noteParams?: Record<string, unknown>;
  tone: NotaKpiNoteTone;
}

export interface DashboardBar {
  date: string;
  label: string;
  cash: number;
  credit: number;
  total: number;
  /** Bar heights in % of the tallest day. */
  cashPct: number;
  creditPct: number;
  isToday: boolean;
}

/**
 * Stage 12 dashboard (docs/design/screens/Dashboard.dc.html, DashboardDark.dc.html), route /home.
 * One read-only request: GET /api/dashboard/summary. Cash box, expenses and cashier are later phases.
 */
@Component({
  selector: 'app-home',
  standalone: true,
  imports: [RouterLink, TranslatePipe, NotaButtonDirective, NotaEmptyStateComponent, NotaMoneyPipe, NotaNumberPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.scss'],
})
export class HomeComponent implements OnInit {
  private readonly dashboard = inject(DashboardService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly language = inject(LanguageService);

  readonly summary = signal<DashboardSummary | null>(null);
  readonly loading = signal(true);
  readonly failed = signal(false);

  /** Greeting by the time of day on this PC. */
  readonly greetingKey = computed(() => (new Date().getHours() < 12 ? 'dashboard.greeting.morning' : 'dashboard.greeting.evening'));

  /** "الأربعاء ٤ نوفمبر" from the server's date when loaded, else this PC's date. */
  readonly dateLabel = computed(() => {
    const lang = this.language.selectedLanguage();
    const date = this.summary() ? parseDateKey(this.summary()!.date) : new Date();
    return new Intl.DateTimeFormat(notaLocale(lang), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  });

  /** A shop with no invoice at all yet (first run): show the getting-started card. */
  readonly isNewShop = computed(() => {
    const summary = this.summary();
    return !!summary && summary.recentInvoices.length === 0;
  });

  readonly kpis = computed<DashboardKpi[]>(() => {
    const summary = this.summary();
    if (!summary) return [];
    const lang = this.language.selectedLanguage();
    const money = (value: number) => formatNotaNumber(value, lang, 'money');
    const todayTotal = summary.today.cash.total + summary.today.credit.total;
    const yesterdayTotal = summary.yesterday.cash.total + summary.yesterday.credit.total;
    const change = salesChange(todayTotal, yesterdayTotal);
    return [
      {
        key: 'sales',
        labelKey: 'dashboard.kpis.salesToday',
        value: money(todayTotal),
        note: change === null ? 'dashboard.kpis.noYesterday' : change >= 0 ? 'dashboard.kpis.upFromYesterday' : 'dashboard.kpis.downFromYesterday',
        noteParams: change === null ? undefined : { percent: formatNotaNumber(Math.abs(change), lang) },
        tone: change === null ? 'neutral' : change >= 0 ? 'success' : 'danger',
      },
      {
        key: 'invoices',
        labelKey: 'dashboard.kpis.invoicesToday',
        value: formatNotaNumber(summary.today.cash.count + summary.today.credit.count, lang),
        note: 'dashboard.kpis.invoicesSplit',
        noteParams: { cash: formatNotaNumber(summary.today.cash.count, lang), credit: formatNotaNumber(summary.today.credit.count, lang) },
        tone: 'neutral',
      },
      {
        key: 'outstanding',
        labelKey: 'dashboard.kpis.outstanding',
        value: money(summary.credit.outstanding),
        note: summary.credit.overdueCount ? 'dashboard.kpis.overdue' : 'dashboard.kpis.customersWithBalance',
        noteParams: summary.credit.overdueCount
          ? { count: formatNotaNumber(summary.credit.overdueCount, lang), amount: money(summary.credit.overdueAmount) }
          : { count: formatNotaNumber(summary.credit.customersWithBalance, lang) },
        tone: summary.credit.overdueCount ? 'danger' : 'neutral',
      },
    ];
  });

  readonly bars = computed<DashboardBar[]>(() => {
    const summary = this.summary();
    if (!summary) return [];
    const formatter = new Intl.DateTimeFormat(notaLocale(this.language.selectedLanguage()), { weekday: 'long' });
    const max = Math.max(1, ...summary.last7Days.map((day) => day.cash + day.credit));
    return summary.last7Days.map((day) => ({
      date: day.date,
      label: formatter.format(parseDateKey(day.date)),
      cash: day.cash,
      credit: day.credit,
      total: Math.round((day.cash + day.credit) * 100) / 100,
      cashPct: (Math.max(0, day.cash) / max) * 100,
      creditPct: (Math.max(0, day.credit) / max) * 100,
      isToday: day.date === summary.date,
    }));
  });

  readonly hasWeekSales = computed(() => this.bars().some((bar) => bar.total > 0));

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.failed.set(false);
    this.dashboard.getSummary().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (summary) => {
        this.summary.set(summary);
        this.loading.set(false);
      },
      error: () => {
        this.failed.set(true);
        this.loading.set(false);
      },
    });
  }

  /** Low-stock pill: red when at or below half the threshold (or out of stock), amber otherwise. */
  stockVariant(row: { inventoryCount: number; threshold: number }): NotaPillVariant {
    return row.inventoryCount <= 0 || row.inventoryCount <= row.threshold / 2 ? 'overdue' : 'due';
  }

  /** Time today, otherwise the date. */
  invoiceTime(row: DashboardSummary['recentInvoices'][number]): string {
    const created = new Date(row.createdAt);
    if (Number.isNaN(created.getTime())) return '—';
    const locale = notaLocale(this.language.selectedLanguage());
    const sameDay = created.toDateString() === new Date().toDateString();
    return new Intl.DateTimeFormat(locale, sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' }).format(created);
  }

  /** Short invoice reference: last 6 characters of the id, as the other lists show it. */
  shortRef(reference: string): string {
    return reference ? `#${reference.slice(-6).toUpperCase()}` : '—';
  }
}

/** Percent change from yesterday; null when there was nothing yesterday. One decimal. */
export function salesChange(today: number, yesterday: number): number | null {
  if (!yesterday) return null;
  return Math.round(((today - yesterday) / yesterday) * 1000) / 10;
}

/** 'YYYY-MM-DD' as a local date (for weekday / date labels). */
function parseDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}
