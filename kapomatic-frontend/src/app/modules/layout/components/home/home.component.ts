import { Component, Inject, OnInit, PLATFORM_ID } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { SideNavComponent } from "../side-nav/side-nav.component";
import { ThemeService } from '../../../shared/services/theme.service';
import { HeaderComponent } from "../header/header.component";
import { TranslatePipe } from '@ngx-translate/core';
import { ActivatedRoute, Router } from '@angular/router';
import { HOME_DEFAULT_VIEW, HOME_VIEW_STORAGE_KEY, HOME_VIEWS, HomeView } from '../../constants/home-view.constants';

@Component({
  selector: 'app-home',
  imports: [CommonModule, SideNavComponent, HeaderComponent, TranslatePipe],
  standalone: true,
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.scss']
})
export class HomeComponent implements OnInit {
  currentView: HomeView = HOME_DEFAULT_VIEW;
  isDarkMode$;
  private isBrowser: boolean;

  constructor(
    private _themeService: ThemeService,
    private _activatedRoute: ActivatedRoute,
    private _router: Router,
    @Inject(PLATFORM_ID) platformId: Object
  ) {
    this.isDarkMode$ = this._themeService.isDarkMode$;
    this.isBrowser = isPlatformBrowser(platformId);
  }

  ngOnInit(): void {
    this.restoreView();
    this.handleResetViewQueryParam();
  }

  openInventory(): void {
    this.setCurrentView('inventory');
  }

  openProducts(): void {
    this.setCurrentView('products');
  }

  openCustomers(): void {
    this._router.navigate(['/customers']);
  }

  openSelling(): void {
    this.setCurrentView('products');
    this._router.navigate(['/selling']);
  }

  openCreditSales(): void {
    this.setCurrentView('products');
    this._router.navigate(['/credit-sales']);
  }

  openInvoiceHistory(): void {
    this.setCurrentView('products');
    this._router.navigate(['/invoice-history']);
  }

  backToDashboard(): void {
    this.setCurrentView('dashboard');
  }

  backToProducts(): void {
    this.setCurrentView('products');
  }

  private setCurrentView(view: HomeView): void {
    this.currentView = view;
    if (!this.isBrowser) return;

    localStorage.setItem(HOME_VIEW_STORAGE_KEY, view);
  }

  private restoreView(): void {
    if (!this.isBrowser) return;

    const savedView = localStorage.getItem(HOME_VIEW_STORAGE_KEY);
    if (savedView && HOME_VIEWS.includes(savedView as HomeView)) {
      this.currentView = savedView as HomeView;
      return;
    }

    this.setCurrentView(HOME_DEFAULT_VIEW);
  }

  private handleResetViewQueryParam(): void {
    this._activatedRoute.queryParamMap.subscribe((params) => {
      if (!params.has('resetView')) return;

      this.setCurrentView(HOME_DEFAULT_VIEW);
      this._router.navigate([], {
        relativeTo: this._activatedRoute,
        queryParams: { resetView: null },
        queryParamsHandling: 'merge',
        replaceUrl: true
      });
    });
  }
}
