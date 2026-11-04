import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { mainPcGuard } from './core/guards/main-pc.guard';
import { HomeComponent } from './modules/layout/components/home/home.component';

export const routes: Routes = [
    { path: '', redirectTo: 'home', pathMatch: 'full' },
    {
        path: 'home',
        // canActivate: [authGuard],
        component: HomeComponent
    },
    {
        path: 'admins',
        // canActivate: [authGuard],
        loadComponent: () => import('./modules/admin/components/admins/admins.component').then(m => m.AdminsComponent)
    },
    {
        path: 'customers',
        // canActivate: [authGuard],
        loadComponent: () => import('./modules/customer/components/customers/customers.component').then(m => m.CustomersComponent)
    },
    {
        path: 'customers/:id',
        // canActivate: [authGuard],
        loadComponent: () => import('./modules/customer/components/customer-details/customer-details.component').then(m => m.CustomerDetailsComponent)
    },
    {
        path: 'selling',
        // canActivate: [authGuard],
        loadComponent: () => import('./modules/products/components/selling/selling.component').then(m => m.SellingComponent)
    },
    {
        // Stage 10: the credit invoice list; the create form moved to /credit-sales/new.
        path: 'credit-sales',
        // canActivate: [authGuard],
        loadComponent: () => import('./modules/products/components/credit-sales-list/credit-sales-list.component').then(m => m.CreditSalesListComponent)
    },
    {
        path: 'credit-sales/new',
        // canActivate: [authGuard],
        loadComponent: () => import('./modules/products/components/credit-sales/credit-sales.component').then(m => m.CreditSalesComponent)
    },
    {
        path: 'invoice-history',
        // canActivate: [authGuard],
        loadComponent: () => import('./modules/products/components/invoice-history/invoice-history.component').then(m => m.InvoiceHistoryComponent)
    },
    {
        path: 'returns',
        // canActivate: [authGuard],
        loadComponent: () => import('./modules/returns/components/returns/returns.component').then(m => m.ReturnsComponent)
    },
    {
        path: 'categories/:id',
        // canActivate: [authGuard],
        loadComponent: () => import('./modules/category/components/category-details/category-details.component').then(m => m.CategoryDetailsComponent)
    },
    {
        path: 'products/edit/:id',
        // canActivate: [authGuard],
        loadComponent: () => import('./modules/category/components/product-edit/product-edit.component').then(m => m.ProductEditComponent)
    },
    {
        path: 'products/profit-report',
        loadComponent: () => import('./modules/products/components/product-profit-report/product-profit-report.component').then(m => m.ProductProfitReportComponent)
    },
    {
        path: 'shop-profile',
        loadComponent: () => import('./modules/shop-profile/components/shop-profile/shop-profile.component').then(m => m.ShopProfileComponent)
    },
    {
        // Offline edition, main PC only.
        path: 'backup',
        canMatch: [mainPcGuard],
        loadComponent: () => import('./offline/backup-page.component').then(m => m.BackupPageComponent)
    },
    {
        // Design-system preview; not linked from the menu, static content only.
        path: 'ui-kit',
        data: { frame: false },
        loadComponent: () => import('./modules/ui-kit/ui-kit.component').then(m => m.UiKitComponent)
    },
    {
        path: '**',
        // canActivate: [authGuard],
        component: HomeComponent
    },
];
