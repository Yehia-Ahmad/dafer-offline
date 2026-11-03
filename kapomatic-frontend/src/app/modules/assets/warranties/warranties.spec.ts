import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Warranties } from './warranties';

describe('Warranties', () => {
  let component: Warranties;
  let fixture: ComponentFixture<Warranties>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Warranties]
    })
    .compileComponents();

    fixture = TestBed.createComponent(Warranties);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
