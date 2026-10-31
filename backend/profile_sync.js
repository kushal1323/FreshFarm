export function resolveSyncedRole(existingRole, cognitoRole) {
  const currentRole = String(existingRole || '').trim().toUpperCase();
  const verifiedRole = String(cognitoRole || '').trim().toUpperCase();

  if (currentRole === 'ADMIN') return 'ADMIN';
  if (currentRole === 'FARMER' || verifiedRole === 'FARMER') return 'FARMER';
  return 'CUSTOMER';
}

function firstText(...values) {
  return values.find(value => typeof value === 'string' && value.trim())?.trim() || '';
}

export function buildFarmerProfileDefaults({ name, email, body = {}, tokenPayload = {} }) {
  const accountName = firstText(name, email?.split('@')[0], 'FreshFarm');
  const farmName = firstText(
    tokenPayload['custom:farm_name'],
    body.farm_name,
    `${accountName}'s Farm`
  ).slice(0, 150);
  const location = firstText(
    tokenPayload['custom:farm_location'],
    body.farm_location,
    'Pending verification'
  ).slice(0, 255);
  const description = firstText(
    tokenPayload['custom:farm_description'],
    body.farm_description
  ) || null;

  return { farmName, location, description };
}
