import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NotaPillVariant, NotaStatusPillComponent } from './status-pill.component';

@Component({
  imports: [NotaStatusPillComponent],
  template: `<nota-status-pill [variant]="variant()">Paid</nota-status-pill><nota-status-pill id="default">x</nota-status-pill>`,
})
class HostComponent {
  readonly variant = signal<NotaPillVariant>('ok');
}

describe('NotaStatusPillComponent', () => {
  it('renders content and defaults to neutral', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const pill: HTMLElement = fixture.nativeElement.querySelector('nota-status-pill');
    expect(pill.textContent).toContain('Paid');
    expect(fixture.nativeElement.querySelector('#default').classList).toContain('nota-pill--neutral');
  });

  it('applies each variant class', () => {
    const fixture = TestBed.createComponent(HostComponent);
    const pill = () => fixture.nativeElement.querySelector('nota-status-pill') as HTMLElement;
    for (const variant of ['ok', 'due', 'overdue', 'info', 'neutral'] as NotaPillVariant[]) {
      fixture.componentInstance.variant.set(variant);
      fixture.detectChanges();
      expect(pill().classList).toContain('nota-pill');
      expect(pill().classList).toContain(`nota-pill--${variant}`);
      expect(pill().classList.length).toBe(2);
    }
  });
});
