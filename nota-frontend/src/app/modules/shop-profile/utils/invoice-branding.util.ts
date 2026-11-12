/** A shop logo as an <img> source: the backend accepts raw base64 as well as data URIs. (The printed header itself is core/print/print-kit.ts.) */
export function toImageSrc(logo: string | null | undefined): string {
  const value = typeof logo === 'string' ? logo.trim() : '';
  if (!value) return '';
  return value.startsWith('data:image/') ? value : `data:image/png;base64,${value}`;
}
