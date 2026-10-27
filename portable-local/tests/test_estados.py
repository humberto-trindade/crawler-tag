"""Regressão da identidade dos estados (URL + rótulo + passo) e da verificação dos pontos por etapa."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import jornadas  # noqa: E402
from estados import (  # noqa: E402
    estados_por_passo, normalizar_etapa, partes_estado, reatribuir_estados,
)
from motor.deteccao import extrair_passo, make_event  # noqa: E402

BASE = "https://x.test/loja/servicos"


def _ev(tech: str, url: str, estado: str, nome: str = "network_x") -> dict:
    return {"technology": tech, "eventName": nome, "url": url, "stateName": estado, "eventType": "request_observed"}


class PartesDoEstadoTest(unittest.TestCase):
    def test_partes_com_rotulo_e_passo(self) -> None:
        url, rotulo, passo = partes_estado(f"{BASE}/dados-cadastrais | Informe seus dados | passo 3 de 3")
        self.assertEqual((url, rotulo, passo), (f"{BASE}/dados-cadastrais", "Informe seus dados", "3 de 3"))

    def test_estado_so_com_url(self) -> None:
        self.assertEqual(partes_estado("https://x.test/a"), ("https://x.test/a", "", ""))

    def test_etapa_normalizada(self) -> None:
        for texto in ("Passo 3 de 3", "3/3", "3 de 3", "  3  DE  3 "):
            self.assertEqual(normalizar_etapa(texto), "3 de 3")
        self.assertEqual(normalizar_etapa("Informe seus dados"), "informe seus dados")

    def test_evento_carrega_o_passo(self) -> None:
        self.assertEqual(extrair_passo(f"{BASE}/endereco | Confirme o local | passo 2 de 3"), "2 de 3")
        evento = make_event(action_id=None, event_type="request_observed", technology="meta_pixel",
                            event_name="network_meta", url=f"{BASE}/endereco",
                            state_name=f"{BASE}/endereco | Confirme o local | passo 2 de 3", parameters={})
        self.assertEqual(evento["passo"], "2 de 3")


class ReatribuicaoTest(unittest.TestCase):
    def test_evento_logo_apos_navegacao_recebe_o_estado_da_url_nova(self) -> None:
        # request já na URL de dados, mas ainda rotulado com o passo 2 (rótulo atrasado)
        eventos = [
            _ev("meta_pixel", f"{BASE}/endereco", f"{BASE}/endereco | Local | passo 2 de 3"),
            _ev("meta_pixel", f"{BASE}/dados-cadastrais", f"{BASE}/endereco | Local | passo 2 de 3"),
            _ev("ga4", f"{BASE}/dados-cadastrais", f"{BASE}/dados-cadastrais | Informe seus dados | passo 3 de 3"),
        ]
        self.assertEqual(reatribuir_estados(eventos), 1)
        self.assertEqual(eventos[1]["passo"], "3 de 3")
        self.assertTrue(eventos[1]["estadoReatribuido"])
        self.assertNotIn("estadoReatribuido", eventos[0])

    def test_sem_estado_seguinte_fica_so_com_a_url(self) -> None:
        eventos = [_ev("meta_pixel", f"{BASE}/dados-cadastrais", f"{BASE}/endereco | Local | passo 2 de 3")]
        reatribuir_estados(eventos)
        self.assertEqual(eventos[0]["stateName"], f"{BASE}/dados-cadastrais")
        self.assertEqual(eventos[0]["passo"], "")


class EventosDeCarregamentoTest(unittest.TestCase):
    URL = f"{BASE}/dados-cadastrais"

    def test_pageview_antes_do_rotulo_adota_o_passo_da_tela(self) -> None:
        eventos = [
            _ev("meta_pixel", self.URL, self.URL),  # carregamento: nome do estado só com a URL
            _ev("ga4", self.URL, f"{self.URL} | Informe seus dados | passo 3 de 3"),
        ]
        reatribuir_estados(eventos)
        self.assertEqual(eventos[0]["passo"], "3 de 3")
        self.assertEqual(eventos[0]["stateName"], f"{self.URL} | Informe seus dados | passo 3 de 3")

    def test_nao_adota_estado_depois_de_navegar_para_outra_url(self) -> None:
        eventos = [
            _ev("meta_pixel", self.URL, self.URL),
            _ev("ga4", f"{BASE}/outra", f"{BASE}/outra | Outra | passo 1 de 3"),
            _ev("ga4", self.URL, f"{self.URL} | Informe seus dados | passo 3 de 3"),
        ]
        reatribuir_estados(eventos)
        self.assertEqual(eventos[0]["stateName"], self.URL)
        self.assertEqual(eventos[0].get("passo", ""), "")

    def test_ponto_com_etapa_conta_o_pixel_do_carregamento(self) -> None:
        saida = {"events": [_ev("meta_pixel", self.URL, self.URL),
                            _ev("ga4", self.URL, f"{self.URL} | Informe seus dados | passo 3 de 3")],
                 "actions": [], "warnings": []}
        reatribuir_estados(saida["events"])
        pontos = jornadas.verificar_pontos(saida, {"ponto_lead_intent": self.URL, "ponto_lead_intent_etapa": "3 de 3"})
        self.assertEqual(pontos[2]["status"], "disparou")


class EstadosPorPassoTest(unittest.TestCase):
    def test_mesma_url_com_estados_distintos(self) -> None:
        url = "https://x.test/pdp"
        eventos = [
            _ev("meta_pixel", url, f"{url} | Servico Exemplo"),
            _ev("ga4", url, f"{url} | Servico Exemplo"),
            _ev("meta_pixel", url, f"{url} | Form: Avenida Paulista", "network_meta_b"),
            _ev("meta_pixel", url, f"{url} | Form: Avenida Paulista", "network_meta_b"),
        ]
        estados = estados_por_passo(eventos)
        self.assertEqual(len(estados), 2)
        self.assertEqual([(e["eventos"], e["eventos_meta"]) for e in estados], [(2, 1), (2, 2)])
        self.assertEqual(estados[1]["nomes_meta"], "network_meta_b")

    def test_passos_distintos_na_mesma_url(self) -> None:
        url = f"{BASE}/dados-cadastrais"
        eventos = [_ev("meta_pixel", url, f"{url} | Dados | passo 1 de 3"),
                   _ev("meta_pixel", url, f"{url} | Dados | passo 3 de 3")]
        self.assertEqual([e["passo"] for e in estados_por_passo(eventos)], ["1 de 3", "3 de 3"])


class JornadaEmOrdemTest(unittest.TestCase):
    def test_tela_so_com_url_some_quando_ganha_rotulo_e_repeticao_e_ignorada(self) -> None:
        url = f"{BASE}/endereco"
        telas = [url, url, f"{url} | Local | passo 2 de 3", f"{url} | Local | passo 2 de 3", f"{BASE}/dados | Dados | passo 3 de 3"]
        jornada = estados_por_passo([], telas)
        self.assertEqual([(e["ordem"], e["passo"]) for e in jornada], [(1, "2 de 3"), (2, "3 de 3")])

    def test_tecnologias_por_tela(self) -> None:
        url = f"{BASE}/x"
        eventos = [_ev("meta_pixel", url, f"{url} | A | passo 1 de 2"), _ev("ga4", url, f"{url} | A | passo 1 de 2")]
        self.assertEqual(estados_por_passo(eventos)[0]["tecnologias"], "meta_pixel=1;ga4=1")


class PontosPorEtapaTest(unittest.TestCase):
    URL = f"{BASE}/dados-cadastrais"

    def _output(self, eventos: list[dict], **extra) -> dict:
        return {"events": eventos, "actions": [{"type": "navigate", "url": self.URL}], "warnings": [], **extra}

    def test_mesma_url_e_mesma_etapa_e_indistinguivel(self) -> None:
        saida = self._output([_ev("meta_pixel", self.URL, f"{self.URL} | Dados | passo 3 de 3")])
        pontos = jornadas.verificar_pontos(saida, {"ponto_shortform": self.URL, "ponto_lead_intent": self.URL})
        self.assertEqual([p["status"] for p in pontos if p["url"]], ["indistinguivel", "indistinguivel"])
        self.assertIn("etapa", pontos[1]["detalhe"])

    def test_etapas_diferentes_na_mesma_url_sao_medidas_separadamente(self) -> None:
        saida = self._output([_ev("meta_pixel", self.URL, f"{self.URL} | Dados | passo 3 de 3")])
        pontos = jornadas.verificar_pontos(saida, {
            "ponto_shortform": self.URL, "ponto_shortform_etapa": "1 de 3",
            "ponto_lead_intent": self.URL, "ponto_lead_intent_etapa": "Passo 3 de 3"})
        status = {p["chave"]: p["status"] for p in pontos if p["url"]}
        self.assertEqual(status["lead_intent"], "disparou")
        self.assertEqual(status["shortform"], "criterio_nao_localizado")

    def test_etapa_inexistente_lista_os_estados_vistos_na_url(self) -> None:
        saida = self._output([_ev("meta_pixel", self.URL, f"{self.URL} | Informe seus dados | passo 3 de 3")])
        pontos = jornadas.verificar_pontos(saida, {"ponto_shortform": self.URL, "ponto_shortform_etapa": "1 de 3"})
        self.assertEqual(pontos[1]["status"], "criterio_nao_localizado")
        self.assertIn("Informe seus dados [3 de 3] meta=1", pontos[1]["detalhe"])

    def test_url_nunca_alcancada_continua_not_reached(self) -> None:
        saida = self._output([_ev("meta_pixel", self.URL, f"{self.URL} | Dados | passo 3 de 3")])
        pontos = jornadas.verificar_pontos(saida, {"ponto_shortform": "https://x.test/outra",
                                                   "ponto_shortform_etapa": "1 de 3"})
        self.assertEqual(pontos[1]["status"], "not_reached")

    def test_criterio_combinado_etapa_e_titulo(self) -> None:
        saida = self._output([_ev("meta_pixel", self.URL, f"{self.URL} | Informe seus dados | passo 3 de 3")])
        pontos = jornadas.verificar_pontos(saida, {
            "ponto_lead_intent": self.URL, "ponto_lead_intent_etapa": "3 de 3", "ponto_lead_intent_titulo": "informe seus dados",
            "ponto_shortform": self.URL, "ponto_shortform_etapa": "3 de 3", "ponto_shortform_titulo": "outro titulo"})
        status = {p["chave"]: p["status"] for p in pontos if p["url"]}
        self.assertEqual(status["lead_intent"], "disparou")
        self.assertEqual(status["shortform"], "criterio_nao_localizado")

    def test_evento_esperado_usa_o_parametro_ev_da_meta(self) -> None:
        evento = _ev("meta_pixel", self.URL, f"{self.URL} | Dados | passo 3 de 3")
        evento["parameters"] = {"ev": "PageView"}
        saida = self._output([evento])
        ok = jornadas.verificar_pontos(saida, {"ponto_lead_intent": self.URL, "ponto_lead_intent_etapa": "3 de 3",
                                               "ponto_lead_intent_evento": "pageview"})
        self.assertEqual(ok[2]["status"], "disparou")
        errado = jornadas.verificar_pontos(saida, {"ponto_lead_intent": self.URL, "ponto_lead_intent_etapa": "3 de 3",
                                                   "ponto_lead_intent_evento": "Lead"})
        self.assertEqual(errado[2]["status"], "missing")
        self.assertIn("'lead'", errado[2]["detalhe"])

    def test_tela_sem_nenhum_evento_aparece_na_jornada_e_e_missing(self) -> None:
        # o passo existe (tela visitada), mas não disparou nada: é o caso do cadastro faltando
        telas = [{"stateName": f"{self.URL} | Endereço | passo 2 de 3"},
                 {"stateName": f"{self.URL} | Informe seus dados | passo 3 de 3"}]
        saida = self._output([_ev("meta_pixel", self.URL, f"{self.URL} | Informe seus dados | passo 3 de 3")],
                             telasVisitadas=telas)
        jornada = estados_por_passo(saida["events"], saida["telasVisitadas"])
        self.assertEqual([(e["passo"], e["eventos"]) for e in jornada], [("2 de 3", 0), ("3 de 3", 1)])
        pontos = jornadas.verificar_pontos(saida, {"ponto_shortform": self.URL, "ponto_shortform_etapa": "2 de 3"})
        self.assertEqual(pontos[1]["status"], "missing")

    def test_alcancado_sem_pixel_e_missing(self) -> None:
        saida = self._output([_ev("ga4", self.URL, f"{self.URL} | Dados | passo 3 de 3")])
        pontos = jornadas.verificar_pontos(saida, {"ponto_lead_intent": self.URL, "ponto_lead_intent_etapa": "3 de 3"})
        self.assertEqual(pontos[2]["status"], "missing")

    def test_nao_alcancado_com_bloqueio_e_blocked_e_nao_missing(self) -> None:
        saida = self._output([], warnings=[{"type": "spa_router", "message": 'Clique sem efeito em "continuar" em x'}])
        pontos = jornadas.verificar_pontos(saida, {"ponto_lead_intent": "https://x.test/outra"})
        self.assertEqual(pontos[2]["status"], "blocked")

    def test_watchdog_conta_como_bloqueio(self) -> None:
        saida = self._output([], stopReason="watchdog_sem_progresso:150s")
        pontos = jornadas.verificar_pontos(saida, {"ponto_pdp": "https://x.test/outra"})
        self.assertEqual(pontos[0]["status"], "blocked")


if __name__ == "__main__":
    unittest.main()
