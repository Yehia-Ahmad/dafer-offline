import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { LabelRollPreset, LabelSheetPreset, ROLL_PRESETS, SHEET_PRESETS, normalizeRoll, normalizeSheet } from '../../../../core/print/label-layout';
import { PrintService } from '../../../../core/print/print.service';
import { PrintSettingsService } from '../../../../core/print/print-settings.service';
import { DesktopPrinter } from '../../../../core/runtime/runtime-config';
import { NotaButtonDirective, NotaFormFieldComponent } from '../../../shared/ui';

/**
 * Stage 26: "ملصقات الباركود" in the print settings of THIS PC (shop.manage): the label printer (a roll of stickers,
 * printed silently when chosen), its label size (presets or custom W×H), calibration offsets and the gap; the A4 sticker
 * sheet layout (presets or custom grid) with the outline test sheet; and the scan sounds mute. Every number is clamped
 * again by the desktop app when it is saved.
 */
@Component({
  selector: 'app-label-settings-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslatePipe, NotaButtonDirective, NotaFormFieldComponent],
  template: `
    <section class="lsc" data-test="label-card" aria-labelledby="lsc-title">
      <h3 id="lsc-title" class="nota-section-title">{{ 'labels.settings.title' | translate }}</h3>

      <nota-form-field [label]="'labels.settings.printer' | translate" forId="lsc-printer" [hint]="'labels.noPrinterNote' | translate">
        <select id="lsc-printer" class="nota-select" name="labelPrinter" data-field="label-printer" [ngModel]="printer()" (ngModelChange)="printer.set($event)">
          <option value="">{{ 'print.settings.noneDialog' | translate }}</option>
          @for (entry of printers(); track entry.name) { <option [value]="entry.name">{{ entry.displayName }}</option> }
        </select>
      </nota-form-field>
      <nota-form-field [label]="'labels.settings.preset' | translate" forId="lsc-preset">
        <select id="lsc-preset" class="nota-select" name="rollPreset" data-field="roll-preset" [ngModel]="rollPreset()" (ngModelChange)="rollPreset.set($event)">
          @for (key of rollKeys; track key) { <option [value]="key">{{ key.replace('x', ' × ') }} mm</option> }
          <option value="custom">{{ 'labels.settings.custom' | translate }}</option>
        </select>
      </nota-form-field>
      @if (rollPreset() === 'custom') {
        <div class="lsc__row">
          <nota-form-field [label]="'labels.settings.width' | translate" forId="lsc-w"><input id="lsc-w" class="nota-input nota-num" type="number" min="20" max="110" step="0.5" name="rollW" data-field="roll-width" [ngModel]="rollW()" (ngModelChange)="rollW.set($event)" /></nota-form-field>
          <nota-form-field [label]="'labels.settings.height' | translate" forId="lsc-h"><input id="lsc-h" class="nota-input nota-num" type="number" min="15" max="150" step="0.5" name="rollH" data-field="roll-height" [ngModel]="rollH()" (ngModelChange)="rollH.set($event)" /></nota-form-field>
        </div>
      }
      <div class="lsc__row">
        <nota-form-field [label]="'labels.settings.offsetX' | translate" forId="lsc-ox"><input id="lsc-ox" class="nota-input nota-num" type="number" min="-5" max="5" step="0.5" name="offX" data-field="offset-x" [ngModel]="offX()" (ngModelChange)="offX.set($event)" /></nota-form-field>
        <nota-form-field [label]="'labels.settings.offsetY' | translate" forId="lsc-oy"><input id="lsc-oy" class="nota-input nota-num" type="number" min="-5" max="5" step="0.5" name="offY" data-field="offset-y" [ngModel]="offY()" (ngModelChange)="offY.set($event)" /></nota-form-field>
        <nota-form-field [label]="'labels.settings.gap' | translate" forId="lsc-gap"><input id="lsc-gap" class="nota-input nota-num" type="number" min="0" max="10" step="0.5" name="gap" data-field="gap" [ngModel]="gap()" (ngModelChange)="gap.set($event)" /></nota-form-field>
      </div>
      <button type="button" notaButton data-action="test-label" [disabled]="busy()" (click)="testLabel()">{{ 'labels.settings.testLabel' | translate }}</button>

      <nota-form-field [label]="'labels.settings.sheetPreset' | translate" forId="lsc-sheet">
        <select id="lsc-sheet" class="nota-select" name="sheetPreset" data-field="sheet-preset" [ngModel]="sheetPreset()" (ngModelChange)="sheetPreset.set($event)">
          @for (key of sheetKeys; track key) { <option [value]="key">{{ sheetText(key) }}</option> }
          <option value="custom">{{ 'labels.settings.custom' | translate }}</option>
        </select>
      </nota-form-field>
      @if (sheetPreset() === 'custom') {
        <div class="lsc__row">
          <nota-form-field [label]="'labels.settings.columns' | translate" forId="lsc-cols"><input id="lsc-cols" class="nota-input nota-num" type="number" min="1" max="10" step="1" name="cols" data-field="sheet-columns" [ngModel]="cols()" (ngModelChange)="cols.set($event)" /></nota-form-field>
          <nota-form-field [label]="'labels.settings.rows' | translate" forId="lsc-rows"><input id="lsc-rows" class="nota-input nota-num" type="number" min="1" max="30" step="1" name="rows" data-field="sheet-rows" [ngModel]="rows()" (ngModelChange)="rows.set($event)" /></nota-form-field>
          <nota-form-field [label]="'labels.settings.labelWidth' | translate" forId="lsc-lw"><input id="lsc-lw" class="nota-input nota-num" type="number" min="10" max="210" step="0.05" name="lw" data-field="sheet-label-width" [ngModel]="lw()" (ngModelChange)="lw.set($event)" /></nota-form-field>
          <nota-form-field [label]="'labels.settings.labelHeight' | translate" forId="lsc-lh"><input id="lsc-lh" class="nota-input nota-num" type="number" min="8" max="297" step="0.05" name="lh" data-field="sheet-label-height" [ngModel]="lh()" (ngModelChange)="lh.set($event)" /></nota-form-field>
        </div>
        <div class="lsc__row">
          <nota-form-field [label]="'labels.settings.marginTop' | translate" forId="lsc-mt"><input id="lsc-mt" class="nota-input nota-num" type="number" min="0" max="50" step="0.05" name="mt" data-field="sheet-margin-top" [ngModel]="mt()" (ngModelChange)="mt.set($event)" /></nota-form-field>
          <nota-form-field [label]="'labels.settings.marginSide' | translate" forId="lsc-ms"><input id="lsc-ms" class="nota-input nota-num" type="number" min="0" max="50" step="0.05" name="ms" data-field="sheet-margin-side" [ngModel]="ms()" (ngModelChange)="ms.set($event)" /></nota-form-field>
          <nota-form-field [label]="'labels.settings.gapX' | translate" forId="lsc-gx"><input id="lsc-gx" class="nota-input nota-num" type="number" min="0" max="20" step="0.05" name="gx" data-field="sheet-gap-x" [ngModel]="gx()" (ngModelChange)="gx.set($event)" /></nota-form-field>
          <nota-form-field [label]="'labels.settings.gapY' | translate" forId="lsc-gy"><input id="lsc-gy" class="nota-input nota-num" type="number" min="0" max="20" step="0.05" name="gy" data-field="sheet-gap-y" [ngModel]="gy()" (ngModelChange)="gy.set($event)" /></nota-form-field>
        </div>
      }
      <button type="button" notaButton data-action="outline-sheet" [disabled]="busy()" (click)="outline()">{{ 'labels.settings.outline' | translate }}</button>
      <p class="nota-hint">{{ 'labels.settings.outlineHint' | translate }}</p>

      <h4 class="lsc__sub">{{ 'labels.settings.sounds' | translate }}</h4>
      <label class="lsc__check"><input type="checkbox" name="mute" data-field="scan-mute" [ngModel]="mute()" (ngModelChange)="mute.set($event)" /> {{ 'labels.settings.mute' | translate }}</label>

      @if (message()) { <p role="status" data-test="label-status" [class.nota-error]="isError()">{{ message() }}</p> }
      <button type="button" notaButton="primary" data-action="save-label-settings" [disabled]="busy()" (click)="save()">{{ 'labels.settings.save' | translate }}</button>
    </section>
  `,
  styles: [
    `
      .lsc { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; padding-top: 8px; border-top: 1px solid var(--border); width: 100%; }
      .lsc nota-form-field, .lsc .nota-select, .lsc .nota-input { max-width: 360px; width: 100%; }
      .lsc__row { display: flex; flex-wrap: wrap; gap: 12px; }
      .lsc__row nota-form-field { max-width: 170px; }
      .lsc__sub { margin: 0; font-size: 14px; }
      .lsc__check { display: inline-flex; gap: 8px; align-items: center; }
    `,
  ],
})
export class LabelSettingsCardComponent implements OnInit {
  private readonly settings = inject(PrintSettingsService);
  private readonly printService = inject(PrintService);

  readonly rollKeys = Object.keys(ROLL_PRESETS);
  readonly sheetKeys = Object.keys(SHEET_PRESETS);
  readonly printers = signal<DesktopPrinter[]>([]);
  readonly busy = signal(false);
  readonly message = signal('');
  readonly isError = signal(false);

  readonly printer = signal('');
  readonly rollPreset = signal<LabelRollPreset>('38x25');
  readonly rollW = signal<number | string>(38);
  readonly rollH = signal<number | string>(25);
  readonly offX = signal<number | string>(0);
  readonly offY = signal<number | string>(0);
  readonly gap = signal<number | string>(0);
  readonly sheetPreset = signal<LabelSheetPreset>('3x8');
  readonly cols = signal<number | string>(3);
  readonly rows = signal<number | string>(8);
  readonly lw = signal<number | string>(70);
  readonly lh = signal<number | string>(37);
  readonly mt = signal<number | string>(0);
  readonly ms = signal<number | string>(0);
  readonly gx = signal<number | string>(0);
  readonly gy = signal<number | string>(0);
  readonly mute = signal(false);

  async ngOnInit(): Promise<void> {
    const [current, printers] = await Promise.all([this.settings.load(), this.settings.printers()]);
    this.printers.set(printers);
    if (current) this.apply(current);
  }

  sheetText(key: string): string {
    const sheet = SHEET_PRESETS[key as keyof typeof SHEET_PRESETS];
    return `${sheet.columns} × ${sheet.rows} (${sheet.columns * sheet.rows}) · ${sheet.labelWidthMm} × ${sheet.labelHeightMm} mm`;
  }

  private apply(value: { labelPrinter?: string; labelRoll?: unknown; labelSheet?: unknown; scanSoundMuted?: boolean }): void {
    const roll = normalizeRoll(value.labelRoll);
    const sheet = normalizeSheet(value.labelSheet);
    this.printer.set(value.labelPrinter ?? '');
    this.rollPreset.set(roll.preset);
    this.rollW.set(roll.widthMm); this.rollH.set(roll.heightMm);
    this.offX.set(roll.offsetXmm); this.offY.set(roll.offsetYmm); this.gap.set(roll.gapMm);
    this.sheetPreset.set(sheet.preset);
    this.cols.set(sheet.columns); this.rows.set(sheet.rows);
    this.lw.set(sheet.labelWidthMm); this.lh.set(sheet.labelHeightMm);
    this.mt.set(sheet.marginTopMm); this.ms.set(sheet.marginSideMm);
    this.gx.set(sheet.gapXmm); this.gy.set(sheet.gapYmm);
    this.mute.set(value.scanSoundMuted === true);
  }

  /** Saves what is typed (the desktop app clamps every number again); resolves whether it was saved. */
  async save(): Promise<boolean> {
    this.busy.set(true);
    this.message.set('');
    const result = await this.settings.save({
      labelPrinter: this.printer(),
      labelRoll: normalizeRoll({ preset: this.rollPreset(), widthMm: this.rollW(), heightMm: this.rollH(), offsetXmm: this.offX(), offsetYmm: this.offY(), gapMm: this.gap() }),
      labelSheet: normalizeSheet({ preset: this.sheetPreset(), columns: this.cols(), rows: this.rows(), labelWidthMm: this.lw(), labelHeightMm: this.lh(), marginTopMm: this.mt(), marginSideMm: this.ms(), gapXmm: this.gx(), gapYmm: this.gy() }),
      scanSoundMuted: this.mute(),
    });
    this.busy.set(false);
    if (result.ok === true) {
      this.isError.set(false);
      this.apply(result.settings);
      this.message.set('✓');
      return true;
    }
    this.isError.set(true);
    this.message.set(result.message);
    return false;
  }

  /** A test label on the label printer (saved first, so the label shows the size and offsets that will be used). */
  async testLabel(): Promise<void> {
    if (!(await this.save())) return;
    this.busy.set(true);
    await this.printService.labelTestPage(this.printer());
    this.busy.set(false);
  }

  /** The label borders only, on plain A4, to check the sticker sheet alignment (saved first). */
  async outline(): Promise<void> {
    if (!(await this.save())) return;
    this.busy.set(true);
    await this.printService.outlineSheet();
    this.busy.set(false);
  }
}
