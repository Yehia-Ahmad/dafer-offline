import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MoonComponent } from './moon.component';

describe('Moon', () => {
  let component: MoonComponent;
  let fixture: ComponentFixture<MoonComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MoonComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(MoonComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
