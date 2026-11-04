import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NotaButtonDirective, NotaButtonVariant } from './button.directive';

@Component({
  imports: [NotaButtonDirective],
  template: `
    <button id="default" notaButton class="extra">Default</button>
    <button id="variant" [notaButton]="variant()" size="lg">Variant</button>
    <button id="icon" notaButton icon>×</button>
  `,
})
class HostComponent {
  readonly variant = signal<NotaButtonVariant>('primary');
}

describe('NotaButtonDirective', () => {
  function setup() {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const el = (id: string) => fixture.nativeElement.querySelector(`#${id}`) as HTMLButtonElement;
    return { fixture, el };
  }

  it('defaults to the secondary variant and keeps existing classes', () => {
    const { el } = setup();
    expect(el('default').classList).toContain('nota-btn');
    expect(el('default').classList).toContain('nota-btn--secondary');
    expect(el('default').classList).toContain('extra');
  });

  it('applies the variant and size classes and follows changes', () => {
    const { fixture, el } = setup();
    expect(el('variant').classList).toContain('nota-btn--primary');
    expect(el('variant').classList).toContain('nota-btn--lg');
    fixture.componentInstance.variant.set('danger');
    fixture.detectChanges();
    expect(el('variant').classList).toContain('nota-btn--danger');
    expect(el('variant').classList).not.toContain('nota-btn--primary');
  });

  it('supports icon-only buttons', () => {
    const { el } = setup();
    expect(el('icon').classList).toContain('nota-btn--icon');
  });
});
