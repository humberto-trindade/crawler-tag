"""Regressão das jornadas monitoradas: configuração CSV, intervalo e saídas por execução.

Tudo isolado em diretórios temporários; não toca em config/ nem saidas/ reais.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import jornadas  # noqa: E402


def _linha(**extra) -> dict:
    base = {"id": "seguro-viagem", "nome": "Seguro viagem", "url": "https://www.exemplo.test/seguro-viagem",
            "profundidade": "0", "max_estados": "12", "max_acoes": "120", "template": "sintetico-padrao",
            "navegador": "headless", "url_unica": "sim", "ativo": "sim", "intervalo_horas": "6",
            "observacoes": "teste"}
    base.update(extra)
    return base


def _evento(tech: str, state: str = "estado-a") -> dict:
    return {"timestamp": "2026-10-22T10:00:00Z", "eventType": "request_observed", "technology": tech,
            "eventName": f"network_{tech}", "stateName": state, "url": "https://x.test/", "status": "observed",
            "consentState": "after_consent", "parameters": {"id": "1"}}


def _record(eid: str, techs: list[str], jid: str = "seguro-viagem") -> dict:
    return {
        "id": eid, "url": "https://x.test/", "status": "completed", "stopReason": "max_actions:120",
        "jornadaId": jid, "jornadaNome": "Seguro viagem",
        "output": {"status": "completed", "statesDiscovered": 2,
                   "actions": [{"type": "navigate", "url": "https://x.test/"},
                               {"type": "fill_field", "url": "https://x.test/"}],
                   "events": [_evento(t) for t in techs], "warnings": [], "ignoredFields": []},
    }


class ValidacaoTest(unittest.TestCase):
    def test_profundidade_zero_e_mantida(self) -> None:
        normalized = jornadas.validate_jornada(_linha(profundidade=0))
        self.assertEqual(normalized["profundidade"], "0")

    def test_id_invalido(self) -> None:
        with self.assertRaisesRegex(ValueError, "id:"):
            jornadas.validate_jornada(_linha(id="Seguro Viagem!"))

    def test_url_invalida(self) -> None:
        with self.assertRaisesRegex(ValueError, "url inválida"):
            jornadas.validate_jornada(_linha(url="ftp://x.test/"))

    def test_faixas_e_navegador(self) -> None:
        with self.assertRaisesRegex(ValueError, "profundidade"):
            jornadas.validate_jornada(_linha(profundidade=9))
        with self.assertRaisesRegex(ValueError, "navegador"):
            jornadas.validate_jornada(_linha(navegador="firefox"))

    def test_intervalo_aceita_virgula(self) -> None:
        normalized = jornadas.validate_jornada(_linha(intervalo_horas="0,5"))
        self.assertEqual(normalized["intervalo_horas"], "0,5")

    def test_booleanos_em_portugues(self) -> None:
        normalized = jornadas.validate_jornada(_linha(ativo="nao", url_unica="sim"))
        self.assertEqual((normalized["ativo"], normalized["url_unica"]), ("nao", "sim"))


class ConfiguracaoTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "jornadas.csv"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_salvar_cria_e_altera_pelo_id(self) -> None:
        jornadas.salvar_jornada(_linha(), path=self.path)
        jornadas.salvar_jornada(_linha(nome="Novo nome", intervalo_horas="2"), path=self.path)
        lista = jornadas.listar_jornadas(self.path)
        self.assertEqual(len(lista), 1)
        self.assertEqual(lista[0]["nome"], "Novo nome")
        self.assertEqual(lista[0]["intervalo_horas"], "2")

    def test_arquivo_gravado_com_ponto_e_virgula_e_bom(self) -> None:
        jornadas.salvar_jornada(_linha(), path=self.path)
        raw = self.path.read_bytes()
        self.assertTrue(raw.startswith(b"\xef\xbb\xbf"))
        self.assertIn(b";", raw.splitlines()[0])

    def test_le_arquivo_separado_por_virgula(self) -> None:
        self.path.write_text("id,nome,url,profundidade,max_estados,max_acoes,dominios,template,navegador,"
                             "url_unica,ativo,intervalo_horas,observacoes\n"
                             "servicos,Servicos,https://www.exemplo.test/servicos,1,30,60,,sintetico-padrao,"
                             "headless,nao,sim,24,\n", encoding="utf-8")
        lista = jornadas.listar_jornadas(self.path)
        self.assertEqual(lista[0]["id"], "servicos")
        self.assertTrue(lista[0]["ativo_bool"])

    def test_payload_de_execucao(self) -> None:
        jornada = jornadas.salvar_jornada(_linha(dominios="www.exemplo.test, outro.test"), path=self.path)
        payload = jornadas.config_execucao(jornadas.jornada_por_id("seguro-viagem", self.path))
        self.assertEqual(payload["jornadaId"], "seguro-viagem")
        self.assertEqual(payload["urls"][0]["allowedDomains"], ["www.exemplo.test", "outro.test"])
        self.assertTrue(payload["urls"][0]["singleUrlMode"])
        self.assertEqual(payload["urls"][0]["depth"], 0)
        self.assertIsNotNone(jornada)


class IntervaloTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.resumo = Path(self.tmp.name) / "resumo.csv"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _registrar(self, when: datetime) -> None:
        jornadas.gravar_saida(_record("aaaaaaaa-0000", ["ga4"]), agora=when, saidas_dir=Path(self.tmp.name))

    def test_nunca_executada_esta_vencida(self) -> None:
        jornada = jornadas.validate_jornada(_linha())
        jornada = {**jornada, "ativo_bool": True}
        self.assertTrue(jornadas.vencida(jornada, datetime(2026, 10, 22, 12), self.resumo))

    def test_intervalo_respeitado(self) -> None:
        jornada = {**jornadas.validate_jornada(_linha(intervalo_horas="6")), "ativo_bool": True}
        self._registrar(datetime(2026, 10, 22, 8, 0))
        resumo = Path(self.tmp.name) / "resumo.csv"
        self.assertFalse(jornadas.vencida(jornada, datetime(2026, 10, 22, 13, 0), resumo))
        self.assertTrue(jornadas.vencida(jornada, datetime(2026, 10, 22, 14, 30), resumo))

    def test_inativa_nunca_vence(self) -> None:
        jornada = {**jornadas.validate_jornada(_linha(ativo="nao")), "ativo_bool": False}
        self.assertFalse(jornadas.vencida(jornada, datetime(2026, 10, 30), self.resumo))


class SaidasTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.saidas = Path(self.tmp.name) / "saidas"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_grava_csv_json_e_resumo(self) -> None:
        linha = jornadas.gravar_saida(_record("11111111-aaaa", ["ga4", "meta_pixel", "custom"]),
                                      agora=datetime(2026, 10, 22, 9, 30, 5), saidas_dir=self.saidas)
        pasta = self.saidas / "seguro-viagem"
        self.assertTrue((pasta / "2026-10-22_093005_11111111.csv").exists())
        self.assertTrue((pasta / "2026-10-22_093005_11111111.json").exists())
        self.assertEqual(linha["eventos"], 3)
        self.assertEqual(linha["preenchimentos"], 1)
        self.assertEqual(linha["pixels"], "ga4=1;meta_pixel=1")
        self.assertEqual(linha["tecnologias_novas"], "")
        resumo = (self.saidas / "resumo.csv").read_text(encoding="utf-8-sig")
        self.assertIn("jornada_id", resumo.splitlines()[0])
        self.assertIn("11111111-aaaa", resumo)

    def test_csv_de_eventos_tem_uma_linha_por_evento(self) -> None:
        jornadas.gravar_saida(_record("22222222-aaaa", ["ga4", "meta_pixel"]),
                              agora=datetime(2026, 10, 22, 9, 0, 0), saidas_dir=self.saidas)
        csv_path = next((self.saidas / "seguro-viagem").glob("*.csv"))
        self.assertEqual(len(csv_path.read_text(encoding="utf-8-sig").splitlines()) - 1, 2)

    def test_compara_com_execucao_anterior(self) -> None:
        jornadas.gravar_saida(_record("33333333-aaaa", ["ga4", "meta_pixel"]),
                              agora=datetime(2026, 10, 22, 8, 0, 0), saidas_dir=self.saidas)
        linha = jornadas.gravar_saida(_record("44444444-bbbb", ["ga4", "tiktok_pixel"]),
                                      agora=datetime(2026, 10, 22, 14, 0, 0), saidas_dir=self.saidas)
        self.assertEqual(linha["tecnologias_novas"], "tiktok_pixel")
        self.assertEqual(linha["tecnologias_ausentes"], "meta_pixel")

    def test_ler_resumo_filtra_por_jornada_mais_recente_primeiro(self) -> None:
        jornadas.gravar_saida(_record("55555555-aaaa", ["ga4"]), agora=datetime(2026, 10, 22, 8, 0, 0),
                              saidas_dir=self.saidas)
        jornadas.gravar_saida(_record("66666666-bbbb", ["ga4"], jid="financiamento"),
                              agora=datetime(2026, 10, 22, 9, 0, 0), saidas_dir=self.saidas)
        jornadas.gravar_saida(_record("77777777-cccc", ["ga4"]), agora=datetime(2026, 10, 22, 10, 0, 0),
                              saidas_dir=self.saidas)
        rows = jornadas.ler_resumo(self.saidas / "resumo.csv", jornada_id="seguro-viagem")
        self.assertEqual([r["execucao_id"] for r in rows], ["77777777-cccc", "55555555-aaaa"])


class PontosMetaTest(unittest.TestCase):
    def setUp(self) -> None:
        self.output = {
            "actions": [{"type": "navigate", "url": "https://x.test/a"}, {"type": "navigate", "url": "https://x.test/b/"}],
            "events": [
                {"technology": "meta_pixel", "url": "https://x.test/a?utm=1", "stateName": "a"},
                {"technology": "meta_pixel", "url": "https://x.test/a", "stateName": "a"},
                {"technology": "ga4", "url": "https://x.test/b", "stateName": "b"},
            ],
        }

    def test_status_de_cada_ponto(self) -> None:
        pontos = jornadas.verificar_pontos(self.output, {
            "ponto_pdp": "https://x.test/a",          # disparou (2 eventos, query ignorada)
            "ponto_shortform": "https://x.test/b",    # visitada, sem pixel Meta (barra final ignorada)
            "ponto_lead_intent": "https://x.test/c",  # não alcançada
        })
        self.assertEqual([p["status"] for p in pontos], ["disparou", "missing", "not_reached"])
        self.assertEqual(pontos[0]["eventos_meta"], 2)
        self.assertEqual([p["ponto"] for p in pontos], ["PDP", "Shortform", "Lead intent"])

    def test_ponto_vazio_nao_e_medido(self) -> None:
        pontos = jornadas.verificar_pontos(self.output, {"ponto_pdp": "https://x.test/a"})
        self.assertEqual(pontos[1]["status"], "")

    def test_validacao_aceita_pontos_opcionais(self) -> None:
        normalized = jornadas.validate_jornada(_linha(ponto_pdp="https://x.test/a", ponto_lead_intent="https://x.test/c"))
        self.assertEqual(normalized["ponto_pdp"], "https://x.test/a")
        self.assertEqual(normalized["ponto_shortform"], "")
        self.assertEqual(normalized["ponto_lead_intent"], "https://x.test/c")

    def test_validacao_rejeita_ponto_invalido(self) -> None:
        with self.assertRaisesRegex(ValueError, "Shortform"):
            jornadas.validate_jornada(_linha(ponto_shortform="ftp://x.test/"))

    def test_resumo_traz_status_dos_pontos(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        record = {"id": "99999999-aaaa", "url": "https://x.test/a", "status": "completed", "stopReason": "",
                  "jornadaId": "seguro-viagem", "jornadaNome": "Seguro",
                  "jornadaPontos": {"ponto_pdp": "https://x.test/a", "ponto_shortform": "https://x.test/b",
                                    "ponto_lead_intent": "https://x.test/c"},
                  "output": self.output}
        linha = jornadas.gravar_saida(record, agora=datetime(2026, 10, 22, 9, 0, 0), saidas_dir=Path(tmp.name))
        self.assertEqual(linha["ponto_pdp_meta"], "disparou")
        self.assertEqual(linha["ponto_shortform_meta"], "missing")
        self.assertEqual(linha["ponto_lead_intent_meta"], "not_reached")
        pontos_csv = next((Path(tmp.name) / "seguro-viagem").glob("*_pontos.csv"))
        self.assertEqual(len(pontos_csv.read_text(encoding="utf-8-sig").splitlines()), 4)

    def test_resumo_antigo_e_migrado_para_novo_cabecalho(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(tmp, ignore_errors=True))
        antigo = tmp / "resumo.csv"
        antigo.write_text("data_hora;jornada_id;execucao_id\n2026-10-21 10:00:00;seguro-viagem;abc\n", encoding="utf-8-sig")
        jornadas.gravar_saida({"id": "88888888-aaaa", "url": "https://x.test/", "status": "completed", "jornadaId": "seguro-viagem",
                               "output": {}}, agora=datetime(2026, 10, 22, 9, 0, 0), saidas_dir=tmp)
        rows = jornadas.ler_resumo(antigo)
        self.assertEqual(len(rows), 2)
        self.assertIn("ponto_pdp_meta", rows[0])
        self.assertEqual(rows[1]["execucao_id"], "abc")

if __name__ == "__main__":
    unittest.main()
