import { Routes } from '@angular/router';
import { categoryResolver, homeResolver, productResolver, searchResolver, zonesResolver } from './core/resolvers';

// Every page is a lazy route (the first load only carries the shell). The id in /p/:id/:slug and /c/:id/:slug is what the API looks up;
// a wrong slug is redirected with a real 301 by the server (src/server/slug-redirect.ts).
export const routes: Routes = [
  { path: '', loadComponent: () => import('./pages/home').then((m) => m.HomePage), resolve: { home: homeResolver } },
  { path: 'c/:id/:slug', loadComponent: () => import('./pages/listing').then((m) => m.ListingPage), resolve: { listing: categoryResolver }, runGuardsAndResolvers: 'paramsOrQueryParamsChange' },
  { path: 'c/:id', loadComponent: () => import('./pages/listing').then((m) => m.ListingPage), resolve: { listing: categoryResolver }, runGuardsAndResolvers: 'paramsOrQueryParamsChange' },
  { path: 'search', loadComponent: () => import('./pages/listing').then((m) => m.ListingPage), resolve: { listing: searchResolver }, runGuardsAndResolvers: 'paramsOrQueryParamsChange' },
  { path: 'p/:id/:slug', loadComponent: () => import('./pages/product').then((m) => m.ProductPage), resolve: { product: productResolver }, runGuardsAndResolvers: 'paramsChange' },
  { path: 'p/:id', loadComponent: () => import('./pages/product').then((m) => m.ProductPage), resolve: { product: productResolver }, runGuardsAndResolvers: 'paramsChange' },
  { path: 'cart', loadComponent: () => import('./pages/cart').then((m) => m.CartPage) },
  { path: 'checkout', loadComponent: () => import('./pages/checkout').then((m) => m.CheckoutPage) },
  { path: 'order/:token', loadComponent: () => import('./pages/order').then((m) => m.OrderPage) },
  { path: 'login', loadComponent: () => import('./pages/auth').then((m) => m.AuthPage), data: { mode: 'login' } },
  { path: 'register', loadComponent: () => import('./pages/auth').then((m) => m.AuthPage), data: { mode: 'register' } },
  {
    path: 'account',
    loadComponent: () => import('./pages/account').then((m) => m.AccountPage),
    children: [
      { path: '', loadComponent: () => import('./pages/account').then((m) => m.AccountOrdersPage) },
      { path: 'orders/:id', loadComponent: () => import('./pages/account').then((m) => m.AccountOrderPage) },
      { path: 'addresses', loadComponent: () => import('./pages/account').then((m) => m.AccountAddressesPage) },
      { path: 'profile', loadComponent: () => import('./pages/account').then((m) => m.AccountProfilePage) },
    ],
  },
  { path: 'policies/returns', loadComponent: () => import('./pages/policy').then((m) => m.PolicyPage), data: { kind: 'returns' } },
  { path: 'policies/terms', loadComponent: () => import('./pages/policy').then((m) => m.PolicyPage), data: { kind: 'terms' } },
  { path: 'delivery', loadComponent: () => import('./pages/policy').then((m) => m.DeliveryPage), resolve: { zones: zonesResolver } },
  { path: '**', loadComponent: () => import('./pages/policy').then((m) => m.NotFoundPage) },
];
