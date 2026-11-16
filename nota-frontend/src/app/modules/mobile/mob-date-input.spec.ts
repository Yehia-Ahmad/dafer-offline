import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { MobDateInputComponent, fromNativeValue, toNativeValue } from './mob-date-input.component';

describe('native date conversion (Online Stage 6B)', () => {
  it('writes a Date as local yyyy-MM-dd without a UTC shift', () => {
    expect(toNativeValue(new Date(2026, 10, 16, 0, 5), 'date')).toBe('2026-11-16');
    expect(toNativeValue(new Date(2026, 0, 1), 'month')).toBe('2026-01');
    expect(toNativeValue(new Date(2026, 10, 16, 9, 30), 'datetime-local')).toBe('2026-11-16T09:30');
    expect(toNativeValue('2026-03-05', 'date')).toBe('2026-03-05');
    expect(toNativeValue(null, 'date')).toBe('');
    expect(toNativeValue('garbage', 'date')).toBe('');
  });
  it('reads the input text back as a local Date', () => {
    expect(fromNativeValue('2026-11-16', 'date')?.getTime()).toBe(new Date(2026, 10, 16).getTime());
    expect(fromNativeValue('2026-11', 'month')?.getDate()).toBe(1);
    expect(fromNativeValue('2026-11-16T09:30', 'datetime-local')?.getHours()).toBe(9);
    expect(fromNativeValue('', 'date')).toBeNull();
  });
});

@Component({
  imports: [MobDateInputComponent, ReactiveFormsModule, FormsModule],
  template: `
    <nota-mob-date id="a" [formControl]="dateControl" />
    <nota-mob-date id="b" [formControl]="textControl" />
  `,
})
class HostComponent {
  dateControl = new FormControl<Date | null>(new Date(2026, 10, 4));
  textControl = new FormControl<string | null>('2026-11-04');
}

describe('MobDateInputComponent (Online Stage 6B)', () => {
  const setup = () => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return { fixture, host: fixture.componentInstance, el: fixture.nativeElement as HTMLElement };
  };
  const type = (el: HTMLElement, id: string, value: string) => {
    const input = el.querySelector<HTMLInputElement>(`#${id} input`)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };

  it('shows the control value and a Date control gets a Date back', () => {
    const { fixture, host, el } = setup();
    expect(el.querySelector<HTMLInputElement>('#a input')!.value).toBe('2026-11-04');
    type(el, 'a', '2026-12-25');
    fixture.detectChanges();
    expect(host.dateControl.value instanceof Date).toBeTrue();
    expect(host.dateControl.value!.getTime()).toBe(new Date(2026, 11, 25).getTime());
  });

  it('a control that holds a yyyy-MM-dd string gets a string back, and clearing gives null', () => {
    const { host, el } = setup();
    type(el, 'b', '2026-12-25');
    expect(host.textControl.value).toBe('2026-12-25');
    type(el, 'b', '');
    expect(host.textControl.value).toBeNull();
  });
});
