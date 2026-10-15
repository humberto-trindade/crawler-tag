"""
Motor de exploração de jornadas usando Camoufox (Firefox anti-detect).

Este módulo é um port do src/crawler/explorer.ts para Python, adaptado para
usar Camoufox em vez de Playwright/Chromium puro.

Diferenças em relação ao explorer.ts:
- Engine: Firefox (SpiderMonkey) via Camoufox, não Chromium
- Fingerprint: C++ level (indetectável por JS), não JS injection
- Stealth: BrowserForge gera fingerprints internamente consistentes
- WAF: TLS JA3 de Firefox, menos detectável pelo Cloudflare Bot Management

Para instalar e rodar:
  pip install camoufox[geoip] playwright
  camoufox fetch  # Download do Firefox modificado (~200MB)
  python -c "from explorer import explore_journeys; print('ok')"
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import os
import re
from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from models import (
    CrawlAction,
    CrawlConfig,
    CrawlEvent,
    CrawlOutput,
    CrawlWarning,
    IgnoredField,
    SessionCookie,
    TemplateKey,
)

logger = logging.getLogger("crawler-service.explorer")


# ── Helpers ───────────────────────────────────────────────────────────────────

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def sanitize_parameter(name: str, value: str) -> str:
    """Redact PII e credenciais de parâmetros de tracking."""
    sensitive = re.compile(
        r"(cpf|cnpj|email|phone|name|nome|pass|token|key|secret|credit|card|cvv|birth|address)",
        re.IGNORECASE,
    )
    if sensitive.search(name):
        return "[REDACTED]"
    return value[:200]  # limitar tamanho


def is_waf_block(html: str, status: int) -> bool:
    """Detecta página de bloqueio Cloudflare."""
    if status in (403, 429):
        return True
    patterns = [
        "sorry.*you.*have.*been.*blocked",
        "just a moment",
        "__cf_chl",
        "cf_clearance",
        "cloudflare.*security",
        "error 1015",
        "error 1020",
        "ray id:",
    ]
    lower = html.lower()
    return any(re.search(p, lower) for p in patterns)


def detect_tracking_from_html(html: str, url: str, action_id: Optional[str]) -> list[CrawlEvent]:
    """Detecta scripts de tracking conhecidos no HTML."""
    events = []
    checks = [
        ("gtag(", "ga4", "ga4_tag_detected"),
        ("googletagmanager.com", "ga4", "gtm_detected"),
        ("fbq(", "meta_pixel", "meta_pixel_detected"),
        ("connect.facebook.net", "meta_pixel", "meta_pixel_detected"),
        ("analytics.tiktok.com", "tiktok_pixel", "tiktok_tag_detected"),
        ("px.ads.linkedin.com", "linkedin_insight", "linkedin_tag_detected"),
        ("clarity.ms", "clarity", "clarity_detected"),
        ("hotjar", "hotjar", "hotjar_detected"),
    ]
    for needle, tech, event_name in checks:
        if needle in html:
            events.append(CrawlEvent(
                id=str(uuid4()),
                actionId=action_id,
                eventType="tag_detected",
                technology=tech,
                eventName=event_name,
                url=url,
                stateName=url,
                parameters={"source": "html_scan"},
                consentState="unknown",
                status="observed",
                correlationConfidence="high" if action_id else "low",
                timestamp=now_iso(),
            ))
    return events


# ── Field mapping (port do fieldMapper.ts) ────────────────────────────────────

def resolve_field_mapping(
    name: str,
    label: str,
    placeholder: str,
    input_type: str,
    template_keys: list[TemplateKey],
) -> Optional[str]:
    """
    Resolve o valor de persona para um campo de formulário.
    Retorna o valor a preencher ou None se não encontrar mapeamento.
    """
    name_lower = name.lower()
    label_lower = label.lower()
    ph_lower = placeholder.lower()
    type_lower = input_type.lower()

    matches = []
    for key in template_keys:
        m = key.matchers
        if any(a.lower() in name_lower for a in m.attributes):
            matches.append(key)
            continue
        if any(l.lower() in label_lower for l in m.labels):
            matches.append(key)
            continue
        if any(p.lower() in ph_lower for p in m.placeholders):
            matches.append(key)
            continue
        if any(t.lower() == type_lower for t in m.types):
            matches.append(key)
            continue

    if not matches:
        return None
    if len(matches) == 1:
        return matches[0].value
    # Ambiguous — usar primeiro se todos têm o mesmo valor
    values = {k.value for k in matches}
    if len(values) == 1:
        return matches[0].value
    return None  # genuinamente ambíguo


# ── Exploração principal ───────────────────────────────────────────────────────

async def explore_journeys(config: CrawlConfig) -> CrawlOutput:
    """
    Explora jornadas usando Camoufox (Firefox anti-detect).
    
    Esta função é o equivalente de runPlaywrightEngine() do explorer.ts,
    mas usando Camoufox para contornar Cloudflare Bot Management.
    """
    # Import aqui para evitar erro se camoufox não estiver instalado
    try:
        from camoufox.async_api import AsyncCamoufox
    except ImportError:
        raise RuntimeError(
            "Camoufox não está instalado. Execute:\n"
            "  pip install camoufox[geoip]\n"
            "  camoufox fetch\n"
        )

    actions: list[CrawlAction] = []
    events: list[CrawlEvent] = []
    warnings: list[CrawlWarning] = []
    ignored_fields: list[IgnoredField] = []
    visited: set[str] = set()
    state_screenshots: dict[str, str] = {}
    stop_reason: Optional[str] = None

    # Fila inicial
    queue = []
    for url_cfg in config.urls:
        queue.append(url_cfg)

    async with AsyncCamoufox(
        os="windows",
        humanize=True,           # Movimento de cursor humano (reduz detecção comportamental)
        headless=True,           # True para produção; "virtual" no Linux sem display
        locale="pt-BR",
        disable_coop=True,       # Necessário para Cloudflare Turnstile
        block_webrtc=True,       # Evita leak de IP via WebRTC
        # geoip=True,            # Descomente com proxy residencial
    ) as browser:

        # Injetar cookies de sessão (cf_clearance, auth tokens)
        if config.session_cookies:
            cookie_list = []
            for c in config.session_cookies:
                # Derivar domínios candidatos das URLs configuradas
                for url_cfg in config.urls:
                    try:
                        from urllib.parse import urlparse
                        host = urlparse(url_cfg.url).hostname or ""
                        parts = host.split(".")
                        parent = ".".join(parts[-3:]) if parts[-1] == "br" and len(parts) >= 3 else ".".join(parts[-2:])
                        for domain in [host, f".{parent}", parent]:
                            cookie_list.append({
                                "name": c.name,
                                "value": c.value,
                                "domain": domain,
                                "path": c.path,
                                "sameSite": c.same_site,
                                "secure": c.secure or c.name in ("cf_clearance", "__cf_bm"),
                            })
                    except Exception:
                        pass
            if cookie_list:
                await browser.add_cookies(cookie_list)
                logger.info(f"Injetados {len(config.session_cookies)} cookies de sessão")

        total_actions = 0
        waf_blocked_count = 0

        for url_cfg in queue:
            if url_cfg.url in visited:
                continue
            if len(visited) >= url_cfg.max_states:
                stop_reason = f"max_states:{url_cfg.max_states}"
                break
            if total_actions >= url_cfg.max_actions:
                stop_reason = f"max_actions:{url_cfg.max_actions}"
                break

            visited.add(url_cfg.url)
            page = await browser.new_page()

            try:
                logger.info(f"[CRAWLER] Navegando para {url_cfg.url}")
                response = await page.goto(url_cfg.url, wait_until="domcontentloaded", timeout=30_000)
                await page.wait_for_timeout(2000)  # SPA render

                # Checar WAF
                status = response.status if response else 0
                html = await page.content()

                if is_waf_block(html, status):
                    cf_ray = response.headers.get("cf-ray", "") if response else ""
                    logger.warning(f"[CRAWLER] WAF block em {url_cfg.url} (status={status}, cf-ray={cf_ray})")
                    warnings.append(CrawlWarning(
                        type="navigation_blocked",
                        message=f"WAF/Cloudflare bloqueou {url_cfg.url} (HTTP {status}, cf-ray={cf_ray}). "
                                "Com Camoufox: se persiste, use proxy residencial.",
                    ))
                    # Aguardar até 15s para JS challenge auto-resolver (funciona para challenges simples)
                    try:
                        await page.wait_for_function(
                            "() => !document.title.toLowerCase().includes('blocked') && "
                            "!document.title.toLowerCase().includes('just a moment')",
                            timeout=15_000,
                        )
                        html = await page.content()
                        if not is_waf_block(html, 0):
                            logger.info(f"[CRAWLER] Challenge resolvido para {url_cfg.url}")
                        else:
                            waf_blocked_count += 1
                            continue
                    except Exception:
                        waf_blocked_count += 1
                        continue

                # Registrar ação de navegação
                state_name = url_cfg.url
                nav_action_id = str(uuid4())
                actions.append(CrawlAction(
                    id=nav_action_id,
                    type="navigate",
                    targetSelector="",
                    stateBefore="",
                    stateAfter=state_name,
                    url=url_cfg.url,
                    timestamp=now_iso(),
                ))
                total_actions += 1

                # Capturar eventos de tracking do HTML inicial
                html_events = detect_tracking_from_html(html, url_cfg.url, nav_action_id)
                events.extend(html_events)

                # Screenshot do estado inicial
                if len(state_screenshots) < 20:
                    try:
                        buf = await page.screenshot(type="jpeg", quality=20, full_page=True, timeout=8_000)
                        state_screenshots[state_name] = f"data:image/jpeg;base64,{base64.b64encode(buf).decode()}"
                    except Exception as e:
                        logger.warning(f"Screenshot falhou para {state_name}: {e}")

                # TODO: Fase 2 — port completo de:
                #   - fill_form_fields() → preencher campos com template_keys
                #   - click_best_cta() → detectar e clicar CTA de progressão
                #   - discover_links() → descobrir links internos para fila
                #   - detect_spa_state_change() → detectar mudança de estado SPA
                # Ver src/crawler/explorer.ts para implementação de referência

                logger.info(
                    f"[CRAWLER] {url_cfg.url}: "
                    f"{len(html_events)} eventos, estado={state_name}"
                )

            except Exception as exc:
                logger.exception(f"Erro ao processar {url_cfg.url}")
                warnings.append(CrawlWarning(
                    type="spa_router",
                    message=f"Falha ao processar {url_cfg.url}: {exc}",
                ))
            finally:
                await page.close()

    if waf_blocked_count > 0 and not stop_reason:
        stop_reason = (
            f"queue_exhausted_partial:exploração parcial — "
            f"{waf_blocked_count} URL(s) bloqueadas por WAF"
        )
    elif not stop_reason:
        stop_reason = "queue_exhausted:exploração completa"

    return CrawlOutput(
        status="completed",
        stopReason=stop_reason,
        actions=actions,
        events=events,
        ignoredFields=ignored_fields,
        warnings=warnings,
        statesDiscovered=len(visited),
        stateScreenshots=state_screenshots,
    )
