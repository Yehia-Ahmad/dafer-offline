import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MenuOpen } from './menu-open';

describe('MenuOpen', () => {
  let component: MenuOpen;
  let fixture: ComponentFixture<MenuOpen>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MenuOpen]
    })
    .compileComponents();

    fixture = TestBed.createComponent(MenuOpen);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
