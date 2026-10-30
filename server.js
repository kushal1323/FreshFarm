import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import cron from 'node-cron';
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

const app = express();
app.use(cors());
app.use(express.json());

const REGION = process.env.AWS_REGION || 'eu-north-1';

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
    console.warn('Cognito parameters missing in SSM; operating in mock-auth mode only.');
  }
}

// ---------------- AUTHENTICATION & ROLE MIDDLEWARE ----------------
const authenticateUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  // Mode A: Valid Cognito Bearer Token
  if (authHeader && authHeader.startsWith('Bearer ') && jwtVerifier) {
    const token = authHeader.split(' ')[1];
    try {
      const payload = await jwtVerifier.verify(token);
      const [rows] = await dbPool.query('SELECT * FROM users WHERE cognito_sub = ?', [payload.sub]);

      if (rows.length === 0) {
        return res.status(401).json({
          success: false,
          message: 'User authenticated with Cognito but not registered in database. Please call /api/users/sync.'
        });
      }
      req.user = rows[0];
      return next();
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Invalid or expired Cognito token', error: err.message });
    }
  }

  // Mode B: Mock Header Fallback (Preserves local tests and Person 1 mock flows)
  const userId = req.headers['x-user-id'] || 1;
  try {
    const [rows] = await dbPool.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid user authentication' });
    }
    req.user = rows[0];
    next();
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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

function getImageUrl(s3Key) {
  if (!s3Key) return null;
  return `https://${APP_CONFIG.s3_bucket}.s3.${REGION}.amazonaws.com/${s3Key}`;
}

// ---------------- USER SYNC & PROFILE ENDPOINTS ----------------

app.post('/api/users/sync', async (req, res) => {
  const { cognito_sub, name, email, phone, role, farm_name, farm_description, farm_location } = req.body;

  if (!cognito_sub || !name || !email) {
    return res.status(400).json({ success: false, message: 'cognito_sub, name, and email are required' });
  }

  const assignedRole = role === 'FARMER' ? 'FARMER' : 'CUSTOMER';
  const conn = await dbPool.getConnection();

  try {
    await conn.beginTransaction();

    await conn.execute(`
      INSERT INTO users (cognito_sub, name, email, phone, role)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE name = VALUES(name), phone = VALUES(phone)
    `, [cognito_sub, name, email, phone || null, assignedRole]);

    const [userRows] = await conn.query('SELECT id, role FROM users WHERE cognito_sub = ?', [cognito_sub]);
    const userId = userRows[0].id;

    if (assignedRole === 'FARMER' && farm_name) {
      await conn.execute(`
        INSERT INTO farmer_profiles (user_id, farm_name, description, location, verification_status)
        VALUES (?, ?, ?, ?, 'APPROVED')
        ON DUPLICATE KEY UPDATE farm_name = VALUES(farm_name), description = VALUES(description), location = VALUES(location)
      `, [userId, farm_name, farm_description || null, farm_location || 'Pending Verification']);
    }

    await conn.commit();
    res.json({ success: true, user_id: userId, role: assignedRole, message: 'User profile synced successfully' });
  } catch (err) {
    await conn.rollback();
    console.error('Error syncing user profile:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    conn.release();
  }
});

app.get('/api/users/me', authenticateUser, async (req, res) => {
  try {
    let profile = { ...req.user };
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
  const { fileName, fileType } = req.body;
  if (!fileName || !fileType) {
    return res.status(400).json({ success: false, message: 'File name and type required' });
  }

  const s3Key = `invoices/${Date.now()}-${fileName}`;
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
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to link document' });
  }
});

// ---------------- MARKETPLACE CATALOGUE ENDPOINTS ----------------

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
      WHERE p.is_active = 1 AND fp.verification_status = 'APPROVED'
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

    const formattedData = rows.map(row => ({
      id: row.id,
      name: row.name,
      category: row.category,
      price_paise: row.price_paise,
      unit: row.unit,
      available_quantity: parseFloat(row.available_quantity),
      image_url: getImageUrl(row.image_s3_key),
      farmer: {
        id: row.farmer_id,
        farm_name: row.farm_name
      }
    }));

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
      return res.status(404).json({ success: false, message: 'Product not found or inactive' });
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
      image_url: getImageUrl(row.image_s3_key),
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

app.post('/api/farmer/products', authenticateUser, requireRole('FARMER', 'ADMIN'), async (req, res) => {
  const { name, description, category, price_paise, unit, image_s3_key } = req.body;

  if (!name || !price_paise || !category) {
    return res.status(400).json({ success: false, message: 'Product name, price in paise, and category required' });
  }

  try {
    const [farmer] = await dbPool.query(
      'SELECT id, verification_status FROM farmer_profiles WHERE user_id = ?',
      [req.user.id]
    );

    if (farmer.length === 0 || farmer[0].verification_status !== 'APPROVED') {
      return res.status(403).json({ success: false, message: 'Only approved farmers can publish products' });
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

    const [product] = await dbPool.query('SELECT id FROM products WHERE id = ? AND farmer_id = ?', [id, farmer[0].id]);
    if (product.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found or not owned by you' });
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

// ---------------- TRANSACTIONAL ORDER PROCESSING ----------------

app.post('/api/orders', authenticateUser, async (req, res) => {
  const { items, delivery_address } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Cart items cannot be empty' });
  }
  if (!delivery_address || typeof delivery_address !== 'string') {
    return res.status(400).json({ success: false, message: 'Valid delivery address is required' });
  }

  const connection = await dbPool.getConnection();

  try {
    await connection.beginTransaction();

    let grandTotalPaise = 0;
    const preparedOrderItems = [];

    for (const item of items) {
      const { product_id, quantity } = item;
      const orderQty = parseFloat(quantity);

      if (!product_id || isNaN(orderQty) || orderQty <= 0) {
        throw new Error(`Invalid item quantity or product ID for item: ${JSON.stringify(item)}`);
      }

      const [productRows] = await connection.query(
        'SELECT id, price_paise, is_active FROM products WHERE id = ?',
        [product_id]
      );

      if (productRows.length === 0 || !productRows[0].is_active) {
        throw new Error(`Product ID ${product_id} is unavailable or inactive`);
      }

      const unitPricePaise = productRows[0].price_paise;
      const lineTotalPaise = Math.round(unitPricePaise * orderQty);
      grandTotalPaise += lineTotalPaise;

      // Lock batch rows with FOR UPDATE
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
    `, [req.user.id, grandTotalPaise, delivery_address]);

    const orderId = orderResult.insertId;

    for (const oi of preparedOrderItems) {
      await connection.execute(`
        INSERT INTO order_items (order_id, product_id, batch_id, quantity, unit_price_paise, line_total_paise)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [orderId, oi.product_id, oi.batch_id, oi.quantity, oi.unit_price_paise, oi.line_total_paise]);
    }

    await connection.execute(`
      INSERT INTO order_status_history (order_id, status, notes)
      VALUES (?, 'PLACED', 'Order placed with Demo Checkout')
    `, [orderId]);

    await connection.commit();

    if (APP_CONFIG.sns_topic_arn) {
      snsClient.send(new PublishCommand({
        TopicArn: APP_CONFIG.sns_topic_arn,
        Subject: `FreshFarm Order #${orderId} Confirmed`,
        Message: `New demo order #${orderId} placed for Rs. ${(grandTotalPaise / 100).toFixed(2)}.`
      })).catch(err => console.error('SNS publish error:', err));
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

app.get('/api/orders', authenticateUser, async (req, res) => {
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

app.get('/api/orders/:id', authenticateUser, async (req, res) => {
  const { id } = req.params;
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

app.patch('/api/farmer/orders/:id/status', authenticateUser, requireRole('FARMER', 'ADMIN'), async (req, res) => {
  const { id } = req.params;
  const { status, notes } = req.body;
  const validStatuses = ['PLACED', 'CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid order status' });
  }

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query('UPDATE orders SET order_status = ? WHERE id = ?', [status, id]);
    await conn.query(`
      INSERT INTO order_status_history (order_id, status, notes)
      VALUES (?, ?, ?)
    `, [id, status, notes || `Status changed to ${status}`]);

    await conn.commit();
    res.json({ success: true, message: `Order status updated to ${status}` });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, error: err.message });
  } finally {
    conn.release();
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
      let body = `WARNING: FreshFarm Cold-Chain Shelf Life Alert\n\n`;
      body += `Items nearing expiration:\n\n`;
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

// Bootstrap server
const PORT = process.env.PORT || 5000;
loadConfigFromSSM()
  .then(() => initDatabase())
  .then(() => {
    initCognitoVerifier();
    app.listen(PORT, () => {
      console.log(`FreshFarm API operating on port ${PORT}`);
    });
  });
