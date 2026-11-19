import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { of, throwError } from 'rxjs';
import { CustomerPhoneCheck } from './customer-phone-check';
import { CustomerPhoneDialogComponent } from './customer-phone-dialog.component';
import { CustomerByPhone, CustomerPhoneService } from './customer-phone.service';

/** Online Fixes 1: what a sale screen does when the cashier finishes typing a phone that already belongs to a customer. */
describe('customer phone check (Online Fixes 1)', () => {
  const setup = (answer: CustomerByPhone | 'error', canRename = false) => {
    const lookup = { lookup: jasmine.createSpy('lookup').and.returnValue(answer === 'error' ? throwError(() => new Error('x')) : of(answer)) } as unknown as CustomerPhoneService;
    const filled: string[] = [];
    let focused = 0;
    const check = new CustomerPhoneCheck(lookup, () => canRename, (name) => filled.push(name), () => { focused++; });
    return { check, lookup: lookup.lookup as jasmine.Spy, filled, focused: () => focused };
  };

  it('an unknown phone does nothing', () => {
    const { check, filled } = setup({ exists: false });
    check.check('01012345678', 'اسم');
    expect(check.dialogOpen()).toBeFalse();
    expect(filled).toEqual([]);
  });

  it('an empty name field is filled with the stored name without asking', () => {
    const { check, filled } = setup({ exists: true, name: 'أحمد القديم' });
    check.check('01012345678', '   ');
    expect(filled).toEqual(['أحمد القديم']);
    expect(check.dialogOpen()).toBeFalse();
  });

  it('the same name does not ask', () => {
    const { check } = setup({ exists: true, name: 'أحمد' });
    check.check('01012345678', 'أحمد');
    expect(check.dialogOpen()).toBeFalse();
  });

  it('a different name asks; «نفس العميل» uses the stored name and never sends the rename flag', () => {
    const { check, filled } = setup({ exists: true, name: 'أحمد القديم' }, true);
    check.check('01012345678', 'اسم جديد');
    expect(check.dialogOpen()).toBeTrue();
    expect(check.storedName()).toBe('أحمد القديم');
    expect(check.typedName()).toBe('اسم جديد');
    check.chooseSame();
    expect(check.dialogOpen()).toBeFalse();
    expect(filled).toEqual(['أحمد القديم']);
    expect(check.renameFlagFor('01012345678', 'أحمد القديم')).toBeFalse();
    expect(check.renameFlagFor('01012345678', 'اسم جديد')).toBeFalse();
  });

  it('«غيّر اسمه» (only with customers.manage) sends the flag for exactly that phone and name', () => {
    const { check } = setup({ exists: true, name: 'أحمد القديم' }, true);
    check.check('01012345678', 'اسم جديد');
    check.chooseRename();
    expect(check.dialogOpen()).toBeFalse();
    expect(check.renameFlagFor('01012345678', 'اسم جديد')).toBeTrue();
    expect(check.renameFlagFor('01012345678 ', ' اسم جديد ')).toBeTrue();
    expect(check.renameFlagFor('01099999999', 'اسم جديد')).toBeFalse();
    expect(check.renameFlagFor('01012345678', 'اسم تاني')).toBeFalse();
  });

  it('without customers.manage the rename choice does nothing and the flag is never sent', () => {
    const { check } = setup({ exists: true, name: 'أحمد القديم' }, false);
    check.check('01012345678', 'اسم جديد');
    check.chooseRename();
    expect(check.renameFlagFor('01012345678', 'اسم جديد')).toBeFalse();
  });

  it('«الرقم غلط» closes and focuses the phone field', () => {
    const { check, focused } = setup({ exists: true, name: 'أحمد القديم' });
    check.check('01012345678', 'اسم جديد');
    check.chooseWrong();
    expect(check.dialogOpen()).toBeFalse();
    expect(focused()).toBe(1);
  });

  it('a failed lookup never blocks the sale (the server does not rename by default)', () => {
    const { check } = setup('error');
    check.check('01012345678', 'اسم');
    expect(check.dialogOpen()).toBeFalse();
  });

  it('a blank phone is not looked up', () => {
    const { check, lookup } = setup({ exists: true, name: 'x' });
    check.check('   ', 'اسم');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('after «غيّر اسمه» the same phone and name do not ask again', () => {
    const { check, lookup } = setup({ exists: true, name: 'أحمد القديم' }, true);
    check.check('01012345678', 'اسم جديد');
    check.chooseRename();
    lookup.calls.reset();
    check.check('01012345678', 'اسم جديد');
    expect(lookup).not.toHaveBeenCalled();
  });
});

@Component({
  imports: [CustomerPhoneDialogComponent],
  template: `<nota-customer-phone-dialog [open]="true" storedName="أحمد القديم" typedName="اسم جديد" [canRename]="canRename"
    (same)="events.push('same')" (rename)="events.push('rename')" (wrong)="events.push('wrong')" />`,
})
class HostComponent {
  canRename = true;
  events: string[] = [];
}

describe('customer phone dialog (Online Fixes 1)', () => {
  let fixture: ComponentFixture<HostComponent>;
  const body = () => document.body;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent, TranslateModule.forRoot()], providers: [provideNoopAnimations()] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
  });

  it('offers the three choices with customers.manage, and only two without it', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(body().querySelector('[data-action="same"]')).not.toBeNull();
    expect(body().querySelector('[data-action="rename"]')).not.toBeNull();
    expect(body().querySelector('[data-action="wrong"]')).not.toBeNull();
    (body().querySelector('[data-action="same"]') as HTMLElement).click();
    (body().querySelector('[data-action="rename"]') as HTMLElement).click();
    (body().querySelector('[data-action="wrong"]') as HTMLElement).click();
    expect(fixture.componentInstance.events).toEqual(['same', 'rename', 'wrong']);
  });

  it('hides «غيّر اسمه» without customers.manage', async () => {
    fixture.componentInstance.canRename = false;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(body().querySelector('[data-action="rename"]')).toBeNull();
    expect(body().querySelector('[data-action="same"]')).not.toBeNull();
  });
});
