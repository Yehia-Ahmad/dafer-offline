import { ComponentFixture, TestBed } from '@angular/core/testing';

import { DeleteAdminDialog } from './delete-admin-dialog.component';

describe('DeleteAdminDialog', () => {
  let component: DeleteAdminDialog;
  let fixture: ComponentFixture<DeleteAdminDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DeleteAdminDialog]
    })
    .compileComponents();

    fixture = TestBed.createComponent(DeleteAdminDialog);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
