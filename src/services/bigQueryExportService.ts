/**
 * BigQuery export service.
 *
 * Reads finalized executions + events from PostgreSQL and writes them to BigQuery.
 * The service is a no-op when BIGQUERY_PROJECT_ID is not set, so local/dev
 * environments are not affected.
 *
 * Install the official SDK before enabling:
 *   npm install @google-cloud/bigquery
 *
 * Usage:
 *   import { exportExecutionToBigQuery } from "./bigQueryExportService.js";
 *   await exportExecutionToBigQuery(executionId);
 */

import { dbQuery } from "../config/db.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

type BQExecution = {
  execution_id: string;
  audit_id: string;
  audit_name: string;
  version: number;
  status: string;
  platform: string;
  environment: string;
  started_at: string | null;
  ended_at: string | null;
  events_count: number;
  actions_count: number;
  states_count: number;
  urls: unknown;
  warnings: unknown;
  ignored_fields: unknown;
  exported_at: string;
};

type BQEvent = {
  event_id: string;
  execution_id: string;
  audit_id: string;
  audit_name: string;
  version: number;
  environment: string;
  event_timestamp: string;
  event_date: string;
  action_id: string | null;
  action_type: string | null;
  action_sequence: number | null;
  event_type: string;
  technology: string;
  event_name: string | null;
  url: string;
  url_host: string | null;
  url_path: string | null;
  state_name: string | null;
  consent_state: string;
  status: string;
  correlation_confidence: string;
  parameters: unknown;
  exported_at: string;
};

// --------------------------------------------------------------------------
// BigQuery client (lazy-loaded; null when SDK not installed or not configured)
// --------------------------------------------------------------------------

let bqClient: unknown = null;

const getBqClient = async () => {
  if (!env.BIGQUERY_PROJECT_ID) return null;
  if (bqClient) return bqClient;
  try {
    // Dynamic import so the module is optional
    const { BigQuery } = await import("@google-cloud/bigquery" as string);
    const options: Record<string, unknown> = {
      projectId: env.BIGQUERY_PROJECT_ID,
      location: env.BIGQUERY_LOCATION,
    };
    if (env.BIGQUERY_KEY_FILE && !env.BIGQUERY_USE_ADC) {
      options.keyFilename = env.BIGQUERY_KEY_FILE;
    }
    bqClient = new (BigQuery as new (o: unknown) => unknown)(options);
    return bqClient;
  } catch {
    logger.warn("BigQuery SDK not available — install @google-cloud/bigquery to enable export");
    return null;
  }
};

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const extractHost = (url: string): string | null => {
  try { return new URL(url).hostname; } catch { return null; }
};

const extractPath = (url: string): string | null => {
  try { return new URL(url).pathname; } catch { return null; }
};

const toDateString = (ts: string): string => ts.slice(0, 10);

type BQClient = { dataset: (id: string) => { table: (id: string) => { insert: (rows: unknown[]) => Promise<void> } } };

const insert = async (table: string, rows: unknown[]) => {
  const client = await getBqClient();
  if (!client) return;
  const bq = client as BQClient;
  const dataset = bq.dataset(env.BIGQUERY_DATASET_ID);
  await dataset.table(table).insert(rows);
};

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/** Returns false when BigQuery is not configured (no-op). */
export const isBigQueryEnabled = (): boolean => Boolean(env.BIGQUERY_PROJECT_ID);

/**
 * Export a single completed execution (+ all its events) to BigQuery.
 * Safe to call multiple times — BigQuery WRITE_APPEND means duplicates are
 * possible; use the exported_at timestamp for deduplication if needed.
 */
export const exportExecutionToBigQuery = async (executionId: string): Promise<boolean> => {
  if (!isBigQueryEnabled()) return false;

  const BATCH = 500;
  const exportedAt = new Date().toISOString();

  try {
    // ---- execution row ----
    const execResult = await dbQuery<{
      id: string; audit_id: string; audit_name: string; version: number;
      status: string; platform: string; environment: string;
      started_at: string | null; ended_at: string | null;
      events_count: number; actions_count: number; results: { statesCount?: number };
      urls: unknown; warnings: unknown; ignored_fields: unknown;
    }>(
      `SELECT e.id, e.audit_id, a.name AS audit_name, e.version, e.status,
              e.platform, e.environment, e.started_at, e.ended_at,
              COUNT(DISTINCT ev.id)::int  AS events_count,
              COUNT(DISTINCT ac.id)::int  AS actions_count,
              e.results, e.warnings, e.ignored_fields,
              a.urls
       FROM executions e
       JOIN audits a       ON a.id = e.audit_id
       LEFT JOIN events ev ON ev.execution_id = e.id
       LEFT JOIN actions ac ON ac.execution_id = e.id
       WHERE e.id = $1
       GROUP BY e.id, a.name, a.urls`,
      [executionId],
    );

    const exec = execResult.rows[0];
    if (!exec) throw new Error(`Execution ${executionId} not found`);

    const bqExec: BQExecution = {
      execution_id: exec.id,
      audit_id: exec.audit_id,
      audit_name: exec.audit_name,
      version: exec.version,
      status: exec.status,
      platform: exec.platform,
      environment: exec.environment,
      started_at: exec.started_at,
      ended_at: exec.ended_at,
      events_count: exec.events_count,
      actions_count: exec.actions_count,
      states_count: exec.results?.statesCount ?? 0,
      urls: exec.urls,
      warnings: exec.warnings,
      ignored_fields: exec.ignored_fields,
      exported_at: exportedAt,
    };

    await insert("executions", [bqExec]);

    // ---- events (batched) ----
    let offset = 0;
    for (;;) {
      const evResult = await dbQuery<{
        id: string; timestamp: string; action_id: string | null;
        action_type: string | null; sequence: number | null;
        event_type: string; technology: string; event_name: string | null;
        url: string; state_name: string | null; consent_state: string;
        status: string; correlation_confidence: string; parameters: unknown;
      }>(
        `SELECT ev.id, ev.timestamp, ev.action_id, ac.action_type, ac.sequence,
                ev.event_type, ev.technology, ev.event_name, ev.url,
                ev.state_name, ev.consent_state, ev.status,
                ev.correlation_confidence, ev.parameters
         FROM events ev
         LEFT JOIN actions ac ON ac.id = ev.action_id
         WHERE ev.execution_id = $1
         ORDER BY ev.timestamp ASC
         LIMIT $2 OFFSET $3`,
        [executionId, BATCH, offset],
      );

      if (evResult.rows.length === 0) break;

      const bqEvents: BQEvent[] = evResult.rows.map(r => ({
        event_id: r.id,
        execution_id: executionId,
        audit_id: exec.audit_id,
        audit_name: exec.audit_name,
        version: exec.version,
        environment: exec.environment,
        event_timestamp: r.timestamp,
        event_date: toDateString(r.timestamp),
        action_id: r.action_id,
        action_type: r.action_type,
        action_sequence: r.sequence,
        event_type: r.event_type,
        technology: r.technology,
        event_name: r.event_name,
        url: r.url,
        url_host: extractHost(r.url),
        url_path: extractPath(r.url),
        state_name: r.state_name,
        consent_state: r.consent_state,
        status: r.status,
        correlation_confidence: r.correlation_confidence,
        parameters: r.parameters,
        exported_at: exportedAt,
      }));

      await insert("events", bqEvents);
      offset += evResult.rows.length;
      if (evResult.rows.length < BATCH) break;
    }

    logger.info({ executionId, offset }, "BigQuery export completed");
    return true;
  } catch (err) {
    logger.error({ executionId, err }, "BigQuery export failed");
    throw err;
  }
};
