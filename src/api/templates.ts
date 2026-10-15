import { Router } from "express";
import { z } from "zod";
import {
  assertSyntheticTemplateData,
  parseOrThrow,
  templateSchema,
} from "../domain/schemas.js";
import { asyncHandler } from "../lib/http.js";
import { requireParam } from "../lib/request.js";
import {
  archiveTemplateFamily,
  createTemplate,
  createTemplateVersion,
  getTemplateLatest,
  getTemplateVersions,
  listTemplateFamilies,
} from "../services/templateService.js";

export const templatesRouter = Router();

const updateTemplateSchema = z.object({
  name: z.string().trim().min(3).max(255).optional(),
  createdBy: z.string().trim().min(3).max(255),
  data: templateSchema.shape.data.optional(),
});

templatesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const payload = parseOrThrow(templateSchema, req.body);
    assertSyntheticTemplateData(payload.data);
    const template = await createTemplate(payload);
    res.status(201).json(template);
  }),
);

templatesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const templates = await listTemplateFamilies();
    res.status(200).json(templates);
  }),
);

templatesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const template = await getTemplateLatest(requireParam(req, "id"));
    res.status(200).json(template);
  }),
);

templatesRouter.get(
  "/:id/versions",
  asyncHandler(async (req, res) => {
    const versions = await getTemplateVersions(requireParam(req, "id"));
    res.status(200).json(versions);
  }),
);

templatesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const payload = parseOrThrow(updateTemplateSchema, req.body);
    if (payload.data) {
      assertSyntheticTemplateData(payload.data);
    }
    const version = await createTemplateVersion(requireParam(req, "id"), {
      name: payload.name,
      data: payload.data,
      createdBy: payload.createdBy,
    });
    res.status(200).json(version);
  }),
);

templatesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await archiveTemplateFamily(requireParam(req, "id"));
    res.status(204).send();
  }),
);
