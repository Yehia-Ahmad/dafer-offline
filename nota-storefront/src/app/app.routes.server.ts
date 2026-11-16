import { RenderMode, ServerRoute } from '@angular/ssr';

// Public, indexable pages are rendered on the server. The pages that depend on the visitor's browser (cart, checkout, order tracking,
// sign-in, account) are client-rendered: they read localStorage, are noindex, and are disallowed in robots.txt.
export const serverRoutes: ServerRoute[] = [
  { path: 'cart', renderMode: RenderMode.Client },
  { path: 'checkout', renderMode: RenderMode.Client },
  { path: 'order/:token', renderMode: RenderMode.Client },
  { path: 'login', renderMode: RenderMode.Client },
  { path: 'register', renderMode: RenderMode.Client },
  { path: 'account', renderMode: RenderMode.Client },
  { path: 'account/**', renderMode: RenderMode.Client },
  { path: '**', renderMode: RenderMode.Server },
];
