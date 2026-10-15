import { randomUUID } from "node:crypto";
import { dbQuery } from "../config/db.js";
import { HttpError } from "../lib/http.js";

type AuditRow = {
  id: string;
  name: string;
  objective: string;
  urls: unknown;
  template_id: string | null;
  config_snapshot: unknown;
  status: string;
  created_at: string;
  created_by: string;
};

export type CreateAuditInput = {
  name: string;
  objective: string;
  createdBy: string;
  templateId?: string;
  urls: unknown;
  config: unknown;
};

const mapAudit = (row: AuditRow) => ({
  id: row.id,
  name: row.name,
  objective: row.objective,
  urls: row.urls,
  templateId: row.template_id,
  config: row.config_snapshot,
  status: row.status,
  createdAt: row.created_at,
  createdBy: row.created_by,
});

const requireFirst = (rows: AuditRow[], notFoundMessage: string): AuditRow => {
  const row = rows[0];
  if (!row) {
    throw new HttpError(404, notFoundMessage);
  }
  return row;
};

export const createAudit = async (input: CreateAuditInput) => {
  const id = randomUUID();
  const result = await dbQuery<AuditRow>(
    `INSERT INTO audits (id, name, objective, urls, template_id, config_snapshot, status, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, 'configured', $7)
     RETURNING id, name, objective, urls, template_id, config_snapshot, status, created_at, created_by`,
    [
      id,
      input.name,
      input.objective,
      JSON.stringify(input.urls),
      input.templateId ?? null,
      JSON.stringify(input.config),
      input.createdBy,
    ],
  );

  return mapAudit(requireFirst(result.rows, "Failed to create audit"));
};

export const listAudits = async () => {
  const result = await dbQuery<AuditRow>(
    `SELECT id, name, objective, urls, template_id, config_snapshot, status, created_at, created_by
     FROM audits
     ORDER BY created_at DESC
     LIMIT 200`,
  );

  return result.rows.map(mapAudit);
};

export const getAuditById = async (id: string) => {
  const result = await dbQuery<AuditRow>(
    `SELECT id, name, objective, urls, template_id, config_snapshot, status, created_at, created_by
     FROM audits
     WHERE id = $1`,
    [id],
  );

  if (result.rowCount === 0) {
    throw new HttpError(404, "Audit not found");
  }

  return mapAudit(requireFirst(result.rows, "Audit not found"));
};

export const updateAudit = async (
  id: string,
  input: Partial<CreateAuditInput & { status: "configured" | "archived" }>,
) => {
  const current = await getAuditById(id);
  const result = await dbQuery<AuditRow>(
    `UPDATE audits
       SET name = $2,
           objective = $3,
           urls = $4::jsonb,
           template_id = $5,
           config_snapshot = $6::jsonb,
           status = $7
     WHERE id = $1
     RETURNING id, name, objective, urls, template_id, config_snapshot, status, created_at, created_by`,
    [
      id,
      input.name ?? current.name,
      input.objective ?? current.objective,
      JSON.stringify(input.urls ?? current.urls),
      input.templateId ?? current.templateId ?? null,
      JSON.stringify(input.config ?? current.config),
      input.status ?? current.status,
    ],
  );

  return mapAudit(requireFirst(result.rows, "Audit not found"));
};
