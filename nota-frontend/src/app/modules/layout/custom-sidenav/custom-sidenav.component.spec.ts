import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';

import { CustomSidenavComponent } from './custom-sidenav.component';

describe('CustomSidenav', () => {
  let component: CustomSidenavComponent;
  let fixture: ComponentFixture<CustomSidenavComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CustomSidenavComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations()]
    })
    .compileComponents();

    fixture = TestBed.createComponent(CustomSidenavComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
