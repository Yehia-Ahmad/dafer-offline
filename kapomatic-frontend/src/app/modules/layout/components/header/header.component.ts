import { CommonModule, Location } from '@angular/common';
import { Component, computed, EventEmitter, Output, signal } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { MenuOpen } from "../../../assets/menu-open/menu-open";
import { Mode } from "../../../assets/mode/mode";
import { SelectModule } from 'primeng/select';
import { FormsModule } from '@angular/forms';
import { LanguageService } from '../../../shared/services/translation.service';
import { MoonComponent } from "../../../assets/moon/moon.component";
import { ThemeService } from '../../../shared/services/theme.service';

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, ButtonModule, MenuOpen, Mode, MoonComponent],
  templateUrl: './header.component.html',
  styleUrl: './header.component.scss'
})
export class HeaderComponent {
  @Output() collapsedSidenav = new EventEmitter<boolean>();
  isDarkMode$;
  collapsed = signal(false);
  direction = computed(() => this._languageService.selectedLanguage() === 'ar' ? 'rtl' : 'ltr');
  i18n: any[] = [
    {
      name:'English',
      id:'en'
    },
    {
      name:'Arabic',
      id:'ar'
    }
  ];
  currentLang: string;

  constructor(private _languageService: LanguageService, private _themeService: ThemeService, private _location: Location) {
    this.currentLang = _languageService.selectedLanguage();
    this.isDarkMode$ = this._themeService.isDarkMode$

  }

  ngAfterViewInit() {
    queueMicrotask(() => this.toggleSidenav());
  }

  onLanguageChange(lang: string) {
    this._languageService.changeLanguage(lang);
    this.currentLang = lang;
  }

  toggleSidenav() {
    this.collapsed.set(!this.collapsed());
    this.collapsedSidenav.emit(this.collapsed());
  }

  toggleDarkMode() {
    this._themeService.toggleTheme();
  }

  goBack() {
    this._location.back();
  }

  get backButtonLabel() {
    return this.currentLang === 'ar' ? 'رجوع' : 'Back';
  }

}
