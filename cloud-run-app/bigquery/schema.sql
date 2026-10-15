-- BigQuery schema for the Sheets -> crawler -> Sheets workflow.
-- Create the dataset separately with the configured project/location.
-- Table ids are selected by deployment configuration, not application logic.

CREATE TABLE IF NOT EXISTS crawler_tag_audit.audit_targets (
  target_id STRING OPTIONS(description = 'Stable identifier generated once for a spreadsheet row'),
  flow_id STRING OPTIONS(description = 'Business journey/product identifier from the input sheet'),
  display_name STRING,
  environment STRING,
  start_url STRING,
  stage STRING OPTIONS(description = 'pdp, short_form, lead_intent, or purchase'),
  expected_technology STRING OPTIONS(description = 'meta_pixel, ga4, google_ads, gtm, or custom'),
  expected_event_name STRING,
  expected_destination_id STRING,
  checkpoint_hint STRING,
  allowed_domains ARRAY<STRING>,
  persona_ref STRING,
  max_depth INT64,
  max_actions INT64,
  max_states INT64,
  max_duration_minutes INT64,
  active BOOL,
  validate_current_phase BOOL,
  owner STRING,
  authorization_ref STRING,
  notes STRING,
  approval_status STRING OPTIONS(description = 'pending, approved, rejected, or incomplete'),
  revision INT64,
  source_spreadsheet_id STRING,
  source_sheet_tab STRING,
  source_row_number INT64,
  source_hash STRING,
  last_synced_at TIMESTAMP,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
)
PARTITION BY DATE(last_synced_at)
CLUSTER BY active, flow_id, stage, expected_technology
OPTIONS (description = 'Current normalized, validated target catalog imported from Google Sheets');

CREATE TABLE IF NOT EXISTS crawler_tag_audit.audit_target_revisions (
  target_id STRING,
  revision INT64,
  flow_id STRING,
  display_name STRING,
  environment STRING,
  start_url STRING,
  stage STRING,
  expected_technology STRING,
  expected_event_name STRING,
  expected_destination_id STRING,
  checkpoint_hint STRING,
  allowed_domains ARRAY<STRING>,
  persona_ref STRING,
  max_depth INT64,
  max_actions INT64,
  max_states INT64,
  max_duration_minutes INT64,
  active BOOL,
  validate_current_phase BOOL,
  owner STRING,
  authorization_ref STRING,
  notes STRING,
  approval_status STRING,
  source_hash STRING,
  source_spreadsheet_id STRING,
  source_sheet_tab STRING,
  source_row_number INT64,
  captured_at TIMESTAMP
)
PARTITION BY DATE(captured_at)
CLUSTER BY target_id, flow_id, stage, expected_technology
OPTIONS (description = 'Immutable snapshots of imported target revisions');

CREATE TABLE IF NOT EXISTS crawler_tag_audit.audit_runs (
  run_id STRING,
  target_id STRING,
  target_revision INT64,
  flow_id STRING,
  display_name STRING,
  environment STRING,
  start_url STRING,
  final_url STRING,
  stage STRING,
  expected_technology STRING,
  expected_event_name STRING,
  observed_event_names ARRAY<STRING>,
  schedule_window STRING OPTIONS(description = 'morning, afternoon, evening, or manual'),
  idempotency_key STRING,
  status STRING,
  outcome STRING OPTIONS(description = 'reachable, challenge_detected, blocked_by_waf, blocked_by_auth, timeout, inconclusive, or event assessment'),
  checkpoint_reached BOOL,
  initial_http_status INT64,
  final_http_status INT64,
  actions_count INT64,
  states_count INT64,
  events_count INT64,
  duration_seconds FLOAT64,
  warnings ARRAY<STRING>,
  config_snapshot JSON,
  error_code STRING,
  scheduled_at TIMESTAMP,
  started_at TIMESTAMP,
  finished_at TIMESTAMP,
  inserted_at TIMESTAMP
)
PARTITION BY DATE(scheduled_at)
CLUSTER BY target_id, flow_id, stage, expected_technology
OPTIONS (description = 'Immutable crawler execution results; one row per target and schedule slot');

CREATE TABLE IF NOT EXISTS crawler_tag_audit.audit_events (
  event_id STRING,
  run_id STRING,
  target_id STRING,
  target_revision INT64,
  flow_id STRING,
  stage STRING,
  page_url STRING,
  action_id STRING,
  technology STRING,
  event_name STRING,
  destination_id STRING,
  request_outcome STRING,
  http_status INT64,
  correlation_confidence FLOAT64,
  parameter_names ARRAY<STRING>,
  sanitized_parameters JSON OPTIONS(description = 'Only allowlisted, sanitized values; never raw payloads'),
  observed_at TIMESTAMP,
  inserted_at TIMESTAMP
)
PARTITION BY DATE(observed_at)
CLUSTER BY run_id, target_id, technology, event_name
OPTIONS (description = 'Sanitized tracking events and requests observed during crawler runs');

CREATE TABLE IF NOT EXISTS crawler_tag_audit.audit_sync_log (
  sync_id STRING,
  source_spreadsheet_id STRING,
  source_sheet_tab STRING,
  sync_status STRING,
  rows_seen INT64,
  rows_accepted INT64,
  rows_rejected INT64,
  error_codes ARRAY<STRING>,
  sync_started_at TIMESTAMP,
  sync_finished_at TIMESTAMP
)
PARTITION BY DATE(sync_started_at)
OPTIONS (description = 'Operational metadata for spreadsheet ingestion; excludes raw sheet payloads');

CREATE OR REPLACE VIEW crawler_tag_audit.sheet_monitoring_view AS
WITH latest_run AS (
  SELECT *
  FROM crawler_tag_audit.audit_runs
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY target_id
    ORDER BY scheduled_at DESC, inserted_at DESC
  ) = 1
)
SELECT
  t.target_id,
  t.flow_id,
  t.display_name,
  t.environment,
  t.start_url,
  t.stage,
  t.expected_technology,
  t.expected_event_name,
  t.active,
  t.approval_status,
  t.revision AS target_revision,
  r.run_id,
  r.schedule_window,
  r.status AS run_status,
  r.outcome,
  r.checkpoint_reached,
  r.observed_event_names,
  r.initial_http_status,
  r.final_http_status,
  r.actions_count,
  r.events_count,
  r.duration_seconds,
  r.warnings,
  r.scheduled_at AS last_run_at,
  r.finished_at AS last_finished_at
FROM crawler_tag_audit.audit_targets AS t
LEFT JOIN latest_run AS r USING (target_id);
