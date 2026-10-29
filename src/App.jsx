
import { useEffect, useState } from "react";
import {
  getBatches,
  addBatch,
  uploadDocument,
  linkDocumentToBatch,
  getDocumentDownloadUrl,
} from "./api";
import "./App.css";

const emptyForm = {
  item_name: "",
  category: "",
  quantity_kg: "",
  harvest_date: "",
  expiry_date: "",
};

export default function App() {
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [file, setFile] = useState(null);
  const [selectedBatchId, setSelectedBatchId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");
  const [downloadingKey, setDownloadingKey] = useState("");

  async function loadInventory() {
    setLoading(true);
    setError("");

    try {
      const data = await getBatches();
      setBatches(data);
      setSelectedBatchId((current) =>
        data.some((batch) => String(batch.id) === String(current))
          ? current
          : ""
      );
    } catch (err) {
      setError(err.message || "Unable to load inventory");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadInventory();
  }, []);

  async function handleAddBatch(event) {
    event.preventDefault();
    setSaving(true);
    setMessage("");

    try {
      const result = await addBatch({
        ...form,
        quantity_kg: Number(form.quantity_kg),
        category: form.category || null,
      });

      setMessage(`Inventory added successfully. Batch ID: ${result.batch_id}`);
      setForm(emptyForm);
      await loadInventory();
    } catch (err) {
      setMessage(`Failed to add inventory: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleUpload(event) {
    event.preventDefault();
    if (!file || !selectedBatchId) return;

    setUploading(true);
    setUploadMessage("");

    try {
      const uploaded = await uploadDocument(file);
      await linkDocumentToBatch(selectedBatchId, uploaded.s3Key);

      setUploadMessage(`Uploaded and linked: ${uploaded.fileName}`);
      setFile(null);
      event.target.reset();
      await loadInventory();
    } catch (err) {
      setUploadMessage(`Upload/link failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  }

  async function handleDownload(key) {
    setDownloadingKey(key);

    try {
      const url = await getDocumentDownloadUrl(key);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      alert(`Download failed: ${err.message}`);
    } finally {
      setDownloadingKey("");
    }
  }

  const criticalCount = batches.filter(
    (batch) => batch.dynamic_status === "CRITICAL"
  ).length;

  return (
    <main className="dashboard">
      <header className="hero">
        <div>
          <p className="eyebrow">PERISHABLE INVENTORY MANAGEMENT</p>
          <h1>🌱 FreshFarm</h1>
          <p>Track inventory. Monitor expiry. Manage documents.</p>
        </div>
        <button className="secondary-button" onClick={loadInventory}>
          {loading ? "Refreshing..." : "↻ Refresh"}
        </button>
      </header>

      {error && <div className="notice error">{error}</div>}

      <section className="stats">
        <article className="stat-card">
          <span>Total batches</span>
          <strong>{batches.length}</strong>
        </article>
        <article className="stat-card">
          <span>Critical batches</span>
          <strong className="critical-number">{criticalCount}</strong>
        </article>
        <article className="stat-card">
          <span>Document-linked batches</span>
          <strong>
            {batches.filter((batch) => batch.s3_document_key).length}
          </strong>
        </article>
      </section>

      <section className="panel">
        <h2>Add inventory batch</h2>
        <p className="muted">Register a new shipment in your inventory.</p>

        <form onSubmit={handleAddBatch} className="form-grid">
          <label>
            Item name *
            <input
              value={form.item_name}
              onChange={(e) =>
                setForm({ ...form, item_name: e.target.value })
              }
              placeholder="e.g. Organic Apples"
              required
            />
          </label>

          <label>
            Category
            <input
              value={form.category}
              onChange={(e) =>
                setForm({ ...form, category: e.target.value })
              }
              placeholder="e.g. Fruits"
            />
          </label>

          <label>
            Quantity (kg) *
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={form.quantity_kg}
              onChange={(e) =>
                setForm({ ...form, quantity_kg: e.target.value })
              }
              required
            />
          </label>

          <label>
            Harvest date *
            <input
              type="date"
              value={form.harvest_date}
              onChange={(e) =>
                setForm({ ...form, harvest_date: e.target.value })
              }
              required
            />
          </label>

          <label>
            Expiry date *
            <input
              type="date"
              min={form.harvest_date || undefined}
              value={form.expiry_date}
              onChange={(e) =>
                setForm({ ...form, expiry_date: e.target.value })
              }
              required
            />
          </label>

          <div className="form-action">
            <button disabled={saving} type="submit">
              {saving ? "Saving..." : "+ Add inventory"}
            </button>
          </div>
        </form>

        {message && <p className="notice">{message}</p>}
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Inventory batches</h2>
            <p className="muted">Live data from your existing API.</p>
          </div>
          <span className="count-badge">{batches.length} batches</span>
        </div>

        {loading && <p>Loading inventory...</p>}

        {!loading && !error && batches.length === 0 && (
          <p>No inventory batches found.</p>
        )}

        <div className="inventory-grid">
          {batches.map((batch) => (
            <article className="batch-card" key={batch.id}>
              <div className="batch-heading">
                <div>
                  <p className="batch-id">BATCH #{batch.id}</p>
                  <h3>{batch.item_name}</h3>
                </div>
                <span
                  className={`status ${
                    batch.dynamic_status === "CRITICAL" ? "status-critical" : ""
                  }`}
                >
                  {batch.dynamic_status || "UNKNOWN"}
                </span>
              </div>

              <p className="muted">{batch.category || "Uncategorized"}</p>
              <div className="batch-details">
                <p>
                  <span>Quantity</span>
                  <strong>{batch.quantity_kg} kg</strong>
                </p>
                <p>
                  <span>Expiry date</span>
                  <strong>
                    {new Date(batch.expiry_date).toLocaleDateString()}
                  </strong>
                </p>
              </div>

              {batch.s3_document_key ? (
                <button
                  className="secondary-button full-button"
                  onClick={() => handleDownload(batch.s3_document_key)}
                  disabled={downloadingKey === batch.s3_document_key}
                >
                  {downloadingKey === batch.s3_document_key
                    ? "Preparing download..."
                    : "↓ Download document"}
                </button>
              ) : (
                <p className="muted document-missing">No document linked</p>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Upload and link a document</h2>
        <p className="muted">
          Upload an invoice or report to the existing S3 bucket.
        </p>

        <form onSubmit={handleUpload} className="upload-form">
          <label>
            Inventory batch *
            <select
              value={selectedBatchId}
              onChange={(e) => setSelectedBatchId(e.target.value)}
              required
            >
              <option value="">Choose a batch</option>
              {batches.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {batch.item_name} (ID: {batch.id})
                </option>
              ))}
            </select>
          </label>

          <label>
            Document *
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.csv,.xlsx"
              onChange={(e) => {
                setFile(e.target.files?.[0] || null);
                setUploadMessage("");
              }}
              required
            />
          </label>

          <button disabled={!file || !selectedBatchId || uploading}>
            {uploading ? "Uploading..." : "Upload to S3 and link"}
          </button>
        </form>

        {uploadMessage && <p className="notice">{uploadMessage}</p>}
      </section>

      <footer>FreshFarm · Perishable Inventory &amp; Cold-Chain Tracker</footer>
    </main>
  );
}
