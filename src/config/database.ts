import { Pool } from "pg";
import { env } from "./env.js";
import { logger } from "./logger.js";

export const dbPool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export const connectDatabase = async (): Promise<void> => {
  const client = await dbPool.connect();
  try {
    await client.query("SELECT 1");
    logger.info("Database connection established");
  } finally {
    client.release();
  }
};
