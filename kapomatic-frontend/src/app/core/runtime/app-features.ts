import { environment } from '../../../environments/environment';
import { getDesktopRuntimeConfig } from './runtime-config';

/**
 * Website-related features: e-commerce settings, website images, website orders,
 * SEO fields and WhatsApp links. Off in the offline (LAN) desktop edition.
 */
export function isWebsiteEnabled(): boolean {
  return environment.features.website;
}

/** True on the offline edition's main PC, the only place backup and restore are offered. */
export function isOfflineMainPc(): boolean {
  return environment.offline && getDesktopRuntimeConfig()?.role === 'main';
}
