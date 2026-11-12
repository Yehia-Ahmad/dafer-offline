import { Injectable } from '@angular/core';

// Stage 23: Alexandria for the prints. The two woff2 files (Arabic + Latin subsets, weights 100-900) ship with
// the app under assets/fonts/alexandria/ (angular.json); a print is a separate page that must never load fonts
// from the network, so they are read once and embedded in each print's HTML as data: URIs.

const FILES = [
  {
    file: 'assets/fonts/alexandria/alexandria-arabic-wght-normal.woff2',
    range: 'U+0600-06FF, U+0750-077F, U+0870-088E, U+0890-0891, U+0897-08E1, U+08E3-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FE74, U+FE76-FEFC',
  },
  {
    file: 'assets/fonts/alexandria/alexandria-latin-wght-normal.woff2',
    range: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
  },
] as const;

/** `@font-face` rules with the font files embedded, for use in a print document. */
export function fontFaceCss(encoded: Array<{ base64: string; range: string }>): string {
  return encoded
    .map(({ base64, range }) => `@font-face { font-family: 'Alexandria'; font-style: normal; font-weight: 100 900; font-display: block; src: url(data:font/woff2;base64,${base64}) format('woff2'); unicode-range: ${range}; }`)
    .join('\n');
}

/**
 * XMLHttpRequest, not fetch(): in the desktop app the UI is a file:// page, where Chromium refuses fetch() of file:// URLs but allows
 * XHR to the app's own assets (the same way the translation files are read).
 */
function readBytes(url: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', url);
    request.responseType = 'arraybuffer';
    request.onload = () => (request.status === 0 || (request.status >= 200 && request.status < 300) ? resolve(request.response as ArrayBuffer) : reject(new Error(`font ${request.status}`)));
    request.onerror = () => reject(new Error('font read failed'));
    request.send();
  });
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

@Injectable({ providedIn: 'root' })
export class PrintFontService {
  private cached: Promise<string> | null = null;

  /** The embedded font CSS. A font that cannot be read is skipped (the print falls back to Tahoma / system fonts). */
  css(): Promise<string> {
    if (!this.cached) {
      this.cached = this.load().then((css) => {
        if (!css) this.cached = null; // retry next time (e.g. the first print happened before the assets were ready)
        return css;
      });
    }
    return this.cached;
  }

  private async load(): Promise<string> {
    const encoded: Array<{ base64: string; range: string }> = [];
    for (const entry of FILES) {
      try {
        const bytes = await readBytes(new URL(entry.file, document.baseURI).href);
        if (bytes.byteLength > 1000) encoded.push({ base64: toBase64(bytes), range: entry.range });
      } catch {
        // offline fallback stack
      }
    }
    return fontFaceCss(encoded);
  }
}
