import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getBatches,
  addBatch,
  uploadDocument,
  linkDocumentToBatch,
  getDocumentDownloadUrl,
  getProducts,
  getFarmerProducts,
  createOrder,
  getOrders,
  getOrderDetails,
  getFarmerOrders,
  updateFarmerOrderStatus,
  syncUserProfile,
  getCurrentUserProfile,
} from "./api";
import "./App.css";
import AuthPanel from "./AuthPanel";
import { fetchAuthSession, signOut } from "aws-amplify/auth";

const categories = [
  { name: "All produce", emoji: "🌱" },
  { name: "Vegetables", emoji: "🥕" },
  { name: "Fruits", emoji: "🍎" },
  { name: "Leafy Greens", emoji: "🥬" },
];

const emptyForm = {
  item_name: "",
  product_id: "",
  category: "",
  quantity_kg: "",
  harvest_date: "",
  expiry_date: "",
};

const formatPrice = (amount) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(amount);

const normalizeRole = (role) => {
  const normalizedRole = String(role || "").trim().toLowerCase();
  return normalizedRole === "buyer" ? "customer" : normalizedRole;
};

const profileSyncPayload = (token) => {
  const claims = token.payload;
  const email = claims.email || "";

  return {
    name: claims.name || email.split("@")[0],
    phone: claims.phone_number || null,
    farm_name: claims["custom:farm_name"],
    farm_location: claims["custom:farm_location"],
    farm_description: claims["custom:farm_description"],
  };
};

async function syncAndResolveAccount(token) {
  const syncResult = await syncUserProfile(profileSyncPayload(token));
  const profile = await getCurrentUserProfile();
  const cognitoRole = normalizeRole(token.payload["custom:role"]);
  const databaseRole = normalizeRole(profile.role || syncResult.role);

  let role = databaseRole || cognitoRole || "customer";
  if (databaseRole !== "admin" && (databaseRole === "farmer" || cognitoRole === "farmer")) {
    role = "farmer";
  }

  let warning = "";
  if (cognitoRole === "farmer" && databaseRole === "customer") {
    warning = "Cognito identifies this account as a farmer, but the FreshFarm database still reports customer. The backend sync service needs updating.";
  } else if (role === "farmer" && !profile.farmer_profile?.farmer_id) {
    warning = "This account is recognized as a farmer, but its farmer profile is still missing. Refresh after the backend sync service is updated.";
  }

  return { role, warning };
}

const nextOrderStatuses = {
  PLACED: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PACKED", "CANCELLED"],
  PACKED: ["OUT_FOR_DELIVERY"],
  OUT_FOR_DELIVERY: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

const orderStatusLabels = {
  CONFIRMED: "Accept order",
  CANCELLED: "Cancel order",
  PACKED: "Mark packed",
  OUT_FOR_DELIVERY: "Send for delivery",
  DELIVERED: "Mark delivered",
};

export default function App() {

  const [authUser, setAuthUser] = useState(null);
const [authLoading, setAuthLoading] = useState(true);
const [products, setProducts] = useState([]);
  const [page, setPage] = useState("shop");
  const [profileSyncError, setProfileSyncError] = useState("");
  async function toggleOrderDetails(orderId) {
    if (expandedOrder === orderId) {
      setExpandedOrder(null);
      return;
    }

    setExpandedOrder(orderId);

    if (!orderDetails[orderId]) {
      try {
        const details = await getOrderDetails(orderId);
        setOrderDetails((current) => ({
          ...current,
          [orderId]: details,
        }));
      } catch (err) {
        setOrdersError(err.message);
      }
    }
  }


const loadProducts = async () => {
  try {
    const data = await getProducts();

    setProducts(
      data.map((product) => ({
        id: product.id,
        name: product.name,
        category: product.category,
        price: Number(product.price_paise) / 100,
        unit: product.unit,
        stock: Number(product.available_quantity) || 0,
        farmer: product.farmer?.farm_name || "Local farmer",
        location: product.farmer?.location || "Location unavailable",
        image:
          product.image_url ||
          "https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&w=700&q=80",
        description: product.description || "",
        tag: "",
      }))
    );
  } catch (error) {
    console.error("Failed to load marketplace products:", error);
  }
};

useEffect(() => {
  let cancelled = false;

  getProducts()
    .then((data) => {
      if (cancelled) return;

      setProducts(
        data.map((product) => ({
          id: product.id,
          name: product.name,
          category: product.category,
          price: Number(product.price_paise) / 100,
          unit: product.unit,
          stock: Number(product.available_quantity) || 0,
          farmer: product.farmer?.farm_name || "Local farmer",
          location: product.farmer?.location || "Location unavailable",
          image:
            product.image_url ||
            "https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&w=700&q=80",
          description: product.description || "",
          tag: "",
        }))
      );
    })
    .catch((error) => {
      console.error("Failed to load marketplace products:", error);
    });

  return () => {
    cancelled = true;
  };
}, []);
async function refreshAuth() {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken;

    if (!token) {
      setAuthUser(null);
      setPage("shop");
      return;
    }

    let role = normalizeRole(token.payload["custom:role"]);
    try {
      const account = await syncAndResolveAccount(token);
      role = account.role;
      setProfileSyncError(account.warning);
    } catch (error) {
      setProfileSyncError(error.message || "Unable to sync your FreshFarm profile");
    }
    setAuthUser({
      email: token.payload.email,
      role,
    });
    setPage(role === "farmer" ? "inventory" : "shop");
  } catch {
    setAuthUser(null);
    setPage("shop");
  } finally {
    setAuthLoading(false);
  }
}

async function handleLogout() {
  await signOut();
  setAuthUser(null);
  setPage("shop");
}

useEffect(() => {
  let active = true;

  fetchAuthSession()
    .then(async (session) => {
      if (!active) return;

      const token = session.tokens?.idToken;
      if (!token) {
        setAuthUser(null);
        setPage("shop");
        return;
      }

      let role = normalizeRole(token.payload["custom:role"]);
      try {
        const account = await syncAndResolveAccount(token);
        role = account.role;
        if (active) setProfileSyncError(account.warning);
      } catch (error) {
        if (active) {
          setProfileSyncError(error.message || "Unable to sync your FreshFarm profile");
        }
      }

      if (!active) return;

      setAuthUser({ email: token.payload.email, role });
      setPage(role === "farmer" ? "inventory" : "shop");
    })
    .catch(() => {
      if (active) {
        setAuthUser(null);
        setPage("shop");
      }
    })
    .finally(() => {
      if (active) setAuthLoading(false);
    });

  return () => {
    active = false;
  };
}, []);


  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All produce");
  const [sort, setSort] = useState("featured");
  const [cart, setCart] = useState([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [orderMessage, setOrderMessage] = useState("");
  const [orderSubmitting, setOrderSubmitting] = useState(false);
  const [orders, setOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState("");
  const [expandedOrder, setExpandedOrder] = useState(null);
  const [orderDetails, setOrderDetails] = useState({});
  const [farmerOrders, setFarmerOrders] = useState([]);
  const [farmerOrdersLoading, setFarmerOrdersLoading] = useState(true);
  const [farmerOrdersError, setFarmerOrdersError] = useState("");
  const [farmerOrdersMessage, setFarmerOrdersMessage] = useState("");
  const [updatingFarmerOrderId, setUpdatingFarmerOrderId] = useState(null);
  // Existing inventory state
  const [batches, setBatches] = useState([]);
  const [farmerProducts, setFarmerProducts] = useState([]);
  const [farmerProductsLoading, setFarmerProductsLoading] = useState(false);
  const [farmerProductsError, setFarmerProductsError] = useState("");
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

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    setOrdersError("");

    try {
      const data = await getOrders();
      setOrders(data);
    } catch (err) {
      setOrdersError(err.message);
    } finally {
      setOrdersLoading(false);
    }
  }, []);

  const loadFarmerOrders = useCallback(async (showLoading = true) => {
    if (showLoading) setFarmerOrdersLoading(true);
    setFarmerOrdersError("");

    try {
      const data = await getFarmerOrders();
      setFarmerOrders(data);
    } catch (err) {
      setFarmerOrdersError(err.message || "Unable to load incoming orders");
    } finally {
      if (showLoading) setFarmerOrdersLoading(false);
    }
  }, []);

  async function handleFarmerOrderStatus(orderId, status) {
    setUpdatingFarmerOrderId(String(orderId));
    setFarmerOrdersMessage("");
    setFarmerOrdersError("");

    try {
      await updateFarmerOrderStatus(
        orderId,
        status,
        status === "CANCELLED" ? "Cancelled by farmer" : "Updated by farmer"
      );
      setFarmerOrdersMessage(`Order #${orderId} updated to ${status}.`);
      await loadFarmerOrders(false);
    } catch (err) {
      setFarmerOrdersError(err.message || "Unable to update order status");
    } finally {
      setUpdatingFarmerOrderId(null);
    }
  }

  const groupedFarmerOrders = useMemo(() => {
    const groups = new Map();

    for (const row of farmerOrders) {
      const key = String(row.order_id);
      if (!groups.has(key)) {
        groups.set(key, {
          id: row.order_id,
          status: row.order_status,
          created_at: row.created_at,
          delivery_address: row.delivery_address,
          items: [],
        });
      }
      groups.get(key).items.push(row);
    }

    return [...groups.values()];
  }, [farmerOrders]);

  const pendingFarmerOrderCount = useMemo(
    () =>
      new Set(
        farmerOrders
          .filter((order) => order.order_status === "PLACED")
          .map((order) => String(order.order_id))
      ).size,
    [farmerOrders]
  );

  useEffect(() => {
    if (authUser?.role !== "farmer") return undefined;

    let active = true;
    async function refreshIncomingOrders() {
      try {
        const data = await getFarmerOrders();
        if (active) {
          setFarmerOrders(data);
          setFarmerOrdersError("");
          setFarmerOrdersLoading(false);
        }
      } catch (err) {
        if (active) {
          setFarmerOrdersError(err.message || "Unable to load incoming orders");
          setFarmerOrdersLoading(false);
        }
      }
    }

    refreshIncomingOrders();
    const intervalId = window.setInterval(refreshIncomingOrders, 30000);
    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [authUser?.role]);

  const filteredProducts = useMemo(() => {
    const query = search.trim().toLowerCase();

    let result = products.filter((product) => {
      const matchesCategory =
        category === "All produce" || product.category === category;

      const matchesSearch =
        !query ||
        product.name.toLowerCase().includes(query) ||
        product.category.toLowerCase().includes(query) ||
        product.farmer.toLowerCase().includes(query) ||
        product.location.toLowerCase().includes(query);

      return matchesCategory && matchesSearch;
    });

    if (sort === "price-low") {
      result = [...result].sort((a, b) => a.price - b.price);
    } else if (sort === "price-high") {
      result = [...result].sort((a, b) => b.price - a.price);
    } else if (sort === "name") {
      result = [...result].sort((a, b) => a.name.localeCompare(b.name));
    }

    return result;
}, [products, search, category, sort]);

  const suggestedFarmerProduct = farmerProducts.find(
    (product) =>
      form.item_name.trim() &&
      product.name.trim().toLocaleLowerCase() === form.item_name.trim().toLocaleLowerCase()
  );

  const cartCount = cart.reduce((total, item) => total + item.quantity, 0);

  const cartTotal = cart.reduce(
    (total, item) => total + item.price * item.quantity,
    0
  );

  const loadInventory = useCallback(async () => {
    setLoading(true);
    setError("");
    setFarmerProductsLoading(true);
    setFarmerProductsError("");

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
    try {
      setFarmerProducts(await getFarmerProducts());
    } catch (err) {
      setFarmerProductsError(err.message || "Unable to load your marketplace products");
    } finally {
      setFarmerProductsLoading(false);
    }
  }, []);

useEffect(() => {
  if (!authUser || authUser.role !== "farmer") {
    return;
  }

  let cancelled = false;
  const timerId = window.setTimeout(() => {
    if (!cancelled) loadInventory();
  }, 0);

  return () => {
    cancelled = true;
    window.clearTimeout(timerId);
  };
}, [authUser, loadInventory]);


  function addToCart(product) {
    setOrderMessage("");

    setCart((current) => {
      const existing = current.find((item) => item.id === product.id);

      if (existing) {
        if (existing.quantity >= product.stock) return current;

        return current.map((item) =>
          item.id === product.id
            ? { ...item, quantity: item.quantity + 1 }
            : item
        );
      }

      return [...current, { ...product, quantity: 1 }];
    });
  }

  function updateCartQuantity(productId, change) {
    setCart((current) =>
      current
        .map((item) => {
          if (item.id !== productId) return item;

          return {
            ...item,
            quantity: Math.min(item.stock, item.quantity + change),
          };
        })
        .filter((item) => item.quantity > 0)
    );
  }

  function removeFromCart(productId) {
    setCart((current) => current.filter((item) => item.id !== productId));
  }

  async function handleCheckout(event) {
    event.preventDefault();

    if (!cart.length || !customerName.trim() || !customerAddress.trim() || orderSubmitting) {
      return;
    }

    setOrderSubmitting(true);
    setOrderMessage("Placing your order...");

    try {
      const result = await createOrder({
        items: cart.map((item) => ({
          product_id: item.id,
          quantity: item.quantity,
        })),
        delivery_address: `${customerName.trim()}, ${customerAddress.trim()}`,
      });

      setOrderMessage(
        `Order #${result.order_id} placed successfully!`
      );

      setCart([]);
      setCheckoutOpen(false);
      setCartOpen(false);
      setCustomerName("");
      setCustomerAddress("");
      await loadOrders();
      setPage("shop");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setOrderMessage(`Order failed: ${err.message}`);
    } finally {
      setOrderSubmitting(false);
    }
  }

  async function handleAddBatch(event) {
    event.preventDefault();
    setSaving(true);
    setMessage("");

    try {
      const selectedProduct = farmerProducts.find(
        (product) => String(product.id) === String(form.product_id)
      );
      const result = await addBatch({
        ...form,
        product_id: form.product_id ? Number(form.product_id) : null,
        quantity_kg: Number(form.quantity_kg),
        category: form.category || null,
      });

      setMessage(
        `Inventory added successfully. Batch ID: ${result.batch_id}.${
          selectedProduct
            ? ` Linked to marketplace product: ${selectedProduct.name}.`
            : " No marketplace product linked."
        }`
      );
      setForm(emptyForm);
      await loadProducts();
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

// Show loading screen while checking Cognito session
if (authLoading) {
  return <div className="auth-page">Loading FreshFarm...</div>;
}

// Show login/register if user is not authenticated
if (!authUser) {
  return <AuthPanel onLogin={refreshAuth} />;
}

// Render the existing FreshFarm application
return (
  <div className={`freshfarm-app ${authUser.role === "farmer" ? "farmer-app" : ""}`}>
      <header className="site-header">
        <button
          className="brand"
          onClick={() => {
            setPage(authUser.role === "farmer" ? "inventory" : "shop");
            setCartOpen(false);
          }}
          aria-label="FreshFarm home"
        >
          <span className="brand-icon">🌱</span>
          <span>
            FreshFarm
            <small>FROM FARM TO HOME</small>
          </span>
        </button>

        {authUser.role !== "farmer" && <div className="header-search">
          <span>⌕</span>
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage("shop");
            }}
            placeholder="Search vegetables, fruits, farmers..."
            aria-label="Search produce"
          />
          <button onClick={() => setPage("shop")}>Search</button>
        </div>}

        <nav className="header-actions">
        {authUser.role === "customer" && (
  <button
    className={`nav-link ${page === "orders" ? "active" : ""}`}
    onClick={() => {
      setPage("orders");
      setCartOpen(false);
      loadOrders();
    }}
  >
    My Orders
  </button>
)}
          {authUser.role !== "farmer" && <button
            className={`nav-link ${page === "shop" ? "active" : ""}`}
            onClick={() => {
              setPage("shop");
              setCartOpen(false);
            }}
          >
            Shop
          </button>}

          {authUser.role === "farmer" && (
  <button
    className={`nav-link ${page === "inventory" ? "active" : ""}`}
    onClick={() => {
      setPage("inventory");
      setCartOpen(false);
    }}
  >
    Inventory dashboard
  </button>
)}
          {authUser.role === "farmer" && (
            <button
              className={`nav-link ${page === "farmer-orders" ? "active" : ""}`}
              onClick={() => {
                setPage("farmer-orders");
                setCartOpen(false);
                loadFarmerOrders();
              }}
            >
              Orders
              {pendingFarmerOrderCount > 0 && (
                <span className="order-notification-badge" aria-label={`${pendingFarmerOrderCount} new orders`}>
                  {pendingFarmerOrderCount}
                </span>
              )}
            </button>
          )}
          {authUser.role !== "farmer" && <button
            className="cart-button"
            onClick={() => setCartOpen((open) => !open)}
          >
            ♧ Cart <span>{cartCount}</span>
          </button>}
          <span className="nav-link">{authUser.email}</span>

<button className="nav-link" onClick={handleLogout}>
  Sign out
</button>
        </nav>
      </header>

      <div className="announcement">
        <span>✳</span> Fresh from local farms, delivered closer to home.
        <span className="announcement-right">Buy direct. Support farmers.</span>
      </div>

      {profileSyncError && (
        <div className="profile-sync-warning" role="alert">
          Account profile sync failed: {profileSyncError}. Try refreshing the page.
        </div>
      )}

      {page === "shop" && (
        <main>
          <section className="market-hero">
            <div className="hero-copy">
              <span className="hero-label">
                <span>✳</span> GOOD FOOD. FAIRER PRICES.
              </span>
              <h1>
                From our farms
                <br />
                <span>to your table.</span>
              </h1>
              <p>
                Discover fresh produce straight from the people who grow it.
                Less middlemen, more goodness.
              </p>
              <button
                className="primary-button hero-button"
                onClick={() =>
                  document
                    .getElementById("produce")
                    ?.scrollIntoView({ behavior: "smooth" })
                }
              >
                Explore fresh produce <span>→</span>
              </button>

              <div className="hero-proof">
                <div className="proof-avatars">
                  <span>👨🏽‍🌾</span>
                  <span>👩🏽‍🌾</span>
                  <span>🧑🏽‍🌾</span>
                </div>
                <div>
                  <strong>Grown with care</strong>
                  <small>Supporting independent farmers</small>
                </div>
              </div>
            </div>

            <div className="hero-art">
              <img
                src="https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=1100&q=85"
                alt="Fresh vegetables and produce"
              />
              <div className="floating-note note-top">
                <span>🌿</span>
                <div>
                  <strong>Farm fresh</strong>
                  <small>Know where it grows</small>
                </div>
              </div>
              <div className="floating-note note-bottom">
                <span className="note-check">✓</span>
                <div>
                  <strong>Direct from farmers</strong>
                  <small>A more transparent food journey</small>
                </div>
              </div>
            </div>
          </section>

          <section className="benefit-strip">
            <article>
              <span>🌱</span>
              <div>
                <strong>Direct from farms</strong>
                <small>Know your growers</small>
              </div>
            </article>
            <article>
              <span>🥬</span>
              <div>
                <strong>Fresh produce</strong>
                <small>Harvest information</small>
              </div>
            </article>
            <article>
              <span>🤝</span>
              <div>
                <strong>Fairer sourcing</strong>
                <small>Support farm businesses</small>
              </div>
            </article>
            <article>
              <span>📦</span>
              <div>
                <strong>Convenient shopping</strong>
                <small>Browse from home</small>
              </div>
            </article>
          </section>

          <section className="produce-section" id="produce">
            <div className="section-title-row">
              <div>
                <span className="section-eyebrow">THE FARMER'S HARVEST</span>
                <h2>Good things, grown locally.</h2>
                <p>Find your everyday favourites, sourced closer to home.</p>
              </div>
              <span className="produce-count">
                {filteredProducts.length} products
              </span>
            </div>

            <div className="category-row">
              {categories.map((item) => (
                <button
                  key={item.name}
                  className={`category-chip ${
                    category === item.name ? "selected" : ""
                  }`}
                  onClick={() => setCategory(item.name)}
                >
                  <span>{item.emoji}</span>
                  {item.name}
                </button>
              ))}
              <label className="sort-control">
                <span>Sort:</span>
                <select value={sort} onChange={(e) => setSort(e.target.value)}>
                  <option value="featured">Featured</option>
                  <option value="price-low">Price: low to high</option>
                  <option value="price-high">Price: high to low</option>
                  <option value="name">Name: A–Z</option>
                </select>
              </label>
            </div>

            <div className="product-grid">
            

              {filteredProducts.map((product) => {
                const cartItem = cart.find((item) => item.id === product.id);

                return (
                  <article className="product-card" key={product.id}>
                    <div className="product-image">
                      <img
                        src={product.image}
                        alt={product.name}
                        loading="lazy"
                        onError={(event) => {
                          event.currentTarget.style.display = "none";
                          event.currentTarget.parentElement.classList.add(
                            "image-fallback"
                          );
                        }}
                      />
                      {product.tag && (
                        <span className="product-tag">{product.tag}</span>
                      )}
                      <button
                        className="favorite-button"
                        aria-label={`Save ${product.name}`}
                        title="Wishlist coming soon"
                        onClick={(event) => {
                          event.currentTarget.classList.toggle("favorited");
                        }}
                      >
                        ♡
                      </button>
                    </div>

                    <div className="product-content">
                      <div className="product-category">{product.category}</div>
                      <h3>{product.name}</h3>
                      <div className="farmer-line">
                        <span>⌂</span> {product.farmer}
                      </div>
                      <div className="location-line">⌖ {product.location}</div>

                      <div className="product-bottom">
                        <div className="price-block">
                          <strong>{formatPrice(product.price)}</strong>
                          <span>/{product.unit}</span>
                        </div>

                        {cartItem ? (
                          <div className="quick-quantity">
                            <button
                              onClick={() =>
                                updateCartQuantity(product.id, -1)
                              }
                              aria-label="Decrease quantity"
                            >
                              −
                            </button>
                            <span>{cartItem.quantity}</span>
                            <button
                              disabled={cartItem.quantity >= product.stock}
                              onClick={() =>
                                updateCartQuantity(product.id, 1)
                              }
                              aria-label="Increase quantity"
                            >
                              +
                            </button>
                          </div>
                        ) : (
                          <button
                            className="add-button"
                            onClick={() => addToCart(product)}
                          >
                            + Add
                          </button>
                        )}
                      </div>
                      <div className="stock-note">
                        {product.stock} {product.unit === "kg" ? "kg" : "units"}{" "}
                        available
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>

            {filteredProducts.length === 0 && (
              <div className="empty-state">
                <span>🔎</span>
                <h3>No produce found</h3>
                <p>Try another search term or category.</p>
                <button
                  className="primary-button"
                  onClick={() => {
                    setSearch("");
                    setCategory("All produce");
                  }}
                >
                  Clear filters
                </button>
              </div>
            )}
          </section>

          <section className="farmer-banner">
            <div className="farmer-banner-icon">👩🏽‍🌾</div>
            <div>
              <span className="section-eyebrow">GROW WITH US</span>
              <h2>Are you a farmer?</h2>
              <p>
                Bring your harvest directly to customers. Manage your
                inventory and grow your farm business with FreshFarm.
              </p>
            </div>
            <button
              className="primary-button"
              onClick={() => setPage("inventory")}
            >
              Open farmer portal <span>→</span>
            </button>
          </section>

          {orderMessage && (
            <div className="notice demo-notice">
              <strong>Order update</strong>
              <p>{orderMessage}</p>
            </div>
          )}
        </main>
      )}

      {page === "inventory" && (
        <main className="inventory-page">
          <section className="inventory-hero">
            <div>
              <span className="section-eyebrow">FARM OPERATIONS</span>
              <h1>Your inventory dashboard</h1>
              <p>
                Track every harvest, watch expiry dates and keep your farm
                documents close at hand.
              </p>
            </div>
            <button
              className="secondary-button"
              onClick={loadInventory}
              disabled={loading}
            >
              {loading ? "Refreshing..." : "↻ Refresh inventory"}
            </button>
          </section>

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
            <button
              className="stat-card stat-card-button"
              type="button"
              onClick={() => {
                setPage("farmer-orders");
                loadFarmerOrders();
              }}
            >
              <span>Orders to review</span>
              <strong>{pendingFarmerOrderCount}</strong>
              <small>View incoming orders</small>
            </button>
          </section>

          <section className="panel">
            <h2>Add inventory batch</h2>
            <p className="muted">Register a new harvest in your inventory.</p>

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
                Link marketplace product (optional)
                <select
                  value={form.product_id}
                  onChange={(event) =>
                    setForm({ ...form, product_id: event.target.value })
                  }
                >
                  <option value="">Inventory only — no marketplace link</option>
                  {farmerProducts.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name}{product.is_active ? "" : " (inactive listing)"}
                    </option>
                  ))}
                </select>
                <span className="muted">
                  Only your marketplace listings are shown. Linking keeps this batch and listing as separate records.
                </span>
              </label>

              {farmerProductsLoading && <p className="muted">Loading your marketplace products...</p>}
              {farmerProductsError && <p className="notice error">{farmerProductsError}</p>}
              {suggestedFarmerProduct && String(suggestedFarmerProduct.id) !== String(form.product_id) && (
                <div className="form-action">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() =>
                      setForm({ ...form, product_id: String(suggestedFarmerProduct.id) })
                    }
                  >
                    Link matching listing: {suggestedFarmerProduct.name}
                  </button>
                </div>
              )}

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
                <p className="muted">Live data from the existing API.</p>
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
                        batch.dynamic_status === "CRITICAL"
                          ? "status-critical"
                          : ""
                      }`}
                    >
                      {batch.dynamic_status || "UNKNOWN"}
                    </span>
                  </div>

                  <p className="muted">
                    {batch.category || "Uncategorized"}
                  </p>
                  <p className={`batch-product-link ${batch.product_id ? "is-linked" : "is-unlinked"}`}>
                    {batch.product_id
                      ? `Linked to ${batch.product_name || `marketplace product #${batch.product_id}`}`
                      : "No marketplace product linked"}
                  </p>
                  <div className="batch-details">
                    <p>
                      <span>Quantity</span>
                      <strong>{batch.quantity_kg} kg</strong>
                    </p>
                    <p>
                      <span>Expiry date</span>
                      <strong>
                        {batch.expiry_date
                          ? new Date(batch.expiry_date).toLocaleDateString()
                          : "Not set"}
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
                    <p className="muted document-missing">
                      No document linked
                    </p>
                  )}
                </article>
              ))}
            </div>
          </section>

          <section className="panel">
            <h2>Upload and link a document</h2>
            <p className="muted">
              Upload an invoice or report to the existing S3 integration.
            </p>

            <form
              onSubmit={handleUpload}
              className="upload-form"
            >
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

              <button
                disabled={!file || !selectedBatchId || uploading}
              >
                {uploading ? "Uploading..." : "Upload to S3 and link"}
              </button>
            </form>

            {uploadMessage && (
              <p className="notice">{uploadMessage}</p>
            )}
          </section>
        </main>
      )}
        {page === "farmer-orders" && authUser.role === "farmer" && (
          <main className="inventory-page farmer-orders-page">
            <section className="section-title-row farmer-orders-heading">
              <div>
                <span className="section-eyebrow">FARMER WORKSPACE</span>
                <h1>Incoming orders</h1>
                <p className="muted">
                  Orders for your products. New orders refresh automatically.
                </p>
              </div>
              <button
                className="primary-button"
                onClick={() => loadFarmerOrders()}
                disabled={farmerOrdersLoading}
              >
                {farmerOrdersLoading ? "Refreshing..." : "Refresh orders"}
              </button>
            </section>

            {pendingFarmerOrderCount > 0 && (
              <div className="farmer-order-alert" role="status">
                {pendingFarmerOrderCount} new order{pendingFarmerOrderCount === 1 ? "" : "s"} need review.
              </div>
            )}
            {farmerOrdersMessage && <p className="notice">{farmerOrdersMessage}</p>}
            {farmerOrdersError && <p className="notice error">{farmerOrdersError}</p>}
            {farmerOrdersLoading && <p>Loading orders for your products...</p>}
            {!farmerOrdersLoading && !farmerOrdersError && groupedFarmerOrders.length === 0 && (
              <div className="empty-state farmer-orders-empty">
                <span>ðŸ“¦</span>
                <h3>No incoming orders yet</h3>
                <p>Orders for your listed products will appear here.</p>
              </div>
            )}

            <div className="farmer-order-list">
              {groupedFarmerOrders.map((order) => {
                const allowedNextStatuses = nextOrderStatuses[order.status] || [];
                const farmSubtotal = order.items.reduce(
                  (total, item) => total + Number(item.line_total_paise || 0),
                  0
                );
                const isUpdating = updatingFarmerOrderId === String(order.id);

                return (
                  <article className="farmer-order-card" key={order.id}>
                    <div className="farmer-order-card-header">
                      <div>
                        <span className="section-eyebrow">ORDER #{order.id}</span>
                        <p>{new Date(order.created_at).toLocaleString("en-IN")}</p>
                      </div>
                      <span className={`farmer-order-status status-${order.status.toLowerCase()}`}>
                        {order.status.replaceAll("_", " ")}
                      </span>
                    </div>

                    <div className="farmer-order-items">
                      {order.items.map((item, index) => (
                        <div className="farmer-order-item" key={`${item.product_id}-${index}`}>
                          <div>
                            <strong>{item.product_name}</strong>
                            <span>{item.quantity} units</span>
                          </div>
                          <strong>{formatPrice(Number(item.line_total_paise) / 100)}</strong>
                        </div>
                      ))}
                    </div>

                    <div className="farmer-order-footer">
                      <div>
                        <span className="muted">Delivery address</span>
                        <p>{order.delivery_address}</p>
                      </div>
                      <strong className="farmer-order-total">
                        Your items: {formatPrice(farmSubtotal / 100)}
                      </strong>
                    </div>

                    {allowedNextStatuses.length > 0 && (
                      <div className="farmer-order-actions">
                        {allowedNextStatuses.map((status) => (
                          <button
                            className={status === "CANCELLED" ? "secondary-button danger-button" : "primary-button"}
                            key={status}
                            type="button"
                            disabled={isUpdating}
                            onClick={() => handleFarmerOrderStatus(order.id, status)}
                          >
                            {isUpdating ? "Updating..." : orderStatusLabels[status]}
                          </button>
                        ))}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </main>
        )}

        {page === "orders" && (
        <main className="inventory-page">
          <section>
            <div className="section-title-row">
              <div>
                <span className="section-eyebrow">CUSTOMER ACCOUNT</span>
                <h2>My Orders</h2>
                <p>Track your purchases and view order details.</p>
              </div>

              <button
                className="primary-button"
                onClick={loadOrders}
                disabled={ordersLoading}
              >
                {ordersLoading ? "Refreshing..." : "Refresh"}
              </button>
            </div>

            {ordersLoading && <p>Loading your orders...</p>}

            {ordersError && (
              <p className="notice">{ordersError}</p>
            )}

            {!ordersLoading && !ordersError && orders.length === 0 && (
              <p>You haven't placed any orders yet.</p>
            )}

            <div className="orders-list">
              {orders.map((order) => (
                <article className="order-card" key={order.id}>
                  <div className="section-title-row">
                    <div>
                      <h3>Order #{order.id}</h3>
                      <p>
                        {new Date(order.created_at).toLocaleString("en-IN")}
                      </p>
                    </div>

                    <div>
                      <strong>{order.order_status}</strong>
                      <p>{order.payment_status}</p>
                    </div>
                  </div>

                  <p>
                    <strong>Total:</strong>{" "}
                    {formatPrice(Number(order.total_paise) / 100)}
                  </p>

                  <p>
                    <strong>Delivery address:</strong>{" "}
                    {order.delivery_address}
                  </p>

                  <button
                    className="nav-link"
                    onClick={() => toggleOrderDetails(order.id)}
                  >
                    {expandedOrder === order.id
                      ? "Hide details"
                      : "View details"}
                  </button>

                  {expandedOrder === order.id && (
                    <div>
                      {!orderDetails[order.id] ? (
                        <p>Loading order details...</p>
                      ) : (
                        <>
                          <h4>Items</h4>
                          {orderDetails[order.id].items?.map((item, index) => (
                            <p key={index}>
                              {item.product_name} ({item.unit}) × {item.quantity}
                            </p>
                          ))}

                          <h4>Order history</h4>
                          {orderDetails[order.id].history?.map((entry, index) => (
                            <p key={index}>
                              {entry.status} —{" "}
                              {new Date(entry.changed_at).toLocaleString("en-IN")}
                              {entry.notes ? ` (${entry.notes})` : ""}
                            </p>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        </main>
      )}
      {cartOpen && (
        
        <div
          className="drawer-backdrop"
          onClick={() => setCartOpen(false)}
        >
          <aside
            className="cart-drawer"
            onClick={(event) => event.stopPropagation()}
            aria-label="Shopping cart"
          >
            <div className="drawer-heading">
              <div>
                <span className="section-eyebrow">YOUR SELECTION</span>
                <h2>Your basket ({cartCount})</h2>
              </div>
              <button
                className="close-button"
                onClick={() => setCartOpen(false)}
                aria-label="Close cart"
              >
                ×
              </button>
            </div>

            {cart.length === 0 ? (
              <div className="empty-cart">
                <span>🧺</span>
                <h3>Your basket is empty</h3>
                <p>Discover something fresh from the farms.</p>
                <button
                  className="primary-button"
                  onClick={() => setCartOpen(false)}
                >
                  Continue shopping
                </button>
              </div>
            ) : (
              <>
                <div className="cart-items">
                  {cart.map((item) => (
                    <article className="cart-item" key={item.id}>
                      <img src={item.image} alt={item.name} />
                      <div className="cart-item-info">
                        <strong>{item.name}</strong>
                        <span>{formatPrice(item.price)} / {item.unit}</span>
                        <div className="quick-quantity">
                          <button
                            onClick={() => updateCartQuantity(item.id, -1)}
                            aria-label="Decrease quantity"
                          >
                            −
                          </button>
                          <span>{item.quantity}</span>
                          <button
                            disabled={item.quantity >= item.stock}
                            onClick={() => updateCartQuantity(item.id, 1)}
                            aria-label="Increase quantity"
                          >
                            +
                          </button>
                        </div>
                      </div>
                      <div className="cart-item-price">
                        {formatPrice(item.price * item.quantity)}
                        <button
                          className="remove-button"
                          onClick={() => removeFromCart(item.id)}
                        >
                          Remove
                        </button>
                      </div>
                    </article>
                  ))}
                </div>

                <div className="cart-summary">
                  <div>
                    <span>Subtotal</span>
                    <strong>{formatPrice(cartTotal)}</strong>
                  </div>
                  <small>
                    Demo pricing. Delivery charges are not included.
                  </small>
                  <button
                    className="primary-button checkout-button"
                    onClick={() => {
                      setCartOpen(false);
                      setCheckoutOpen(true);
                    }}
                  >
                    Continue to checkout →
                  </button>
                </div>
              </>
            )}
          </aside>
        </div>
      )}

      {checkoutOpen && (
        <div
          className="modal-backdrop"
          onClick={() => setCheckoutOpen(false)}
        >
          <section
            className="checkout-modal"
            onClick={(event) => event.stopPropagation()}
            aria-label="Checkout"
          >
            <div className="drawer-heading">
              <div>
                <span className="section-eyebrow">ALMOST THERE</span>
                <h2>Delivery details</h2>
              </div>
              <button
                className="close-button"
                onClick={() => setCheckoutOpen(false)}
                aria-label="Close checkout"
              >
                ×
              </button>
            </div>

            <p className="muted">
              Confirm your delivery details to place your order. Payment is not collected in this checkout.
            </p>

            <form className="checkout-form" onSubmit={handleCheckout}>
              <label>
                Your name
                <input
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  required
                  placeholder="Enter your name"
                />
              </label>

              <label>
                Delivery address
                <textarea
                  value={customerAddress}
                  onChange={(e) => setCustomerAddress(e.target.value)}
                  required
                  rows={3}
                  placeholder="Enter your delivery address"
                />
              </label>

              <div className="checkout-total">
                <span>Order total</span>
                <strong>{formatPrice(cartTotal)}</strong>
              </div>

              <button className="primary-button checkout-button" type="submit" disabled={orderSubmitting}>
                {orderSubmitting ? "Placing order..." : "Place order"}
              </button>
            </form>
          </section>
        </div>
      )}

      <footer className="site-footer">
        <div className="footer-brand">
          <span>🌱</span> FreshFarm
        </div>
        <p>Good food. Fairer prices. A closer connection to the farm.</p>
        <small>FreshFarm 2.0 · Marketplace prototype</small>
      </footer>
    </div>
  );
}
