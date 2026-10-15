import { z } from "zod";
import { HttpError } from "../lib/http.js";

const urlSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
    message: "URL must use http or https",
  });

export const auditUrlConfigSchema = z.object({
  url: urlSchema,
  label: z.string().trim().min(1).max(255).optional(),
  depth: z.number().int().min(0).max(5),
  maxActions: z.number().int().min(1).max(10_000),
  maxStates: z.number().int().min(1).max(10_000),
  allowedDomains: z.array(z.string().trim().min(1)).min(1),
  singleUrlMode: z.boolean().optional().describe("Se true, não navega para outras URLs"),
});

export const auditConfigSchema = z.object({
  technologies: z.array(z.enum(["ga4", "meta_pixel", "google_ads", "custom"])).min(1),
  auditLevel: z.enum(["quick_check", "inventory", "parameters"]),
  syntheticPolicy: z.enum(["ignore_unknown_fields", "stop", "request_approval"]),
  browserMode: z.enum(["headless", "visual"]).default("headless"),
  blockedActions: z.array(z.string().trim().min(1)).default([]),
  maxDurationMinutes: z.number().int().min(1).max(180),
});

export const createAuditSchema = z.object({
  name: z.string().trim().min(3).max(255),
  objective: z.string().trim().min(5).max(2_000),
  createdBy: z.string().trim().min(3).max(255),
  templateId: z.string().uuid().optional(),
  urls: z.array(auditUrlConfigSchema).min(1),
  config: auditConfigSchema,
});

export const updateAuditSchema = createAuditSchema.partial().extend({
  status: z.enum(["configured", "archived"]).optional(),
});

export const templateSchema = z.object({
  name: z.string().trim().min(3).max(255),
  createdBy: z.string().trim().min(3).max(255),
  data: z.object({
    keys: z
      .array(
        z.object({
          key: z.string().trim().min(1),
          value: z.string().trim().min(1),
          matchers: z
            .object({
              attributes: z.array(z.string().trim().min(1)).optional(),
              labels: z.array(z.string().trim().min(1)).optional(),
              types: z.array(z.string().trim().min(1)).optional(),
              autocomplete: z.array(z.string().trim().min(1)).optional(),
              placeholders: z.array(z.string().trim().min(1)).optional(),
            })
            .optional(),
        }),
      )
      .min(1),
  }),
});

export const createExecutionSchema = z.object({
  platform: z.enum(["web", "mobile_web", "ios", "android"]).default("web"),
  environment: z.string().trim().min(1).max(64).default("local"),
});

export const parseOrThrow = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, "Validation failed", parsed.error.flatten());
  }

  return parsed.data;
};

const syntheticEmailDomains = [".test", "@example.com", "@example.test", "@mailinator.com"];

export const assertSyntheticTemplateData = (data: { keys: Array<{ key: string; value: string }> }) => {
  for (const field of data.keys) {
    const loweredKey = field.key.toLowerCase();
    const value = field.value.trim();

    if (loweredKey.includes("email")) {
      const loweredValue = value.toLowerCase();
      if (!syntheticEmailDomains.some((suffix) => loweredValue.endsWith(suffix))) {
        throw new HttpError(
          400,
          `Template email for key "${field.key}" must use synthetic domain (.test or example)`,
        );
      }
    }

    // CPF/CNPJ sintéticos são permitidos para testes de validação de formulário.
  }
};
