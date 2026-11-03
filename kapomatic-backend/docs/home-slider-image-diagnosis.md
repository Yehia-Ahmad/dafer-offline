# Home slider image diagnosis and verification

Repository fix verified locally on 2026-09-12 (Africa/Cairo). Production deployment is pending; the public storefront still serves the old failing URLs.

## Confirmed cause

The optimized public Home response points WebsiteImage assets at the storefront origin, `https://kapomatic.com`, whose `/api/website-images/:id/image` requests return Cloudflare 502. The same records served through `https://api.kapomatic.com` return 200 and valid JPEG bytes. All six images reproduce this origin-dependent difference. The backend image service is reachable through the API domain.

The previous backend URL helper could derive the public image origin from the request host or fall back to the website origin. The Home endpoint used this helper, whereas active-with-products returned a relative URL. The frontend normalized relative `/api/` URLs but preserved absolute storefront WebsiteImage URLs, which made the optimized Home response reach the failing storefront route.

Without production configuration/log access, it is not possible to distinguish whether the deployed bad origin comes from PUBLIC_API_ORIGIN, forwarded/request Host, or the former localhost-to-website fallback, or identify the exact Nginx/SSR upstream failure behind that route. No evidence supports changing Cloudflare settings, proxy timeouts, or buffering.

## Exact URL trace

The actual Home contract uses `settings.slides[].desktopImage` and `mobileImage`; it does not contain a literal `slide.imageUrl` property.

For slide `6a3ec0fdf89d31fbfaa73791`, captured from the live API and hydrated `/en`:

| Stage | Value before fix |
| --- | --- |
| Raw Home desktopImage/mobileImage | `https://kapomatic.com/api/website-images/6a3ec0fdf89d31fbfaa73791/image` |
| Frontend desktopImageUrl/mobileImageUrl | Same absolute storefront URL, preserved by the previous normalizer |
| Browser img src/currentSrc | `https://kapomatic.com/api/website-images/6a3ec0fdf89d31fbfaa73791/image` |
| active-with-products imageUrl | `/api/website-images/6a3ec0fdf89d31fbfaa73791/image` |

After the frontend fix, the captured live Home response normalizes to `https://api.kapomatic.com/api/website-images/6a3ec0fdf89d31fbfaa73791/image`. Both local SSR HTML and hydrated `img.src`/`currentSrc` contain that identical URL. The backend fix makes both public contracts use this canonical URL directly when PUBLIC_API_ORIGIN is correctly configured.

Representative failing curl response, 2026-09-11 22:50:11 UTC:

```http
HTTP/2 502
content-type: text/plain; charset=UTF-8
content-length: 16
server: cloudflare
cache-control: private, max-age=0, no-store, no-cache, must-revalidate, post-check=0, pre-check=0
cf-ray: a39a3addc9c9078b-MRS
```

The browser received the Cloudflare HTML error representation (`text/html; charset=UTF-8`, 6401 bytes), status 502, with image naturalWidth 0. The same asset through the backend domain returned:

```http
HTTP/2 200
content-type: image/jpeg
content-length: 94030
server: cloudflare
x-powered-by: Express
access-control-allow-origin: *
cache-control: public, max-age=3600
etag: W/"16f4e-WjtUzIFyw25TEtLjpFhhU15txFQ"
cf-cache-status: DYNAMIC
```

`file` identified a 1041 × 1041 JPEG; Chrome decoded it with naturalWidth 1041.

## Every slide request

The old URL is `https://kapomatic.com/api/website-images/<id>/image`. The verified canonical URL is `https://api.kapomatic.com/api/website-images/<id>/image`.

| WebsiteImage ID | Old storefront URL | Canonical API URL | Content-Type | Bytes |
| --- | --- | --- | --- | --- |
| `6a3ec0fdf89d31fbfaa73791` | 502 | [200](https://api.kapomatic.com/api/website-images/6a3ec0fdf89d31fbfaa73791/image) | image/jpeg | 94030 |
| `6a3ebf5ef89d31fbfaa73775` | 502 | [200](https://api.kapomatic.com/api/website-images/6a3ebf5ef89d31fbfaa73775/image) | image/jpeg | 103122 |
| `6a3eb93bf89d31fbfaa73766` | 502 | [200](https://api.kapomatic.com/api/website-images/6a3eb93bf89d31fbfaa73766/image) | image/jpeg | 645702 |
| `6a3eb8a1f89d31fbfaa73763` | 502 | [200](https://api.kapomatic.com/api/website-images/6a3eb8a1f89d31fbfaa73763/image) | image/jpeg | 295953 |
| `6a3eb863f89d31fbfaa73760` | 502 | [200](https://api.kapomatic.com/api/website-images/6a3eb863f89d31fbfaa73760/image) | image/jpeg | 106457 |
| `6a3eb838f89d31fbfaa7375d` | 502 | [200](https://api.kapomatic.com/api/website-images/6a3eb838f89d31fbfaa7375d/image) | image/jpeg | 343196 |

All canonical responses contain JPEG binaries, verified with `file` and actual browser decoding. Their dimensions, in table order, are 1041×1041, 1064×1064, 1080×1080, 1280×1280, 1280×1059, and 940×788.

## Changes

Backend paths:

- `.env.example`: documents `PUBLIC_API_ORIGIN=https://api.kapomatic.com`.
- `src/utils/seo.js`: canonical configured API origin, independent of request host; strips `/api` supplied in origin configuration by using URL.origin; excludes loopback origins; shared WebsiteImage URL helper.
- `src/controllers/publicPage.controller.js`: generates slide URLs with the shared helper.
- `src/controllers/websiteImage.controller.js`: same canonical URL for active-with-products; image endpoint selects an active record, returns binary bytes with exact length, existing one-hour public caching, and controlled missing/invalid data errors.
- `src/utils/decodeImage.js`: validates Base64, handles data URLs/raw values, detects JPEG/PNG/WebP/GIF/AVIF MIME signatures, and rejects malformed input or MIME mismatches without embedding image data in errors.
- `src/middlewares/error.middleware.js`: delegates errors after headers have already been sent.
- `test/website-image-asset.test.js`: route-level binary/HEAD/error/recovery tests, large input, canonical contract consistency, and headers-sent handling.
- `test/public-optimizations.test.js`, `test/public-home-categories.test.js`: align URL assertions with the shared canonical API origin.

Frontend paths (existing staged work was preserved):

- `src/app/core/security/public-url.utils.ts`: normalizes legacy absolute WebsiteImage URLs and relative API URLs through the configured API base exactly once.
- `src/app/features/home/components/home-offer-carousel.component.ts` and `.html`: hide only a failed image over the existing neutral background; keep controls and other slides usable; log each failed URL only once in development.
- `src/app/features/home/components/home-offer-carousel.component.spec.ts`: direct URL/alt binding, fallback, navigation, and replacement-image tests.
- `src/app/domains/home/home.normalizer.spec.ts`: relative, canonical absolute, legacy storefront absolute, idempotence, and alt-text tests.

No Base64 was added to Home JSON. Slider layout/styles and unrelated Home sections were not changed. No Nginx, Cloudflare, PM2, timeout, or buffering changes were made.

## Verification performed

- `npm test --prefix kapomatic-backend`: **59 passed**, including valid JPEG/PNG data URLs, raw Base64, missing/invalid records, Content-Type/Length, binary equality, HEAD, and successful requests after failures on the same HTTP server. Database access is mocked in these tests.
- `CHROME_BIN=/tmp/kap-chrome-test npm run test:ci --prefix kapomatic-website-frontend`: **148 passed** in Chrome Headless.
- `npm run build:ssr --prefix kapomatic-website-frontend`: **passed**, production build.
- `npm run lint --prefix kapomatic-website-frontend`: **passed**.
- Production build served locally on port 4310, using the real public production API. Both `/ar` and `/en` SSR HTML contain the six canonical image URLs. Both hydrated pages display all six images: 200, image/jpeg, naturalWidth > 0, no image hidden, six image requests / six unique URLs per page.
- Mobile Arabic at 390px: all six images decode successfully, one request per URL; carousel navigation works.
- Deliberately blocked the first image in a separate browser test: only that image is hidden, the other five load, navigation advances to the second slide. This controlled test is separate from the successful all-images checks.
- Exact failing URL tested with `curl -I` and `curl -v ... -o /tmp/slide-image`. All twelve old/canonical URLs tested with response headers and downloaded bytes.
- `http://127.0.0.1:5000/api/website-images/6a3ec0fdf89d31fbfaa73791/image`: connection refused on this workstation; there is no backend listening on port 5000 here. This does not test the production host's loopback interface.

## Production work still required

Production SSH/deployment access has been requested but is not available in this session. This workstation has no `/etc/nginx`, `/var/log/nginx`, or PM2 logs. Therefore production upstream ports, Nginx routing, process restart counts, and origin-only connectivity remain unverified. Successful repeated API-domain image requests establish reachability during testing, not proof of PM2 uptime.

Deploy the reviewed backend/frontend changes with backend `PUBLIC_API_ORIGIN=https://api.kapomatic.com` and frontend SSR/browser API base `https://api.kapomatic.com/api`. An existing PUBLIC_API_ORIGIN explicitly set to the storefront must be corrected; editing `.env.example` alone does not change a running process. Verify both public API contracts after deployment and their existing 60-second response caches expire. Then repeat all image requests and browser checks on public `/ar` and `/en`.

On the production host, correlate Nginx error logs and PM2 logs with 2026-09-11 22:50:11 UTC (and Cloudflare ray above), inspect the effective Nginx server/location blocks and actual listening ports, and test the image directly against the backend. If same-origin `/api` routing is retained, its upstream must be the backend, not the Angular SSR process. Do not alter timeout/buffering settings without supporting logs.
