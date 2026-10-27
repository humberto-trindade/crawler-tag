"""Motor de exploração Playwright (sync) portado de runPlaywrightEngine em explorer.ts.

Saída no mesmo formato do CrawlOutput da versão completa (chaves camelCase),
para que o JSON gravado localmente tenha o mesmo schema.
"""

from __future__ import annotations

import base64
import logging
import re
import socket
import threading
import time
from collections import deque
from typing import Any, Callable, Optional
from urllib.parse import urljoin, urlparse

from .deteccao import (
    classify_blocked_navigation,
    detect_tracking_events_from_html,
    has_blocking_captcha,
    is_download_target,
    is_potential_tracker_url,
    is_waf_block,
    make_event,
    new_id,
    now_iso,
    parse_tracking_request,
    request_query_params,
)
from .fieldmapper import FieldHints, resolve_field_mapping_from_hints
from .paginas import (
    JS_ANCHOR_META,
    PURCHASE_URL_RE,
    has_travel_form,
    preencher_dropdowns_customizados,
    marcar_termos_customizados,
    JS_MOTO_CHECKBOX_INDEX,
    STEALTH_INIT_JS,
    capture_page_state,
    capture_transition_signature,
    click_best_dynamic_cta,
    collect_field_hints,
    collect_links,
    consume_consent_prompts,
    hash_content,
    is_date_like_field,
    is_travel_form_ready_for_submit,
    normalize_field_descriptor,
    summarize_element_target,
    to_brazil_date,
    try_interact_react_select,
    try_repair_after_no_change,
    wait_for_overlay_to_disappear,
    wait_for_page_ready,
    wait_for_ui_to_settle,
    _fill_travel_dates,
)

log = logging.getLogger("crawler-tag-portable")

PER_URL_TIMEOUT_S = 120
PARTIAL_SNAPSHOT_INTERVAL_S = 20
MAX_SCREENSHOTS = 20
DYNAMIC_DATE_IDENTITY = re.compile(r"(startdate|enddate|fakedate|data.?ida|data.?volta|checkin|checkout)", re.I)
FALSE_VALUES = ["0", "false", "nao", "não", "off"]
PROGRESSION_SELECTORS = [
    "button[aria-label*='próximo' i]",
    "button[aria-label*='proximo' i]",
    "button[aria-label*='next' i]",
    ".slick-next",
    ".swiper-button-next",
    "[class*='carousel'] button",
    "[role='combobox']",
    "[class*='select__control']",
]
CHALLENGE_TITLE_JS = (
    "() => !document.title.toLowerCase().includes('blocked') && "
    "!document.title.toLowerCase().includes('just a moment') && "
    "!((document.body && document.body.innerText) || '').toLowerCase().includes('sorry, you have been blocked')"
)
CAPTCHA_TEXT_RE = re.compile(r"(n[aã]o sou um rob[oô]|i am human|verifique que voc[eê] [ée] humano)", re.I)
UNKNOWN_FAILURE = "UNKNOWN_ACTION_FAILURE:"
# controles de carrossel/próximo: o navegador trava com o JS deles em laço (ver docs/progress.md)
CAROUSEL_SELECTOR_RE = re.compile(r"next|pr[oó]ximo|carousel|slick|swiper", re.I)


class UrlTimeout(Exception):
    """Limite de 120s por URL excedido (checado entre etapas)."""


class AssertionBlocked(Exception):
    pass


def assert_safe_target(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise AssertionBlocked(f"Blocked scheme for crawler: {parsed.scheme}")
    host = parsed.hostname or ""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return
    for info in infos:
        address = info[4][0]
        if _is_private_ip(address):
            raise AssertionBlocked(f"Blocked private address for crawler target: {address}")
        if address == "169.254.169.254":
            raise AssertionBlocked("Blocked cloud metadata endpoint")


def _is_private_ip(address: str) -> bool:
    if ":" in address:
        normalized = address.lower()
        return normalized == "::1" or normalized.startswith(("fc", "fd", "fe80:"))
    parts = [int(p) for p in address.split(".") if p.isdigit()]
    if len(parts) != 4:
        return False
    a, b = parts[0], parts[1]
    return a in (10, 127) or (a == 169 and b == 254) or (a == 172 and 16 <= b <= 31) or (a == 192 and b == 168)


def is_allowed_url(url: str, allowed_domains: list[str]) -> bool:
    host = (urlparse(url).hostname or "").lower()
    for domain in allowed_domains:
        normalized = domain.lower().lstrip(".")
        if host == normalized or host.endswith(f".{normalized}"):
            return True
    return False


class _UrlCtx:
    """Estado mutável de uma URL (equivalente às variáveis locais do loop TS)."""

    def __init__(self, current: dict[str, Any], page: Any,
                 on_state: Optional[Callable[[str], None]] = None) -> None:
        self.current = current
        self.page = page
        self.active_action_id: Optional[str] = None
        self._on_state = on_state
        self._active_state_name = ""
        self.active_state_name = current["url"]
        self.consent_accepted = False
        self.travel_submit_handled = False
        self.quote_submit_handled = False
        self.any_dynamic_cta_clicked = False
        self.found_fillable_fields = False
        # CTA de carrossel que já não mudou o estado: a progressão não deve clicar nele de novo
        self.carousel_blocked = False
        self.deadline = time.monotonic() + PER_URL_TIMEOUT_S
        self.event_by_request: dict[Any, dict[str, Any]] = {}

    @property
    def active_state_name(self) -> str:
        return self._active_state_name

    @active_state_name.setter
    def active_state_name(self, value: str) -> None:
        # cada tela alcançada é registrada, tenha ou não disparado eventos
        self._active_state_name = value
        if self._on_state:
            self._on_state(value)


class ExplorerRun:
    def __init__(
        self,
        config: dict[str, Any],
        on_progress: Optional[Callable[[dict[str, Any]], None]] = None,
        on_state_visited: Optional[Callable[[dict[str, Any]], None]] = None,
        should_stop: Optional[threading.Event] = None,
    ) -> None:
        self.config = config
        self.on_progress = on_progress
        self.on_state_visited = on_state_visited
        self.should_stop = should_stop
        self.actions: list[dict[str, Any]] = []
        self.events: list[dict[str, Any]] = []
        self.warnings: list[dict[str, str]] = []
        self.ignored_fields: list[dict[str, Any]] = []
        self.visited: set[str] = set()
        self.visited_urls: list[str] = []
        # telas alcançadas, na ordem (inclusive as sem nenhum evento): base da jornada em ordem
        self.screens_visited: list[dict[str, Any]] = []
        self.queue: deque[dict[str, Any]] = deque(self._initial_queue())
        self.total_actions = 0
        self.last_progress_events = 0
        self.fatal: Optional[str] = None
        self.stop_reason: Optional[str] = None
        self.pause: Optional[dict[str, Any]] = None
        self.screens: dict[str, str] = {}
        self.captured_snapshots: set[str] = set()
        self.unclassified_counts: dict[str, int] = {}
        self.waf_domains: set[str] = set()
        self.waf_count = 0
        self.url_failures = 0
        # URLs já visitadas em uma tentativa anterior (retomada após watchdog)
        self.skip_urls: set[str] = set(config.get("skipUrls", []))
        self.ignored_warning_keys: set[tuple[str, str, str]] = set()
        self.last_snapshot_at = 0.0
        self.template_keys: list[dict[str, Any]] = config.get("templateKeys", [])
        self.global_single_url = bool(config.get("singleUrlMode"))

    # ------------------------------------------------------------------ utilidades

    def _initial_queue(self) -> list[dict[str, Any]]:
        items = []
        for root in self.config["urls"]:
            items.append(
                {
                    "url": root["url"],
                    "depth": 0,
                    "allowedDomains": root["allowedDomains"],
                    "maxDepth": root["depth"],
                    "maxActions": root["maxActions"],
                    "maxStates": root["maxStates"],
                    "singleUrlMode": bool(root.get("singleUrlMode") or self.config.get("singleUrlMode")),
                }
            )
        return items

    def _registrar_tela(self, state_name: str) -> None:
        """Registra a tela ativa; mudanças só de rótulo na mesma URL contam como nova tela, repetição imediata não."""
        if not state_name or (self.screens_visited and self.screens_visited[-1]["stateName"] == state_name):
            return
        self.screens_visited.append({"ordem": len(self.screens_visited) + 1, "stateName": state_name,
                                     "timestamp": now_iso(), "eventosAteAqui": len(self.events)})

    def _publish(self, phase: str, current_url: str, message: str) -> None:
        if not self.on_progress:
            return
        self.on_progress(
            {
                "phase": phase,
                "currentUrl": current_url,
                "queuedUrls": len(self.queue),
                "actionsCount": self.total_actions,
                "eventsCount": len(self.events),
                "statesDiscovered": len(self.visited),
                "visitedUrls": self.visited_urls[-20:],
                "message": message,
            }
        )

    def _action(self, action_type: str, target: str, state_before: str, state_after: str, url: str) -> dict[str, Any]:
        return {
            "id": new_id(),
            "type": action_type,
            "targetSelector": target,
            "stateBefore": state_before,
            "stateAfter": state_after,
            "url": url,
            "timestamp": now_iso(),
        }

    def _consent_state(self, ctx: _UrlCtx) -> str:
        return "after_consent" if ctx.consent_accepted else "before_consent"

    def _checkpoint(self, ctx: _UrlCtx) -> None:
        if time.monotonic() > ctx.deadline:
            raise UrlTimeout()
        # sinal de atividade para o watchdog do processo (servidor), sem log por etapa
        self._publish("processing", ctx.page.url or ctx.current["url"], "Executando etapa")
        # resultado parcial periódico: se o navegador travar, o que já foi coletado não se perde
        now = time.monotonic()
        if now - self.last_snapshot_at >= PARTIAL_SNAPSHOT_INTERVAL_S:
            self.last_snapshot_at = now
            self._snapshot_state()

    def _ui_snapshot(self, ctx: _UrlCtx, action_id: Optional[str], source: str) -> None:
        self.events.append(
            make_event(
                action_id=action_id,
                event_type="state_snapshot",
                technology="custom",
                event_name="ui_state_snapshot",
                url=ctx.page.url or ctx.current["url"],
                state_name=ctx.active_state_name,
                parameters={"source": source},
                consent_state=self._consent_state(ctx),
                correlation_confidence="high" if action_id else "low",
            )
        )

    def _snapshot_state(self) -> None:
        if self.on_state_visited:
            self.on_state_visited(
                {
                    "actions": list(self.actions),
                    "events": list(self.events),
                    "ignoredFields": list(self.ignored_fields),
                    "warnings": list(self.warnings),
                    "statesDiscovered": len(self.visited),
                    "stateScreenshots": dict(self.screens),
                    # para retomar a fila se o processo for encerrado pelo watchdog
                    "pendingQueue": list(self.queue),
                    "visitedUrls": list(self.visited_urls),
                    "telasVisitadas": list(self.screens_visited),
                }
            )

    def _maybe_screenshot(self, state_name: str, page: Any) -> None:
        if not state_name or len(self.screens) >= MAX_SCREENSHOTS:
            return
        try:
            signature = capture_transition_signature(page)[:10]
            snapshot_key = f"{state_name}@@{signature}"
            if snapshot_key in self.captured_snapshots:
                return
            self.captured_snapshots.add(snapshot_key)
            buf = page.screenshot(type="jpeg", quality=20, full_page=True, timeout=8_000)
            existing = [k for k in self.screens if k == state_name or k.startswith(f"{state_name}@@")]
            storage_key = state_name if not existing else snapshot_key
            self.screens[storage_key] = "data:image/jpeg;base64," + base64.b64encode(buf).decode("ascii")
        except Exception as error:
            log.warning("Screenshot capture failed for state %s: %s", state_name, error)

    def _has_visible_captcha(self, page: Any, html: str) -> bool:
        if not has_blocking_captcha(html):
            return False
        try:
            count = page.locator(
                "iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='arkoselabs'], "
                ".g-recaptcha, .h-captcha, [data-sitekey]"
            ).filter(has_not_text=re.compile("hidden", re.I)).count()
        except Exception:
            count = 0
        if count > 0:
            return True
        try:
            text = page.locator("body").inner_text()
        except Exception:
            return False
        return CAPTCHA_TEXT_RE.search(text) is not None

    # ------------------------------------------------------------------ execução

    def run(self) -> dict[str, Any]:
        from playwright.sync_api import sync_playwright

        headless = self.config.get("browserMode", "headless") != "visual"
        slow_mo = 0
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                headless=headless,
                slow_mo=slow_mo,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--disable-features=IsolateOrigins,site-per-process",
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--window-size=1280,800",
                    "--lang=pt-BR",
                ],
            )
            try:
                context = browser.new_context(
                    user_agent=self._user_agent(),
                    locale="pt-BR",
                    timezone_id="America/Sao_Paulo",
                    viewport={"width": 1280, "height": 800},
                    extra_http_headers={
                        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
                        "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
                        "sec-ch-ua-mobile": "?0",
                        "sec-ch-ua-platform": '"Windows"',
                        "Upgrade-Insecure-Requests": "1",
                    },
                )
                context.set_default_timeout(10_000)
                context.set_default_navigation_timeout(30_000)
                context.add_init_script(f"({STEALTH_INIT_JS})();")
                try:
                    self._publish("starting", self.config["urls"][0]["url"] if self.config["urls"] else "",
                                  "Iniciando exploração em navegador real")
                    self._main_loop(context)
                finally:
                    context.close()
            finally:
                browser.close()
        return self._finish()

    @staticmethod
    def _user_agent() -> str:
        return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

    def _main_loop(self, context: Any) -> None:
        while self.queue:
            if self.should_stop and self.should_stop.is_set():
                self.stop_reason = "cancelled:interrompido pelo operador"
                break
            current = self.queue.popleft()
            self._publish("navigating", current["url"], "Abrindo URL no navegador")

            if not is_allowed_url(current["url"], current["allowedDomains"]):
                continue
            if current["url"] in self.skip_urls:
                continue
            if is_download_target(current["url"]):
                self.warnings.append({"type": "spa_router", "message": f"Download ignorado: {current['url']}"})
                continue
            assert_safe_target(current["url"])

            if len(self.visited) >= current["maxStates"]:
                self.stop_reason = f"max_states:{current['maxStates']} estados explorados"
                break
            if self.total_actions >= current["maxActions"]:
                self.stop_reason = f"max_actions:{current['maxActions']} ações executadas"
                break

            page = context.new_page()
            ctx = _UrlCtx(current, page, self._registrar_tela)
            timed_out = False
            outcome: Optional[str] = None
            page.route("**/*", self._route_handler)
            page.on("response", lambda response, c=ctx: self._on_response(c, response))
            page.on("request", lambda request, c=ctx: self._on_request(c, request))
            page.on("framenavigated", lambda frame, c=ctx: self._on_navigated(c, frame))

            nav_action = self._action("navigate", "document", current["url"], current["url"], current["url"])
            self.actions.append(nav_action)
            self.total_actions += 1
            ctx.active_action_id = nav_action["id"]

            try:
                outcome = self._process_url(ctx, nav_action)
            except UrlTimeout:
                timed_out = True
            except Exception as error:
                message = str(error)
                if not timed_out and UNKNOWN_FAILURE in message:
                    self.fatal = f"Falha desconhecida após clique em estado estável: {message}"
                    self.warnings.append({"type": "spa_router", "message": self.fatal})
                    self._publish("processing", page.url or current["url"], self.fatal)
                    outcome = "fatal"
                else:
                    self.url_failures += 1
                    self.warnings.append(
                        {"type": "spa_router", "message": f"Falha ao processar URL {current['url']}: {message}"}
                    )
                    log.exception("browser failed url=%s", current["url"])
            finally:
                try:
                    page.close()
                except Exception:
                    pass

            if timed_out:
                self.warnings.append(
                    {
                        "type": "spa_router",
                        "message": f"URL {current['url']} abortada: per-URL timeout de {PER_URL_TIMEOUT_S}s excedido",
                    }
                )

            if outcome == "pause":
                break
            if outcome == "skip":
                continue
            self._snapshot_state()
            if self.fatal:
                break

    # ---------------------------------------------------------- handlers de rede

    def _route_handler(self, route: Any) -> None:
        request_url = route.request.url
        if is_download_target(request_url):
            self.warnings.append({"type": "spa_router", "message": f"Request de download bloqueado: {request_url}"})
            route.abort()
            return
        route.continue_()

    def _on_response(self, ctx: _UrlCtx, response: Any) -> None:
        event = ctx.event_by_request.get(response.request)
        if event is None:
            return
        payload = event.get("requestPayload") or {}
        event["requestPayload"] = {**payload, "status": response.status, "ok": response.ok}
        if not response.ok:
            event["status"] = "flagged"
            if event["correlationConfidence"] == "high":
                event["correlationConfidence"] = "low"

    def _on_navigated(self, ctx: _UrlCtx, frame: Any) -> None:
        """Navegação do frame principal: o estado passa a ser a URL nova até a tela renderizar.

        Sem isso, os requests disparados logo após a navegação herdam o rótulo (e o passo) da tela anterior.
        """
        try:
            if frame != ctx.page.main_frame or not frame.url:
                return
            url_estado = (ctx.active_state_name or "").split(" | ")[0]
            if url_estado.split("?")[0].rstrip("/") != frame.url.split("?")[0].rstrip("/"):
                ctx.active_state_name = frame.url
        except Exception:
            pass

    def _on_request(self, ctx: _UrlCtx, request: Any) -> None:
        request_url = request.url
        parsed = parse_tracking_request(request_url)
        if not parsed and not is_potential_tracker_url(request_url):
            return
        sanitized = request_query_params(request_url)
        host = (urlparse(request_url).hostname or "unknown-host").lower()
        if not parsed:
            count = self.unclassified_counts.get(host, 0)
            if count >= 12:
                return
            self.unclassified_counts[host] = count + 1

        event = make_event(
            action_id=ctx.active_action_id,
            event_type="request_observed",
            technology=parsed["technology"] if parsed else "unclassified_tracker",
            event_name=parsed["eventName"] if parsed else f"network_unclassified:{host}",
            url=ctx.page.url or ctx.current["url"],
            state_name=ctx.active_state_name,
            parameters=sanitized,
            consent_state=self._consent_state(ctx),
            correlation_confidence="high" if ctx.active_action_id else "low",
            request_payload={
                "source": "crawler_request",
                "requestUrl": request_url,
                "method": request.method,
                "resourceType": request.resource_type,
            },
        )
        self.events.append(event)
        ctx.event_by_request[request] = event
        if len(self.events) - self.last_progress_events >= 5:
            self.last_progress_events = len(self.events)
            self._publish("processing", ctx.page.url or ctx.current["url"], "Capturando requests de tracking")

    # ---------------------------------------------------------- fluxo de uma URL

    def _process_url(self, ctx: _UrlCtx, nav_action: dict[str, Any]) -> Optional[str]:
        page = ctx.page
        current = ctx.current
        log.info("Starting navigation to %s", current["url"])
        response = page.goto(current["url"], wait_until="domcontentloaded", timeout=30_000)
        log.info("Page loaded, waiting for SPA rendering")

        nav_status = response.status if response else 0
        nav_html = page.content()
        if is_waf_block(nav_html, nav_status):
            outcome = self._handle_waf(ctx, response, nav_status, nav_html)
            if outcome is not None:
                return outcome

        try:
            page.wait_for_load_state("networkidle", timeout=8_000)
        except Exception:
            log.info("networkidle timeout (expected, continuing)")

        initial_ready = wait_for_page_ready(page, "initial_navigation", 15_000)
        log.info("Post-render readiness: ready=%s elapsed=%sms signals=%s",
                 initial_ready["ready"], initial_ready["elapsedMs"], initial_ready["visibleSignals"])
        page.wait_for_timeout(500)

        self._maybe_screenshot(current["url"], page)
        ctx.active_state_name = capture_page_state(page, current["url"])
        log.info("Active state name: %s", ctx.active_state_name)
        self._maybe_screenshot(ctx.active_state_name, page)

        accepted = consume_consent_prompts(page)
        if accepted > 0:
            ctx.consent_accepted = True
            for i in range(accepted):
                self.actions.append(
                    self._action(
                        "consent",
                        f"kind=banner | text=accept consent | context=banner | ordinal={i + 1}",
                        ctx.active_state_name,
                        ctx.active_state_name,
                        page.url,
                    )
                )
                self.total_actions += 1
            self._publish("processing", page.url or current["url"], f"Consentimentos aceitos: {accepted}")
            self.events.append(
                make_event(
                    action_id=ctx.active_action_id,
                    event_type="consent_updated",
                    technology="custom",
                    event_name="consent_accept",
                    url=page.url or current["url"],
                    state_name=ctx.active_state_name,
                    parameters={"source": "consent_banner", "acceptedCount": accepted},
                    request_payload={"source": "consent_banner_click", "method": "ui_click", "status": 200, "ok": True},
                    consent_state="after_consent",
                    correlation_confidence="high",
                )
            )

        html = page.content()
        state_hash = hash_content(f"{page.url}:{html}")
        if state_hash in self.visited:
            return "skip"
        self.visited.add(state_hash)
        self.visited_urls.append(page.url or current["url"])
        self._publish("processing", page.url or current["url"], "Página carregada e analisada")

        if self._has_visible_captcha(page, html):
            self.warnings.append({"type": "captcha", "message": f"CAPTCHA detectado em {page.url}"})
            self._publish("paused", page.url or current["url"], "Execução pausada por CAPTCHA")
            self.pause = {"url": page.url, "reason": "captcha_detected"}
            return "pause"

        nav_action["stateAfter"] = page.url
        nav_action["url"] = page.url
        self.events.append(
            make_event(
                action_id=nav_action["id"],
                event_type="page_view",
                technology="custom",
                event_name="page_view",
                url=page.url,
                state_name=ctx.active_state_name,
                parameters={"source": "playwright"},
                consent_state=self._consent_state(ctx),
                correlation_confidence="high",
            )
        )
        self.events.extend(
            detect_tracking_events_from_html(html, page.url, nav_action["id"], self._consent_state(ctx))
        )

        self._fill_static_form(ctx)
        self._dynamic_forms_and_progression(ctx)

        single = bool(current.get("singleUrlMode") or self.config.get("singleUrlMode"))
        if not single and current["depth"] < current["maxDepth"] and self.total_actions < current["maxActions"]:
            self._enqueue_links(ctx)

        self._trigger_clicks(ctx)
        self._progression_clicks(ctx)
        self._anchor_clicks(ctx)
        return None

    def _handle_waf(self, ctx: _UrlCtx, response: Any, nav_status: int, nav_html: str) -> Optional[str]:
        page = ctx.page
        current = ctx.current
        cf_ray = (response.headers.get("cf-ray", "") if response else "") or ""
        page_title = ""
        try:
            page_title = page.title()
        except Exception:
            pass
        classification = classify_blocked_navigation(nav_status, page_title, nav_html)
        log.info("WAF block detected (status=%s, cf-ray=%s), waiting up to 8s for JS challenge", nav_status, cf_ray)
        try:
            page.wait_for_function(CHALLENGE_TITLE_JS, timeout=8_000)
            resolved = True
        except Exception:
            resolved = False
        nav_html = page.content()
        still_blocked = is_waf_block(nav_html, 0)
        if not still_blocked or resolved:
            log.info("CF challenge auto-resolved after wait")
            return None

        blocked_domain = urlparse(current["url"]).hostname or current["url"]
        self.waf_count += 1
        wait_detail = "challenge aparente, mas bloqueio persistiu" if resolved else "sem auto-resolução após espera de até 8s"
        self.warnings.append(
            {
                "type": "navigation_blocked",
                "message": f"Navegação {classification}: {current['url']} (status={nav_status or 0}, "
                           f"cf-ray={cf_ray or 'n/a'}, {wait_detail})",
            }
        )
        if blocked_domain not in self.waf_domains:
            self.waf_domains.add(blocked_domain)
            if classification == "challenge_detected":
                msg = f"Desafio de verificação humana detectado em {blocked_domain}; a rota não foi explorada."
            else:
                msg = f"WAF/Cloudflare bloqueou {blocked_domain} (HTTP {nav_status or 'desconhecido'}); a rota não foi explorada."
            self.warnings.append({"type": "captcha", "message": msg})
        self._publish("paused", current["url"],
                      f"⚠️ {classification} em {current['url']} ({self.waf_count} URL(s) bloqueadas no total)")
        self._maybe_screenshot(f"BLOCKED: {current['url']}", page)
        return "skip"

    # ------------------------------------------------------- formulário estático

    def _fill_static_form(self, ctx: _UrlCtx) -> None:
        page = ctx.page
        current = ctx.current
        mapped_fields: list[dict[str, Any]] = []
        for hint in collect_field_hints(page):
            if hint["inputType"] == "hidden":
                continue
            h = hint["hints"]
            field_hints = FieldHints(
                name=h["name"], id=h["id"], data_field=h["dataField"], type=h["type"],
                autocomplete=h["autocomplete"], placeholder=h["placeholder"], aria_label=h["ariaLabel"],
                label=h["label"], context_text=h["contextText"],
            )
            mapping = resolve_field_mapping_from_hints(field_hints, self.template_keys)
            raw_name, raw_id = hint["rawName"], hint["rawId"]
            field_name = raw_name if raw_name is not None else (raw_id if raw_id is not None else f"field_{hint['index']}")
            if mapping["type"] == "mapped":
                selector_candidates = []
                if raw_id:
                    selector_candidates.append(f'[id="{_esc(raw_id)}"]')
                if raw_name:
                    selector_candidates.append(f'[name="{_esc(raw_name)}"]')
                mapped_fields.append(
                    {
                        "fieldName": field_name,
                        "tagName": hint["tagName"],
                        "inputType": hint["inputType"],
                        "value": mapping["value"],
                        "selectorCandidates": selector_candidates,
                        "labelText": hint["labelText"] or field_name,
                        "ariaLabel": hint["ariaLabel"],
                        "title": hint["title"],
                        "idValue": (raw_id or "").strip()[:80],
                        "dataAttr": hint["dataAttr"],
                        "context": hint["context"],
                    }
                )
            else:
                self.ignored_fields.append(
                    {"fieldName": field_name, "cssSelector": hint["tagName"] or "input", "reason": mapping["reason"],
                     "matchedKeys": mapping.get("matchedKeys", [])}
                )
                # um aviso por campo e página: a mesma página visitada de novo não repete o aviso
                warning_key = (field_name, mapping["reason"], page.url)
                if warning_key not in self.ignored_warning_keys:
                    self.ignored_warning_keys.add(warning_key)
                    self.warnings.append(
                        {"type": "field_ignored",
                         "message": f'Campo "{field_name}" ignorado ({mapping["reason"]}) em {page.url}'}
                    )

        single = bool(current.get("singleUrlMode") or self.config.get("singleUrlMode"))
        max_form = current["maxActions"] if single else max(8, int(current["maxActions"] * 0.6))
        form_count = 0
        fill_action_id = new_id()
        did_fill = False

        for field in mapped_fields:
            self._checkpoint(ctx)
            if self.total_actions >= current["maxActions"] or form_count >= max_form:
                break
            candidates = field["selectorCandidates"] or ["input,select,textarea"]
            locator = None
            matched_selector = candidates[0]
            for candidate in candidates:
                matches = page.locator(candidate)
                count = min(_count(matches), 6)
                for idx in range(count):
                    possible = matches.nth(idx)
                    if _visible(possible):
                        locator = possible
                        matched_selector = f"{candidate}:nth-match({idx + 1})"
                        break
                if locator is not None:
                    break
            if locator is None:
                self.warnings.append(
                    {"type": "field_ignored",
                     "message": f'Campo "{field["fieldName"]}" mapeado sem elemento visível para interação'}
                )
                continue

            is_check = field["inputType"] in ("checkbox", "radio")
            interaction_type = "check_field" if is_check else ("select_field" if field["tagName"] == "select" else "fill_field")
            kind = "field" if is_check else ("form" if field["tagName"] == "select" else "campo")
            interaction = self._action(
                interaction_type,
                summarize_element_target(
                    kind=kind, text=field["labelText"], aria_label=field["ariaLabel"], title=field["title"],
                    id=field["idValue"], data_attr=field["dataAttr"], context=field["context"],
                    selector=matched_selector,
                ),
                ctx.active_state_name, ctx.active_state_name, page.url,
            )
            self.actions.append(interaction)
            self.total_actions += 1
            form_count += 1
            previous_action_id = ctx.active_action_id
            ctx.active_action_id = interaction["id"]
            did_fill = True
            try:
                lowered = field["value"].lower()
                should_enable = lowered not in FALSE_VALUES
                if is_check:
                    if should_enable:
                        locator.check(timeout=2_500)
                    else:
                        locator.uncheck(timeout=2_500)
                elif field["idValue"] and "react-select" in field["idValue"]:
                    try_interact_react_select(page, locator, field["value"])
                elif field["tagName"] == "select":
                    try:
                        locator.select_option(label=field["value"])
                    except Exception:
                        locator.select_option(field["value"])
                else:
                    should_brazil = field["inputType"] != "date" and is_date_like_field(
                        field["fieldName"], field["idValue"], field["labelText"], field["inputType"])
                    candidate_value = to_brazil_date(field["value"]) if should_brazil else field["value"]
                    locator.fill(candidate_value, timeout=2_500)
                    if should_brazil:
                        try:
                            locator.press("Tab")
                        except Exception:
                            pass

                next_state = capture_page_state(page, current["url"])
                interaction["stateAfter"] = next_state
                ctx.active_state_name = next_state
                self._maybe_screenshot(next_state, page)
                self._ui_snapshot(ctx, interaction["id"], "after_form_field_interaction")
                wait_for_page_ready(page, f"after_form_field_{field['fieldName']}", 6_000)

                valid = locator.evaluate(
                    "(node) => typeof node.checkValidity === 'function' ? node.checkValidity() : true")
                if not valid:
                    self.warnings.append(
                        {"type": "field_ignored",
                         "message": f'Campo "{field["fieldName"]}" preenchido, mas inválido após validação nativa'})
            except UrlTimeout:
                raise
            except Exception as error:
                self.warnings.append(
                    {"type": "field_ignored", "message": f"Falha ao preencher {field['fieldName']}: {error}"})
            finally:
                ctx.active_action_id = previous_action_id

        if did_fill:
            self.actions.append(
                {"id": fill_action_id, "type": "inspect_form", "targetSelector": "form",
                 "stateBefore": page.url, "stateAfter": page.url, "url": page.url, "timestamp": now_iso()}
            )
            self.total_actions += 1
    # ------------------------------------------------- formulário dinâmico / travel

    def _dynamic_forms_and_progression(self, ctx: _UrlCtx) -> None:
        page = ctx.page
        current = ctx.current
        if not (self.total_actions < current["maxActions"] and self.template_keys):
            return

        self._publish("processing", page.url or current["url"], "Procurando por formulários dinâmicos (SPA/Modal)...")
        did_fill = False
        inputs = page.locator("input, select, textarea").all()
        for input_el in inputs:
            self._checkpoint(ctx)
            if self.total_actions >= current["maxActions"]:
                break
            try:
                if not _visible(input_el):
                    continue
                type_ = (input_el.get_attribute("type") or "text")
                name = input_el.get_attribute("name") or ""
                id_ = input_el.get_attribute("id") or ""
                if DYNAMIC_DATE_IDENTITY.search(f"{name} {id_}".lower()):
                    continue
                if type_ == "hidden":
                    continue
                try:
                    if input_el.is_disabled():
                        continue
                except Exception:
                    pass
                ctx.found_fillable_fields = True

                label_text = input_el.evaluate(
                    "(el) => { const l = el.id ? document.querySelector(`label[for=\"${el.id}\"]`) : null;"
                    " return l ? l.textContent.trim() : null; }")
                data_field = input_el.get_attribute("data-field") or ""
                autocomplete = input_el.get_attribute("autocomplete") or ""
                placeholder = input_el.get_attribute("placeholder") or ""
                aria_label = input_el.get_attribute("aria-label") or ""
                context_text = input_el.evaluate(
                    "(el) => ((el.closest('form, section, article, div') || {}).textContent || '')"
                    ".replace(/\\s+/g, ' ').trim().slice(0, 240)")
                mapping = resolve_field_mapping_from_hints(
                    FieldHints(
                        name=name.lower(), id=id_.lower(), data_field=data_field.lower(), type=type_.lower(),
                        autocomplete=autocomplete.lower(), placeholder=placeholder.lower(),
                        aria_label=aria_label.lower(), label=(label_text or "").lower(),
                        context_text=(context_text or "").lower(),
                    ),
                    self.template_keys,
                )

                if mapping["type"] == "mapped":
                    field_desc = f'{type_}[name="{name}"][id="{id_}"]'
                    action_type = "check_field" if type_ in ("checkbox", "radio") else (
                        "select_field" if type_ == "select" else "fill_field")
                    interaction = self._action(
                        action_type, f"dynamic_field | {field_desc} | key={mapping['key']}",
                        ctx.active_state_name, ctx.active_state_name, page.url)
                    self.actions.append(interaction)
                    self.total_actions += 1
                    try:
                        value = mapping["value"]
                        if type_ in ("checkbox", "radio"):
                            if value.lower() not in FALSE_VALUES:
                                input_el.check(timeout=2_500)
                            else:
                                input_el.uncheck(timeout=2_500)
                        elif type_ in ("select", "combobox"):
                            try:
                                input_el.select_option(label=value)
                            except Exception:
                                input_el.select_option(value)
                        elif "react-select" in id_:
                            try_interact_react_select(page, input_el, value.strip())
                        else:
                            input_el.fill(value, timeout=2_500)

                        next_state = capture_page_state(page, current["url"])
                        interaction["stateAfter"] = next_state
                        ctx.active_state_name = next_state
                        self._maybe_screenshot(next_state, page)
                        self._ui_snapshot(ctx, interaction["id"], "after_dynamic_field_interaction")
                        wait_for_page_ready(page, f"after_dynamic_field_{mapping['key']}", 6_000)
                        did_fill = True
                        self.events.append(
                            make_event(
                                action_id=interaction["id"],
                                event_type="form_filled_dynamic",
                                technology="custom",
                                event_name="form_field_filled_spa",
                                url=page.url,
                                state_name=ctx.active_state_name,
                                parameters={"source": "dynamic_form_detection", "fieldKey": mapping["key"],
                                            "fieldType": type_, "fieldName": name or id_},
                                consent_state=self._consent_state(ctx),
                                correlation_confidence="high",
                            )
                        )
                    except UrlTimeout:
                        raise
                    except Exception as error:
                        self.warnings.append(
                            {"type": "field_ignored",
                             "message": f"Falha ao preencher campo dinâmico {name}/{id_}: {error}"})
                elif mapping["reason"] != "unsupported_type":
                    self.ignored_fields.append(
                        {
                            "fieldName": normalize_field_descriptor(name)
                            or normalize_field_descriptor(id_)
                            or normalize_field_descriptor(aria_label)
                            or normalize_field_descriptor(placeholder)
                            or normalize_field_descriptor(label_text or "")
                            or normalize_field_descriptor(context_text or "")
                            or "dynamic_field",
                            "cssSelector": "input,select,textarea",
                            "reason": mapping["reason"],
                            "matchedKeys": mapping.get("matchedKeys", []),
                        }
                    )
            except UrlTimeout:
                raise
            except Exception:
                continue

        if did_fill:
            self._publish("processing", page.url or current["url"], "Formulários dinâmicos preenchidos")

        # Rotina de viagem só quando o formulário de viagem existe (decisão §10.3 do HANDOFF).
        # Antes ela rodava em toda página e clicava no "Próximo" do carrossel.
        if self.total_actions < current["maxActions"] and has_travel_form(page):
            self._travel_flow(ctx)

    def _travel_flow(self, ctx: _UrlCtx) -> None:
        """Rotina determinística de progressão da jornada (valores como em explorer.ts)."""
        page = ctx.page
        current = ctx.current
        travel_step = self._action("inspect_form", "kind=step_prep | context=travel_step_pre_submit",
                                   ctx.active_state_name, ctx.active_state_name, page.url)
        self.actions.append(travel_step)
        self.total_actions += 1
        ctx.active_action_id = travel_step["id"]
        try:
            country = page.locator("#react-select-2-input, input[id*='react-select'][id$='-input']").first
            if _visible(country):
                try_interact_react_select(page, country, "Brasil")
                page.wait_for_timeout(400)

            _fill_travel_dates(page)

            increase = page.locator("button[aria-label='increase']").first
            if _visible(increase):
                try:
                    increase.click(timeout=1_500)
                except Exception:
                    pass
                page.wait_for_timeout(250)

            all_checkboxes = page.locator("input[type='checkbox']")
            try:
                moto_index = page.evaluate(JS_MOTO_CHECKBOX_INDEX)
            except Exception:
                moto_index = -1
            consent = all_checkboxes.nth(moto_index) if moto_index >= 0 else all_checkboxes.first
            if _visible(consent):
                try:
                    checked = consent.is_checked()
                except Exception:
                    checked = False
                if not checked:
                    try:
                        consent.check(timeout=2_500)
                    except Exception:
                        try:
                            consent.click(timeout=2_500)
                        except Exception:
                            pass

            refreshed = capture_page_state(page, current["url"])
            travel_step["stateAfter"] = refreshed
            ctx.active_state_name = refreshed
            self._ui_snapshot(ctx, travel_step["id"], "after_travel_step_preparation")
            travel_ready = is_travel_form_ready_for_submit(page)

            if self.total_actions < current["maxActions"]:
                submit = self._action("click_link", "kind=button | context=dynamic_cta_submit_step_1",
                                      ctx.active_state_name, ctx.active_state_name, page.url)
                previous_action_id = ctx.active_action_id
                ctx.active_action_id = submit["id"]
                if consume_consent_prompts(page) > 0:
                    ctx.consent_accepted = True
                if not travel_ready:
                    log.info("Fill phase complete, but form readiness check is partial; attempting CTA click anyway")
                log.info("Attempting first CTA click after fill phase")
                first = click_best_dynamic_cta(page)
                log.info('First CTA click result: clicked=%s text="%s"', first.get("clicked"), first.get("text", ""))
                if first.get("failureReason") == "no_state_change_after_click" and first.get("stableAfterClick"):
                    if try_repair_after_no_change(page):
                        first = click_best_dynamic_cta(page)
                    if first.get("failureReason") == "no_state_change_after_click" and first.get("stableAfterClick"):
                        alt = click_best_dynamic_cta(page, [first.get("text") or ""], min_score=0)
                        if alt.get("clicked"):
                            first = alt
                    if first.get("failureReason") == "no_state_change_after_click" and first.get("stableAfterClick"):
                        self.warnings.append({
                            "type": "spa_router",
                            "message": f'Botão "{first.get("text") or "cta"}" clicado mas estado não mudou. '
                                       "O crawler vai tentar seguir links da página.",
                        })
                if first.get("clicked"):
                    submit["targetSelector"] = (
                        f'kind=button | text={(first.get("text") or "cta")[:80]} | context=dynamic_cta_submit_step_1')
                    self.actions.append(submit)
                    self.total_actions += 1
                    ctx.any_dynamic_cta_clicked = True
                    post = capture_page_state(page, current["url"])
                    submit["stateAfter"] = post
                    ctx.active_state_name = post
                    self._maybe_screenshot(post, page)
                    self._ui_snapshot(ctx, submit["id"], "after_travel_step_submit")
                    ctx.travel_submit_handled = True

                if ctx.travel_submit_handled and self.total_actions < current["maxActions"]:
                    quote = self._action("click_link", "kind=button | context=dynamic_cta_submit_step_2",
                                         ctx.active_state_name, ctx.active_state_name, page.url)
                    ctx.active_action_id = quote["id"]
                    log.info("Attempting second CTA click (step 2)")
                    wait_for_ui_to_settle(page, 10_000)
                    page.wait_for_timeout(1_200)
                    second = click_best_dynamic_cta(page, [first.get("text") or ""])
                    if not second.get("clicked"):
                        log.info("Second CTA click retry without excluded text")
                        second = click_best_dynamic_cta(page, [], min_score=0)
                    log.info('Second CTA click result: clicked=%s text="%s"', second.get("clicked"), second.get("text", ""))
                    if second.get("failureReason") == "no_state_change_after_click" and second.get("stableAfterClick"):
                        if try_repair_after_no_change(page):
                            second = click_best_dynamic_cta(page, [], min_score=0)
                        if second.get("failureReason") == "no_state_change_after_click" and second.get("stableAfterClick"):
                            alt = click_best_dynamic_cta(page, [second.get("text") or ""], min_score=0)
                            if alt.get("clicked"):
                                second = alt
                        if second.get("failureReason") == "no_state_change_after_click" and second.get("stableAfterClick"):
                            self.warnings.append({
                                "type": "spa_router",
                                "message": f'Segundo botão "{second.get("text") or "cta"}" clicado mas estado não mudou. '
                                           "Continuando via links.",
                            })
                    if second.get("clicked"):
                        quote["targetSelector"] = (
                            f'kind=button | text={(second.get("text") or "cta")[:80]} | context=dynamic_cta_submit_step_2')
                        self.actions.append(quote)
                        self.total_actions += 1
                        ctx.any_dynamic_cta_clicked = True
                        post_quote = capture_page_state(page, current["url"])
                        quote["stateAfter"] = post_quote
                        ctx.active_state_name = post_quote
                        self._maybe_screenshot(post_quote, page)
                        self._ui_snapshot(ctx, quote["id"], "after_quote_modal_submit")
                        ctx.quote_submit_handled = True
                ctx.active_action_id = previous_action_id
        except UrlTimeout:
            raise
        except Exception as error:
            if UNKNOWN_FAILURE in str(error):
                raise
            # Etapa best-effort: segue sem interromper o rastreio.

    def _enqueue_links(self, ctx: _UrlCtx) -> None:
        page = ctx.page
        current = ctx.current
        links = collect_links(page, page.url)
        for link in links:
            if len(self.queue) >= current["maxStates"] * 2:
                break
            if is_allowed_url(link, current["allowedDomains"]):
                self.queue.append({**current, "depth": current["depth"] + 1, "url": link})

    def _trigger_clicks(self, ctx: _UrlCtx) -> None:
        page = ctx.page
        current = ctx.current
        # Com campos preenchíveis na página, o botão de envio (ex.: "Agendar serviço") também precisa ser clicado.
        log.info("Looking for dynamic CTA triggers")
        preencher_dropdowns_customizados(page)
        marcar_termos_customizados(page)
        # CEP e outros campos carregam dados (ex.: endereço) de forma assíncrona: espera antes do CTA
        wait_for_ui_to_settle(page, 4_000)
        # Fluxos têm várias etapas (landing -> loja -> cotação -> modal): até 6 CTAs por URL
        budget = min(6, current["maxActions"] - self.total_actions)
        clicked_texts: list[str] = []
        for _ in range(budget):
            self._checkpoint(ctx)
            if self.total_actions >= current["maxActions"]:
                break
            button = self._action("click_link", "kind=button | context=dynamic_trigger_exploration",
                                  ctx.active_state_name, ctx.active_state_name, page.url)
            ctx.active_action_id = button["id"]
            url_before = page.url
            result = click_best_dynamic_cta(page, clicked_texts)
            navigated = bool(page.url) and page.url != url_before
            reason = result.get("failureReason")
            if reason == "payment_screen":
                break
            if reason and not navigated:
                # clique sem efeito ou bloqueado: registra o diagnóstico e tenta o próximo candidato
                text = result.get("text") or "cta"
                clicked_texts.append(text)
                self._registrar_falha_clique(ctx, text, reason, result.get("diagnostico") or {})
                if reason == "no_state_change_after_click" and CAROUSEL_SELECTOR_RE.search(text):
                    ctx.carousel_blocked = True
                continue
            if not result.get("clicked"):
                break
            button_text = (result.get("text") or "cta")[:80]
            clicked_texts.append(result.get("text") or "")
            ctx.any_dynamic_cta_clicked = True
            button["targetSelector"] = f"kind=button | text={button_text} | context=dynamic_trigger_exploration"
            self.actions.append(button)
            self.total_actions += 1
            if navigated:
                # nova página do fluxo: preenche o formulário dela antes do próximo CTA
                log.info("CTA levou a nova página: %s", page.url)
                # exclusão de textos vale para a tela em que foram clicados; nova tela, nova busca
                clicked_texts.clear()
                # SPA: a URL muda antes de a tela renderizar; espera a tela antes de procurar o próximo CTA
                page.wait_for_timeout(2_500)
                wait_for_ui_to_settle(page, 4_000)
                self._fill_static_form(ctx)
                self._dynamic_forms_and_progression(ctx)
                # validação do site roda ao sair do campo: dá tempo para o botão de avanço habilitar
                page.wait_for_timeout(1_000)
            ctx.active_state_name = capture_page_state(page, current["url"])
            button["stateAfter"] = ctx.active_state_name
            self._ui_snapshot(ctx, button["id"], "after_trigger_button_click")
            self.events.append(
                make_event(
                    action_id=button["id"],
                    event_type="button_clicked",
                    technology="custom",
                    event_name="form_trigger_button_clicked",
                    url=page.url,
                    state_name=ctx.active_state_name,
                    parameters={"source": "dynamic_trigger_detection", "buttonText": button_text},
                    consent_state=self._consent_state(ctx),
                    correlation_confidence="high",
                )
            )

    def _registrar_falha_clique(self, ctx: _UrlCtx, text: str, reason: str, diagnostico: dict[str, Any]) -> None:
        """Clique sem efeito: aviso com o que está na tela e print do passo para diagnóstico."""
        partes = [f"reason={reason}"]
        for chave, rotulo in (("dialogs", "modais"), ("alerts", "alertas"),
                              ("invalid", "campos inválidos"), ("disabled", "botões desabilitados")):
            valores = diagnostico.get(chave) or []
            if valores:
                partes.append(f"{rotulo}={valores[:3]}")
        mensagem = f'Clique sem efeito em "{text}" em {ctx.page.url}: ' + " | ".join(partes)
        log.warning(mensagem)
        self.warnings.append({"type": "spa_router", "message": mensagem})
        self._maybe_screenshot(f"DIAGNOSTICO: {ctx.page.url} | {text}", ctx.page)

    def _progression_clicks(self, ctx: _UrlCtx) -> None:
        page = ctx.page
        current = ctx.current
        if not (self.total_actions < current["maxActions"] and ctx.any_dynamic_cta_clicked):
            return
        progression_clicks = 0
        for selector in PROGRESSION_SELECTORS:
            if progression_clicks >= 3 or self.total_actions >= current["maxActions"]:
                break
            if ctx.carousel_blocked and CAROUSEL_SELECTOR_RE.search(selector):
                continue
            control = page.locator(selector).first
            if _count(control) == 0 or not _visible(control):
                continue
            action = self._action("click_link", f"kind=progression | selector={selector} | context=spa_control",
                                  ctx.active_state_name, ctx.active_state_name, page.url)
            self.actions.append(action)
            self.total_actions += 1
            ctx.active_action_id = action["id"]
            try:
                control.click(timeout=2_500)
                page.wait_for_timeout(700)
                next_state = capture_page_state(page, current["url"])
                action["stateAfter"] = next_state
                ctx.active_state_name = next_state
                progression_clicks += 1
                self._ui_snapshot(ctx, action["id"], "after_spa_progression_click")
                self.events.append(
                    make_event(
                        action_id=action["id"],
                        event_type="ui_progression_interaction",
                        technology="custom",
                        event_name="spa_control_clicked",
                        url=page.url,
                        state_name=ctx.active_state_name,
                        parameters={"selector": selector, "source": "spa_progression"},
                        consent_state=self._consent_state(ctx),
                        correlation_confidence="high",
                    )
                )
            except Exception:
                pass

    def _anchor_clicks(self, ctx: _UrlCtx) -> None:
        page = ctx.page
        current = ctx.current
        budget = min(3, current["maxActions"] - self.total_actions)
        for i in range(budget):
            self._checkpoint(ctx)
            # links de conteúdo primeiro: cabeçalho, menu e rodapé gastam o orçamento sem levar ao fluxo
            anchor = page.locator("a[href]:not(header a):not(nav a):not(footer a)").nth(i)
            try:
                anchor.evaluate("el => el.removeAttribute('target')")
            except Exception:
                pass
            if _count(anchor) == 0:
                break
            href = anchor.get_attribute("href")
            if not href:
                continue
            resolved = urljoin(page.url, href)
            single = bool(current.get("singleUrlMode") or self.config.get("singleUrlMode"))
            if single:
                self.warnings.append({"type": "spa_router",
                                      "message": f"Clique em link ignorado em Single URL Mode: {resolved}"})
                continue
            if not is_allowed_url(resolved, current["allowedDomains"]):
                continue
            if is_download_target(resolved):
                self.warnings.append({"type": "spa_router", "message": f"Clique para download ignorado: {resolved}"})
                continue
            if PURCHASE_URL_RE.search(resolved):
                self.warnings.append({"type": "spa_router", "message": f"Link de compra/pagamento ignorado: {resolved}"})
                continue

            try:
                meta = anchor.evaluate(JS_ANCHOR_META)
            except Exception:
                meta = None
            if meta:
                target = summarize_element_target(
                    kind=meta["kind"], text=meta["text"], aria_label=meta["ariaLabel"], title=meta["title"],
                    href=resolved, id=meta["id"], data_attr=meta["dataAttr"], context=meta["context"],
                    selector=f"{meta['stableSelector']}:nth({i + 1})",
                )
            else:
                target = f"kind=link | href={resolved} | context=content | selector=a[href]:nth({i + 1})"

            click_action = self._action("click_link", target, page.url, resolved, page.url)
            ctx.active_action_id = click_action["id"]
            self.actions.append(click_action)
            self.total_actions += 1
            try:
                wait_for_overlay_to_disappear(page)
                anchor.click(timeout=3_000)
                page.wait_for_timeout(700)
            except Exception as error:
                try:
                    anchor.click(force=True, timeout=3_000)
                    page.wait_for_timeout(700)
                except Exception:
                    self.warnings.append({"type": "spa_router",
                                          "message": f"Clique não executado em {resolved}: {error}"})

    # ------------------------------------------------------------------ saída

    def _finish(self) -> dict[str, Any]:
        if not self.visited and self.url_failures and not self.fatal:
            self.fatal = f"nenhuma página carregada ({self.url_failures} falha(s) de navegação)"
        if not self.stop_reason and not self.queue and not self.fatal and self.pause is None:
            if self.waf_count > 0:
                self.stop_reason = (f"queue_exhausted_partial:exploração parcial — fila esgotada com "
                                    f"{self.waf_count} URL(s) bloqueadas por controle de acesso")
            else:
                self.stop_reason = "queue_exhausted:exploração completa"

        output: dict[str, Any] = {"status": "completed", "actions": self.actions, "events": self.events,
                                  "ignoredFields": self.ignored_fields, "warnings": self.warnings,
                                  "statesDiscovered": len(self.visited), "stateScreenshots": self.screens,
                                  "telasVisitadas": self.screens_visited}
        if self.fatal:
            output["status"] = "failed"
            output["stopReason"] = f"error:{self.fatal}"
        elif self.pause is not None:
            output["status"] = "paused"
            output["pauseCheckpoint"] = self.pause
            output["stopReason"] = self.stop_reason or "captcha_detected"
        else:
            output["stopReason"] = self.stop_reason
        return output


def _esc(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _count(locator: Any) -> int:
    try:
        return locator.count()
    except Exception:
        return 0


def _visible(locator: Any) -> bool:
    try:
        return bool(locator.is_visible())
    except Exception:
        return False


def explore_journeys(
    config: dict[str, Any],
    on_progress: Optional[Callable[[dict[str, Any]], None]] = None,
    on_state_visited: Optional[Callable[[dict[str, Any]], None]] = None,
    should_stop: Optional[threading.Event] = None,
) -> dict[str, Any]:
    """Equivalente a exploreJourneys (engine playwright) da versão completa."""
    if not config.get("urls"):
        return {"status": "completed", "actions": [], "events": [], "ignoredFields": [], "warnings": [],
                "statesDiscovered": 0}
    return ExplorerRun(config, on_progress, on_state_visited, should_stop).run()
