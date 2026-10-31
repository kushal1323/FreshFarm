import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeOptionalProductId } from './batch_product_link.js';

const serverSource = await readFile(new URL('./server.js', import.meta.url), 'utf8');
const apiSource = await readFile(new URL('../src/api.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('batch product ID is optional and validated when provided', () => {
  assert.equal(normalizeOptionalProductId(undefined), null);
  assert.equal(normalizeOptionalProductId(null), null);
  assert.equal(normalizeOptionalProductId(''), null);
  assert.equal(normalizeOptionalProductId(27), 27);
  assert.equal(normalizeOptionalProductId('27'), 27);
  assert.throws(() => normalizeOptionalProductId('0'), /positive integer/);
  assert.throws(() => normalizeOptionalProductId('27.5'), /positive integer/);
  assert.throws(() => normalizeOptionalProductId('abc'), /positive integer/);
});

test('batch creation authenticates the farmer and checks product ownership before parameterized insert', () => {
  const start = serverSource.indexOf("app.post('/api/batches'");
  const end = serverSource.indexOf("app.post('/api/documents/presigned-url'", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const route = serverSource.slice(start, end);

  assert.match(route, /authenticateUser, requireRole\('FARMER'\)/);
  assert.match(route, /SELECT id FROM farmer_profiles WHERE user_id = \?/);
  assert.match(route, /SELECT id FROM products WHERE id = \? AND farmer_id = \?/);
  assert.match(route, /INSERT INTO batches \([^)]*product_id\)[\s\S]*VALUES \(\?, \?, \?, \?, \?, \?, \?\)/);
  assert.match(route, /normalizedProductId\s*\n\s*\]\)/);
});

test('farmer product selector is authenticated and scoped to the current farmer profile', () => {
  const start = serverSource.indexOf("app.get('/api/farmer/products'");
  const end = serverSource.indexOf("app.post('/api/farmer/products'", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const route = serverSource.slice(start, end);

  assert.match(route, /authenticateUser, requireRole\('FARMER'\)/);
  assert.match(route, /SELECT id, name, category, is_active[\s\S]*FROM products[\s\S]*WHERE farmer_id = \?/);
  assert.match(route, /\[farmerRows\[0\]\.id\]/);
  assert.match(apiSource, /fetch\(`\$\{API_BASE_URL\}\/farmer\/products`,\s*\{\s*headers: await authHeaders\(\)/);
  assert.match(appSource, /Link marketplace product \(optional\)/);
  assert.match(appSource, /product_id: form\.product_id \? Number\(form\.product_id\) : null/);
});
