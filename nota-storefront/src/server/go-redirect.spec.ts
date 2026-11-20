import { ServerApi } from './api-client';
import { deviceOf, resolveGo, safeLocalPath } from './go-redirect';

const apiWith = (handler: (url: string, init?: RequestInit) => Promise<Response>): ServerApi => new ServerApi({ base: 'http://api.test', fetchImpl: handler as typeof fetch });
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('/go redirect', () => {
  it('asks the backend to count the click with a coarse device type and lands on the path it answers', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const api = apiWith(async (url, init) => { calls.push({ url, body: JSON.parse(String(init?.body)) }); return json({ path: '/p/abc?utm_source=facebook&utm_medium=paid&utm_campaign=camp123' }); });
    const path = await resolveGo('camp123', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148', api);
    expect(path).toBe('/p/abc?utm_source=facebook&utm_medium=paid&utm_campaign=camp123');
    expect(calls).toEqual([{ url: 'http://api.test/api/store/go/camp123', body: { device: 'mobile' } }]);
  });

  it('sends no IP and no user agent to the backend, only the device type', async () => {
    let seen = '';
    const api = apiWith(async (_url, init) => { seen = JSON.stringify(init); return json({ path: '/' }); });
    await resolveGo('camp123', 'Mozilla/5.0 secret-agent', api);
    expect(seen).not.toContain('secret-agent');
    expect(seen.toLowerCase()).not.toContain('x-forwarded');
  });

  it('an unknown or malformed code, or a backend failure, lands on the home page', async () => {
    const down = apiWith(async () => { throw new Error('network'); });
    expect(await resolveGo('camp123', '', down)).toBe('/');
    expect(await resolveGo('../etc', '', down)).toBe('/');
    expect(await resolveGo('a', '', down)).toBe('/');
    expect(await resolveGo('camp123', '', apiWith(async () => json({ path: '/' })))).toBe('/');
    expect(await resolveGo('camp123', '', apiWith(async () => json({}, 500)))).toBe('/');
  });

  it('a click is never retried (it would count twice)', async () => {
    let count = 0;
    const api = apiWith(async () => { count += 1; throw new Error('network'); });
    await resolveGo('camp123', '', api);
    expect(count).toBe(1);
  });

  it('never redirects off the site', () => {
    for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'evil', undefined, 5, '/a\nb']) expect(safeLocalPath(bad)).toBe('/');
    expect(safeLocalPath('/c/1?x=1')).toBe('/c/1?x=1');
  });

  it('classifies the device coarsely', () => {
    expect(deviceOf('Mozilla/5.0 (Linux; Android 13; Pixel) Mobile Safari')).toBe('mobile');
    expect(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
    expect(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('desktop');
    expect(deviceOf('curl/8')).toBe('other');
    expect(deviceOf(undefined)).toBe('other');
  });
});
