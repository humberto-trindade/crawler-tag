import { dbPool } from "./database.js";

export const dbQuery = async <T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
) => dbPool.query<T>(text, params);
