export function normalizeOptionalProductId(value) {
  if (value === undefined || value === null || value === '') return null;

  const productId = Number(value);
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    throw new TypeError('Product ID must be a positive integer');
  }

  return productId;
}
