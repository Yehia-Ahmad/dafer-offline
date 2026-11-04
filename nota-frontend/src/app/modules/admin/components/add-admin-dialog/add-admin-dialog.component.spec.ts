import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import { AddAdminDialog } from './add-admin-dialog.component';

describe('AddAdminDialog', () => {
  let component: AddAdminDialog;
  let fixture: ComponentFixture<AddAdminDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AddAdminDialog],
      providers: [provideNoopAnimations()]
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
