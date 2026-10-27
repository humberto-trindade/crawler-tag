"""Regressão do mapeamento campo -> valor sintético (motor/fieldmapper.py).

Os vetores em fixtures/fieldmapper_vectors.json foram gerados pelo TypeScript de referência
(cloud-run-app/src/crawler/fieldMapper.ts, resolveFieldMappingFromHints) com o mesmo template.
Casos cujo valor é uma data mudam com o dia; neles só tipo e chave são comparados.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from motor.fieldmapper import FieldHints, resolve_field_mapping_from_hints  # noqa: E402

VECTORS = ROOT / "tests" / "fixtures" / "fieldmapper_vectors.json"
TEMPLATE = ROOT / "templates" / "sintetico-padrao.json"

HINT_KEYS = {
    "name": "name",
    "id": "id",
    "dataField": "data_field",
    "type": "type",
    "autocomplete": "autocomplete",
    "placeholder": "placeholder",
    "ariaLabel": "aria_label",
    "label": "label",
    "contextText": "context_text",
}


def _load_template_keys() -> list[dict]:
    data = json.loads(TEMPLATE.read_text(encoding="utf-8"))
    return data["data"]["keys"]


def _hints(raw: dict) -> FieldHints:
    kwargs = {python_name: raw.get(ts_name, "") for ts_name, python_name in HINT_KEYS.items()}
    return FieldHints(**kwargs)


class FieldMapperParityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.vectors = json.loads(VECTORS.read_text(encoding="utf-8"))
        cls.template_keys = _load_template_keys()

    def test_quantidade_de_vetores(self) -> None:
        self.assertEqual(len(self.vectors), 17)

    def test_cada_caso_igual_ao_typescript(self) -> None:
        for case in self.vectors:
            with self.subTest(caso=case["id"]):
                actual = resolve_field_mapping_from_hints(_hints(case["hints"]), self.template_keys)
                expected = case["expected"]
                self.assertEqual(actual["type"], expected["type"])
                if expected["type"] == "ignored":
                    self.assertEqual(actual["reason"], expected["reason"])
                else:
                    self.assertEqual(actual["key"], expected["key"])
                    if not case["valueVaries"]:
                        self.assertEqual(actual["value"], expected["value"])


class IdentityTieBreakTest(unittest.TestCase):
    """Divergência documentada do TypeScript: campo tel chamado cep vai para cep, não ignorado."""

    def setUp(self) -> None:
        self.template_keys = _load_template_keys()

    def test_cep_com_tipo_tel_mapeia_para_cep(self) -> None:
        hints = FieldHints(name="cep", id="", data_field="", type="tel", autocomplete="", placeholder="",
                           aria_label="", label="", context_text="")
        result = resolve_field_mapping_from_hints(hints, self.template_keys)
        self.assertEqual(result["type"], "mapped")
        self.assertEqual(result["key"], "cep")

    def test_tel_sem_identidade_continua_telefone(self) -> None:
        hints = FieldHints(name="", id="", data_field="", type="tel", autocomplete="", placeholder="",
                           aria_label="", label="", context_text="")
        result = resolve_field_mapping_from_hints(hints, self.template_keys)
        self.assertEqual(result["key"], "telefone")


if __name__ == "__main__":
    unittest.main()
