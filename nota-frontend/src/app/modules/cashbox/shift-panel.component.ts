import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { NotaButtonDirective, NotaFormFieldComponent, NotaMoneyPipe } from '../shared/ui';
import { CashboxService } from './cashbox.service';
import { ShiftLineKey, ShiftReport } from './cashbox.models';

export interface DepositOption {
  _id: string;
  name: string;
}

/** The lines that show even when they are 0 (the design's five); the rest only when something moved. */
const ALWAYS_SHOWN: readonly ShiftLineKey[] = ['float', 'sales', 'receipts', 'refunds', 'expenses'];
const MINUS_LINES: readonly ShiftLineKey[] = ['refunds', 'expenses', 'transfersOut', 'payouts', 'drawings'];

/** TODO(Stage 22 PrShiftClose): turn on when the shift report print template exists. */
export const SHIFT_PRINT_ENABLED = false;

/**
 * Stage 19: one shift (CashBox.dc.html "إقفال الوردية"). Open: the expected-cash lines, the counted amount, the live
 * difference (عجز / زيادة), a note (required when there is a difference), an optional deposit to another box and the
 * "الباقي يفضل في الدرج" line. Closed: the printable summary of what was closed.
 */
@Component({
  selector: 'app-shift-panel',
  standalone: true,
  imports: [DatePipe, FormsModule, TranslatePipe, NotaButtonDirective, NotaFormFieldComponent, NotaMoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './shift-panel.component.html',
  styleUrl: './shift-panel.component.scss',
})
export class ShiftPanelComponent implements OnInit {
  private readonly cashbox = inject(CashboxService);

  readonly shiftId = input.required<string>();
  /** Where the deposit can go (never the shift's own box). */
  readonly depositOptions = input<DepositOption[]>([]);
  readonly closed = output<ShiftReport>();

  readonly report = signal<ShiftReport | null>(null);
  readonly loadFailed = signal(false);
  readonly counted = signal<number | null>(null);
  readonly note = signal('');
  readonly depositBoxId = signal('');
  readonly deposit = signal<number | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly printEnabled = SHIFT_PRINT_ENABLED;

  readonly lines = computed(() => (this.report()?.lines ?? []).filter((line) => ALWAYS_SHOWN.includes(line.key) || line.amount !== 0));
  readonly isOpen = computed(() => this.report()?.status === 'open');
  /** counted − expected, rounded to 2 decimals. null until something is typed. */
  readonly difference = computed(() => {
    const report = this.report();
    const counted = this.counted();
    if (!report || counted === null || report.expected === null) return null;
    return Math.round((counted - report.expected) * 100) / 100;
  });
  readonly diffKind = computed<'short' | 'over' | 'even' | null>(() => {
    const diff = this.difference();
    return diff === null ? null : diff < 0 ? 'short' : diff > 0 ? 'over' : 'even';
  });
  readonly needsNote = computed(() => (this.difference() ?? 0) !== 0);
  readonly remaining = computed(() => Math.round(((this.counted() ?? 0) - (this.deposit() ?? 0)) * 100) / 100);
  readonly options = computed(() => this.depositOptions().filter((option) => option._id !== this.report()?.boxId));
  readonly depositInvalid = computed(() => {
    const amount = this.deposit() ?? 0;
    return amount < 0 || amount > (this.counted() ?? 0) || (amount > 0 && !this.depositBoxId());
  });
  readonly canClose = computed(() => this.isOpen() && this.counted() !== null && (this.counted() ?? -1) >= 0
    && (!this.needsNote() || this.note().trim().length > 0) && !this.depositInvalid() && !this.busy());

  isMinus = (key: ShiftLineKey) => MINUS_LINES.includes(key);

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.cashbox.shift(this.shiftId()).subscribe({
      next: (report) => { this.report.set(report); this.loadFailed.set(false); },
      error: () => this.loadFailed.set(true),
    });
  }

  close(): void {
    const report = this.report();
    if (!report || !this.canClose()) return;
    this.busy.set(true);
    this.error.set('');
    const deposit = this.deposit() ?? 0;
    this.cashbox.closeShift(report._id, {
      counted: this.counted() as number,
      ...(this.needsNote() ? { differenceNote: this.note().trim() } : {}),
      ...(deposit > 0 ? { depositBoxId: this.depositBoxId(), depositAmount: deposit } : {}),
    }).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.report.set(result);
        this.closed.emit(result);
      },
      error: (response) => {
        this.busy.set(false);
        const code = response?.error?.code;
        this.error.set(code === 'NOTE_REQUIRED' ? 'cashbox.shift.noteRequired' : code === 'INSUFFICIENT_BALANCE' ? 'cashbox.errors.INSUFFICIENT_BALANCE'
          : code === 'FORBIDDEN' ? 'cashbox.errors.FORBIDDEN' : 'cashbox.shift.closeFailed');
      },
    });
  }

  print(): void {
    if (this.printEnabled) window.print();
  }
}
