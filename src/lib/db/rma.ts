import mysql from 'mysql2/promise';

const globalForRma = globalThis as unknown as {
  rmaReadPool?: mysql.Pool;
  rmaWritePool?: mysql.Pool;
};

export function rmaReadPool(): mysql.Pool {
  if (!globalForRma.rmaReadPool) {
    const required = ['RMA_DB_HOST', 'RMA_DB_USER', 'RMA_DB_PASS', 'RMA_DB_NAME'] as const;
    for (const k of required) {
      if (!process.env[k]) throw new Error(`Missing env: ${k}`);
    }
    globalForRma.rmaReadPool = mysql.createPool({
      host: process.env.RMA_DB_HOST,
      user: process.env.RMA_DB_USER,
      password: process.env.RMA_DB_PASS,
      database: process.env.RMA_DB_NAME,
      connectionLimit: 5,
      waitForConnections: true,
      charset: 'utf8mb4',
    });
  }
  return globalForRma.rmaReadPool;
}

export async function queryRma<T = unknown>(sql: string, params: (string | number | boolean | null)[] = []): Promise<T[]> {
  const [rows] = await rmaReadPool().execute(sql, params);
  return rows as T[];
}

export function rmaWritePool(): mysql.Pool {
  if (!globalForRma.rmaWritePool) {
    const required = ['RMA_WRITE_DB_HOST', 'RMA_WRITE_DB_USER', 'RMA_WRITE_DB_PASS', 'RMA_WRITE_DB_NAME'] as const;
    for (const k of required) {
      if (!process.env[k]) throw new Error(`Missing env: ${k}`);
    }
    globalForRma.rmaWritePool = mysql.createPool({
      host: process.env.RMA_WRITE_DB_HOST,
      user: process.env.RMA_WRITE_DB_USER,
      password: process.env.RMA_WRITE_DB_PASS,
      database: process.env.RMA_WRITE_DB_NAME,
      connectionLimit: 5,
      waitForConnections: true,
      charset: 'utf8mb4',
    });
  }
  return globalForRma.rmaWritePool;
}

export async function executeRmaWrite(sql: string, params: (string | number | boolean | null)[] = []): Promise<mysql.ResultSetHeader> {
  const [result] = await rmaWritePool().execute(sql, params);
  return result as mysql.ResultSetHeader;
}
