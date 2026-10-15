import type { QueryResultRow } from "pg";
import { dbPool } from "./database.js";

export const dbQuery = async <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
) => dbPool.query<T>(text, params);
