"""Roda o motor em processo separado (python -m motor.worker).

O servidor (app.py) inicia este processo para poder encerrá-lo quando o navegador
travar dentro de uma chamada que o limite por URL não alcança (ex.: JS da página
em laço). Mensagens vão para stdout, uma por linha, prefixadas por MESSAGE_PREFIX.
Parada cooperativa: o servidor cria o arquivo de stop-file e o motor sai entre etapas.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from .explorer import explore_journeys

MESSAGE_PREFIX = "@@ENGINE "


class StopFlag:
    def __init__(self, path: Path) -> None:
        self.path = path

    def is_set(self) -> bool:
        return self.path.exists()


def _emit(kind: str, payload: object) -> None:
    # ensure_ascii: a linha fica ASCII, sem depender da codificação do console (cp1252 no Windows)
    line = json.dumps({"kind": kind, "payload": payload}, ensure_ascii=True)
    sys.stdout.write(MESSAGE_PREFIX + line + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--stop-file", required=True)
    parser.add_argument("--log-file", required=True)
    args = parser.parse_args()

    logging.basicConfig(
        filename=args.log_file,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        encoding="utf-8",
    )
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    try:
        output = explore_journeys(
            config,
            lambda progress: _emit("progress", progress),
            lambda snapshot: _emit("snapshot", snapshot),
            StopFlag(Path(args.stop_file)),
        )
        _emit("result", output)
        return 0
    except Exception as error:
        logging.getLogger("crawler-tag-portable").exception("motor falhou no processo filho")
        _emit("error", f"{type(error).__name__}: {error}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
