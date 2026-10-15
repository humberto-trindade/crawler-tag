/**
 * Bridge entre o backend TypeScript e o crawler-service Python (Camoufox).
 *
 * Quando CRAWLER_ENGINE=camoufox, as execuções são roteadas para o
 * microserviço FastAPI em vez de usar o Playwright/Chromium local.
 *
 * Variáveis de ambiente:
 *   CRAWLER_ENGINE          - "playwright" (default) | "camoufox"
 *   CRAWLER_SERVICE_URL     - URL do crawler-service (default: http://localhost:5001)
 *   CRAWLER_SERVICE_TIMEOUT - Timeout em ms para a requisição (default: 30 min)
 */

import type { CrawlConfig, CrawlOutput } from "./explorer.js";

type CrawlHooks = {
  onProgress?: (progress: import("./explorer.js").CrawlProgress) => void;
  onBrowserReady?: (closeBrowser: () => Promise<void>) => void;
  onStateVisited?: (snapshot: {
    actions: import("./explorer.js").CrawlAction[];
    events: import("./explorer.js").CrawlEvent[];
    ignoredFields: import("./explorer.js").IgnoredField[];
    warnings: import("./explorer.js").CrawlWarning[];
    statesDiscovered: number;
    stateScreenshots: Record<string, string>;
  }) => void;
};

const CRAWLER_SERVICE_URL =
  process.env.CRAWLER_SERVICE_URL ?? "http://localhost:5001";

const CRAWLER_SERVICE_TIMEOUT_MS = Number(
  process.env.CRAWLER_SERVICE_TIMEOUT ?? String(30 * 60 * 1000),
);

/**
 * Verifica se o crawler-service está disponível.
 * Útil para healthcheck antes de submeter uma execução.
 */
export const checkCrawlerServiceHealth = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${CRAWLER_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  }
};

/**
 * Executa uma exploração de jornada via crawler-service (Camoufox/Python).
 *
 * Transforma o CrawlConfig TypeScript para o formato JSON esperado pelo
 * endpoint POST /crawl do crawler-service e devolve CrawlOutput.
 */
export const runCamoufoxCrawler = async (config: CrawlConfig): Promise<CrawlOutput> => {
  const serviceUrl = `${CRAWLER_SERVICE_URL}/crawl`;

  // Transformar CrawlConfig para o formato que o Pydantic do Python espera
  // (camelCase → o Python usa populate_by_name=True, então aceita camelCase)
  const requestBody = JSON.stringify(config);

  let response: Response;
  try {
    response = await fetch(serviceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
      signal: AbortSignal.timeout(CRAWLER_SERVICE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `crawler-service indisponível em ${serviceUrl}: ${String(err)}. ` +
        "Verifique se o container crawler-service está rodando.",
    );
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { detail?: string };
      detail = body.detail ?? "";
    } catch {
      /* ignore */
    }
    throw new Error(
      `crawler-service retornou HTTP ${response.status}: ${detail || response.statusText}`,
    );
  }

  return response.json() as Promise<CrawlOutput>;
};

/**
 * Seletor de engine: retorna a função de crawl correta baseado em CRAWLER_ENGINE.
 *
 * Uso em executionService.ts:
 *   import { selectCrawlEngine } from "../crawler/crawlerBridge.js";
 *   const output = await selectCrawlEngine(config, hooks);
 */
export const selectCrawlEngine = async (config: CrawlConfig, hooks?: CrawlHooks): Promise<CrawlOutput> => {
  const engine = process.env.CRAWLER_ENGINE ?? "playwright";

  if (engine === "camoufox") {
    const healthy = await checkCrawlerServiceHealth();
    if (!healthy) {
      console.warn(
        "[CRAWLER-BRIDGE] crawler-service não disponível. " +
          "Falling back para Playwright local.",
      );
      const { exploreJourneys } = await import("./explorer.js");
      return exploreJourneys(config, hooks);
    }
    console.log(`[CRAWLER-BRIDGE] Roteando para Camoufox em ${CRAWLER_SERVICE_URL}`);
    return runCamoufoxCrawler(config);
  }

  // Default: Playwright local (com hooks para onProgress)
  const { exploreJourneys } = await import("./explorer.js");
  return exploreJourneys(config, hooks);
};
