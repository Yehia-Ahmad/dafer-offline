import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { HELP_PART_TITLES, HelpBlock } from '../help.models';
import { money } from '../help-markdown';
import { HelpInlineComponent } from './help-inline.component';

/** Renders the blocks of a help section. Tables scroll inside their own box on narrow screens. */
@Component({
  selector: 'nota-help-blocks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HelpInlineComponent, NgTemplateOutlet],
  template: `
    @for (block of blocks(); track $index) {
      @switch (block.type) {
        @case ('heading') { <h3 class="hb-heading" [attr.data-part]="$any(block).part ?? null"><nota-help-inline [text]="$any(block).text || partTitle($any(block).part)" [inPanel]="inPanel()" /></h3> }
        @case ('paragraph') { <p class="hb-p"><nota-help-inline [text]="$any(block).text" [inPanel]="inPanel()" /></p> }
        @case ('tip') { <p class="hb-note hb-note--tip"><span class="hb-note__icon" aria-hidden="true">💡</span><span><nota-help-inline [text]="$any(block).text" [inPanel]="inPanel()" /></span></p> }
        @case ('warning') { <p class="hb-note hb-note--warn"><span class="hb-note__icon" aria-hidden="true">⚠️</span><span><nota-help-inline [text]="$any(block).text" [inPanel]="inPanel()" /></span></p> }
        @case ('steps') {
          <div class="hb-task">
            <div class="hb-task__title"><nota-help-inline [text]="$any(block).title" [inPanel]="inPanel()" /></div>
            <ol class="hb-steps">@for (item of $any(block).items; track $index) { <li><nota-help-inline [text]="item" [inPanel]="inPanel()" /></li> }</ol>
          </div>
        }
        @case ('bullets') {
          @if ($any(block).title) { <div class="hb-task__title"><nota-help-inline [text]="$any(block).title" [inPanel]="inPanel()" /></div> }
          <ul class="hb-list">@for (item of $any(block).items; track $index) { <li><nota-help-inline [text]="item" [inPanel]="inPanel()" /></li> }</ul>
        }
        @case ('behind') {
          <div class="hb-behind">
            <div class="hb-task__title"><nota-help-inline [text]="$any(block).title" [inPanel]="inPanel()" /></div>
            <ul class="hb-list">@for (item of $any(block).text; track $index) { <li><nota-help-inline [text]="item" [inPanel]="inPanel()" /></li> }</ul>
            @if ($any(block).entry?.length) {
              <div class="hb-scroll"><table class="hb-table hb-table--entry">
                <thead><tr><th>الحساب</th><th>مدين</th><th>دائن</th></tr></thead>
                <tbody>@for (line of $any(block).entry; track $index) {
                  <tr><td><nota-help-inline [text]="line.account" [inPanel]="inPanel()" /></td><td class="hb-num">{{ amount(line.debit) }}</td><td class="hb-num">{{ amount(line.credit) }}</td></tr>
                }</tbody>
              </table></div>
            }
          </div>
        }
        @case ('fields') { <ng-container [ngTemplateOutlet]="grid" [ngTemplateOutletContext]="{ title: $any(block).title, head: ['الخانة', 'معناها', 'القواعد'], rows: fieldRows($any(block)) }" /> }
        @case ('actions') { <ng-container [ngTemplateOutlet]="grid" [ngTemplateOutletContext]="{ title: $any(block).title, head: ['الزرار', 'بيعمل إيه', 'إمتى مش هتلاقيه / مقفول'], rows: actionRows($any(block)) }" /> }
        @case ('statuses') { <ng-container [ngTemplateOutlet]="grid" [ngTemplateOutletContext]="{ title: $any(block).title, head: ['الحالة', 'معناها', 'تقدر تعمل إيه'], rows: statusRows($any(block)) }" /> }
        @case ('blockers') { <ng-container [ngTemplateOutlet]="grid" [ngTemplateOutletContext]="{ title: $any(block).title, head: ['اللي بيمنعك', 'تعمل إيه'], rows: blockerRows($any(block)) }" /> }
        @case ('table') { <ng-container [ngTemplateOutlet]="grid" [ngTemplateOutletContext]="{ title: $any(block).title, head: $any(block).head, rows: $any(block).rows }" /> }
        @case ('faq') {
          <div class="hb-faq">@for (item of $any(block).items; track $index) {
            <details class="hb-faq__item"><summary><nota-help-inline [text]="item.q" [inPanel]="inPanel()" /></summary><p class="hb-p"><nota-help-inline [text]="item.a" [inPanel]="inPanel()" /></p></details>
          }</div>
        }
      }
    }
    <ng-template #grid let-title="title" let-head="head" let-rows="rows">
      @if (title) { <div class="hb-task__title"><nota-help-inline [text]="title" [inPanel]="inPanel()" /></div> }
      <div class="hb-scroll"><table class="hb-table">
        <thead><tr>@for (cell of head; track $index) { <th>{{ cell }}</th> }</tr></thead>
        <tbody>@for (row of rows; track $index) {
          <tr>@for (cell of row; track $index) { <td>@if (cell) { <nota-help-inline [text]="cell" [inPanel]="inPanel()" /> }</td> }</tr>
        }</tbody>
      </table></div>
    </ng-template>
  `,
  styles: [`
    :host { display: block; line-height: 1.85; color: var(--text); }
    .hb-heading { font-size: 17px; font-weight: 800; margin: 26px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
    .hb-p { margin: 0 0 12px; }
    .hb-note { display: flex; gap: 10px; margin: 0 0 12px; padding: 10px 12px; border-radius: 12px; }
    .hb-note--tip { background: var(--info-soft); color: var(--info-text); }
    .hb-note--warn { background: var(--warning-soft); color: var(--warning-text); }
    .hb-note__icon { flex: none; }
    .hb-task { margin: 0 0 14px; }
    .hb-task__title { font-weight: 700; margin: 0 0 6px; }
    .hb-steps, .hb-list { margin: 0 0 12px; padding-inline-start: 22px; }
    .hb-steps li, .hb-list li { margin-bottom: 4px; }
    .hb-behind { margin: 0 0 14px; padding: 12px 14px; border-radius: 12px; border: 1px dashed var(--border-strong); background: var(--surface-2); }
    .hb-scroll { overflow-x: auto; margin: 0 0 14px; max-width: 100%; }
    .hb-table { width: 100%; border-collapse: collapse; font-size: 14px; }
    .hb-table th, .hb-table td { border: 1px solid var(--line); padding: 7px 10px; text-align: start; vertical-align: top; }
    .hb-table th { background: var(--surface-2); font-weight: 700; white-space: nowrap; }
    .hb-table--entry { width: auto; min-width: 280px; }
    .hb-num { font-variant-numeric: tabular-nums; direction: ltr; text-align: end; white-space: nowrap; }
    .hb-faq__item { border: 1px solid var(--line); border-radius: 12px; padding: 8px 12px; margin-bottom: 8px; background: var(--surface); }
    .hb-faq__item summary { cursor: pointer; font-weight: 700; }
    .hb-faq__item .hb-p { margin: 8px 0 0; }
  `],
})
export class HelpBlocksComponent {
  readonly blocks = input.required<readonly HelpBlock[]>();
  readonly inPanel = input(false);

  protected partTitle(part: keyof typeof HELP_PART_TITLES | undefined): string {
    return part ? HELP_PART_TITLES[part] : '';
  }
  protected amount(value: number | undefined): string {
    return money(value);
  }
  protected fieldRows(block: Extract<HelpBlock, { type: 'fields' }>): string[][] {
    return block.rows.map((row) => [row.field, row.meaning, row.rules ?? '']);
  }
  protected actionRows(block: Extract<HelpBlock, { type: 'actions' }>): string[][] {
    return block.rows.map((row) => [row.action, row.does, row.when ?? '']);
  }
  protected statusRows(block: Extract<HelpBlock, { type: 'statuses' }>): string[][] {
    return block.rows.map((row) => [row.status, row.meaning, row.next ?? '']);
  }
  protected blockerRows(block: Extract<HelpBlock, { type: 'blockers' }>): string[][] {
    return block.rows.map((row) => [row.rule, row.fix]);
  }
}
