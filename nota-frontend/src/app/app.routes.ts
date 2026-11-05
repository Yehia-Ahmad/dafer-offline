import { inject } from '@angular/core';
import { Router, Routes } from '@angular/router';
import { mainPcGuard } from './core/guards/main-pc.guard';
import { authGuard, guestGuard, landingRedirect, permissionGuard } from './core/auth/auth.guards';
import { ROUTE_RULES } from './core/auth/route-permissions';
import { HomeComponent } from './modules/layout/components/home/home.component';

// Stage 14: every page needs a signed-in user and its permission (core/auth/route-permissions.ts).
// The backend checks every request as well; these guards only keep the user out of pages they
// cannot use.
export const routes: Routes = [
    { path: '', pathMatch: 'full', redirectTo: landingRedirect },
    {
        path: 'login',
        data: { frame: false },
        canActivate: [guestGuard],
        loadComponent: () => import('./modules/auth/login-page/login-page.component').then(m => m.LoginPageComponent)
    },
    {
        // A signed-in user who may open no page at all (custom role with an empty list).
        path: 'no-access',
        data: { frame: false },
        canActivate: [authGuard],
        loadComponent: () => import('./modules/auth/no-access/no-access.component').then(m => m.NoAccessComponent)
    },
    {
        path: 'home',
        canActivate: [permissionGuard(ROUTE_RULES.home)],
        component: HomeComponent
    },
    {
        path: 'customers',
        canActivate: [permissionGuard(ROUTE_RULES.customers)],
        loadComponent: () => import('./modules/customer/components/customers/customers.component').then(m => m.CustomersComponent)
    },
    {
        path: 'customers/:id',
        canActivate: [permissionGuard(ROUTE_RULES.customers)],
        loadComponent: () => import('./modules/customer/components/customer-details/customer-details.component').then(m => m.CustomerDetailsComponent)
    },
    {
        path: 'selling',
        canActivate: [permissionGuard(ROUTE_RULES.selling)],
        loadComponent: () => import('./modules/products/components/selling/selling.component').then(m => m.SellingComponent)
    },
    {
        // Stage 10: the credit invoice list; the create form moved to /credit-sales/new.
        path: 'credit-sales',
        canActivate: [permissionGuard(ROUTE_RULES.creditSales)],
        loadComponent: () => import('./modules/products/components/credit-sales-list/credit-sales-list.component').then(m => m.CreditSalesListComponent)
    },
    {
        path: 'credit-sales/new',
        canActivate: [permissionGuard(ROUTE_RULES.creditSaleNew)],
        loadComponent: () => import('./modules/products/components/credit-sales/credit-sales.component').then(m => m.CreditSalesComponent)
    },
    {
        path: 'invoice-history',
        canActivate: [permissionGuard(ROUTE_RULES.invoiceHistory)],
        loadComponent: () => import('./modules/products/components/invoice-history/invoice-history.component').then(m => m.InvoiceHistoryComponent)
    },
    {
        path: 'returns',
        canActivate: [permissionGuard(ROUTE_RULES.returns)],
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
        canActivate: [permissionGuard(ROUTE_RULES.products)],
        loadComponent: () => import('./modules/category/components/products-page/products-page.component').then(m => m.ProductsPageComponent)
    },
    {
        path: 'products/new',
        canActivate: [permissionGuard(ROUTE_RULES.productNew)],
        loadComponent: () => import('./modules/category/components/product-form/product-form.component').then(m => m.ProductFormComponent)
    },
    {
        path: 'products/edit/:id',
        canActivate: [permissionGuard(ROUTE_RULES.productForm)],
        loadComponent: () => import('./modules/category/components/product-form/product-form.component').then(m => m.ProductFormComponent)
    },
    {
        path: 'products/profit-report',
        canActivate: [permissionGuard(ROUTE_RULES.profitReport)],
        loadComponent: () => import('./modules/products/components/product-profit-report/product-profit-report.component').then(m => m.ProductProfitReportComponent)
    },
    {
        path: 'shop-profile',
        canActivate: [permissionGuard(ROUTE_RULES.shopProfile)],
        loadComponent: () => import('./modules/shop-profile/components/shop-profile/shop-profile.component').then(m => m.ShopProfileComponent)
    },
    {
        path: 'users',
        canActivate: [permissionGuard(ROUTE_RULES.users)],
        loadComponent: () => import('./modules/users/users-page/users-page.component').then(m => m.UsersPageComponent)
    },
    {
        path: 'audit',
        canActivate: [permissionGuard(ROUTE_RULES.audit)],
        loadComponent: () => import('./modules/audit/audit-page/audit-page.component').then(m => m.AuditPageComponent)
    },
    {
        // Offline edition, main PC only, and backup.manage.
        path: 'backup',
        canMatch: [mainPcGuard],
        canActivate: [permissionGuard(ROUTE_RULES.backup)],
        loadComponent: () => import('./offline/backup-page.component').then(m => m.BackupPageComponent)
    },
    {
        // Design-system preview; not linked from the menu, static content only.
        path: 'ui-kit',
        data: { frame: false },
        canActivate: [authGuard],
        loadComponent: () => import('./modules/ui-kit/ui-kit.component').then(m => m.UiKitComponent)
    },
    { path: '**', redirectTo: landingRedirect },
];
