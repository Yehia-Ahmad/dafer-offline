import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Mode } from './mode';

describe('Mode', () => {
  let component: Mode;
  let fixture: ComponentFixture<Mode>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Mode]
    })
    .compileComponents();

    fixture = TestBed.createComponent(Mode);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
