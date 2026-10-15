import { logger } from "../config/logger.js";

/**
 * Deliberately inert BigQuery boundary for this Cloud Run application version.
 * PostgreSQL/Cloud SQL remains the operational store until the BigQuery
 * contract is approved and its real adapter replaces this mock.
 */
export const isBigQueryEnabled = (): boolean => false;

export const exportExecutionToBigQuery = async (executionId: string): Promise<boolean> => {
  logger.info(
    { executionId, integration: "bigquery", mode: "mock" },
    "BigQuery export skipped: mock adapter is active",
  );
  return false;
};
