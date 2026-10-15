import { randomUUID } from "node:crypto";
import { dbQuery } from "../config/db.js";
import { HttpError } from "../lib/http.js";

type TemplateRow = {
  id: string;
  name: string;
  version: number;
  data: unknown;
  parent_template_id: string | null;
  created_at: string;
  created_by: string;
  archived_at: string | null;
};

const mapTemplate = (row: TemplateRow) => ({
  id: row.id,
  name: row.name,
  version: row.version,
  data: row.data,
  parentTemplateId: row.parent_template_id,
  createdAt: row.created_at,
  createdBy: row.created_by,
  archivedAt: row.archived_at,
});

const requireTemplateRow = (rows: TemplateRow[], message: string): TemplateRow => {
  const row = rows[0];
  if (!row) {
    throw new HttpError(404, message);
  }
  return row;
};

const getRootTemplateId = async (id: string): Promise<string> => {
  const result = await dbQuery<{ id: string; parent_template_id: string | null }>(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_template_id
       FROM templates
       WHERE id = $1
       UNION ALL
       SELECT t.id, t.parent_template_id
       FROM templates t
       JOIN ancestors a ON a.parent_template_id = t.id
     )
     SELECT id, parent_template_id
     FROM ancestors
     WHERE parent_template_id IS NULL
     LIMIT 1`,
    [id],
  );

  if (result.rowCount === 0) {
    throw new HttpError(404, "Template not found");
  }

  const root = result.rows[0];
  if (!root) {
    throw new HttpError(404, "Template root not found");
  }
  return root.id;
};

const getTemplateLineage = async (rootId: string) => {
  const result = await dbQuery<TemplateRow>(
    `WITH RECURSIVE lineage AS (
      SELECT id, name, version, data, parent_template_id, created_at, created_by, archived_at
      FROM templates
      WHERE id = $1
      UNION ALL
      SELECT t.id, t.name, t.version, t.data, t.parent_template_id, t.created_at, t.created_by, t.archived_at
      FROM templates t
      JOIN lineage l ON t.parent_template_id = l.id
    )
    SELECT id, name, version, data, parent_template_id, created_at, created_by, archived_at
    FROM lineage
    ORDER BY version ASC`,
    [rootId],
  );

  if (result.rowCount === 0) {
    throw new HttpError(404, "Template lineage not found");
  }

  return result.rows.map(mapTemplate);
};

export const createTemplate = async (input: { name: string; data: unknown; createdBy: string }) => {
  const id = randomUUID();
  const result = await dbQuery<TemplateRow>(
    `INSERT INTO templates (id, name, version, data, parent_template_id, created_by)
     VALUES ($1, $2, 1, $3::jsonb, NULL, $4)
     RETURNING id, name, version, data, parent_template_id, created_at, created_by, archived_at`,
    [id, input.name, JSON.stringify(input.data), input.createdBy],
  );

  return mapTemplate(requireTemplateRow(result.rows, "Template creation failed"));
};

export const listTemplateFamilies = async () => {
  const result = await dbQuery<TemplateRow>(
    `WITH RECURSIVE roots AS (
      SELECT id
      FROM templates
      WHERE parent_template_id IS NULL AND archived_at IS NULL
    ),
    lineage AS (
      SELECT r.id AS root_id, t.id, t.name, t.version, t.data, t.parent_template_id, t.created_at, t.created_by, t.archived_at
      FROM roots r
      JOIN templates t ON t.id = r.id
      UNION ALL
      SELECT l.root_id, t.id, t.name, t.version, t.data, t.parent_template_id, t.created_at, t.created_by, t.archived_at
      FROM lineage l
      JOIN templates t ON t.parent_template_id = l.id
    )
    SELECT DISTINCT ON (root_id)
      id, name, version, data, parent_template_id, created_at, created_by, archived_at
    FROM lineage
    WHERE archived_at IS NULL
    ORDER BY root_id, version DESC`,
  );

  return result.rows.map(mapTemplate);
};

export const getTemplateLatest = async (templateId: string) => {
  const rootId = await getRootTemplateId(templateId);
  const lineage = await getTemplateLineage(rootId);
  const latest = lineage[lineage.length - 1];
  if (!latest) {
    throw new HttpError(404, "Template not found");
  }
  return latest;
};

export const getTemplateVersions = async (templateId: string) => {
  const rootId = await getRootTemplateId(templateId);
  return getTemplateLineage(rootId);
};

export const createTemplateVersion = async (
  templateId: string,
  patch: { name?: string; data?: unknown; createdBy: string },
) => {
  const latest = await getTemplateLatest(templateId);
  const id = randomUUID();
  const version = latest.version + 1;
  const name = patch.name ?? latest.name;
  const data = patch.data ?? latest.data;
  const result = await dbQuery<TemplateRow>(
    `INSERT INTO templates (id, name, version, data, parent_template_id, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     RETURNING id, name, version, data, parent_template_id, created_at, created_by, archived_at`,
    [id, name, version, JSON.stringify(data), latest.id, patch.createdBy],
  );

  return mapTemplate(requireTemplateRow(result.rows, "Template version creation failed"));
};

export const archiveTemplateFamily = async (templateId: string) => {
  const rootId = await getRootTemplateId(templateId);
  const lineage = await getTemplateLineage(rootId);
  const ids = lineage.map((item) => item.id);

  await dbQuery(`UPDATE templates SET archived_at = NOW() WHERE id = ANY($1::uuid[])`, [ids]);
};
