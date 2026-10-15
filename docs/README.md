# Documentação de trabalho

Esta pasta contém o contexto mínimo que todos os agentes devem usar.

## Entrega para cliente

- `DOCUMENTACAO_CLIENTE_VERSAO_COMPLETA.html` — documentação executiva,
  visual e técnica enxuta da versão completa planejada, incluindo Sheets,
  espelhamento no BigQuery, execução três vezes ao dia, dashboard,
  notificações e cronograma de cinco dias úteis. O arquivo é autocontido,
  abre diretamente no navegador e pode ser impresso/salvo como PDF.
- `PLANILHA_ENTRADA_AUDITORIA_TRACKING.xlsx` — modelo de entrada importável no
  Google Sheets, com abas de instruções, cadastro de jornadas, acompanhamento
  de resultados e resumo. A aba de resultados/resumo depende da futura
  integração com BigQuery para atualização automática.

## Quem cria o quê?

| Arquivo | Quem inicia | Quem mantém |
|---|---|---|
| `brief.md` | Usuário | Usuário, com sugestões dos agentes |
| `user-story.md` | Usuário | Usuário e CX |
| `cx.md` | Agente CX, a partir do brief e user story | CX; usuário aprova decisões relevantes |
| `implementation-plan.md` | Solution Planner | Planner e orquestrador |
| `validation.md` | QA Adversary | QA e Test Executor |
| `progress.md` | Agente principal ou usuário | Durante toda a execução |
| `project.md` | Usuário/agente principal | Durante e ao final do projeto |

## Fluxo curto

1. Preencha `brief.md` e `user-story.md`.
2. Chame o `solution-planner`.
3. Chame o `cx-journey-architect`.
4. Peça ao planner para revisar o plano se CX alterou escopo ou requisitos.
5. Implemente.
6. Chame o `qa-adversary`.
7. Chame o `test-executor`.
8. Chame novamente o QA para revisar as evidências.

## Regra

Use os arquivos existentes. Não crie uma estrutura maior até haver uma dor concreta que ela resolva.
