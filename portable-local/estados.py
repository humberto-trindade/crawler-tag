"""Identidade dos estados de uma jornada: URL + rótulo da tela + passo visível.

Fluxos de e-commerce e serviços trocam de etapa por modais e SPA, muitas vezes sem mudar a URL (ou mudando a URL
antes de a tela renderizar). O nome do estado capturado pelo motor tem o formato:

    <url> | <rótulo da tela> | passo <N de M>

Este módulo lê esse nome, corrige eventos cujo rótulo ficou atrasado em relação à URL e resume
quantos eventos (e quais da Meta) ocorreram em cada estado distinto.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse

SEPARADOR = " | "
PASSO_RE = re.compile(r"\bpasso\s+(\d+\s*de\s*\d+)", re.I)
TECNOLOGIA_META = "meta_pixel"


def normalizar_url(url: str) -> str:
    """Compara URLs ignorando maiúsculas no host, barra final, query e fragmento."""
    parsed = urlparse((url or "").strip())
    path = parsed.path.rstrip("/") or "/"
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}{path}"


def partes_estado(state_name: str) -> tuple[str, str, str]:
    """(url, rótulo, passo) de um nome de estado. Passo vem como '3 de 3' ou vazio."""
    partes = [p.strip() for p in (state_name or "").split(SEPARADOR)]
    url = partes[0] if partes else ""
    passo = ""
    rotulos = []
    for parte in partes[1:]:
        achado = PASSO_RE.search(parte)
        if achado and parte.lower().startswith("passo"):
            passo = re.sub(r"\s+", " ", achado.group(1)).strip().lower()
        elif parte:
            rotulos.append(parte)
    return url, SEPARADOR.join(rotulos), passo


def normalizar_etapa(texto: str) -> str:
    """'Passo 3 de 3', '3/3' e '3 de 3' viram '3 de 3'; qualquer outro texto fica em minúsculas."""
    bruto = re.sub(r"\s+", " ", (texto or "").strip().lower())
    achado = re.search(r"(\d+)\s*(?:de|/)\s*(\d+)", bruto)
    if achado:
        return f"{achado.group(1)} de {achado.group(2)}"
    return bruto


def _url_do_estado(evento: dict[str, Any]) -> str:
    estado_url = partes_estado(evento.get("stateName") or "")[0]
    return normalizar_url(estado_url) if estado_url else ""


def reatribuir_estados(events: list[dict[str, Any]]) -> int:
    """Corrige eventos cujo nome de estado ficou atrasado em relação à URL (efeito de navegação).

    Quando a URL muda, os primeiros requests já carregam a URL nova, mas o rótulo do estado só é
    capturado depois que a tela renderiza. Esses eventos herdariam o passo anterior. Aqui eles
    recebem o estado seguinte da mesma URL; sem estado seguinte, ficam só com a URL (sem passo).
    Retorna quantos eventos foram corrigidos.
    """
    corrigidos = 0
    for indice, evento in enumerate(events):
        url_evento = normalizar_url(evento.get("url") or "") if evento.get("url") else ""
        url_estado = _url_do_estado(evento)
        if not url_evento or not url_estado or url_evento == url_estado:
            continue
        proximo = next((e for e in events[indice + 1:] if _url_do_estado(e) == url_evento), None)
        novo_estado = proximo["stateName"] if proximo else evento["url"]
        evento["stateName"] = novo_estado
        evento["passo"] = partes_estado(novo_estado)[2]
        evento["estadoReatribuido"] = True
        corrigidos += 1
    return corrigidos + _adotar_estado_da_tela(events)


def _adotar_estado_da_tela(events: list[dict[str, Any]]) -> int:
    """Eventos de carregamento (antes do rótulo da tela existir) adotam o estado rotulado seguinte.

    O pageview e os primeiros requests de uma tela disparam antes de o motor capturar o rótulo e o passo.
    Esses eventos têm só a URL no nome do estado. Eles pertencem à tela que se forma na mesma URL: adotam o
    próximo estado rotulado dessa URL, desde que a jornada não navegue para outra URL no meio.
    """
    adotados = 0
    for indice, evento in enumerate(events):
        url, rotulo, passo = partes_estado(evento.get("stateName") or "")
        if not url or rotulo or passo or not evento.get("url"):
            continue
        alvo = normalizar_url(url)
        for seguinte in events[indice + 1:]:
            url_seguinte = _url_do_estado(seguinte)
            if url_seguinte and url_seguinte != alvo:
                break
            _, rotulo_seguinte, passo_seguinte = partes_estado(seguinte.get("stateName") or "")
            if url_seguinte == alvo and (rotulo_seguinte or passo_seguinte):
                evento["stateName"] = seguinte["stateName"]
                evento["passo"] = passo_seguinte
                evento["estadoReatribuido"] = True
                adotados += 1
                break
    return adotados


def nome_evento_meta(evento: dict[str, Any]) -> str:
    """Nome do evento Meta (parâmetro 'ev' da requisição, ex.: PageView, Lead); sem ele, o nome técnico."""
    parametros = evento.get("parameters") or {}
    return str(parametros.get("ev") or evento.get("eventName") or "")


def _chave_estado(nome: str) -> tuple[str, str, str]:
    url, rotulo, passo = partes_estado(nome)
    return (normalizar_url(url) if url else "", rotulo, passo)


def _nomes_das_telas(telas: list[Any]) -> list[str]:
    """Nomes das telas alcançadas, sem repetição imediata e sem a versão só-URL de uma tela que logo ganha rótulo."""
    nomes = [t["stateName"] if isinstance(t, dict) else str(t) for t in telas]
    nomes = [n for n in nomes if n]
    resultado = []
    for indice, nome in enumerate(nomes):
        url, rotulo, passo = partes_estado(nome)
        if url and not rotulo and not passo:
            alvo = normalizar_url(url)
            adiante = nomes[indice + 1:]
            rotulada_depois = False
            for seguinte in adiante:
                url_seguinte, rot_seg, passo_seguinte = partes_estado(seguinte)
                if normalizar_url(url_seguinte) != alvo:
                    break
                if rot_seg or passo_seguinte:
                    rotulada_depois = True
                    break
            if rotulada_depois:
                continue
        if not resultado or resultado[-1] != nome:
            resultado.append(nome)
    return resultado


def estados_por_passo(events: list[dict[str, Any]], telas: list[Any] | None = None) -> list[dict[str, Any]]:
    """Um registro por estado distinto (URL + rótulo + passo), na ordem em que apareceram.

    Com `telas` (as telas alcançadas pelo motor, em ordem), a jornada inclui também as telas sem nenhum
    evento (contagem zero) — são elas que mostram onde o cadastro do pixel está faltando.
    """
    estados: dict[tuple[str, str, str], dict[str, Any]] = {}

    def registro_de(nome: str) -> dict[str, Any]:
        url, rotulo, passo = partes_estado(nome)
        return estados.setdefault(_chave_estado(nome), {
            "ordem": len(estados) + 1, "url": url, "estado": rotulo, "passo": passo,
            "eventos": 0, "eventos_meta": 0, "nomes_meta": set(), "tecnologias": {},
        })

    for nome in _nomes_das_telas(telas or []):
        registro_de(nome)
    for evento in events:
        nome = evento.get("stateName") or ""
        if not nome.startswith(("http://", "https://")):
            nome = evento.get("url") or ""  # nome de estado sem URL: usa a URL do próprio evento
        if not nome:
            continue
        registro = registro_de(nome)
        registro["eventos"] += 1
        tecnologia = evento.get("technology") or ""
        if tecnologia and tecnologia not in ("custom", "unclassified_tracker"):
            registro["tecnologias"][tecnologia] = registro["tecnologias"].get(tecnologia, 0) + 1
        if tecnologia == TECNOLOGIA_META:
            registro["eventos_meta"] += 1
            registro["nomes_meta"].add(nome_evento_meta(evento))
    return [{**r, "nomes_meta": ";".join(sorted(n for n in r["nomes_meta"] if n)),
             "tecnologias": ";".join(f"{t}={n}" for t, n in sorted(r["tecnologias"].items(), key=lambda i: -i[1]))}
            for r in estados.values()]


def tela_corresponde(registro: dict[str, Any], etapa: str = "", titulo: str = "") -> bool:
    """A tela atende ao critério? Etapa e título informados precisam bater juntos (E)."""
    rotulo = str(registro.get("estado") or "").lower()
    if etapa and not (etapa == registro.get("passo") or etapa in rotulo):
        return False
    if titulo and titulo not in rotulo:
        return False
    return True
