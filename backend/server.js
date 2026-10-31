import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import cron from 'node-cron';
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import {
  buildFarmerProfileDefaults,
  farmerProfileVerificationStatus,
  isVerifiedEmailClaim,
  resolveSyncedRole
} from './profile_sync.js';

const app = express();
app.use(cors());
app.use(express.json());

const REGION = process.env.AWS_REGION || 'eu-north-1';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const ssmClient = new SSMClient({ region: REGION });
const s3Client = new S3Client({ region: REGION });
const snsClient = new SNSClient({ region: REGION });

let dbPool;
let APP_CONFIG = {};
let jwtVerifier = null;

// 1. Retrieve runtime secrets dynamically from Systems Manager Parameter Store
async function loadConfigFromSSM() {
  const paramNames = [
    '/freshfarm/db_host',
    '/freshfarm/db_name',
    '/freshfarm/db_user',
    '/freshfarm/db_password',
    '/freshfarm/s3_bucket',
    '/freshfarm/sns_topic_arn',
    '/freshfarm/cognito_user_pool_id',
    '/freshfarm/cognito_client_id'
  ];

  try {
    const cmd = new GetParametersCommand({
      Names: paramNames,
      WithDecryption: true,
    });
    const response = await ssmClient.send(cmd);

    response.Parameters.forEach(param => {
      const key = param.Name.replace('/freshfarm/', '');
      APP_CONFIG[key] = param.Value.trim();
    });

    console.log('Successfully retrieved runtime configuration from SSM Parameter Store.');
  } catch (err) {
    console.error('Failed to load parameters from SSM:', err);
    process.exit(1);
  }
}

// 2. Initialize RDS MySQL Connection Pool
async function initDatabase() {
  dbPool = mysql.createPool({
    host: APP_CONFIG.db_host,
    user: APP_CONFIG.db_user,
    password: APP_CONFIG.db_password,
    database: APP_CONFIG.db_name,
    waitForConnections: true,
    connectionLimit: 15,
    queueLimit: 0
  });

  const conn = await dbPool.getConnection();
  console.log('Connected to Amazon RDS MySQL instance.');
  conn.release();
}

// 3. Initialize Cognito JWT Verifier
function initCognitoVerifier() {
  if (APP_CONFIG.cognito_user_pool_id && APP_CONFIG.cognito_client_id) {
    jwtVerifier = CognitoJwtVerifier.create({
      userPoolId: APP_CONFIG.cognito_user_pool_id,
      tokenUse: 'id',
      clientId: APP_CONFIG.cognito_client_id,
    });
    console.log('Cognito JWT verifier initialized successfully.');
  } else {
    console.warn('Cognito parameters missing in SSM; running in mock-auth mode only.');
  }
}

// ---------------- HEALTH CHECK ENDPOINTS (P2: #20, #21) ----------------
const healthHandler = async (req, res) => {
  try {
    const conn = await dbPool.getConnection();
    await conn.ping();
    conn.release();
    res.json({
      status: 'UP',
      database: 'CONNECTED',
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(503).json({ status: 'DOWN', database: 'DISCONNECTED', error: err.message });
  }
};

app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

// ---------------- AUTHENTICATION & ROLE MIDDLEWARE (P0: #3) ----------------
const authenticateUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  // Mode A: Cognito Token Validation
  if (authHeader && authHeader.startsWith('Bearer ') && jwtVerifier) {
    const token = authHeader.split(' ')[1];
    try {
      const payload = await jwtVerifier.verify(token);
      req.tokenPayload = payload;

      const [rows] = await dbPool.query('SELECT * FROM users WHERE cognito_sub = ?', [payload.sub]);
      if (rows.length === 0) {
        return res.status(401).json({
          success: false,
          message: 'User authenticated with Cognito but not registered in FreshFarm database. Please sync profile.'
        });
      }
      req.user = rows[0];
      return next();
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Invalid or expired Cognito token', error: err.message });
    }
  }

  // Mode B: Mock Header - RESTRICTED TO NON-PRODUCTION (P0: #3)
  if (!IS_PRODUCTION && req.headers['x-user-id']) {
    const userId = req.headers['x-user-id'];
    try {
      const [rows] = await dbPool.query('SELECT * FROM users WHERE id = ?', [userId]);
      if (rows.length === 0) {
        return res.status(401).json({ success: false, message: 'Mock user ID not found' });
      }
      req.user = rows[0];
      return next();
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(401).json({ success: false, message: 'Authorization required. Bearer token missing.' });
};

// Token-only middleware for initial sync (before user row exists in DB)
const authenticateTokenOnly = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ') || !jwtVerifier) {
    if (!IS_PRODUCTION && req.headers['x-mock-sub']) {
      req.tokenPayload = {
        sub: req.headers['x-mock-sub'],
        email: req.headers['x-mock-email'] || 'test@freshfarm.test'
      };
      return next();
    }
    return res.status(401).json({ success: false, message: 'Valid Bearer token required for user sync' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = await jwtVerifier.verify(token);
    req.tokenPayload = payload;
    next();
  } catch (err) {
    res.status(401).json({ success: false, message: 'Invalid token', error: err.message });
  }
};

const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: `Access denied. Requires role: ${roles.join(' or ')}` });
    }
    next();
  };
};

async function getProductImageUrl(s3Key) {
  if (!s3Key) return null;

  // Product images are stored as object keys, never as public S3 URLs.
  // Limit signing to the product image prefix to avoid turning this into an
  // arbitrary object URL signing endpoint.
  if (
    typeof s3Key !== 'string' ||
    !s3Key.startsWith('products/') ||
    s3Key.split('/').some(segment => !segment || segment === '.' || segment === '..')
  ) {
    console.warn('Skipped signing invalid product image S3 key.');
    return null;
  }

  try {
    const command = new GetObjectCommand({
      Bucket: APP_CONFIG.s3_bucket,
      Key: s3Key
    });
    return await getSignedUrl(s3Client, command, { expiresIn: 300 });
  } catch (error) {
    // Keep the catalogue available if an individual image cannot be signed;
    // the frontend's existing image fallback handles a null image_url.
    console.error('Failed to sign product image URL:', error);
    return null;
  }
}

// ---------------- USER SYNC & PROFILE ENDPOINTS (P0: #4, #5) ----------------

app.post('/api/users/sync', authenticateTokenOnly, async (req, res) => {
  const verifiedSub = req.tokenPayload.sub;
  const verifiedEmail = req.tokenPayload.email;
  const name = String(req.tokenPayload.name || req.body.name || verifiedEmail?.split('@')[0] || '').trim();
  const phone = req.tokenPayload.phone_number || req.body.phone || null;

  if (!isVerifiedEmailClaim(req.tokenPayload.email_verified)) {
    return res.status(403).json({ success: false, message: 'Verify your email before syncing your FreshFarm profile' });
  }

  if (!verifiedSub || !verifiedEmail || !name) {
    return res.status(400).json({ success: false, message: 'A verified Cognito subject, email, and name are required' });
  }

  let conn;
  try {
    conn = await dbPool.getConnection();
    await conn.beginTransaction();

    const cognitoRole = req.tokenPayload['custom:role'];
    const [existingUsers] = await conn.query(
      'SELECT id, role FROM users WHERE cognito_sub = ? FOR UPDATE',
      [verifiedSub]
    );
    let userId;
    let assignedRole;

    if (existingUsers.length > 0) {
      userId = existingUsers[0].id;
      assignedRole = resolveSyncedRole(existingUsers[0].role, cognitoRole);
      await conn.execute(
        'UPDATE users SET name = ?, phone = COALESCE(?, phone), role = ? WHERE id = ?',
        [name, phone, assignedRole, userId]
      );
    } else {
      assignedRole = resolveSyncedRole(null, cognitoRole);
      const [insertResult] = await conn.execute(
        'INSERT INTO users (cognito_sub, name, email, phone, role) VALUES (?, ?, ?, ?, ?)',
        [verifiedSub, name, verifiedEmail, phone, assignedRole]
      );
      userId = insertResult.insertId;
    }
    let farmerProfile = null;

    if (assignedRole === 'FARMER') {
      const { farmName, location, description } = buildFarmerProfileDefaults({
        name,
        email: verifiedEmail,
        body: req.body,
        tokenPayload: req.tokenPayload
      });
      await conn.execute(`
        INSERT INTO farmer_profiles (user_id, farm_name, description, location, verification_status)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE verification_status = VALUES(verification_status)
      `, [
        userId,
        farmName,
        description,
        location,
        farmerProfileVerificationStatus(assignedRole, req.tokenPayload.email_verified)
      ]);

      const [profileRows] = await conn.query(
        'SELECT id, farm_name, location, verification_status FROM farmer_profiles WHERE user_id = ?',
        [userId]
      );
      farmerProfile = profileRows[0] || null;
    }

    await conn.commit();
    res.json({
      success: true,
      user_id: userId,
      role: assignedRole,
      farmer_profile: farmerProfile,
      verification_status: farmerProfile?.verification_status || null,
      message: 'User profile synced successfully'
    });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('Error syncing profile:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        success: false,
        message: 'This verified email is already linked to a different FreshFarm account.'
      });
    }
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

app.get('/api/users/me', authenticateUser, async (req, res) => {
  try {
    const profile = { ...req.user };
    delete profile.cognito_sub;

    if (req.user.role === 'FARMER') {
      const [farmerRows] = await dbPool.query(
        'SELECT id AS farmer_id, farm_name, description, location, verification_status FROM farmer_profiles WHERE user_id = ?',
        [req.user.id]
      );
      if (farmerRows.length > 0) {
        profile.farmer_profile = farmerRows[0];
      }
    }

    res.json({ success: true, data: profile });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- EXISTING INVENTORY & DOCUMENT ENDPOINTS (PRESERVED) ----------------

app.get('/api/batches', async (req, res) => {
  try {
    const query = `
      SELECT
        id, item_name, category, quantity_kg, harvest_date, expiry_date,
        s3_document_key, product_id,
        DATEDIFF(expiry_date, CURDATE()) AS days_remaining,
        CASE
          WHEN DATEDIFF(expiry_date, CURDATE()) < 0 THEN 'EXPIRED'
          WHEN DATEDIFF(expiry_date, CURDATE()) <= 2 THEN 'CRITICAL'
          ELSE 'FRESH'
        END AS dynamic_status
      FROM batches
      ORDER BY expiry_date ASC
    `;
    const [rows] = await dbPool.query(query);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/batches', async (req, res) => {
  const { item_name, category, quantity_kg, harvest_date, expiry_date, s3_document_key, product_id } = req.body;
  if (!item_name || !quantity_kg || !harvest_date || !expiry_date) {
    return res.status(400).json({ success: false, message: 'Missing mandatory fields' });
  }

  try {
    const query = `
      INSERT INTO batches (item_name, category, quantity_kg, harvest_date, expiry_date, s3_document_key, product_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    const [result] = await dbPool.execute(query, [
      item_name, category, quantity_kg, harvest_date, expiry_date, s3_document_key || null, product_id || null
    ]);
    res.status(201).json({ success: true, batch_id: result.insertId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/documents/presigned-url', async (req, res) => {
  const { fileName, fileType, folder } = req.body;
  if (!fileName || !fileType) {
    return res.status(400).json({ success: false, message: 'File name and type required' });
  }

  const prefix = folder === 'products' ? 'products' : 'invoices';
  const s3Key = `${prefix}/${Date.now()}-${fileName}`;

  try {
    const command = new PutObjectCommand({
      Bucket: APP_CONFIG.s3_bucket,
      Key: s3Key,
      ContentType: fileType
    });
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
    res.json({ success: true, uploadUrl, s3Key });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/documents/download-url', async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ success: false, message: 'Key required' });

  try {
    const command = new GetObjectCommand({
      Bucket: APP_CONFIG.s3_bucket,
      Key: key
    });
    const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
    res.json({ success: true, downloadUrl });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/batches/:id/document', async (req, res) => {
  const { id } = req.params;
  const { s3Key } = req.body;

  if (!s3Key || !s3Key.startsWith('invoices/')) {
    return res.status(400).json({ success: false, message: 'A valid invoice S3 key is required' });
  }

  try {
    const [result] = await dbPool.query(
      'UPDATE batches SET s3_document_key = ? WHERE id = ?',
      [s3Key, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Batch not found' });
    }
    res.json({ success: true, message: 'Document linked to batch' });
  } catch{
    res.status(500).json({ success: false, message: 'Failed to link document' });
  }
});

// ---------------- MARKETPLACE CATALOGUE ENDPOINTS (P1: #7) ----------------

app.get('/api/products', async (req, res) => {
  const { category, search } = req.query;
  try {
    let sql = `
      SELECT 
        p.id, p.name, p.category, p.price_paise, p.unit, p.image_s3_key,
        fp.id AS farmer_id, fp.farm_name,
        COALESCE(SUM(CASE WHEN b.expiry_date >= CURDATE() THEN b.quantity_kg ELSE 0 END), 0) AS available_quantity
      FROM products p
      JOIN farmer_profiles fp ON p.farmer_id = fp.id
      LEFT JOIN batches b ON p.id = b.product_id
      WHERE p.is_active = 1
    `;
    const params = [];

    if (category) {
      sql += ` AND p.category = ?`;
      params.push(category);
    }
    if (search) {
      sql += ` AND (p.name LIKE ? OR p.description LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    sql += ` GROUP BY p.id, fp.id ORDER BY p.id DESC`;

    const [rows] = await dbPool.query(sql, params);

    const formattedData = await Promise.all(rows.map(async row => ({
      id: row.id,
      name: row.name,
      category: row.category,
      price_paise: row.price_paise,
      unit: row.unit,
      available_quantity: parseFloat(row.available_quantity),
      image_url: await getProductImageUrl(row.image_s3_key),
      farmer: {
        id: row.farmer_id,
        farm_name: row.farm_name
      }
    })));

    res.json({ success: true, data: formattedData, message: 'Products retrieved successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [productRows] = await dbPool.query(`
      SELECT 
        p.id, p.name, p.description, p.category, p.price_paise, p.unit, p.image_s3_key,
        fp.id AS farmer_id, fp.farm_name
      FROM products p
      JOIN farmer_profiles fp ON p.farmer_id = fp.id
      WHERE p.id = ? AND p.is_active = 1
    `, [id]);

    if (productRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found, inactive, or unapproved' });
    }

    const row = productRows[0];

    const [batchRows] = await dbPool.query(`
      SELECT quantity_kg
      FROM batches
      WHERE product_id = ? AND expiry_date >= CURDATE() AND quantity_kg > 0
    `, [id]);

    const totalStock = batchRows.reduce((sum, b) => sum + parseFloat(b.quantity_kg), 0);

    const formattedData = {
      id: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      price_paise: row.price_paise,
      unit: row.unit,
      available_quantity: totalStock,
      image_url: await getProductImageUrl(row.image_s3_key),
      farmer: {
        id: row.farmer_id,
        farm_name: row.farm_name
      }
    };

    res.json({ success: true, data: formattedData, message: 'Product retrieved successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- FARMER PRODUCT MANAGEMENT (P0: #6; P1: #8) ----------------

app.post('/api/farmer/products', authenticateUser, requireRole('FARMER', 'ADMIN'), async (req, res) => {
  const { name, description, category, price_paise, unit, image_s3_key } = req.body;

  if (!name || !price_paise || !category) {
    return res.status(400).json({ success: false, message: 'Product name, price_paise, and category are required' });
  }

  try {
    const [farmer] = await dbPool.query(
      'SELECT id FROM farmer_profiles WHERE user_id = ?',
      [req.user.id]
    );

    if (farmer.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Farmer profile not found'
      });
    }

    const [result] = await dbPool.execute(`
      INSERT INTO products (farmer_id, name, description, category, price_paise, unit, image_s3_key, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `, [farmer[0].id, name, description || null, category, price_paise, unit || 'kg', image_s3_key || null]);

    res.status(201).json({ success: true, product_id: result.insertId, message: 'Product created successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/farmer/products/:id', authenticateUser, requireRole('FARMER', 'ADMIN'), async (req, res) => {
  const { id } = req.params;
  const { name, description, category, price_paise, unit, is_active } = req.body;

  try {
    const [farmer] = await dbPool.query('SELECT id FROM farmer_profiles WHERE user_id = ?', [req.user.id]);
    if (farmer.length === 0) return res.status(403).json({ success: false, message: 'Farmer profile not found' });

    // Strict ownership verification (P0: #6)
    const [product] = await dbPool.query('SELECT id FROM products WHERE id = ? AND farmer_id = ?', [id, farmer[0].id]);
    if (product.length === 0) {
      return res.status(403).json({ success: false, message: 'Access denied: You do not own this product' });
    }

    await dbPool.execute(`
      UPDATE products 
      SET name = COALESCE(?, name),
          description = COALESCE(?, description),
          category = COALESCE(?, category),
          price_paise = COALESCE(?, price_paise),
          unit = COALESCE(?, unit),
          is_active = COALESCE(?, is_active)
      WHERE id = ?
    `, [name, description, category, price_paise, unit, is_active, id]);

    res.json({ success: true, message: 'Product updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- TRANSACTIONAL CHECKOUT & ORDERS (P1: #9, #10) ----------------

app.post('/api/orders', authenticateUser, requireRole('CUSTOMER'), async (req, res) => {
  const { items, delivery_address } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Cart items cannot be empty' });
  }
  if (!delivery_address || typeof delivery_address !== 'string' || delivery_address.trim().length === 0) {
    return res.status(400).json({ success: false, message: 'Valid delivery address is required' });
  }

  const connection = await dbPool.getConnection();

  try {
    await connection.beginTransaction();

    let grandTotalPaise = 0;
    const preparedOrderItems = [];

    for (const item of items) {
      const { product_id, quantity } = item;
      const orderQty = Number(quantity);

      if (!Number.isSafeInteger(Number(product_id)) || Number(product_id) <= 0 ||
          !Number.isFinite(orderQty) || orderQty <= 0 || orderQty > 99999999.99 ||
          Math.round(orderQty * 100) !== orderQty * 100) {
        throw new Error('Each order item must have a valid product ID and a positive quantity with at most two decimal places');
      }

      const [productRows] = await connection.query(
        `SELECT p.id, p.price_paise, p.is_active
         FROM products p
         JOIN farmer_profiles fp ON fp.id = p.farmer_id
         WHERE p.id = ?`,
        [product_id]
      );

      if (productRows.length === 0 || !productRows[0].is_active) {
        throw new Error(`Product ID ${product_id} is unavailable or inactive`);
      }

      const unitPricePaise = productRows[0].price_paise;
      const lineTotalPaise = Math.round(unitPricePaise * orderQty);
      grandTotalPaise += lineTotalPaise;

      // Atomic row-level locking via FOR UPDATE
      const [batches] = await connection.query(`
        SELECT id, quantity_kg 
        FROM batches 
        WHERE product_id = ? AND expiry_date >= CURDATE() AND quantity_kg > 0
        ORDER BY expiry_date ASC
        FOR UPDATE
      `, [product_id]);

      const availableStock = batches.reduce((sum, b) => sum + parseFloat(b.quantity_kg), 0);
      if (availableStock < orderQty) {
        throw new Error(`Insufficient stock for Product ID ${product_id}. Requested: ${orderQty}, Available: ${availableStock}`);
      }

      let remainingToDeduct = orderQty;
      let primaryBatchId = null;

      for (const batch of batches) {
        if (remainingToDeduct <= 0) break;
        if (!primaryBatchId) primaryBatchId = batch.id;

        const currentBatchQty = parseFloat(batch.quantity_kg);
        const deduction = Math.min(currentBatchQty, remainingToDeduct);

        await connection.query(
          'UPDATE batches SET quantity_kg = quantity_kg - ? WHERE id = ?',
          [deduction, batch.id]
        );

        remainingToDeduct -= deduction;
      }

      preparedOrderItems.push({
        product_id,
        batch_id: primaryBatchId,
        quantity: orderQty,
        unit_price_paise: unitPricePaise,
        line_total_paise: lineTotalPaise
      });
    }

    const [orderResult] = await connection.execute(`
      INSERT INTO orders (customer_id, total_paise, delivery_address, payment_status, order_status)
      VALUES (?, ?, ?, 'DEMO_PAID', 'PLACED')
    `, [req.user.id, grandTotalPaise, delivery_address.trim()]);

    const orderId = orderResult.insertId;

    for (const oi of preparedOrderItems) {
      await connection.execute(`
        INSERT INTO order_items (order_id, product_id, batch_id, quantity, unit_price_paise, line_total_paise)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [orderId, oi.product_id, oi.batch_id, oi.quantity, oi.unit_price_paise, oi.line_total_paise]);
    }

    await connection.execute(`
      INSERT INTO order_status_history (order_id, status, notes)
      VALUES (?, 'PLACED', 'Order placed successfully')
    `, [orderId]);

    await connection.commit();

    if (APP_CONFIG.sns_topic_arn) {
      snsClient.send(new PublishCommand({
        TopicArn: APP_CONFIG.sns_topic_arn,
        Subject: `FreshFarm Order #${orderId} Confirmed`,
        Message: `New order #${orderId} confirmed for customer #${req.user.id}. Total: ₹${(grandTotalPaise / 100).toFixed(2)}`
      })).catch(err => console.error('SNS order publish failed:', err));
    }

    res.status(201).json({
      success: true,
      order_id: orderId,
      total_paise: grandTotalPaise,
      payment_status: 'DEMO_PAID',
      message: 'Order created successfully'
    });
  } catch (err) {
    await connection.rollback();
    res.status(400).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

app.get('/api/orders', authenticateUser, requireRole('CUSTOMER'), async (req, res) => {
  try {
    const [orders] = await dbPool.query(`
      SELECT id, total_paise, delivery_address, payment_status, order_status, created_at
      FROM orders
      WHERE customer_id = ?
      ORDER BY id DESC
    `, [req.user.id]);
    res.json({ success: true, data: orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/orders/:id', authenticateUser, requireRole('CUSTOMER'), async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
    return res.status(400).json({ success: false, message: 'A valid order ID is required' });
  }
  try {
    const [orderRows] = await dbPool.query(
      'SELECT * FROM orders WHERE id = ? AND customer_id = ?',
      [id, req.user.id]
    );

    if (orderRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const [items] = await dbPool.query(`
      SELECT oi.*, p.name AS product_name, p.unit
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ?
    `, [id]);

    const [history] = await dbPool.query(`
      SELECT status, notes, changed_at
      FROM order_status_history
      WHERE order_id = ?
      ORDER BY changed_at ASC
    `, [id]);

    res.json({
      success: true,
      data: {
        ...orderRows[0],
        items,
        history
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- FARMER ORDER FULFILLMENT & STATE MACHINE (P0: #6; P1: #11) ----------------

app.get('/api/farmer/orders', authenticateUser, requireRole('FARMER', 'ADMIN'), async (req, res) => {
  try {
    const [farmer] = await dbPool.query('SELECT id FROM farmer_profiles WHERE user_id = ?', [req.user.id]);
    if (farmer.length === 0) return res.status(403).json({ success: false, message: 'Farmer profile not found' });

    const [rows] = await dbPool.query(`
      SELECT DISTINCT o.id AS order_id, o.order_status, o.created_at, o.delivery_address,
             oi.product_id, p.name AS product_name, oi.quantity, oi.unit_price_paise, oi.line_total_paise
      FROM orders o
      JOIN order_items oi ON o.id = oi.order_id
      JOIN products p ON oi.product_id = p.id
      WHERE p.farmer_id = ?
      ORDER BY o.id DESC
    `, [farmer[0].id]);

    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const VALID_TRANSITIONS = {
  'PLACED': ['CONFIRMED', 'CANCELLED'],
  'CONFIRMED': ['PACKED', 'CANCELLED'],
  'PACKED': ['OUT_FOR_DELIVERY'],
  'OUT_FOR_DELIVERY': ['DELIVERED'],
  'DELIVERED': [],
  'CANCELLED': []
};

app.patch('/api/farmer/orders/:id/status', authenticateUser, requireRole('FARMER', 'ADMIN'), async (req, res) => {
  const { id } = req.params;
  const { status, notes } = req.body;

  try {
    const [farmer] = await dbPool.query('SELECT id FROM farmer_profiles WHERE user_id = ?', [req.user.id]);
    if (farmer.length === 0) return res.status(403).json({ success: false, message: 'Farmer profile not found' });

    // Verify order contains products from this farmer (P0: #6)
    const [ownership] = await dbPool.query(`
      SELECT oi.id 
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ? AND p.farmer_id = ?
    `, [id, farmer[0].id]);

    if (ownership.length === 0) {
      return res.status(403).json({ success: false, message: 'Forbidden: You do not have items in this order' });
    }

    const [orderRows] = await dbPool.query('SELECT order_status FROM orders WHERE id = ?', [id]);
    if (orderRows.length === 0) return res.status(404).json({ success: false, message: 'Order not found' });

    const currentStatus = orderRows[0].order_status;
    const allowedNext = VALID_TRANSITIONS[currentStatus] || [];

    if (!allowedNext.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status transition from ${currentStatus} to ${status}. Allowed next states: ${allowedNext.join(', ') || 'None'}`
      });
    }

    const conn = await dbPool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.query('UPDATE orders SET order_status = ? WHERE id = ?', [status, id]);
      await conn.query(`
        INSERT INTO order_status_history (order_id, status, notes)
        VALUES (?, ?, ?)
      `, [id, status, notes || `Status updated from ${currentStatus} to ${status}`]);

      await conn.commit();
      res.json({ success: true, message: `Order #${id} status updated to ${status}` });
    } catch (txErr) {
      await conn.rollback();
      throw txErr;
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- EXPIRY AUDIT CRON ----------------
cron.schedule('0 6 * * *', async () => {
  if (!dbPool || !APP_CONFIG.sns_topic_arn) return;
  try {
    const [criticalItems] = await dbPool.query(`
      SELECT item_name, quantity_kg, expiry_date, DATEDIFF(expiry_date, CURDATE()) as days_left
      FROM batches
      WHERE DATEDIFF(expiry_date, CURDATE()) BETWEEN 0 AND 2
    `);

    if (criticalItems.length > 0) {
      let body = `WARNING: FreshFarm Cold-Chain Shelf Life Alert\n\nItems nearing expiration:\n\n`;
      criticalItems.forEach(item => {
        body += `- ${item.item_name} (${item.quantity_kg} kg): ${item.days_left} day(s) remaining\n`;
      });

      await snsClient.send(new PublishCommand({
        TopicArn: APP_CONFIG.sns_topic_arn,
        Subject: 'URGENT: Perishable Inventory Reaching Expiry',
        Message: body
      }));
    }
  } catch (err) {
    console.error('Expiry audit error:', err);
  }
});

// ---------------- BOOTSTRAP & GRACEFUL SHUTDOWN (P2: #20) ----------------
const PORT = process.env.PORT || 5000;

async function startServer() {
  await loadConfigFromSSM();
  await initDatabase();
  initCognitoVerifier();

  const server = app.listen(PORT, () => {
    console.log(`FreshFarm API operating on port ${PORT}`);
  });

  const shutdown = async (signal) => {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    server.close(async () => {
      console.log('HTTP server closed.');
      if (dbPool) {
        await dbPool.end();
        console.log('Database connections closed.');
      }
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer();
