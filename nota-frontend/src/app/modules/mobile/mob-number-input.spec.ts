import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MobNumberInputComponent, clampNumber, normalizeNumberText, numberFromText } from './mob-number-input.component';

describe('number text helpers (Online Stage 6B)', () => {
  it('accepts Arabic and English digits and the Arabic decimal separator', () => {
    expect(normalizeNumberText('١٢٣', 2, false)).toBe('123');
    expect(normalizeNumberText('۱۲٫٥', 2, false)).toBe('12.5');
    expect(normalizeNumberText('12,5', 2, false)).toBe('12.5');
    expect(normalizeNumberText('1٬250٫75', 2, false)).toBe('1250.75');
  });
  it('keeps at most the allowed decimals, one dot, and drops letters', () => {
    expect(normalizeNumberText('1.2345', 2, false)).toBe('1.23');
    expect(normalizeNumberText('1.2.3', 3, false)).toBe('1.23');
    expect(normalizeNumberText('12abc', 2, false)).toBe('12');
    expect(normalizeNumberText('12.7', 0, false)).toBe('12');
  });
  it('keeps a minus sign only when negatives are allowed', () => {
    expect(normalizeNumberText('-5', 2, false)).toBe('5');
    expect(normalizeNumberText('-5', 2, true)).toBe('-5');
  });
  it('turns text into a number, and an empty or incomplete text into null', () => {
    expect(numberFromText('12.5')).toBe(12.5);
    expect(numberFromText('')).toBeNull();
    expect(numberFromText('.')).toBeNull();
    expect(clampNumber(5, 10, 20)).toBe(10);
    expect(clampNumber(50, 10, 20)).toBe(20);
    expect(clampNumber(15, null, null)).toBe(15);
  });
});

@Component({
  imports: [MobNumberInputComponent, ReactiveFormsModule],
  template: `
    <nota-mob-number id="a" [formControl]="amount" [min]="0" [max]="100" [decimals]="2" />
    <nota-mob-number id="b" [formControl]="qty" [integer]="true" [min]="1" />
  `,
})
class HostComponent {
  amount = new FormControl<number | null>(12.5, [Validators.min(0)]);
  qty = new FormControl<number | null>(3);
}

describe('MobNumberInputComponent (Online Stage 6B)', () => {
  const setup = () => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return { fixture, host: fixture.componentInstance, el: fixture.nativeElement as HTMLElement };
  };
  const input = (el: HTMLElement, id: string) => el.querySelector<HTMLInputElement>(`#${id} input`)!;
  const type = (el: HTMLElement, id: string, value: string) => { const field = input(el, id); field.value = value; field.dispatchEvent(new Event('input')); };

  it('shows the control value in a text input with the right keyboard', () => {
    const { el } = setup();
    expect(input(el, 'a').type).toBe('text');
    expect(input(el, 'a').value).toBe('12.5');
    expect(input(el, 'a').getAttribute('inputmode')).toBe('decimal');
    expect(input(el, 'b').getAttribute('inputmode')).toBe('numeric');
  });

  it('writes a number into the same control, from Arabic or English digits', () => {
    const { host, el } = setup();
    type(el, 'a', '٣٣٫٧٥٥');
    expect(host.amount.value).toBe(33.75);
    type(el, 'a', '8');
    expect(host.amount.value).toBe(8);
    type(el, 'a', '');
    expect(host.amount.value).toBeNull();
  });

  it('clamps to min and max when the field loses focus, and an integer field drops decimals', () => {
    const { fixture, host, el } = setup();
    type(el, 'a', '250');
    input(el, 'a').dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    expect(host.amount.value).toBe(100);
    expect(input(el, 'a').value).toBe('100');
    type(el, 'b', '4.9');
    expect(host.qty.value).toBe(4);
    type(el, 'b', '0');
    input(el, 'b').dispatchEvent(new Event('blur'));
    expect(host.qty.value).toBe(1);
  });
});
