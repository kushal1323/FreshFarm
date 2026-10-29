
const API_BASE_URL = "http://13.63.166.10";

async function readResponse(response) {
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.message || result.error || "Request failed");
  }
  return result;
}

export async function getBatches() {
  const result = await readResponse(
    await fetch(`${API_BASE_URL}/api/batches`)
  );
  return Array.isArray(result) ? result : result.data || [];
}

export async function addBatch(batchData) {
  const result = await readResponse(
    await fetch(`${API_BASE_URL}/api/batches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    await fetch(`${API_BASE_URL}/api/documents/presigned-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    await fetch(`${API_BASE_URL}/api/batches/${batchId}/document`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      `${API_BASE_URL}/api/documents/download-url?key=${encodeURIComponent(key)}`
    )
  );

  if (!result.downloadUrl) {
    throw new Error("Download URL was not returned by the API");
  }

  return result.downloadUrl;
}
