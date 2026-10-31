import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFarmerProfileDefaults,
  farmerProfileVerificationStatus,
  isVerifiedEmailClaim,
  resolveSyncedRole
} from './profile_sync.js';

test('farmer role is derived from verified Cognito claims', () => {
  assert.equal(resolveSyncedRole(null, 'farmer'), 'FARMER');
  assert.equal(resolveSyncedRole(null, 'buyer'), 'CUSTOMER');
  assert.equal(resolveSyncedRole('CUSTOMER', 'buyer'), 'CUSTOMER');
});

test('existing farmer and admin database roles are never downgraded', () => {
  assert.equal(resolveSyncedRole('FARMER', 'buyer'), 'FARMER');
  assert.equal(resolveSyncedRole('FARMER', null), 'FARMER');
  assert.equal(resolveSyncedRole('FARMER', 'stale-customer-claim'), 'FARMER');
  assert.equal(resolveSyncedRole('ADMIN', 'farmer'), 'ADMIN');
  assert.equal(resolveSyncedRole('ADMIN', null), 'ADMIN');
});

test('existing customer accounts remain customers without a verified farmer claim', () => {
  assert.equal(resolveSyncedRole('CUSTOMER', 'buyer'), 'CUSTOMER');
  assert.equal(resolveSyncedRole('CUSTOMER', null), 'CUSTOMER');
  assert.equal(resolveSyncedRole('CUSTOMER', 'stale-customer-claim'), 'CUSTOMER');
});

test('verified farmer claim repairs a customer role on the same Cognito identity', () => {
  assert.equal(resolveSyncedRole('CUSTOMER', 'farmer'), 'FARMER');
  assert.equal(resolveSyncedRole(null, 'farmer'), 'FARMER');
});

test('farmer profile approval requires verified email claim from Cognito', () => {
  assert.equal(isVerifiedEmailClaim(true), true);
  assert.equal(isVerifiedEmailClaim('true'), true);
  assert.equal(isVerifiedEmailClaim(false), false);
  assert.equal(isVerifiedEmailClaim(undefined), false);
  assert.equal(farmerProfileVerificationStatus('FARMER', true), 'APPROVED');
  assert.equal(farmerProfileVerificationStatus('FARMER', false), 'PENDING');
  assert.equal(farmerProfileVerificationStatus('CUSTOMER', true), 'PENDING');
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
