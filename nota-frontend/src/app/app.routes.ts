import { inject } from '@angular/core';
import { Router, Routes } from '@angular/router';
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
        // Stage 11: old category links open the products page on that category.
        path: 'categories/:id',
        redirectTo: ({ params }) => inject(Router).createUrlTree(['/products'], { queryParams: { category: params['id'] } }),
    },
    {
        // Stage 11: products & categories (optional ?category=<id>).
        path: 'products',
        pathMatch: 'full',
        // canActivate: [authGuard],
        loadComponent: () => import('./modules/category/components/products-page/products-page.component').then(m => m.ProductsPageComponent)
    },
    {
        path: 'products/new',
        // canActivate: [authGuard],
        loadComponent: () => import('./modules/category/components/product-form/product-form.component').then(m => m.ProductFormComponent)
    },
    {
        path: 'products/edit/:id',
        // canActivate: [authGuard],
        loadComponent: () => import('./modules/category/components/product-form/product-form.component').then(m => m.ProductFormComponent)
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
