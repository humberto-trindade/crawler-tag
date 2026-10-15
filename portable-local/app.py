from __future__ import annotations

import csv
import html
import json
import logging
import re
import threading
import uuid
import webbrowser
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
EXPORT_DIR = ROOT / "exports"
LOG_DIR = ROOT / "logs"
HOST = "127.0.0.1"
PORT = 3000
USER_AGENT = "CrawlerTagPortable/1.0 (authorized tracking audit)"
MAX_BODY = 5 * 1024 * 1024

for directory in (DATA_DIR, EXPORT_DIR, LOG_DIR):
    directory.mkdir(exist_ok=True)

logging.basicConfig(
    filename=LOG_DIR / f"portable-{datetime.now().strftime('%Y%m%d-%H%M%S')}.log",
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("crawler-tag-portable")


@dataclass
class Event:
    technology: str
    event_name: str
    url: str
    event_type: str = "tag_detected"
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


@dataclass
class Execution:
    id: str
    url: str
    status: str = "queued"
    stop_reason: str = ""
    states: list[str] = field(default_factory=list)
    actions: int = 0
    events: list[Event] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    ended_at: str = ""


EXECUTIONS: dict[str, Execution] = {}
LOCK = threading.Lock()


def save_execution(execution: Execution) -> None:
    payload = asdict(execution)
    (DATA_DIR / f"{execution.id}.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def safe_filename(execution_id: str, extension: str) -> Path:
    return EXPORT_DIR / f"execution-{execution_id}.{extension}"


def detect_events(content: str, url: str) -> list[Event]:
    checks = (
        ("gtag(", "ga4", "ga4_tag_detected"),
        ("googletagmanager.com", "google_tag_manager", "gtm_detected"),
        ("fbq(", "meta_pixel", "meta_pixel_detected"),
        ("connect.facebook.net", "meta_pixel", "meta_pixel_detected"),
        ("googleadservices.com", "google_ads", "google_ads_detected"),
        ("doubleclick.net", "google_ads", "google_ads_detected"),
        ("analytics.tiktok.com", "tiktok", "tiktok_detected"),
        ("clarity.ms", "clarity", "clarity_detected"),
    )
    lower = content.lower()
    return [
        Event(technology=technology, event_name=name, url=url)
        for needle, technology, name in checks
        if needle in lower
    ]


def sanitize_tracking_url(raw_url: str) -> str:
    parsed = urlparse(raw_url)
    if not parsed.query:
        return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))
    parameter_names = [(name, "[REDACTED]") for name, _ in parse_qsl(parsed.query, keep_blank_values=True)]
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", urlencode(parameter_names), ""))


class LinkParser:
    def __init__(self, base_url: str, allowed_hosts: set[str]) -> None:
        from html.parser import HTMLParser

        class Parser(HTMLParser):
            def __init__(self) -> None:
                super().__init__()
                self.links: list[str] = []

            def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
                if tag.lower() != "a":
                    return
                href = dict(attrs).get("href")
                if href:
                    self.links.append(href)

        self.parser = Parser()
        self.base_url = base_url
        self.allowed_hosts = allowed_hosts

    def feed(self, content: str) -> list[str]:
        self.parser.feed(content)
        result: list[str] = []
        for href in self.parser.links:
            absolute = urljoin(self.base_url, href).split("#", 1)[0]
            parsed = urlparse(absolute)
            if parsed.scheme in ("http", "https") and parsed.hostname in self.allowed_hosts:
                result.append(absolute)
        return list(dict.fromkeys(result))


def crawl(execution_id: str, depth: int, max_states: int, max_actions: int) -> None:
    with LOCK:
        execution = EXECUTIONS[execution_id]
        execution.status = "running"
        save_execution(execution)
    queue: list[tuple[str, int]] = [(execution.url, 0)]
    visited: set[str] = set()
    root_host = urlparse(execution.url).hostname or ""
    logger.info("execution=%s start url=%s", execution_id, execution.url)
    try:
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
        from playwright.sync_api import sync_playwright
    except ImportError:
        execution.warnings.append("Playwright nao instalado; usando crawler HTTP sem JavaScript")
        crawl_http(execution, depth, max_states, max_actions)
        return

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(
                locale="pt-BR", timezone_id="America/Sao_Paulo",
                user_agent=USER_AGENT, viewport={"width": 1366, "height": 768},
            )
            page = context.new_page()
            network_urls: list[str] = []

            def on_request(request: object) -> None:
                request_url = getattr(request, "url", "")
                if isinstance(request_url, str) and any(
                    marker in request_url.lower()
                    for marker in ("collect", "google-analytics", "facebook.com/tr", "doubleclick", "ads.linkedin")
                ):
                    network_urls.append(sanitize_tracking_url(request_url))

            page.on("request", on_request)
            while queue and len(visited) < max_states and execution.actions < max_actions:
                current, current_depth = queue.pop(0)
                if current in visited:
                    continue
                visited.add(current)
                try:
                    response = page.goto(current, wait_until="domcontentloaded", timeout=45_000)
                    page.wait_for_timeout(2500)
                    status = response.status if response else 0
                    body = page.content()
                    execution.actions += 1
                    execution.states.append(page.url)
                    execution.events.extend(detect_events(body, page.url))
                    execution.events.extend(
                        Event("network", "tracking_request", request_url, "request_observed")
                        for request_url in list(dict.fromkeys(network_urls))
                    )
                    network_urls.clear()
                    if status >= 400:
                        execution.warnings.append(f"HTTP {status} em {current}")
                    if current_depth < depth:
                        links = page.locator("a[href]").evaluate_all("(els) => els.map((e) => e.href)")
                        queue.extend(
                            (link.split("#", 1)[0], current_depth + 1)
                            for link in dict.fromkeys(links)
                            if urlparse(link).hostname == root_host
                        )
                except PlaywrightTimeoutError:
                    execution.warnings.append(f"Timeout ao carregar {current}")
                except Exception as error:
                    execution.warnings.append(f"Falha em {current}: {type(error).__name__}: {error}")
                    logger.exception("execution=%s browser failed url=%s", execution_id, current)
                with LOCK:
                    save_execution(execution)
            browser.close()
        execution.stop_reason = (
            f"max_states:{max_states}" if len(visited) >= max_states
            else f"max_actions:{max_actions}" if execution.actions >= max_actions
            else "queue_exhausted:exploracao completa"
        )
        execution.status = "completed"
    except Exception as error:
        execution.status = "failed"
        execution.stop_reason = f"error:{type(error).__name__}"
        execution.warnings.append(str(error))
        logger.exception("execution=%s fatal failure", execution_id)
    execution.ended_at = datetime.now(timezone.utc).isoformat()
    with LOCK:
        save_execution(execution)
    write_exports(execution)
    logger.info("execution=%s end status=%s", execution_id, execution.status)


def crawl_http(execution: Execution, depth: int, max_states: int, max_actions: int) -> None:
    queue: list[tuple[str, int]] = [(execution.url, 0)]
    visited: set[str] = set()
    root_host = urlparse(execution.url).hostname or ""
    while queue and len(visited) < max_states and execution.actions < max_actions:
        current, current_depth = queue.pop(0)
        if current in visited:
            continue
        visited.add(current)
        try:
            request = Request(current, headers={"User-Agent": USER_AGENT})
            with urlopen(request, timeout=30) as response:
                body = response.read(MAX_BODY).decode("utf-8", "replace")
                status = response.status
            execution.actions += 1
            execution.states.append(current)
            execution.events.extend(detect_events(body, current))
            if status >= 400:
                execution.warnings.append(f"HTTP {status} em {current}")
            if current_depth < depth:
                queue.extend((link, current_depth + 1) for link in LinkParser(current, {root_host}).feed(body))
        except Exception as error:
            execution.warnings.append(f"Falha em {current}: {type(error).__name__}: {error}")
    execution.stop_reason = "fallback_http:playwright_nao_disponivel"
    execution.status = "completed"
    execution.ended_at = datetime.now(timezone.utc).isoformat()
    with LOCK:
        save_execution(execution)
    write_exports(execution)
    logger.info("execution=%s end status=%s", execution_id, execution.status)


def write_exports(execution: Execution) -> None:
    payload = asdict(execution)
    safe_filename(execution.id, "json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    with safe_filename(execution.id, "csv").open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=["timestamp", "technology", "event_name", "event_type", "url"])
        writer.writeheader()
        writer.writerows(asdict(event) for event in execution.events)
    report_html = (
        "<!doctype html><meta charset='utf-8'><title>Crawler Tag report</title>"
        f"<h1>Relatorio de auditoria</h1><p>Status: {html.escape(execution.status)}</p>"
        f"<p>URL inicial: {html.escape(execution.url)}</p>"
        f"<p>Estados: {len(execution.states)} | Acoes: {execution.actions} | Eventos: {len(execution.events)}</p>"
        f"<p>Parada: {html.escape(execution.stop_reason)}</p>"
        "<h2>Eventos</h2><table border='1'><tr><th>Tecnologia</th><th>Evento</th><th>URL</th></tr>"
        + "".join(
            f"<tr><td>{html.escape(event.technology)}</td><td>{html.escape(event.event_name)}</td><td>{html.escape(event.url)}</td></tr>"
            for event in execution.events
        )
        + "</table><h2>Avisos</h2><ul>"
        + "".join(f"<li>{html.escape(warning)}</li>" for warning in execution.warnings)
        + "</ul>"
    )
    safe_filename(execution.id, "html").write_text(report_html, encoding="utf-8")
    write_minimal_pdf(execution)


def write_minimal_pdf(execution: Execution) -> None:
    lines = [
        "Crawler Tag - Relatorio de auditoria",
        f"Status: {execution.status}",
        f"URL: {execution.url}",
        f"Estados: {len(execution.states)}  Acoes: {execution.actions}  Eventos: {len(execution.events)}",
        f"Parada: {execution.stop_reason}",
    ]
    stream = "BT /F1 11 Tf 50 780 Td " + " ".join(f"({line[:110]}) Tj 0 -16 Td" for line in lines) + " ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        f"<< /Length {len(stream.encode())} >>\nstream\n{stream}\nendstream".encode(),
    ]
    output = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    output.extend("".join(f"{offset:010d} 00000 n \n" for offset in offsets[1:]).encode())
    output.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    safe_filename(execution.id, "pdf").write_bytes(output)


HTML = """<!doctype html><meta charset="utf-8"><title>Crawler Tag Portable</title>
<style>body{font:16px Arial;max-width:850px;margin:30px auto}input{padding:8px;margin:4px}button{padding:9px 14px}pre{background:#f3f3f3;padding:12px;white-space:pre-wrap}a{margin-right:12px}</style>
<h1>Crawler Tag - execucao local</h1>
<p>Python apenas. Resultados sao gravados em <code>portable-local/exports</code>.</p>
<form id="form"><input id="url" size="60" value="https://www.portoseguro.com.br/servicos" required><br>
Profundidade <input id="depth" type="number" value="0" min="0" max="5">
Estados <input id="states" type="number" value="5" min="1" max="100">
Acoes <input id="actions" type="number" value="10" min="1" max="100">
<button>Executar auditoria</button></form><pre id="output">Pronto.</pre>
<script>
const form=document.querySelector('#form'), out=document.querySelector('#output');
form.onsubmit=async(e)=>{e.preventDefault();out.textContent='Iniciando...';
const p={url:url.value,depth:+depth.value,max_states:+states.value,max_actions:+actions.value};
const r=await fetch('/api/executions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
const x=await r.json(); if(!r.ok){out.textContent=x.error;return;}
const timer=setInterval(async()=>{const s=await (await fetch('/api/executions/'+x.id)).json();out.textContent=JSON.stringify(s,null,2);
if(['completed','failed'].includes(s.status)){clearInterval(timer);out.innerHTML+=`\\n\\n<a href="/api/executions/${x.id}/report">Relatorio</a><a href="/api/executions/${x.id}/export?format=json">JSON</a><a href="/api/executions/${x.id}/export?format=csv">CSV</a><a href="/api/executions/${x.id}/export?format=pdf">PDF</a>`}},1000)};
</script>"""


class Handler(BaseHTTPRequestHandler):
    def send_json(self, payload: object, status: int = 200) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/":
            raw = HTML.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        match = re.fullmatch(r"/api/executions/([a-f0-9-]+)(?:/(report|export))?", path)
        if not match:
            self.send_json({"error": "not_found"}, 404)
            return
        execution = EXECUTIONS.get(match.group(1))
        if not execution:
            file = DATA_DIR / f"{match.group(1)}.json"
            if not file.exists():
                self.send_json({"error": "execution_not_found"}, 404)
                return
            execution = Execution(**json.loads(file.read_text(encoding="utf-8")))
        if match.group(2) is None:
            self.send_json(asdict(execution))
            return
        if match.group(2) == "report":
            raw = safe_filename(execution.id, "html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
        else:
            query = self.path.split("?", 1)[1] if "?" in self.path else ""
            fmt = query.replace("format=", "")
            if fmt not in ("json", "csv", "pdf"):
                self.send_json({"error": "format must be json, csv or pdf"}, 400)
                return
            raw = safe_filename(execution.id, fmt).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", {"json": "application/json", "csv": "text/csv", "pdf": "application/pdf"}[fmt])
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:
        if self.path != "/api/executions":
            self.send_json({"error": "not_found"}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length))
            parsed = urlparse(str(payload["url"]))
            if parsed.scheme not in ("http", "https") or not parsed.hostname:
                raise ValueError("URL deve usar http ou https")
            execution = Execution(id=str(uuid.uuid4()), url=payload["url"])
            EXECUTIONS[execution.id] = execution
            save_execution(execution)
            thread = threading.Thread(
                target=crawl,
                args=(execution.id, int(payload.get("depth", 0)), int(payload.get("max_states", 5)), int(payload.get("max_actions", 10))),
                daemon=True,
            )
            thread.start()
            self.send_json({"id": execution.id, "status": execution.status}, 201)
        except Exception as error:
            logger.exception("invalid execution request")
            self.send_json({"error": str(error)}, 400)

    def log_message(self, format: str, *args: object) -> None:
        logger.info("http %s", format % args)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    logger.info("portable app listening on http://%s:%s", HOST, PORT)
    webbrowser.open(f"http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("shutdown requested")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
