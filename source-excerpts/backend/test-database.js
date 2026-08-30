import { initDatabase, pool, dbConfig } from '../src/database.js';
try {
  await initDatabase();
  const result=await pool.query('SELECT current_database() AS database, current_user AS user, now() AS now');
  console.log('[OK] PostgreSQL conectado.');
  console.log(`Banco: ${result.rows[0].database}`);
  console.log(`Usuario: ${result.rows[0].user}`);
  console.log(`Host: ${dbConfig.host}:${dbConfig.port}`);
  await pool.end();
  process.exit(0);
} catch(error) {
  console.error('[ERRO] PostgreSQL:',error.message);
  try{await pool.end()}catch{}
  process.exit(1);
}
