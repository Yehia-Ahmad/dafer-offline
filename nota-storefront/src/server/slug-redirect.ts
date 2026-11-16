import { storeSlug } from '../app/core/slug';
import { ServerApi, UpstreamError } from './api-client';

const ID = /^[0-9a-f]{24}$/;

/**
 * For /p/:id/:slug and /c/:id/:slug (or the same without a slug): the path the request should be 301-redirected to, or null when the
 * URL is already right, is not one of these pages, or the entity does not exist / the API is down (then Angular renders the 404 or
 * the error page). Products carry their slug in the API; categories do not, so theirs is built from the name.
 */
export const slugRedirectFor = async (pathname: string, search: string, api: ServerApi): Promise<string | null> => {
  const match = /^\/(p|c)\/([^/]+)(?:\/([^/]*))?\/?$/.exec(pathname);
  if (!match) return null;
  const [, kind, id, rawSlug] = match;
  if (!ID.test(id)) return null;
  let requested = rawSlug ?? '';
  try { requested = decodeURIComponent(requested); } catch { /* keep as is */ }
  try {
    let correct: string;
    if (kind === 'p') {
      correct = (await api.get<{ slug: string }>(`/products/${id}`, 15)).slug;
    } else {
      const categories = (await api.get<{ data: { id: string; name: string }[] }>('/categories', 30)).data;
      const category = categories.find((c) => c.id === id);
      if (!category) return null;
      correct = storeSlug(category.name);
    }
    if (requested === correct) return null;
    return `/${kind}/${id}/${encodeURIComponent(correct)}${search}`;
  } catch (error) {
    if (error instanceof UpstreamError) return null;
    throw error;
  }
};
