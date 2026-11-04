import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NotaCardComponent } from './card.component';

@Component({
  imports: [NotaCardComponent],
  template: `
    <nota-card id="titled" title="Sales"><button notaCardActions>All</button><p>Body</p></nota-card>
    <nota-card id="plain"><p>Only body</p></nota-card>
  `,
})
class HostComponent {}

describe('NotaCardComponent', () => {
  it('renders the card with title, actions and body', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const titled: HTMLElement = fixture.nativeElement.querySelector('#titled');
    expect(titled.classList).toContain('nota-card');
    expect(titled.querySelector('.nota-section-title')?.textContent).toContain('Sales');
    expect(titled.querySelector('.nota-card__head button')?.textContent).toContain('All');
    expect(titled.textContent).toContain('Body');
  });

  it('omits the header when there is no title', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const plain: HTMLElement = fixture.nativeElement.querySelector('#plain');
    expect(plain.querySelector('.nota-card__head')).toBeNull();
    expect(plain.textContent).toContain('Only body');
  });
});
