import { existsSync } from "node:fs";

/**
 * Docker images provide /ms-playwright. Local installations should use the
 * platform default cache unless the launcher supplies an explicit path.
 */
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync("/ms-playwright")) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = "/ms-playwright";
}
