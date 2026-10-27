"""Port de funções de detecção de rastreadores, bloqueios e downloads.

Origem: cloud-run-app/src/crawler/explorer.ts (parseTrackingRequest,
isPotentialTrackerUrl, detectTrackingEventsFromHtml, sanitizeParameter,
hasBlockingCaptcha, isWafBlock, isDownloadTarget) e accessClassification.ts.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import parse_qsl, urlparse

BLOCKED_DOWNLOAD_EXTENSIONS = [
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".zip", ".rar", ".7z", ".csv", ".xml", ".txt",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_id() -> str:
    return str(uuid.uuid4())


_PASSO_ESTADO_RE = re.compile(r"\bpasso\s+(\d+\s*de\s*\d+)", re.I)


def extrair_passo(state_name: str) -> str:
    """Passo capturado no nome do estado (ex.: 'passo 3 de 3' -> '3 de 3'); vazio se não houver."""
    match = _PASSO_ESTADO_RE.search(state_name or "")
    return re.sub(r"\s+", " ", match.group(1)).strip().lower() if match else ""


def make_event(
    *,
    action_id: Optional[str],
    event_type: str,
    technology: str,
    event_name: str,
    url: str,
    state_name: str,
    parameters: dict[str, Any],
    consent_state: str = "unknown",
    status: str = "observed",
    correlation_confidence: str = "low",
    request_payload: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "id": new_id(),
        "actionId": action_id,
        "eventType": event_type,
        "technology": technology,
        "eventName": event_name,
        "url": url,
        "stateName": state_name,
        "passo": extrair_passo(state_name),
        "parameters": parameters,
        "consentState": consent_state,
        "status": status,
        "correlationConfidence": correlation_confidence,
        "timestamp": now_iso(),
    }
    if request_payload is not None:
        event["requestPayload"] = request_payload
    return event


def sanitize_parameter(name: str, value: str) -> str:
    lowered = name.lower()
    if "token" in lowered or "cookie" in lowered or "auth" in lowered:
        return "[redacted]"
    if "email" in lowered:
        return "[masked-email]"
    if "phone" in lowered or "telefone" in lowered:
        return "[masked-phone]"
    if len(value) > 120:
        return f"{value[:120]}...[truncated]"
    return value


def parse_tracking_request(request_url: str) -> Optional[dict[str, str]]:
    n = request_url.lower()
    if (
        "facebook.com/tr" in n
        or "connect.facebook.net" in n
        or "fbevents.js" in n
        or "/signals/config" in n
    ):
        return {"technology": "meta_pixel", "eventName": "network_meta"}
    if "google-analytics.com/g/collect" in request_url or "/collect?" in request_url:
        return {"technology": "ga4", "eventName": "network_collect"}
    if "doubleclick.net" in request_url or "googleads.g.doubleclick.net" in request_url:
        return {"technology": "google_ads", "eventName": "network_ads"}
    if "bat.bing.com" in n or "clarity.ms" in n:
        return {"technology": "microsoft_ads", "eventName": "network_microsoft_ads"}
    if "analytics.tiktok.com" in n or "tiktok" in n:
        return {"technology": "tiktok_pixel", "eventName": "network_tiktok"}
    if "px.ads.linkedin.com" in n or "snap.licdn.com" in n:
        return {"technology": "linkedin_insight", "eventName": "network_linkedin"}
    if "hotjar.com" in n:
        return {"technology": "hotjar", "eventName": "network_hotjar"}
    if "omtrdc.net" in n or "adobedc.net" in n or "/b/ss/" in n:
        return {"technology": "adobe_analytics", "eventName": "network_adobe"}
    if "ct.pinterest.com" in n:
        return {"technology": "pinterest_tag", "eventName": "network_pinterest"}
    if "tr.snapchat.com" in n:
        return {"technology": "snap_pixel", "eventName": "network_snapchat"}
    return None


_INCLUDE_HINTS = ["collect", "analytics", "pixel", "track", "tr?", "tag", "gtm", "metrics", "ads", "conversion"]
_EXCLUDE_HINTS = [".css", ".js", ".png", ".jpg", ".svg", "font", "favicon"]


def is_potential_tracker_url(request_url: str) -> bool:
    n = request_url.lower()
    if not (n.startswith("http://") or n.startswith("https://")):
        return False
    if any(hint in n for hint in _EXCLUDE_HINTS):
        return False
    return any(hint in n for hint in _INCLUDE_HINTS)


def request_query_params(request_url: str) -> dict[str, str]:
    parsed = urlparse(request_url)
    result: dict[str, str] = {}
    for name, value in parse_qsl(parsed.query, keep_blank_values=True):
        # Igual ao objeto JS da versão completa: em nome repetido, vale a última ocorrência.
        result[name] = sanitize_parameter(name, value)
    return result


def detect_tracking_events_from_html(
    html: str, url: str, action_id: Optional[str], consent_state: str = "unknown"
) -> list[dict[str, Any]]:
    confidence = "high" if action_id else "low"
    common = dict(
        action_id=action_id,
        event_type="tag_detected",
        url=url,
        state_name=url,
        consent_state=consent_state,
        correlation_confidence=confidence,
    )
    checks = [
        (
            lambda h: "gtag(" in h or "googletagmanager.com" in h,
            "ga4",
            "ga4_tag_detected",
        ),
        (
            lambda h: "fbq(" in h or "connect.facebook.net" in h,
            "meta_pixel",
            "meta_pixel_detected",
        ),
        (
            lambda h: "analytics.tiktok.com" in h or "ttq(" in h,
            "tiktok_pixel",
            "tiktok_tag_detected",
        ),
        (
            lambda h: "px.ads.linkedin.com" in h or "linkedin" in h,
            "linkedin_insight",
            "linkedin_tag_detected",
        ),
        (
            lambda h: "clarity.ms" in h or "hotjar" in h,
            "session_analytics",
            "session_analytics_detected",
        ),
    ]
    lowered = html  # TS usa includes() case-sensitive; mantém o mesmo comportamento
    events = []
    for predicate, technology, name in checks:
        if predicate(lowered):
            events.append(
                make_event(
                    technology=technology,
                    event_name=name,
                    parameters={"source": "html_scan"},
                    **common,
                )
            )
    return events


def has_blocking_captcha(html: str) -> bool:
    has_widget = re.search(r"(g-recaptcha|h-captcha|arkose|data-sitekey)", html, re.I) is not None
    has_iframe = re.search(r"<iframe[^>]+(recaptcha|hcaptcha|arkoselabs)", html, re.I) is not None
    has_text = re.search(
        r"(n[aã]o sou um rob[oô]|i am human|verifique que voc[eê] [ée] humano|captcha)", html, re.I
    ) is not None
    return has_iframe and (has_text or has_widget)


def is_waf_block(html: str, status_code: int) -> bool:
    if status_code in (403, 429):
        return True
    return re.search(
        r"(sorry.*you.*have.*been.*blocked|access.*denied.*cloudflare|ray id:|cf-ray|__cf_chl|cf_clearance"
        r"|cloudflare.*security|error 1015|error 1020)",
        html,
        re.I,
    ) is not None


def classify_blocked_navigation(status_code: int, title: str, html: str) -> str:
    content = f"{title}\n{html}".lower()
    if re.search(
        r"just a moment|checking your browser|verify you are human|human verification|"
        r"verifica[çc][aã]o humana|__cf_chl|cf-chl|challenge-platform|captcha|turnstile",
        content,
    ):
        return "challenge_detected"
    return "blocked_by_waf"


def is_download_target(raw_url: str) -> bool:
    try:
        parsed = urlparse(raw_url)
    except ValueError:
        return False
    path = parsed.path.lower()
    if any(path.endswith(ext) for ext in BLOCKED_DOWNLOAD_EXTENSIONS):
        return True
    fmt = None
    for name, value in parse_qsl(parsed.query, keep_blank_values=True):
        if name == "format":
            fmt = value.lower()
            break
    if fmt and any(ext[1:] == fmt for ext in BLOCKED_DOWNLOAD_EXTENSIONS):
        return True
    return False
