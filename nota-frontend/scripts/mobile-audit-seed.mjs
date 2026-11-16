// Dev script (not part of the build): puts a small data set into a LOCAL, throwaway backend through its public API,
// so scripts/mobile-audit.mjs has real ids for every detail route. Best effort: a step that fails is reported and skipped.
// Usage: AUDIT_API=http://localhost:5000 AUDIT_USER=owner AUDIT_PASS=... node scripts/mobile-audit-seed.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const API = (process.env.AUDIT_API || 'http://localhost:5000').replace(/\/$/, '');
const USER = process.env.AUDIT_USER || 'owner';
const PASS = process.env.AUDIT_PASS || '';
const OUT = path.resolve('mobile-audit');
const DEVICE = { 'X-Nota-Device-Id': 'mobile-audit-device', 'X-Nota-Device-Name': encodeURIComponent('mobile-audit') };

let token = '';
const ids = {};
const notes = [];

async function call(method, url, body) {
  const response = await fetch(`${API}/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...DEVICE, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function step(name, fn) {
  try { await fn(); console.log(`ok    ${name}`); }
  catch (error) { notes.push(`${name}: ${error.message}`); console.log(`skip  ${name}: ${error.message}`); }
}

const today = new Date().toISOString().slice(0, 10);
const list = (data) => (Array.isArray(data) ? data : data?.items ?? data?.data ?? data?.results ?? Object.values(data ?? {}).find(Array.isArray) ?? []);
const idOf = (row) => row?._id ?? row?.id;

const login = await call('POST', '/auth/login', { username: USER, password: PASS });
token = login.token;
console.log('signed in as', login.user?.username);

await step('category', async () => { const c = await call('POST', '/categories', { name: 'فئة تجريبية' }); ids.category = idOf(c); });
await step('product', async () => {
  const p = await call('POST', '/products', { name: 'منتج تجريبي', code: 'AUD-1', inventoryCount: 50, categoryId: ids.category, wholesalePrice: 8, purchasePrice: 5, retailPrice: 10 });
  ids.product = idOf(p);
});
await step('customer', async () => { const c = await call('POST', '/customers', { name: 'عميل تجريبي', phone: '01000000001' }); ids.customer = idOf(c); });
await step('supplier', async () => { const s = await call('POST', '/suppliers', { name: 'مورد تجريبي', phone: '01000000002' }); ids.supplier = idOf(s); });
await step('cash sale', async () => {
  const s = await call('POST', '/sellings', { customerName: 'عميل تجريبي', customerPhone: '01000000001', sellingDate: today, items: [{ productId: ids.product, quantity: 2, price: 10 }] });
  ids.selling = idOf(s?.selling ?? s);
});
await step('credit sale', async () => {
  const s = await call('POST', '/credit-sales', { customerId: ids.customer, customerName: 'عميل تجريبي', customerPhone: '01000000001', sellingDate: today, items: [{ productId: ids.product, quantity: 1, price: 10 }] });
  ids.creditSale = idOf(s?.creditSale ?? s);
});
await step('purchase', async () => {
  const p = await call('POST', '/purchases', { supplierId: ids.supplier, date: today, items: [{ productId: ids.product, qty: 5, unitPrice: 5 }] });
  ids.purchase = idOf(p?.purchase ?? p);
});
await step('cash boxes', async () => { ids.boxes = list(await call('GET', '/cashbox/boxes')).map(idOf); ids.box = ids.boxes[0]; });
await step('expense category + expense', async () => {
  const c = await call('POST', '/expenses/categories', { nameAr: 'مصروف تجريبي' });
  await call('POST', '/expenses', { accountId: c.id ?? idOf(c), amount: 5, date: today, note: 'audit' });
});
await step('courier', async () => { const c = await call('POST', '/couriers', { name: 'مندوب تجريبي', phone: '01000000003' }); ids.courier = c.id ?? idOf(c); });
await step('accounts', async () => { ids.accounts = list(await call('GET', '/accounting/accounts')).map(idOf); ids.account = ids.accounts[0]; });
await step('journal', async () => { ids.journal = idOf(list(await call('GET', '/accounting/journal'))[0]); });
await step('manual entry (draft)', async () => {
  const accounts = list(await call('GET', '/accounting/manual-entries/accounts'));
  const [a, b] = accounts.filter((x) => x.isGroup !== true).slice(0, 2);
  const e = await call('POST', '/accounting/manual-entries', { date: today, memo: 'audit', lines: [{ accountId: idOf(a), debit: 5, credit: 0 }, { accountId: idOf(b), debit: 0, credit: 5 }] });
  ids.manualEntry = idOf(e?.entry ?? e);
});
await step('website order', async () => {
  await call('PUT', '/website/settings', { enabled: true, orderingEnabled: true });
  const zone = await call('POST', '/website/delivery-zones', { name: 'منطقة تجريبية', fee: 10 });
  await call('PUT', '/website/products/' + ids.product, { visibility: 'show' });
  await call('PUT', '/website/categories/' + ids.category, { visibility: 'show' });
  const key = crypto.randomUUID();
  await fetch(API + '/api/store/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    idempotencyKey: key, items: [{ productId: ids.product, qty: 1 }], zoneId: zone.id ?? idOf(zone), fulfillment: 'delivery', paymentMethod: 'cod',
    contact: { name: 'زبون الموقع', phone: '01012345678', address: 'عنوان تجريبي' } }) }).then(async (r) => { if (!r.ok) throw new Error('store order ' + r.status + ' ' + (await r.text()).slice(0, 200)); });
  ids.order = idOf(list(await call('GET', '/orders'))[0]);
});

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'ids.json'), JSON.stringify({ ids, notes }, null, 2));
console.log('\nids saved to mobile-audit/ids.json');
if (notes.length) console.log('skipped steps:\n - ' + notes.join('\n - '));
