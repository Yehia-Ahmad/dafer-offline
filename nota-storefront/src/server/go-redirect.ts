// Online Stage 7A: /go/<code>. The backend counts the click (campaign, local day, a coarse device type; no IP, no user agent stored) and
// says where to land. Whatever happens, the visitor is sent on: a broken counter must never break an ad.
import { ServerApi } from './api-client';

const CODE = /^[A-Za-z0-9_-]{3,40}$/;

export const deviceOf = (userAgent: string | undefined): 'mobile' | 'tablet' | 'desktop' | 'other' => {
  const ua = userAgent ?? '';
  if (/ipad|tablet|(android(?!.*mobile))/i.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android/i.test(ua)) return 'mobile';
  if (/windows|macintosh|linux|cros/i.test(ua)) return 'desktop';
  return 'other';
};

/** A same-site path only: one leading "/", never "//", a backslash or a control character (no open redirect). */
export const safeLocalPath = (value: unknown): string => {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  return value;
};

/** The path to redirect to (the home page for an unknown code, a malformed one or any upstream problem). */
export const resolveGo = async (code: string, userAgent: string | undefined, api: ServerApi): Promise<string> => {
  if (!CODE.test(code)) return '/';
  try {
    const answer = await api.post<{ path?: string }>(`/go/${encodeURIComponent(code)}`, { device: deviceOf(userAgent) });
    return safeLocalPath(answer.path);
  } catch {
    return '/';
  }
};
