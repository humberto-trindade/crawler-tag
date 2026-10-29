"""Jornadas monitoradas: configuração em CSV e saídas estruturadas por execução.

- config/jornadas.csv: uma linha por jornada (URL e parâmetros). Lido a cada execução.
- saidas/<jornada_id>/<data_hora>_<execucao>.csv|json: uma pasta por jornada, um arquivo por execução.
- saidas/resumo.csv: uma linha por execução, com comparação com a execução anterior da mesma jornada.

CSV com ';' e UTF-8 com BOM: abre direto no Excel em português. Leitura aceita ';' ou ','.
"""

from __future__ import annotations

import csv
import io
import json
import re
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from estados import (
    estados_por_passo, normalizar_etapa, normalizar_url, partes_estado, reatribuir_estados, tela_corresponde,
)

ROOT = Path(__file__).resolve().parent
CONFIG_DIR = ROOT / "config"
JORNADAS_PATH = CONFIG_DIR / "jornadas.csv"
SAIDAS_DIR = ROOT / "saidas"
RESUMO_PATH = SAIDAS_DIR / "resumo.csv"

JORNADA_COLUMNS = [
    "id", "nome", "url", "profundidade", "max_estados", "max_acoes", "dominios",
    "template", "navegador", "url_unica", "ativo", "intervalo_horas", "observacoes",
    "ponto_pdp", "ponto_shortform", "ponto_lead_intent",
    "ponto_pdp_etapa", "ponto_shortform_etapa", "ponto_lead_intent_etapa",
    "ponto_pdp_titulo", "ponto_shortform_titulo", "ponto_lead_intent_titulo",
    "ponto_pdp_evento", "ponto_shortform_evento", "ponto_lead_intent_evento",
    "ponto_compra",
]
# Pontos de medição do pixel Meta: (chave, rótulo). Compras fica fora do escopo (após o pagamento).
PONTOS = [("pdp", "PDP"), ("shortform", "Shortform"), ("lead_intent", "Lead intent")]
RESUMO_COLUMNS = [
    "data_hora", "jornada_id", "nome", "url", "execucao_id", "status", "parada", "estados", "acoes",
    "eventos", "preenchimentos", "paginas", "pixels", "tecnologias_novas", "tecnologias_ausentes",
    "avisos", "estados_distintos", "arquivo_csv", "arquivo_json", "arquivo_estados", "arquivo_pontos",
    "ponto_pdp_url", "ponto_pdp_etapa", "ponto_pdp_titulo", "ponto_pdp_evento", "ponto_pdp_meta",
    "ponto_pdp_eventos",
    "ponto_shortform_url", "ponto_shortform_etapa", "ponto_shortform_titulo", "ponto_shortform_evento",
    "ponto_shortform_meta", "ponto_shortform_eventos",
    "ponto_lead_intent_url", "ponto_lead_intent_etapa", "ponto_lead_intent_titulo", "ponto_lead_intent_evento",
    "ponto_lead_intent_meta", "ponto_lead_intent_eventos",
]
EVENTO_COLUMNS = [
    "timestamp_evento", "jornada_id", "estado", "passo", "url", "tipo_evento", "tecnologia", "nome_evento",
    "status", "consentimento", "parametros",
]
ESTADO_COLUMNS = ["ordem", "url", "estado", "passo", "eventos", "eventos_meta", "nomes_meta", "tecnologias", "ponto"]
# Status de cada ponto (taxonomia do plano: docs/progress.md, 2026-09-17):
#   disparou, missing (alcançado sem pixel Meta), blocked (execução bloqueada antes), not_reached,
#   indistinguivel (dois pontos com a mesma URL e o mesmo critério: a configuração não separa os dois),
#   criterio_nao_localizado (a URL foi alcançada, mas nenhuma tela atende à etapa/título informado:
#   cadastro ou critério a revisar; não indica pixel quebrado).
NON_TAG_TECHNOLOGIES = ("custom", "unclassified_tracker", "")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")
TIMESTAMP_FORMAT = "%Y-%m-%d %H:%M:%S"


# ---------------------------------------------------------------- CSV

def _sniff_delimiter(text: str) -> str:
    first_line = text.splitlines()[0] if text.strip() else ""
    return ";" if first_line.count(";") >= first_line.count(",") else ","


def _read_csv(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    if not path.exists():
        return JORNADA_COLUMNS, []
    text = path.read_text(encoding="utf-8-sig")
    reader = csv.DictReader(io.StringIO(text), delimiter=_sniff_delimiter(text))
    rows = [{key.strip(): (value or "").strip() for key, value in row.items() if key} for row in reader]
    return list(reader.fieldnames or []), rows


def _write_csv(path: Path, columns: list[str], rows: list[dict[str, Any]]) -> None:
    """Escrita atômica: grava em arquivo temporário e troca no fim, para não corromper a configuração."""
    path.parent.mkdir(parents=True, exist_ok=True)
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=columns, delimiter=";", extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow({column: row.get(column, "") for column in columns})
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(buffer.getvalue(), encoding="utf-8-sig", newline="")
    temp.replace(path)


def _append_csv(path: Path, columns: list[str], row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        old_columns, old_rows = _read_csv(path)
        if old_columns != columns:
            # cabeçalho mudou (nova versão): reescreve preservando as linhas antigas
            _write_csv(path, columns, old_rows)
    is_new = not path.exists()
    with path.open("a", encoding="utf-8-sig" if is_new else "utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=columns, delimiter=";", extrasaction="ignore")
        if is_new:
            writer.writeheader()
        writer.writerow({column: row.get(column, "") for column in columns})


# ---------------------------------------------------------------- jornadas

def validate_jornada(raw: dict[str, Any]) -> dict[str, str]:
    """Normaliza e valida uma jornada. Lança ValueError com mensagem em português."""
    jid = str(raw.get("id", "")).strip().lower()
    if not ID_RE.match(jid):
        raise ValueError("id: use letras minúsculas, números e hífen (2 a 41 caracteres)")
    url = str(raw.get("url", "")).strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError(f"url inválida para {jid}: use http ou https")
    nome = str(raw.get("nome", "")).strip() or jid
    numbers = {}
    for field, low, high, default in (
        ("profundidade", 0, 5, 1), ("max_estados", 1, 10_000, 30), ("max_acoes", 1, 10_000, 60),
    ):
        raw_value = raw.get(field)
        value = str(default if raw_value in (None, "") else raw_value).strip()
        try:
            number = int(value)
        except ValueError:
            raise ValueError(f"{field} deve ser um número inteiro ({jid})")
        if not low <= number <= high:
            raise ValueError(f"{field} deve estar entre {low} e {high} ({jid})")
        numbers[field] = str(number)
    dominios = [d.strip() for d in re.split(r"[|,]", str(raw.get("dominios", "") or "")) if d.strip()]
    navegador = str(raw.get("navegador", "") or "headless").strip()
    if navegador not in ("headless", "visual"):
        raise ValueError(f"navegador deve ser headless ou visual ({jid})")
    try:
        intervalo = float(str(raw.get("intervalo_horas", "") or "24").replace(",", "."))
    except ValueError:
        raise ValueError(f"intervalo_horas deve ser um número ({jid})")
    if not 0.25 <= intervalo <= 24 * 31:
        raise ValueError(f"intervalo_horas deve estar entre 0,25 e 744 ({jid})")
    return {
        "id": jid,
        "nome": nome,
        "url": url,
        "profundidade": numbers["profundidade"],
        "max_estados": numbers["max_estados"],
        "max_acoes": numbers["max_acoes"],
        "dominios": "|".join(dominios),
        "template": str(raw.get("template", "") or "sintetico-padrao").strip(),
        "navegador": navegador,
        "url_unica": "sim" if _as_bool(raw.get("url_unica")) else "nao",
        "ativo": "sim" if _as_bool(raw.get("ativo", True)) else "nao",
        "intervalo_horas": f"{intervalo:g}".replace(".", ","),
        "observacoes": str(raw.get("observacoes", "") or "").strip(),
        **_pontos_normalizados(raw),
        "ponto_compra": _url_de_compra(raw),
    }


def _url_de_compra(raw: dict[str, Any]) -> str:
    """URL em que o avanço é a compra: não é medida; o crawler preenche, mas não clica em avançar nela."""
    url = str(raw.get("ponto_compra", "") or "").strip()
    if url:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError("ponto Compra: use uma URL http ou https")
    return url


def _pontos_normalizados(raw: dict[str, Any]) -> dict[str, str]:
    """URLs dos pontos de medição (PDP, shortform, lead intent). Opcional: vazio = não medido."""
    result = {}
    for key, label in PONTOS:
        url = str(raw.get(f"ponto_{key}", "") or "").strip()
        if url:
            parsed = urlparse(url)
            if parsed.scheme not in ("http", "https") or not parsed.hostname:
                raise ValueError(f"ponto {label}: use uma URL http ou https")
        result[f"ponto_{key}"] = url
        # etapa opcional: texto do passo (ex.: "1 de 3") que precisa aparecer na tela para contar como medido
        result[f"ponto_{key}_etapa"] = str(raw.get(f"ponto_{key}_etapa", "") or "").strip()
        # critério combinado (E): título da tela e evento Meta esperado (ex.: Lead), opcionais
        result[f"ponto_{key}_titulo"] = str(raw.get(f"ponto_{key}_titulo", "") or "").strip()
        result[f"ponto_{key}_evento"] = str(raw.get(f"ponto_{key}_evento", "") or "").strip()
    return result


def _bloqueio_detectado(output: dict[str, Any]) -> bool:
    """A execução foi barrada (clique sem efeito, WAF/CAPTCHA, watchdog): pontos não alcançados são 'blocked'."""
    if str(output.get("stopReason") or "").startswith("watchdog"):
        return True
    for aviso in output.get("warnings", []):
        if aviso.get("type") in ("captcha", "navigation_blocked") or str(aviso.get("message", "")).startswith("Clique sem efeito"):
            return True
    return False


def verificar_pontos(output: dict[str, Any], pontos: dict[str, str]) -> list[dict[str, Any]]:
    """Para cada ponto (URL + etapa opcional): foi alcançado? o pixel Meta disparou nele?

    Status: disparou, missing (alcançado, sem pixel Meta), blocked (não alcançado e a execução foi
    barrada), not_reached (não alcançado, sem bloqueio), indistinguivel (outro ponto tem a mesma URL
    e a mesma etapa) ou vazio (ponto não configurado). Bloqueio e ponto não alcançado nunca viram
    'missing': não indicam pixel quebrado.
    """
    eventos = output.get("events", [])
    bloqueio = _bloqueio_detectado(output)
    estados = estados_por_passo(eventos, output.get("telasVisitadas"))
    configurados = []
    for key, label in PONTOS:
        configurados.append({
            "chave": key, "ponto": label, "url": pontos.get(f"ponto_{key}", ""),
            "etapa": normalizar_etapa(pontos.get(f"ponto_{key}_etapa", "")),
            "titulo": _texto(pontos.get(f"ponto_{key}_titulo", "")),
            "evento": _texto(pontos.get(f"ponto_{key}_evento", "")),
        })
    regras = Counter((normalizar_url(c["url"]), c["etapa"], c["titulo"]) for c in configurados if c["url"])

    resultado = []
    for c in configurados:
        base = {"ponto": c["ponto"], "chave": c["chave"], "url": c["url"], "etapa": c["etapa"],
                "titulo": c["titulo"], "evento": c["evento"], "tela": "", "eventos_meta": 0, "detalhe": ""}
        if not c["url"]:
            resultado.append({**base, "status": ""})
            continue
        alvo = normalizar_url(c["url"])
        criterio = bool(c["etapa"] or c["titulo"])
        da_url = [r for r in estados if r["url"] and normalizar_url(r["url"]) == alvo]
        # com critério, só conta tela que o prova (rótulo/passo); sem critério, qualquer tela da URL
        achadas = [r for r in da_url if tela_corresponde(r, c["etapa"], c["titulo"]) and (not criterio or r["estado"] or r["passo"])]
        meta = sum(r["eventos_meta"] for r in achadas)
        alcancada = bool(achadas)
        if not criterio:
            alcancada = alcancada or any(normalizar_url(a["url"]) == alvo
                                         for a in output.get("actions", []) if a.get("url"))
        detalhe = ""
        evento_ok = True
        if c["evento"]:
            nomes = {n.lower() for r in achadas for n in r["nomes_meta"].split(";") if n}
            evento_ok = c["evento"] in nomes
        if regras[(alvo, c["etapa"], c["titulo"])] > 1:
            status = "indistinguivel"
            detalhe = "mesma URL e mesmo critério de outro ponto: informe etapa (ex.: 3 de 3) ou título da tela para separar"
        elif meta and evento_ok:
            status = "disparou"
        elif alcancada:
            status = "missing"
            if meta and not evento_ok:
                vistos_meta = ";".join(sorted({n for r in achadas for n in r["nomes_meta"].split(";") if n}))
                detalhe = f"tela localizada, mas o evento esperado '{c['evento']}' não disparou; Meta na tela: {vistos_meta}"
        elif criterio and da_url:
            status = "criterio_nao_localizado"
        elif bloqueio:
            status = "blocked"
        else:
            status = "not_reached"
        if criterio and not alcancada:
            vistas = [f"{r['estado'] or '(sem rótulo)'}{' [' + r['passo'] + ']' if r['passo'] else ''} meta={r['eventos_meta']}"
                      for r in da_url]
            if vistas:
                detalhe = ("a etapa/título informado não apareceu nessa URL; estados vistos: " + " | ".join(vistas)
                           + " (jornada completa em ordem no arquivo de estados)")
        if achadas:
            primeira = achadas[0]
            base["tela"] = f"{primeira['ordem']}. {primeira['estado'] or primeira['url']}" + (
                f" [{primeira['passo']}]" if primeira["passo"] else "")
        resultado.append({**base, "status": status, "eventos_meta": meta, "detalhe": detalhe})
    return resultado


def _texto(valor: Any) -> str:
    return re.sub(r"\s+", " ", str(valor or "").strip().lower())


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in ("1", "sim", "s", "true", "yes", "on")


def listar_jornadas(path: Path | None = None) -> list[dict[str, Any]]:
    _, rows = _read_csv(path or JORNADAS_PATH)
    result = []
    for row in rows:
        if not row.get("id"):
            continue
        item = dict(row)
        item["ativo_bool"] = _as_bool(row.get("ativo"))
        item["url_unica_bool"] = _as_bool(row.get("url_unica"))
        result.append(item)
    return result


def salvar_jornada(raw: dict[str, Any], path: Path | None = None) -> dict[str, str]:
    """Cria ou altera uma jornada (pelo id). Retorna a linha normalizada gravada."""
    path = path or JORNADAS_PATH
    normalized = validate_jornada(raw)
    _, rows = _read_csv(path)
    rows = [row for row in rows if row.get("id")]
    replaced = False
    for index, row in enumerate(rows):
        if row.get("id") == normalized["id"]:
            rows[index] = normalized
            replaced = True
    if not replaced:
        rows.append(normalized)
    _write_csv(path, JORNADA_COLUMNS, rows)
    return normalized


def jornada_por_id(jid: str, path: Path | None = None) -> dict[str, Any] | None:
    for item in listar_jornadas(path):
        if item["id"] == jid:
            return item
    return None


def config_execucao(jornada: dict[str, Any]) -> dict[str, Any]:
    """Payload de execução (mesmo formato de /api/executions) a partir de uma jornada."""
    domains = [d for d in jornada.get("dominios", "").split("|") if d]
    return {
        "urls": [{
            "url": jornada["url"],
            "depth": int(jornada["profundidade"]),
            "maxStates": int(jornada["max_estados"]),
            "maxActions": int(jornada["max_acoes"]),
            "allowedDomains": domains or None,
            "singleUrlMode": jornada.get("url_unica_bool", False),
        }],
        "template": jornada.get("template") or "sintetico-padrao",
        "browserMode": jornada.get("navegador") or "headless",
        "jornadaId": jornada["id"],
        "purchaseUrls": [jornada["ponto_compra"]] if jornada.get("ponto_compra") else [],
    }


def vencida(jornada: dict[str, Any], agora: datetime, resumo_path: Path | None = None) -> bool:
    """Jornada ativa cujo intervalo desde a última execução já passou (ou nunca rodou)."""
    if not jornada.get("ativo_bool"):
        return False
    ultima = ultima_execucao(jornada["id"], resumo_path)
    if ultima is None:
        return True
    intervalo_h = float(str(jornada.get("intervalo_horas") or "24").replace(",", "."))
    return agora - ultima >= timedelta(hours=intervalo_h)


def ultima_execucao(jid: str, resumo_path: Path | None = None) -> datetime | None:
    _, rows = _read_csv(resumo_path or RESUMO_PATH)
    datas = [datetime.strptime(r["data_hora"], TIMESTAMP_FORMAT) for r in rows
             if r.get("jornada_id") == jid and r.get("data_hora")]
    return max(datas) if datas else None


# ---------------------------------------------------------------- saídas

def _tecnologias(output: dict[str, Any]) -> set[str]:
    return {e.get("technology") or "" for e in output.get("events", [])
            if e.get("technology") not in NON_TAG_TECHNOLOGIES}


def _pixels(output: dict[str, Any]) -> str:
    counts: dict[str, int] = {}
    for e in output.get("events", []):
        tech = e.get("technology") or ""
        if tech and tech not in NON_TAG_TECHNOLOGIES:
            counts[tech] = counts.get(tech, 0) + 1
    return ";".join(f"{tech}={count}" for tech, count in sorted(counts.items(), key=lambda item: -item[1]))


def _ultimo_json(pasta: Path, excluir: str) -> dict[str, Any] | None:
    if not pasta.exists():
        return None
    candidatos = sorted(p for p in pasta.glob("*.json") if p.name != excluir)
    if not candidatos:
        return None
    return json.loads(candidatos[-1].read_text(encoding="utf-8"))


def gravar_saida(record: dict[str, Any], agora: datetime | None = None,
                 saidas_dir: Path | None = None) -> dict[str, Any]:
    """Grava CSV de eventos, JSON completo e a linha de resumo com comparação com a execução anterior."""
    saidas_dir = saidas_dir or SAIDAS_DIR
    jid = record.get("jornadaId") or "avulsa"
    agora = agora or datetime.now()
    output = record.get("output") or {}
    eid = record["id"]
    pasta = saidas_dir / jid
    pasta.mkdir(parents=True, exist_ok=True)
    base = f"{agora.strftime('%Y-%m-%d_%H%M%S')}_{eid[:8]}"
    nome_json = f"{base}.json"

    anterior = _ultimo_json(pasta, nome_json)
    tech_atual = _tecnologias(output)
    tech_anterior = _tecnologias(anterior.get("output") or {}) if anterior else set()
    novas = sorted(tech_atual - tech_anterior) if anterior else []
    ausentes = sorted(tech_anterior - tech_atual) if anterior else []

    data_hora = agora.strftime(TIMESTAMP_FORMAT)
    # eventos logo após uma navegação herdam o rótulo do estado anterior: corrige antes de gravar
    reatribuir_estados(output.get("events", []))
    estados = estados_por_passo(output.get("events", []), output.get("telasVisitadas"))
    pontos = verificar_pontos(output, record.get("jornadaPontos") or {})
    for registro in estados:
        # quais pontos configurados foram associados a esta tela (jornada em ordem, com os pontos marcados)
        registro["ponto"] = ";".join(p["ponto"] for p in pontos
                                     if p["tela"].startswith(f"{registro['ordem']}. "))
    eventos_path = pasta / f"{base}.csv"
    with eventos_path.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.writer(file, delimiter=";")
        writer.writerow(EVENTO_COLUMNS)
        for e in output.get("events", []):
            url_estado, rotulo, passo = partes_estado(e.get("stateName", ""))
            writer.writerow([
                e.get("timestamp", ""), jid, rotulo or url_estado, e.get("passo") or passo, e.get("url", ""),
                e.get("eventType", ""), e.get("technology", ""), e.get("eventName", ""), e.get("status", ""),
                e.get("consentState", ""), json.dumps(e.get("parameters", {}), ensure_ascii=False),
            ])
    estados_path = pasta / f"{base}_estados.csv"
    with estados_path.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.writer(file, delimiter=";")
        writer.writerow(ESTADO_COLUMNS)
        for registro in estados:
            writer.writerow([registro[coluna] for coluna in ESTADO_COLUMNS])
    (pasta / nome_json).write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")

    preenchimentos = sum(1 for a in output.get("actions", [])
                         if a.get("type") in ("fill_field", "select_field", "check_field"))
    paginas = len({a.get("url") for a in output.get("actions", []) if a.get("type") == "navigate"})
    linha = {
        "data_hora": data_hora,
        "jornada_id": jid,
        "nome": record.get("jornadaNome") or jid,
        "url": record.get("url", ""),
        "execucao_id": eid,
        "status": record.get("status", ""),
        "parada": record.get("stopReason") or "",
        "estados": output.get("statesDiscovered", 0),
        "acoes": len(output.get("actions", [])),
        "eventos": len(output.get("events", [])),
        "preenchimentos": preenchimentos,
        "paginas": paginas,
        "pixels": _pixels(output),
        "tecnologias_novas": ";".join(novas),
        "tecnologias_ausentes": ";".join(ausentes),
        "avisos": len(output.get("warnings", [])),
        "estados_distintos": len(estados),
        "arquivo_csv": str(eventos_path.relative_to(saidas_dir.parent)),
        "arquivo_json": str((pasta / nome_json).relative_to(saidas_dir.parent)),
        "arquivo_estados": str(estados_path.relative_to(saidas_dir.parent)),
        "arquivo_pontos": str((pasta / f"{base}_pontos.csv").relative_to(saidas_dir.parent)),
        **{f"ponto_{p['chave']}_{campo}": valor for p in pontos
           for campo, valor in (("url", p["url"]), ("etapa", p["etapa"]), ("titulo", p["titulo"]),
                                ("evento", p["evento"]), ("meta", p["status"]),
                                ("eventos", p["eventos_meta"] if p["url"] else ""))},
    }
    _gravar_pontos(pasta / f"{base}_pontos.csv", pontos)
    _append_csv(saidas_dir / "resumo.csv", RESUMO_COLUMNS, linha)
    # histórico da própria jornada, ao lado dos arquivos de cada execução
    _append_csv(pasta / "resumo.csv", RESUMO_COLUMNS, linha)
    return linha


def _gravar_pontos(path: Path, pontos: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.writer(file, delimiter=";")
        writer.writerow(["ponto", "url", "etapa", "titulo", "evento_esperado", "status_pixel_meta", "eventos_meta",
                         "tela_localizada", "detalhe"])
        for p in pontos:
            if p["url"]:
                writer.writerow([p["ponto"], p["url"], p["etapa"], p["titulo"], p["evento"], p["status"],
                                 p["eventos_meta"], p["tela"], p["detalhe"]])


def ler_resumo(resumo_path: Path | None = None, jornada_id: str | None = None) -> list[dict[str, str]]:
    _, rows = _read_csv(resumo_path or RESUMO_PATH)
    if jornada_id:
        rows = [r for r in rows if r.get("jornada_id") == jornada_id]
    return list(reversed(rows))
