import { config } from "dotenv";
import { z } from "zod";

config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  PERSISTENCE_MODE: z.literal("mock").default("mock"),
  // BigQuery — opcional; exportação só ativa quando BIGQUERY_PROJECT_ID estiver definido
  BIGQUERY_PROJECT_ID:  z.string().optional(),
  BIGQUERY_DATASET_ID:  z.string().default("crawler_tag_audit"),
  BIGQUERY_LOCATION:    z.string().default("US"),
  BIGQUERY_KEY_FILE:    z.string().optional(),
  BIGQUERY_USE_ADC:     z.coerce.boolean().default(false),
  BIGQUERY_EXPORT_MODE: z.literal("mock").default("mock"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

export const env = parsed.data;
