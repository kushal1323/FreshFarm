import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';
import mysql from 'mysql2/promise';

async function seed() {
  const ssm = new SSMClient({ region: 'eu-north-1' });
  const res = await ssm.send(new GetParametersCommand({
    Names: ['/freshfarm/db_host', '/freshfarm/db_user', '/freshfarm/db_name', '/freshfarm/db_password'],
    WithDecryption: true
  }));

  const cfg = {};
  res.Parameters.forEach(p => cfg[p.Name.replace('/freshfarm/', '')] = p.Value.trim());

  const conn = await mysql.createConnection({
    host: cfg.db_host,
    user: cfg.db_user,
    password: cfg.db_password,
    database: cfg.db_name
  });

  console.log('Seeding demo users and farmer profile...');

  // 1. Seed Customer
  await conn.query(`
    INSERT IGNORE INTO users (id, cognito_sub, name, email, phone, role)
    VALUES (1, 'mock-cognito-customer-1', 'Aarav Patel', 'aarav@freshfarm.test', '+919876543210', 'CUSTOMER')
  `);

  // 2. Seed Farmer User
  await conn.query(`
    INSERT IGNORE INTO users (id, cognito_sub, name, email, phone, role)
    VALUES (2, 'mock-cognito-farmer-1', 'Ramesh Kumar', 'ramesh@freshfarm.test', '+919876543211', 'FARMER')
  `);

  // 3. Seed Farmer Profile (Approved)
  await conn.query(`
    INSERT IGNORE INTO farmer_profiles (id, user_id, farm_name, description, location, verification_status)
    VALUES (1, 2, 'Green Valley Organic Farm', 'Pesticide-free vegetables from Punjab valley', 'Amritsar, Punjab', 'APPROVED')
  `);

  // 4. Seed Sample Products (price in integer paise: 6000 = Rs 60.00)
  await conn.query(`
    INSERT IGNORE INTO products (id, farmer_id, name, description, category, price_paise, unit, is_active)
    VALUES 
      (1, 1, 'Organic Vine Tomatoes', 'Naturally ripened, rich in lycopene', 'Vegetables', 6000, 'kg', 1),
      (2, 1, 'Fresh Spinach (Palak)', 'Crisp green leaves harvested at sunrise', 'Vegetables', 3500, 'bunch', 1),
      (3, 1, 'Himachal Royal Apples', 'Crisp mountain apples', 'Fruits', 14000, 'kg', 1)
  `);

  // 5. Link existing or new harvest batches to products
  await conn.query(`
    INSERT INTO batches (item_name, category, quantity_kg, harvest_date, expiry_date, status, product_id)
    VALUES 
      ('Organic Vine Tomatoes', 'Vegetables', 50.00, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 7 DAY), 'FRESH', 1),
      ('Fresh Spinach (Palak)', 'Vegetables', 25.00, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 3 DAY), 'FRESH', 2),
      ('Himachal Royal Apples', 'Fruits', 100.00, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 14 DAY), 'FRESH', 3)
    ON DUPLICATE KEY UPDATE quantity_kg = VALUES(quantity_kg);
  `);

  console.log('Seeding completed successfully!');
  await conn.end();
}

seed().catch(console.error);
