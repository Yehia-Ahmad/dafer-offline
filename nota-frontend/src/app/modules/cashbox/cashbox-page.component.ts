import { ChangeDetectionStrategy, Component, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService } from '../../core/auth/auth.service';
import { NotaCanDirective } from '../../core/auth/nota-can.directive';
import { NotaButtonDirective, NotaMoneyPipe, NotaPageHeaderComponent } from '../shared/ui';
import { AddBoxDialogComponent } from './add-box-dialog.component';
import { CashBox } from './cashbox.models';
import { CashboxService } from './cashbox.service';
import { DrawingDialogComponent } from './drawing-dialog.component';
import { OpenShiftDialogComponent } from './open-shift-dialog.component';
import { DepositOption, ShiftPanelComponent } from './shift-panel.component';
import { TransferDialogComponent } from './transfer-dialog.component';

/**
 * Stage 19: الخزائن والوردية (CashBox.dc.html). A card per box (name, type, balance, open shift), "+ خزنة جديدة" and
 * "تحويل بين الخزائن" (cashbox.manage), "سحب المالك" (owner.drawings), and the shift panel of the selected open shift.
 * A card opens the box detail: its ledger and its shifts.
 */
@Component({
  selector: 'app-cashbox-page',
  standalone: true,
  imports: [
    RouterLink, TranslatePipe, NotaCanDirective, NotaButtonDirective, NotaMoneyPipe, NotaPageHeaderComponent,
    AddBoxDialogComponent, TransferDialogComponent, DrawingDialogComponent, OpenShiftDialogComponent, ShiftPanelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './cashbox-page.component.html',
  styleUrl: './cashbox-page.component.scss',
})
export class CashboxPageComponent implements OnInit {
  private readonly cashbox = inject(CashboxService);
  private readonly auth = inject(AuthService);

  @ViewChild(AddBoxDialogComponent) private addDialog?: AddBoxDialogComponent;

  readonly boxes = signal<CashBox[]>([]);
  readonly cashTotal = signal(0);
  readonly loading = signal(true);
  readonly loadError = signal(false);

  readonly addOpen = signal(false);
  readonly transferOpen = signal(false);
  readonly drawingOpen = signal(false);
  readonly openShiftOpen = signal(false);
  readonly openShiftBox = signal<CashBox | null>(null);
  private readonly picked = signal<string | null>(null);

  readonly activeBoxes = computed(() => this.boxes().filter((box) => box.isActive));
  readonly depositOptions = computed<DepositOption[]>(() => this.activeBoxes().map((box) => ({ _id: box._id, name: box.name })));

  /** The shift whose panel is shown: the picked one, else the first open shift this user may see. */
  readonly shownShift = computed(() => {
    const withShift = this.boxes().filter((box) => box.openShift && this.mayUseShift(box));
    const pickedId = this.picked();
    return withShift.find((box) => box.openShift?._id === pickedId) ?? withShift[0] ?? null;
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.cashbox.boxes().subscribe({
      next: (response) => { this.boxes.set(response.data); this.cashTotal.set(response.cashTotal); this.loading.set(false); },
      error: () => { this.loadError.set(true); this.loading.set(false); },
    });
  }

  /** shift.manage: any shift. shift.operate: only the shift this user opened. */
  mayUseShift(box: CashBox): boolean {
    if (!box.openShift) return false;
    if (this.auth.has('shift.manage')) return true;
    return this.auth.has('shift.operate') && box.openShift.userId === this.auth.user()?._id;
  }

  mayOpenShift(box: CashBox): boolean {
    return box.isActive && box.shiftsEnabled && !box.openShift && (this.auth.has('shift.operate') || this.auth.has('shift.manage'));
  }

  note(box: CashBox): string {
    if (box.openShift) return 'cashbox.cards.openShift';
    if (box.deviceName) return 'cashbox.cards.device';
    return box.isMain ? 'cashbox.cards.main' : '';
  }

  showShift(box: CashBox): void {
    this.picked.set(box.openShift?._id ?? null);
  }

  startOpenShift(box: CashBox): void {
    this.openShiftBox.set(box);
    this.openShiftOpen.set(true);
  }

  openAdd(): void {
    this.addOpen.set(true);
    this.addDialog?.loadDevices();
  }

  shiftChanged(): void {
    this.load();
  }
}
