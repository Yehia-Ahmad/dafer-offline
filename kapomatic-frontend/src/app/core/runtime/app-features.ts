import { environment } from '../../../environments/environment';
import { getDesktopRuntimeConfig } from './runtime-config';

/** True on the offline edition's main PC, the only place backup and restore are offered. */
export function isOfflineMainPc(): boolean {
  return environment.offline && getDesktopRuntimeConfig()?.role === 'main';
}
