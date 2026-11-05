import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateModule } from '@ngx-translate/core';
import { NotaCanDirective } from './nota-can.directive';
import { LockedActionComponent } from './locked-action.component';
import { signInWith } from './testing/sign-in';

@Component({
  imports: [NotaCanDirective, LockedActionComponent],
  template: `
    <button *notaCan="'sales.delete'" class="single">delete</button>
    <button *notaCan="['products.importExport', 'products.viewCost']" class="all">export</button>
    <section *notaCan="['returns.view', 'returns.create']; any: true" class="any">returns</section>
    <button *notaCan="'credit.delete'; else locked" class="with-else">delete credit</button>
    <ng-template #locked><nota-locked-action class="locked" note="auth.locked.delete" /></ng-template>
  `,
})
class HostComponent {}

describe('notaCan directive (Stage 14)', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HostComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
  });

  const render = (permissions: string[]) => {
    signInWith(permissions);
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return fixture;
  };
  const has = (el: HTMLElement, selector: string) => !!el.querySelector(selector);

  it('no permissions: everything hidden; the else template (permission-locked pattern) shows', () => {
    const el = render([]).nativeElement as HTMLElement;
    expect(has(el, '.single')).toBeFalse();
    expect(has(el, '.all')).toBeFalse();
    expect(has(el, '.any')).toBeFalse();
    expect(has(el, '.with-else')).toBeFalse();
    expect(has(el, '.locked')).toBeTrue();
    expect(el.querySelector('.locked svg')).not.toBeNull(); // lock icon
  });

  it('a list needs every key; any: true needs one', () => {
    const el = render(['products.importExport', 'returns.create']).nativeElement as HTMLElement;
    expect(has(el, '.all')).toBeFalse();
    expect(has(el, '.any')).toBeTrue();
  });

  it('with the permissions: the action shows, the locked note does not', () => {
    const el = render(['sales.delete', 'credit.delete', 'products.importExport', 'products.viewCost']).nativeElement as HTMLElement;
    expect(has(el, '.single')).toBeTrue();
    expect(has(el, '.all')).toBeTrue();
    expect(has(el, '.with-else')).toBeTrue();
    expect(has(el, '.locked')).toBeFalse();
  });

  it('follows permission changes (e.g. after refreshMe)', () => {
    const fixture = render([]);
    const el = fixture.nativeElement as HTMLElement;
    signInWith(['sales.delete']);
    fixture.detectChanges();
    expect(has(el, '.single')).toBeTrue();
    signInWith([]);
    fixture.detectChanges();
    expect(has(el, '.single')).toBeFalse();
  });
});
