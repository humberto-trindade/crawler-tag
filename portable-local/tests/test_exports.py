"""Regressão dos relatórios e downloads (PDF, CSV, JSON, HTML) pela API HTTP real.

Usa uma porta livre e uma execução em memória; os arquivos gerados em exports/ são removidos ao final.
"""

from __future__ import annotations

import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import app  # noqa: E402

EID = "3f2a9c1e-7b4d-4e8a-9c2f-0a1b2c3d4e5f"  # id no formato aceito pelo roteador (hex)


def _record(extra_techs: int = 0) -> dict:
    events = [
        {"eventType": "request_observed", "technology": "meta_pixel", "eventName": "network_meta",
         "stateName": "estado-a", "url": "https://x.test/", "status": "observed", "consentState": "after_consent",
         "timestamp": "2026-10-21T10:00:00Z", "actionId": "a1", "parameters": {"id": "123"}},
        {"eventType": "request_observed", "technology": "meta_pixel", "eventName": "network_meta",
         "stateName": "estado-b", "url": "https://x.test/b", "status": "observed", "consentState": "after_consent",
         "timestamp": "2026-10-21T10:00:01Z", "actionId": "a2", "parameters": {"token": "[redacted]"}},
        {"eventType": "tag_detected", "technology": "ga4", "eventName": "ga4_tag_detected",
         "stateName": "estado-a", "url": "https://x.test/", "status": "observed", "consentState": "before_consent",
         "timestamp": "2026-10-21T10:00:02Z", "actionId": "a1", "parameters": {}},
        {"eventType": "state_snapshot", "technology": "custom", "eventName": "ui_state_snapshot",
         "stateName": "estado-a", "url": "https://x.test/", "status": "observed", "consentState": "before_consent",
         "timestamp": "2026-10-21T10:00:03Z", "actionId": "a1", "parameters": {}},
    ]
    events += [
        {"eventType": "tag_detected", "technology": f"tecnologia_{i}", "eventName": f"evento_{i}",
         "stateName": "estado-c", "url": "https://x.test/c", "status": "observed", "consentState": "before_consent",
         "timestamp": "2026-10-21T10:00:04Z", "actionId": "a3", "parameters": {}}
        for i in range(extra_techs)
    ]
    return {
        "id": EID, "url": "https://x.test/", "status": "completed", "stopReason": "queue_exhausted:exploração completa",
        "output": {"status": "completed", "actions": [{"id": "a1"}], "events": events, "ignoredFields": [],
                   "warnings": [], "statesDiscovered": 3, "stateScreenshots": {}},
    }


class PdfTest(unittest.TestCase):
    def test_pdf_lista_pixels_e_ignora_eventos_custom(self) -> None:
        pdf = app.render_pdf(_record()).decode("latin-1")
        self.assertTrue(pdf.startswith("%PDF-1.4"))
        self.assertTrue(pdf.rstrip().endswith("%%EOF"))
        self.assertIn("meta_pixel: 2 eventos em 2 nomes de estado", pdf)
        self.assertIn("ga4: 1 evento em 1 nome de estado", pdf)
        self.assertNotIn("ui_state_snapshot", pdf)
        self.assertNotIn("custom:", pdf)

    def test_pdf_pagina_quando_passa_de_uma_pagina(self) -> None:
        pdf = app.render_pdf(_record(extra_techs=120)).decode("latin-1")
        pages = pdf.count("/Type /Page /")
        self.assertGreaterEqual(pages, 3)
        self.assertIn(f"/Count {pages}", pdf)


class DownloadTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self) -> None:
        app.EXECUTIONS[EID] = _record()
        app.write_exports(app.EXECUTIONS[EID])

    def tearDown(self) -> None:
        app.EXECUTIONS.pop(EID, None)
        for ext in ("json", "csv", "html", "pdf"):
            (app.EXPORT_DIR / f"execution-{EID}.{ext}").unlink(missing_ok=True)

    def _get(self, path: str):
        try:
            with urllib.request.urlopen(self.base + path, timeout=10) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.headers, error.read()

    def test_download_pdf(self) -> None:
        status, headers, body = self._get(f"/api/executions/{EID}/export?format=pdf")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/pdf")
        self.assertIn("attachment", headers["Content-Disposition"])
        self.assertTrue(body.startswith(b"%PDF-1.4"))

    def test_download_csv_uma_linha_por_evento(self) -> None:
        status, headers, body = self._get(f"/api/executions/{EID}/export?format=csv")
        self.assertEqual(status, 200)
        self.assertTrue(headers["Content-Type"].startswith("text/csv"))
        lines = body.decode("utf-8").strip().splitlines()
        self.assertEqual(lines[0].split(",")[1], "technology")
        self.assertEqual(len(lines) - 1, len(app.EXECUTIONS[EID]["output"]["events"]))

    def test_download_json_e_relatorio_html(self) -> None:
        status, _, body = self._get(f"/api/executions/{EID}/export?format=json")
        self.assertEqual(status, 200)
        self.assertIn(b'"stopReason"', body)
        status, headers, body = self._get(f"/api/executions/{EID}/report")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["Content-Type"])
        self.assertIn("Pixels e tags detectados", body.decode("utf-8"))
        self.assertIn("meta_pixel", body.decode("utf-8"))

    def test_formato_invalido(self) -> None:
        status, _, _ = self._get(f"/api/executions/{EID}/export?format=xlsx")
        self.assertEqual(status, 400)

    def test_exports_desligados_retornam_404(self) -> None:
        with mock.patch.object(app, "EXPORTS_ENABLED", False):
            status, _, body = self._get(f"/api/executions/{EID}/export?format=pdf")
            self.assertEqual(status, 404)
            self.assertIn(b"exports_disabled", body)
            status, _, _ = self._get(f"/api/executions/{EID}/report")
            self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
