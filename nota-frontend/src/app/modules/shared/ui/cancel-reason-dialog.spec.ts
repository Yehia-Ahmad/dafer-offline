import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NotaCancelReasonDialogComponent } from './cancel-reason-dialog.component';
import { correctionErrorText } from './correction-error';

@Component({
  imports: [NotaCancelReasonDialogComponent],
  template: `<nota-cancel-reason-dialog [open]="open()" title="إلغاء" text="هيتلغي" confirmLabel="إلغاء السند" [requireReason]="requireReason()"
    [busy]="busy()" [error]="error()" (confirmed)="confirmed.push($event)" (closed)="closed = closed + 1" />`,
})
class HostComponent {
  open = signal(true);
  requireReason = signal(true);
  busy = signal(false);
  error = signal('');
  confirmed: string[] = [];
  closed = 0;
}

/** Online Fixes 1: the red confirm dialog shared by every correction screen. */
describe('cancel reason dialog (Online Fixes 1)', () => {
  let fixture: ComponentFixture<HostComponent>;
  const button = () => document.body.querySelector<HTMLButtonElement>('[data-action="confirm-correction"]')!;
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const type = async (value: string) => {
    const input = document.body.querySelector<HTMLInputElement>('[data-test="cancel-reason"]')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent, TranslateModule.forRoot()], providers: [provideNoopAnimations()] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    await settle();
  });

  it('keeps the red button disabled until the reason has 3 characters, then sends it trimmed', async () => {
    expect(button().disabled).toBeTrue();
    await type('ab');
    expect(button().disabled).toBeTrue();
    await type('  غلط  ');
    expect(button().disabled).toBeFalse();
    button().click();
    expect(fixture.componentInstance.confirmed).toEqual(['غلط']);
  });

  it('without requireReason there is no field and the button confirms with an empty reason', async () => {
    fixture.componentInstance.requireReason.set(false);
    await settle();
    expect(document.body.querySelector('[data-test="cancel-reason"]')).toBeNull();
    expect(button().disabled).toBeFalse();
    button().click();
    expect(fixture.componentInstance.confirmed).toEqual(['']);
  });

  it('busy disables the button and an error is shown', async () => {
    fixture.componentInstance.busy.set(true);
    fixture.componentInstance.error.set('الخزنة مقفولة');
    fixture.componentInstance.requireReason.set(false);
    await settle();
    expect(button().disabled).toBeTrue();
    expect(document.body.querySelector('[data-testid="correction-error"]')!.textContent).toContain('الخزنة مقفولة');
  });
});

describe('correctionErrorText (Online Fixes 1)', () => {
  let translate: TranslateService;
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [TranslateModule.forRoot()] });
    translate = TestBed.inject(TranslateService);
    translate.setTranslation('ar', { corrections: { errors: { BOX_INACTIVE: 'الخزنة دي مقفولة', GENERIC: 'حصلت مشكلة' } } });
    translate.use('ar');
  });

  it('a known code wins over the server message', () => {
    expect(correctionErrorText({ error: { code: 'BOX_INACTIVE', message: 'x' } }, translate)).toBe('الخزنة دي مقفولة');
  });

  it('an unknown code shows the server message; nothing at all shows the generic text', () => {
    expect(correctionErrorText({ error: { code: 'NEW_CODE', message: 'رسالة السيرفر' } }, translate)).toBe('رسالة السيرفر');
    expect(correctionErrorText({}, translate)).toBe('حصلت مشكلة');
  });
});
