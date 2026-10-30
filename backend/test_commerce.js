import assert from 'assert';

const BASE_URL = 'http://localhost:5000/api';

async function runTests() {
  console.log('≡ƒº¬ Starting FreshFarm 2.0 Production-Readiness Test Suite...\n');

  // Test 1: Health Check (P2: #20)
  console.log('Test 1: Health endpoint check');
  const healthRes = await fetch(`${BASE_URL}/health`);
  const healthData = await healthRes.json();
  assert.strictEqual(healthRes.status, 200);
  assert.strictEqual(healthData.status, 'UP');
  assert.strictEqual(healthData.database, 'CONNECTED');
  console.log('Γ£à Health check passed\n');

  // Test 2: Product Catalogue Contract & Filtering (P1: #7)
  console.log('Test 2: GET /api/products format & category filter');
  const catRes = await fetch(`${BASE_URL}/products?category=Vegetables`);
  const catData = await catRes.json();
  assert.strictEqual(catData.success, true);
  assert(Array.isArray(catData.data));
  catData.data.forEach(p => {
    assert.strictEqual(p.category, 'Vegetables');
    assert(p.farmer && typeof p.farmer.farm_name === 'string');
    assert(typeof p.available_quantity === 'number');
    assert(typeof p.price_paise === 'number');
  });
  console.log('Γ£à Product catalogue matches nested schema and filter requirements\n');

  // Test 3: Unauthorized Access Prevention (P1: #14)
  console.log('Test 3: Authorization guards (Customer attempting farmer operation)');
  const unauthRes = await fetch(`${BASE_URL}/farmer/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': '1' },
    body: JSON.stringify({ name: 'Hacked Item', price_paise: 100, category: 'Vegetables' })
  });
  assert.strictEqual(unauthRes.status, 403, 'Customer should not create farmer products');
  console.log('Γ£à Customer restricted from farmer product creation\n');

  // Test 4: Farmer Ownership Protection (P0: #6)
  console.log('Test 4: Farmer updating another farmer\'s product');
  const fakePatchRes = await fetch(`${BASE_URL}/farmer/products/99999`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-user-id': '2' },
    body: JSON.stringify({ price_paise: 500 })
  });
  assert.strictEqual(fakePatchRes.status, 403, 'Farmer cannot patch unowned product');
  console.log('Γ£à Strict product ownership enforced\n');

  // Test 5: Validation - Invalid & Negative Quantities (P1: #13)
  console.log('Test 5: Order input validation (negative quantity)');
  const badQtyRes = await fetch(`${BASE_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': '1' },
    body: JSON.stringify({
      items: [{ product_id: 1, quantity: -2 }],
      delivery_address: 'Validation Address'
    })
  });
  const badQty = await badQtyRes.json();
  assert.strictEqual(badQty.success, false);
  console.log('Γ£à Rejected negative quantity\n');

  // Test 6: Validation - Insufficient Stock (P1: #13)
  console.log('Test 6: Order input validation (excessive stock request)');
  const overStockRes = await fetch(`${BASE_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': '1' },
    body: JSON.stringify({
      items: [{ product_id: 1, quantity: 999999 }],
      delivery_address: 'Validation Address'
    })
  });
  const overStock = await overStockRes.json();
  assert.strictEqual(overStock.success, false);
  console.log('Γ£à Rejected stock exceeding unexpired inventory\n');

  // Test 7: Concurrent Race-Condition Locking (P1: #13)
  console.log('Test 7: Concurrent checkout race condition (Atomic FOR UPDATE)');
  const prodCheck = await (await fetch(`${BASE_URL}/products/1`)).json();
  const currentStock = prodCheck.data.available_quantity;

  if (currentStock >= 2) {
    const buyQty = Math.floor(currentStock / 2) + 1;
    console.log(`Targeting stock: ${currentStock} kg. Two concurrent orders requesting ${buyQty} kg...`);

    const p1 = fetch(`${BASE_URL}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': '1' },
      body: JSON.stringify({ items: [{ product_id: 1, quantity: buyQty }], delivery_address: 'Client A' })
    }).then(r => r.json());

    const p2 = fetch(`${BASE_URL}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': '1' },
      body: JSON.stringify({ items: [{ product_id: 1, quantity: buyQty }], delivery_address: 'Client B' })
    }).then(r => r.json());

    const [r1, r2] = await Promise.all([p1, p2]);
    const succ = [r1, r2].filter(r => r.success);
    const fail = [r1, r2].filter(r => !r.success);

    assert.strictEqual(succ.length, 1, 'Only one order can claim the limited stock');
    assert.strictEqual(fail.length, 1, 'Second concurrent order must fail gracefully');
    console.log('Γ£à Concurrency race condition prevented by row-level locking\n');
  }

  // Test 8: Order Status State Machine Transitions (P1: #11)
  console.log('Test 8: Invalid status transition enforcement');
  const badTransitionRes = await fetch(`${BASE_URL}/farmer/orders/1/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-user-id': '2' },
    body: JSON.stringify({ status: 'DELIVERED' })
  });
  assert.strictEqual(badTransitionRes.status, 400, 'Invalid forward skip should return 400');
  console.log('Γ£à State machine transition validation enforced\n');

  // Test 9: Legacy Batches Regression Check (P1: #15)
  console.log('Test 9: Regression check for original /api/batches');
  const batchRes = await fetch(`${BASE_URL}/batches`);
  const batchData = await batchRes.json();
  assert.strictEqual(batchRes.status, 200);
  assert.strictEqual(batchData.success, true);
  assert(Array.isArray(batchData.data));
  assert('dynamic_status' in batchData.data[0]);
  console.log('Γ£à Legacy inventory & cold-chain batch routes unaffected\n');

  console.log('≡ƒÄë All 9 critical backend test suites completed successfully!');
}

runTests().catch(err => {
  console.error('Γ¥î Test suite failed:', err);
  process.exit(1);
});
