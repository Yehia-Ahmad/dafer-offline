// Test helper: puts a signed-in user (role template permissions) into AuthService without HTTP.
import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth.service';
import { AuthUser, RoleKey } from '../auth.models';
import { fakeUser } from './auth-fixtures';

export function signInAs(role: RoleKey, overrides: Partial<AuthUser> = {}): AuthService {
  const auth = TestBed.inject(AuthService);
  const user = fakeUser(role, overrides);
  auth.token.set(`test-token-${role}`);
  auth.user.set(user);
  auth.permissions.set(user.permissions);
  return auth;
}

/** Signed in with exactly these permissions (role custom). */
export function signInWith(permissions: string[]): AuthService {
  return signInAs('custom', { permissions });
}
