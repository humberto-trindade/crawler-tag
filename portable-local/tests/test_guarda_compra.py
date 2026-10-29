"""Guarda de compra: em URL de compra da jornada nenhum botão de avanço é clicado."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from motor import paginas  # noqa: E402


class _Page:
    def __init__(self, url: str) -> None:
        self.url = url


class GuardaDeCompraTest(unittest.TestCase):
    def tearDown(self) -> None:
        paginas.definir_urls_de_compra([])

    def test_url_de_compra_ignora_query_e_barra_final(self) -> None:
        paginas.definir_urls_de_compra(["https://x.test/loja/dados/"])
        self.assertTrue(paginas.em_url_de_compra(_Page("https://X.test/loja/dados?a=1")))
        self.assertFalse(paginas.em_url_de_compra(_Page("https://x.test/loja/agendamento")))

    def test_clique_e_recusado_na_url_de_compra(self) -> None:
        paginas.definir_urls_de_compra(["https://x.test/loja/dados"])
        resultado = paginas.click_best_dynamic_cta(_Page("https://x.test/loja/dados"))
        self.assertEqual(resultado, {"clicked": False, "failureReason": "purchase_guard"})

    def test_sem_guarda_configurada_nada_e_bloqueado(self) -> None:
        self.assertFalse(paginas.em_url_de_compra(_Page("https://x.test/loja/dados")))


if __name__ == "__main__":
    unittest.main()
