import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NotaPageHeaderComponent } from './page-header.component';

@Component({
  imports: [NotaPageHeaderComponent],
  template: `
    <nota-page-header id="full" title="Customers" subtitle="128 customers" backLink="/home" backLabel="Home">
      <button notaPageActions>Add</button>
    </nota-page-header>
    <nota-page-header id="minimal" title="Returns" />
  `,
})
class HostComponent {}

describe('NotaPageHeaderComponent', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [provideRouter([])] }));

  it('renders title, subtitle, back link and actions', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement.querySelector('#full');
    expect(el.classList).toContain('nota-page-header');
    expect(el.querySelector('h1.nota-page-header__title')?.textContent).toContain('Customers');
    expect(el.querySelector('.nota-page-header__subtitle')?.textContent).toContain('128 customers');
    const back = el.querySelector('a.nota-page-header__back') as HTMLAnchorElement;
    expect(back.getAttribute('href')).toBe('/home');
    expect(back.textContent).toContain('Home');
    expect(el.querySelector('.nota-page-header__actions button')?.textContent).toContain('Add');
  });

  it('omits the optional parts', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement.querySelector('#minimal');
    expect(el.querySelector('.nota-page-header__subtitle')).toBeNull();
    expect(el.querySelector('.nota-page-header__back')).toBeNull();
  });
});
