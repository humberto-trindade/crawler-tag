"""Worker falso para testar o watchdog de app.py sem navegador.

O modo vem de config["mode"]:
  done        -> progresso, uma linha com bytes inválidos em UTF-8, resultado
  hang        -> progresso e depois trava (simula JS da página em laço)
  hang_with_pending -> como hang, mas com snapshot que lista URLs pendentes
  stop_aware  -> sai com resultado quando o stop-file aparece
  ignore_stop -> ignora o stop-file e trava
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

MESSAGE_PREFIX = "@@ENGINE "


def _emit(kind: str, payload: object) -> None:
    line = json.dumps({"kind": kind, "payload": payload}, ensure_ascii=True)
    sys.stdout.write(MESSAGE_PREFIX + line + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--stop-file", required=True)
    parser.add_argument("--log-file", required=True)
    args = parser.parse_args()
    mode = json.loads(Path(args.config).read_text(encoding="utf-8")).get("mode", "done")
    stop_file = Path(args.stop_file)

    _emit("progress", {"phase": "starting", "message": "Iniciando exploração em navegador real"})
    if mode == "hang_with_pending":
        _emit("snapshot", {"actions": [], "events": [], "ignoredFields": [], "warnings": [],
                           "statesDiscovered": 1, "stateScreenshots": {},
                           "visitedUrls": ["https://x.test/"],
                           "pendingQueue": [{"url": "https://x.test/pendente", "depth": 1, "maxDepth": 1,
                                             "allowedDomains": ["x.test"], "maxActions": 5, "maxStates": 5,
                                             "singleUrlMode": False}]})
        time.sleep(120)
        return 0
    if mode == "hang":
        time.sleep(120)
        return 0
    if mode == "ignore_stop":
        time.sleep(120)
        return 0
    if mode == "stop_aware":
        while not stop_file.exists():
            time.sleep(0.2)
        _emit("result", _empty_output("cancelled:interrompido pelo operador"))
        return 0

    # done: linha com bytes que não são UTF-8 válido; o servidor não pode parar de ler por isso
    sys.stdout.buffer.write(MESSAGE_PREFIX.encode("ascii") + b'{"kind": "progress", "payload": {"message": "explora\xe7\xe3o"}}\n')
    sys.stdout.flush()
    _emit("result", _empty_output("queue_exhausted:exploração completa"))
    return 0


def _empty_output(stop_reason: str) -> dict:
    return {"status": "completed", "stopReason": stop_reason, "actions": [], "events": [],
            "ignoredFields": [], "warnings": [], "statesDiscovered": 0, "stateScreenshots": {}}


if __name__ == "__main__":
    sys.exit(main())
