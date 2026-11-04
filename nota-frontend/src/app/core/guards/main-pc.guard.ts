import { inject } from '@angular/core';
import { CanMatchFn, Router } from '@angular/router';
import { isOfflineMainPc } from '../runtime/app-features';

/** Screens that only make sense on the offline edition's main PC (backup and restore). */
export const mainPcGuard: CanMatchFn = () => isOfflineMainPc() || inject(Router).createUrlTree(['/home']);
