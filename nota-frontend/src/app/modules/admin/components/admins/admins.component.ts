import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component } from '@angular/core';
import { SideNavComponent } from "../../../layout/components/side-nav/side-nav.component";
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { AdminsService } from '../../services/admins.service';
import { TranslatePipe } from '@ngx-translate/core';
import { ThemeService } from '../../../shared/services/theme.service';
import { ErrorIconComponent } from "../../../assets/error/error-icon.component";

@Component({
  selector: 'app-admins',
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule, TableModule, SelectModule, ButtonModule, DialogModule, SideNavComponent, TranslatePipe, ErrorIconComponent],
  templateUrl: './admins.component.html',
  styleUrl: './admins.component.scss'
})
export class AdminsComponent {
  isLoading: boolean = false;
  admins: any[] = [];
  selectedUser: any;
  visible: boolean = false;
  deleteVisible: boolean = false;
  mode: string = 'add';
  changeForm: FormGroup;
  roles: any[] = [
    {
      name: 'Admin',
      value: 'admin'
    },
    {
      name: 'Customer',
      value: 'customer'
    }
  ];
  pages = [1, 2, 3, 4, '...', 10];
  currentPage = 1;
  isDarkMode$;
  errorVisible = false;
  errorMessage = '';

  constructor(private _themeService: ThemeService, private fb: FormBuilder, private _adminsService: AdminsService, private cdr: ChangeDetectorRef) {
    this.isDarkMode$ = this._themeService.isDarkMode$;
    this.initializeChangeForm();
  }

  ngOnInit() {
    setTimeout(() => {
      this.getAllUsers();
    }, 100);
  }

  getAllUsers(params?: any) {
    this._adminsService.getAllUsers(params).subscribe({
      next: (res: any) => {
        this.admins = res.data.users;
        this.cdr.detectChanges();
      }, error: (err: any) => {
        this.errorVisible = true;
        this.errorMessage = err.error.message;
        this.cdr.detectChanges();
      }
    });
  }

  initializeChangeForm() {
    this.changeForm = this.fb.group({
      username: [null],
      email: [null],
      phone: [null],
      password: [null],
      role: [null],
    });
  }

  userHandler() {
    if (this.mode === 'add') {
      this.addUser();
    } else {
      this.updateUser();
    }
  }

  addUser() {
    this.isLoading = true;
    this.changeForm.value.role = this.changeForm.value.role.toLowerCase();
    this._adminsService.createUser(this.changeForm.value).subscribe({
      next: (res: any) => {
        this.isLoading = false;
        this.getAllUsers();
        this.visible = false;
      }, error: (err: any) => {
        this.isLoading = false;
        this.errorVisible = true;
        this.errorMessage = err.error.message;
        this.cdr.detectChanges();
      }
    })
  }

  updateUser() {
    this.isLoading = true;
    this.changeForm.value.role = this.changeForm.value.role.toLowerCase();
    this._adminsService.updateUser(this.selectedUser._id, this.changeForm.value).subscribe({
      next: (res: any) => {
        this.isLoading = false;
        this.getAllUsers();
        this.visible = false;
        this.selectedUser = null;
      }, error: (err: any) => {
        this.isLoading = false;
        this.errorVisible = true;
        this.errorMessage = err.error.message;
        this.cdr.detectChanges();
      }
    })
  }

  deleteUser() {
    this.isLoading = true;
    this._adminsService.deleteUser(this.selectedUser._id).subscribe({
      next: (res: any) => {
        this.isLoading = false;
        this.getAllUsers();
        this.deleteVisible = false;
        this.selectedUser = null;
      }, error: (err: any) => {
        this.isLoading = false;
        this.errorVisible = true;
        this.errorMessage = err.error.message;
        this.cdr.detectChanges();
      }
    })
  }

  showDialog(mode: string, user?: any) {
    this.mode = mode;
    if(mode === 'change') {
      this.selectedUser = user;
      this.changeForm.patchValue(this.selectedUser);
      this.cdr.detectChanges();
    }
    this.visible = true;
  }

  showDeleteDialog(user: any) {
    this.selectedUser = user;
    this.deleteVisible = true;
  }

  closeDialog() {
    this.deleteVisible = false;
  }

  goToPage(page: number | string) {
    if (typeof page === 'number') {
      this.currentPage = page;
    }
  }
}
