import fs from 'fs';
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';
import mysql from 'mysql2/promise';

async function run() {
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
    database: cfg.db_name,
    multipleStatements: true
  });

  console.log('Applying migration: 001_create_marketplace_tables.sql...');
  const sql = fs.readFileSync('./migrations/001_create_marketplace_tables.sql', 'utf8');
  await conn.query(sql);
  console.log('Migration executed successfully.');

  const [tables] = await conn.query('SHOW TABLES;');
  console.log('Updated tables:');
  console.table(tables);
  await conn.end();
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
