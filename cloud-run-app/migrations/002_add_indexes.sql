CREATE INDEX IF NOT EXISTS idx_executions_audit_id ON executions(audit_id);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);
CREATE INDEX IF NOT EXISTS idx_events_execution_id ON events(execution_id);
CREATE INDEX IF NOT EXISTS idx_events_technology ON events(technology);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_actions_execution_id ON actions(execution_id);
CREATE INDEX IF NOT EXISTS idx_warnings_execution_id ON warnings(execution_id);
CREATE INDEX IF NOT EXISTS idx_templates_archived_at ON templates(archived_at);
