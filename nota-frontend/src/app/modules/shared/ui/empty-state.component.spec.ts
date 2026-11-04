import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NotaEmptyStateComponent } from './empty-state.component';

@Component({
  imports: [NotaEmptyStateComponent],
  template: `
    <nota-empty-state id="full" title="No invoices yet" text="Invoices you save appear here." icon="fa-solid fa-receipt">
      <button>New invoice</button>
    </nota-empty-state>
    <nota-empty-state id="minimal" title="Nothing here" />
  `,
})
class HostComponent {}

describe('NotaEmptyStateComponent', () => {
  it('renders icon, title, text and actions', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement.querySelector('#full');
    expect(el.classList).toContain('nota-empty');
    expect(el.querySelector('.nota-empty__icon i')?.classList.contains('fa-receipt')).toBeTrue();
    expect(el.querySelector('.nota-empty__title')?.textContent).toContain('No invoices yet');
    expect(el.querySelector('.nota-empty__text')?.textContent).toContain('Invoices you save appear here.');
    expect(el.querySelector('button')?.textContent).toContain('New invoice');
  });

  it('uses the default icon and omits empty text', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement.querySelector('#minimal');
    expect(el.querySelector('.nota-empty__icon i')?.classList.contains('fa-inbox')).toBeTrue();
    expect(el.querySelector('.nota-empty__text')).toBeNull();
  });
});
