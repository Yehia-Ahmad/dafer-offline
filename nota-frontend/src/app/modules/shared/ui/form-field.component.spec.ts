import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { NotaFormFieldComponent } from './form-field.component';

@Component({
  imports: [NotaFormFieldComponent, ReactiveFormsModule],
  template: `
    <nota-form-field label="Name" forId="name" hint="Shown on invoices" [error]="error()" [required]="true">
      <input id="name" class="nota-input" [formControl]="control" />
    </nota-form-field>
  `,
})
class HostComponent {
  readonly control = new FormControl('');
  readonly error = signal<string | null>(null);
}

describe('NotaFormFieldComponent', () => {
  it('renders label above the projected control, linked by id, with the hint', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement.querySelector('nota-form-field');
    const label = host.querySelector('label.nota-label') as HTMLLabelElement;
    expect(host.classList).toContain('nota-field');
    expect(label.textContent).toContain('Name');
    expect(label.textContent).toContain('*');
    expect(label.htmlFor).toBe('name');
    expect(host.querySelector('input.nota-input')).toBeTruthy();
    expect(host.querySelector('.nota-hint')?.textContent).toContain('Shown on invoices');
  });

  it('shows the error instead of the hint and marks the field invalid', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.error.set('Required');
    fixture.detectChanges();
    const host: HTMLElement = fixture.nativeElement.querySelector('nota-form-field');
    expect(host.classList).toContain('nota-field--invalid');
    expect(host.querySelector('.nota-error')?.textContent).toContain('Required');
    expect(host.querySelector('.nota-hint')).toBeNull();
  });

  it('keeps working with Reactive Forms', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');
    input.value = '123';
    input.dispatchEvent(new Event('input'));
    expect(fixture.componentInstance.control.value).toBe('123');
  });
});
