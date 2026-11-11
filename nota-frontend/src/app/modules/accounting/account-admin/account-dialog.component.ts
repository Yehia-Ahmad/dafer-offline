import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { TranslatePipe } from '@ngx-translate/core';
import { Dialog } from 'primeng/dialog';
import { LanguageService } from '../../shared/services/translation.service';
import { NotaButtonDirective, NotaDialogShellComponent } from '../../shared/ui';
import { AccountAdminService, AccountUsage, AdminAccount, NextCode } from './account-admin.service';

/** A row of the accounts tree as the dialog needs it. */
export interface TreeAccount { _id: string; code: string; nameAr: string; nameEn: string; isGroup: boolean; isActive?: boolean; parentId?: string | null; type?: string }

/** Parents the dialog never offers: the box branches have their own screen (الخزائن). */
const BOX_BRANCHES = ['111', '112'];

/**
 * Stage 22: "حساب جديد" (AddAccount.dc.html) and the edit dialog of one account (accounting.manage).
 * Add: a group parent (required), the code (automatic: the next free child code of that parent), an Arabic name (required), an English
 * one (optional), the type shown (inherited from the parent) and "حساب تجميعي". Edit: the names always (system accounts included); the
 * parent and the code only while the account has no lines (never a system or box account); the type never. Stop / start / delete
 * follow the backend rules, which this dialog shows (a stopped account takes no postings; delete only if it never had lines).
 */
@Component({
  selector: 'app-account-dialog',
  imports: [FormsModule, TranslatePipe, Dialog, NotaButtonDirective, NotaDialogShellComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-dialog [visible]="true" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog" (onHide)="closed.emit()">
      <nota-dialog-shell [title]="(account() ? 'accountsAdmin.editTitle' : 'accountsAdmin.addTitle') | translate" [closeLabel]="'accountsAdmin.close' | translate" (closed)="closed.emit()">
        <form class="ad" (ngSubmit)="save()" #form="ngForm" data-test="account-form">
          @if (!account()) {
            <label class="ad__field"><span class="nota-label">{{ 'accountsAdmin.parent' | translate }} *</span>
              <select class="nota-select" name="parent" data-field="parent" [ngModel]="parentId()" (ngModelChange)="pickParent($event)">
                <option value="">{{ 'accountsAdmin.pickParent' | translate }}</option>
                @for (parent of parents(); track parent._id) { <option [value]="parent._id">{{ parent.code }} · {{ name(parent) }}</option> }
              </select></label>
            <div class="ad__field"><span class="nota-label">{{ 'accountsAdmin.code' | translate }}</span>
              <output class="nota-input nota-num ad__code" dir="ltr" data-test="auto-code">{{ next()?.code || ('accountsAdmin.codeAuto' | translate) }}</output></div>
            @if (next(); as n) { <p class="ad__type" data-test="inherited-type">{{ 'accountsAdmin.typeInherited' | translate: { type: ('accountsAdmin.types.' + n.type | translate) } }}</p> }
          } @else {
            <div class="ad__field"><span class="nota-label">{{ 'accountsAdmin.code' | translate }}</span>
              @if (usage()?.canEditStructure) {
                <input class="nota-input nota-num" dir="ltr" name="code" data-field="code" maxlength="8" [ngModel]="code()" (ngModelChange)="code.set($event)" />
              } @else { <output class="nota-input nota-num ad__code" dir="ltr" data-test="fixed-code">{{ account()?.code }}</output> }
            </div>
            @if (usage(); as u) {
              @if (!u.canEditStructure) { <p class="ad__note" data-test="structure-locked">{{ (account()?.isSystem ? 'accountsAdmin.structureSystem' : u.isBox ? 'accountsAdmin.structureBox' : 'accountsAdmin.structureLines') | translate }}</p> }
              @else {
                <label class="ad__field"><span class="nota-label">{{ 'accountsAdmin.parent' | translate }}</span>
                  <select class="nota-select" name="editParent" data-field="parent" [ngModel]="parentId()" (ngModelChange)="parentId.set($event)">
                    @for (parent of parents(); track parent._id) { <option [value]="parent._id">{{ parent.code }} · {{ name(parent) }}</option> }
                  </select></label>
              }
            }
            <p class="ad__type" data-test="fixed-type">{{ 'accountsAdmin.typeFixed' | translate: { type: ('accountsAdmin.types.' + account()?.type | translate) } }}</p>
          }

          <label class="ad__field"><span class="nota-label">{{ 'accountsAdmin.nameAr' | translate }} *</span>
            <input class="nota-input" name="nameAr" data-field="nameAr" maxlength="120" required [ngModel]="nameAr()" (ngModelChange)="nameAr.set($event)" /></label>
          <label class="ad__field"><span class="nota-label">{{ 'accountsAdmin.nameEn' | translate }}</span>
            <input class="nota-input" name="nameEn" data-field="nameEn" maxlength="120" dir="ltr" [ngModel]="nameEn()" (ngModelChange)="nameEn.set($event)" /></label>
          @if (!account()) {
            <label class="ad__check"><input type="checkbox" name="isGroup" data-field="isGroup" [ngModel]="isGroup()" (ngModelChange)="isGroup.set($event)" /> {{ 'accountsAdmin.isGroup' | translate }}</label>
            @if (next()?.type === 'expense' && next()?.parent?.code === '520') { <p class="ad__hint" data-test="category-hint">{{ 'accountsAdmin.expenseCategoryHint' | translate }}</p> }
          }

          @if (account(); as acc) {
            @if (usage(); as u) {
              <div class="ad__state" data-test="account-state">
                <span>{{ (acc.isActive ? 'accountsAdmin.active' : 'accountsAdmin.inactive') | translate }}</span>
                @if (u.canDeactivate) { <button type="button" notaButton data-action="deactivate" [disabled]="busy()" (click)="deactivate()">{{ 'accountsAdmin.deactivate' | translate }}</button> }
                @else if (acc.isActive) { <small class="ad__hint" data-test="deactivate-blocked">{{ 'accountsAdmin.cannotDeactivate' | translate }}: {{ blockedText(u.deactivateBlockedBy) }}</small> }
                @if (u.canReactivate) { <button type="button" notaButton data-action="reactivate" [disabled]="busy()" (click)="reactivate()">{{ 'accountsAdmin.reactivate' | translate }}</button> }
                @if (u.canDelete) { <button type="button" notaButton="danger" data-action="delete" [disabled]="busy()" (click)="remove()">{{ 'accountsAdmin.delete' | translate }}</button> }
              </div>
              @if (u.balance !== 0) { <p class="ad__hint nota-num" data-test="balance-note">{{ 'accountsAdmin.balanceNote' | translate: { amount: u.balance } }}</p> }
            }
          }

          @if (error()) { <p class="nota-error" role="alert" data-test="dialog-error">{{ error() | translate }}</p> }
        </form>
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="closed.emit()">{{ 'accountsAdmin.cancel' | translate }}</button>
          <button type="button" notaButton="primary" data-action="save" [disabled]="!canSave() || busy()" (click)="save()">{{ 'accountsAdmin.save' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>
  `,
  styles: `
    .ad { display: flex; flex-direction: column; gap: 12px; min-width: min(480px, 86vw); }
    .ad__field { display: flex; flex-direction: column; gap: 4px; }
    .ad__code { display: flex; align-items: center; background: var(--surface-2); color: var(--text-muted); }
    .ad__type, .ad__hint { margin: 0; font-size: 13px; color: var(--text-muted); }
    .ad__note { margin: 0; padding: 10px 12px; border-radius: var(--radius-control); background: var(--info-soft); color: var(--info-text); font-size: 13px; }
    .ad__check { display: flex; align-items: flex-start; gap: 8px; font-size: 14px; min-height: var(--touch-target); }
    .ad__state { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-top: 8px; border-top: 1px solid var(--line); }
  `,
})
export class AccountDialogComponent implements OnInit {
  private readonly service = inject(AccountAdminService);
  private readonly language = inject(LanguageService);

  /** Edit mode: the account. Absent: add mode. */
  readonly account = input<AdminAccount | null>(null);
  /** Every account of the chart (flattened): the parents are its groups. */
  readonly chart = input<readonly TreeAccount[]>([]);
  readonly saved = output<AdminAccount | null>();
  readonly closed = output<void>();

  readonly parentId = signal('');
  readonly next = signal<NextCode | null>(null);
  readonly usage = signal<AccountUsage | null>(null);
  readonly nameAr = signal('');
  readonly nameEn = signal('');
  readonly code = signal('');
  readonly isGroup = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');

  readonly parents = computed(() => this.chart().filter((row) => row.isGroup && row.isActive !== false && !BOX_BRANCHES.includes(row.code)));
  readonly canSave = computed(() => (this.account() ? this.nameAr().trim().length > 0 : !!this.parentId() && !!this.next() && this.nameAr().trim().length > 0));

  ngOnInit(): void {
    const account = this.account();
    if (!account) return;
    this.nameAr.set(account.nameAr); this.nameEn.set(account.nameEn); this.code.set(account.code); this.parentId.set(account.parentId ?? '');
    this.service.usage(account._id).subscribe({ next: (usage) => this.usage.set(usage), error: () => this.error.set('accountsAdmin.errors.generic') });
  }

  protected name(row: { nameAr: string; nameEn: string }): string { return this.language.selectedLanguage() === 'en' ? row.nameEn || row.nameAr : row.nameAr; }

  protected blockedText(reasons: string[]): string { return reasons.join(' · '); }

  pickParent(id: string): void {
    this.parentId.set(id);
    this.next.set(null);
    this.error.set('');
    if (!id) return;
    this.service.nextCode(id).subscribe({ next: (next) => this.next.set(next), error: (error) => this.fail(error) });
  }

  private fail(error: unknown): void {
    this.busy.set(false);
    const body = error instanceof HttpErrorResponse ? (error.error as { message?: string } | null) : null;
    this.error.set(body?.message || 'accountsAdmin.errors.generic');
  }

  save(): void {
    if (!this.canSave()) return;
    this.busy.set(true); this.error.set('');
    const account = this.account();
    if (!account) {
      this.service.create({ parentId: this.parentId(), nameAr: this.nameAr().trim(), ...(this.nameEn().trim() ? { nameEn: this.nameEn().trim() } : {}), isGroup: this.isGroup() })
        .subscribe({ next: (created) => { this.busy.set(false); this.saved.emit(created); }, error: (error) => this.fail(error) });
      return;
    }
    const payload: Record<string, string> = { nameAr: this.nameAr().trim(), nameEn: this.nameEn().trim() || this.nameAr().trim() };
    if (this.usage()?.canEditStructure) {
      if (this.parentId() && this.parentId() !== (account.parentId ?? '')) payload['parentId'] = this.parentId();
      else if (this.code().trim() && this.code().trim() !== account.code) payload['code'] = this.code().trim();
    }
    this.service.update(account._id, payload).subscribe({ next: (updated) => { this.busy.set(false); this.saved.emit(updated); }, error: (error) => this.fail(error) });
  }

  deactivate(): void { this.act(this.service.deactivate(this.account()!._id)); }
  reactivate(): void { this.act(this.service.reactivate(this.account()!._id)); }
  remove(): void {
    this.busy.set(true); this.error.set('');
    this.service.remove(this.account()!._id).subscribe({ next: () => { this.busy.set(false); this.saved.emit(null); }, error: (error) => this.fail(error) });
  }
  private act(request: ReturnType<AccountAdminService['deactivate']>): void {
    this.busy.set(true); this.error.set('');
    request.subscribe({ next: (updated) => { this.busy.set(false); this.saved.emit(updated); }, error: (error) => this.fail(error) });
  }
}
