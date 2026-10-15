// Initialize Playwright environment variables FIRST
import "./playwright-init.js";

import { createApp } from "./app.js";
import { connectDatabase, dbPool } from "./config/database.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { executionEvents } from "./realtime/executionEvents.js";
import { loadQueueFromDatabase } from "./services/executionService.js";
import { WebSocketServer } from "ws";

const bootstrap = async (): Promise<void> => {
  await connectDatabase();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "Server running");
  });

  // The mock store starts empty after each process restart.
  await loadQueueFromDatabase();
  const wsServer = new WebSocketServer({ server, path: "/ws" });

  wsServer.on("connection", (socket, request) => {
    const requestUrl = new URL(request.url ?? "/ws", `http://${request.headers.host ?? "localhost"}`);
    const executionId = requestUrl.searchParams.get("executionId");
    if (!executionId) {
      socket.close(1008, "executionId query param required");
      return;
    }

    const unsubscribe = executionEvents.subscribe(executionId, (payload) => {
      socket.send(JSON.stringify(payload));
    });

    socket.on("close", () => {
      unsubscribe();
    });
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info({ signal }, "Shutdown signal received");
    server.close(async () => {
      wsServer.close();
      await dbPool.end();
      logger.info("Server stopped");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

bootstrap().catch((error: unknown) => {
  logger.error({ error }, "Failed to start application");
  process.exit(1);
});
