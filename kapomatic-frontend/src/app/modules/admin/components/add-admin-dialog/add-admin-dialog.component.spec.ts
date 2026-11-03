import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AddAdminDialog } from './add-admin-dialog.component';

describe('AddAdminDialog', () => {
  let component: AddAdminDialog;
  let fixture: ComponentFixture<AddAdminDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AddAdminDialog]
    })
    .compileComponents();

    fixture = TestBed.createComponent(AddAdminDialog);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
