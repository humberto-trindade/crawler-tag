import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connectDatabase, dbPool } from "../src/config/database.js";
import { getExecutionReport } from "../src/services/executionService.js";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

test("report query should handle 10k events under threshold", async () => {
  await connectDatabase();
  const client = dbPool;

  const auditId = randomUUID();
  const executionId = randomUUID();
  const templateId = randomUUID();

  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO templates (id, name, version, data, created_by) VALUES ($1, $2, 1, $3::jsonb, $4)`,
      [templateId, `Perf Template ${auditId}`, JSON.stringify({ keys: [] }), "perf"],
    );
    await client.query(
      `INSERT INTO audits (id, name, objective, urls, template_id, config_snapshot, status, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, 'configured', $7)`,
      [auditId, `Perf Audit ${auditId}`, "Perf", JSON.stringify([]), templateId, JSON.stringify({}), "perf"],
    );
    await client.query(
      `INSERT INTO executions (id, audit_id, version, status, platform, environment, config_snapshot, ignored_fields, warnings)
       VALUES ($1, $2, 1, 'completed', 'web', 'local', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb)`,
      [executionId, auditId],
    );

    for (let offset = 0; offset < 10_000; offset += 500) {
      const values: string[] = [];
      const params: unknown[] = [];
      for (let index = offset; index < offset + 500; index += 1) {
        const base = (index - offset) * 5;
        values.push(
          `($${base + 1}, $${base + 2}, NOW(), NULL, $${base + 3}, $${base + 4}, $${base + 5}, '{}'::jsonb, 'unknown', '{}'::jsonb, 'observed', 'high')`,
        );
        params.push(randomUUID(), executionId, "page_view", index % 2 === 0 ? "ga4" : "meta_pixel", "/perf");
      }
      await client.query(
        `INSERT INTO events
         (id, execution_id, timestamp, action_id, event_type, technology, url, parameters, consent_state, request_payload, status, correlation_confidence)
         VALUES ${values.join(",")}`,
        params,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
  }

  const startedAt = performance.now();
  const report = await getExecutionReport(executionId);
  const elapsedMs = performance.now() - startedAt;
  assert.equal(report.totals.events, 10_000);
  assert.ok(elapsedMs < 5_000);
});
