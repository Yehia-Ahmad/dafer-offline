import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NotaKpiCardComponent, NotaKpiNoteTone } from './kpi-card.component';

@Component({
  imports: [NotaKpiCardComponent],
  template: `<nota-kpi-card label="Sales today" value="12,480" note="+8% vs yesterday" [noteTone]="tone()" />`,
})
class HostComponent {
  readonly tone = signal<NotaKpiNoteTone>('success');
}

describe('NotaKpiCardComponent', () => {
  it('renders label, tabular value and note', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement.querySelector('nota-kpi-card');
    expect(el.classList).toContain('nota-kpi');
    expect(el.querySelector('.nota-kpi__label')?.textContent).toContain('Sales today');
    const value = el.querySelector('.nota-kpi__value') as HTMLElement;
    expect(value.textContent).toContain('12,480');
    expect(value.classList).toContain('num');
    expect(el.querySelector('.nota-kpi__note')?.textContent).toContain('+8% vs yesterday');
  });

  it('applies the note tone class', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const note = () => fixture.nativeElement.querySelector('.nota-kpi__note') as HTMLElement;
    expect(note().classList).toContain('nota-kpi__note--success');
    fixture.componentInstance.tone.set('danger');
    fixture.detectChanges();
    expect(note().classList).toContain('nota-kpi__note--danger');
    expect(note().classList).not.toContain('nota-kpi__note--success');
  });
});
