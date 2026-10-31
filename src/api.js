
import { fetchAuthSession } from "aws-amplify/auth";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  (import.meta.env.DEV ? "http://localhost:5000/api" : "/api");

async function authHeaders(extraHeaders = {}) {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    return {
      ...extraHeaders,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  } catch {
    return extraHeaders;
  }
}

async function readResponse(response) {
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.message || result.error || "Request failed");
  }

  return result;
}

export async function getBatches() {
  const result = await readResponse(
    await fetch(`${API_BASE_URL}/batches`, {
      headers: await authHeaders(),
    })
  );

return Array.isArray(result)
  ? result
  : Array.isArray(result.data)
    ? result.data
    : [];}

export async function getProducts() {
  const result = await readResponse(
    await fetch(`${API_BASE_URL}/products`)
  );

  return result.data || [];
}


export async function addBatch(batchData) {
  const result = await readResponse(
    await fetch(`${API_BASE_URL}/batches`, {
      method: "POST",
      headers: await authHeaders({
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(batchData),
    })
  );

  if (!result.success) {
    throw new Error(result.message || "Could not add inventory");
  }

  return result;
}

export async function uploadDocument(file) {
  const result = await readResponse(
    await fetch(`${API_BASE_URL}/documents/presigned-url`, {
      method: "POST",
      headers: await authHeaders({
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        fileName: file.name,
        fileType: file.type || "application/octet-stream",
      }),
    })
  );

  const uploadResponse = await fetch(result.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  });

  if (!uploadResponse.ok) {
    throw new Error(`S3 upload failed (${uploadResponse.status})`);
  }

  return { fileName: file.name, s3Key: result.s3Key };
}

export async function linkDocumentToBatch(batchId, s3Key) {
  const result = await readResponse(
    await fetch(`${API_BASE_URL}/batches/${batchId}/document`, {
      method: "POST",
      headers: await authHeaders({
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ s3Key }),
    })
  );

  if (!result.success) {
    throw new Error(result.message || "Could not link document");
  }

  return result;
}

export async function getDocumentDownloadUrl(key) {
  const result = await readResponse(
    await fetch(
      `${API_BASE_URL}/documents/download-url?key=${encodeURIComponent(key)}`,
      {
        headers: await authHeaders(),
      }
    )
  );

  if (!result.downloadUrl) {
    throw new Error("Download URL was not returned by the API");
  }

  return result.downloadUrl;
}
export async function createOrder(orderData) {
  const result = await readResponse(
    await fetch(`${API_BASE_URL}/orders`, {
      method: "POST",
      headers: await authHeaders({
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(orderData),
    })
  );

  if (!result.success) {
    throw new Error(result.message || "Could not place order");
  }

  return result;
}
export async function getOrders() {
  const result = await readResponse(
    await fetch(`${API_BASE_URL}/orders`, {
      headers: await authHeaders(),
    })
  );

  if (!Array.isArray(result.data)) {
    throw new Error("The API returned an invalid orders response");
  }

  return result.data;
}

export async function getOrderDetails(orderId) {
  const normalizedOrderId = Number(orderId);
  if (!Number.isSafeInteger(normalizedOrderId) || normalizedOrderId <= 0) {
    throw new Error("A valid order ID is required");
  }

  const result = await readResponse(
    await fetch(`${API_BASE_URL}/orders/${encodeURIComponent(normalizedOrderId)}`, {
      headers: await authHeaders(),
    })
  );

  if (!result.data || !Array.isArray(result.data.items)) {
    throw new Error("The API returned invalid order details");
  }

  return result.data;
}

export async function getFarmerOrders() {
  const result = await readResponse(
    await fetch(`${API_BASE_URL}/farmer/orders`, {
      headers: await authHeaders(),
    })
  );

  if (!Array.isArray(result.data)) {
    throw new Error("The API returned an invalid farmer orders response");
  }

  return result.data;
}

export async function updateFarmerOrderStatus(orderId, status, notes = "") {
  const normalizedOrderId = Number(orderId);
  const allowedStatuses = [
    "CONFIRMED",
    "CANCELLED",
    "PACKED",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
  ];

  if (!Number.isSafeInteger(normalizedOrderId) || normalizedOrderId <= 0) {
    throw new Error("A valid order ID is required");
  }
  if (!allowedStatuses.includes(status)) {
    throw new Error("A valid order status is required");
  }

  const result = await readResponse(
    await fetch(`${API_BASE_URL}/farmer/orders/${normalizedOrderId}/status`, {
      method: "PATCH",
      headers: await authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ status, notes }),
    })
  );

  if (!result.success) {
    throw new Error(result.message || "Could not update order status");
  }

  return result;
}
