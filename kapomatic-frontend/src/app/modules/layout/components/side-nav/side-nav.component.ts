import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, computed, ElementRef, HostListener, ViewChild } from '@angular/core';
import { MatSidenavModule } from '@angular/material/sidenav';
import { HeaderComponent } from "../header/header.component";
import { CustomSidenavComponent } from "../../custom-sidenav/custom-sidenav.component";
import { ThemeService } from '../../../shared/services/theme.service';
import { AsyncPipe } from '@angular/common'; // to use async in template
import { LanguageService } from '../../../shared/services/translation.service';

@Component({
  selector: 'app-side-nav',
  standalone: true,
  imports: [CommonModule, MatSidenavModule, HeaderComponent, CustomSidenavComponent, AsyncPipe],
  templateUrl: './side-nav.component.html',
  styleUrl: './side-nav.component.scss'
})
export class SideNavComponent implements AfterViewInit {
  @ViewChild('headerRef', { read: ElementRef }) headerRef!: ElementRef;
  @ViewChild('customSidenav') customSidenav!: CustomSidenavComponent;

  isSidenavCollapsed = true;
  sidenavHeight = 'calc(100vh - 0px)';

  isDarkMode$;
  direction = computed(() => this._languageService.selectedLanguage() === 'ar' ? 'rtl' : 'ltr');

  sidenavWidth(): string {
    return this.isSidenavCollapsed ? '100px' : '250px';
  }

  constructor(private _themeService: ThemeService, private _languageService: LanguageService) {
    this.isDarkMode$ = this._themeService.isDarkMode$;
  }

  ngAfterViewInit() {
    queueMicrotask(() => this.updateSidenavHeight());
  }

  @HostListener('window:resize')
  onResize() {
    this.updateSidenavHeight();
  }

  private updateSidenavHeight() {
    if (this.headerRef?.nativeElement) {
      const headerHeight = this.headerRef.nativeElement.offsetHeight;
      this.sidenavHeight = `calc(100vh - ${headerHeight}px)`;
    }
  }

  toggleSidenav(event: boolean) {
    this.isSidenavCollapsed = event;
    this.customSidenav.isSidenavCollapsed = event;
  }
}
