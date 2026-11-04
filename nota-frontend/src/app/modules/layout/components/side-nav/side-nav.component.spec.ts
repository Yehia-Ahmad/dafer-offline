import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';

import { SideNavComponent } from './side-nav.component';

describe('SideNavComponent (app frame)', () => {
  let component: SideNavComponent;
  let fixture: ComponentFixture<SideNavComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SideNavComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations()]
    })
    .compileComponents();

    fixture = TestBed.createComponent(SideNavComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders the sidebar, top bar and page container', () => {
    const el = fixture.nativeElement as HTMLElement;
    expect(component).toBeTruthy();
    expect(el.querySelector('app-custom-sidenav')).not.toBeNull();
    expect(el.querySelector('.nota-shell__back')).not.toBeNull();
    expect(el.querySelector('.nota-shell__content')).not.toBeNull();
  });
});
