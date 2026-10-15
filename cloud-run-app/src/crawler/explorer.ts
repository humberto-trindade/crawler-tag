import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { load } from "cheerio";
import { chromium } from "playwright";
import { resolveFieldMapping, resolveFieldMappingFromHints, type TemplateKey } from "./fieldMapper.js";
import { classifyBlockedNavigation } from "./accessClassification.js";

export type CrawlUrlConfig = {
  url: string;
  depth: number;
  maxActions: number;
  maxStates: number;
  allowedDomains: string[];
  singleUrlMode?: boolean; // Se true, não segue links para outras URLs
};

export type CrawlConfig = {
  urls: CrawlUrlConfig[];
  templateKeys: TemplateKey[];
  singleUrlMode?: boolean;
  browserMode?: "headless" | "visual";
};

export type CrawlProgress = {
  phase: "starting" | "navigating" | "processing" | "completed" | "paused";
  currentUrl: string;
  queuedUrls: number;
  actionsCount: number;
  eventsCount: number;
  statesDiscovered: number;
  visitedUrls: string[];
  message: string;
};

type CrawlHooks = {
  onProgress?: (progress: CrawlProgress) => void;
  onBrowserReady?: (closeBrowser: () => Promise<void>) => void;
  onStateVisited?: (snapshot: {
    actions: CrawlAction[];
    events: CrawlEvent[];
    ignoredFields: IgnoredField[];
    warnings: CrawlWarning[];
    statesDiscovered: number;
    stateScreenshots: Record<string, string>;
  }) => void;
};

export type CrawlAction = {
  id: string;
  type:
    | "navigate"
    | "inspect_form"
    | "click_link"
    | "fill_field"
    | "select_field"
    | "check_field"
    | "consent";
  targetSelector: string;
  stateBefore: string;
  stateAfter: string;
  url: string;
  timestamp: string;
};

export type CrawlEvent = {
  id: string;
  actionId: string | null;
  eventType: string;
  technology: string;
  eventName: string;
  url: string;
  stateName: string;
  parameters: Record<string, unknown>;
  requestPayload?: Record<string, unknown>;
  consentState: "unknown" | "before_consent" | "after_consent";
  status: "observed" | "ignored" | "flagged";
  correlationConfidence: "high" | "low";
  timestamp: string;
};

export type IgnoredField = {
  fieldName: string;
  cssSelector: string;
  reason: "no_mapping" | "ambiguous_mapping" | "unsupported_type";
};

export type CrawlWarning = {
  type: "captcha" | "cookie_blocked" | "adblocker" | "csp" | "spa_router" | "field_ignored" | "navigation_blocked";
  message: string;
};

export type CrawlOutput = {
  status: "completed" | "paused" | "failed";
  stopReason?: string;
  pauseCheckpoint?: { url: string; reason: "captcha_detected" };
  actions: CrawlAction[];
  events: CrawlEvent[];
  ignoredFields: IgnoredField[];
  warnings: CrawlWarning[];
  statesDiscovered: number;
  // state name → base64 JPEG data-URI thumbnail (quality 25, viewport-only, max 20 screenshots)
  stateScreenshots?: Record<string, string>;
};

type QueueItem = {
  url: string;
  depth: number;
  allowedDomains: string[];
  maxDepth: number;
  maxActions: number;
  maxStates: number;
  singleUrlMode?: boolean;
};

const hashContent = (value: string) => createHash("sha256").update(value).digest("hex");

const isAllowedUrl = (urlToCheck: URL, allowedDomains: string[]) =>
  allowedDomains.some((domain) => {
    const normalized = domain.toLowerCase().replace(/^\./, "");
    return (
      urlToCheck.hostname.toLowerCase() === normalized ||
      urlToCheck.hostname.toLowerCase().endsWith(`.${normalized}`)
    );
  });

const isPrivateIpAddress = (ipAddress: string): boolean => {
  const version = isIP(ipAddress);
  if (version === 4) {
    const parts = ipAddress.split(".").map(Number);
    const a = parts[0] ?? -1;
    const b = parts[1] ?? -1;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }

  if (version === 6) {
    const normalized = ipAddress.toLowerCase();
    if (normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (normalized.startsWith("fe80:")) return true;
  }

  return false;
};

const assertSafeTarget = async (url: URL): Promise<void> => {
  if (process.env.NODE_ENV === "test") {
    return;
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Blocked scheme for crawler: ${url.protocol}`);
  }

  const dnsResult = await lookup(url.hostname, { all: true });
  for (const entry of dnsResult) {
    if (isPrivateIpAddress(entry.address)) {
      throw new Error(`Blocked private address for crawler target: ${entry.address}`);
    }
    if (entry.address === "169.254.169.254") {
      throw new Error("Blocked cloud metadata endpoint");
    }
  }
};

const sanitizeParameter = (name: string, value: string) => {
  const lowered = name.toLowerCase();
  if (lowered.includes("token") || lowered.includes("cookie") || lowered.includes("auth")) {
    return "[redacted]";
  }
  if (lowered.includes("email")) {
    return "[masked-email]";
  }
  if (lowered.includes("phone") || lowered.includes("telefone")) {
    return "[masked-phone]";
  }
  if (value.length > 120) {
    return `${value.slice(0, 120)}...[truncated]`;
  }

  return value;
};

const parseTrackingRequest = (requestUrl: string): { technology: string; eventName: string } | null => {
  const normalizedUrl = requestUrl.toLowerCase();
  if (
    normalizedUrl.includes("facebook.com/tr") ||
    normalizedUrl.includes("connect.facebook.net") ||
    normalizedUrl.includes("fbevents.js") ||
    normalizedUrl.includes("/signals/config")
  ) {
    return { technology: "meta_pixel", eventName: "network_meta" };
  }
  if (requestUrl.includes("google-analytics.com/g/collect") || requestUrl.includes("/collect?")) {
    return { technology: "ga4", eventName: "network_collect" };
  }
  if (requestUrl.includes("doubleclick.net") || requestUrl.includes("googleads.g.doubleclick.net")) {
    return { technology: "google_ads", eventName: "network_ads" };
  }
  if (normalizedUrl.includes("bat.bing.com") || normalizedUrl.includes("clarity.ms")) {
    return { technology: "microsoft_ads", eventName: "network_microsoft_ads" };
  }
  if (normalizedUrl.includes("analytics.tiktok.com") || normalizedUrl.includes("tiktok")) {
    return { technology: "tiktok_pixel", eventName: "network_tiktok" };
  }
  if (normalizedUrl.includes("px.ads.linkedin.com") || normalizedUrl.includes("snap.licdn.com")) {
    return { technology: "linkedin_insight", eventName: "network_linkedin" };
  }
  if (normalizedUrl.includes("hotjar.com")) {
    return { technology: "hotjar", eventName: "network_hotjar" };
  }
  if (
    normalizedUrl.includes("omtrdc.net") ||
    normalizedUrl.includes("adobedc.net") ||
    normalizedUrl.includes("/b/ss/")
  ) {
    return { technology: "adobe_analytics", eventName: "network_adobe" };
  }
  if (normalizedUrl.includes("ct.pinterest.com")) {
    return { technology: "pinterest_tag", eventName: "network_pinterest" };
  }
  if (normalizedUrl.includes("tr.snapchat.com")) {
    return { technology: "snap_pixel", eventName: "network_snapchat" };
  }

  return null;
};

const isPotentialTrackerUrl = (requestUrl: string): boolean => {
  const normalized = requestUrl.toLowerCase();
  if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) return false;
  const includeHints = [
    "collect",
    "analytics",
    "pixel",
    "track",
    "tr?",
    "tag",
    "gtm",
    "metrics",
    "ads",
    "conversion",
  ];
  const excludeHints = [".css", ".js", ".png", ".jpg", ".svg", "font", "favicon"];
  if (excludeHints.some((hint) => normalized.includes(hint))) return false;
  return includeHints.some((hint) => normalized.includes(hint));
};

const detectTrackingEventsFromHtml = (
  html: string,
  url: string,
  actionId: string | null,
  consentState: CrawlEvent["consentState"] = "unknown",
): CrawlEvent[] => {
  const now = new Date().toISOString();
  const events: CrawlEvent[] = [];

  if (html.includes("gtag(") || html.includes("googletagmanager.com")) {
    events.push({
      id: randomUUID(),
      actionId,
      eventType: "tag_detected",
      technology: "ga4",
      eventName: "ga4_tag_detected",
      url,
      stateName: url,
      parameters: { source: "html_scan" },
      consentState,
      status: "observed",
      correlationConfidence: actionId ? "high" : "low",
      timestamp: now,
    });
  }

  if (html.includes("fbq(") || html.includes("connect.facebook.net")) {
    events.push({
      id: randomUUID(),
      actionId,
      eventType: "tag_detected",
      technology: "meta_pixel",
      eventName: "meta_pixel_detected",
      url,
      stateName: url,
      parameters: { source: "html_scan" },
      consentState,
      status: "observed",
      correlationConfidence: actionId ? "high" : "low",
      timestamp: now,
    });
  }
  if (html.includes("analytics.tiktok.com") || html.includes("ttq(")) {
    events.push({
      id: randomUUID(),
      actionId,
      eventType: "tag_detected",
      technology: "tiktok_pixel",
      eventName: "tiktok_tag_detected",
      url,
      stateName: url,
      parameters: { source: "html_scan" },
      consentState,
      status: "observed",
      correlationConfidence: actionId ? "high" : "low",
      timestamp: now,
    });
  }
  if (html.includes("px.ads.linkedin.com") || html.includes("linkedin")) {
    events.push({
      id: randomUUID(),
      actionId,
      eventType: "tag_detected",
      technology: "linkedin_insight",
      eventName: "linkedin_tag_detected",
      url,
      stateName: url,
      parameters: { source: "html_scan" },
      consentState,
      status: "observed",
      correlationConfidence: actionId ? "high" : "low",
      timestamp: now,
    });
  }
  if (html.includes("clarity.ms") || html.includes("hotjar")) {
    events.push({
      id: randomUUID(),
      actionId,
      eventType: "tag_detected",
      technology: "session_analytics",
      eventName: "session_analytics_detected",
      url,
      stateName: url,
      parameters: { source: "html_scan" },
      consentState,
      status: "observed",
      correlationConfidence: actionId ? "high" : "low",
      timestamp: now,
    });
  }

  return events;
};

const tryAcceptConsentBanner = async (page: import("playwright").Page): Promise<boolean> => {
  const selectors = [
    "#onetrust-accept-btn-handler",
    ".cc-btn.cc-allow",
    "button[aria-label*='permit']",
    "button[id*='permit']",
    "button[class*='permit']",
    "button[aria-label*='aceit']",
    "button[aria-label*='accept']",
    "button[id*='accept']",
    "button[class*='accept']",
    "button[class*='consent']",
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const count = await locator.count();
    if (count === 0) continue;
    try {
      await locator.click({ timeout: 1_500 });
      await page.waitForTimeout(400);
      return true;
    } catch {
      continue;
    }
  }

  const acceptedByText = await page
    .locator("button, a[role='button'], [role='button']")
    .filter({ hasText: /aceitar|aceito|allow all|accept all|concordo|permitir|permito|entendi|ok,? entendi/i })
    .first()
    .click({ timeout: 1_500 })
    .then(async () => {
      await page.waitForTimeout(400);
      return true;
    })
    .catch(() => false);

  return acceptedByText;
};

const consumeConsentPrompts = async (page: import("playwright").Page): Promise<number> => {
  let acceptedCount = 0;
  for (let round = 0; round < 5; round += 1) {
    const accepted = await tryAcceptConsentBanner(page).catch(() => false);
    if (!accepted) break;
    acceptedCount += 1;
    console.log(`[CRAWLER][CONSENT] accepted prompt #${acceptedCount}`);
    await waitForPageReady(page, `after_consent_${acceptedCount}`, 8_000);
  }
  return acceptedCount;
};

const blockedDownloadExtensions = [
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".rar",
  ".7z",
  ".csv",
  ".xml",
  ".txt",
];

const hasBlockingCaptcha = (html: string): boolean => {
  const hasCaptchaWidget = /(g-recaptcha|h-captcha|arkose|data-sitekey)/i.test(html);
  const hasCaptchaIframe = /<iframe[^>]+(recaptcha|hcaptcha|arkoselabs)/i.test(html);
  const hasChallengeText =
    /(n[aã]o sou um rob[oô]|i am human|verifique que voc[eê] [ée] humano|captcha)/i.test(html);
  return hasCaptchaIframe && (hasChallengeText || hasCaptchaWidget);
};

// Detects Cloudflare WAF / Bot Management block pages (IP or fingerprint block)
const isWafBlock = (html: string, statusCode: number): boolean => {
  if (statusCode === 403 || statusCode === 429) return true;
  return /(sorry.*you.*have.*been.*blocked|access.*denied.*cloudflare|ray id:|cf-ray|__cf_chl|cf_clearance|cloudflare.*security|error 1015|error 1020)/i.test(html);
};

const hasVisibleCaptcha = async (page: import("playwright").Page, html: string): Promise<boolean> => {
  const structuralHit = hasBlockingCaptcha(html);
  if (!structuralHit) return false;

  const visibleWidgetCount = await page
    .locator(
      "iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='arkoselabs'], .g-recaptcha, .h-captcha, [data-sitekey]",
    )
    .filter({ hasNotText: /hidden/i })
    .count()
    .catch(() => 0);

  if (visibleWidgetCount > 0) return true;

  const visibleChallengeText = await page
    .locator("body")
    .innerText()
    .then((text) => /(n[aã]o sou um rob[oô]|i am human|verifique que voc[eê] [ée] humano)/i.test(text))
    .catch(() => false);
  return visibleChallengeText;
};

const escapeSelectorAttribute = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/**
 * Aguarda que overlays/modals desapareçam antes de clicar.
 * Essencial para SPAs onde loading spinners ou modals podem interceptar cliques.
 * Usa seletores específicos para evitar falsos positivos em elementos de layout.
 */
const waitForOverlayToDisappear = async (page: import("playwright").Page): Promise<void> => {
  // Only target elements that are genuinely blocking (full-screen modals/backdrops).
  // Avoid broad selectors like [class*="overlay"] that match layout helpers.
  const overlaySelectors = [
    '[role="dialog"][aria-modal="true"]',
    '.modal.show',
    '.modal-backdrop.show',
    '.MuiBackdrop-root',
    '.ReactModal__Overlay',
    '[class*="loading-overlay"]',
    '[class*="loader-overlay"]',
    '[id*="overlay"][style*="display: block"]',
  ];

  for (const selector of overlaySelectors) {
    try {
      const isVisible = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
          rect.width > 50 &&
          rect.height > 50 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0"
        );
      }, selector);

      if (isVisible) {
        console.log(`[CRAWLER] Overlay detectado: ${selector}, aguardando desaparecimento...`);
        await page
          .waitForSelector(selector, { state: "hidden", timeout: 4_000 })
          .catch(() => {
            console.warn(`[CRAWLER] Overlay ${selector} não desapareceu no timeout (continuando)`);
          });
      }
    } catch {
      // Ignorar erros de seletor inválido
    }
  }
};

const waitForUiToSettle = async (
  page: import("playwright").Page,
  maxWaitMs = 18_000,
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const loadingVisible = await page
      .evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll(
            "[class*='loading'], [class*='spinner'], [aria-busy='true'], [role='progressbar'], .modal-backdrop, .MuiBackdrop-root",
          ),
        );
        return candidates.some((el) => {
          const node = el as HTMLElement;
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        });
      })
      .catch(() => false);

    if (!loadingVisible) {
      return;
    }
    await page.waitForTimeout(500);
  }
};

// Specific selectors that indicate the page is genuinely loading — avoids false positives
const LOADING_SIGNAL_SELECTOR =
  "[class*='loading'], [class*='spinner'], [aria-busy='true'], [role='progressbar'], .modal-backdrop, .MuiBackdrop-root, [class*='skeleton']";

const detectPageLoadingSignals = async (
  page: import("playwright").Page,
): Promise<{ busy: boolean; visibleSignals: number }> =>
  page
    .evaluate((selector) => {
      const nodes = Array.from(document.querySelectorAll(selector));
      let visible = 0;
      for (const el of nodes) {
        const node = el as HTMLElement;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const isVisible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        if (isVisible) visible += 1;
      }
      return { busy: visible > 0, visibleSignals: visible };
    }, LOADING_SIGNAL_SELECTOR)
    .catch(() => ({ busy: false, visibleSignals: 0 }));

const waitForPageReady = async (
  page: import("playwright").Page,
  contextLabel: string,
  maxWaitMs = 12_000,
): Promise<{ ready: boolean; elapsedMs: number; visibleSignals: number }> => {
  const start = Date.now();
  let lastSignals = 0;
  // Check overlays once upfront — not inside the polling loop to avoid infinite retry
  await waitForOverlayToDisappear(page);
  while (Date.now() - start < maxWaitMs) {
    const loading = await detectPageLoadingSignals(page);
    lastSignals = loading.visibleSignals;
    if (!loading.busy) {
      await page.waitForLoadState("networkidle", { timeout: 1_500 }).catch(() => undefined);
      const recheck = await detectPageLoadingSignals(page);
      lastSignals = recheck.visibleSignals;
      if (!recheck.busy) {
        const elapsedMs = Date.now() - start;
        console.log(`[CRAWLER][READY] ${contextLabel}: ready in ${elapsedMs}ms`);
        return { ready: true, elapsedMs, visibleSignals: lastSignals };
      }
    }
    await page.waitForTimeout(300);
  }

  const elapsedMs = Date.now() - start;
  console.warn(`[CRAWLER][READY] ${contextLabel}: timeout after ${elapsedMs}ms (signals=${lastSignals})`);
  return { ready: false, elapsedMs, visibleSignals: lastSignals };
};

const captureTransitionSignature = async (page: import("playwright").Page): Promise<string> => {
  const summary = await page
    .evaluate(() => {
      const normalize = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
      const isVisible = (el: Element) => {
        const node = el as HTMLElement;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const activeHeading = Array.from(document.querySelectorAll("h1, h2, [role='heading'], [class*='step'], [class*='wizard']"))
        .map((el) => normalize(el.textContent))
        .find(Boolean);
      const visibleFormControls = Array.from(document.querySelectorAll("input, select, textarea"))
        .filter(isVisible).length;
      const visibleButtons = Array.from(document.querySelectorAll("button, [role='button'], input[type='submit'], input[type='button']"))
        .filter(isVisible)
        .map((el) => normalize((el as HTMLElement).textContent || (el as HTMLInputElement).value || ""))
        .filter(Boolean)
        .slice(0, 20);

      const visibleFieldHints = Array.from(document.querySelectorAll("input, select, textarea"))
        .filter(isVisible)
        .map((el) => {
          const field = el as HTMLInputElement;
          return normalize(field.name || field.id || field.getAttribute("aria-label") || field.placeholder || "");
        })
        .filter(Boolean)
        .slice(0, 20);

      const activeStepHints = Array.from(
        document.querySelectorAll(
          "[aria-current='step'], [aria-current='true'], [class*='step'][class*='active'], [class*='wizard'][class*='active']",
        ),
      )
        .filter(isVisible)
        .map((el) => normalize(el.textContent))
        .filter(Boolean)
        .slice(0, 6);

      const errorHints = Array.from(document.querySelectorAll("[role='alert'], .error, [class*='error'], [aria-invalid='true']"))
        .filter(isVisible)
        .map((el) => normalize(el.textContent))
        .filter(Boolean)
        .slice(0, 6);

      const summaryContainer =
        document.querySelector("aside") ||
        document.querySelector("[class*='summary']") ||
        document.querySelector("[class*='resumo']") ||
        document.querySelector("[class*='proposal']") ||
        document.querySelector("[class*='proposta']") ||
        document.querySelector("[class*='cart']") ||
        document.querySelector("[class*='cesta']") ||
        document.querySelector("[class*='basket']") ||
        document.querySelector("[class*='drawer']") ||
        document.querySelector("[class*='sidebar']");

      const focusContainer =
        document.querySelector("[role='dialog']") ||
        summaryContainer ||
        document.querySelector("form") ||
        document.querySelector("[class*='wizard']") ||
        document.querySelector("[class*='step']") ||
        document.querySelector("main") ||
        document.querySelector("article") ||
        document.body;

      const contentSnippet = normalize((focusContainer as HTMLElement | null)?.innerText || "").slice(0, 900);

      return {
        url: location.href,
        title: normalize(document.title),
        activeHeading: activeHeading || "",
        visibleFormControls,
        visibleButtons,
        visibleFieldHints,
        activeStepHints,
        errorHints,
        contentSnippet,
      };
    })
    .catch(() => ({
      url: page.url(),
      title: "",
      activeHeading: "",
      visibleFormControls: 0,
      visibleButtons: [] as string[],
      visibleFieldHints: [] as string[],
      activeStepHints: [] as string[],
      errorHints: [] as string[],
      contentSnippet: "",
    }));
  return hashContent(JSON.stringify(summary));
};

const DYNAMIC_CTA_SELECTOR =
  "button, [role='button'], input[type='submit'], input[type='button'], a[href], a[role='button'], a[class*='button'], a[class*='btn'], [onclick]";

const findBestDynamicCta = async (
  page: import("playwright").Page,
  excludedTexts: string[] = [],
): Promise<{ index: number; text: string; score: number } | null> =>
  page
    .evaluate((excluded) => {
      const normalizedExcluded = excluded.map((item) => item.toLowerCase().trim()).filter(Boolean);
      const normalize = (value: string | null | undefined) => (value || "").toLowerCase().replace(/\s+/g, " ").trim();
      const selector = DYNAMIC_CTA_SELECTOR;
      const elements = Array.from(document.querySelectorAll(selector));
      let best: { index: number; text: string; score: number } | null = null;

      for (let index = 0; index < elements.length; index += 1) {
        const node = elements[index] as HTMLElement;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        if (!visible) continue;

        const disabled =
          node.hasAttribute("disabled") ||
          node.getAttribute("aria-disabled") === "true" ||
          node.classList.contains("disabled") ||
          style.pointerEvents === "none";
        if (disabled) continue;

        const rawText =
          node.textContent ||
          node.getAttribute("value") ||
          node.getAttribute("aria-label") ||
          node.getAttribute("title") ||
          "";
        const text = normalize(rawText);
        if (!text) continue;
        if (normalizedExcluded.includes(text)) continue;
        if (/(hand talk|vlibras|libras|acessibilidade|plugin de acessibilidade|plugin)/.test(text)) continue;

        let score = 0;
        if (/(seguir|continuar|avançar|avancar|pr[oó]ximo|proximo|cotação|cotacao|contratar|simular|finalizar)/.test(text)) score += 45;
        if (/(ver quanto custa|ver proposta|atualizar cesta|adicionar ou editar produtos)/.test(text)) score += 42;
        if (/(quero este|quero essa|quero esta|escolher|selecionar|contratar este|comprar agora)/.test(text)) score += 38;
        if (/(seguir com a cota[cç][aã]o|seguir com essa cota[cç][aã]o|seguir com esta cota[cç][aã]o)/.test(text)) score += 35;
        // CTAs alternativos de formulários de veículo / produto sem identificador
        if (/(ve[ií]culo.*0\s*km|0\s*km.*sem\s*placa|sem\s*placa|n[aã]o\s*sei\s*a\s*placa|consultar\s*placa|pesquisar\s*ve[ií]culo)/.test(text)) score += 38;
        if (/(voltar|fechar|cancelar|sair|ajuda|parceiros|área do cliente|area do cliente)/.test(text)) score -= 55;
        if (/(nossos produtos|loja virtual|sua cesta)/.test(text)) score -= 45;
        if (/(saiba mais|ver mais|detalhes|conhe[çc]a|entenda)/.test(text)) score -= 20;

        const cls = normalize(node.className);
        const id = normalize(node.id);
        if (/(primary|cta|submit|continue|next)/.test(`${cls} ${id}`)) score += 18;

        if (node.closest("[role='dialog'], .modal, [class*='modal']")) score += 24;
        const formScope =
          node.closest("form, [role='form'], [class*='form'], [class*='wizard'], [class*='step']") ||
          node.closest("section, article, main");
        if (formScope) score += 18;
        if (formScope?.querySelector("#startDate, #endDate, input[id*='react-select']")) score += 22;
        if (node.closest("header, footer, nav")) score -= 28;

        const inputType = normalize((node as HTMLInputElement).type || "");
        if (inputType === "submit") score += 20;

        if (!best || score > best.score) {
          best = { index, text, score };
        }
      }

      if (!best || best.score < 8) {
        // Fallback dinâmico: último controle visível e habilitado no bloco de formulário
        let fallback: { index: number; text: string; score: number } | null = null;
        for (let index = 0; index < elements.length; index += 1) {
          const node = elements[index] as HTMLElement;
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          if (!visible) continue;
          const disabled =
            node.hasAttribute("disabled") ||
            node.getAttribute("aria-disabled") === "true" ||
            node.classList.contains("disabled") ||
            style.pointerEvents === "none";
          if (disabled) continue;
          if (node.closest("header, footer, nav")) continue;
          const text = normalize(node.textContent || node.getAttribute("value") || node.getAttribute("aria-label") || "");
          if (!text || normalizedExcluded.includes(text)) continue;
          if (/(hand talk|vlibras|libras|acessibilidade|plugin de acessibilidade|plugin)/.test(text)) continue;
          if (/(voltar|fechar|cancelar|sair)/.test(text)) continue;
          if (!node.closest("form, [role='form'], [class*='form'], [class*='wizard'], [class*='step'], section, article, main")) {
            continue;
          }
          fallback = { index, text, score: 8 };
        }
        if (fallback) {
          return fallback;
        }

        return null;
      }
      return best;
    }, excludedTexts)
    .catch(() => null);

const clickBestDynamicCta = async (
  page: import("playwright").Page,
  excludedTexts: string[] = [],
  options: { minScore?: number } = {},
): Promise<{ clicked: boolean; text?: string; pageChanged?: boolean; stableAfterClick?: boolean; failureReason?: string }> => {
  console.log(`[CRAWLER] Dynamic CTA search start (excluded=${excludedTexts.filter(Boolean).length})`);
  const minScore = options.minScore ?? 8;
  const normalize = (value: string | null | undefined) =>
    (value || "").toLowerCase().replace(/\s+/g, " ").trim();
  const excluded = excludedTexts.map((item) => normalize(item)).filter(Boolean);
  const candidates = page.locator(DYNAMIC_CTA_SELECTOR);

  const findCandidateWithTimeout = async (): Promise<{ index: number; text: string; score: number } | null> =>
    new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        console.log("[CRAWLER] Dynamic CTA evaluate search timed out; using Playwright fallback");
        resolve(null);
      }, 2_500);

      findBestDynamicCta(page, excludedTexts)
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch(() => {
          clearTimeout(timeoutId);
          resolve(null);
        });
    });

  let selected = await findCandidateWithTimeout();
  if (!selected) {
    await waitForUiToSettle(page, 2_500);
    await page.waitForTimeout(300);
    selected = await findCandidateWithTimeout();
  }

  if (!selected) {
    const total = Math.min(await candidates.count().catch(() => 0), 120);
    let fallback: { index: number; text: string; score: number } | null = null;
    for (let index = 0; index < total; index += 1) {
      const candidate = candidates.nth(index);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;

      const disabledViaApi = await candidate.isDisabled().catch(() => false);
      const snapshot = await candidate
        .evaluate((node) => {
          const element = node as HTMLElement;
          const text =
            element.textContent ||
            (element as HTMLInputElement).value ||
            element.getAttribute("aria-label") ||
            element.getAttribute("title") ||
            "";
          const className = element.className || "";
          const disabledLike =
            element.hasAttribute("disabled") ||
            element.getAttribute("aria-disabled") === "true" ||
            className.toLowerCase().includes("disabled") ||
            window.getComputedStyle(element).pointerEvents === "none";
          return {
            text,
            inModal: Boolean(element.closest("[role='dialog'], .modal, [class*='modal']")),
            inFormArea: Boolean(element.closest("form, [role='form'], [class*='form'], [class*='wizard'], [class*='step']")),
            inChromeArea: Boolean(element.closest("header, footer, nav")),
            disabledLike,
          };
        })
        .catch(() => null);
      if (!snapshot) continue;
      if (disabledViaApi || snapshot.disabledLike) continue;

      const text = normalize(snapshot.text);
      if (!text) continue;
      if (excluded.includes(text)) continue;
      if (/(hand talk|vlibras|libras|acessibilidade|plugin de acessibilidade|plugin)/.test(text)) continue;

      let score = 0;
      if (/(seguir|continuar|avançar|avancar|pr[oó]ximo|proximo|cotação|cotacao|simular|finalizar)/.test(text)) score += 45;
      if (/(ver quanto custa|ver proposta|atualizar cesta|adicionar ou editar produtos)/.test(text)) score += 42;
      if (/(quero este|quero essa|quero esta|escolher|selecionar|contratar este|comprar agora)/.test(text)) score += 38;
      if (/(seguir com a cota[cç][aã]o|seguir com essa cota[cç][aã]o|seguir com esta cota[cç][aã]o)/.test(text)) score += 35;
      // CTAs alternativos de formulários de veículo / produto sem identificador
      if (/(ve[ií]culo.*0\s*km|0\s*km.*sem\s*placa|sem\s*placa|n[aã]o\s*sei\s*a\s*placa|consultar\s*placa|pesquisar\s*ve[ií]culo)/.test(text)) score += 38;
      if (/(voltar|fechar|cancelar|sair|ajuda|parceiros|área do cliente|area do cliente)/.test(text)) score -= 55;
      if (/(nossos produtos|loja virtual|sua cesta)/.test(text)) score -= 45;
      if (/(saiba mais|ver mais|detalhes|conhe[çc]a|entenda)/.test(text)) score -= 20;
      if (snapshot.inModal) score += 20;
      if (snapshot.inFormArea) score += 16;
      if (snapshot.inChromeArea) score -= 24;

      if (score < minScore) continue;
      if (!fallback || score > fallback.score) {
        fallback = { index, text, score };
      }
    }

    if (fallback) {
      selected = fallback;
      console.log(`[CRAWLER] Dynamic CTA Playwright fallback candidate: text="${selected.text}" score=${selected.score}`);
    }
  }

  if (!selected) {
    console.log("[CRAWLER] Dynamic CTA: no suitable candidate found");
    return { clicked: false };
  }
  console.log(`[CRAWLER] Dynamic CTA candidate: text="${selected.text}" score=${selected.score}`);

  const totalCandidates = await candidates.count().catch(() => 0);
  if (selected.index < 0 || selected.index >= totalCandidates) {
    console.log(`[CRAWLER] Dynamic CTA: candidate index out of bounds (${selected.index}/${totalCandidates})`);
    return { clicked: false };
  }

  const target = candidates.nth(selected.index);
  const beforeSignature = await captureTransitionSignature(page);
  const beforeStateLabel = await capturePageState(page, page.url());
  console.log("[CRAWLER] Dynamic CTA click step: scroll into view");
  await target.scrollIntoViewIfNeeded({ timeout: 2_500 }).catch(() => undefined);
  console.log("[CRAWLER] Dynamic CTA click step: wait overlay");
  await waitForOverlayToDisappear(page);
  console.log("[CRAWLER] Dynamic CTA click step: perform click");
  let clicked = false;
  try {
    await target.click({ timeout: 3_000 });
    clicked = true;
  } catch {
    try {
      await target.click({ force: true, timeout: 3_000 });
      clicked = true;
    } catch {
      clicked = false;
    }
  }

  if (!clicked) {
    console.log(`[CRAWLER] Dynamic CTA click failed: text="${selected.text}"`);
    return { clicked: false };
  }

  console.log("[CRAWLER] Dynamic CTA click step: post-click settle");
  const readyAfter = await waitForPageReady(page, "after_dynamic_cta_click", 12_000);
  const afterSignature = await captureTransitionSignature(page);
  const afterStateLabel = await capturePageState(page, page.url());
  let pageChanged = beforeSignature !== afterSignature || beforeStateLabel !== afterStateLabel;

  if (!pageChanged && readyAfter.ready) {
    // Grace period para fluxos SPA que atualizam o estado visual com atraso.
    await page.waitForTimeout(1_800);
    const delayedReady = await waitForPageReady(page, "after_dynamic_cta_click_grace", 4_000);
    const delayedSignature = await captureTransitionSignature(page);
    const delayedStateLabel = await capturePageState(page, page.url());
    pageChanged = beforeSignature !== delayedSignature || beforeStateLabel !== delayedStateLabel;
    if (pageChanged) {
      console.log(`[CRAWLER] Dynamic CTA clicked and state changed after grace period: text="${selected.text}"`);
      return { clicked: true, text: selected.text, pageChanged: true, stableAfterClick: delayedReady.ready };
    }
  }

  if (!pageChanged && readyAfter.ready) {
    console.error(`[CRAWLER] Dynamic CTA clicked but page did not change in stable state: text="${selected.text}"`);
    return {
      clicked: true,
      text: selected.text,
      pageChanged: false,
      stableAfterClick: true,
      failureReason: "no_state_change_after_click",
    };
  }

  console.log(`[CRAWLER] Dynamic CTA clicked: text="${selected.text}"`);
  return { clicked: true, text: selected.text, pageChanged, stableAfterClick: readyAfter.ready };
};

const isTravelFormReadyForSubmit = async (page: import("playwright").Page): Promise<boolean> =>
  page
    .evaluate(() => {
      const normalize = (value: string | null | undefined) => (value || "").trim();
      const startDate = normalize((document.querySelector("#startDate") as HTMLInputElement | null)?.value);
      const endDate = normalize((document.querySelector("#endDate") as HTMLInputElement | null)?.value);
      const countryHidden = normalize(
        (document.querySelector("input[name='select_country']") as HTMLInputElement | null)?.value,
      );

      const motoConsentTextRegex = /acidentes? de moto|am[eé]rica latina|assinale o campo acima para continuar/i;
      const checkboxes = Array.from(document.querySelectorAll("input[type='checkbox']")) as HTMLInputElement[];
      let needsMotoConsent = false;
      let motoConsentChecked = true;

      for (const checkbox of checkboxes) {
        const byLabel = checkbox.id ? document.querySelector(`label[for='${checkbox.id}']`) : null;
        const container = checkbox.closest("label") || checkbox.closest("div") || checkbox.parentElement;
        const contextText = `${byLabel?.textContent || ""} ${container?.textContent || ""}`.replace(/\s+/g, " ");
        if (motoConsentTextRegex.test(contextText)) {
          needsMotoConsent = true;
          motoConsentChecked = checkbox.checked;
          break;
        }
      }

      const datesReady = Boolean(startDate) && Boolean(endDate);
      const countryReady = Boolean(countryHidden);
      const consentReady = !needsMotoConsent || motoConsentChecked;
      return datesReady && countryReady && consentReady;
    })
    .catch(() => false);

const diagnosePostClickBlockers = async (
  page: import("playwright").Page,
): Promise<{ invalidCount: number; requiredEmptyCount: number; errorHints: string[] }> =>
  page
    .evaluate(() => {
      const isVisible = (el: Element) => {
        const node = el as HTMLElement;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const normalize = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();

      const invalidCount = Array.from(document.querySelectorAll("input, select, textarea")).filter((field) => {
        const input = field as HTMLInputElement;
        if (!isVisible(input)) return false;
        if (typeof input.checkValidity !== "function") return false;
        return !input.checkValidity();
      }).length;

      const requiredEmptyCount = Array.from(document.querySelectorAll("input[required], select[required], textarea[required]")).filter((field) => {
        const input = field as HTMLInputElement;
        if (!isVisible(input)) return false;
        return !normalize(input.value);
      }).length;

      const errorHints = Array.from(
        document.querySelectorAll(".error, [class*='error'], [aria-invalid='true'], [role='alert'], [class*='invalid']"),
      )
        .filter(isVisible)
        .map((node) => normalize(node.textContent))
        .filter(Boolean)
        .slice(0, 6);

      return { invalidCount, requiredEmptyCount, errorHints };
    })
    .catch(() => ({ invalidCount: 0, requiredEmptyCount: 0, errorHints: [] }));

const tryRepairAfterNoChange = async (page: import("playwright").Page): Promise<boolean> => {
  const before = await diagnosePostClickBlockers(page);
  console.log(
    `[CRAWLER][RECOVERY] blockers before repair: invalid=${before.invalidCount} requiredEmpty=${before.requiredEmptyCount} hints=${before.errorHints.join(" | ")}`,
  );

  if (before.invalidCount === 0 && before.requiredEmptyCount === 0 && before.errorHints.length === 0) {
    return false;
  }

  const countryInput = page.locator("#react-select-2-input, input[id*='react-select'][id$='-input']").first();
  if (await countryInput.isVisible().catch(() => false)) {
    await tryInteractReactSelect(page, countryInput, "Brasil").catch(() => undefined);
  }

  const startDateInput = page.locator("#startDate").first();
  if (await startDateInput.isVisible().catch(() => false)) {
    const startType = ((await startDateInput.getAttribute("type")) || "").toLowerCase();
    const startValue = startType === "date" ? "2026-08-05" : "05/08/2026";
    await startDateInput.fill(startValue, { timeout: 2_500 }).catch(() => undefined);
    await startDateInput.press("Tab").catch(() => undefined);
  }

  const endDateInput = page.locator("#endDate").first();
  if (await endDateInput.isVisible().catch(() => false)) {
    const endType = ((await endDateInput.getAttribute("type")) || "").toLowerCase();
    const endValue = endType === "date" ? "2026-08-12" : "12/08/2026";
    await endDateInput.fill(endValue, { timeout: 2_500 }).catch(() => undefined);
    await endDateInput.press("Tab").catch(() => undefined);
  }

  const allCheckboxes = page.locator("input[type='checkbox']");
  const checkboxCount = await allCheckboxes.count().catch(() => 0);
  for (let index = 0; index < Math.min(checkboxCount, 6); index += 1) {
    const box = allCheckboxes.nth(index);
    const visible = await box.isVisible().catch(() => false);
    if (!visible) continue;
    const checked = await box.isChecked().catch(() => false);
    if (!checked) {
      await box.check({ timeout: 1_500 }).catch(() => undefined);
    }
  }

  await consumeConsentPrompts(page);
  await waitForPageReady(page, "after_repair_no_change", 8_000);

  const after = await diagnosePostClickBlockers(page);
  console.log(
    `[CRAWLER][RECOVERY] blockers after repair: invalid=${after.invalidCount} requiredEmpty=${after.requiredEmptyCount} hints=${after.errorHints.join(" | ")}`,
  );

  return true;
};

const inferElementContext = (node: { closest: (selector: string) => unknown }) => {
  if (node.closest("header")) return "header";
  if (node.closest("footer")) return "footer";
  if (node.closest("[role='dialog'], .modal, [class*='modal']")) return "modal";
  if (node.closest("[id*='banner'], [class*='banner']")) return "banner";
  return "content";
};

const normalizeFieldDescriptor = (value: string | null | undefined) =>
  (value || "").replace(/\s+/g, " ").trim().slice(0, 80);

/**
 * Captura um nome de estado descritivo para a página atual.
 * Para SPAs onde a URL não muda entre etapas, extrai contexto visual do DOM:
 * step indicators, headings ativos de modal/formulário, título da página, etc.
 * 
 * Retorna algo como:
 *   "https://site.com/pagina"                              (URL normal)
 *   "https://site.com/pagina | Step 2: Dados pessoais"     (SPA com step indicator)
 *   "https://site.com/pagina | Modal: Escolha o seguro"    (modal aberto)
 *   "https://site.com/pagina | Etapa 2 de 3"              (progress indicator)
 */
const capturePageState = async (
  page: import("playwright").Page,
  baseUrl?: string,
): Promise<string> => {
  const url = page.url() || baseUrl || "";

  try {
    const stateData = await page.evaluate(() => {
      // 1. Step indicator com aria-current ou active
      const stepCurrent = document.querySelector(
        "[aria-current='step'], [class*='step'][class*='active'], [class*='step'][class*='current'], " +
        "[class*='wizard'][class*='active'], [class*='progress'][class*='active']"
      );
      if (stepCurrent) {
        const stepText = (stepCurrent.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
        if (stepText) return { context: `Step: ${stepText}`, semantic: "" };
      }

      // 2. Indicador numérico de step (ex: "2 de 3", "Passo 2", "Etapa 2")
      const stepLabels = document.querySelectorAll(
        "[class*='step-label'], [class*='step-title'], [class*='wizard-step'], " +
        "[class*='step-indicator'], [class*='breadcrumb-item'][class*='active']"
      );
      for (const el of Array.from(stepLabels)) {
        const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
        if (text && /\d/.test(text)) return { context: `Step: ${text}`, semantic: "" };
      }

      // 3. Heading ativo de modal/dialog (tela mais específica)
      const openModal = document.querySelector(
        "[role='dialog']:not([hidden]), [role='dialog'][open], " +
        ".modal.show, .modal.active, [class*='modal'][class*='open'], " +
        "[aria-modal='true']"
      );
      if (openModal) {
        const modalTitle = openModal.querySelector("h1, h2, h3, [class*='modal-title'], [class*='dialog-title']");
        const titleText = (modalTitle?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
        if (titleText) return { context: `Modal: ${titleText}`, semantic: "" };
        const firstText = (openModal.querySelector("h1, h2, h3")?.textContent ?? "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 80);
        if (firstText) return { context: `Modal: ${firstText}`, semantic: "" };
      }

      // 4. Heurísticas estruturais para jornadas SPA sem marcador de step explícito
      const visibleButtons = Array.from(document.querySelectorAll("button, [role='button']")).filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      const buttonTexts = visibleButtons
        .map((btn) => (btn.textContent ?? "").trim().replace(/\s+/g, " ").toLowerCase())
        .filter(Boolean);

      const bodyText = (document.body?.innerText ?? "").trim().replace(/\s+/g, " ").toLowerCase();
      const summaryPanel = document.querySelector(
        "aside, [class*='summary'], [class*='resumo'], [class*='proposal'], [class*='proposta'], [class*='cart'], [class*='cesta'], [class*='basket'], [class*='drawer'], [class*='sidebar']",
      );
      const summaryPanelText = (summaryPanel?.textContent ?? "").trim().replace(/\s+/g, " ").toLowerCase();

      const cartCtaText = buttonTexts.join(" | ");
      if (
        /(ver proposta|atualizar cesta|editar produtos|checkout|fechar pedido|finalizar pedido)/.test(cartCtaText) ||
        /(ver proposta|atualizar cesta|editar produtos|checkout|fechar pedido|finalizar pedido)/.test(summaryPanelText)
      ) {
        return { context: "Step: Resumo de proposta", semantic: "" };
      }

      // 5. Formulário ativo com título/legend/fieldset
      const activeForm = document.querySelector(
        "form:not([hidden]), [role='form']"
      );
      if (activeForm) {
        const formTitle = activeForm.querySelector("legend, [class*='form-title'], h1, h2, h3");
        const formText = (formTitle?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
        if (formText) return { context: `Form: ${formText}`, semantic: "" };
      }

      // 6. H1 visível principal (não vazio, não genérico)
      const h1 = document.querySelector("h1");
      const h1Text = (h1?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
      if (h1Text && h1Text.length > 3) return { context: h1Text, semantic: "" };

      const visibleInputs = Array.from(document.querySelectorAll("input, select, textarea")).filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      const inputHints = visibleInputs
        .map((input) => {
          const element = input as HTMLInputElement;
          return `${element.name || ""} ${element.id || ""} ${element.getAttribute("placeholder") || ""}`.toLowerCase();
        })
        .join(" | ");

      if (/(cpf|data.?nascimento|nome.?completo|celular|email|endereco|endereço)/.test(inputHints)) {
        return { context: "Step: Dados pessoais", semantic: "" };
      }

      if (
        buttonTexts.some((txt) => /quero este|selecionar plano|contratar plano|simular plano/.test(txt)) ||
        /(selecione o plano|escolha o plano|resumo da viagem|coberturas|quero este)/.test(bodyText)
      ) {
        return { context: "Step: Seleção de plano", semantic: "" };
      }

      if (/(startdate|enddate|data de ida|data de volta|react-select-2-input|seguir com a cotação)/.test(inputHints + " | " + buttonTexts.join(" | "))) {
        return { context: "Step: Informações da viagem", semantic: "" };
      }

      // 7. Título do documento (fallback)
      const title = (document.title ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
      if (title && title.length > 3) {
        const semanticTitle = [title.toLowerCase(), buttonTexts.slice(0, 8).join("|"), inputHints.slice(0, 180)].join("::");
        return { context: title, semantic: semanticTitle };
      }

      const fallbackHeading = (document.querySelector("h1, h2, h3")?.textContent ?? "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 80);
      const semantic = [fallbackHeading.toLowerCase(), buttonTexts.slice(0, 8).join("|"), inputHints.slice(0, 180)]
        .join("::")
        .slice(0, 350);

      return { context: "", semantic };
    });

    if (stateData?.context) {
      return `${url} | ${stateData.context}`;
    }

    if (stateData?.semantic) {
      const semanticHash = hashContent(stateData.semantic).slice(0, 10);
      return `${url} | State:${semanticHash}`;
    }
  } catch (error) {
    console.warn(`[CRAWLER][STATE] capturePageState fallback to URL: ${String(error)}`);
  }

  return url;
};

const summarizeElementTarget = (details: {
  kind: string;
  text: string;
  ariaLabel: string;
  title: string;
  href: string;
  id: string;
  dataAttr: string;
  context: string;
  selector: string;
}) => {
  const pairs = [
    `kind=${details.kind}`,
    details.text ? `text=${details.text}` : "",
    details.ariaLabel ? `aria=${details.ariaLabel}` : "",
    details.title ? `title=${details.title}` : "",
    details.href ? `href=${details.href}` : "",
    details.id ? `id=${details.id}` : "",
    details.dataAttr ? `data=${details.dataAttr}` : "",
    details.context ? `context=${details.context}` : "",
    `selector=${details.selector}`,
  ].filter(Boolean);
  return pairs.join(" | ");
};

const toBrazilDate = (rawValue: string) => {
  const asIso = /^\d{4}-\d{2}-\d{2}$/.test(rawValue);
  if (!asIso) return rawValue;
  const [year, month, day] = rawValue.split("-");
  if (!year || !month || !day) return rawValue;
  return `${day}/${month}/${year}`;
};

const isDateLikeField = (fieldName: string, idValue: string, labelText: string, inputType: string) => {
  const hints = `${fieldName} ${idValue} ${labelText} ${inputType}`.toLowerCase();
  return /(date|data|inicio|fim|partida|retorno|checkin|checkout|fakedate|startdate|enddate)/i.test(hints);
};

const tryInteractReactSelect = async (
  page: import("playwright").Page,
  input: import("playwright").Locator,
  valueText: string,
) => {
  console.log(`[CRAWLER] ReactSelect start selection: ${valueText}`);
  const expected = valueText.trim().toLowerCase();

  const inputId = (await input.getAttribute("id").catch(() => null)) ?? "";
  const reactPrefix = inputId.endsWith("-input") ? inputId.slice(0, -6) : inputId;

  const readSelectedText = async () =>
    page
      .evaluate((prefix) => {
        const normalized = (s: string | null | undefined) => s?.trim().replace(/\s+/g, " ") ?? "";
        const selectedNode = prefix
          ? document.querySelector(`[id='${prefix}-single-value']`)
          : document.querySelector("[class*='singleValue'], [class*='single-value']");
        if (selectedNode && selectedNode.textContent) {
          return normalized(selectedNode.textContent);
        }
        const fallbackRoot = prefix
          ? document.querySelector(`[id='${prefix}-value-container']`)
          : document.querySelector("[class*='select__value-container']");
        return normalized(fallbackRoot?.textContent);
      }, reactPrefix)
      .catch(() => "");

  await input.click({ timeout: 2_500 }).catch(() => undefined);
  await input.fill(valueText, { timeout: 2_500 }).catch(() => undefined);
  await page.waitForTimeout(300);

  const escapedValue = valueText.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const optionCandidates = [
    `.react-select__option:has-text("${valueText}")`,
    `.select__option:has-text("${valueText}")`,
    `[id*='react-select'][id*='option']:has-text("${valueText}")`,
    "[class*='option']",
  ];
  let selected = false;
  for (const selector of optionCandidates) {
    const option = page.locator(selector).first();
    const count = await option.count().catch(() => 0);
    if (count === 0) continue;
    const visible = await option.isVisible().catch(() => false);
    if (!visible) continue;
    await option.click({ timeout: 2_500 }).catch(() => undefined);
    await page.waitForTimeout(350);
    const selectedText = (await readSelectedText()).toLowerCase();
    if (selectedText.includes(expected)) {
      selected = true;
      break;
    }
  }

  if (!selected) {
    await page.keyboard.press("ArrowDown").catch(() => undefined);
    await page.keyboard.press("Enter").catch(() => undefined);
    await page.waitForTimeout(350);
    const selectedText = (await readSelectedText()).toLowerCase();
    selected = selectedText.includes(expected);
  }

  if (!selected) {
    const fallbackOption = page.locator(`[id*='react-select'][id*='option']:has-text("${escapedValue}")`).first();
    const canClickFallback =
      (await fallbackOption.count().catch(() => 0)) > 0 &&
      (await fallbackOption.isVisible().catch(() => false));
    if (canClickFallback) {
      await fallbackOption.click({ timeout: 2_500 }).catch(() => undefined);
    }
  }
  console.log(`[CRAWLER] ReactSelect selection finished: ${valueText}`);
};

const isDownloadTarget = (rawUrl: string): boolean => {
  try {
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname.toLowerCase();
    if (blockedDownloadExtensions.some((ext) => pathname.endsWith(ext))) {
      return true;
    }
    const format = parsed.searchParams.get("format")?.toLowerCase();
    if (format && blockedDownloadExtensions.some((ext) => ext.slice(1) === format)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
};

const extractLinks = (html: string, baseUrl: string) => {
  const $ = load(html);
  return $("a[href]")
    .toArray()
    .slice(0, 80)
    .map((element) => $(element).attr("href"))
    .filter((href): href is string => Boolean(href))
    .map((href) => {
      try {
        return new URL(href, baseUrl).toString();
      } catch {
        return null;
      }
    })
    .filter((href): href is string => Boolean(href))
    .filter((href) => !isDownloadTarget(href));
};

const createInitialQueue = (config: CrawlConfig): QueueItem[] =>
  config.urls.map((root) => ({
    url: root.url,
    depth: 0,
    allowedDomains: root.allowedDomains,
    maxDepth: root.depth,
    maxActions: root.maxActions,
    maxStates: root.maxStates,
    singleUrlMode: root.singleUrlMode || config.singleUrlMode,
  }));

const publishProgress = (hooks: CrawlHooks | undefined, payload: CrawlProgress) => {
  hooks?.onProgress?.(payload);
};

const runFetchEngine = async (config: CrawlConfig, hooks?: CrawlHooks): Promise<CrawlOutput> => {
  const actions: CrawlAction[] = [];
  const events: CrawlEvent[] = [];
  const warnings: CrawlWarning[] = [];
  const ignoredFields: IgnoredField[] = [];
  const visited = new Set<string>();
  const visitedUrls = new Set<string>();
  const queue = createInitialQueue(config);
  let totalActions = 0;
  publishProgress(hooks, {
    phase: "starting",
    currentUrl: config.urls[0]?.url ?? "",
    queuedUrls: queue.length,
    actionsCount: totalActions,
    eventsCount: events.length,
    statesDiscovered: visited.size,
    visitedUrls: [],
    message: "Iniciando exploração",
  });

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    publishProgress(hooks, {
      phase: "navigating",
      currentUrl: current.url,
      queuedUrls: queue.length,
      actionsCount: totalActions,
      eventsCount: events.length,
      statesDiscovered: visited.size,
      visitedUrls: Array.from(visitedUrls).slice(-20),
      message: "Navegando para próxima URL",
    });

    try {
      const currentUrl = new URL(current.url);
      if (!isAllowedUrl(currentUrl, current.allowedDomains)) continue;
      if (isDownloadTarget(current.url)) {
        warnings.push({
          type: "spa_router",
          message: `Download ignorado: ${current.url}`,
        });
        continue;
      }
      await assertSafeTarget(currentUrl);

      if (visited.size >= current.maxStates || totalActions >= current.maxActions) {
        break;
      }

      const response = await fetch(current.url);
      const html = await response.text();
      const stateHash = hashContent(`${current.url}:${html}`);
      if (visited.has(stateHash)) continue;

      visited.add(stateHash);
      visitedUrls.add(current.url);
      publishProgress(hooks, {
        phase: "processing",
        currentUrl: current.url,
        queuedUrls: queue.length,
        actionsCount: totalActions,
        eventsCount: events.length,
        statesDiscovered: visited.size,
        visitedUrls: Array.from(visitedUrls).slice(-20),
        message: "Processando página e detectando eventos",
      });

      if (hasBlockingCaptcha(html)) {
        warnings.push({ type: "captcha", message: `CAPTCHA detectado em ${current.url}` });
        publishProgress(hooks, {
          phase: "paused",
          currentUrl: current.url,
          queuedUrls: queue.length,
          actionsCount: totalActions,
          eventsCount: events.length,
          statesDiscovered: visited.size,
          visitedUrls: Array.from(visitedUrls).slice(-20),
          message: "Execução pausada por CAPTCHA",
        });
        return {
          status: "paused",
          pauseCheckpoint: { url: current.url, reason: "captcha_detected" },
          actions,
          events,
          ignoredFields,
          warnings,
          statesDiscovered: visited.size,
        };
      }

      const navigateAction: CrawlAction = {
      id: randomUUID(),
      type: "navigate",
      targetSelector: "document",
      stateBefore: current.url,
      stateAfter: current.url,
      url: current.url,
      timestamp: new Date().toISOString(),
    };
      actions.push(navigateAction);
      totalActions += 1;

      events.push({
      id: randomUUID(),
      actionId: navigateAction.id,
      eventType: "page_view",
      technology: "custom",
      eventName: "page_view",
      url: current.url,
      stateName: current.url,
      parameters: { source: "fetch_engine" },
      consentState: "unknown",
      status: "observed",
      correlationConfidence: "high",
      timestamp: new Date().toISOString(),
    });

      events.push(...detectTrackingEventsFromHtml(html, current.url, navigateAction.id, "unknown"));

      const $ = load(html);
      $("input, select, textarea").each((index, element) => {
        const mapping = resolveFieldMapping($, element, config.templateKeys);
        if (mapping.type === "ignored") {
          const fieldName =
            $(element).attr("name") ??
            $(element).attr("id") ??
            $(element).attr("aria-label") ??
            $(element).attr("placeholder") ??
            (normalizeFieldDescriptor($(element).closest("label, form, section, article, div").text()) || `field_${index}`);
          ignoredFields.push({
            fieldName,
            cssSelector: element.tagName ?? "input",
            reason: mapping.reason,
          });
        }
      });

      // Single URL Mode: não extrai links de outras páginas
      const singleUrlModeEnabled = current.singleUrlMode || config.singleUrlMode;
      if (!singleUrlModeEnabled && current.depth < current.maxDepth) {
        const links = extractLinks(html, current.url);
        for (const link of links) {
          const next = new URL(link);
          if (isAllowedUrl(next, current.allowedDomains)) {
            queue.push({ ...current, depth: current.depth + 1, url: link });
          }
        }
      }
    } catch (error) {
      warnings.push({
        type: "spa_router",
        message: `Falha ao processar URL ${current.url}: ${String(error)}`,
      });
      continue;
    }
  }

  return {
    status: "completed",
    actions,
    events,
    ignoredFields,
    warnings,
    statesDiscovered: visited.size,
  };
};

const runPlaywrightEngine = async (config: CrawlConfig, hooks?: CrawlHooks): Promise<CrawlOutput> => {
  const actions: CrawlAction[] = [];
  const events: CrawlEvent[] = [];
  const warnings: CrawlWarning[] = [];
  const ignoredFields: IgnoredField[] = [];
  const visited = new Set<string>();
  const visitedUrls = new Set<string>();
  const queue = createInitialQueue(config);
  let totalActions = 0;
  let lastProgressEventsCount = 0;
  let fatalFailure: string | null = null;
  let stopReason: string | undefined;
  const stateScreenshots: Record<string, string> = {};
  const capturedStateSnapshots = new Set<string>();
  const MAX_SCREENSHOTS = 20;
  const unclassifiedTrackerCounts = new Map<string, number>();

  // Helper: capture screenshot synchronously for a new state (before page closes)
  const maybeCaptureScreenshot = async (stateName: string, page: import("playwright").Page) => {
    if (!stateName || Object.keys(stateScreenshots).length >= MAX_SCREENSHOTS) return;
    try {
      const signature = (await captureTransitionSignature(page)).slice(0, 10);
      const snapshotKey = `${stateName}@@${signature}`;
      if (capturedStateSnapshots.has(snapshotKey)) return;
      capturedStateSnapshots.add(snapshotKey);

      // Full-page screenshots avoid repeated header-only captures in long SPA states.
      const buf = await page.screenshot({ type: "jpeg", quality: 20, fullPage: true, timeout: 8_000 });
      const existingForState = Object.keys(stateScreenshots).filter((key) => key === stateName || key.startsWith(`${stateName}@@`));
      const storageKey = existingForState.length === 0 ? stateName : `${stateName}@@${signature}`;
      stateScreenshots[storageKey] = `data:image/jpeg;base64,${buf.toString("base64")}`;
    } catch (error) {
      console.warn(`[CRAWLER] Screenshot capture failed for state "${stateName}": ${String(error)}`);
    }
  };
  publishProgress(hooks, {
    phase: "starting",
    currentUrl: config.urls[0]?.url ?? "",
    queuedUrls: queue.length,
    actionsCount: totalActions,
    eventsCount: events.length,
    statesDiscovered: visited.size,
    visitedUrls: [],
    message: "Iniciando exploração em navegador real",
  });

  let headless = config.browserMode
    ? config.browserMode !== "visual"
    : process.env.CRAWLER_HEADLESS !== "false";
  if (!headless && process.platform !== "win32" && !process.env.DISPLAY) {
    warnings.push({
      type: "navigation_blocked",
      message:
        "Modo visual solicitado, mas o ambiente não possui DISPLAY/XServer. Aplicando fallback automático para headless e continuando a execução.",
    });
    headless = true;
  }
  const slowMoValue = Number(process.env.CRAWLER_SLOWMO_MS ?? "0");
  const browser = await chromium.launch({
    headless,
    slowMo: Number.isFinite(slowMoValue) && slowMoValue > 0 ? slowMoValue : 0,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1280,800",
      "--lang=pt-BR",
    ],
  });

  // Expor função de fechamento para o serviço externo poder encerrar o browser quando timeout global disparar
  hooks?.onBrowserReady?.(async () => {
    try { await browser.close(); } catch { /* ignorar erros ao fechar */ }
  });
  // Use a realistic stable Chrome UA that matches the Chromium major version
  const stealthUA =
    process.env.CRAWLER_USER_AGENT ??
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  const context = await browser.newContext({
    userAgent: stealthUA,
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: {
      "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "Upgrade-Insecure-Requests": "1",
    },
  });

  // Comprehensive stealth: remove all automation fingerprints
  await context.addInitScript(() => {
    // 1. Remove webdriver flag
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });

    // 2. Add window.chrome (absent in headless = detected)
    (window as unknown as Record<string, unknown>)["chrome"] = {
      app: { isInstalled: false, InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" }, RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" } },
      csi: () => ({}),
      loadTimes: () => ({}),
      runtime: {},
    };

    // 3. Override plugins to non-empty list
    const pluginData = [
      { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format" },
      { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
      { name: "Native Client", filename: "internal-nacl-plugin", description: "" },
    ];
    Object.defineProperty(navigator, "plugins", { get: () => pluginData });
    Object.defineProperty(navigator, "mimeTypes", { get: () => [] });

    // 4. Consistent languages
    Object.defineProperty(navigator, "languages", { get: () => ["pt-BR", "pt", "en-US", "en"] });

    // 5. Permissions API — Notification returns 'default' instead of 'denied'
    const origPerms = window.navigator.permissions?.query.bind(window.navigator.permissions);
    if (origPerms) {
      Object.defineProperty(window.navigator.permissions, "query", {
        value: (params: PermissionDescriptor) =>
          params.name === "notifications"
            ? Promise.resolve({ state: "default", onchange: null })
            : origPerms(params),
      });
    }

    // 6. userAgentData brands — must match UA string
    if ("userAgentData" in navigator) {
      Object.defineProperty(navigator, "userAgentData", {
        get: () => ({
          brands: [
            { brand: "Google Chrome", version: "131" },
            { brand: "Chromium", version: "131" },
            { brand: "Not_A Brand", version: "24" },
          ],
          mobile: false,
          platform: "Windows",
          getHighEntropyValues: (hints: string[]) => Promise.resolve(
            Object.fromEntries(hints.map(h => [h, h === "platform" ? "Windows" : h === "platformVersion" ? "10.0.0" : ""]))
          ),
        }),
      });
    }

    // 7. Remove Playwright/CDP artifacts
    for (const k of ["__playwright", "__pwInitScripts", "__pw_manual", "cdc_adoQpoasnfa76pfcZLmcfl_Array", "cdc_adoQpoasnfa76pfcZLmcfl_Promise", "cdc_adoQpoasnfa76pfcZLmcfl_Symbol"]) {
      try { delete (window as unknown as Record<string, unknown>)[k]; } catch { /* noop */ }
    }

    // 8. Realistic hardware concurrency and memory
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
    Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });

    // 9. WebGL vendor — headless reports SwiftShader which is a bot signal
    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param) {
      if (param === 37445) return "Intel Inc.";  // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return "Intel Iris OpenGL Engine"; // UNMASKED_RENDERER_WEBGL
      return getParam.call(this, param);
    };
  });

  // Track WAF-blocked domains — one warning per domain, not one per URL
  const wafBlockedDomains = new Set<string>();
  let wafBlockedUrlCount = 0;

  try {
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      publishProgress(hooks, {
        phase: "navigating",
        currentUrl: current.url,
        queuedUrls: queue.length,
        actionsCount: totalActions,
        eventsCount: events.length,
        statesDiscovered: visited.size,
        visitedUrls: Array.from(visitedUrls).slice(-20),
        message: "Abrindo URL no navegador",
      });

      const currentUrl = new URL(current.url);
      if (!isAllowedUrl(currentUrl, current.allowedDomains)) continue;
      if (isDownloadTarget(current.url)) {
        warnings.push({
          type: "spa_router",
          message: `Download ignorado: ${current.url}`,
        });
        continue;
      }
      await assertSafeTarget(currentUrl);

      if (visited.size >= current.maxStates) {
        stopReason = `max_states:${current.maxStates} estados explorados`;
        break;
      }
      if (totalActions >= current.maxActions) {
        stopReason = `max_actions:${current.maxActions} ações executadas`;
        break;
      }


      const page = await context.newPage();
      // Per-URL timeout: se uma URL demorar mais que 2 min, fecha a página e passa para a próxima
      const PER_URL_TIMEOUT_MS = 120_000;
      let urlTimedOut = false;
      const urlTimeoutId = setTimeout(() => {
        urlTimedOut = true;
        console.log(`[CRAWLER] Per-URL timeout (${PER_URL_TIMEOUT_MS / 1000}s) atingido para ${current.url} — fechando página`);
        page.close().catch(() => {});
      }, PER_URL_TIMEOUT_MS);
      await page.route("**/*", async (route) => {
        const requestUrl = route.request().url();
        if (isDownloadTarget(requestUrl)) {
          warnings.push({
            type: "spa_router",
            message: `Request de download bloqueado: ${requestUrl}`,
          });
          await route.abort();
          return;
        }
        await route.continue();
      });
      const navigateAction: CrawlAction = {
        id: randomUUID(),
        type: "navigate",
        targetSelector: "document",
        stateBefore: current.url,
        stateAfter: current.url,
        url: current.url,
        timestamp: new Date().toISOString(),
      };
      actions.push(navigateAction);
      totalActions += 1;
      let activeActionId: string | null = navigateAction.id;
      let activeStateName: string = current.url;
      let consentAccepted = false;
      let travelSubmitHandled = false;
      let quoteModalSubmitHandled = false;
      let anyDynamicCtaClicked = false;
      let foundFillableFields = false;
      let travelFormReadyForSubmit = false;
      let fillPhaseCompleted = false;
      const pushUiStateSnapshotEvent = (actionId: string | null, source: string) => {
        events.push({
          id: randomUUID(),
          actionId,
          eventType: "state_snapshot",
          technology: "custom",
          eventName: "ui_state_snapshot",
          url: page.url() || current.url,
          stateName: activeStateName,
          parameters: { source },
          consentState: consentAccepted ? "after_consent" : "before_consent",
          status: "observed",
          correlationConfidence: actionId ? "high" : "low",
          timestamp: new Date().toISOString(),
        });
      };
      const requestEventByRequest = new WeakMap<import("playwright").Request, CrawlEvent>();
      page.on("response", (response) => {
        const request = response.request();
        const eventRef = requestEventByRequest.get(request);
        if (!eventRef) return;
        const payload = eventRef.requestPayload ?? {};
        eventRef.requestPayload = {
          ...payload,
          status: response.status(),
          ok: response.ok(),
        };
        if (!response.ok()) {
          eventRef.status = "flagged";
          if (eventRef.correlationConfidence === "high") {
            eventRef.correlationConfidence = "low";
          }
        }
      });
      page.on("request", (request) => {
        const requestUrl = request.url();
        const parsed = parseTrackingRequest(requestUrl);
        if (!parsed && !isPotentialTrackerUrl(requestUrl)) return;

        const requestParams = new URL(requestUrl).searchParams;
        const sanitized: Record<string, string> = {};
        for (const [name, value] of requestParams.entries()) {
          sanitized[name] = sanitizeParameter(name, value);
        }
        const host = (() => {
          try {
            return new URL(requestUrl).hostname.toLowerCase();
          } catch {
            return "unknown-host";
          }
        })();
        if (!parsed) {
          const currentCount = unclassifiedTrackerCounts.get(host) ?? 0;
          if (currentCount >= 12) return;
          unclassifiedTrackerCounts.set(host, currentCount + 1);
        }

        const createdEvent: CrawlEvent = {
          id: randomUUID(),
          actionId: activeActionId,
          eventType: "request_observed",
          technology: parsed?.technology ?? "unclassified_tracker",
          eventName: parsed?.eventName ?? `network_unclassified:${host}`,
          url: page.url() || current.url,
          stateName: activeStateName,
          parameters: sanitized,
          requestPayload: {
            source: "crawler_request",
            requestUrl,
            method: request.method(),
            resourceType: request.resourceType(),
          },
          consentState: consentAccepted ? "after_consent" : "before_consent",
          status: "observed",
          correlationConfidence: activeActionId ? "high" : "low",
          timestamp: new Date().toISOString(),
        };
        events.push(createdEvent);
        requestEventByRequest.set(request, createdEvent);
        if (events.length - lastProgressEventsCount >= 5) {
          lastProgressEventsCount = events.length;
          publishProgress(hooks, {
            phase: "processing",
            currentUrl: page.url() || current.url,
            queuedUrls: queue.length,
            actionsCount: totalActions,
            eventsCount: events.length,
            statesDiscovered: visited.size,
            visitedUrls: Array.from(visitedUrls).slice(-20),
            message: "Capturando requests de tracking",
          });
        }
      });

      try {
        console.log(`[CRAWLER] Starting navigation to ${current.url}`);
        let navResponse: import("playwright").Response | null = null;
        navResponse = await page.goto(current.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        console.log(`[CRAWLER] Page loaded, waiting for SPA rendering...`);

        // Check for WAF / bot-management block immediately after navigation
        const navStatus = navResponse?.status() ?? 0;
        let navHtml = await page.content().catch(() => "");

        if (isWafBlock(navHtml, navStatus)) {
          const cfRay = navResponse?.headers()["cf-ray"] ?? "";
          const pageTitle = await page.title().catch(() => "");
          const accessClassification = classifyBlockedNavigation(navStatus, pageTitle, navHtml);
          console.log(`[CRAWLER] WAF block detected (status=${navStatus}, cf-ray=${cfRay}), waiting up to 8s for JS challenge to auto-resolve...`);

          // Cloudflare JS challenge typically auto-resolves in 5-10s when the browser passes.
          // We wait for a navigation away from the challenge page.
          const resolved = await Promise.race([
            page.waitForFunction(
              () => !document.title.toLowerCase().includes("blocked") &&
                    !document.title.toLowerCase().includes("just a moment") &&
                    !document.body?.innerText?.toLowerCase().includes("sorry, you have been blocked"),
              { timeout: 8_000 }
            ).then(() => true).catch(() => false),
            new Promise<false>(resolve => setTimeout(() => resolve(false), 8_000)),
          ]);

          navHtml = await page.content().catch(() => "");
          const stillBlocked = isWafBlock(navHtml, 0);

          if (!stillBlocked || resolved) {
            console.log(`[CRAWLER] CF challenge auto-resolved after wait`);
          } else {
            // Deduplicate: one warning per blocked domain, not per URL
            const blockedDomain = (() => { try { return new URL(current.url).hostname; } catch { return current.url; } })();
            wafBlockedUrlCount += 1;
            const waitDetail = resolved
              ? "challenge aparente, mas bloqueio persistiu"
              : "sem auto-resolução após espera de até 8s";
            warnings.push({
              type: "navigation_blocked",
              message: `Navegação ${accessClassification}: ${current.url} (status=${navStatus || 0}, cf-ray=${cfRay || "n/a"}, ${waitDetail})`,
            });
            if (!wafBlockedDomains.has(blockedDomain)) {
              wafBlockedDomains.add(blockedDomain);
              const warnMsg = accessClassification === "challenge_detected"
                ? `Desafio de verificação humana detectado em ${blockedDomain}; a rota não foi explorada.`
                : `WAF/Cloudflare bloqueou ${blockedDomain} (HTTP ${navStatus || "desconhecido"}); a rota não foi explorada.`;
              warnings.push({ type: "captcha", message: warnMsg });
            }
            publishProgress(hooks, {
              phase: "paused",
              currentUrl: current.url,
              queuedUrls: queue.length,
              actionsCount: totalActions,
              eventsCount: events.length,
              statesDiscovered: visited.size,
              visitedUrls: Array.from(visitedUrls).slice(-20),
              message: `⚠️ ${accessClassification} em ${current.url} (${wafBlockedUrlCount} URL(s) bloqueadas no total)`,
            });
            // Preserve visual evidence without treating a challenge as content.
            await maybeCaptureScreenshot(`BLOCKED: ${current.url}`, page);
            await page.close();
            continue;
          }
        }
        
        // Aguardar aplicação SPA renderizar componentes (modais, formulários dinâmicos)
        // Tenta esperar por networkidle com timeout curto, se falhar continua mesmo assim
        const startNetworkIdle = Date.now();
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {
          console.log(`[CRAWLER] networkidle timeout after ${Date.now() - startNetworkIdle}ms (expected, continuing)`);
          return Promise.resolve();
        });
        console.log(`[CRAWLER] networkidle complete in ${Date.now() - startNetworkIdle}ms`);

        const initialReady = await waitForPageReady(page, "initial_navigation", 15_000);
        console.log(
          `[CRAWLER] Post-render readiness: ready=${initialReady.ready} elapsed=${initialReady.elapsedMs}ms signals=${initialReady.visibleSignals}`,
        );
        await page.waitForTimeout(500);
        console.log(`[CRAWLER] Post-render wait complete, searching for forms...`);

        // Capture baseline screenshot for the raw URL state so every discovered
        // state label has at least one visual artifact in reports.
        await maybeCaptureScreenshot(current.url, page);

        // Capturar estado visual da página após SPA renderizar
        activeStateName = await capturePageState(page, current.url);
        console.log(`[CRAWLER] Active state name: ${activeStateName}`);

        // Take a thumbnail screenshot for new states (max 20, JPEG quality 25)
        await maybeCaptureScreenshot(activeStateName, page);

        const acceptedConsentCount = await consumeConsentPrompts(page);
        if (acceptedConsentCount > 0) {
          consentAccepted = true;
          for (let i = 0; i < acceptedConsentCount; i += 1) {
            actions.push({
              id: randomUUID(),
              type: "consent",
              targetSelector: `kind=banner | text=accept consent | context=banner | ordinal=${i + 1}`,
              stateBefore: activeStateName,
              stateAfter: activeStateName,
              url: page.url(),
              timestamp: new Date().toISOString(),
            });
            totalActions += 1;
          }
          publishProgress(hooks, {
            phase: "processing",
            currentUrl: page.url() || current.url,
            queuedUrls: queue.length,
            actionsCount: totalActions,
            eventsCount: events.length,
            statesDiscovered: visited.size,
            visitedUrls: Array.from(visitedUrls).slice(-20),
            message: `Consentimentos aceitos: ${acceptedConsentCount}`,
          });
          events.push({
            id: randomUUID(),
            actionId: activeActionId,
            eventType: "consent_updated",
            technology: "custom",
            eventName: "consent_accept",
            url: page.url() || current.url,
            stateName: activeStateName,
            parameters: { source: "consent_banner", acceptedCount: acceptedConsentCount },
            requestPayload: { source: "consent_banner_click", method: "ui_click", status: 200, ok: true },
            consentState: "after_consent",
            status: "observed",
            correlationConfidence: "high",
            timestamp: new Date().toISOString(),
          });
        }

        const html = await page.content();
        const stateHash = hashContent(`${page.url()}:${html}`);
        if (visited.has(stateHash)) {
          await page.close();
          continue;
        }

        visited.add(stateHash);
        visitedUrls.add(page.url() || current.url);
        publishProgress(hooks, {
          phase: "processing",
          currentUrl: page.url() || current.url,
          queuedUrls: queue.length,
          actionsCount: totalActions,
          eventsCount: events.length,
          statesDiscovered: visited.size,
          visitedUrls: Array.from(visitedUrls).slice(-20),
          message: "Página carregada e analisada",
        });
        if (await hasVisibleCaptcha(page, html)) {
          warnings.push({ type: "captcha", message: `CAPTCHA detectado em ${page.url()}` });
          publishProgress(hooks, {
            phase: "paused",
            currentUrl: page.url() || current.url,
            queuedUrls: queue.length,
            actionsCount: totalActions,
            eventsCount: events.length,
            statesDiscovered: visited.size,
            visitedUrls: Array.from(visitedUrls).slice(-20),
            message: "Execução pausada por CAPTCHA",
          });
          await page.close();
          return {
            status: "paused",
            pauseCheckpoint: { url: page.url(), reason: "captcha_detected" },
            actions,
            events,
            ignoredFields,
            warnings,
            statesDiscovered: visited.size,
          };
        }

        navigateAction.stateAfter = page.url();
        navigateAction.url = page.url();

        events.push({
          id: randomUUID(),
          actionId: navigateAction.id,
          eventType: "page_view",
          technology: "custom",
          eventName: "page_view",
          url: page.url(),
          stateName: activeStateName,
          parameters: { source: "playwright" },
          consentState: consentAccepted ? "after_consent" : "before_consent",
          status: "observed",
          correlationConfidence: "high",
          timestamp: new Date().toISOString(),
        });
        events.push(
          ...detectTrackingEventsFromHtml(
            html,
            page.url(),
            navigateAction.id,
            consentAccepted ? "after_consent" : "before_consent",
          ),
        );

        const $ = load(html);
        const fillActionId = randomUUID();
        let didFill = false;
        const mappedFields: Array<{
          fieldName: string;
          tagName: string;
          inputType: string;
          value: string;
          selectorCandidates: string[];
          labelText: string;
          ariaLabel: string;
          title: string;
          idValue: string;
          dataAttr: string;
          context: string;
        }> = [];
        $("input, select, textarea").each((index, element) => {
          const tagName = (element.tagName ?? "").toLowerCase();
          const inputType = ($(element).attr("type") ?? "").toLowerCase();
          const inlineStyle = ($(element).attr("style") ?? "").toLowerCase();
          const isHiddenLike =
            inputType === "hidden" ||
            $(element).attr("disabled") !== undefined ||
            $(element).attr("readonly") !== undefined ||
            $(element).attr("aria-hidden") === "true" ||
            inlineStyle.includes("display:none") ||
            inlineStyle.includes("visibility:hidden");
          if (isHiddenLike) return;

          const mapping = resolveFieldMapping($, element, config.templateKeys);
          const fieldName = $(element).attr("name") ?? $(element).attr("id") ?? `field_${index}`;
          if (mapping.type === "mapped") {
            didFill = true;
            const id = $(element).attr("id");
            const name = $(element).attr("name");
            const selectorCandidates = [
              id ? `[id="${escapeSelectorAttribute(id)}"]` : null,
              name ? `[name="${escapeSelectorAttribute(name)}"]` : null,
            ].filter((candidate): candidate is string => Boolean(candidate));
            mappedFields.push({
              fieldName,
              tagName,
              inputType,
              value: mapping.value,
              selectorCandidates,
              labelText: (
                (($(element).closest("label").text() || $("label[for='" + (id ?? "") + "']").first().text()) ?? "")
                  .trim()
                  .replace(/\s+/g, " ")
                  .slice(0, 80) || fieldName
              ),
              ariaLabel: (($(element).attr("aria-label") ?? "").trim() || "").slice(0, 80),
              title: (($(element).attr("title") ?? "").trim() || "").slice(0, 80),
              idValue: (id ?? "").trim().slice(0, 80),
              dataAttr: Object.keys((element.attribs ?? {}) as Record<string, string>)
                .filter((attr) => attr.startsWith("data-"))
                .slice(0, 3)
                .join(","),
              context:
                $(element).closest("[role='dialog'], .modal, [class*='modal']").length > 0
                  ? "modal"
                  : $(element).closest("header").length > 0
                    ? "header"
                    : $(element).closest("footer").length > 0
                      ? "footer"
                      : $(element).closest("[id*='banner'], [class*='banner']").length > 0
                        ? "banner"
                        : "content",
            });
          } else {
            ignoredFields.push({
              fieldName,
              cssSelector: element.tagName ?? "input",
              reason: mapping.reason,
            });
            warnings.push({
              type: "field_ignored",
              message: `Campo "${fieldName}" ignorado (${mapping.reason}) em ${page.url()}`,
            });
          }
        });
        const singleUrlModeEnabledForFill = current.singleUrlMode || config.singleUrlMode;
        const maxFormInteractions = singleUrlModeEnabledForFill
          ? current.maxActions
          : Math.max(8, Math.floor(current.maxActions * 0.6));
        let formInteractionsCount = 0;

        for (const field of mappedFields) {
          if (totalActions >= current.maxActions) break;
          if (formInteractionsCount >= maxFormInteractions) break;
          const selectorCandidates = field.selectorCandidates.length > 0 ? field.selectorCandidates : ["input,select,textarea"];
          let locator: import("playwright").Locator | null = null;
          let matchedSelector = selectorCandidates[0] ?? "input,select,textarea";
          for (const candidate of selectorCandidates) {
            const matches = page.locator(candidate);
            const count = Math.min(await matches.count(), 6);
            for (let idx = 0; idx < count; idx += 1) {
              const possible = matches.nth(idx);
              const visible = await possible.isVisible().catch(() => false);
              if (visible) {
                locator = possible;
                matchedSelector = `${candidate}:nth-match(${idx + 1})`;
                break;
              }
            }
            if (locator) break;
          }
          if (!locator) {
            warnings.push({
              type: "field_ignored",
              message: `Campo "${field.fieldName}" mapeado sem elemento visível para interação`,
            });
            continue;
          }

          const interactionType =
            field.inputType === "checkbox" || field.inputType === "radio"
              ? "check_field"
              : field.tagName === "select"
                ? "select_field"
                : "fill_field";
          const interactionAction: CrawlAction = {
            id: randomUUID(),
            type: interactionType,
            targetSelector: summarizeElementTarget({
              kind: field.inputType === "checkbox" || field.inputType === "radio" ? "field" : field.tagName === "select" ? "form" : "campo",
              text: field.labelText,
              ariaLabel: field.ariaLabel,
              title: field.title,
              href: "",
              id: field.idValue,
              dataAttr: field.dataAttr,
              context: field.context,
              selector: matchedSelector,
            }),
            stateBefore: activeStateName,
            stateAfter: activeStateName,
            url: page.url(),
            timestamp: new Date().toISOString(),
          };
          actions.push(interactionAction);
          totalActions += 1;
          formInteractionsCount += 1;
          const previousActionId: string | null = activeActionId;
          activeActionId = interactionAction.id;
          try {
            const lowered = field.value.toLowerCase();
            const shouldEnable = !["0", "false", "nao", "não", "off"].includes(lowered);
            if (field.inputType === "checkbox" || field.inputType === "radio") {
              if (shouldEnable) {
                await locator.check({ timeout: 2_500 });
              } else {
                await locator.uncheck({ timeout: 2_500 });
              }
            } else if (field.idValue.includes("react-select")) {
              await tryInteractReactSelect(page, locator, field.value);
            } else if (field.tagName === "select") {
              await locator.selectOption({ label: field.value }).catch(async () => {
                await locator!.selectOption(field.value);
              });
            } else {
              const shouldUseBrazilDate =
                field.inputType !== "date" && isDateLikeField(field.fieldName, field.idValue, field.labelText, field.inputType);
              const candidateValue = shouldUseBrazilDate ? toBrazilDate(field.value) : field.value;
              await locator.fill(candidateValue, { timeout: 2_500 });
              if (shouldUseBrazilDate) {
                await locator.press("Tab").catch(() => undefined);
              }
            }

            const nextStateName = await capturePageState(page, current.url);
            interactionAction.stateAfter = nextStateName;
            activeStateName = nextStateName;
            await maybeCaptureScreenshot(nextStateName, page);
            pushUiStateSnapshotEvent(interactionAction.id, "after_form_field_interaction");
            await waitForPageReady(page, `after_form_field_${field.fieldName}`, 6_000);

            const valid = await locator.evaluate((node) => {
              const elementNode = node as HTMLInputElement;
              return typeof elementNode.checkValidity === "function"
                ? elementNode.checkValidity()
                : true;
            });
            if (!valid) {
              warnings.push({
                type: "field_ignored",
                message: `Campo "${field.fieldName}" preenchido, mas inválido após validação nativa`,
              });
            }
          } catch (error: unknown) {
            warnings.push({
              type: "field_ignored",
              message: `Falha ao preencher ${field.fieldName}: ${String(error)}`,
            });
          } finally {
            activeActionId = previousActionId;
          }
        }

        if (didFill) {
          actions.push({
            id: fillActionId,
            type: "inspect_form",
            targetSelector: "form",
            stateBefore: page.url(),
            stateAfter: page.url(),
            url: page.url(),
            timestamp: new Date().toISOString(),
          });
          totalActions += 1;
        }

        // 🔍 DETECÇÃO DINÂMICA DE FORMULÁRIOS (SPA/Modal)
        // Procura por inputs que aparecem dinamicamente após JS executar
        // Isso é essencial para SPAs onde o HTML inicial não contém os formulários
        if (totalActions < current.maxActions && config.templateKeys.length > 0) {
          publishProgress(hooks, {
            phase: "processing",
            currentUrl: page.url() || current.url,
            queuedUrls: queue.length,
            actionsCount: totalActions,
            eventsCount: events.length,
            statesDiscovered: visited.size,
            visitedUrls: Array.from(visitedUrls).slice(-20),
            message: "Procurando por formulários dinâmicos (SPA/Modal)...",
          });

          // Procurar por inputs visíveis no Playwright (não apenas no HTML estático)
          const dynamicInputs = await page.locator("input, select, textarea").all();
          for (const input of dynamicInputs) {
            if (totalActions >= current.maxActions) break;
            
            try {
              const visible = await input.isVisible().catch(() => false);
              if (!visible) continue;

              const type = (await input.getAttribute("type")) || "text";
              const name = (await input.getAttribute("name")) || "";
              const id = (await input.getAttribute("id")) || "";
              const dateLikeIdentity = `${name} ${id}`.toLowerCase();
              if (/(startdate|enddate|fakedate|data.?ida|data.?volta|checkin|checkout)/i.test(dateLikeIdentity)) {
                continue;
              }
              
              // Ignorar campos já preenchidos ou hidden
              if (type === "hidden") continue;
              const isDisabled = await input.isDisabled().catch(() => false);
              if (isDisabled) continue;
              foundFillableFields = true;

              // Tentar encontrar mapeamento para este campo
              const labelElement = await input.evaluate((el) => {
                const fieldId = (el as HTMLInputElement).id;
                if (!fieldId) return null;
                const label = document.querySelector(`label[for="${fieldId}"]`);
                return label?.textContent?.trim() || null;
              });

              const dataField = (await input.getAttribute("data-field")) || "";
              const autocomplete = (await input.getAttribute("autocomplete")) || "";
              const placeholder = (await input.getAttribute("placeholder")) || "";
              const ariaLabel = (await input.getAttribute("aria-label")) || "";
              const contextText = await input
                .evaluate((el) =>
                  (el.closest("form, section, article, div")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240),
                )
                .catch(() => "");
              const foundMapping = resolveFieldMappingFromHints(
                {
                  name: name.toLowerCase(),
                  id: id.toLowerCase(),
                  dataField: dataField.toLowerCase(),
                  type: type.toLowerCase(),
                  autocomplete: autocomplete.toLowerCase(),
                  placeholder: placeholder.toLowerCase(),
                  ariaLabel: ariaLabel.toLowerCase(),
                  label: (labelElement || "").toLowerCase(),
                  contextText: contextText.toLowerCase(),
                },
                config.templateKeys,
              );

              if (foundMapping.type === "mapped") {
                // Preencher o campo dinâmico encontrado
                const fieldDesc = `${type}[name="${name}"][id="${id}"]`;
                const interactionAction: CrawlAction = {
                  id: randomUUID(),
                  type: type === "checkbox" || type === "radio" ? "check_field" : type === "select" ? "select_field" : "fill_field",
                  targetSelector: `dynamic_field | ${fieldDesc} | key=${foundMapping.key}`,
                  stateBefore: activeStateName,
                  stateAfter: activeStateName,
                  url: page.url(),
                  timestamp: new Date().toISOString(),
                };
                actions.push(interactionAction);
                totalActions += 1;

                try {
                  if (type === "checkbox" || type === "radio") {
                    const shouldCheck = !["0", "false", "nao", "não", "off"].includes(foundMapping.value.toLowerCase());
                    if (shouldCheck) {
                      await input.check({ timeout: 2_500 });
                    } else {
                      await input.uncheck({ timeout: 2_500 });
                    }
                  } else if (type === "select" || type === "combobox") {
                    await input.selectOption({ label: foundMapping.value }).catch(async () => {
                      await input.selectOption(foundMapping.value);
                    });
                  } else if ((id || "").includes("react-select")) {
                    await tryInteractReactSelect(page, input, foundMapping.value.trim());
                  } else {
                    await input.fill(foundMapping.value, { timeout: 2_500 });
                  }

                  const nextStateName = await capturePageState(page, current.url);
                  interactionAction.stateAfter = nextStateName;
                  activeStateName = nextStateName;
                  await maybeCaptureScreenshot(nextStateName, page);
                  pushUiStateSnapshotEvent(interactionAction.id, "after_dynamic_field_interaction");
                  await waitForPageReady(page, `after_dynamic_field_${foundMapping.key}`, 6_000);

                  didFill = true;
                  events.push({
                    id: randomUUID(),
                    actionId: interactionAction.id,
                    eventType: "form_filled_dynamic",
                    technology: "custom",
                    eventName: "form_field_filled_spa",
                    url: page.url(),
                    stateName: activeStateName,
                    parameters: {
                      source: "dynamic_form_detection",
                      fieldKey: foundMapping.key,
                      fieldType: type,
                      fieldName: name || id,
                    },
                    consentState: consentAccepted ? "after_consent" : "before_consent",
                    status: "observed",
                    correlationConfidence: "high",
                    timestamp: new Date().toISOString(),
                  });
                } catch (error: unknown) {
                  warnings.push({
                    type: "field_ignored",
                    message: `Falha ao preencher campo dinâmico ${name}/${id}: ${String(error)}`,
                  });
                }
              } else if (foundMapping.reason !== "unsupported_type") {
                ignoredFields.push({
                  fieldName:
                    normalizeFieldDescriptor(name) ||
                    normalizeFieldDescriptor(id) ||
                    normalizeFieldDescriptor(ariaLabel) ||
                    normalizeFieldDescriptor(placeholder) ||
                    normalizeFieldDescriptor(labelElement || "") ||
                    normalizeFieldDescriptor(contextText) ||
                    "dynamic_field",
                  cssSelector: "input,select,textarea",
                  reason: foundMapping.reason,
                });
              }
            } catch (error: unknown) {
              // Ignorar erros ao processar elementos dinâmicos
              continue;
            }
          }

          if (didFill) {
            publishProgress(hooks, {
              phase: "processing",
              currentUrl: page.url() || current.url,
              queuedUrls: queue.length,
              actionsCount: totalActions,
              eventsCount: events.length,
              statesDiscovered: visited.size,
              visitedUrls: Array.from(visitedUrls).slice(-20),
              message: "Formulários dinâmicos preenchidos",
            });
          }

          // Rotina determinística de progressão para formulários SPA:
          // garante preenchimentos essenciais antes de tentar avançar.
          if (totalActions < current.maxActions) {
            const travelStepAction: CrawlAction = {
              id: randomUUID(),
              type: "inspect_form",
              targetSelector: "kind=step_prep | context=travel_step_pre_submit",
              stateBefore: activeStateName,
              stateAfter: activeStateName,
              url: page.url(),
              timestamp: new Date().toISOString(),
            };
            actions.push(travelStepAction);
            totalActions += 1;
            activeActionId = travelStepAction.id;

            try {
              const countryInput = page.locator("#react-select-2-input, input[id*='react-select'][id$='-input']").first();
              const countryVisible = await countryInput.isVisible().catch(() => false);
              if (countryVisible) {
                await tryInteractReactSelect(page, countryInput, "Brasil");
                await page.waitForTimeout(400);
              }

              const startDateInput = page.locator("#startDate").first();
              if (await startDateInput.isVisible().catch(() => false)) {
                const startType = ((await startDateInput.getAttribute("type")) || "").toLowerCase();
                const startValue = startType === "date" ? "2026-08-05" : "05/08/2026";
                await startDateInput.fill(startValue, { timeout: 2_500 }).catch(() => undefined);
                await startDateInput.press("Tab").catch(() => undefined);
              }

              const endDateInput = page.locator("#endDate").first();
              if (await endDateInput.isVisible().catch(() => false)) {
                const endType = ((await endDateInput.getAttribute("type")) || "").toLowerCase();
                const endValue = endType === "date" ? "2026-08-12" : "12/08/2026";
                await endDateInput.fill(endValue, { timeout: 2_500 }).catch(() => undefined);
                await endDateInput.press("Tab").catch(() => undefined);
              }

              const increaseButton = page.locator("button[aria-label='increase']").first();
              if (await increaseButton.isVisible().catch(() => false)) {
                await increaseButton.click({ timeout: 1_500 }).catch(() => undefined);
                await page.waitForTimeout(250);
              }

              const allCheckboxes = page.locator("input[type='checkbox']");
              const motoCheckboxIndex = await page
                .evaluate(() => {
                  const normalize = (value: string | null | undefined) =>
                    (value || "").toLowerCase().replace(/\s+/g, " ").trim();
                  const isMotoConsentText = (text: string) =>
                    /acidentes? de moto|am[eé]rica latina|assinale o campo acima para continuar/.test(text);

                  const checkboxes = Array.from(document.querySelectorAll("input[type='checkbox']"));
                  for (let index = 0; index < checkboxes.length; index += 1) {
                    const checkbox = checkboxes[index] as HTMLInputElement;
                    const byLabel = checkbox.id
                      ? document.querySelector(`label[for="${checkbox.id}"]`)
                      : null;
                    const nearestContainer =
                      checkbox.closest("label") ||
                      checkbox.closest("div") ||
                      checkbox.closest("section") ||
                      checkbox.parentElement;
                    const contextText = normalize(
                      `${byLabel?.textContent || ""} ${nearestContainer?.textContent || ""}`,
                    );
                    if (isMotoConsentText(contextText)) {
                      return index;
                    }
                  }

                  return -1;
                })
                .catch(() => -1);

              const consentCheckbox = motoCheckboxIndex >= 0 ? allCheckboxes.nth(motoCheckboxIndex) : allCheckboxes.first();
              if (await consentCheckbox.isVisible().catch(() => false)) {
                const checked = await consentCheckbox.isChecked().catch(() => false);
                if (!checked) {
                  await consentCheckbox.check({ timeout: 2_500 }).catch(async () => {
                    await consentCheckbox.click({ timeout: 2_500 }).catch(() => undefined);
                  });
                }
              }

              const refreshedState = await capturePageState(page, current.url);
              travelStepAction.stateAfter = refreshedState;
              activeStateName = refreshedState;
              pushUiStateSnapshotEvent(travelStepAction.id, "after_travel_step_preparation");
              travelFormReadyForSubmit = await isTravelFormReadyForSubmit(page);
              fillPhaseCompleted = true;

              if (totalActions < current.maxActions) {
                const submitAction: CrawlAction = {
                  id: randomUUID(),
                  type: "click_link",
                  targetSelector: "kind=button | context=dynamic_cta_submit_step_1",
                  stateBefore: activeStateName,
                  stateAfter: activeStateName,
                  url: page.url(),
                  timestamp: new Date().toISOString(),
                };
                const previousActionId = activeActionId;
                activeActionId = submitAction.id;
                const postFillConsent = await consumeConsentPrompts(page);
                if (postFillConsent > 0) {
                  consentAccepted = true;
                }
                if (!travelFormReadyForSubmit) {
                  console.log("[CRAWLER] Fill phase complete, but form readiness check is partial; attempting CTA click anyway");
                }
                console.log("[CRAWLER] Attempting first CTA click after fill phase");
                let firstClick = fillPhaseCompleted ? await clickBestDynamicCta(page) : { clicked: false as const };
                console.log(`[CRAWLER] First CTA click result: clicked=${firstClick.clicked} text="${firstClick.text || ""}"`);
                if (firstClick.failureReason === "no_state_change_after_click" && firstClick.stableAfterClick) {
                  const repaired = await tryRepairAfterNoChange(page);
                  if (repaired) {
                    console.log("[CRAWLER][RECOVERY] Retrying first CTA click after repair");
                    firstClick = await clickBestDynamicCta(page);
                    console.log(`[CRAWLER][RECOVERY] First CTA retry result: clicked=${firstClick.clicked} text="${firstClick.text || ""}"`);
                  }
                  if (firstClick.failureReason === "no_state_change_after_click" && firstClick.stableAfterClick) {
                    console.log("[CRAWLER][RECOVERY] Trying alternative CTA after no-change on first click");
                    const alternativeClick = await clickBestDynamicCta(page, [firstClick.text || ""], { minScore: 0 });
                    console.log(
                      `[CRAWLER][RECOVERY] Alternative first CTA result: clicked=${alternativeClick.clicked} text="${alternativeClick.text || ""}"`,
                    );
                    if (alternativeClick.clicked) {
                      firstClick = alternativeClick;
                    }
                  }
                  if (firstClick.failureReason === "no_state_change_after_click" && firstClick.stableAfterClick) {
                    // Instead of hard-failing, log and fall through to link-following.
                    // The CTA (e.g., "ver quanto custa") may show prices without a URL/state change.
                    console.warn(`[CRAWLER] CTA clicked but state did not change (${firstClick.text || "cta"}); falling through to link discovery`);
                    warnings.push({ type: "spa_router", message: `Botão "${firstClick.text || "cta"}" clicado mas estado não mudou. O crawler vai tentar seguir links da página.` });
                  }
                }
                if (firstClick.clicked) {
                  submitAction.targetSelector = `kind=button | text=${(firstClick.text || "cta").slice(0, 80)} | context=dynamic_cta_submit_step_1`;
                  actions.push(submitAction);
                  totalActions += 1;
                  anyDynamicCtaClicked = true;
                  const postSubmitState = await capturePageState(page, current.url);
                  submitAction.stateAfter = postSubmitState;
                  activeStateName = postSubmitState;
                  await maybeCaptureScreenshot(postSubmitState, page);
                  pushUiStateSnapshotEvent(submitAction.id, "after_travel_step_submit");
                  travelSubmitHandled = true;
                }

                if (travelSubmitHandled && totalActions < current.maxActions) {
                  const quoteModalAction: CrawlAction = {
                    id: randomUUID(),
                    type: "click_link",
                    targetSelector: "kind=button | context=dynamic_cta_submit_step_2",
                    stateBefore: activeStateName,
                    stateAfter: activeStateName,
                    url: page.url(),
                    timestamp: new Date().toISOString(),
                  };
                  activeActionId = quoteModalAction.id;
                  console.log("[CRAWLER] Attempting second CTA click (step 2)");
                  await waitForUiToSettle(page, 10_000);
                  await page.waitForTimeout(1_200);
                  let secondClick = await clickBestDynamicCta(page, [firstClick.text || ""]);
                  if (!secondClick.clicked) {
                    // Em alguns fluxos o CTA da próxima etapa repete o mesmo texto da etapa anterior.
                    console.log("[CRAWLER] Second CTA click retry without excluded text");
                    secondClick = await clickBestDynamicCta(page, [], { minScore: 0 });
                  }
                  console.log(`[CRAWLER] Second CTA click result: clicked=${secondClick.clicked} text="${secondClick.text || ""}"`);
                  if (secondClick.failureReason === "no_state_change_after_click" && secondClick.stableAfterClick) {
                    const repaired = await tryRepairAfterNoChange(page);
                    if (repaired) {
                      console.log("[CRAWLER][RECOVERY] Retrying second CTA click after repair");
                      secondClick = await clickBestDynamicCta(page, [], { minScore: 0 });
                      console.log(`[CRAWLER][RECOVERY] Second CTA retry result: clicked=${secondClick.clicked} text="${secondClick.text || ""}"`);
                    }
                    if (secondClick.failureReason === "no_state_change_after_click" && secondClick.stableAfterClick) {
                      console.log("[CRAWLER][RECOVERY] Trying alternative CTA after no-change on second click");
                      const alternativeSecond = await clickBestDynamicCta(page, [secondClick.text || ""], { minScore: 0 });
                      console.log(
                        `[CRAWLER][RECOVERY] Alternative second CTA result: clicked=${alternativeSecond.clicked} text="${alternativeSecond.text || ""}"`,
                      );
                      if (alternativeSecond.clicked) {
                        secondClick = alternativeSecond;
                      }
                    }
                    if (secondClick.failureReason === "no_state_change_after_click" && secondClick.stableAfterClick) {
                      // Fall through to link discovery instead of hard-failing
                      console.warn(`[CRAWLER] Second CTA no state change (${secondClick.text || "cta"}); falling through to link discovery`);
                      warnings.push({ type: "spa_router", message: `Segundo botão "${secondClick.text || "cta"}" clicado mas estado não mudou. Continuando via links.` });
                    }
                  }
                  if (secondClick.clicked) {
                    quoteModalAction.targetSelector = `kind=button | text=${(secondClick.text || "cta").slice(0, 80)} | context=dynamic_cta_submit_step_2`;
                    actions.push(quoteModalAction);
                    totalActions += 1;
                    anyDynamicCtaClicked = true;
                    const postQuoteModalState = await capturePageState(page, current.url);
                    quoteModalAction.stateAfter = postQuoteModalState;
                    activeStateName = postQuoteModalState;
                    await maybeCaptureScreenshot(postQuoteModalState, page);
                    pushUiStateSnapshotEvent(quoteModalAction.id, "after_quote_modal_submit");
                    quoteModalSubmitHandled = true;
                  }
                }

                activeActionId = previousActionId;
              }
            } catch (error) {
              const message = String(error);
              if (message.includes("UNKNOWN_ACTION_FAILURE:")) {
                throw error;
              }
              // Etapa best-effort: segue sem interromper rastreio.
            }
          }
        }

        // Single URL Mode: não extrai links de outras páginas
        const singleUrlModeEnabled = current.singleUrlMode || config.singleUrlMode;
        if (!singleUrlModeEnabled && current.depth < current.maxDepth && totalActions < current.maxActions) {
          const staticLinks = extractLinks(html, page.url());
          const dynamicLinks = await page
            .$$eval("a[href]", (anchors) =>
              anchors
                .map((anchor) => (anchor as HTMLAnchorElement).getAttribute("href"))
                .filter((href): href is string => Boolean(href))
            )
            .catch(() => [] as string[]);
          const links = Array.from(
            new Set([
              ...staticLinks,
              ...dynamicLinks
                .map((href) => {
                  try {
                    return new URL(href, page.url()).toString();
                  } catch {
                    return null;
                  }
                })
                .filter((href): href is string => Boolean(href)),
            ]),
          );
          for (const link of links) {
            if (queue.length >= current.maxStates * 2) {
              break;
            }

            const next = new URL(link);
            if (isAllowedUrl(next, current.allowedDomains)) {
              queue.push({ ...current, depth: current.depth + 1, url: link });
            }
          }
        }

        // 🔘 CLIQUES EM BOTÕES DE INTERAÇÃO (abrir modais, formulários)
        // Procura por botões com texto comum que possam abrir o formulário (Cotar, Começar, etc)
        if (!foundFillableFields || travelSubmitHandled || quoteModalSubmitHandled) {
          console.log(`[CRAWLER] Looking for dynamic CTA triggers...`);
          const buttonClickBudget = Math.min(2, current.maxActions - totalActions);
          const clickedCtaTexts: string[] = [];
          for (let attempt = 0; attempt < buttonClickBudget; attempt += 1) {
            if (totalActions >= current.maxActions) break;
            const buttonAction: CrawlAction = {
              id: randomUUID(),
              type: "click_link",
              targetSelector: "kind=button | context=dynamic_trigger_exploration",
              stateBefore: activeStateName,
              stateAfter: activeStateName,
              url: page.url(),
              timestamp: new Date().toISOString(),
            };

            activeActionId = buttonAction.id;
            const clickResult = await clickBestDynamicCta(page, clickedCtaTexts);
            if (clickResult.failureReason === "no_state_change_after_click" && clickResult.stableAfterClick) {
              // Fall through to link discovery instead of aborting
              console.warn(`[CRAWLER] Trigger CTA no state change (${clickResult.text || "cta"}); stopping button exploration`);
              break;
            }
            if (!clickResult.clicked) {
              break;
            }

            const buttonText = (clickResult.text || "cta").slice(0, 80);
            clickedCtaTexts.push(clickResult.text || "");
            anyDynamicCtaClicked = true;
            buttonAction.targetSelector = `kind=button | text=${buttonText} | context=dynamic_trigger_exploration`;
            actions.push(buttonAction);
            totalActions += 1;

            activeStateName = await capturePageState(page, current.url);
            buttonAction.stateAfter = activeStateName;
            pushUiStateSnapshotEvent(buttonAction.id, "after_trigger_button_click");

            events.push({
              id: randomUUID(),
              actionId: buttonAction.id,
              eventType: "button_clicked",
              technology: "custom",
              eventName: "form_trigger_button_clicked",
              url: page.url(),
              stateName: activeStateName,
              parameters: {
                source: "dynamic_trigger_detection",
                buttonText,
              },
              consentState: consentAccepted ? "after_consent" : "before_consent",
              status: "observed",
              correlationConfidence: "high",
              timestamp: new Date().toISOString(),
            });
          }
        }

        // 🎠 Interações comuns de SPA: carrossel/slider/dropdown customizados.
        if (totalActions < current.maxActions && anyDynamicCtaClicked) {
          const progressionSelectors = [
            "button[aria-label*='próximo' i]",
            "button[aria-label*='proximo' i]",
            "button[aria-label*='next' i]",
            ".slick-next",
            ".swiper-button-next",
            "[class*='carousel'] button",
            "[role='combobox']",
            "[class*='select__control']",
          ];
          let progressionClicks = 0;
          for (const selector of progressionSelectors) {
            if (progressionClicks >= 3 || totalActions >= current.maxActions) break;
            const control = page.locator(selector).first();
            const exists = await control.count().catch(() => 0);
            if (exists === 0) continue;
            const isVisible = await control.isVisible().catch(() => false);
            if (!isVisible) continue;

            const progressionAction: CrawlAction = {
              id: randomUUID(),
              type: "click_link",
              targetSelector: `kind=progression | selector=${selector} | context=spa_control`,
              stateBefore: activeStateName,
              stateAfter: activeStateName,
              url: page.url(),
              timestamp: new Date().toISOString(),
            };
            actions.push(progressionAction);
            totalActions += 1;
            activeActionId = progressionAction.id;
            try {
              await control.click({ timeout: 2_500 });
              await page.waitForTimeout(700);
              const nextStateName = await capturePageState(page, current.url);
              progressionAction.stateAfter = nextStateName;
              activeStateName = nextStateName;
              progressionClicks += 1;
              pushUiStateSnapshotEvent(progressionAction.id, "after_spa_progression_click");
              events.push({
                id: randomUUID(),
                actionId: progressionAction.id,
                eventType: "ui_progression_interaction",
                technology: "custom",
                eventName: "spa_control_clicked",
                url: page.url(),
                stateName: activeStateName,
                parameters: { selector, source: "spa_progression" },
                consentState: consentAccepted ? "after_consent" : "before_consent",
                status: "observed",
                correlationConfidence: "high",
                timestamp: new Date().toISOString(),
              });
            } catch {
              // segue para o próximo seletor
            }
          }
        }

        const clickBudget = Math.min(3, current.maxActions - totalActions);
        for (let i = 0; i < clickBudget; i += 1) {
          const anchor = page.locator("a[href]").nth(i);
          const count = await anchor.count();
          if (count === 0) break;
          const href = await anchor.getAttribute("href");
          if (!href) continue;
          const resolved = new URL(href, page.url());
          
          // Single URL Mode: não clica em links nem dentro do domínio permitido
          const singleUrlModeEnabled = current.singleUrlMode || config.singleUrlMode;
          if (singleUrlModeEnabled) {
            warnings.push({
              type: "spa_router",
              message: `Clique em link ignorado em Single URL Mode: ${resolved.toString()}`,
            });
            continue;
          }
          
          if (!isAllowedUrl(resolved, current.allowedDomains)) continue;
          if (isDownloadTarget(resolved.toString())) {
            warnings.push({
              type: "spa_router",
              message: `Clique para download ignorado: ${resolved.toString()}`,
            });
            continue;
          }

          const clickMeta = await anchor
            .evaluate((node) => {
              const elementNode = node as HTMLAnchorElement;
              const text = (elementNode.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
              const ariaLabel = (elementNode.getAttribute("aria-label") ?? "").trim().slice(0, 80);
              const title = (elementNode.getAttribute("title") ?? "").trim().slice(0, 80);
              const id = (elementNode.id ?? "").trim().slice(0, 80);
              const dataAttrs = Array.from(elementNode.attributes)
                .map((attr) => attr.name)
                .filter((name) => name.startsWith("data-"))
                .slice(0, 3)
                .join(",");
              const context = elementNode.closest("header")
                ? "header"
                : elementNode.closest("footer")
                  ? "footer"
                  : elementNode.closest("[role='dialog'], .modal, [class*='modal']")
                    ? "modal"
                    : elementNode.closest("[id*='banner'], [class*='banner']")
                      ? "banner"
                      : "content";
              const stableSelector = id
                ? `#${id}`
                : dataAttrs
                  ? `${elementNode.tagName.toLowerCase()}[${dataAttrs.split(",")[0]}]`
                  : `${elementNode.tagName.toLowerCase()}[href]`;
              return {
                kind: "link",
                text,
                ariaLabel,
                title,
                href: elementNode.getAttribute("href") ?? "",
                id,
                dataAttr: dataAttrs,
                context,
                stableSelector,
              };
            })
            .catch(() => null);

          const targetSelector = clickMeta
            ? summarizeElementTarget({
                kind: clickMeta.kind,
                text: clickMeta.text,
                ariaLabel: clickMeta.ariaLabel,
                title: clickMeta.title,
                href: resolved.toString(),
                id: clickMeta.id,
                dataAttr: clickMeta.dataAttr,
                context: clickMeta.context,
                selector: `${clickMeta.stableSelector}:nth(${i + 1})`,
              })
            : `kind=link | href=${resolved.toString()} | context=content | selector=a[href]:nth(${i + 1})`;

          const clickAction: CrawlAction = {
            id: randomUUID(),
            type: "click_link",
            targetSelector,
            stateBefore: page.url(),
            stateAfter: resolved.toString(),
            url: page.url(),
            timestamp: new Date().toISOString(),
          };
          activeActionId = clickAction.id;
          actions.push(clickAction);
          totalActions += 1;
          try {
            // Aguardar overlay desaparecer antes de clicar
            await waitForOverlayToDisappear(page);

            // Agora fazer o clique
            await anchor.click({ timeout: 3_000 });
            await page.waitForTimeout(700);
          } catch (error: unknown) {
            try {
              console.log(`[CRAWLER] Tentando clique forçado no link...`, true);
              await anchor.click({ force: true, timeout: 3_000 });
              await page.waitForTimeout(700);
            } catch (forceClickError: unknown) {
              warnings.push({
                type: "spa_router",
                message: `Clique não executado em ${resolved.toString()}: ${String(error)}`,
              });
            }
          }
        }
      } catch (error) {
        const message = String(error);
        if (!urlTimedOut && message.includes("UNKNOWN_ACTION_FAILURE:")) {
          fatalFailure = `Falha desconhecida após clique em estado estável: ${message}`;
          warnings.push({
            type: "spa_router",
            message: fatalFailure,
          });
          publishProgress(hooks, {
            phase: "processing",
            currentUrl: page.url() || current.url,
            queuedUrls: queue.length,
            actionsCount: totalActions,
            eventsCount: events.length,
            statesDiscovered: visited.size,
            visitedUrls: Array.from(visitedUrls).slice(-20),
            message: fatalFailure,
          });
          break;
        }
        warnings.push({
          type: "spa_router",
          message: `Falha ao processar URL ${current.url}: ${message}`,
        });
      } finally {
        clearTimeout(urlTimeoutId);
        await page.close().catch(() => {});
      }

      if (urlTimedOut) {
        warnings.push({
          type: "spa_router",
          message: `URL ${current.url} abortada: per-URL timeout de ${PER_URL_TIMEOUT_MS / 1000}s excedido`,
        });
      }

      // Snapshot parcial após cada URL — permite recuperar dados em caso de timeout
      hooks?.onStateVisited?.({
        actions: [...actions],
        events: [...events],
        ignoredFields: [...ignoredFields],
        warnings: [...warnings],
        statesDiscovered: visited.size,
        stateScreenshots: { ...stateScreenshots },
      });

      if (fatalFailure) {
        break;
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  if (!stopReason && queue.length === 0 && !fatalFailure) {
    if (wafBlockedUrlCount > 0) {
      stopReason = `queue_exhausted_partial:exploração parcial — fila esgotada com ${wafBlockedUrlCount} URL(s) bloqueadas por controle de acesso`;
    } else {
      stopReason = "queue_exhausted:exploração completa";
    }
  }

  if (fatalFailure) {
    return {
      status: "failed",
      stopReason: `error:${fatalFailure}`,
      actions,
      events,
      ignoredFields,
      warnings,
      statesDiscovered: visited.size,
      stateScreenshots,
    };
  }

  return {
    status: "completed",
    stopReason,
    actions,
    events,
    ignoredFields,
    warnings,
    statesDiscovered: visited.size,
    stateScreenshots,
  };
};

export const exploreJourneys = async (config: CrawlConfig, hooks?: CrawlHooks): Promise<CrawlOutput> => {
  if (config.urls.length === 0) {
    return {
      status: "completed",
      actions: [],
      events: [],
      ignoredFields: [],
      warnings: [],
      statesDiscovered: 0,
    };
  }

  const engine = process.env.CRAWLER_ENGINE ?? (process.env.NODE_ENV === "test" ? "fetch" : "playwright");
  if (engine === "fetch") {
    return runFetchEngine(config, hooks);
  }

  return runPlaywrightEngine(config, hooks);
};
