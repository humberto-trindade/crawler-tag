"""Downloads dos arquivos de estados e de pontos pela API HTTP real (diretório temporário)."""

from __future__ import annotations

import csv
import io
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import app  # noqa: E402
import jornadas  # noqa: E402

EID = "5b1e9c3a-1111-4222-8333-444455556666"
URL = "https://x.test/loja/dados"


def _record() -> dict:
    estado = f"{URL} | Informe seus dados | passo 3 de 3"
    return {
        "id": EID, "url": URL, "status": "completed", "stopReason": "queue_exhausted",
        "jornadaId": "teste-estados", "jornadaNome": "Teste",
        "jornadaPontos": {"ponto_shortform": URL, "ponto_shortform_etapa": "1 de 3",
                          "ponto_lead_intent": URL, "ponto_lead_intent_etapa": "3 de 3"},
        "output": {"status": "completed", "statesDiscovered": 1, "actions": [], "warnings": [], "ignoredFields": [],
                   "events": [
                       {"technology": "meta_pixel", "eventName": "network_meta", "url": URL, "stateName": URL,
                        "eventType": "request_observed", "timestamp": "t1", "parameters": {}},
                       {"technology": "ga4", "eventName": "network_collect", "url": URL, "stateName": estado,
                        "eventType": "request_observed", "timestamp": "t2", "parameters": {}}]},
    }


class SaidasHttpTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.patches = [
            mock.patch.object(jornadas, "SAIDAS_DIR", base / "saidas"),
            mock.patch.object(jornadas, "RESUMO_PATH", base / "saidas" / "resumo.csv"),
            mock.patch.object(app, "ROOT", base),
        ]
        for patch in self.patches:
            patch.start()
        jornadas.gravar_saida(_record(), agora=datetime(2026, 10, 26, 9, 0, 0))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        for patch in self.patches:
            patch.stop()
        self.tmp.cleanup()

    def _get(self, caminho: str):
        try:
            with urllib.request.urlopen(self.base_url + caminho, timeout=10) as resposta:
                return resposta.status, resposta.read().decode("utf-8-sig")
        except urllib.error.HTTPError as erro:
            return erro.code, erro.read().decode("utf-8")

    def test_download_de_estados_traz_um_estado_por_passo(self) -> None:
        status, corpo = self._get(f"/api/saidas/{EID}/estados")
        self.assertEqual(status, 200)
        linhas = list(csv.DictReader(io.StringIO(corpo), delimiter=";"))
        self.assertEqual([(l["estado"], l["passo"], l["eventos"], l["eventos_meta"]) for l in linhas],
                         [("Informe seus dados", "3 de 3", "2", "1")])

    def test_download_de_pontos_traz_status_e_detalhe(self) -> None:
        status, corpo = self._get(f"/api/saidas/{EID}/pontos")
        self.assertEqual(status, 200)
        linhas = {l["ponto"]: l for l in csv.DictReader(io.StringIO(corpo), delimiter=";")}
        self.assertEqual(linhas["Lead intent"]["status_pixel_meta"], "disparou")
        self.assertEqual(linhas["Shortform"]["status_pixel_meta"], "criterio_nao_localizado")
        self.assertIn("Informe seus dados [3 de 3]", linhas["Shortform"]["detalhe"])

    def test_resumo_expoe_etapa_e_contagem_por_ponto(self) -> None:
        status, corpo = self._get("/api/resumo?jornada=teste-estados")
        self.assertEqual(status, 200)
        import json
        linha = json.loads(corpo)[0]
        self.assertEqual(linha["ponto_lead_intent_etapa"], "3 de 3")
        self.assertEqual(linha["ponto_lead_intent_meta"], "disparou")
        self.assertEqual(linha["ponto_lead_intent_eventos"], "1")
        self.assertEqual(linha["estados_distintos"], "1")

    def test_execucao_desconhecida_retorna_404(self) -> None:
        status, _ = self._get("/api/saidas/00000000-0000-0000-0000-000000000000/estados")
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
