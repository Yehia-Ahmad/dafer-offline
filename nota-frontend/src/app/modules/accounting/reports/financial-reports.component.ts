import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { PrintActionItem, PrintActionsComponent } from '../../../core/print/print-actions.component';
import { PrintDataService } from '../../../core/print/print-data.service';
import { localDateKey } from '../../../core/utilities/local-date';
import { NotaButtonDirective, NotaPageHeaderComponent } from '../../shared/ui';
import { formatNotaNumber } from '../../shared/ui/nota-number';
import { LanguageService } from '../../shared/services/translation.service';
import { ShopProfileService } from '../../shop-profile/services/shop-profile.service';
import { ReportsService } from './reports.service';
import { LayoutService } from '../../../core/layout/layout.service';
import { MobSheetComponent } from '../../mobile/mob-sheet.component';
import {
  AGING_KEYS, BalanceSheet, BoxMovements, IncomeRow, IncomeStatement, PartyBalances, PartyRow, ReportKey, ReportQuery, ReportTab, SheetRow, TrialBalance, TrialRow,
} from './reports.models';


type Preset = 'thisMonth' | 'lastMonth' | 'thisYear' | 'custom';
const TABS: readonly ReportTab[] = ['income', 'balance', 'trial', 'boxes', 'parties'];
const REPORT_KEY: Record<ReportTab, ReportKey> = { income: 'income-statement', balance: 'balance-sheet', trial: 'trial-balance', boxes: 'box-movements', parties: 'party-balances' };

/** A row in the flattened table: depth for the indent. */
interface Flat<T> { row: T; depth: number }

const flatten = <T extends { children?: T[]; isZero: boolean; kind: string }>(rows: readonly T[], keepAlways: readonly string[], showZero: boolean, depth = 0, out: Flat<T>[] = []): Flat<T>[] => {
  for (const row of rows) {
    if (!showZero && row.isZero && !keepAlways.includes(row.kind)) continue;
    out.push({ row, depth });
    if (row.children?.length) flatten(row.children, keepAlways, showZero, depth + 1, out);
  }
  return out;
};

/**
 * Stage 22: "التقارير المالية" (/accounting/reports): income statement, balance sheet, trial balance, box movements, customer and
 * supplier balances with aging. Read-only, every figure from the ledger (the aging from the statements). Each amount links to its
 * account ledger (and from there to the entry); "Excel للمحاسب" exports the same rows. reports.financial is the only permission.
 */
@Component({
  selector: 'app-financial-reports',
  imports: [PrintActionsComponent, FormsModule, RouterLink, TranslatePipe, NotaButtonDirective, NotaPageHeaderComponent, MobSheetComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
@if (layout.isMobile()) {
    <!-- Online Stage 6B (phone): the same financial reports. The report picker as chips; the period / switches in a sheet; the income statement and balance sheet as sections with subtotal rows; the wide tables (trial balance, boxes, balances) scroll inside their own card with the first column fixed. -->
    <div class="m-chips" style="padding-top:12px" role="tablist" [attr.aria-label]="'reports.title' | translate">
      @for (item of tabs; track item) {
        <button type="button" role="tab" class="m-chip" [class.is-active]="tab() === item" [attr.aria-selected]="tab() === item" [attr.data-tab]="item" (click)="setTab(item)">{{ 'reports.tabs.' + item | translate }}</button>
      }
    </div>
    <div style="display:flex;gap:8px;padding:0 14px 8px">
      @if (tab() !== 'parties') { <button type="button" class="m-btn" style="flex:1" (click)="filtersOpen.set(true)" data-testid="m-report-filters" data-test="filters">{{ 'mobile.common.filters' | translate }}</button> }
      <button type="button" class="m-btn" style="flex:1" data-action="export" [disabled]="exporting() || !current()" (click)="exportExcel()">{{ 'reports.excel' | translate }}</button>
    </div>
    <div style="padding:0 14px 8px"><nota-print-actions [items]="printItems()" data-test="report-print" /></div>
    @if (error()) { <p class="nota-error m-note" role="alert" data-test="error">{{ error() | translate }}</p> }

    <div class="m-page" data-test="report" [attr.data-report]="tab()">
      @if (loading()) { <div class="m-skel m-skel-row" style="margin:0" data-test="loading"></div> }
      @if (header(); as head) {
        <div data-test="report-header">
          <div class="m-section-label" style="margin:0">{{ 'reports.tabs.' + tab() | translate }}</div>
          <p class="m-note" style="padding:2px 4px" data-test="report-sub">@if (head.shopName) { <span data-test="shop-name">{{ head.shopName }}</span> · }@if (head.asOf) { {{ 'reports.asOfDate' | translate: { date: head.asOf } }} } @else { {{ 'reports.periodRange' | translate: { from: head.from, to: head.to } }} } · <span data-test="currency">{{ 'reports.currency' | translate }}</span></p>
        </div>
      }
      @switch (tab()) {
        @case ('income') {
          @if (income(); as r) {
            <div class="m-card m-card--flush" data-test="income-table">
              @for (item of incomeRows(); track item.row.id) {
                <div class="m-row" [style.padding-inline-start.px]="14 + item.depth * 16" [style.font-weight]="item.row.kind === 'total' ? 800 : item.row.kind === 'subtotal' || item.row.kind === 'group' ? 700 : 400"
                  [style.background]="item.row.kind === 'total' ? 'var(--brand-soft)' : null" [attr.data-row]="item.row.code || item.row.id">
                  <span class="m-row__body" style="white-space:normal">
                    @if (item.row.accountId && item.row.kind === 'line') {
                      <a [routerLink]="ledgerLink(item.row.accountId)" [queryParams]="{ from: r.period.from, to: r.period.to, excludeClosing: 1 }" data-link="ledger" style="color:var(--brand-strong-text)">{{ name(item.row) }}</a>
                    } @else { {{ name(item.row) }} }
                    @if (item.row.sign < 0 && (item.row.kind === 'line' || item.row.kind === 'group')) { <small class="m-row__sub">(−)</small> }
                    @if (r.comparison) { <span class="m-row__sub nota-num" style="display:block;font-weight:400" data-cell="previous">{{ 'reports.previous' | translate }} {{ incomeAmount(item.row, item.row.previous) }} · {{ 'reports.change' | translate }} {{ incomeAmount(item.row, item.row.change) }}</span> }
                  </span>
                  <span class="nota-num" data-cell="amount">{{ incomeAmount(item.row, item.row.amount) }}</span>
                </div>
              }
            </div>
            @if (r.check.difference !== 0) { <p class="nota-error" role="alert" data-test="income-check">{{ 'reports.checkFailed' | translate }}</p> }
          }
        }
        @case ('balance') {
          @if (balance(); as r) {
            @for (section of sheetSections(); track section.key) {
              <div class="m-section-label" style="margin-bottom:0">{{ 'reports.sheet.' + section.key | translate }}</div>
              <div class="m-card m-card--flush" [attr.data-section]="section.key">
                @for (item of section.rows; track item.row.id) {
                  <div class="m-row" [style.padding-inline-start.px]="14 + item.depth * 16" [style.font-weight]="item.row.kind === 'group' ? 700 : 400" [attr.data-row]="item.row.code || item.row.id">
                    <span class="m-row__body" style="white-space:normal">
                      @if (item.row.accountId && item.row.kind === 'line') { <a [routerLink]="ledgerLink(item.row.accountId)" [queryParams]="{ to: r.asOf }" data-link="ledger" style="color:var(--brand-strong-text)">{{ name(item.row) }}</a> } @else { {{ name(item.row) }} }
                    </span>
                    <span class="nota-num" [class.m-out]="item.row.opposite" data-cell="amount">{{ money(item.row.amount) }}@if (item.row.opposite) { <small> {{ 'accounting.side.' + item.row.side | translate }}</small> }</span>
                  </div>
                }
                <div class="m-row" style="background:var(--brand-soft);font-weight:800"><span class="m-row__body">{{ 'reports.sheet.total' | translate: { name: ('reports.sheet.' + section.key | translate) } }}</span><span class="nota-num" [attr.data-total]="section.key">{{ money(section.total) }}</span></div>
              </div>
            }
            <p class="m-pill" [class.m-pill--ok]="r.check.difference === 0" [class.m-pill--warn]="r.check.difference !== 0" style="white-space:normal" data-test="balance-check">
              {{ 'reports.sheet.check' | translate }}: {{ money(r.check.assets) }} = {{ money(r.check.liabilitiesAndEquity) }} · {{ 'reports.sheet.difference' | translate }}: <strong data-test="balance-difference">{{ money(r.check.difference) }}</strong>
            </p>
          }
        }
        @case ('trial') {
          @if (trial(); as r) {
            <div class="m-card m-card--flush m-scroll">
              <table class="nota-table fr__table fr__table--wide" data-test="trial-table">
                <thead>
                  <tr><th rowspan="2">{{ 'reports.account' | translate }}</th><th class="nota-num" colspan="2">{{ 'reports.opening' | translate }}</th><th class="nota-num" colspan="2">{{ 'reports.movement' | translate }}</th><th class="nota-num" colspan="2">{{ 'reports.closing' | translate }}</th></tr>
                  <tr><th class="nota-num">{{ 'accounting.debit' | translate }}</th><th class="nota-num">{{ 'accounting.credit' | translate }}</th><th class="nota-num">{{ 'accounting.debit' | translate }}</th><th class="nota-num">{{ 'accounting.credit' | translate }}</th><th class="nota-num">{{ 'accounting.debit' | translate }}</th><th class="nota-num">{{ 'accounting.credit' | translate }}</th></tr>
                </thead>
                <tbody>
                  @for (item of trialRows(); track item.row.id) {
                    <tr class="fr__row" [class.fr__row--sub]="item.row.kind === 'group'" [attr.data-row]="item.row.code">
                      <td [style.padding-inline-start.px]="12 + item.depth * 20" style="min-width:150px"><span class="fr__code nota-num" dir="ltr">{{ item.row.code }}</span>
                        @if (item.row.accountId && item.row.kind === 'line') { <a class="fr__link" [routerLink]="ledgerLink(item.row.accountId)" [queryParams]="{ from: r.period.from, to: r.period.to }" data-link="ledger">{{ name(item.row) }}</a> } @else { {{ name(item.row) }} }
                      </td>
                      <td class="nota-num">{{ cell(item.row.openingDebit) }}</td><td class="nota-num">{{ cell(item.row.openingCredit) }}</td>
                      <td class="nota-num">{{ cell(item.row.movementDebit) }}</td><td class="nota-num">{{ cell(item.row.movementCredit) }}</td>
                      <td class="nota-num">{{ cell(item.row.closingDebit) }}</td><td class="nota-num">{{ cell(item.row.closingCredit) }}</td>
                    </tr>
                  }
                </tbody>
                <tfoot><tr class="fr__row fr__row--total" data-test="trial-totals">
                  <td>{{ 'reports.total' | translate }}</td>
                  <td class="nota-num">{{ money(r.totals.openingDebit) }}</td><td class="nota-num">{{ money(r.totals.openingCredit) }}</td>
                  <td class="nota-num">{{ money(r.totals.movementDebit) }}</td><td class="nota-num">{{ money(r.totals.movementCredit) }}</td>
                  <td class="nota-num">{{ money(r.totals.closingDebit) }}</td><td class="nota-num">{{ money(r.totals.closingCredit) }}</td>
                </tr></tfoot>
              </table>
            </div>
            <p class="m-pill" [class.m-pill--ok]="r.balanced" [class.m-pill--warn]="!r.balanced" style="white-space:normal" data-test="trial-balanced">{{ (r.balanced ? 'reports.trialBalanced' : 'reports.trialUnbalanced') | translate }}</p>
          }
        }
        @case ('boxes') {
          @if (boxes(); as r) {
            <div class="m-card m-card--flush m-scroll">
              <table class="nota-table fr__table fr__table--wide" data-test="boxes-table">
                <thead><tr><th>{{ 'reports.box' | translate }}</th><th class="nota-num">{{ 'reports.opening' | translate }}</th><th class="nota-num">{{ 'reports.in' | translate }}</th><th class="nota-num">{{ 'reports.out' | translate }}</th><th class="nota-num">{{ 'reports.closing' | translate }}</th></tr></thead>
                <tbody>
                  @for (box of r.boxes; track box.boxId) {
                    <tr class="fr__row fr__row--sub fr__box" [attr.data-box]="box.boxId" tabindex="0" role="button" (click)="toggleBox(box.boxId)" (keydown.enter)="toggleBox(box.boxId)">
                      <td style="min-width:130px"><a class="fr__link" [routerLink]="['/cashbox', box.boxId]" data-link="box" (click)="$event.stopPropagation()">{{ box.name }}</a>@if (!box.isActive) { <small class="fr__muted"> {{ 'reports.inactive' | translate }}</small> }</td>
                      <td class="nota-num">{{ money(box.opening) }}</td><td class="nota-num">{{ money(box.in) }}</td><td class="nota-num">{{ money(box.out) }}</td><td class="nota-num"><strong>{{ money(box.closing) }}</strong></td>
                    </tr>
                    @if (openBoxes().has(box.boxId)) {
                      @for (kind of box.byKind; track kind.key) {
                        <tr class="fr__row" [attr.data-kind]="box.boxId + ':' + kind.key"><td [style.padding-inline-start.px]="32">{{ kindName(kind) }}</td><td></td><td class="nota-num">{{ cell(kind.in) }}</td><td class="nota-num">{{ cell(kind.out) }}</td><td></td></tr>
                      } @empty { <tr><td colspan="5" class="fr__muted" [style.padding-inline-start.px]="32">{{ 'reports.noMovement' | translate }}</td></tr> }
                    }
                  }
                </tbody>
                <tfoot><tr class="fr__row fr__row--total" data-test="boxes-totals"><td>{{ 'reports.total' | translate }}</td><td class="nota-num">{{ money(r.totals.opening) }}</td><td class="nota-num">{{ money(r.totals.in) }}</td><td class="nota-num">{{ money(r.totals.out) }}</td><td class="nota-num">{{ money(r.totals.closing) }}</td></tr></tfoot>
              </table>
            </div>
          }
        }
        @case ('parties') {
          @if (parties(); as r) {
            @for (group of partyGroups(); track group.key) {
              <div class="m-section-label" style="margin-bottom:0">{{ 'reports.parties.' + group.key | translate }}</div>
              <div class="m-card m-card--flush m-scroll">
                <table class="nota-table fr__table fr__table--wide" [attr.data-test]="group.key + '-table'">
                  <thead><tr><th>{{ 'reports.parties.name' | translate }}</th><th class="nota-num">{{ 'reports.parties.balance' | translate }}</th>@for (bucket of buckets; track bucket) { <th class="nota-num">{{ 'reports.aging.' + bucket | translate }}</th> }<th class="nota-num">{{ 'reports.parties.advance' | translate }}</th></tr></thead>
                  <tbody>
                    @for (row of group.rows; track row.partyId) {
                      <tr class="fr__row" [attr.data-party]="row.partyId">
                        <td style="min-width:120px">@if (group.key === 'customers') { <a class="fr__link" [routerLink]="['/customers', row.partyId]" data-link="party">{{ row.name }}</a> } @else { <a class="fr__link" routerLink="/suppliers" [queryParams]="{ statement: row.partyId }" data-link="party">{{ row.name }}</a> }</td>
                        <td class="nota-num" [class.fr__warn]="row.opposite">{{ money(row.absBalance) }} <small>{{ 'accounting.side.' + row.side | translate }}</small></td>
                        @for (bucket of buckets; track bucket) { <td class="nota-num">{{ cell(row.aging[bucket]) }}</td> }
                        <td class="nota-num">{{ cell(row.advance) }}</td>
                      </tr>
                    } @empty { <tr><td [attr.colspan]="buckets.length + 3" class="fr__muted">{{ 'reports.parties.none' | translate }}</td></tr> }
                  </tbody>
                  <tfoot><tr class="fr__row fr__row--total" [attr.data-totals]="group.key"><td>{{ 'reports.total' | translate }}</td><td class="nota-num">{{ money(group.totals.balance) }}</td>@for (bucket of buckets; track bucket) { <td class="nota-num">{{ money(group.totals[bucket]) }}</td> }<td class="nota-num">{{ money(group.totals.advance) }}</td></tr></tfoot>
                </table>
              </div>
            }
          }
        }
      }
    </div>

    <nota-mob-sheet [(open)]="filtersOpen" [title]="'mobile.common.filters' | translate">
      @if (tab() === 'balance') {
        <div class="m-field">{{ 'reports.asOf' | translate }}<input class="m-input nota-num" type="date" data-test="as-of" [ngModel]="asOf()" (ngModelChange)="asOf.set($event); load()" /></div>
      } @else if (tab() !== 'parties') {
        <div class="m-chips" style="padding:0 0 12px" role="group" [attr.aria-label]="'reports.period' | translate">
          @for (item of presets; track item) { <button type="button" class="m-chip" [class.is-active]="preset() === item" [attr.data-preset]="item" [attr.aria-pressed]="preset() === item" (click)="applyPreset(item)">{{ 'reports.presets.' + item | translate }}</button> }
        </div>
        @if (preset() === 'custom') {
          <div class="m-field">{{ 'reports.from' | translate }}<input class="m-input nota-num" type="date" data-test="from" [ngModel]="from()" (ngModelChange)="from.set($event); load()" /></div>
          <div class="m-field">{{ 'reports.to' | translate }}<input class="m-input nota-num" type="date" data-test="to" [ngModel]="to()" (ngModelChange)="to.set($event); load()" /></div>
        }
      }
      @if (tab() === 'income') { <label class="m-switch"><span>{{ 'reports.compare' | translate }}</span><input type="checkbox" data-test="compare" [ngModel]="compare()" (ngModelChange)="compare.set($event); load()" /></label> }
      @if (tab() === 'income' || tab() === 'balance' || tab() === 'trial' || tab() === 'parties') { <label class="m-switch"><span>{{ 'reports.showZero' | translate }}</span><input type="checkbox" data-test="zero-toggle" [ngModel]="showZero()" (ngModelChange)="showZero.set($event)" /></label> }
    </nota-mob-sheet>
} @else {

    <div class="fr">
      <nota-page-header [title]="'reports.title' | translate" [subtitle]="'reports.subtitle' | translate">
        <div notaPageActions class="fr__actions">
          <nota-print-actions [items]="printItems()" data-test="report-print" />
          <button type="button" notaButton data-action="export" [disabled]="exporting() || !current()" (click)="exportExcel()">{{ 'reports.excel' | translate }}</button>
        </div>
      </nota-page-header>

      <div class="fr__tabs" role="tablist" [attr.aria-label]="'reports.title' | translate">
        @for (item of tabs; track item) {
          <button type="button" role="tab" class="fr__tab" [class.fr__tab--on]="tab() === item" [attr.aria-selected]="tab() === item" [attr.data-tab]="item" (click)="setTab(item)">
            {{ 'reports.tabs.' + item | translate }}
          </button>
        }
      </div>

      <section class="nota-card fr__filters" data-test="filters">
        @if (tab() === 'balance') {
          <label class="fr__field"><span class="nota-label">{{ 'reports.asOf' | translate }}</span>
            <input class="nota-input nota-num" type="date" data-test="as-of" [ngModel]="asOf()" (ngModelChange)="asOf.set($event); load()" /></label>
        } @else if (tab() !== 'parties') {
          <div class="fr__presets" role="group" [attr.aria-label]="'reports.period' | translate">
            @for (item of presets; track item) {
              <button type="button" class="fr__preset" [class.fr__preset--on]="preset() === item" [attr.data-preset]="item" [attr.aria-pressed]="preset() === item" (click)="applyPreset(item)">{{ 'reports.presets.' + item | translate }}</button>
            }
          </div>
          @if (preset() === 'custom') {
            <label class="fr__field"><span class="nota-label">{{ 'reports.from' | translate }}</span>
              <input class="nota-input nota-num" type="date" data-test="from" [ngModel]="from()" (ngModelChange)="from.set($event); load()" /></label>
            <label class="fr__field"><span class="nota-label">{{ 'reports.to' | translate }}</span>
              <input class="nota-input nota-num" type="date" data-test="to" [ngModel]="to()" (ngModelChange)="to.set($event); load()" /></label>
          }
        }
        @if (tab() === 'income') {
          <label class="fr__check"><input type="checkbox" data-test="compare" [ngModel]="compare()" (ngModelChange)="compare.set($event); load()" /> {{ 'reports.compare' | translate }}</label>
        }
        @if (tab() === 'income' || tab() === 'balance' || tab() === 'trial' || tab() === 'parties') {
          <label class="fr__check"><input type="checkbox" data-test="zero-toggle" [ngModel]="showZero()" (ngModelChange)="showZero.set($event)" /> {{ 'reports.showZero' | translate }}</label>
        }
      </section>

      @if (error()) { <p class="nota-error" role="alert" data-test="error">{{ error() | translate }}</p> }

      <section class="nota-card fr__report" data-test="report" [attr.data-report]="tab()">
        @if (loading()) { <p class="fr__note" data-test="loading">…</p> }

        @if (header(); as head) {
          <header class="fr__head" data-test="report-header">
            <h2 class="fr__title">{{ 'reports.tabs.' + tab() | translate }}</h2>
            <p class="fr__sub" data-test="report-sub">
              @if (head.shopName) { <span data-test="shop-name">{{ head.shopName }}</span> · }
              @if (head.asOf) { {{ 'reports.asOfDate' | translate: { date: head.asOf } }} } @else { {{ 'reports.periodRange' | translate: { from: head.from, to: head.to } }} }
              · <span data-test="currency">{{ 'reports.currency' | translate }}</span>
            </p>
          </header>
        }

        @switch (tab()) {
          @case ('income') {
            @if (income(); as r) {
              <div class="nota-table-wrap">
                <table class="nota-table fr__table" data-test="income-table">
                  <thead><tr>
                    <th>{{ 'reports.item' | translate }}</th>
                    <th class="nota-num">{{ 'reports.amount' | translate }}</th>
                    @if (r.comparison) { <th class="nota-num" data-test="prev-head">{{ 'reports.previous' | translate }}</th><th class="nota-num">{{ 'reports.change' | translate }}</th> }
                  </tr></thead>
                  <tbody>
                    @for (item of incomeRows(); track item.row.id) {
                      <tr class="fr__row" [class.fr__row--sub]="item.row.kind === 'subtotal' || item.row.kind === 'group'" [class.fr__row--total]="item.row.kind === 'total'" [attr.data-row]="item.row.code || item.row.id">
                        <td [style.padding-inline-start.px]="12 + item.depth * 20">
                          @if (item.row.accountId && item.row.kind === 'line') {
                            <a class="fr__link" [routerLink]="ledgerLink(item.row.accountId)" [queryParams]="{ from: r.period.from, to: r.period.to, excludeClosing: 1 }" data-link="ledger">{{ name(item.row) }}</a>
                          } @else { {{ name(item.row) }} }
                          @if (item.row.sign < 0 && (item.row.kind === 'line' || item.row.kind === 'group')) { <small class="fr__muted">(−)</small> }
                        </td>
                        <td class="nota-num" data-cell="amount">{{ incomeAmount(item.row, item.row.amount) }}</td>
                        @if (r.comparison) {
                          <td class="nota-num" data-cell="previous">{{ incomeAmount(item.row, item.row.previous) }}</td>
                          <td class="nota-num" data-cell="change">{{ incomeAmount(item.row, item.row.change) }}</td>
                        }
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              @if (r.check.difference !== 0) { <p class="nota-error" role="alert" data-test="income-check">{{ 'reports.checkFailed' | translate }}</p> }
            }
          }
          @case ('balance') {
            @if (balance(); as r) {
              <div class="fr__sheet">
                @for (section of sheetSections(); track section.key) {
                  <div class="fr__col" [attr.data-section]="section.key">
                    <h3 class="fr__h">{{ 'reports.sheet.' + section.key | translate }}</h3>
                    <table class="nota-table fr__table"><tbody>
                      @for (item of section.rows; track item.row.id) {
                        <tr class="fr__row" [class.fr__row--sub]="item.row.kind === 'group'" [attr.data-row]="item.row.code || item.row.id">
                          <td [style.padding-inline-start.px]="12 + item.depth * 20">
                            @if (item.row.accountId && item.row.kind === 'line') {
                              <a class="fr__link" [routerLink]="ledgerLink(item.row.accountId)" [queryParams]="{ to: r.asOf }" data-link="ledger">{{ name(item.row) }}</a>
                            } @else { {{ name(item.row) }} }
                          </td>
                          <td class="nota-num" [class.fr__warn]="item.row.opposite" data-cell="amount" [attr.title]="item.row.opposite ? ('accounting.oppositeHint' | translate) : null">
                            {{ money(item.row.amount) }}@if (item.row.opposite) { <small> {{ 'accounting.side.' + item.row.side | translate }}</small> }
                          </td>
                        </tr>
                      }
                      <tr class="fr__row fr__row--total"><td>{{ 'reports.sheet.total' | translate: { name: ('reports.sheet.' + section.key | translate) } }}</td><td class="nota-num" [attr.data-total]="section.key">{{ money(section.total) }}</td></tr>
                    </tbody></table>
                  </div>
                }
              </div>
              <p class="fr__check-row" [class.fr__check-row--bad]="r.check.difference !== 0" data-test="balance-check">
                {{ 'reports.sheet.check' | translate }}: {{ money(r.check.assets) }} = {{ money(r.check.liabilitiesAndEquity) }}
                · {{ 'reports.sheet.difference' | translate }}: <strong data-test="balance-difference">{{ money(r.check.difference) }}</strong>
              </p>
            }
          }
          @case ('trial') {
            @if (trial(); as r) {
              <div class="nota-table-wrap">
                <table class="nota-table fr__table fr__table--wide" data-test="trial-table">
                  <thead>
                    <tr><th rowspan="2">{{ 'reports.account' | translate }}</th><th class="nota-num" colspan="2">{{ 'reports.opening' | translate }}</th><th class="nota-num" colspan="2">{{ 'reports.movement' | translate }}</th><th class="nota-num" colspan="2">{{ 'reports.closing' | translate }}</th></tr>
                    <tr><th class="nota-num">{{ 'accounting.debit' | translate }}</th><th class="nota-num">{{ 'accounting.credit' | translate }}</th><th class="nota-num">{{ 'accounting.debit' | translate }}</th><th class="nota-num">{{ 'accounting.credit' | translate }}</th><th class="nota-num">{{ 'accounting.debit' | translate }}</th><th class="nota-num">{{ 'accounting.credit' | translate }}</th></tr>
                  </thead>
                  <tbody>
                    @for (item of trialRows(); track item.row.id) {
                      <tr class="fr__row" [class.fr__row--sub]="item.row.kind === 'group'" [attr.data-row]="item.row.code">
                        <td [style.padding-inline-start.px]="12 + item.depth * 20"><span class="fr__code nota-num" dir="ltr">{{ item.row.code }}</span>
                          @if (item.row.accountId && item.row.kind === 'line') {
                            <a class="fr__link" [routerLink]="ledgerLink(item.row.accountId)" [queryParams]="{ from: r.period.from, to: r.period.to }" data-link="ledger">{{ name(item.row) }}</a>
                          } @else { {{ name(item.row) }} }
                        </td>
                        <td class="nota-num">{{ cell(item.row.openingDebit) }}</td><td class="nota-num">{{ cell(item.row.openingCredit) }}</td>
                        <td class="nota-num">{{ cell(item.row.movementDebit) }}</td><td class="nota-num">{{ cell(item.row.movementCredit) }}</td>
                        <td class="nota-num">{{ cell(item.row.closingDebit) }}</td><td class="nota-num">{{ cell(item.row.closingCredit) }}</td>
                      </tr>
                    }
                  </tbody>
                  <tfoot><tr class="fr__row fr__row--total" data-test="trial-totals">
                    <td>{{ 'reports.total' | translate }}</td>
                    <td class="nota-num">{{ money(r.totals.openingDebit) }}</td><td class="nota-num">{{ money(r.totals.openingCredit) }}</td>
                    <td class="nota-num">{{ money(r.totals.movementDebit) }}</td><td class="nota-num">{{ money(r.totals.movementCredit) }}</td>
                    <td class="nota-num">{{ money(r.totals.closingDebit) }}</td><td class="nota-num">{{ money(r.totals.closingCredit) }}</td>
                  </tr></tfoot>
                </table>
              </div>
              <p class="fr__check-row" [class.fr__check-row--bad]="!r.balanced" data-test="trial-balanced">{{ (r.balanced ? 'reports.trialBalanced' : 'reports.trialUnbalanced') | translate }}</p>
            }
          }
          @case ('boxes') {
            @if (boxes(); as r) {
              <div class="nota-table-wrap">
                <table class="nota-table fr__table fr__table--wide" data-test="boxes-table">
                  <thead><tr>
                    <th>{{ 'reports.box' | translate }}</th><th class="nota-num">{{ 'reports.opening' | translate }}</th><th class="nota-num">{{ 'reports.in' | translate }}</th>
                    <th class="nota-num">{{ 'reports.out' | translate }}</th><th class="nota-num">{{ 'reports.closing' | translate }}</th>
                  </tr></thead>
                  <tbody>
                    @for (box of r.boxes; track box.boxId) {
                      <tr class="fr__row fr__row--sub fr__box" [attr.data-box]="box.boxId" tabindex="0" role="button" (click)="toggleBox(box.boxId)" (keydown.enter)="toggleBox(box.boxId)">
                        <td><a class="fr__link" [routerLink]="['/cashbox', box.boxId]" data-link="box" (click)="$event.stopPropagation()">{{ box.name }}</a>
                          @if (!box.isActive) { <small class="fr__muted"> {{ 'reports.inactive' | translate }}</small> }</td>
                        <td class="nota-num">{{ money(box.opening) }}</td><td class="nota-num">{{ money(box.in) }}</td><td class="nota-num">{{ money(box.out) }}</td><td class="nota-num"><strong>{{ money(box.closing) }}</strong></td>
                      </tr>
                      @if (openBoxes().has(box.boxId)) {
                        @for (kind of box.byKind; track kind.key) {
                          <tr class="fr__row" [attr.data-kind]="box.boxId + ':' + kind.key">
                            <td [style.padding-inline-start.px]="32">{{ kindName(kind) }}</td><td></td>
                            <td class="nota-num">{{ cell(kind.in) }}</td><td class="nota-num">{{ cell(kind.out) }}</td><td></td>
                          </tr>
                        } @empty { <tr><td colspan="5" class="fr__muted" [style.padding-inline-start.px]="32">{{ 'reports.noMovement' | translate }}</td></tr> }
                      }
                    }
                  </tbody>
                  <tfoot><tr class="fr__row fr__row--total" data-test="boxes-totals"><td>{{ 'reports.total' | translate }}</td>
                    <td class="nota-num">{{ money(r.totals.opening) }}</td><td class="nota-num">{{ money(r.totals.in) }}</td><td class="nota-num">{{ money(r.totals.out) }}</td><td class="nota-num">{{ money(r.totals.closing) }}</td></tr></tfoot>
                </table>
              </div>
            }
          }
          @case ('parties') {
            @if (parties(); as r) {
              @for (group of partyGroups(); track group.key) {
                <h3 class="fr__h">{{ 'reports.parties.' + group.key | translate }}</h3>
                <div class="nota-table-wrap">
                  <table class="nota-table fr__table fr__table--wide" [attr.data-test]="group.key + '-table'">
                    <thead><tr>
                      <th>{{ 'reports.parties.name' | translate }}</th><th class="nota-num">{{ 'reports.parties.balance' | translate }}</th>
                      @for (bucket of buckets; track bucket) { <th class="nota-num">{{ 'reports.aging.' + bucket | translate }}</th> }
                      <th class="nota-num">{{ 'reports.parties.advance' | translate }}</th>
                    </tr></thead>
                    <tbody>
                      @for (row of group.rows; track row.partyId) {
                        <tr class="fr__row" [attr.data-party]="row.partyId">
                          <td>@if (group.key === 'customers') { <a class="fr__link" [routerLink]="['/customers', row.partyId]" data-link="party">{{ row.name }}</a> }
                            @else { <a class="fr__link" routerLink="/suppliers" [queryParams]="{ statement: row.partyId }" data-link="party">{{ row.name }}</a> }</td>
                          <td class="nota-num" [class.fr__warn]="row.opposite">{{ money(row.absBalance) }} <small>{{ 'accounting.side.' + row.side | translate }}</small></td>
                          @for (bucket of buckets; track bucket) { <td class="nota-num">{{ cell(row.aging[bucket]) }}</td> }
                          <td class="nota-num">{{ cell(row.advance) }}</td>
                        </tr>
                      } @empty { <tr><td [attr.colspan]="buckets.length + 3" class="fr__muted">{{ 'reports.parties.none' | translate }}</td></tr> }
                    </tbody>
                    <tfoot><tr class="fr__row fr__row--total" [attr.data-totals]="group.key"><td>{{ 'reports.total' | translate }}</td>
                      <td class="nota-num">{{ money(group.totals.balance) }}</td>
                      @for (bucket of buckets; track bucket) { <td class="nota-num">{{ money(group.totals[bucket]) }}</td> }
                      <td class="nota-num">{{ money(group.totals.advance) }}</td></tr></tfoot>
                  </table>
                </div>
              }
            }
          }
        }
      </section>
    </div>
  }
  `,
  styles: `
    .fr { display: flex; flex-direction: column; gap: 16px; }
    .fr__actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .fr__tabs { display: flex; flex-wrap: wrap; gap: 6px; }
    .fr__tab { min-height: 44px; padding: 0 16px; border-radius: var(--radius-control); border: 1px solid var(--border); background: var(--surface); color: var(--text); font: inherit; font-weight: 700; cursor: pointer; }
    .fr__tab--on { background: var(--brand); border-color: var(--brand); color: var(--on-brand); }
    .fr__filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 14px; padding: 14px 16px; }
    .fr__presets { display: flex; flex-wrap: wrap; gap: 6px; }
    .fr__preset { min-height: 40px; padding: 0 14px; border-radius: var(--radius-pill); border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); font: inherit; cursor: pointer; }
    .fr__preset--on { background: var(--brand-soft); border-color: var(--brand); color: var(--brand-strong-text); font-weight: 700; }
    .fr__field { display: flex; flex-direction: column; gap: 4px; min-width: 160px; }
    .fr__check { display: inline-flex; align-items: center; gap: 8px; min-height: var(--touch-target); font-size: 14px; }
    .fr__report { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
    .fr__head { text-align: center; }
    .fr__title { margin: 0; font-size: 20px; font-weight: 800; }
    .fr__sub { margin: 4px 0 0; color: var(--text-muted); font-size: 13px; }
    .fr__note, .fr__muted { color: var(--text-muted); font-size: 12px; margin: 0; }
    .fr__row--sub td { font-weight: 700; background: var(--surface-2); }
    .fr__row--total td { font-weight: 800; border-top: 2px solid var(--text); }
    .fr__link { color: var(--brand); text-decoration: none; }
    .fr__link:hover, .fr__link:focus-visible { text-decoration: underline; }
    .fr__code { color: var(--text-muted); margin-inline-end: 8px; }
    .fr__warn { color: var(--danger); }
    .fr__box { cursor: pointer; }
    .fr__sheet { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
    .fr__h { margin: 0 0 6px; font-size: 16px; }
    .fr__check-row { margin: 0; padding: 10px 14px; border-radius: var(--radius-control); background: var(--brand-soft); color: var(--brand-strong-text); font-size: 14px; }
    .fr__check-row--bad { background: var(--danger-soft); color: var(--danger-text); font-weight: 700; }
    @media (max-width: 640px) { .fr__table--wide { min-width: 640px; } .fr__table td, .fr__table th { padding-inline: 8px; } .fr__filters { flex-direction: column; align-items: stretch; } .fr__tab { flex: 1 1 140px; } }
  `,
})
export class FinancialReportsComponent implements OnInit {
  protected readonly layout = inject(LayoutService);
  /** Phone only (Online Stage 6B): the period / switches sheet. */
  protected readonly filtersOpen = signal(false);
  private readonly service = inject(ReportsService);
  private readonly language = inject(LanguageService);
  private readonly shopProfile = inject(ShopProfileService);

  private readonly printData = inject(PrintDataService);

  /**
   * Stage 23: طباعة / حفظ PDF of the shown report. The income statement and the balance sheet print together as
   * "القوائم المالية" (PrFinancials; the other one is read for the same period); the trial balance, box movements and
   * party balances use the trial-balance table style.
   */
  readonly printItems = computed<PrintActionItem[]>(() => {
    const tab = this.tab();
    return [{ key: 'report', load: async () => {
      const query = this.query();
      if (tab === 'income' || tab === 'balance') {
        const [income, balance, trial] = await Promise.all([
          tab === 'income' && this.income() ? Promise.resolve(this.income()) : firstValueFrom(this.service.incomeStatement(query)),
          tab === 'balance' && this.balance() ? Promise.resolve(this.balance()) : firstValueFrom(this.service.balanceSheet({ ...query, asOf: query.to })),
          firstValueFrom(this.service.trialBalance(query)).catch(() => null),
        ]);
        return this.printData.financials(income, balance, trial ? trial.balanced : null);
      }
      if (tab === 'trial' && this.trial()) return this.printData.trialBalance(this.trial() as TrialBalance);
      if (tab === 'boxes' && this.boxes()) return this.printData.boxMovements(this.boxes() as BoxMovements);
      if (tab === 'parties' && this.parties()) return this.printData.partyBalances(this.parties() as PartyBalances);
      return null;
    } }];
  });
  readonly tabs = TABS;
  readonly presets: readonly Preset[] = ['thisMonth', 'lastMonth', 'thisYear', 'custom'];
  readonly buckets = AGING_KEYS;

  readonly tab = signal<ReportTab>('income');
  readonly preset = signal<Preset>('thisMonth');
  readonly from = signal('');
  readonly to = signal('');
  readonly asOf = signal(localDateKey());
  readonly compare = signal(false);
  readonly showZero = signal(false);
  readonly loading = signal(false);
  readonly exporting = signal(false);
  readonly error = signal('');
  readonly openBoxes = signal<ReadonlySet<string>>(new Set());

  readonly income = signal<IncomeStatement | null>(null);
  readonly balance = signal<BalanceSheet | null>(null);
  readonly trial = signal<TrialBalance | null>(null);
  readonly boxes = signal<BoxMovements | null>(null);
  readonly parties = signal<PartyBalances | null>(null);

  readonly current = computed(() => ({ income: this.income, balance: this.balance, trial: this.trial, boxes: this.boxes, parties: this.parties })[this.tab()]());

  readonly incomeRows = computed<Flat<IncomeRow>[]>(() => flatten(this.income()?.rows ?? [], ['subtotal', 'total', 'percent'], this.showZero()));
  readonly trialRows = computed<Flat<TrialRow>[]>(() => flatten(this.trial()?.rows ?? [], [], this.showZero()));
  readonly sheetSections = computed(() => {
    const sheet = this.balance();
    if (!sheet) return [];
    const section = (key: 'assets' | 'liabilities' | 'equity', root: SheetRow, total: number) => ({ key, rows: flatten(root.children ?? [], [], this.showZero()), total });
    return [section('assets', sheet.sections.assets, sheet.totals.assets), section('liabilities', sheet.sections.liabilities, sheet.totals.liabilities), section('equity', sheet.sections.equity, sheet.totals.equity)];
  });
  readonly partyGroups = computed(() => {
    const report = this.parties();
    if (!report) return [];
    const pick = (key: 'customers' | 'suppliers') => {
      const data = report[key];
      return data ? [{ key, rows: this.showZero() ? data.rows : data.rows.filter((row: PartyRow) => !row.isZero), totals: data.totals }] : [];
    };
    return [...pick('customers'), ...pick('suppliers')];
  });

  /** "النور · عن الفترة من … إلى … · بالجنيه", as in the design (the template adds the words, so a language switch follows). */
  readonly header = computed(() => {
    const report = this.current();
    if (!report) return null;
    return 'period' in report ? { shopName: report.shopName, from: report.period.from, to: report.period.to, asOf: '' } : { shopName: report.shopName, from: '', to: '', asOf: report.asOf };
  });

  ngOnInit(): void {
    this.applyPreset('thisMonth');
  }

  setTab(tab: ReportTab): void {
    this.tab.set(tab);
    this.load();
  }

  applyPreset(preset: Preset): void {
    this.preset.set(preset);
    const now = new Date();
    if (preset === 'thisMonth') { this.range(new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth() + 1, 0)); }
    else if (preset === 'lastMonth') { this.range(new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 0)); }
    else if (preset === 'thisYear') {
      // "This year" is the FISCAL year of the closing settings: it starts on the 1st of fiscalYearStartMonth (January when never set).
      const startMonth = Math.min(12, Math.max(1, Number(this.shopProfile.profile()?.closing?.fiscalYearStartMonth) || 1));
      const year = now.getMonth() + 1 >= startMonth ? now.getFullYear() : now.getFullYear() - 1;
      this.range(new Date(year, startMonth - 1, 1), new Date(year + 1, startMonth - 1, 0));
    }
    else if (!this.from()) { this.range(new Date(now.getFullYear(), now.getMonth(), 1), now); }
    this.load();
  }

  private range(from: Date, to: Date): void {
    this.from.set(localDateKey(from));
    this.to.set(localDateKey(to));
    // the balance sheet is "as of" the end of the period (never later than today)
    this.asOf.set(localDateKey(to.getTime() > Date.now() ? new Date() : to));
  }

  private query(): ReportQuery {
    return { from: this.from(), to: this.to(), asOf: this.asOf(), compare: this.compare() };
  }

  load(): void {
    this.error.set('');
    this.loading.set(true);
    const done = () => this.loading.set(false);
    const failed = () => { this.loading.set(false); this.error.set('reports.loadFailed'); };
    const query = this.query();
    switch (this.tab()) {
      case 'income': this.service.incomeStatement(query).subscribe({ next: (r) => { this.income.set(r); done(); }, error: failed }); break;
      case 'balance': this.service.balanceSheet(query).subscribe({ next: (r) => { this.balance.set(r); done(); }, error: failed }); break;
      case 'trial': this.service.trialBalance(query).subscribe({ next: (r) => { this.trial.set(r); done(); }, error: failed }); break;
      case 'boxes': this.service.boxMovements(query).subscribe({ next: (r) => { this.boxes.set(r); done(); }, error: failed }); break;
      case 'parties': this.service.partyBalances(query).subscribe({ next: (r) => { this.parties.set(r); done(); }, error: failed }); break;
    }
  }

  exportExcel(): void {
    const tab = this.tab();
    this.exporting.set(true);
    this.service.export(REPORT_KEY[tab], this.query()).subscribe({
      next: (blob) => {
        this.exporting.set(false);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${REPORT_KEY[tab]}.xlsx`;
        anchor.click();
        URL.revokeObjectURL(url);
      },
      error: () => { this.exporting.set(false); this.error.set('reports.exportFailed'); },
    });
  }

  toggleBox(id: string): void {
    const next = new Set(this.openBoxes());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.openBoxes.set(next);
  }

  protected ledgerLink(accountId: string): string[] {
    return ['/accounting/accounts', accountId, 'ledger'];
  }

  protected name(row: { nameAr: string; nameEn: string }): string {
    return this.language.selectedLanguage() === 'en' ? row.nameEn || row.nameAr : row.nameAr;
  }

  protected kindName(kind: { ar: string; en: string }): string {
    return this.language.selectedLanguage() === 'en' ? kind.en : kind.ar;
  }

  protected money(value: number | null | undefined): string {
    return formatNotaNumber(value, this.language.selectedLanguage(), 'money');
  }

  /** A trial-balance / box / aging cell: zero shows as a dash. */
  protected cell(value: number | null | undefined): string {
    return value ? this.money(value) : '—';
  }

  /** Income statement amounts: a deduction shows in brackets, the percentage row as a percentage, a missing comparison as a dash. */
  protected incomeAmount(row: IncomeRow, value: number | null): string {
    if (value === null || value === undefined) return '—';
    if (row.kind === 'percent') return `${formatNotaNumber(value, this.language.selectedLanguage(), 'number')}${this.language.selectedLanguage() === 'en' ? '%' : '٪'}`;
    const text = this.money(value);
    return row.sign < 0 && (row.kind === 'line' || row.kind === 'group') && value !== 0 ? `(${text})` : text;
  }
}
