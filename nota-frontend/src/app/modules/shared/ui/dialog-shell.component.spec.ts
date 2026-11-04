import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NotaDialogShellComponent } from './dialog-shell.component';

@Component({
  imports: [NotaDialogShellComponent],
  template: `
    <nota-dialog-shell id="full" title="New customer" closeLabel="Close dialog" (closed)="closedCount = closedCount + 1">
      <p>Fields</p>
      <ng-container notaDialogFooter><button id="save">Save</button></ng-container>
    </nota-dialog-shell>
    <nota-dialog-shell id="nofooter" title="Info"><p>Text</p></nota-dialog-shell>
  `,
})
class HostComponent {
  closedCount = 0;
}

describe('NotaDialogShellComponent', () => {
  it('renders header title, body and footer actions', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement.querySelector('#full');
    expect(el.classList).toContain('nota-dialog');
    expect(el.querySelector('.nota-dialog__title')?.textContent).toContain('New customer');
    expect(el.querySelector('.nota-dialog__body')?.textContent).toContain('Fields');
    expect(el.querySelector('.nota-dialog__footer #save')).toBeTruthy();
  });

  it('emits closed from the × button', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const close = fixture.nativeElement.querySelector('#full .nota-dialog__header button') as HTMLButtonElement;
    expect(close.getAttribute('aria-label')).toBe('Close dialog');
    close.click();
    expect(fixture.componentInstance.closedCount).toBe(1);
  });

  it('leaves the footer empty (hidden) when nothing is projected into it', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const footer = fixture.nativeElement.querySelector('#nofooter .nota-dialog__footer') as HTMLElement;
    expect(footer.childElementCount).toBe(0);
    expect(getComputedStyle(footer).display).toBe('none');
  });
});
