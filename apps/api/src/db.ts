import 'dotenv/config';
import { readFileSync } from 'node:fs';
import mysql, {
  type Pool,
  type PoolConnection,
  type RowDataPacket,
  type ResultSetHeader,
} from 'mysql2/promise';

export type Sql = Pool | PoolConnection;
export type SqlParameters = (string | number | boolean | Date | Buffer | null)[];
let pool: Pool | undefined;
export function getPool(): Pool {
  if (!pool) {
    if (!process.env.DB_NAME || !process.env.DB_USER)
      throw new Error('DB_NAME and DB_USER must identify a dedicated Quotient database.');
    if (
      !/^quot(ient|ing)[a-z0-9_-]*$/i.test(process.env.DB_NAME) ||
      /golf/i.test(process.env.DB_NAME)
    )
      throw new Error('Refusing to connect outside the dedicated Quotient database namespace.');
    const limit = Math.max(1, Math.min(20, Number(process.env.DB_CONNECTION_LIMIT) || 5));
    pool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      connectionLimit: limit,
      maxIdle: Math.min(2, limit - 1),
      idleTimeout: 60_000,
      waitForConnections: true,
      queueLimit: 50,
      connectTimeout: 10_000,
      charset: 'utf8mb4',
      timezone: 'Z',
      supportBigNumbers: true,
      bigNumberStrings: false,
      multipleStatements: false,
      ...(process.env.DB_SSL === '1'
        ? {
            ssl: {
              rejectUnauthorized: true,
              ...(process.env.DB_SSL_CA_FILE
                ? { ca: readFileSync(process.env.DB_SSL_CA_FILE, 'utf8') }
                : {}),
            },
          }
        : {}),
    });
    pool.on('connection', (connection) => {
      connection.query("SET time_zone = '+00:00'");
    });
  }
  return pool;
}
export async function rows<T extends RowDataPacket = RowDataPacket>(
  sql: string,
  parameters: SqlParameters = [],
  connection: Sql = getPool(),
): Promise<T[]> {
  const [result] = await connection.execute<T[]>(sql, parameters);
  return result;
}
export async function mutate(
  sql: string,
  parameters: SqlParameters = [],
  connection: Sql = getPool(),
): Promise<ResultSetHeader> {
  const [result] = await connection.execute<ResultSetHeader>(sql, parameters);
  return result;
}
export async function transaction<T>(fn: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await getPool().getConnection();
  try {
    // Explicit tenant/session row locks and unique keys guard writes. READ COMMITTED
    // avoids unrelated tenants deadlocking on empty secondary-index range locks.
    await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    const active = pool;
    pool = undefined;
    await active.end();
  }
}
