"""Executa as jornadas monitoradas cujo intervalo já venceu.

Uso (na pasta portable-local):
    python executar_jornadas.py                 # todas as ativas vencidas
    python executar_jornadas.py --so seguro-viagem   # só uma jornada (respeita o intervalo)
    python executar_jornadas.py --forcar seguro-viagem   # ignora o intervalo

Pensado para o Agendador de Tarefas do Windows: rodar de hora em hora. Cada jornada gera
saidas/<jornada>/<data_hora>_<execucao>.csv|json e uma linha em saidas/resumo.csv.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import app  # noqa: E402  (configura logging do kit)
import jornadas  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Executa jornadas monitoradas vencidas")
    parser.add_argument("--so", help="executa só esta jornada (id), respeitando o intervalo")
    parser.add_argument("--forcar", help="executa esta jornada agora, ignorando o intervalo")
    args = parser.parse_args()

    agora = datetime.now()
    executadas = 0
    for jornada in jornadas.listar_jornadas():
        jid = jornada["id"]
        if args.forcar and jid != args.forcar:
            continue
        if args.so and jid != args.so:
            continue
        if not args.forcar and not jornadas.vencida(jornada, agora):
            motivo = "inativa" if not jornada.get("ativo_bool") else f"intervalo de {jornada['intervalo_horas']} h ainda não passou"
            print(f"[{jid}] pulando: {motivo}")
            continue
        print(f"[{jid}] executando {jornada['url']}")
        execution_id, config = app.create_execution({"jornadaId": jid})
        app.run_execution(execution_id, config)
        linha = jornadas.ler_resumo(jornada_id=jid)[0]
        print(f"[{jid}] {linha['status']} | estados {linha['estados']} | eventos {linha['eventos']} | "
              f"novas {linha['tecnologias_novas'] or '-'} | ausentes {linha['tecnologias_ausentes'] or '-'}")
        executadas += 1
    if executadas == 0:
        print("nenhuma jornada para executar agora")
    return 0


if __name__ == "__main__":
    sys.exit(main())
