import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dbPool } from "../src/config/database.js";
import { logger } from "../src/config/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, "..", "migrations");

const ensureMigrationsTable = async (): Promise<void> => {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(128) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

const getAppliedVersions = async (): Promise<Set<string>> => {
  const result = await dbPool.query<{ version: string }>("SELECT version FROM schema_migrations");
  return new Set(result.rows.map((row) => row.version));
};

const applyMigration = async (version: string, sql: string): Promise<void> => {
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [version]);
    await client.query("COMMIT");
    logger.info({ version }, "Migration applied");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const run = async (): Promise<void> => {
  await ensureMigrationsTable();
  const applied = await getAppliedVersions();
  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  for (const file of files) {
    if (applied.has(file)) {
      logger.info({ version: file }, "Migration already applied");
      continue;
    }

    const fullPath = path.join(migrationsDir, file);
    const sql = await readFile(fullPath, "utf8");
    await applyMigration(file, sql);
  }
};

run()
  .then(async () => {
    await dbPool.end();
    logger.info("Migrations completed");
  })
  .catch(async (error: unknown) => {
    logger.error({ error }, "Migration failed");
    await dbPool.end();
    process.exit(1);
  });
