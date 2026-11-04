import { AsyncPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { ThemeService } from '../shared/services/theme.service';
import { LanguageService } from '../shared/services/translation.service';
import {
  NotaButtonDirective,
  NotaCardComponent,
  NotaDialogShellComponent,
  NotaEmptyStateComponent,
  NotaFormFieldComponent,
  NotaKpiCardComponent,
  NotaMoneyPipe,
  NotaNumberPipe,
  NotaPageHeaderComponent,
  NotaPillVariant,
  NotaStatusPillComponent,
  formatNotaNumber,
} from '../shared/ui';
import { UI_KIT_COPY, UI_KIT_TOKENS } from './ui-kit.data';

/**
 * Design-system preview (/ui-kit). Not linked from the menu; static sample content
 * only, so it renders without the backend. Shows every token and building block.
 */
@Component({
  selector: 'app-ui-kit',
  imports: [
    AsyncPipe,
    ReactiveFormsModule,
    MatButtonModule,
    ButtonModule,
    DialogModule,
    InputNumberModule,
    InputTextModule,
    SelectModule,
    TableModule,
    NotaButtonDirective,
    NotaCardComponent,
    NotaDialogShellComponent,
    NotaEmptyStateComponent,
    NotaFormFieldComponent,
    NotaKpiCardComponent,
    NotaMoneyPipe,
    NotaNumberPipe,
    NotaPageHeaderComponent,
    NotaStatusPillComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './ui-kit.component.html',
  styleUrl: './ui-kit.component.scss',
})
export class UiKitComponent {
  private readonly theme = inject(ThemeService);
  private readonly language = inject(LanguageService);
  private readonly snackBar = inject(MatSnackBar);

  protected readonly isDark$ = this.theme.isDarkMode$;
  protected readonly lang = computed(() => (this.language.selectedLanguage() === 'ar' ? 'ar' : 'en'));
  protected readonly dir = computed(() => (this.lang() === 'ar' ? 'rtl' : 'ltr'));
  protected readonly t = computed(() => UI_KIT_COPY[this.lang()]);
  protected readonly tokens = UI_KIT_TOKENS;

  protected readonly pillVariants: NotaPillVariant[] = ['ok', 'due', 'overdue', 'info', 'neutral'];
  protected readonly pipeSamples = [0, 7, 1000, 1234.5, 2.345, 1250000.75, -320];

  protected readonly dialogOpen = signal(false);

  protected readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    phone: new FormControl('01286409921', { nonNullable: true }),
    limit: new FormControl<number | null>(5000),
    term: new FormControl<string | null>('30'),
    notes: new FormControl('', { nonNullable: true }),
  });

  constructor() {
    // Show the error state of the required field in the preview.
    this.form.controls.name.markAsTouched();
  }

  protected kpiValue(value: number): string {
    return formatNotaNumber(value, this.lang(), 'money');
  }

  protected toggleTheme(): void {
    this.theme.toggleTheme();
  }

  protected setLanguage(lang: 'ar' | 'en'): void {
    this.language.changeLanguage(lang);
  }

  protected showSnack(): void {
    this.snackBar.open(this.t().snack, this.t().ok, { duration: 3000, direction: this.dir() });
  }
}
