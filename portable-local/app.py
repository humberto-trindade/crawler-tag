"""Crawler Tag - versão portátil (Python + Playwright), sem Docker e sem banco.

Usa o mesmo motor de exploração da versão completa (motor/explorer.py).
Cada execução é gravada em portable-local/data/<id>.json e exportada em
exports/ (JSON, CSV, HTML e PDF).
"""

from __future__ import annotations

import csv
import html
import io
import json
import logging
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import jornadas

ROOT = Path(__file__).resolve().parent
# Chromium instalado por INICIAR.bat fica em ./browsers; vale também para executar_jornadas.py (Agendador de Tarefas)
os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(ROOT / "browsers"))
DATA_DIR = ROOT / "data"
EXPORT_DIR = ROOT / "exports"
LOG_DIR = ROOT / "logs"
TEMPLATE_DIR = ROOT / "templates"
HOST = "127.0.0.1"
PORT = 3000
SYNTHETIC_EMAIL_SUFFIXES = (".test", "@example.com", "@example.test", "@mailinator.com")
# Watchdog do processo do motor (motor/worker.py)
WORKER_NO_PROGRESS_S = 150  # sem nenhuma mensagem do motor por este tempo => travado
WORKER_STOP_GRACE_S = 30  # após pedido de parada, tempo para o motor sair entre etapas
WORKER_MAX_TOTAL_S = 40 * 60  # teto absoluto por execução
WORKER_MESSAGE_PREFIX = "@@ENGINE "
WORKER_MAX_RESTARTS = 2  # retomadas da fila após watchdog
# Relatórios e downloads (CSV/JSON/PDF/HTML). Desligue com CRAWLER_EXPORTS=0 para testar outras partes.
EXPORTS_ENABLED = os.environ.get("CRAWLER_EXPORTS", "1") != "0"

for directory in (DATA_DIR, EXPORT_DIR, LOG_DIR, TEMPLATE_DIR):
    directory.mkdir(exist_ok=True)

logging.basicConfig(
    filename=LOG_DIR / f"portable-{datetime.now().strftime('%Y%m%d-%H%M%S')}.log",
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    encoding="utf-8",
)
logger = logging.getLogger("crawler-tag-portable")

EXECUTIONS: dict[str, dict] = {}
STOP_EVENTS: dict[str, threading.Event] = {}
LOCK = threading.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ---------------------------------------------------------------- validação

def validate_url_config(item: dict) -> dict:
    url = str(item.get("url", ""))
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("URL deve usar http ou https")
    depth = int(item.get("depth", 0))
    max_actions = int(item.get("maxActions", 60))
    max_states = int(item.get("maxStates", 30))
    if not 0 <= depth <= 5:
        raise ValueError("depth deve estar entre 0 e 5")
    if not 1 <= max_actions <= 10_000 or not 1 <= max_states <= 10_000:
        raise ValueError("maxActions e maxStates devem estar entre 1 e 10000")
    allowed = item.get("allowedDomains") or [parsed.hostname]
    allowed = [str(d).strip() for d in allowed if str(d).strip()]
    if not allowed:
        raise ValueError("allowedDomains não pode ser vazio")
    return {
        "url": url,
        "depth": depth,
        "maxActions": max_actions,
        "maxStates": max_states,
        "allowedDomains": allowed,
        "singleUrlMode": bool(item.get("singleUrlMode", False)),
    }


def load_template(template_name: str) -> dict:
    safe = re.sub(r"[^a-zA-Z0-9_.-]", "", template_name)
    path = TEMPLATE_DIR / f"{safe}.json"
    if not path.exists():
        raise ValueError(f"template não encontrado: {safe}")
    data = json.loads(path.read_text(encoding="utf-8"))
    keys = data["data"]["keys"]
    for field in keys:
        if "email" in field["key"].lower() and not field["value"].lower().endswith(SYNTHETIC_EMAIL_SUFFIXES):
            raise ValueError(f'email do template "{field["key"]}" deve usar domínio sintético (.test ou example)')
    return {"name": data.get("name", safe), "keys": keys}


def list_templates() -> list[str]:
    return sorted(p.stem for p in TEMPLATE_DIR.glob("*.json"))


# ---------------------------------------------------------------- persistência

def save_execution(record: dict) -> None:
    path = DATA_DIR / f"{record['id']}.json"
    path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")


def load_execution(execution_id: str) -> dict | None:
    if execution_id in EXECUTIONS:
        return EXECUTIONS[execution_id]
    path = DATA_DIR / f"{execution_id}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def list_executions() -> list[dict]:
    rows = []
    for path in DATA_DIR.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        rows.append({k: data.get(k) for k in ("id", "url", "status", "createdAt", "endedAt")})
    return sorted(rows, key=lambda r: r.get("createdAt") or "", reverse=True)


# ---------------------------------------------------------------- execução

def _kill_worker(proc: subprocess.Popen) -> None:
    """Encerra o processo do motor e o Chromium que ele abriu (árvore de processos)."""
    if proc.poll() is None:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
        else:
            proc.kill()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        logger.warning("worker pid=%s não encerrou após kill", proc.pid)


def _read_worker_stdout(proc: subprocess.Popen, messages: queue.Queue) -> None:
    # Precisa drenar o pipe até o fim: se esta thread parar, o worker bloqueia no write.
    try:
        for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace")
            if not line.startswith(WORKER_MESSAGE_PREFIX):
                continue
            try:
                messages.put(json.loads(line[len(WORKER_MESSAGE_PREFIX):]))
            except json.JSONDecodeError:
                logger.warning("mensagem inválida do motor descartada")
    except Exception:
        logger.exception("leitura do stdout do motor interrompida")
    finally:
        messages.put({"kind": "eof"})


def _run_worker(execution_id: str, config: dict, record: dict, stop_event: threading.Event) -> tuple[dict | None, str | None, str | None]:
    """Roda o motor no processo filho com watchdog.

    Retorna (output, error, watchdog). output é o resultado final ou o último parcial.
    watchdog descreve por que o motor foi encerrado à força; None se terminou sozinho.
    """
    work_dir = Path(tempfile.mkdtemp(prefix="crawler-tag-"))
    config_path = work_dir / "config.json"
    stop_path = work_dir / "stop"
    config_path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
    log_file = Path(logging.getLogger().handlers[0].baseFilename)
    command = [
        sys.executable, "-m", os.environ.get("CRAWLER_WORKER_MODULE", "motor.worker"),
        "--config", str(config_path),
        "--stop-file", str(stop_path),
        "--log-file", str(log_file),
    ]
    with open(log_file, "a", encoding="utf-8") as stderr_log:
        proc = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=stderr_log)
    messages: queue.Queue = queue.Queue()
    reader = threading.Thread(target=_read_worker_stdout, args=(proc, messages), daemon=True)
    reader.start()
    logger.info("execution=%s worker pid=%s", execution_id, proc.pid)

    started = last = time.monotonic()
    stop_requested_at: float | None = None
    result: dict | None = None
    partial: dict | None = None
    error: str | None = None
    watchdog: str | None = None
    try:
        while True:
            try:
                message = messages.get(timeout=1)
            except queue.Empty:
                message = None
            if message is not None:
                kind = message.get("kind")
                if kind == "eof":
                    break
                last = time.monotonic()
                payload = message.get("payload")
                if kind == "progress":
                    with LOCK:
                        record["progress"] = payload
                elif kind == "snapshot":
                    partial = payload
                    with LOCK:
                        record["partialOutput"] = payload
                        save_execution(record)
                elif kind == "result":
                    result = payload
                elif kind == "error":
                    error = payload

            now = time.monotonic()
            if stop_event.is_set() and stop_requested_at is None:
                stop_path.touch()
                stop_requested_at = now
            if stop_requested_at is not None and now - stop_requested_at > WORKER_STOP_GRACE_S:
                watchdog = "cancelled:interrompido pelo operador sem resposta do motor"
                break
            if now - last > WORKER_NO_PROGRESS_S:
                watchdog = f"watchdog_sem_progresso:{WORKER_NO_PROGRESS_S}s sem atividade do motor"
                break
            if now - started > WORKER_MAX_TOTAL_S:
                watchdog = f"watchdog_tempo_total:{WORKER_MAX_TOTAL_S}s"
                break
    finally:
        _kill_worker(proc)
        reader.join(timeout=5)
        proc.stdout.close()
        shutil.rmtree(work_dir, ignore_errors=True)

    if result is None and error is None and watchdog is None:
        error = f"motor terminou sem resultado (código {proc.returncode})"
    logger.info("execution=%s worker encerrado code=%s watchdog=%s", execution_id, proc.returncode, watchdog)
    return (result or partial), error, watchdog


def _empty_output() -> dict:
    return {"actions": [], "events": [], "ignoredFields": [], "warnings": [],
            "statesDiscovered": 0, "stateScreenshots": {}, "visitedUrls": [], "telasVisitadas": []}


def _merge_partial(carry: dict, partial: dict) -> dict:
    """Junta o que já foi coletado em tentativas anteriores com o parcial atual."""
    merged = {key: [*carry.get(key, []), *partial.get(key, [])]
              for key in ("actions", "events", "ignoredFields", "warnings", "visitedUrls", "telasVisitadas")}
    merged["statesDiscovered"] = carry.get("statesDiscovered", 0) + partial.get("statesDiscovered", 0)
    merged["stateScreenshots"] = {**carry.get("stateScreenshots", {}), **partial.get("stateScreenshots", {})}
    for key in ("status", "stopReason"):
        if key in partial:
            merged[key] = partial[key]
    return merged


def _resume_config(config: dict, merged: dict, pending: list[dict]) -> dict:
    """Configuração da próxima tentativa: URLs pendentes, com o orçamento que sobrou e sem repetir visitadas."""
    root = config["urls"][0]
    return {
        **config,
        "urls": [
            {
                "url": item["url"],
                "depth": item["maxDepth"],
                "allowedDomains": item["allowedDomains"],
                "maxActions": max(1, root["maxActions"] - len(merged["actions"])),
                "maxStates": max(1, root["maxStates"] - merged["statesDiscovered"]),
                "singleUrlMode": bool(item.get("singleUrlMode")),
            }
            for item in pending
        ],
        "skipUrls": merged["visitedUrls"],
    }


def run_execution(execution_id: str, config: dict) -> None:
    record = EXECUTIONS[execution_id]
    stop_event = STOP_EVENTS[execution_id]
    record["status"] = "running"
    save_execution(record)
    logger.info("execution=%s start urls=%s", execution_id, [u["url"] for u in config["urls"]])

    carry = _empty_output()
    attempt_config = config
    restarts = 0
    while True:
        partial, error, watchdog = _run_worker(execution_id, attempt_config, record, stop_event)
        if error is not None:
            break
        output = _merge_partial(carry, partial or {})
        pending = (partial or {}).get("pendingQueue") or []
        can_resume = (watchdog is not None and pending and restarts < WORKER_MAX_RESTARTS
                      and not stop_event.is_set() and not watchdog.startswith("cancelled:"))
        if not can_resume:
            break
        restarts += 1
        logger.warning("execution=%s retomando %s URL(s) após watchdog (tentativa %s)",
                       execution_id, len(pending), restarts)
        output.setdefault("warnings", []).append({
            "type": "spa_router",
            "message": f"Watchdog ({watchdog}): retomando {len(pending)} URL(s) pendente(s) "
                       f"em novo processo (tentativa {restarts}).",
        })
        carry = output
        attempt_config = _resume_config(config, output, pending)

    if error is not None:
        logger.error("execution=%s falha: %s", execution_id, error)
        record["status"] = "failed"
        record["stopReason"] = "error:EngineFailure"
        record["error"] = error
    else:
        output.pop("visitedUrls", None)
        if watchdog is not None:
            output.setdefault("warnings", []).append(
                {"type": "spa_router", "message": f"Motor encerrado pelo watchdog ({watchdog}); resultado parcial."}
            )
            output["status"] = "completed"
            output["stopReason"] = watchdog
        output.setdefault("status", "completed")
        record["status"] = output["status"]
        record["output"] = output
        record.pop("partialOutput", None)
        record["stopReason"] = output.get("stopReason")
    record["endedAt"] = now_iso()
    with LOCK:
        save_execution(record)
    write_exports(record)
    if record.get("jornadaId"):
        try:
            jornadas.gravar_saida(record)
        except Exception:
            logger.exception("execution=%s falha ao gravar saída da jornada", execution_id)
    logger.info("execution=%s end status=%s", execution_id, record["status"])


def create_execution(payload: dict) -> tuple[str, dict]:
    """Valida o pedido e registra a execução (sem iniciar). Aceita jornadaId para jornadas monitoradas."""
    jornada = None
    if payload.get("jornadaId"):
        jornada = jornadas.jornada_por_id(str(payload["jornadaId"]))
        if jornada is None:
            raise ValueError("jornada não encontrada")
        payload = jornadas.config_execucao(jornada)
    urls = payload.get("urls")
    if not urls:
        urls = [{"url": payload.get("url", ""), "depth": payload.get("depth", 0),
                 "maxActions": payload.get("maxActions", payload.get("max_actions", 60)),
                 "maxStates": payload.get("maxStates", payload.get("max_states", 30)),
                 "allowedDomains": payload.get("allowedDomains"),
                 "singleUrlMode": payload.get("singleUrlMode", False)}]
    url_configs = [validate_url_config(u) for u in urls]
    template = load_template(payload.get("template", "sintetico-padrao"))
    browser_mode = payload.get("browserMode", "headless")
    config = {
        "urls": url_configs,
        "templateKeys": template["keys"],
        "singleUrlMode": False,
        "browserMode": browser_mode if browser_mode in ("headless", "visual") else "headless",
    }
    execution_id = str(uuid.uuid4())
    record = {
        "id": execution_id,
        "url": url_configs[0]["url"],
        "status": "queued",
        "createdAt": now_iso(),
        "endedAt": None,
        "config": {**config, "templateName": template["name"]},
        "progress": None,
        "output": None,
    }
    if jornada is not None:
        record["jornadaId"] = jornada["id"]
        record["jornadaNome"] = jornada["nome"]
        record["jornadaPontos"] = {
            campo: jornada.get(campo, "")
            for key, _ in jornadas.PONTOS
            for campo in (f"ponto_{key}", f"ponto_{key}_etapa", f"ponto_{key}_titulo", f"ponto_{key}_evento")
        }
    with LOCK:
        EXECUTIONS[execution_id] = record
        STOP_EVENTS[execution_id] = threading.Event()
        save_execution(record)
    return execution_id, config


def start_execution(payload: dict) -> dict:
    execution_id, config = create_execution(payload)
    threading.Thread(target=run_execution, args=(execution_id, config), daemon=True).start()
    return {"id": execution_id, "status": "queued"}


# ---------------------------------------------------------------- exportações

def _rows_of_events(output: dict) -> list[dict]:
    return output.get("events", [])


def csv_bytes(record: dict) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["timestamp", "technology", "eventName", "eventType", "status",
                     "consentState", "stateName", "url", "actionId", "parameters"])
    for e in _rows_of_events(record.get("output") or {}):
        writer.writerow([e.get("timestamp"), e.get("technology"), e.get("eventName"), e.get("eventType"),
                         e.get("status"), e.get("consentState"), e.get("stateName"), e.get("url"),
                         e.get("actionId"), json.dumps(e.get("parameters", {}), ensure_ascii=False)])
    return buffer.getvalue().encode("utf-8")


def export_bytes(record: dict, fmt: str) -> bytes:
    """Conteúdo do export gerado a partir do registro atual (nunca lido de um arquivo antigo)."""
    if fmt == "json":
        return json.dumps(record, ensure_ascii=False, indent=2).encode("utf-8")
    if fmt == "csv":
        return csv_bytes(record)
    if fmt == "html":
        return render_report(record).encode("utf-8")
    if fmt == "pdf":
        return render_pdf(record)
    raise ValueError(f"formato desconhecido: {fmt}")


def write_exports(record: dict) -> None:
    if not EXPORTS_ENABLED:
        return
    eid = record["id"]
    for fmt in ("json", "csv", "html", "pdf"):
        (EXPORT_DIR / f"execution-{eid}.{fmt}").write_bytes(export_bytes(record, fmt))


NON_TAG_TECHNOLOGIES = ("custom", "unclassified_tracker")


def _pixel_summary(output: dict) -> list[tuple[str, int, int]]:
    """Por tecnologia de tag: (tecnologia, eventos observados, estados distintos onde apareceu)."""
    totals: dict[str, int] = {}
    states: dict[str, set] = {}
    for e in output.get("events", []):
        technology = e.get("technology") or ""
        if not technology or technology in NON_TAG_TECHNOLOGIES:
            continue
        totals[technology] = totals.get(technology, 0) + 1
        states.setdefault(technology, set()).add(e.get("stateName") or "")
    return sorted(((tech, totals[tech], len(states[tech])) for tech in totals), key=lambda row: -row[1])


def _summary_lines(record: dict) -> list[str]:
    output = record.get("output") or {}
    events = output.get("events", [])
    return [
        "Crawler Tag - Relatorio de auditoria",
        f"Status: {record.get('status')}",
        f"URL inicial: {record.get('url')}",
        f"Estados: {output.get('statesDiscovered', 0)}  Acoes: {len(output.get('actions', []))}  Eventos: {len(events)}",
        f"Parada: {record.get('stopReason') or ''}",
        "",
        "Pixels e tags detectados (tecnologia: eventos em estados):",
        *[f"{tech}: {count} {'evento' if count == 1 else 'eventos'} em {states} {'nome' if states == 1 else 'nomes'} de estado" for tech, count, states in _pixel_summary(output)],
        *([] if _pixel_summary(output) else ["nenhum pixel ou tag de terceiros detectado"]),
    ]


def render_report(record: dict) -> str:
    output = record.get("output") or {}
    rows = "".join(
        "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>".format(
            html.escape(str(e.get("technology", ""))), html.escape(str(e.get("eventName", ""))),
            html.escape(str(e.get("stateName", ""))), html.escape(str(e.get("eventType", ""))))
        for e in output.get("events", []))
    warnings = "".join(f"<li>{html.escape(w.get('message', ''))}</li>" for w in output.get("warnings", []))
    ignored = "".join(
        f"<tr><td>{html.escape(str(f.get('fieldName', '')))}</td><td>{html.escape(str(f.get('reason', '')))}</td></tr>"
        for f in output.get("ignoredFields", []))
    shots = "".join(
        f'<figure><img src="{v}" style="max-width:320px;border:1px solid #ccc"><figcaption>{html.escape(k)}</figcaption></figure>'
        for k, v in (output.get("stateScreenshots") or {}).items())
    pixels = "".join(
        f"<tr><td>{html.escape(tech)}</td><td>{count}</td><td>{states}</td></tr>"
        for tech, count, states in _pixel_summary(output))
    return (
        "<!doctype html><meta charset='utf-8'><title>Crawler Tag report</title>"
        "<style>body{font:14px Arial;margin:24px}table{border-collapse:collapse;margin-bottom:20px}"
        "td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}</style>"
        "<h1>Relatorio de auditoria</h1>"
        f"<p>Status: {html.escape(str(record.get('status')))}</p>"
        f"<p>URL inicial: {html.escape(str(record.get('url')))}</p>"
        f"<p>Estados: {output.get('statesDiscovered', 0)} | Acoes: {len(output.get('actions', []))} | "
        f"Eventos: {len(output.get('events', []))}</p>"
        f"<p>Parada: {html.escape(str(record.get('stopReason') or ''))}</p>"
        "<h2>Pixels e tags detectados</h2><table><tr><th>Tecnologia</th><th>Eventos</th><th>Estados</th></tr>"
        f"{pixels}</table>"
        "<h2>Eventos</h2><table><tr><th>Tecnologia</th><th>Evento</th><th>Estado</th><th>Tipo</th></tr>"
        f"{rows}</table>"
        "<h2>Campos ignorados</h2><table><tr><th>Campo</th><th>Motivo</th></tr>"
        f"{ignored}</table>"
        f"<h2>Avisos</h2><ul>{warnings}</ul>"
        f"<h2>Capturas por estado</h2>{shots}"
    )


PDF_LINES_PER_PAGE = 46


def render_pdf(record: dict) -> bytes:
    """PDF de texto com várias páginas (Helvetica, Letter), sem dependências externas."""
    lines = [line[:110] for line in _summary_lines(record)]
    pages = [lines[i:i + PDF_LINES_PER_PAGE] for i in range(0, len(lines), PDF_LINES_PER_PAGE)] or [[]]
    count = len(pages)
    kids = " ".join(f"{4 + 2 * i} 0 R" for i in range(count))
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {count} >>".encode(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for index, page_lines in enumerate(pages):
        body = "BT /F1 11 Tf 50 780 Td " + " ".join(
            f"({_pdf_escape(line)}) Tj 0 -16 Td" for line in page_lines) + " ET"
        content_number = 5 + 2 * index
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> "
            f"/Contents {content_number} 0 R >>".encode())
        stream = body.encode("latin-1", "replace")
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream")
    output = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, obj in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    output.extend("".join(f"{offset:010d} 00000 n \n" for offset in offsets).encode())
    output.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(output)


def _pdf_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)").encode("latin-1", "replace").decode("latin-1")


# ---------------------------------------------------------------- interface

PAGE = """<!doctype html><meta charset="utf-8"><title>Crawler Tag - Jornadas</title>
<style>body{font:15px Arial;max-width:1000px;margin:24px auto;padding:0 16px}
label{display:block;margin-top:8px}input,select,textarea{padding:6px;margin-top:2px;box-sizing:border-box}
input[type=text],input[type=number],select,textarea{width:100%}button{padding:8px 12px;margin:10px 6px 0 0}
pre{background:#f3f3f3;padding:12px;white-space:pre-wrap;max-height:300px;overflow:auto}
table{border-collapse:collapse;width:100%;margin-top:8px;font-size:13px}td,th{border:1px solid #ccc;padding:5px;text-align:left;vertical-align:top}
th{background:#f0f0f0}.row{display:flex;gap:12px;flex-wrap:wrap}.row>label{flex:1;min-width:130px}
.msg{color:#a00}.ok{color:#060}.muted{color:#666;font-size:13px}a{margin-right:8px}</style>
<h1>Crawler Tag - monitoramento de jornadas</h1>
<p class="muted">Configuração: <code>config/jornadas.csv</code> (abre no Excel). Saídas por execução: <code>saidas/&lt;jornada&gt;/</code>, com resumo em <code>saidas/resumo.csv</code>.</p>

<h2>Jornadas monitoradas</h2>
<table id="jornadas"><tr><td>Carregando...</td></tr></table>
<h3 id="form-title">Nova jornada</h3>
<form id="jform">
<div class="row">
<label>Identificador (ex.: seguro-viagem)<input type="text" id="j-id" required></label>
<label>Nome<input type="text" id="j-nome"></label>
</div>
<label>URL inicial<input type="text" id="j-url" required></label>
<div class="row">
<label>Profundidade (0 a 5)<input type="number" id="j-profundidade" value="0" min="0" max="5"></label>
<label>Máx. estados<input type="number" id="j-estados" value="12" min="1"></label>
<label>Máx. ações<input type="number" id="j-acoes" value="120" min="1"></label>
<label>Intervalo entre execuções (horas)<input type="text" id="j-intervalo" value="6"></label>
</div>
<label>Domínios permitidos (separados por vírgula, vazio = domínio da URL)<input type="text" id="j-dominios"></label>
<h4>Pontos de medição do pixel Meta (URL de cada ponto que a jornada deve passar; vazio = não medido)</h4>
<p class="muted">Cada ponto é uma URL e, para separar telas na mesma URL, um critério combinado: <b>etapa</b> (passo visível, ex.: <code>3 de 3</code>),
<b>título</b> da tela (ex.: <code>Informe seus dados</code>) e, se quiser, o <b>evento Meta esperado</b> (ex.: <code>Lead</code>). Os campos preenchidos valem juntos.
Se o critério não for encontrado, o ponto fica como <b>critério não localizado</b> e o arquivo de <b>Estados</b> traz a jornada completa em ordem, com os eventos de cada tela, para ajustar o cadastro.
Dois pontos com a mesma URL e o mesmo critério aparecem como <b>indistinguivel</b>.</p>
<div class="row"><label>PDP (página de produto)<input type="text" id="j-pdp"></label>
<label>Etapa<input type="text" id="j-pdp_etapa"></label>
<label>Título da tela<input type="text" id="j-pdp_titulo"></label>
<label>Evento Meta<input type="text" id="j-pdp_evento"></label></div>
<div class="row"><label>Shortform<input type="text" id="j-shortform"></label>
<label>Etapa<input type="text" id="j-shortform_etapa"></label>
<label>Título da tela<input type="text" id="j-shortform_titulo"></label>
<label>Evento Meta<input type="text" id="j-shortform_evento"></label></div>
<div class="row"><label>Lead intent<input type="text" id="j-lead_intent"></label>
<label>Etapa<input type="text" id="j-lead_intent_etapa"></label>
<label>Título da tela<input type="text" id="j-lead_intent_titulo"></label>
<label>Evento Meta<input type="text" id="j-lead_intent_evento"></label></div>
<div class="row">
<label>Template de preenchimento<select id="j-template"></select></label>
<label>Navegador<select id="j-navegador"><option value="headless">headless</option><option value="visual">visual</option></select></label>
</div>
<label><input type="checkbox" id="j-unica"> Modo URL única (explora só esta página e seus CTAs)</label>
<label><input type="checkbox" id="j-ativo" checked> Ativa (entra na execução automática)</label>
<label>Observações<textarea id="j-obs" rows="2"></textarea></label>
<button>Salvar jornada</button><button type="button" id="j-novo">Nova</button>
<p id="jmsg"></p>
</form>

<h2>Resultados</h2>
<label>Mostrar jornada<select id="filtro"><option value="">Todas</option></select></label>
<table id="resumo"><tr><td>Sem execuções ainda.</td></tr></table>

<h2>Execução avulsa</h2>
<form id="form">
<label>URL inicial<input type="text" id="url" value="https://www.portoseguro.com.br/servicos" required></label>
<div class="row">
<label>Profundidade<input type="number" id="depth" value="1" min="0" max="5"></label>
<label>Máx. estados<input type="number" id="states" value="30" min="1" max="10000"></label>
<label>Máx. ações<input type="number" id="actions" value="60" min="1" max="10000"></label>
</div>
<label><input type="checkbox" id="single"> Modo URL única</label>
<button>Executar</button> <button type="button" id="stop">Interromper</button>
</form>
<pre id="output">Pronto.</pre>

<script>
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\\'':'&#39;'}[c]));
let timer = null, currentId = null, jornadasCache = [];

fetch('/api/templates').then(r => r.json()).then(list => {
  $('#j-template').innerHTML = list.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
});

function limparForm() {
  $('#form-title').textContent = 'Nova jornada';
  ['#j-id', '#j-nome', '#j-url', '#j-dominios', '#j-obs'].forEach(s => $(s).value = '');
  ['pdp', 'shortform', 'lead_intent'].forEach(k => ['', '_etapa', '_titulo', '_evento'].forEach(s => $('#j-' + k + s).value = ''));
  $('#j-id').disabled = false;
  $('#j-profundidade').value = 0; $('#j-estados').value = 12; $('#j-acoes').value = 120; $('#j-intervalo').value = 6;
  $('#j-navegador').value = 'headless'; $('#j-unica').checked = false; $('#j-ativo').checked = true;
  $('#jmsg').textContent = '';
}

function editar(jid) {
  const j = jornadasCache.find(x => x.id === jid);
  if (!j) return;
  $('#form-title').textContent = 'Editar jornada: ' + jid;
  $('#j-id').value = j.id; $('#j-id').disabled = true; $('#j-nome').value = j.nome; $('#j-url').value = j.url;
  $('#j-profundidade').value = j.profundidade; $('#j-estados').value = j.max_estados; $('#j-acoes').value = j.max_acoes;
  $('#j-intervalo').value = j.intervalo_horas; $('#j-dominios').value = (j.dominios || '').replace(/\\|/g, ', ');
  $('#j-template').value = j.template; $('#j-navegador').value = j.navegador;
  $('#j-unica').checked = j.url_unica_bool; $('#j-ativo').checked = j.ativo_bool; $('#j-obs').value = j.observacoes || '';
  ['pdp', 'shortform', 'lead_intent'].forEach(k => {
    $('#j-' + k).value = j['ponto_' + k] || '';
    ['_etapa', '_titulo', '_evento'].forEach(s => $('#j-' + k + s).value = j['ponto_' + k + s] || '');
  });
  window.scrollTo(0, 0);
}

async function carregarJornadas() {
  jornadasCache = await (await fetch('/api/jornadas')).json();
  const linhas = jornadasCache.map(j => `<tr>
    <td><b>${esc(j.id)}</b><br><span class="muted">${esc(j.nome)}</span></td>
    <td><a href="${esc(j.url)}" target="_blank">${esc(j.url)}</a></td>
    <td>${j.ativo_bool ? 'sim' : 'não'}</td><td>${esc(j.intervalo_horas)} h</td>
    <td>${esc(j.profundidade)} / ${esc(j.max_estados)} / ${esc(j.max_acoes)}${j.url_unica_bool ? ' (URL única)' : ''}</td>
    <td><button onclick="editar('${esc(j.id)}')">Editar</button>
        <button onclick="executar('${esc(j.id)}')">Executar agora</button></td></tr>`).join('');
  $('#jornadas').innerHTML = jornadasCache.length
    ? '<tr><th>Jornada</th><th>URL</th><th>Ativa</th><th>Intervalo</th><th>Prof. / estados / ações</th><th></th></tr>' + linhas
    : '<tr><td>Nenhuma jornada cadastrada. Preencha o formulário abaixo.</td></tr>';
  const atual = $('#filtro').value;
  $('#filtro').innerHTML = '<option value="">Todas</option>' +
    jornadasCache.map(j => `<option value="${esc(j.id)}">${esc(j.id)}</option>`).join('');
  $('#filtro').value = atual;
}

function pontoTexto(status, url, chave, criterio, eventos) {
  if (!url) return '';
  const nome = {pdp: 'PDP', shortform: 'Shortform', lead_intent: 'Lead intent'}[chave];
  const rotulo = {disparou: 'disparou', missing: 'NÃO disparou (alcançado)', blocked: 'bloqueado antes do ponto',
                  not_reached: 'não alcançado', indistinguivel: 'INDISTINGUÍVEL (mesma URL e critério)',
                  criterio_nao_localizado: 'critério não localizado (veja Estados)'}[status] || status;
  const cor = status === 'disparou' ? 'ok' : (['missing', 'indistinguivel', 'criterio_nao_localizado'].includes(status) ? 'msg' : 'muted');
  const extra = (criterio ? ' [' + criterio + ']' : '') + (eventos ? ' x' + eventos : '');
  return `<span class="${cor}">${esc(nome)}${esc(extra)}: ${esc(rotulo)}</span>`;
}

async function carregarResumo() {
  const jid = $('#filtro').value;
  const rows = await (await fetch('/api/resumo' + (jid ? '?jornada=' + encodeURIComponent(jid) : ''))).json();
  if (!rows.length) { $('#resumo').innerHTML = '<tr><td>Sem execuções ainda.</td></tr>'; return; }
  $('#resumo').innerHTML = '<tr><th>Data e hora</th><th>Jornada</th><th>Status</th><th>Estados</th><th>Ações</th>' +
    '<th>Eventos</th><th>Preench.</th><th>Novas tecnologias</th><th>Ausentes</th><th>Pontos Meta</th><th>Parada</th><th>Arquivos</th></tr>' +
    rows.map(r => `<tr><td>${esc(r.data_hora)}</td><td>${esc(r.jornada_id)}</td><td>${esc(r.status)}</td>
      <td>${esc(r.estados)}</td><td>${esc(r.acoes)}</td><td>${esc(r.eventos)}</td><td>${esc(r.preenchimentos)}</td>
      <td class="ok">${esc(r.tecnologias_novas)}</td><td class="msg">${esc(r.tecnologias_ausentes)}</td>
      <td>${['pdp', 'shortform', 'lead_intent'].map(k => pontoTexto(r['ponto_' + k + '_meta'], r['ponto_' + k + '_url'], k, [r['ponto_' + k + '_etapa'], r['ponto_' + k + '_titulo'], r['ponto_' + k + '_evento']].filter(Boolean).join(' + '), r['ponto_' + k + '_eventos'])).join('<br>')}</td>
      <td>${esc(r.parada)}</td>
      <td><a href="/api/saidas/${esc(r.execucao_id)}/csv">Eventos</a><a href="/api/saidas/${esc(r.execucao_id)}/estados">Estados</a><a href="/api/saidas/${esc(r.execucao_id)}/pontos">Pontos</a><a href="/api/saidas/${esc(r.execucao_id)}/json">JSON</a></td></tr>`).join('');
}

$('#jform').onsubmit = async (e) => {
  e.preventDefault();
  const body = {
    id: $('#j-id').value, nome: $('#j-nome').value, url: $('#j-url').value,
    profundidade: $('#j-profundidade').value, max_estados: $('#j-estados').value, max_acoes: $('#j-acoes').value,
    dominios: $('#j-dominios').value, template: $('#j-template').value, navegador: $('#j-navegador').value,
    url_unica: $('#j-unica').checked, ativo: $('#j-ativo').checked, intervalo_horas: $('#j-intervalo').value,
    observacoes: $('#j-obs').value,
    ponto_pdp: $('#j-pdp').value, ponto_shortform: $('#j-shortform').value, ponto_lead_intent: $('#j-lead_intent').value,
  };
  ['pdp', 'shortform', 'lead_intent'].forEach(k => ['_etapa', '_titulo', '_evento'].forEach(s => { body['ponto_' + k + s] = $('#j-' + k + s).value; }));
  const r = await fetch('/api/jornadas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const x = await r.json();
  if (!r.ok) { $('#jmsg').className = 'msg'; $('#jmsg').textContent = x.error; return; }
  $('#jmsg').className = 'ok'; $('#jmsg').textContent = 'Jornada salva: ' + x.id;
  limparForm(); await carregarJornadas();
};
$('#j-novo').onclick = limparForm;
$('#filtro').onchange = carregarResumo;

async function executar(jid) {
  const r = await fetch('/api/jornadas/' + encodeURIComponent(jid) + '/executar', { method: 'POST' });
  const x = await r.json();
  if (!r.ok) { alert(x.error); return; }
  track(x.id, 'Jornada ' + jid);
}

function track(id, titulo) {
  currentId = id; clearInterval(timer);
  timer = setInterval(async () => {
    const s = await (await fetch('/api/executions/' + id)).json();
    $('#output').textContent = JSON.stringify({ titulo, id: s.id, status: s.status, stopReason: s.stopReason, progress: s.progress }, null, 2);
    if (['completed', 'failed', 'paused'].includes(s.status)) {
      clearInterval(timer);
      carregarResumo();
      $('#output').innerHTML += `\n\n<a href="/api/executions/${id}/export?format=csv">CSV (Excel)</a>` +
        `<a href="/api/executions/${id}/export?format=json">JSON</a>` +
        `<a href="/api/executions/${id}/report">Relatório</a>`;
    }
  }, 1000);
}

$('#form').onsubmit = async (e) => {
  e.preventDefault();
  const payload = { urls: [{ url: $('#url').value, depth: +$('#depth').value, maxStates: +$('#states').value,
             maxActions: +$('#actions').value, singleUrlMode: $('#single').checked }],
    template: 'sintetico-padrao', browserMode: 'headless' };
  $('#output').textContent = 'Iniciando...';
  const r = await fetch('/api/executions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const x = await r.json();
  if (!r.ok) { $('#output').textContent = x.error; return; }
  track(x.id, 'Execução avulsa');
};
$('#stop').onclick = () => { if (currentId) fetch(`/api/executions/${currentId}/stop`, { method: 'POST' }); };

carregarJornadas().then(carregarResumo);
</script>
"""


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: bytes, content_type: str, headers: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload: object, status: int = 200) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/":
            self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")
            return
        if path == "/api/templates":
            self._json(list_templates())
            return
        if path == "/api/executions":
            self._json(list_executions())
            return
        if path == "/api/jornadas":
            self._json(jornadas.listar_jornadas())
            return
        if path == "/api/resumo":
            jid = parse_qs(parsed.query).get("jornada", [None])[0]
            self._json(jornadas.ler_resumo(jornada_id=jid))
            return
        saida = re.fullmatch(r"/api/saidas/([a-f0-9-]+)/(csv|json|estados|pontos)", path)
        if saida:
            self._send_saida(saida.group(1), saida.group(2))
            return
        match = re.fullmatch(r"/api/executions/([a-f0-9-]+)(?:/(report|export|stop))?", path)
        if not match:
            self._json({"error": "not_found"}, 404)
            return
        record = load_execution(match.group(1))
        if record is None:
            self._json({"error": "execution_not_found"}, 404)
            return
        action = match.group(2)
        if action is None:
            self._json(record)
            return
        if not EXPORTS_ENABLED and action in ("report", "export"):
            self._json({"error": "exports_disabled", "hint": "defina CRAWLER_EXPORTS=1"}, 404)
            return
        if action == "report":
            self._send(200, render_report(record).encode("utf-8"), "text/html; charset=utf-8")
            return
        if action == "stop":
            self._json({"error": "use POST"}, 405)
            return
        fmt = parse_qs(parsed.query).get("format", [""])[0]
        content_types = {"json": "application/json", "csv": "text/csv; charset=utf-8", "pdf": "application/pdf"}
        if fmt not in content_types:
            self._json({"error": "format must be json, csv or pdf"}, 400)
            return
        self._send(200, export_bytes(record, fmt), content_types[fmt],
                   {"Content-Disposition": f'attachment; filename="execution-{record["id"]}.{fmt}"'})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        stop_match = re.fullmatch(r"/api/executions/([a-f0-9-]+)/stop", path)
        if stop_match:
            event = STOP_EVENTS.get(stop_match.group(1))
            if event is None:
                self._json({"error": "execution_not_found"}, 404)
                return
            event.set()
            self._json({"id": stop_match.group(1), "stopRequested": True})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            if path == "/api/jornadas":
                self._json(jornadas.salvar_jornada(payload), 200)
                return
            run = re.fullmatch(r"/api/jornadas/([a-z0-9-]+)/executar", path)
            if run:
                self._json(start_execution({"jornadaId": run.group(1)}), 201)
                return
            if path != "/api/executions":
                self._json({"error": "not_found"}, 404)
                return
            self._json(start_execution(payload), 201)
        except Exception as error:
            logger.warning("invalid request %s: %s", path, error)
            self._json({"error": str(error)}, 400)

    def _send_saida(self, execution_id: str, fmt: str) -> None:
        """Baixa o CSV de eventos ou o JSON de uma execução de jornada (só dentro de saidas/)."""
        rows = [r for r in jornadas.ler_resumo() if r.get("execucao_id") == execution_id]
        if not rows:
            self._json({"error": "saida_nao_encontrada"}, 404)
            return
        relative = rows[0].get({"csv": "arquivo_csv", "json": "arquivo_json", "estados": "arquivo_estados",
                                "pontos": "arquivo_pontos"}[fmt]) or ""
        target = (ROOT / relative).resolve() if relative else ROOT
        if not relative:
            self._json({"error": "saida_nao_encontrada"}, 404)
            return
        if jornadas.SAIDAS_DIR.resolve() not in target.parents or not target.exists():
            self._json({"error": "saida_nao_encontrada"}, 404)
            return
        content_type = "application/json; charset=utf-8" if fmt == "json" else "text/csv; charset=utf-8"
        self._send(200, target.read_bytes(), content_type,
                   {"Content-Disposition": f'attachment; filename="{target.name}"'})

    def log_message(self, format: str, *args: object) -> None:
        logger.info("http " + format, *args)


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
