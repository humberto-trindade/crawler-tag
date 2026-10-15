# Projeto

> Documento vivo. Pode começar com visão comercial/produto e ganhar detalhe técnico à medida que a solução evolui.

## Visão de produto

### Problema e proposta de valor

Automatizar a auditoria de tracking client-side em jornadas digitais para reduzir esforço manual, aumentar cobertura de navegação (incluindo SPA/interações) e gerar diagnóstico acionável para analistas de mensuração.

### Público e contexto

Usuário primário: analista de mensuração/analytics em contexto single-tenant MVP.
Escopo foca jornadas web autorizadas com dados sintéticos e evidências sanitizadas.

### Escopo atual

- Backend, frontend, crawler HTTP (BFS), observador de sinais básicos e exportação inicial implementados.
- MVP single-tenant (sem RBAC/SSO).
- Execução com status, pausa/retomada e histórico de versões por auditoria.

## Visão técnica

### Stack

- Node.js 24
- TypeScript (strict)
- Express 5
- WebSocket (`ws`)
- PostgreSQL (driver `pg`)
- Logging estruturado com `pino` + `pino-http`
- Validação de ambiente com `zod`
- Next.js 15 + React 18 + Tailwind CSS (frontend)
- Docker / Docker Compose para ambiente local

### Arquitetura

Backend organizado em:
- `src/config`: ambiente, logger e conexão de banco
- `src/api`: rotas HTTP (`/health`, `audits`, `templates`, `executions`)
- `src/services`: regras de domínio (CRUD, orquestração, exportação)
- `src/crawler`: exploração BFS e mapeamento determinístico de campos
- `src/realtime`: publicação de eventos de execução via WebSocket
- `src/app.ts`: composição de middlewares e rotas
- `src/server.ts`: bootstrap e lifecycle do servidor

Frontend organizado em:
- `frontend/app`: páginas (wizard, execução, análise, histórico)
- `frontend/components`: componentes de UX principal
- `frontend/lib`: cliente HTTP/WS

### Execução local

1. `npm install`
2. Copiar `.env.example` para `.env` e ajustar `DATABASE_URL`
3. `npm run db:migrate`
4. `npm run dev` (backend)
5. `npm run build` (backend)
6. `npm test` (backend)
7. `cd frontend && npm install && npm run dev`

### Ambientes e configuração

Variáveis obrigatórias no backend:
- `NODE_ENV` (`development|test|production`)
- `PORT` (número da porta HTTP)
- `DATABASE_URL` (URL PostgreSQL)
- `LOG_LEVEL` (`fatal|error|warn|info|debug|trace`)

Não versionar `.env` com credenciais reais.

### CI/CD e operação

Pipelines ainda não implementados.
CI implementado em `.github/workflows/ci.yml` (backend migrate/build/test + frontend typecheck/build).
Observabilidade via logs estruturados, endpoint `/health` e canal `/ws`.

### Segurança e privacidade

Redaction de `authorization`/`cookie` no logger.
Sem persistência de tokens/segredos em código ou documentação.
