import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger.js";

const database = new PGlite();
let initialization: Promise<void> | undefined;

export const dbPool = {
  query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) => {
    const result = await database.query<T>(text, params);
    return {
      rows: result.rows,
      rowCount: result.rows.length > 0 ? result.rows.length : (result.affectedRows ?? 0),
    };
  },
  end: () => database.close(),
};

const applyMigrations = async (): Promise<void> => {
  const migrationsDir = path.resolve(process.cwd(), "migrations");
  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await database.exec(sql);
  }

  logger.info({ persistenceMode: "mock" }, "Ephemeral mock store initialized");
};

export const connectDatabase = async (): Promise<void> => {
  initialization ??= applyMigrations();
  await initialization;
};
