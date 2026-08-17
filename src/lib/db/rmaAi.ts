import mysql from 'mysql2/promise';

const globalForRmaAi = globalThis as unknown as {
  rmaAiPool?: mysql.Pool;
};

export function rmaAiPool(): mysql.Pool {
  if (!globalForRmaAi.rmaAiPool) {
    const required = ['RMA_AI_DB_HOST', 'RMA_AI_DB_USER', 'RMA_AI_DB_PASS', 'RMA_AI_DB_NAME'] as const;
    for (const k of required) {
      if (!process.env[k]) throw new Error(`Missing env: ${k}`);
    }
    globalForRmaAi.rmaAiPool = mysql.createPool({
      host: process.env.RMA_AI_DB_HOST,
      user: process.env.RMA_AI_DB_USER,
      password: process.env.RMA_AI_DB_PASS,
      database: process.env.RMA_AI_DB_NAME,
      connectionLimit: 5,
      waitForConnections: true,
      charset: 'utf8mb4',
    });
  }
  return globalForRmaAi.rmaAiPool;
}

type Param = string | number | boolean | null;

export async function queryRmaAi<T = unknown>(sql: string, params: Param[] = []): Promise<T[]> {
  const [rows] = await rmaAiPool().execute(sql, params);
  return rows as T[];
}

export async function executeRmaAi(sql: string, params: Param[] = []): Promise<mysql.ResultSetHeader> {
  const [result] = await rmaAiPool().execute(sql, params);
  return result as mysql.ResultSetHeader;
}
