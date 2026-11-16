import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { FilterChip, MobConfirmComponent, MobFilterChipsComponent, MobFilterSheetComponent } from './mob-sheet.component';

@Component({
  imports: [MobFilterSheetComponent, MobFilterChipsComponent, MobConfirmComponent],
  template: `
    <nota-mob-filter-sheet [(open)]="filterOpen" title="فلاتر" (apply)="applied = applied + 1" (clear)="cleared = cleared + 1"><span>fields</span></nota-mob-filter-sheet>
    <nota-mob-filter-chips [chips]="chips()" (remove)="removed.push($event)" />
    <nota-mob-confirm [(open)]="confirmOpen" title="حذف" message="متأكد؟" confirmLabel="احذف" (confirmed)="confirmed = confirmed + 1" />
  `,
})
class HostComponent {
  filterOpen = signal(false);
  confirmOpen = signal(false);
  chips = signal<FilterChip[]>([{ key: 'status', label: 'جديد' }, { key: 'from', label: '2026-11-01' }]);
  applied = 0; cleared = 0; confirmed = 0; removed: string[] = [];
}

describe('phone sheets (Online Stage 6B)', () => {
  const setup = () => {
    TestBed.configureTestingModule({ imports: [HostComponent, TranslateModule.forRoot()] });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return { fixture, host: fixture.componentInstance, el: fixture.nativeElement as HTMLElement };
  };
  const click = (fixture: ReturnType<typeof setup>['fixture'], selector: string) => {
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(selector)!.click();
    fixture.detectChanges();
  };

  it('shows nothing until opened, then the filter sheet applies (and closes) or clears (and stays open)', () => {
    const { fixture, host, el } = setup();
    expect(el.querySelector('[data-testid="m-sheet"]')).toBeNull();
    host.filterOpen.set(true); fixture.detectChanges();
    expect(el.querySelector('[data-testid="m-sheet"]')).not.toBeNull();
    click(fixture, '[data-testid="m-filter-clear"]');
    expect(host.cleared).toBe(1);
    expect(host.filterOpen()).toBeTrue();
    click(fixture, '[data-testid="m-filter-apply"]');
    expect(host.applied).toBe(1);
    expect(host.filterOpen()).toBeFalse();
  });

  it('closes on the scrim', () => {
    const { fixture, host } = setup();
    host.filterOpen.set(true); fixture.detectChanges();
    click(fixture, '[data-testid="m-sheet-scrim"]');
    expect(host.filterOpen()).toBeFalse();
  });

  it('lets each active-filter chip be removed', () => {
    const { fixture, host } = setup();
    click(fixture, '[data-chip="from"]');
    expect(host.removed).toEqual(['from']);
  });

  it('renders no chip row when there are no active filters', () => {
    const { fixture, host, el } = setup();
    host.chips.set([]); fixture.detectChanges();
    expect(el.querySelector('[data-testid="m-filter-chips"]')).toBeNull();
  });

  it('confirms with a red action and closes; cancel closes without confirming', () => {
    const { fixture, host, el } = setup();
    host.confirmOpen.set(true); fixture.detectChanges();
    expect(el.querySelector('[data-testid="m-confirm-ok"]')!.classList).toContain('m-btn--danger');
    click(fixture, '[data-testid="m-confirm-cancel"]');
    expect(host.confirmed).toBe(0);
    host.confirmOpen.set(true); fixture.detectChanges();
    click(fixture, '[data-testid="m-confirm-ok"]');
    expect(host.confirmed).toBe(1);
    expect(host.confirmOpen()).toBeFalse();
  });
});
