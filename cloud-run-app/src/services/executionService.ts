import { randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import { stringify } from "csv-stringify/sync";
import { dbQuery } from "../config/db.js";
import { HttpError } from "../lib/http.js";
import { executionEvents } from "../realtime/executionEvents.js";
import { exploreJourneys } from "../crawler/explorer.js";
import { selectCrawlEngine } from "../crawler/crawlerBridge.js";
import { getAuditById } from "./auditService.js";
import { getTemplateLatest } from "./templateService.js";

type ExecutionRow = {
  id: string;
  audit_id: string;
  version: number;
  status: string;
  platform: string;
  environment: string;
  started_at: string | null;
  ended_at: string | null;
  config_snapshot: unknown;
  pause_checkpoint: unknown;
  results: unknown;
  ignored_fields: unknown;
  warnings: unknown;
  created_at: string;
  events_count?: number;
  actions_count?: number;
};

type EventRow = {
  id: string;
  execution_id: string;
  timestamp: string;
  action_id: string | null;
  event_type: string;
  technology: string;
  url: string;
  state_name: string | null;
  event_name: string | null;
  parameters: Record<string, unknown>;
  consent_state: string;
  request_payload: Record<string, unknown>;
  status: string;
  correlation_confidence: string;
  created_at: string;
};

type ActionRow = {
  id: string;
  execution_id: string;
  sequence: number;
  action_type: string;
  target_selector: string | null;
  state_before: string | null;
  state_after: string | null;
  timestamp: string;
};

type EventQueryFilters = {
  technology?: string;
  eventType?: string;
  url?: string;
  consentState?: string;
  sort?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

type EventPageResult = {
  items: EventRow[];
  meta: {
    total: number;
    returned: number;
    limit: number;
    offset: number;
    isPartial: boolean;
    sort: "asc" | "desc";
  };
};

const mapExecution = (row: ExecutionRow) => {
  const parsedResults = (row.results ?? null) as
    | { eventsCount?: number; statesCount?: number; actionsCount?: number; stateScreenshots?: Record<string, string> }
    | null;
  const mergedResults = {
    ...(parsedResults ?? {}),
    eventsCount:
      parsedResults?.eventsCount ??
      (typeof row.events_count === "number" ? row.events_count : 0),
    actionsCount:
      parsedResults?.actionsCount ??
      (typeof row.actions_count === "number" ? row.actions_count : 0),
    stateScreenshots: parsedResults?.stateScreenshots ?? {},
  };

  return {
  id: row.id,
  auditId: row.audit_id,
  version: row.version,
  status: row.status,
  platform: row.platform,
  environment: row.environment,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  configSnapshot: row.config_snapshot,
  pauseCheckpoint: row.pause_checkpoint,
  results: mergedResults,
  ignoredFields: row.ignored_fields,
  warnings: row.warnings,
  createdAt: row.created_at,
  };
};

const requireExecutionRow = (rows: ExecutionRow[], message: string): ExecutionRow => {
  const row = rows[0];
  if (!row) {
    throw new HttpError(404, message);
  }
  return row;
};

let running = false;
const queue: string[] = [];

export const loadQueueFromDatabase = async () => {
  try {
    const result = await dbQuery<{ id: string }>(
      `SELECT id FROM executions WHERE status = 'queued' ORDER BY created_at ASC`,
      [],
    );
    queue.push(...result.rows.map(row => row.id));
    if (result.rows.length > 0) {
      console.log(`[Queue] Loaded ${result.rows.length} queued executions from database`);
      void processQueue();
    }
  } catch (error) {
    console.error('[Queue] Error loading queued executions:', error);
  }
};

const processQueue = async () => {
  if (running || queue.length === 0) {
    return;
  }
  running = true;
  const executionId = queue.shift();
  if (!executionId) {
    running = false;
    return;
  }

  try {
    await runExecution(executionId);
  } catch (error) {
    // Ao falhar (timeout ou erro inesperado), recuperar contagens do que já foi gravado
    const countResult = await dbQuery<{ events_count: number; actions_count: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM events WHERE execution_id = $1) as events_count,
         (SELECT COUNT(*)::int FROM actions WHERE execution_id = $1) as actions_count`,
      [executionId],
    );
    const eventsCount = countResult.rows[0]?.events_count ?? 0;
    const actionsCount = countResult.rows[0]?.actions_count ?? 0;

    await dbQuery(
      `UPDATE executions
       SET status='failed',
           ended_at=NOW(),
           warnings = COALESCE(warnings, '[]'::jsonb) || $2::jsonb,
           results = COALESCE(results, '{}'::jsonb) || $3::jsonb
       WHERE id=$1`,
      [
        executionId,
        JSON.stringify([
          {
            type: "navigation_blocked",
            message: error instanceof Error ? error.message : "Execution failed unexpectedly",
          },
        ]),
        JSON.stringify({
          eventsCount,
          actionsCount,
          stopReason: error instanceof Error ? error.message : "unexpected_error",
        }),
      ],
    );
    executionEvents.publish({
      executionId,
      type: "status",
      data: { status: "failed", reason: error instanceof Error ? error.message : "unexpected_error" },
    });
  } finally {
    running = false;
    await processQueue();
  }
};

const insertActionsAndEvents = async (
  executionId: string,
  output: Awaited<ReturnType<typeof exploreJourneys>>,
) => {
  const normalizeWarningType = (type: string) => {
    if (type === "navigation_blocked") {
      // Backward-compatible fallback for environments where enum migration was not applied yet.
      return "spa_router";
    }
    return type;
  };

  const insertedActionIds = new Set<string>();

  for (const [index, action] of output.actions.entries()) {
    await dbQuery(
      `INSERT INTO actions (id, execution_id, sequence, action_type, target_selector, state_before, state_after, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
       ON CONFLICT (id) DO NOTHING`,
      [
        action.id,
        executionId,
        index,
        action.type,
        action.targetSelector,
        action.stateBefore,
        action.stateAfter,
        action.timestamp,
      ],
    );
    insertedActionIds.add(action.id);
  }

  for (const event of output.events) {
    const safeActionId = event.actionId && insertedActionIds.has(event.actionId) ? event.actionId : null;
    await dbQuery(
      `INSERT INTO events
       (id, execution_id, timestamp, action_id, event_type, technology, url, state_name, event_name, parameters, consent_state, request_payload, status, correlation_confidence)
       VALUES
       ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13::event_status, $14)
       ON CONFLICT (id) DO NOTHING`,
      [
        event.id,
        executionId,
        event.timestamp,
        safeActionId,
        event.eventType,
        event.technology,
        event.url,
        event.stateName,
        event.eventName,
        JSON.stringify(event.parameters ?? {}),
        event.consentState ?? "unknown",
        JSON.stringify(event.requestPayload ?? { source: "crawler" }),
        event.status,
        event.correlationConfidence,
      ],
    );
  }

  for (const warning of output.warnings) {
    await dbQuery(
      `INSERT INTO warnings (id, execution_id, type, message, first_detected_at, count)
       VALUES ($1, $2, $3::warning_type, $4, NOW(), 1)`,
      [randomUUID(), executionId, normalizeWarningType(warning.type), warning.message],
    );
  }
};

const runExecution = async (executionId: string) => {
  const execution = await getExecutionById(executionId);
  if (execution.status === "paused") {
    return;
  }

  await dbQuery(
    `UPDATE executions SET status = 'running', started_at = COALESCE(started_at, NOW()) WHERE id = $1`,
    [executionId],
  );
  executionEvents.publish({ executionId, type: "status", data: { status: "running" } });

  const audit = await getAuditById(execution.auditId);
  const template = audit.templateId ? await getTemplateLatest(audit.templateId) : null;
  const templateKeys = (template?.data as { keys?: Array<Record<string, unknown>> } | undefined)?.keys ?? [];
  const maxDurationMinutes = Math.min(
    180,
    Math.max(
      1,
      Number(
        (audit.config as { maxDurationMinutes?: number } | undefined)?.maxDurationMinutes ?? 45,
      ),
    ),
  );
  const maxDurationMs = maxDurationMinutes * 60_000;
  const timeoutError = new Error(
    `Execution exceeded max duration (${maxDurationMinutes} min) without completion`,
  );

  const crawlerConfig = {
    urls: audit.urls as Array<{
      url: string;
      depth: number;
      maxActions: number;
      maxStates: number;
      allowedDomains: string[];
      singleUrlMode?: boolean;
    }>,
    templateKeys: templateKeys as Array<{
      key: string;
      value: string;
      matchers?: {
        attributes?: string[];
        labels?: string[];
        types?: string[];
        autocomplete?: string[];
        placeholders?: string[];
      };
    }>,
    // Pass session cookies from audit config to the crawler for Cloudflare bypass
    browserMode: (audit.config as { browserMode?: "headless" | "visual" } | undefined)?.browserMode ?? "headless",
  };

  let timeoutHandle: NodeJS.Timeout | undefined;
  let closeBrowserFn: (() => Promise<void>) | null = null;  // Registrado via onBrowserReady hook
  // Track dados parciais inseridos incremetalmente via onStateVisited
  const insertedActionIds = new Set<string>();
  let lastPartialSnapshot: {
    eventsCount: number;
    actionsCount: number;
    statesDiscovered: number;
    stateScreenshots: Record<string, string>;
    ignoredFields: unknown[];
    warnings: unknown[];
  } | null = null;

  const insertPartialSnapshot = async (snapshot: {
    actions: Awaited<ReturnType<typeof exploreJourneys>>["actions"];
    events: Awaited<ReturnType<typeof exploreJourneys>>["events"];
    ignoredFields: Awaited<ReturnType<typeof exploreJourneys>>["ignoredFields"];
    warnings: Awaited<ReturnType<typeof exploreJourneys>>["warnings"];
    statesDiscovered: number;
    stateScreenshots: Record<string, string>;
  }) => {
    // Inserir apenas ações novas (ON CONFLICT DO NOTHING para idempotência)
    for (const [index, action] of snapshot.actions.entries()) {
      if (insertedActionIds.has(action.id)) continue;
      try {
        await dbQuery(
          `INSERT INTO actions (id, execution_id, sequence, action_type, target_selector, state_before, state_after, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
           ON CONFLICT (id) DO NOTHING`,
          [action.id, executionId, index, action.type, action.targetSelector, action.stateBefore, action.stateAfter, action.timestamp],
        );
        insertedActionIds.add(action.id);
      } catch { /* ignorar conflitos */ }
    }

    // Inserir apenas eventos novos
    for (const event of snapshot.events) {
      const safeActionId = event.actionId && insertedActionIds.has(event.actionId) ? event.actionId : null;
      try {
        await dbQuery(
          `INSERT INTO events
           (id, execution_id, timestamp, action_id, event_type, technology, url, state_name, event_name, parameters, consent_state, request_payload, status, correlation_confidence)
           VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13::event_status, $14)
           ON CONFLICT (id) DO NOTHING`,
          [
            event.id, executionId, event.timestamp, safeActionId,
            event.eventType, event.technology, event.url, event.stateName,
            event.eventName, JSON.stringify(event.parameters ?? {}),
            event.consentState ?? "unknown",
            JSON.stringify(event.requestPayload ?? { source: "crawler" }),
            event.status, event.correlationConfidence,
          ],
        );
      } catch { /* ignorar conflitos */ }
    }

    // Atualizar results com contadores correntes
    lastPartialSnapshot = {
      eventsCount: snapshot.events.length,
      actionsCount: snapshot.actions.length,
      statesDiscovered: snapshot.statesDiscovered,
      stateScreenshots: snapshot.stateScreenshots,
      ignoredFields: snapshot.ignoredFields,
      warnings: snapshot.warnings,
    };

    await dbQuery(
      `UPDATE executions SET results=$2::jsonb WHERE id=$1`,
      [
        executionId,
        JSON.stringify({
          eventsCount: snapshot.events.length,
          statesCount: snapshot.statesDiscovered,
          actionsCount: snapshot.actions.length,
          stopReason: "in_progress",
          stateScreenshots: snapshot.stateScreenshots,
        }),
      ],
    );
  };

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        // Fechar o browser explicitamente para não deixar processos Chrome zumbis
        if (closeBrowserFn) void closeBrowserFn();
        reject(timeoutError);
      }, maxDurationMs);
    });

    const output = (await Promise.race([
      selectCrawlEngine(crawlerConfig, {
        onProgress: (progress) => {
          executionEvents.publish({ executionId, type: "progress", data: progress });
        },
        onBrowserReady: (closeFn) => {
          closeBrowserFn = closeFn;
        },
        onStateVisited: (snapshot) => {
          // Fire-and-forget incremental save (não bloqueia o crawler)
          void insertPartialSnapshot(snapshot);
        },
      }),
      timeoutPromise,
    ])) as Awaited<ReturnType<typeof exploreJourneys>>;

    await insertActionsAndEvents(executionId, output);

    if (output.status === "paused") {
      await dbQuery(
        `UPDATE executions
         SET status='paused', pause_checkpoint=$2::jsonb, ignored_fields=$3::jsonb, warnings=$4::jsonb, results=$5::jsonb
         WHERE id=$1`,
        [
          executionId,
          JSON.stringify(output.pauseCheckpoint ?? {}),
          JSON.stringify(output.ignoredFields),
          JSON.stringify(output.warnings),
          JSON.stringify({
            eventsCount: output.events.length,
            statesCount: output.statesDiscovered,
            actionsCount: output.actions.length,
            stopReason: output.stopReason ?? "captcha_paused",
            stateScreenshots: output.stateScreenshots ?? {},
          }),
        ],
      );
      executionEvents.publish({ executionId, type: "status", data: { status: "paused" } });
      return;
    }

    if (output.status === "failed") {
      await dbQuery(
        `UPDATE executions
         SET status='failed', ended_at=NOW(), ignored_fields=$2::jsonb, warnings=$3::jsonb, results=$4::jsonb
         WHERE id=$1`,
        [
          executionId,
          JSON.stringify(output.ignoredFields),
          JSON.stringify(output.warnings),
          JSON.stringify({
            eventsCount: output.events.length,
            statesCount: output.statesDiscovered,
            actionsCount: output.actions.length,
            stopReason: output.stopReason ?? "error",
            stateScreenshots: output.stateScreenshots ?? {},
          }),
        ],
      );
      executionEvents.publish({ executionId, type: "status", data: { status: "failed" } });
      executionEvents.publish({
        executionId,
        type: "progress",
        data: {
          phase: "completed",
          currentUrl: "",
          queuedUrls: 0,
          actionsCount: output.actions.length,
          eventsCount: output.events.length,
          statesDiscovered: output.statesDiscovered,
          visitedUrls: [],
          message: "Execução falhou por ação sem mudança de estado",
        },
      });
      return;
    }

    await dbQuery(
      `UPDATE executions
       SET status='completed', ended_at=NOW(), ignored_fields=$2::jsonb, warnings=$3::jsonb, results=$4::jsonb
       WHERE id=$1`,
      [
        executionId,
        JSON.stringify(output.ignoredFields),
        JSON.stringify(output.warnings),
        JSON.stringify({
          eventsCount: output.events.length,
          statesCount: output.statesDiscovered,
          actionsCount: output.actions.length,
          stopReason: output.stopReason ?? "queue_exhausted",
          stateScreenshots: output.stateScreenshots ?? {},
        }),
      ],
    );
    executionEvents.publish({ executionId, type: "status", data: { status: "completed" } });
    executionEvents.publish({
      executionId,
      type: "progress",
      data: {
        phase: "completed",
        currentUrl: "",
        queuedUrls: 0,
        actionsCount: output.actions.length,
        eventsCount: output.events.length,
        statesDiscovered: output.statesDiscovered,
        visitedUrls: [],
        message: "Execução concluída",
      },
    });
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
};

export const createExecution = async (
  auditId: string,
  input: { platform: string; environment: string },
) => {
  const audit = await getAuditById(auditId);

  const versionResult = await dbQuery<{ next_version: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM executions WHERE audit_id = $1`,
    [auditId],
  );
  const nextVersionRow = versionResult.rows[0];
  if (!nextVersionRow) {
    throw new HttpError(500, "Unable to determine next execution version");
  }
  const version = nextVersionRow.next_version;

  const id = randomUUID();
  const snapshot = {
    urls: audit.urls,
    config: audit.config,
    templateId: audit.templateId,
  };
  const result = await dbQuery<ExecutionRow>(
    `INSERT INTO executions
       (id, audit_id, version, status, platform, environment, config_snapshot, ignored_fields, warnings)
     VALUES
       ($1, $2, $3, 'queued', $4, $5, $6::jsonb, '[]'::jsonb, '[]'::jsonb)
     RETURNING id, audit_id, version, status, platform, environment, started_at, ended_at, config_snapshot, pause_checkpoint, results, ignored_fields, warnings, created_at`,
    [id, auditId, version, input.platform, input.environment, JSON.stringify(snapshot)],
  );

  queue.push(id);
  executionEvents.publish({ executionId: id, type: "status", data: { status: "queued" } });
  void processQueue();
  return mapExecution(requireExecutionRow(result.rows, "Execution creation failed"));
};

export const getExecutionById = async (
  executionId: string,
  options: { includeDetails?: boolean } = {},
) => {
  const result = await dbQuery<ExecutionRow>(
    `SELECT id, audit_id, version, status, platform, environment, started_at, ended_at, config_snapshot, pause_checkpoint, results, ignored_fields, warnings, created_at
     FROM executions WHERE id = $1`,
    [executionId],
  );

  if (result.rowCount === 0) {
    throw new HttpError(404, "Execution not found");
  }

  const execution = mapExecution(requireExecutionRow(result.rows, "Execution not found"));

  if (!options.includeDetails) {
    return execution;
  }

  // Load events for this execution
  const eventsResult = await dbQuery<EventRow>(
    `SELECT id, execution_id, timestamp, action_id, event_type, technology, url, state_name, event_name, parameters, consent_state, request_payload, status, correlation_confidence, created_at
     FROM events WHERE execution_id = $1 ORDER BY created_at ASC`,
    [executionId],
  );

  // Load actions for this execution
  const actionsResult = await dbQuery<ActionRow>(
    `SELECT id, execution_id, sequence, action_type, target_selector, state_before, state_after, timestamp
     FROM actions WHERE execution_id = $1 ORDER BY sequence ASC`,
    [executionId],
  );

  return {
    ...execution,
    events: eventsResult.rows.map(row => ({
      id: row.id,
      executionId: row.execution_id,
      timestamp: row.timestamp,
      actionId: row.action_id,
      eventType: row.event_type,
      technology: row.technology,
      url: row.url,
      stateName: row.state_name,
      eventName: row.event_name,
      parameters: row.parameters as Record<string, unknown>,
      consentState: row.consent_state,
      requestPayload: row.request_payload as Record<string, unknown>,
      status: row.status,
      correlationConfidence: row.correlation_confidence,
      createdAt: row.created_at,
    })),
    actions: actionsResult.rows.map(row => ({
      id: row.id,
      executionId: row.execution_id,
      sequence: row.sequence,
      actionType: row.action_type,
      targetSelector: row.target_selector,
      stateBefore: row.state_before,
      stateAfter: row.state_after,
      timestamp: row.timestamp,
    })),
  };
};

export const pauseExecution = async (executionId: string) => {
  const execution = await getExecutionById(executionId);
  if (!["queued", "running"].includes(execution.status)) {
    throw new HttpError(409, "Execution cannot be paused in current status");
  }

  await dbQuery(`UPDATE executions SET status='paused' WHERE id=$1`, [executionId]);
  executionEvents.publish({ executionId, type: "status", data: { status: "paused" } });
};

export const resumeExecution = async (executionId: string) => {
  const execution = await getExecutionById(executionId);
  if (execution.status !== "paused") {
    throw new HttpError(409, "Execution is not paused");
  }

  await dbQuery(`UPDATE executions SET status='queued' WHERE id=$1`, [executionId]);
  queue.push(executionId);
  executionEvents.publish({ executionId, type: "status", data: { status: "queued" } });
  void processQueue();
};

const buildEventFilterQuery = (executionId: string, filters: EventQueryFilters) => {
  const where: string[] = ["execution_id = $1"];
  const params: unknown[] = [executionId];

  if (filters.technology) {
    params.push(filters.technology);
    where.push(`technology = $${params.length}`);
  }
  if (filters.eventType) {
    params.push(filters.eventType);
    where.push(`event_type = $${params.length}`);
  }
  if (filters.url) {
    params.push(`%${filters.url}%`);
    where.push(`url ILIKE $${params.length}`);
  }
  if (filters.consentState) {
    params.push(filters.consentState);
    where.push(`consent_state = $${params.length}`);
  }

  return { where, params };
};

export const listExecutionEventsPage = async (
  executionId: string,
  filters: EventQueryFilters,
): Promise<EventPageResult> => {
  const { where, params } = buildEventFilterQuery(executionId, filters);
  const sortDirection = filters.sort === "asc" ? "ASC" : "DESC";
  const limit = Math.min(Math.max(filters.limit ?? 5000, 1), 10000);
  const offset = Math.max(filters.offset ?? 0, 0);

  const countQuery = `SELECT COUNT(*)::int AS total FROM events WHERE ${where.join(" AND ")}`;
  const countResult = await dbQuery<{ total: number }>(countQuery, params);
  const total = countResult.rows[0]?.total ?? 0;

  params.push(limit);
  params.push(offset);
  const query = `SELECT id, execution_id, timestamp, action_id, event_type, technology, url, state_name, event_name, parameters, consent_state, request_payload, status, correlation_confidence, created_at
                 FROM events
                 WHERE ${where.join(" AND ")}
                 ORDER BY timestamp ${sortDirection}
                 LIMIT $${params.length - 1}
                 OFFSET $${params.length}`;
  const result = await dbQuery<EventRow>(query, params);

  return {
    items: result.rows,
    meta: {
      total,
      returned: result.rows.length,
      limit,
      offset,
      isPartial: offset + result.rows.length < total,
      sort: filters.sort === "asc" ? "asc" : "desc",
    },
  };
};

export const listExecutionEvents = async (
  executionId: string,
  filters: EventQueryFilters,
) => {
  const page = await listExecutionEventsPage(executionId, filters);
  return page.items;
};

export const listExecutionActions = async (executionId: string) => {
  const result = await dbQuery<ActionRow>(
    `SELECT id, execution_id, sequence, action_type, target_selector, state_before, state_after, timestamp
     FROM actions
     WHERE execution_id = $1
     ORDER BY sequence ASC`,
    [executionId],
  );
  return result.rows;
};

export const buildJourneyInventory = async (executionId: string) => {
  // Fetch all events with state information
  const eventsResult = await dbQuery<{
    state_name: string;
    event_type: string;
    technology: string;
    count: number;
  }>(
    `SELECT 
       state_name,
       event_type,
       technology,
       COUNT(*)::int as count
     FROM events
     WHERE execution_id = $1
     GROUP BY state_name, event_type, technology
     ORDER BY state_name`,
    [executionId],
  );

  // Collect ALL unique state names from actions (includes visited-but-blocked URLs)
  const actionStatesResult = await dbQuery<{ state_name: string }>(
    `SELECT DISTINCT state_before AS state_name FROM actions WHERE execution_id = $1 AND state_before IS NOT NULL
     UNION
     SELECT DISTINCT state_after  AS state_name FROM actions WHERE execution_id = $1 AND state_after  IS NOT NULL`,
    [executionId],
  );

  // Group events by state
  const stateMap = new Map<
    string,
    {
      eventTypes: Set<string>;
      technologies: Map<string, number>;
      eventCount: number;
      hasEvents: boolean;
    }
  >();

  for (const row of eventsResult.rows) {
    const state = row.state_name || "(unknown)";
    let stateData = stateMap.get(state);
    if (!stateData) {
      stateData = { eventTypes: new Set(), technologies: new Map(), eventCount: 0, hasEvents: true };
      stateMap.set(state, stateData);
    }
    stateData.eventTypes.add(row.event_type);
    stateData.technologies.set(row.technology, (stateData.technologies.get(row.technology) ?? 0) + row.count);
    stateData.eventCount += row.count;
  }

  // Add states from actions that have no events (e.g., WAF-blocked pages)
  for (const row of actionStatesResult.rows) {
    const state = row.state_name;
    if (!stateMap.has(state)) {
      stateMap.set(state, { eventTypes: new Set(), technologies: new Map(), eventCount: 0, hasEvents: false });
    }
  }

  // Fetch all actions
  const actionsResult = await dbQuery<ActionRow>(
    `SELECT id, execution_id, sequence, action_type, target_selector, state_before, state_after, timestamp
     FROM actions
     WHERE execution_id = $1
     ORDER BY sequence ASC`,
    [executionId],
  );

  // Build state inventory
  const states = Array.from(stateMap.entries()).map(([stateName, data]) => {
    // Extract base URL from state_name (format: "URL | Context")
    const parts = stateName.split(" | ");
    const baseUrl = parts[0] || stateName;
    const visualContext = parts[1] || undefined;

    return {
      stateName,
      baseUrl,
      visualContext,
      eventCount: data.eventCount,
      hasEvents: data.hasEvents,
      eventTypes: Array.from(data.eventTypes).sort(),
      technologies: Object.fromEntries(Array.from(data.technologies.entries()).sort((a, b) => b[1] - a[1])),
    };
  // Sort: states with events first, then by event count desc
  }).sort((a, b) => {
    if (a.hasEvents !== b.hasEvents) return a.hasEvents ? -1 : 1;
    return b.eventCount - a.eventCount;
  });

  // Group states by URL to detect multi-screen SPAs
  const urlScreenMap = new Map<string, typeof states>();
  for (const state of states) {
    const url = state.baseUrl;
    if (!urlScreenMap.has(url)) {
      urlScreenMap.set(url, []);
    }
    urlScreenMap.get(url)!.push(state);
  }

  // Determine screen type for each URL
  const screenTypeMap = new Map<string, string>();
  for (const [url, urlStates] of urlScreenMap.entries()) {
    if (urlStates.length > 1) {
      const hasModalIndicators = urlStates.some(s => {
        const ctx = (s.visualContext || "").toLowerCase();
        return ctx.includes("modal") || ctx.includes("dialog") || ctx.includes("popup");
      });
      screenTypeMap.set(url, hasModalIndicators ? "modal" : "spa");
    } else {
      screenTypeMap.set(url, "page");
    }
  }

  // Build transition map for state transitions with back-nav detection
  const transitionMap = new Map<string, { count: number; isBackNav: boolean }>();
  for (const action of actionsResult.rows) {
    const from = action.state_before || "(unknown)";
    const to = action.state_after || "(unknown)";
    const key = `${from}→${to}`;

    const fromParts = from.split(" | ");
    const toParts = to.split(" | ");
    const fromUrl = fromParts[0] || from;
    const toUrl = toParts[0] || to;
    const isBackNav = fromUrl === toUrl && from !== to;

    let trans = transitionMap.get(key);
    if (!trans) {
      trans = { count: 0, isBackNav: false };
      transitionMap.set(key, trans);
    }
    trans.count += 1;
    if (isBackNav) trans.isBackNav = true;
  }

  // Build journey array (simplified transition sequence)
  const journey = actionsResult.rows.map((action) => {
    const from = action.state_before || "(unknown)";
    const to = action.state_after || "(unknown)";
    const fromParts = from.split(" | ");
    const toParts = to.split(" | ");
    const fromUrl = fromParts[0] || from;
    const toUrl = toParts[0] || to;
    const isBackNav = fromUrl === toUrl && from !== to;

    return {
      sequence: action.sequence,
      actionType: action.action_type,
      from,
      to,
      isBackNav,
      timestamp: action.timestamp,
    };
  });

  // Calculate statistics
  const uniqueUrls = Array.from(urlScreenMap.keys());
  const uniqueStates = states.length;
  const totalEvents = states.reduce((sum, s) => sum + s.eventCount, 0);

  return {
    summary: {
      totalStates: uniqueStates,
      totalUniqueUrls: uniqueUrls.length,
      totalActions: actionsResult.rows.length,
      totalEvents,
    },
    states: states.sort((a, b) => b.eventCount - a.eventCount),
    urlScreens: Array.from(urlScreenMap.entries())
      .map(([url, urlStates]) => ({
        url,
        screenType: screenTypeMap.get(url) || "page",
        screenCount: urlStates.length,
        states: urlStates.sort((a, b) => b.eventCount - a.eventCount),
      }))
      .sort((a, b) => {
        if (b.screenCount !== a.screenCount) {
          return b.screenCount - a.screenCount;
        }
        const aFirstEvent = a.states[0]?.eventCount ?? 0;
        const bFirstEvent = b.states[0]?.eventCount ?? 0;
        return bFirstEvent - aFirstEvent;
      }),
    transitions: Array.from(transitionMap.entries())
      .map(([key, data]) => {
        const parts = key.split("→");
        const from = parts[0] || "";
        const to = parts[1] || "";
        return {
          from,
          to,
          actionCount: data.count,
          isBackNav: data.isBackNav,
        };
      })
      .sort((a, b) => b.actionCount - a.actionCount),
    journey: journey.slice(0, 100), // First 100 actions for context
  };
};

export const getExecutionHistoryByAudit = async (auditId: string) => {
  const result = await dbQuery<ExecutionRow>(
    `SELECT
       e.id,
       e.audit_id,
       e.version,
       e.status,
       e.platform,
       e.environment,
       e.started_at,
       e.ended_at,
       e.config_snapshot,
       e.pause_checkpoint,
       e.results,
       e.ignored_fields,
       e.warnings,
       e.created_at,
       COALESCE(evt.events_count, 0)::int AS events_count,
       COALESCE(act.actions_count, 0)::int AS actions_count
     FROM executions e
     LEFT JOIN (
       SELECT execution_id, COUNT(*)::int AS events_count
       FROM events
       GROUP BY execution_id
     ) evt ON evt.execution_id = e.id
     LEFT JOIN (
       SELECT execution_id, COUNT(*)::int AS actions_count
       FROM actions
       GROUP BY execution_id
     ) act ON act.execution_id = e.id
     WHERE e.audit_id = $1
     ORDER BY e.version DESC`,
    [auditId],
  );
  return result.rows.map(mapExecution);
};

export const getExecutionReport = async (executionId: string) => {
  const execution = await getExecutionById(executionId);
  const warnings = await dbQuery<{ type: string; count: number }>(
    `SELECT type, SUM(count)::int AS count FROM warnings WHERE execution_id = $1 GROUP BY type`,
    [executionId],
  );
  const totals = await dbQuery<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM events WHERE execution_id = $1`,
    [executionId],
  );
  const grouped = await dbQuery<{ technology: string; total: number }>(
    `SELECT technology, COUNT(*)::int AS total
     FROM events
     WHERE execution_id = $1
     GROUP BY technology`,
    [executionId],
  );
  const byTechnology = grouped.rows.reduce<Record<string, number>>((acc, item) => {
    acc[item.technology] = item.total;
    return acc;
  }, {});
  const totalRow = totals.rows[0];
  const totalEvents = totalRow ? totalRow.total : 0;

  return {
    execution,
    totals: {
      events: totalEvents,
      byTechnology,
      warnings: warnings.rows,
    },
  };
};

export const exportExecution = async (executionId: string, format: "json" | "csv" | "pdf") => {
  const report = await getExecutionReport(executionId);
  const events = await listExecutionEvents(executionId, {});
  const journeyInventory = await buildJourneyInventory(executionId);

  if (format === "json") {
    return {
      contentType: "application/json",
      fileName: `execution-${executionId}.json`,
      body: Buffer.from(JSON.stringify({ report, events, journeyInventory }, null, 2), "utf8"),
    };
  }

  if (format === "csv") {
    const csv = stringify(
      events.map((item) => ({
        timestamp: item.timestamp,
        event_type: item.event_type,
        technology: item.technology,
        url: item.url,
        consent_state: item.consent_state,
        status: item.status,
        correlation_confidence: item.correlation_confidence,
      })),
      { header: true },
    );
    return {
      contentType: "text/csv; charset=utf-8",
      fileName: `execution-${executionId}.csv`,
      body: Buffer.from(csv, "utf8"),
    };
  }

  const doc = new PDFDocument({ margin: 36 });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk) => chunks.push(chunk as Buffer));
  doc.fontSize(16).text(`Execution ${executionId}`);
  doc.moveDown().fontSize(12).text(`Status: ${report.execution.status}`);
  doc.text(`Platform: ${report.execution.platform}`);
  doc.text(`Environment: ${report.execution.environment}`);
  doc.text(`Total events: ${report.totals.events}`);
  doc.moveDown().text("Events by technology:");
  for (const [tech, count] of Object.entries(report.totals.byTechnology)) {
    doc.text(`- ${tech}: ${count}`);
  }
  doc.end();

  const body = await new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  return {
    contentType: "application/pdf",
    fileName: `execution-${executionId}.pdf`,
    body,
  };
};

// ---------------------------------------------------------------------------
// Audit-level aggregated management report (across ALL executions)
// ---------------------------------------------------------------------------

export const getAuditManagementReport = async (auditId: string, urlFilter?: string) => {
  const auditResult = await dbQuery<{ id: string; name: string; objective: string; urls: unknown; created_at: string }>(
    `SELECT id, name, objective, urls, created_at FROM audits WHERE id = $1`,
    [auditId],
  );
  const audit = auditResult.rows[0];
  if (!audit) throw new HttpError(404, "Audit not found");

  const configuredUrls = (audit.urls as Array<{ url: string }> | null) ?? [];
  // Parameterized URL filter: null = no filter, string = ILIKE %filter%
  const filterClause = urlFilter ? `AND ev.url ILIKE '%' || $2 || '%'` : "";
  const filterParams = (base: unknown[]) => urlFilter ? [...base, urlFilter] : base;

  // Summary per execution (respects URL filter for counts)
  const execSummary = await dbQuery<{
    id: string; version: number; status: string; started_at: string | null; ended_at: string | null;
    events_count: number; urls_count: number;
  }>(
    `SELECT e.id, e.version, e.status, e.started_at, e.ended_at,
            COUNT(DISTINCT ev.id)::int   AS events_count,
            COUNT(DISTINCT ev.url)::int  AS urls_count
     FROM executions e
     LEFT JOIN events ev ON ev.execution_id = e.id ${filterClause}
     WHERE e.audit_id = $1
     GROUP BY e.id, e.version, e.status, e.started_at, e.ended_at
     ORDER BY e.version ASC`,
    filterParams([auditId]),
  );

  // Technologies aggregated across all executions
  const byTech = await dbQuery<{ technology: string; total: number; in_executions: number }>(
    `SELECT ev.technology,
            COUNT(*)::int                      AS total,
            COUNT(DISTINCT e.id)::int          AS in_executions
     FROM events ev
     JOIN executions e ON e.id = ev.execution_id
     WHERE e.audit_id = $1 ${filterClause}
     GROUP BY ev.technology
     ORDER BY total DESC`,
    filterParams([auditId]),
  );

  // Events by name aggregated across all executions
  const byEventName = await dbQuery<{ event_name: string; technology: string; total: number; in_executions: number }>(
    `SELECT COALESCE(ev.event_name, '(sem nome)') AS event_name,
            ev.technology,
            COUNT(*)::int                          AS total,
            COUNT(DISTINCT e.id)::int              AS in_executions
     FROM events ev
     JOIN executions e ON e.id = ev.execution_id
     WHERE e.audit_id = $1 ${filterClause}
     GROUP BY ev.event_name, ev.technology
     ORDER BY total DESC
     LIMIT 60`,
    filterParams([auditId]),
  );

  // URLs aggregated across all executions
  const byUrl = await dbQuery<{
    url: string; total_events: number; in_executions: number;
    technologies: string; last_seen: string;
  }>(
    `SELECT ev.url,
            COUNT(*)::int                      AS total_events,
            COUNT(DISTINCT e.id)::int          AS in_executions,
            STRING_AGG(DISTINCT ev.technology, ', ' ORDER BY ev.technology) AS technologies,
            MAX(ev.timestamp)::text            AS last_seen
     FROM events ev
     JOIN executions e ON e.id = ev.execution_id
     WHERE e.audit_id = $1 ${filterClause}
     GROUP BY ev.url
     ORDER BY total_events DESC`,
    filterParams([auditId]),
  );

  // Evolution matrix: events per URL per execution version (for trend view)
  const evolutionMatrix = await dbQuery<{
    url: string; version: number; started_at: string | null; events_count: number; technologies: string;
  }>(
    `SELECT ev.url,
            e.version,
            e.started_at::text,
            COUNT(*)::int AS events_count,
            STRING_AGG(DISTINCT ev.technology, ',' ORDER BY ev.technology) AS technologies
     FROM events ev
     JOIN executions e ON e.id = ev.execution_id
     WHERE e.audit_id = $1 ${filterClause}
     GROUP BY ev.url, e.version, e.started_at
     ORDER BY ev.url, e.version ASC`,
    filterParams([auditId]),
  );

  // Consent breakdown across executions
  const byConsent = await dbQuery<{ consent_state: string; total: number }>(
    `SELECT ev.consent_state, COUNT(*)::int AS total
     FROM events ev
     JOIN executions e ON e.id = ev.execution_id
     WHERE e.audit_id = $1 ${filterClause}
     GROUP BY ev.consent_state`,
    filterParams([auditId]),
  );

  const totalEvents = byTech.rows.reduce((s, r) => s + r.total, 0);
  const visitedUrlSet = new Set(byUrl.rows.map(r => r.url));
  const urlsWithoutEvents = configuredUrls.filter(u => !visitedUrlSet.has(u.url));
  const completedExecs = execSummary.rows.filter(e => e.status === "completed");

  // Build matrix: url → { v1: N, v2: N, ... }
  const versions = [...new Set(execSummary.rows.map(e => e.version))].sort((a, b) => a - b);
  type UrlMatrixEntry = { url: string; byVersion: Record<number, number>; technologies: string; total: number };
  const matrixMap = new Map<string, UrlMatrixEntry>();
  for (const row of evolutionMatrix.rows) {
    if (!matrixMap.has(row.url)) {
      matrixMap.set(row.url, { url: row.url, byVersion: {}, technologies: row.technologies, total: 0 });
    }
    const entry = matrixMap.get(row.url)!;
    entry.byVersion[row.version] = row.events_count;
    entry.total += row.events_count;
  }
  const urlMatrix = [...matrixMap.values()].sort((a, b) => b.total - a.total);

  return {
    audit: { id: audit.id, name: audit.name, objective: audit.objective, createdAt: audit.created_at },
    urlFilter: urlFilter ?? null,
    configuredUrls,
    totalEvents,
    totalExecutions: execSummary.rows.length,
    completedExecutions: completedExecs.length,
    executions: execSummary.rows,
    versions,
    byTechnology: byTech.rows,
    topEventNames: byEventName.rows,
    allUrls: byUrl.rows,
    urlMatrix,
    urlsWithoutEvents,
    byConsent: byConsent.rows,
  };
};

// ---------------------------------------------------------------------------
// Management report data
// ---------------------------------------------------------------------------

export const getManagementReport = async (executionId: string) => {
  const execution = await getExecutionById(executionId);

  // Configured URLs from audit definition
  const auditResult = await dbQuery<{ urls: unknown; name: string; objective: string }>(
    `SELECT urls, name, objective FROM audits WHERE id = $1`,
    [execution.auditId],
  );
  const configuredUrls = (auditResult.rows[0]?.urls as Array<{ url: string }> | null) ?? [];

  // Unique URLs actually visited (from actions, not just events)
  const visitedUrlsResult = await dbQuery<{ url: string; actions_count: number }>(
    `SELECT COALESCE(state_before, state_after, '') AS url, COUNT(*)::int AS actions_count
     FROM actions WHERE execution_id = $1
     GROUP BY url ORDER BY actions_count DESC`,
    [executionId],
  );

  const byTech = await dbQuery<{ technology: string; total: number }>(
    `SELECT technology, COUNT(*)::int AS total
     FROM events WHERE execution_id = $1 GROUP BY technology ORDER BY total DESC`,
    [executionId],
  );

  const byEventName = await dbQuery<{ event_name: string | null; technology: string; total: number }>(
    `SELECT COALESCE(event_name, '(sem nome)') AS event_name, technology, COUNT(*)::int AS total
     FROM events WHERE execution_id = $1
     GROUP BY event_name, technology ORDER BY total DESC LIMIT 50`,
    [executionId],
  );

  const byUrl = await dbQuery<{ url: string; total: number; technologies: string }>(
    `SELECT url,
            COUNT(*)::int AS total,
            STRING_AGG(DISTINCT technology, ', ' ORDER BY technology) AS technologies
     FROM events WHERE execution_id = $1
     GROUP BY url ORDER BY total DESC`,
    [executionId],
  );

  const byConsent = await dbQuery<{ consent_state: string; total: number }>(
    `SELECT consent_state, COUNT(*)::int AS total
     FROM events WHERE execution_id = $1 GROUP BY consent_state`,
    [executionId],
  );

  const byConfidence = await dbQuery<{ correlation_confidence: string; total: number }>(
    `SELECT correlation_confidence, COUNT(*)::int AS total
     FROM events WHERE execution_id = $1 GROUP BY correlation_confidence`,
    [executionId],
  );

  const totalEvents = byTech.rows.reduce((s, r) => s + r.total, 0);
  const visitedUrlSet = new Set(byUrl.rows.map(r => r.url));
  const configuredUrlSet = new Set(configuredUrls.map(u => u.url));

  // URLs configured but with no events captured
  const urlsWithoutEvents = configuredUrls.filter(u => !visitedUrlSet.has(u.url));

  return {
    execution,
    auditName: auditResult.rows[0]?.name ?? "",
    auditObjective: auditResult.rows[0]?.objective ?? "",
    totalEvents,
    configuredUrlCount: configuredUrls.length,
    visitedUrlCount: byUrl.rows.length,
    configuredUrls,
    byTechnology: byTech.rows,
    topEventNames: byEventName.rows,
    allUrls: byUrl.rows,
    urlsWithoutEvents,
    byConsent: byConsent.rows,
    byConfidence: byConfidence.rows,
    visitedStates: visitedUrlsResult.rows.filter(r => r.url),
  };
};

// ---------------------------------------------------------------------------
// Analyst report data
// ---------------------------------------------------------------------------

export const getAnalystReport = async (executionId: string) => {
  const execution = await getExecutionById(executionId);

  const events = await dbQuery<{
    id: string; timestamp: string; url: string; state_name: string | null;
    action_type: string | null; target_selector: string | null; sequence: number | null;
    event_type: string; technology: string; event_name: string | null;
    consent_state: string; status: string; correlation_confidence: string;
    parameters: Record<string, unknown>;
  }>(
    `SELECT ev.id, ev.timestamp, ev.url, ev.state_name,
            ac.action_type, ac.target_selector, ac.sequence,
            ev.event_type, ev.technology, ev.event_name,
            ev.consent_state, ev.status, ev.correlation_confidence,
            ev.parameters
     FROM events ev
     LEFT JOIN actions ac ON ac.id = ev.action_id
     WHERE ev.execution_id = $1
     ORDER BY ev.timestamp ASC`,
    [executionId],
  );

  // Group by URL for URL-centric drill-down view
  const byUrl = new Map<string, typeof events.rows>();
  for (const ev of events.rows) {
    const key = ev.url;
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key)!.push(ev);
  }

  return {
    execution,
    totalEvents: events.rows.length,
    events: events.rows,
    byUrl: Array.from(byUrl.entries()).map(([url, evs]) => ({ url, events: evs })),
  };
};

// ---------------------------------------------------------------------------
// Historical diff between two versions of the same audit
// ---------------------------------------------------------------------------

export const getExecutionDiff = async (auditId: string, versionA: number, versionB: number) => {
  const execResult = await dbQuery<{ id: string; version: number; started_at: string | null; status: string }>(
    `SELECT id, version, started_at, status
     FROM executions WHERE audit_id = $1 AND version = ANY($2::int[])`,
    [auditId, [versionA, versionB]],
  );

  const execA = execResult.rows.find(r => r.version === versionA);
  const execB = execResult.rows.find(r => r.version === versionB);
  if (!execA || !execB) throw new HttpError(404, `One or both versions not found (${versionA}, ${versionB})`);

  const fetchSignatures = async (execId: string) => {
    const r = await dbQuery<{ event_name: string; technology: string; url: string; total: number }>(
      `SELECT COALESCE(event_name,'(sem nome)') AS event_name, technology, url, COUNT(*)::int AS total
       FROM events WHERE execution_id = $1
       GROUP BY event_name, technology, url`,
      [execId],
    );
    return r.rows;
  };

  const sigsA = await fetchSignatures(execA.id);
  const sigsB = await fetchSignatures(execB.id);

  type Sig = { event_name: string; technology: string; url: string };
  const key = (s: Sig) => `${s.technology}::${s.event_name}::${s.url}`;

  const mapA = new Map(sigsA.map(s => [key(s), s]));
  const mapB = new Map(sigsB.map(s => [key(s), s]));

  const added: typeof sigsB = [];
  const removed: typeof sigsA = [];
  const changed: { event_name: string; technology: string; url: string; countA: number; countB: number; delta: number }[] = [];
  const unchanged: typeof sigsA = [];

  for (const [k, b] of mapB) {
    const a = mapA.get(k);
    if (!a) { added.push(b); }
    else if (a.total !== b.total) { changed.push({ ...b, countA: a.total, countB: b.total, delta: b.total - a.total }); }
    else { unchanged.push(a); }
  }
  for (const [k, a] of mapA) {
    if (!mapB.has(k)) removed.push(a);
  }

  return {
    versionA: { version: versionA, executionId: execA.id, startedAt: execA.started_at, status: execA.status },
    versionB: { version: versionB, executionId: execB.id, startedAt: execB.started_at, status: execB.status },
    summary: { added: added.length, removed: removed.length, changed: changed.length, unchanged: unchanged.length },
    added,
    removed,
    changed: changed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
    unchanged,
  };
};
