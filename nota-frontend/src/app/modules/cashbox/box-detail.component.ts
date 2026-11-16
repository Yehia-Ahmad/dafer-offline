import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService } from '../../core/auth/auth.service';
import { NotaBalancePipe, NotaButtonDirective, NotaMoneyPipe, NotaPageHeaderComponent } from '../shared/ui';
import { BoxDetail, BoxLedger, LedgerLine } from './cashbox.models';
import { CashboxService } from './cashbox.service';
import { DepositOption, ShiftPanelComponent } from './shift-panel.component';
import { LayoutService } from '../../core/layout/layout.service';
import { MobBarComponent } from '../mobile/mob-sheet.component';
import { MobDatePipe } from '../mobile/mob-date.pipe';

/** Where a ledger line's source document can be opened (the route that lists it). */
const SOURCE_LINKS: Record<string, string> = { sale: '/invoice-history', credit_sale: '/credit-sales', return: '/returns', expense: '/expenses' };

/**
 * Stage 19: one box (CashBox.dc.html card → detail). Its ledger: every movement with its source document and a running
 * balance (the Stage 18 balance pipe, so a debit-normal asset shows مدين and a negative balance gets the warning), and
 * its shifts; a shift opens its panel (live for an open one, the printable summary for a closed one).
 */
@Component({
  selector: 'app-box-detail',
  standalone: true,
  imports: [DatePipe, RouterLink, TranslatePipe, NotaBalancePipe, NotaButtonDirective, NotaMoneyPipe, NotaPageHeaderComponent, ShiftPanelComponent, MobBarComponent, MobDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
@if (layout.isMobile()) {
    <!-- Online Stage 6B (phone): the same box page. The name is in the top bar; the balance as a card; the shift panel; each movement as a card (in green, out red, with its source document); the shifts as cards. -->
    @if (box(); as b) {
      <nota-mob-bar [title]="b.name" [subtitle]="('cashbox.types.' + b.type | translate) + (b.deviceName ? ' · ' + b.deviceName : '')" />
      <div class="m-page" style="padding-top:12px">
        <div class="m-dark-card">
          <div class="m-dark-card__label">{{ 'cashbox.detail.balance' | translate }}</div>
          <div class="m-dark-card__value nota-num" data-test="detail-balance">{{ b.balance ?? 0 | notaMoney }} {{ 'cashbox.currency' | translate }}</div>
        </div>

        @if (shiftId(); as id) {
          <app-shift-panel [shiftId]="id" [depositOptions]="depositOptions()" (closed)="load()" />
        }

        <div class="m-section-label">{{ 'cashbox.detail.ledger' | translate }}</div>
        <section class="m-card m-card--flush" data-test="ledger">
          @for (line of ledger()?.lines ?? []; track line.entryId + line.number) {
            <div class="m-row" [attr.data-source]="line.source?.type">
              <span class="m-row__body">
                <span class="m-row__title" style="white-space:normal">{{ 'cashbox.detail.sources.' + (line.source?.type ?? 'other') | translate }}
                  @if (link(line); as target) { <a [routerLink]="target" dir="ltr" style="color:var(--brand-strong-text)">{{ line.source?.number }}</a> } @else { <span dir="ltr">{{ line.source?.number }}</span> }</span>
                <span class="m-row__sub nota-num" style="white-space:normal">{{ line.date | mobDate }} · <a [routerLink]="['/accounting/journal', line.entryId]" dir="ltr" style="color:inherit;white-space:nowrap;display:inline-block">{{ line.number }}</a></span>
              </span>
              <span class="m-row__end nota-num">
                @if (line.debit) { <span class="m-in" style="display:block">+ {{ line.debit | notaMoney }}</span> }
                @if (line.credit) { <span class="m-out" style="display:block">− {{ line.credit | notaMoney }}</span> }
                @let running = shown(line) | notaBalance;
                <span class="m-row__sub" style="display:block" [class.m-out]="running.warning" data-test="line-balance">{{ running.abs | notaMoney }}</span>
              </span>
            </div>
          } @empty {
            <div class="m-empty" data-test="ledger-empty">{{ 'cashbox.detail.emptyLedger' | translate }}</div>
          }
        </section>

        @if (b.shiftsEnabled || b.shifts.length) {
          <div class="m-section-label">{{ 'cashbox.detail.shifts' | translate }}</div>
          <section class="m-card m-card--flush" data-test="shifts">
            @for (shift of b.shifts; track shift._id) {
              <div class="m-row m-stretch-host" [attr.data-shift]="shift.number">
                <button type="button" class="m-row__open m-stretch" data-action="show-shift" (click)="shiftId.set(shift._id)">
                  <span class="m-row__title" style="display:block" dir="auto">{{ shift.userName }} · <span dir="ltr">{{ shift.number }}</span></span>
                  <span class="m-row__sub nota-num" style="display:block">{{ shift.openedAt | mobDate: true }}</span>
                </button>
                <span class="m-row__end nota-num">
                  <span style="display:block">{{ shift.expected === null ? '—' : (shift.expected | notaMoney) }}</span>
                  <span class="m-row__sub" style="display:block" [class.m-out]="(shift.difference ?? 0) < 0">{{ shift.difference === null ? '—' : (shift.difference | notaMoney) }}</span>
                </span>
              </div>
            } @empty {
              <div class="m-empty">{{ 'cashbox.detail.noShifts' | translate }}</div>
            }
          </section>
        }
      </div>
    } @else if (loadFailed()) {
      <div class="m-page" style="padding-top:12px"><div class="m-card m-empty"><p class="nota-error" role="alert">{{ 'cashbox.loadFailed' | translate }}</p>
        <button type="button" class="m-btn" (click)="load()">{{ 'cashbox.retry' | translate }}</button></div></div>
    } @else {
      <div class="m-page" style="padding-top:12px"><div class="m-skel" style="height:110px" role="status" [attr.aria-label]="'cashbox.loading' | translate"></div><div class="m-skel" style="height:160px"></div></div>
    }
} @else {

    <div class="bd">
      @if (box(); as b) {
        <nota-page-header [title]="b.name" [subtitle]="('cashbox.types.' + b.type | translate) + (b.deviceName ? ' · ' + b.deviceName : '')" backLink="/cashbox" [backLabel]="'cashbox.title' | translate">
          <div notaPageActions>
            <span class="bd__balance nota-num" data-test="detail-balance">{{ b.balance ?? 0 | notaMoney }} {{ 'cashbox.currency' | translate }}</span>
          </div>
        </nota-page-header>

        @if (shiftId(); as id) {
          <app-shift-panel [shiftId]="id" [depositOptions]="depositOptions()" (closed)="load()" />
        }

        <section class="nota-card">
          <h2 class="nota-section-title">{{ 'cashbox.detail.ledger' | translate }}</h2>
          <div class="nota-table-wrap">
            <table class="nota-table" data-test="ledger">
              <thead><tr>
                <th>{{ 'cashbox.detail.date' | translate }}</th><th>{{ 'cashbox.detail.entry' | translate }}</th><th>{{ 'cashbox.detail.source' | translate }}</th>
                <th class="nota-num">{{ 'cashbox.detail.in' | translate }}</th><th class="nota-num">{{ 'cashbox.detail.out' | translate }}</th><th class="nota-num">{{ 'cashbox.detail.balance' | translate }}</th>
              </tr></thead>
              <tbody>
                @for (line of ledger()?.lines ?? []; track line.entryId + line.number) {
                  <tr [attr.data-source]="line.source?.type">
                    <td>{{ line.date | date: 'mediumDate' }}</td>
                    <td dir="ltr"><a [routerLink]="['/accounting/journal', line.entryId]">{{ line.number }}</a></td>
                    <td dir="ltr">
                      @if (link(line); as target) { <a [routerLink]="target">{{ line.source?.number }}</a> } @else { {{ line.source?.number }} }
                      <span class="bd__type">{{ 'cashbox.detail.sources.' + (line.source?.type ?? 'other') | translate }}</span>
                    </td>
                    <td class="nota-num">{{ line.debit ? (line.debit | notaMoney) : '' }}</td>
                    <td class="nota-num">{{ line.credit ? (line.credit | notaMoney) : '' }}</td>
                    <td class="nota-num">
                      @let running = shown(line) | notaBalance;
                      <span [class.bd__warn]="running.warning" data-test="line-balance">{{ running.text }}</span>
                    </td>
                  </tr>
                } @empty {
                  <tr><td colspan="6" class="bd__empty" data-test="ledger-empty">{{ 'cashbox.detail.emptyLedger' | translate }}</td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        @if (b.shiftsEnabled || b.shifts.length) {
          <section class="nota-card">
            <h2 class="nota-section-title">{{ 'cashbox.detail.shifts' | translate }}</h2>
            <div class="nota-table-wrap">
              <table class="nota-table" data-test="shifts">
                <thead><tr>
                  <th>{{ 'cashbox.detail.shiftNumber' | translate }}</th><th>{{ 'cashbox.detail.user' | translate }}</th><th>{{ 'cashbox.detail.openedAt' | translate }}</th>
                  <th class="nota-num">{{ 'cashbox.shift.expected' | translate }}</th><th class="nota-num">{{ 'cashbox.shift.counted' | translate }}</th><th class="nota-num">{{ 'cashbox.detail.difference' | translate }}</th><th></th>
                </tr></thead>
                <tbody>
                  @for (shift of b.shifts; track shift._id) {
                    <tr [attr.data-shift]="shift.number">
                      <td dir="ltr">{{ shift.number }}</td>
                      <td>{{ shift.userName }}</td>
                      <td class="nota-num">{{ shift.openedAt | date: 'short' }}</td>
                      <td class="nota-num">{{ shift.expected === null ? '—' : (shift.expected | notaMoney) }}</td>
                      <td class="nota-num">{{ shift.counted === null ? '—' : (shift.counted | notaMoney) }}</td>
                      <td class="nota-num" [class.bd__warn]="(shift.difference ?? 0) < 0">{{ shift.difference === null ? '—' : (shift.difference | notaMoney) }}</td>
                      <td><button type="button" notaButton data-action="show-shift" (click)="shiftId.set(shift._id)">{{ (shift.status === 'open' ? 'cashbox.shift.button' : 'cashbox.shift.summary') | translate }}</button></td>
                    </tr>
                  } @empty {
                    <tr><td colspan="7" class="bd__empty">{{ 'cashbox.detail.noShifts' | translate }}</td></tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }
      } @else if (loadFailed()) {
        <p class="nota-error" role="alert">{{ 'cashbox.loadFailed' | translate }}</p>
        <button type="button" notaButton (click)="load()">{{ 'cashbox.retry' | translate }}</button>
      } @else {
        <p role="status">{{ 'cashbox.loading' | translate }}</p>
      }
    </div>
  }
  `,
  styles: `
    :host { display: block; }
    .bd { display: flex; flex-direction: column; gap: 18px; }
    .bd__balance { font-size: 26px; font-weight: 800; }
    .bd__warn { color: var(--danger); font-weight: 700; }
    .bd__type { display: block; font-size: 12px; color: var(--text-muted); }
    .bd__empty { padding: 24px 16px; text-align: center; color: var(--text-muted); display: table-cell; }
  `,
})
export class BoxDetailComponent implements OnInit {
  protected readonly layout = inject(LayoutService);
  private readonly cashbox = inject(CashboxService);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);

  readonly box = signal<BoxDetail | null>(null);
  readonly ledger = signal<BoxLedger | null>(null);
  readonly loadFailed = signal(false);
  readonly shiftId = signal<string | null>(null);
  readonly depositOptions = signal<DepositOption[]>([]);
  readonly mayShift = computed(() => this.auth.hasAny('shift.operate', 'shift.manage'));

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    this.cashbox.box(id).subscribe({
      next: (box) => {
        this.box.set(box);
        this.loadFailed.set(false);
        if (box.openShift && this.mayShift()) this.shiftId.set(box.openShift._id);
        else if (this.shiftId() && !box.shifts.some((shift) => shift._id === this.shiftId())) this.shiftId.set(null);
      },
      error: () => this.loadFailed.set(true),
    });
    this.cashbox.boxLedger(id).subscribe({ next: (ledger) => this.ledger.set(ledger), error: () => this.ledger.set(null) });
    this.cashbox.boxes().subscribe({
      next: (response) => this.depositOptions.set(response.data.filter((candidate) => candidate.isActive).map((candidate) => ({ _id: candidate._id, name: candidate.name }))),
      error: () => this.depositOptions.set([]),
    });
  }

  /** The ledger shows a debit-normal asset: a positive number labelled مدين, a negative one gets the warning. */
  shown(line: LedgerLine) {
    return { ...line, normalSide: 'debit' as const };
  }

  link(line: LedgerLine): string[] | null {
    const target = line.source ? SOURCE_LINKS[line.source.type] : undefined;
    return target ? [target] : null;
  }
}
