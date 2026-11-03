
import { CanActivateFn, Router } from '@angular/router';
import { inject } from '@angular/core'
import { DiskService } from '../../modules/shared/services/disk.service';

export const authGuard: CanActivateFn = (route, state) => {
  const router = inject(Router);
  const _diskService = inject(DiskService);
  const access_token = _diskService.accessToken;

  if (access_token) {
    // User is logged in
    if (route.url[0].path === 'login') {
      router.navigate(['/home']);
      return false; // Prevent further processing
    }
    return true;
  } else {
    // User is not logged in
    if (route.url[0].path !== 'login') {
      router.navigate(['/login']);
    }
    return false;
  }
};
