import pg from "pg";

const { Pool } = pg;

declare global {
  // eslint-disable-next-line no-var
  var operationsLedgerPgPool: pg.Pool | undefined;
}

export interface QueryExecutor {
  query<T = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

export function getFoundationDatabaseUrl() {
  return (
    process.env.OPERATIONS_LEDGER_DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    null
  );
}

export function isFoundationDatabaseConfigured() {
  return Boolean(getFoundationDatabaseUrl());
}

export function getFoundationDatabasePool() {
  const connectionString = getFoundationDatabaseUrl();

  if (!connectionString) {
    return null;
  }

  if (!global.operationsLedgerPgPool) {
    global.operationsLedgerPgPool = new Pool({ connectionString });
  }

  return global.operationsLedgerPgPool;
}

export async function withFoundationTransaction<T>(
  work: (client: QueryExecutor) => Promise<T>,
) {
  const pool = getFoundationDatabasePool();

  if (!pool) {
    return null;
  }

  const client = await pool.connect();

  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
