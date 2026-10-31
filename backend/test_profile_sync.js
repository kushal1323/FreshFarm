import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFarmerProfileDefaults, resolveSyncedRole } from './profile_sync.js';

test('farmer role is derived from verified Cognito claims', () => {
  assert.equal(resolveSyncedRole(null, 'farmer'), 'FARMER');
  assert.equal(resolveSyncedRole(null, 'buyer'), 'CUSTOMER');
  assert.equal(resolveSyncedRole('CUSTOMER', 'buyer'), 'CUSTOMER');
});

test('existing farmer and admin database roles are never downgraded', () => {
  assert.equal(resolveSyncedRole('FARMER', 'buyer'), 'FARMER');
  assert.equal(resolveSyncedRole('ADMIN', 'farmer'), 'ADMIN');
});

test('untrusted request fields cannot promote a customer to farmer', () => {
  assert.equal(resolveSyncedRole('CUSTOMER', 'buyer'), 'CUSTOMER');
});

test('missing farmer details get safe defaults and supplied details seed a new profile', () => {
  assert.deepEqual(
    buildFarmerProfileDefaults({ name: 'Mira Shah', email: 'mira@example.test' }),
    { farmName: "Mira Shah's Farm", location: 'Pending verification', description: null }
  );
  assert.deepEqual(
    buildFarmerProfileDefaults({
      name: 'Mira Shah',
      email: 'mira@example.test',
      body: { farm_name: 'Green Acres', farm_location: 'Pune', farm_description: 'Organic produce' },
    }),
    { farmName: 'Green Acres', location: 'Pune', description: 'Organic produce' }
  );
});
