"""Port de cloud-run-app/src/crawler/fieldMapper.ts.

Mesma lógica de mapeamento campo -> valor sintético. Os hints do campo são
coletados no navegador (ver explorer.py), no mesmo formato de FieldHints.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Optional


@dataclass
class FieldHints:
    name: str = ""
    id: str = ""
    data_field: str = ""
    type: str = ""
    autocomplete: str = ""
    placeholder: str = ""
    aria_label: str = ""
    label: str = ""
    context_text: str = ""


def _norm(value: Optional[str]) -> str:
    return (value or "").lower().strip()


def _format_date_offset(days: int) -> str:
    return (date.today() + timedelta(days=days)).strftime("%Y-%m-%d")


def _find_template_value(template_keys: list[dict[str, Any]], includes_any: list[str]) -> Optional[str]:
    for item in template_keys:
        key = item["key"].lower()
        if any(term in key for term in includes_any):
            return item["value"]
    return None


def _matches(hints: FieldHints, key: dict[str, Any]) -> bool:
    matcher = key.get("matchers")
    if not matcher:
        return False

    attributes = matcher.get("attributes") or []
    labels = matcher.get("labels") or []
    types = matcher.get("types") or []
    autocompletes = matcher.get("autocomplete") or []
    placeholders = matcher.get("placeholders") or []

    attribute_matched = any(
        term.lower() in candidate
        for term in attributes
        for candidate in (hints.name, hints.id, hints.data_field)
    )
    label_matched = any(term.lower() in hints.label for term in labels)
    type_matched = any(hints.type == term.lower() for term in types)
    autocomplete_matched = any(hints.autocomplete == term.lower() for term in autocompletes)
    placeholder_matched = any(
        term.lower() in hints.placeholder or term.lower() in hints.aria_label for term in placeholders
    )
    return attribute_matched or label_matched or type_matched or autocomplete_matched or placeholder_matched


def _matches_identity(hints: FieldHints, key: dict[str, Any]) -> bool:
    """Casamento pela identidade do campo (nome/id/rótulo/autocomplete/placeholder), sem o tipo HTML."""
    matcher = key.get("matchers") or {}
    attribute_matched = any(
        term.lower() in candidate
        for term in matcher.get("attributes") or []
        for candidate in (hints.name, hints.id, hints.data_field)
    )
    label_matched = any(term.lower() in hints.label for term in matcher.get("labels") or [])
    autocomplete_matched = any(hints.autocomplete == term.lower() for term in matcher.get("autocomplete") or [])
    placeholder_matched = any(
        term.lower() in hints.placeholder or term.lower() in hints.aria_label
        for term in matcher.get("placeholders") or []
    )
    return attribute_matched or label_matched or autocomplete_matched or placeholder_matched


ADMIN_PATTERNS = [
    # Cookiebot/Consent
    "ot-group-id",
    "optanon",
    "cookie-consent",
    "cookie-consent-plus",
    # BMC Software (Help Chat)
    "bmc-",
    "valvechat",
    # Vendor Management
    "vendor-",
    "storage-access",
    "storage-",
    # Batch Operations
    "select-all",
    "selectall",
    # Placeholders
    "replace-with",
    "replace_with",
    "dyanmic-host-id",
    # Portocap Admin
    "portocap__",
    "func__",
    # Admin/DevTools
    "__admin",
    "admin-",
    "dev-",
    "test-",
]

_SEARCH_LIKE = re.compile(r"(buscar|busca|search|pesquisa|encontre|localize|procurar|o que voc[eê] procura)", re.I)
_START_DATE = re.compile(r"(startdate|data.?ida|partida|inicio.?viagem|checkin|data.?inicio|fakedate)", re.I)
_END_DATE = re.compile(r"(enddate|data.?volta|retorno|checkout|data.?fim|fim.?viagem)", re.I)
_DATE_LIKE_TEXT = re.compile(r"(date|data|calend)", re.I)
_START_HINT = re.compile(r"(start|inicio|ida|fakedate)", re.I)
_MONEY_LIKE = re.compile(r"(monthlyvalue|valor|amount|pre[cç]o|price|r\$|mensal|saldo|custo)", re.I)


def resolve_field_mapping_from_hints(hints: FieldHints, template_keys: list[dict[str, Any]]) -> dict[str, Any]:
    """Retorna {"type": "mapped", "key", "value"} ou {"type": "ignored", "reason"}."""
    joined = " ".join(
        [
            hints.name,
            hints.id,
            hints.data_field,
            hints.autocomplete,
            hints.placeholder,
            hints.aria_label,
            hints.label,
            hints.context_text,
        ]
    ).lower()

    # Pagamento: nunca preencher dados de cartão (a execução para antes dessa etapa)
    if re.search(r"(card|cart[aã]o|cvv|cvc|csc|validade|expiry|cc-number|cc-csc|cc-exp)", joined, re.I):
        return {"type": "ignored", "reason": "unsupported_type"}
    if hints.type in ("file", "password", "hidden", "button", "submit", "reset") or any(
        pattern in joined for pattern in ADMIN_PATTERNS
    ):
        return {"type": "ignored", "reason": "unsupported_type"}

    is_search_like = bool(_SEARCH_LIKE.search(joined))
    has_weak_identity = not (
        hints.name or hints.id or hints.data_field or hints.placeholder or hints.aria_label or hints.label
    )
    if hints.type == "search" or (has_weak_identity and is_search_like):
        return {"type": "ignored", "reason": "unsupported_type"}

    # Datas nativas (<input type=date>)
    if hints.type in ("date", "datetime-local"):
        date_keys = [
            k
            for k in template_keys
            if any(t in k["key"].lower() for t in ("date", "data", "inicio", "fim", "start", "end"))
        ]
        if date_keys:
            field_matched = next((k for k in date_keys if _matches(hints, k)), None)
            if field_matched:
                return {"type": "mapped", "key": field_matched["key"], "value": field_matched["value"]}

            def pick(*terms: str) -> Optional[dict[str, Any]]:
                return next((k for k in date_keys if any(t in k["key"].lower() for t in terms)), None)

            target = pick("start") or pick("end") or pick("inicio") or pick("fim") or date_keys[0]
            if target:
                return {"type": "mapped", "key": target["key"], "value": target["value"]}
        return {"type": "ignored", "reason": "no_mapping"}

    is_start_date = bool(_START_DATE.search(joined))
    is_end_date = bool(_END_DATE.search(joined))
    is_date_like_text = hints.type == "text" and bool(_DATE_LIKE_TEXT.search(joined))
    if is_start_date or is_end_date or is_date_like_text:
        is_start = is_start_date or (not is_end_date and bool(_START_HINT.search(joined)))
        if is_start:
            preferred = _find_template_value(template_keys, ["start", "inicio", "ida", "date"])
        else:
            preferred = _find_template_value(template_keys, ["end", "fim", "volta", "date"])
        return {
            "type": "mapped",
            "key": "fallback_start_date" if is_start else "fallback_end_date",
            "value": preferred if preferred is not None else _format_date_offset(7 if is_start else 14),
        }

    is_react_select = "react-select" in hints.id or "react-select" in hints.name
    is_dropdown_like = "select" in hints.aria_label or "select" in hints.placeholder
    if is_react_select or is_dropdown_like:
        preferred = _find_template_value(template_keys, ["destino", "pais", "country", "trip", "produto"])
        return {"type": "mapped", "key": "fallback_select_option", "value": preferred if preferred is not None else "Brasil"}

    if hints.type in ("checkbox", "radio"):
        preferred = _find_template_value(template_keys, ["consent", "aceite", "termo", "accept", "lgpd"])
        return {"type": "mapped", "key": "fallback_checkbox", "value": preferred if preferred is not None else "true"}

    is_money_like = bool(_MONEY_LIKE.search(joined))
    is_numeric_like = (hints.type or "text") in ("tel", "number", "text")
    if is_money_like and is_numeric_like:
        preferred = _find_template_value(template_keys, ["monthly", "mensal", "valor", "amount", "price", "custo"])
        return {"type": "mapped", "key": "fallback_money_value", "value": preferred if preferred is not None else "250"}

    matched = [k for k in template_keys if _matches(hints, k)]
    if not matched:
        return {"type": "ignored", "reason": "no_mapping"}
    if len(matched) > 1:
        # Mesmo valor em todas as chaves casadas -> usa a primeira; senão ambíguo.
        if len({k["value"] for k in matched}) == 1:
            return {"type": "mapped", "key": matched[0]["key"], "value": matched[0]["value"]}
        # Divergência documentada (ver docs/progress.md): um campo `type="tel"` chamado `cep` casava
        # com a chave telefone pelo tipo. Se só uma chave casou pela identidade do campo, ela vence.
        identified = [k for k in matched if _matches_identity(hints, k)]
        if len(identified) == 1:
            return {"type": "mapped", "key": identified[0]["key"], "value": identified[0]["value"]}
        return {"type": "ignored", "reason": "ambiguous_mapping", "matchedKeys": [k["key"] for k in matched]}

    target = matched[0]
    return {"type": "mapped", "key": target["key"], "value": target["value"]}
