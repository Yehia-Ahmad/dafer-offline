import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';

@Component({
  selector: 'app-add-admin-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule, SelectModule, ButtonModule, DialogModule],
  templateUrl: './add-admin-dialog.component.html',
  styleUrl: './add-admin-dialog.component.scss'
})
export class AddAdminDialog {
  visible: boolean = true;
  mode: string = 'add';
  changeForm: FormGroup;
  roles: any[] = [
    {
      name: 'Admin'
    },
    {
      name: 'Customer'
    }
  ];


  constructor(private fb: FormBuilder) {
    this.initializeChangeForm();
  }

  initializeChangeForm() {
    this.changeForm = this.fb.group({
      username: [null],
      email: [null],
      phone_number: [null],
      password: [null],
      role: [null],
    });
  }

  showDialog() {
    this.visible = true;
  }
}
