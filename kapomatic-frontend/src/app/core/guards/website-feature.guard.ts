import { inject } from '@angular/core';
import { CanMatchFn, Router } from '@angular/router';
import { isWebsiteEnabled } from '../runtime/app-features';

/** Keeps website-only screens unreachable when website features are off. */
export const websiteFeatureGuard: CanMatchFn = () =>
  isWebsiteEnabled() || inject(Router).createUrlTree(['/home']);
