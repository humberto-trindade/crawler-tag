# Crawler Tag

Auditoria automatizada de tracking client-side em jornadas web autorizadas.
O projeto explora páginas e interações com limites configuráveis, identifica
sinais de GA4, Meta Pixel e outros destinos, registra cobertura e exporta
relatórios sanitizados.

> **Uso responsável:** execute somente em domínios e jornadas para os quais
> você possui autorização. Use dados sintéticos. O projeto não resolve CAPTCHA,
> não contorna WAF, não usa cookies de sessão e não executa pagamentos,
> contratações ou outras ações irreversíveis.

## O que existe neste repositório

| Diretório | Finalidade |
| --- | --- |
| `src/` | Backend Express/TypeScript, API, crawler, observação e exportações |
| `frontend/` | Interface Next.js para configurar, acompanhar e analisar auditorias |
| `tests/` | Testes automatizados do backend |
| `migrations/` | Schema e seed para o ambiente Docker local |
| `cloud-run-app/` | Variante autocontida para Cloud Run, com persistência mock em memória |
| `portable-local/` | Distribuição experimental para Windows sem Node.js/Docker |
| `docs/` | Contexto, decisões técnicas e documentação detalhada |
| `artifacts/` | Resultados locais; ignorado pelo Git |

## Requisitos

Para o ambiente principal:

- Node.js 22 ou superior (Node.js 24 recomendado);
- Docker Desktop, para subir PostgreSQL e os serviços completos;
- Git;
- Chromium instalado pelo Playwright após a instalação das dependências.

## Executar com Docker Compose

Esta é a forma mais simples de subir backend, frontend e PostgreSQL:

```powershell
docker compose up --build
```

Abra:

- Interface: <http://localhost:3000>
- API/health: <http://localhost:3001/health>

Para encerrar e remover os containers:

```powershell
docker compose down
```

O volume `postgres_data` preserva os dados locais. Para apagar também os dados
locais, use `docker compose down -v`.

## Executar sem Docker

1. Inicie um PostgreSQL local com banco `crawler_tag` na porta `5433`, ou
   ajuste `DATABASE_URL`.
2. Instale e configure o backend:

```powershell
npm install
Copy-Item .env.example .env
npm run db:migrate
npm run dev
```

3. Em outro terminal, instale e inicie o frontend:

```powershell
Set-Location frontend
npm install
npm run dev
```

O frontend usa `http://localhost:3001` por padrão. Para outro endereço, defina
`NEXT_PUBLIC_API_BASE_URL` e `NEXT_PUBLIC_WS_BASE_URL` antes de iniciar o
frontend.

## Validação

Backend:

```powershell
npm run build
npm test
```

Frontend:

```powershell
Set-Location frontend
npm run typecheck
npm run build
```

## Variante `cloud-run-app`

`cloud-run-app/` é uma aplicação autocontida para testes de imagem e execução
no Cloud Run. Ela usa PGlite em memória e, portanto, perde auditorias e
execuções quando o processo reinicia ou escala para zero. A integração com
BigQuery permanece desabilitada/mock nesta versão.

Para executar localmente essa variante:

```powershell
Set-Location cloud-run-app
docker compose up --build
```

Consulte [`cloud-run-app/README.md`](cloud-run-app/README.md) antes de
publicar imagens ou configurar serviços.

## Dados e privacidade

Não versione `.env`, cookies, tokens, credenciais, payloads brutos, PII,
logs, screenshots ou relatórios de execução. Use apenas valores sintéticos e
evidências sanitizadas. Resultados locais devem ser gravados em `artifacts/`
ou nas pastas de execução ignoradas pelo Git.

## Documentação

- [`docs/project.md`](docs/project.md): visão do produto e arquitetura;
- [`docs/implementation-plan.md`](docs/implementation-plan.md): escopo e
  critérios técnicos;
- [`docs/README.md`](docs/README.md): índice da documentação de trabalho;
- [`portable-local/README.md`](portable-local/README.md): distribuição
  experimental para Windows.

## Licença

Este repositório ainda não declara uma licença open source. Até que uma
licença seja escolhida, a publicação do código não concede permissões
adicionais além das previstas por lei.
