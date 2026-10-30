import assert from 'assert';

const BASE_URL = 'http://localhost:5000/api';

async function runTests() {
  console.log('🧪 Starting Commerce & Concurrency Test Suite...\n');

  // Test 1: Catalogue Retrieval
  console.log('Test 1: GET /api/products format check');
  const prodRes = await fetch(`${BASE_URL}/products`);
  const prods = await prodRes.json();
  assert.strictEqual(prods.success, true);
  assert(Array.isArray(prods.data));
  assert(prods.data.length > 0);
  assert(prods.data[0].farmer && prods.data[0].farmer.farm_name);
  console.log('✅ Product catalogue matches Person 1 schema\n');

  // Test 2: Invalid/Zero/Negative Quantity Validation
  console.log('Test 2: Reject invalid order quantities');
  const badOrderRes = await fetch(`${BASE_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': '1' },
    body: JSON.stringify({
      items: [{ product_id: 1, quantity: -5 }],
      delivery_address: 'Test Address'
    })
  });
  const badOrder = await badOrderRes.json();
  assert.strictEqual(badOrder.success, false);
  console.log('✅ Correctly rejected negative quantity\n');

  // Test 3: Overselling / Stock Shortage
  console.log('Test 3: Reject order exceeding available batch quantity');
  const excessOrderRes = await fetch(`${BASE_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': '1' },
    body: JSON.stringify({
      items: [{ product_id: 1, quantity: 999999 }],
      delivery_address: 'Test Address'
    })
  });
  const excessOrder = await excessOrderRes.json();
  assert.strictEqual(excessOrder.success, false);
  console.log('✅ Stock shortage rejected cleanly\n');

  // Test 4: Concurrent Race Condition (Simultaneous checkout of limited stock)
  console.log('Test 4: Concurrent purchase race condition');
  const targetProduct = prods.data[0];
  const available = targetProduct.available_quantity;
  const orderQty = Math.max(1, Math.floor(available / 2) + 1); // Each asks for > half

  console.log(`Available stock: ${available} kg. Firing 2 simultaneous orders of ${orderQty} kg...`);

  const req1 = fetch(`${BASE_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': '1' },
    body: JSON.stringify({
      items: [{ product_id: targetProduct.id, quantity: orderQty }],
      delivery_address: 'Customer 1 Address'
    })
  }).then(r => r.json());

  const req2 = fetch(`${BASE_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': '1' },
    body: JSON.stringify({
      items: [{ product_id: targetProduct.id, quantity: orderQty }],
      delivery_address: 'Customer 2 Address'
    })
  }).then(r => r.json());

  const [res1, res2] = await Promise.all([req1, req2]);
  const successes = [res1, res2].filter(r => r.success);
  const failures = [res1, res2].filter(r => !r.success);

  assert.strictEqual(successes.length, 1, 'Only one order should succeed');
  assert.strictEqual(failures.length, 1, 'The other order must be rejected due to insufficient stock');
  console.log('✅ Atomic row-level lock prevented overselling under concurrent load!\n');

  // Test 5: Verify Original Batches Endpoint Still Works
  console.log('Test 5: Original /api/batches regression check');
  const batchRes = await fetch(`${BASE_URL}/batches`);
  const batches = await batchRes.json();
  assert.strictEqual(batchRes.status, 200);
  assert.strictEqual(batches.success, true);
  console.log('✅ Original batch and expiry endpoints remain operational\n');

  console.log('🎉 All integration tests passed successfully!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
