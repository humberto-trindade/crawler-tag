import cors from "cors";
import express from "express";
import pinoHttp from "pino-http";
import { auditsRouter } from "./api/audits.js";
import { executionsRouter } from "./api/executions.js";
import { exportsRouter } from "./api/exports.js";
import { healthRouter } from "./api/health.js";
import { templatesRouter } from "./api/templates.js";
import { logger } from "./config/logger.js";
import { HttpError } from "./lib/http.js";

export const createApp = () => {
  const app = express();

  app.use(pinoHttp({ logger }));
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use("/health", healthRouter);
  app.use("/api/templates", templatesRouter);
  app.use("/api/audits", auditsRouter);
  app.use("/api/audits/:auditId/executions", executionsRouter);
  app.use("/api/audits/:auditId/executions", exportsRouter);

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.statusCode).json({ message: error.message, details: error.details });
      return;
    }

    logger.error({ error }, "Unhandled application error");
    res.status(500).json({ message: "Internal server error" });
  });

  return app;
};
