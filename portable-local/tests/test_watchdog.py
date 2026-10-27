"""Regressão do processo do motor e do watchdog em app.py (sem navegador).

Usa tests/fake_worker.py no lugar de motor.worker (CRAWLER_WORKER_MODULE).
"""

from __future__ import annotations

import os
import sys
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import app  # noqa: E402  (configura logging do servidor; não sobe o HTTP)

FAKE_MODULE = "tests.fake_worker"


class WorkerWatchdogTest(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = (app.WORKER_NO_PROGRESS_S, app.WORKER_STOP_GRACE_S)
        os.environ["CRAWLER_WORKER_MODULE"] = FAKE_MODULE

    def tearDown(self) -> None:
        app.WORKER_NO_PROGRESS_S, app.WORKER_STOP_GRACE_S = self._saved
        os.environ.pop("CRAWLER_WORKER_MODULE", None)

    def _run(self, mode: str, stop_event: threading.Event | None = None):
        return app._run_worker("teste-" + mode, {"mode": mode}, {}, stop_event or threading.Event())

    def test_resultado_normal_com_linha_de_bytes_invalidos(self) -> None:
        output, error, watchdog = self._run("done")
        self.assertIsNone(error)
        self.assertIsNone(watchdog)
        self.assertEqual(output["stopReason"], "queue_exhausted:exploração completa")

    def test_watchdog_encerra_motor_travado(self) -> None:
        app.WORKER_NO_PROGRESS_S = 3
        started = time.monotonic()
        output, error, watchdog = self._run("hang")
        elapsed = time.monotonic() - started
        self.assertIsNone(error)
        self.assertTrue(watchdog and watchdog.startswith("watchdog_sem_progresso"), watchdog)
        self.assertLess(elapsed, 60, "o processo travado deve ser encerrado pelo watchdog")

    def test_parada_do_operador_respeitada(self) -> None:
        stop = threading.Event()
        threading.Timer(1.0, stop.set).start()
        output, error, watchdog = self._run("stop_aware", stop)
        self.assertIsNone(error)
        self.assertIsNone(watchdog)
        self.assertEqual(output["stopReason"], "cancelled:interrompido pelo operador")

    def test_parada_ignorada_vira_watchdog(self) -> None:
        app.WORKER_STOP_GRACE_S = 2
        app.WORKER_NO_PROGRESS_S = 60
        stop = threading.Event()
        stop.set()
        output, error, watchdog = self._run("ignore_stop", stop)
        self.assertTrue(watchdog and watchdog.startswith("cancelled:"), watchdog)


class ResumeAfterWatchdogTest(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = app.WORKER_NO_PROGRESS_S
        os.environ["CRAWLER_WORKER_MODULE"] = FAKE_MODULE
        app.WORKER_NO_PROGRESS_S = 3

    def tearDown(self) -> None:
        app.WORKER_NO_PROGRESS_S = self._saved
        os.environ.pop("CRAWLER_WORKER_MODULE", None)

    def test_merge_soma_tentativas(self) -> None:
        carry = {"actions": [1], "events": [1, 2], "ignoredFields": [], "warnings": [], "visitedUrls": ["a"],
                 "statesDiscovered": 2, "stateScreenshots": {"s1": "x"}}
        partial = {"actions": [2, 3], "events": [], "ignoredFields": [], "warnings": [{"m": 1}],
                   "visitedUrls": ["b"], "statesDiscovered": 1, "stateScreenshots": {"s2": "y"},
                   "status": "completed", "stopReason": "queue_exhausted:exploração completa"}
        merged = app._merge_partial(carry, partial)
        self.assertEqual(merged["actions"], [1, 2, 3])
        self.assertEqual(merged["events"], [1, 2])
        self.assertEqual(merged["statesDiscovered"], 3)
        self.assertEqual(merged["visitedUrls"], ["a", "b"])
        self.assertEqual(merged["stateScreenshots"], {"s1": "x", "s2": "y"})
        self.assertEqual(merged["stopReason"], "queue_exhausted:exploração completa")

    def test_resume_usa_orcamento_restante_e_pula_visitadas(self) -> None:
        config = {"urls": [{"url": "https://x.test/", "depth": 1, "maxActions": 60, "maxStates": 30,
                            "allowedDomains": ["x.test"]}], "templateKeys": [], "browserMode": "headless"}
        merged = {"actions": [0] * 10, "statesDiscovered": 4, "visitedUrls": ["https://x.test/"]}
        pending = [{"url": "https://x.test/pendente", "maxDepth": 1, "allowedDomains": ["x.test"],
                    "singleUrlMode": False}]
        resumed = app._resume_config(config, merged, pending)
        self.assertEqual(resumed["urls"][0]["maxActions"], 50)
        self.assertEqual(resumed["urls"][0]["maxStates"], 26)
        self.assertEqual(resumed["skipUrls"], ["https://x.test/"])

    def test_execucao_para_depois_de_no_maximo_duas_retomadas(self) -> None:
        from unittest import mock

        record = {"id": "retomada-teste", "status": "queued", "progress": None, "output": None}
        app.EXECUTIONS[record["id"]] = record
        app.STOP_EVENTS[record["id"]] = threading.Event()
        config = {"urls": [{"url": "https://x.test/", "depth": 1, "maxActions": 60, "maxStates": 30,
                            "allowedDomains": ["x.test"]}], "templateKeys": [], "browserMode": "headless",
                  "mode": "hang_with_pending"}
        with mock.patch.object(app, "save_execution"), mock.patch.object(app, "write_exports"), \
                mock.patch.object(app, "_run_worker", wraps=app._run_worker) as run_worker:
            app.run_execution(record["id"], config)
        self.assertEqual(run_worker.call_count, 1 + app.WORKER_MAX_RESTARTS)
        self.assertEqual(record["status"], "completed")
        self.assertTrue(record["stopReason"].startswith("watchdog_sem_progresso"), record["stopReason"])
        retries = [w for w in record["output"]["warnings"] if "retomando" in w["message"]]
        self.assertEqual(len(retries), app.WORKER_MAX_RESTARTS)
        app.EXECUTIONS.pop(record["id"], None)
        app.STOP_EVENTS.pop(record["id"], None)


if __name__ == "__main__":
    unittest.main()
