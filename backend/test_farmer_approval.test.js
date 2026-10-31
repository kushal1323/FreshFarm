import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const serverSource = await readFile(new URL('./server.js', import.meta.url), 'utf8');
const authPanelSource = await readFile(new URL('../src/AuthPanel.jsx', import.meta.url), 'utf8');

function sourceBetween(start, end) {
  const startIndex = serverSource.indexOf(start);
  const endIndex = serverSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return serverSource.slice(startIndex, endIndex);
}

test('registration still requires Cognito email OTP confirmation', () => {
  const confirmationFlow = sourceBetweenAuth(
    'if (step === "confirm") {',
    'if (mode === "register") {'
  );
  assert.match(confirmationFlow, /await confirmSignUp\(\{[\s\S]*confirmationCode: code/);
  assert.match(confirmationFlow, /await signIn\(\{ username: email, password \}\)/);
  assert.match(confirmationFlow, /await onLogin\(\)/);
  assert.match(authPanelSource, /result\.nextStep\.signUpStep === "CONFIRM_SIGN_UP"/);
  assert.match(serverSource, /if \(!isVerifiedEmailClaim\(req\.tokenPayload\.email_verified\)\)/);
});

function sourceBetweenAuth(start, end) {
  const startIndex = authPanelSource.indexOf(start);
  const endIndex = authPanelSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing auth source marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing auth source marker: ${end}`);
  return authPanelSource.slice(startIndex, endIndex);
}

test('farmer product listings, details, publishing, and checkout do not require manual approval', () => {
  const productList = sourceBetween("app.get('/api/products'", "app.get('/api/products/:id'");
  const productDetails = sourceBetween("app.get('/api/products/:id'", '// ---------------- FARMER PRODUCT MANAGEMENT');
  const farmerProductCreation = sourceBetween("app.post('/api/farmer/products'", "app.patch('/api/farmer/products/:id'");
  const checkout = sourceBetween("app.post('/api/orders'", "app.get('/api/orders'");

  assert.doesNotMatch(productList, /verification_status\s*=\s*'APPROVED'/);
  assert.doesNotMatch(productDetails, /verification_status\s*=\s*'APPROVED'/);
  assert.match(farmerProductCreation, /authenticateUser, requireRole\('FARMER', 'ADMIN'\)/);
  assert.match(farmerProductCreation, /SELECT id FROM farmer_profiles WHERE user_id = \?/);
  assert.doesNotMatch(farmerProductCreation, /verification_status/);
  assert.doesNotMatch(checkout, /verification_status\s*=\s*'APPROVED'/);
});

test('farmer order access retains authentication, role, and product ownership checks', () => {
  const farmerOrders = sourceBetween("app.get('/api/farmer/orders'", 'const VALID_TRANSITIONS');
  const updateOrder = sourceBetween("app.patch('/api/farmer/orders/:id/status'", '// ---------------- EXPIRY AUDIT CRON');

  assert.match(farmerOrders, /authenticateUser, requireRole\('FARMER', 'ADMIN'\)/);
  assert.match(farmerOrders, /WHERE p\.farmer_id = \?/);
  assert.match(updateOrder, /authenticateUser, requireRole\('FARMER', 'ADMIN'\)/);
  assert.match(updateOrder, /WHERE oi\.order_id = \? AND p\.farmer_id = \?/);
});
