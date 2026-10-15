# Crawler Tag - Cloud Run application

Aplicacao autocontida para auditar jornadas autorizadas: API Express, crawler
Playwright, interface Next.js, templates sinteticos, painel em tempo real,
historico e exportacoes.

## Persistencia desta versao

`PERSISTENCE_MODE=mock` usa um PostgreSQL embarcado somente em memoria. O
schema e os templates iniciais sao carregados no boot, sem `DATABASE_URL`,
PostgreSQL, Cloud SQL, migrations manuais ou outro banco externo.

Auditorias, execucoes, resultados e historico ficam disponiveis enquanto o
processo do backend estiver ativo. Cloud Run pode reiniciar ou escalar a
instancia para zero; nesse caso esses dados sao removidos. A integracao
BigQuery tambem esta em modo mock (`BIGQUERY_EXPORT_MODE=mock`) e nao envia
dados para a GCP.

## Execucao local

```powershell
docker compose up --build
```

Abra `http://localhost:3000`. A API responde em `http://localhost:3001`.
Nao ha etapa de provisionamento ou migration.

Use somente URLs autorizadas e dados sinteticos. WAF, CAPTCHA, login e OTP sao
registrados como limitacoes. A aplicacao nao recebe cookies de sessao nem tenta
resolver ou contornar controles de seguranca.

## Deploy no Cloud Run

Publique dois servicos independentes:

1. **Backend:** use o `Dockerfile`, com `PORT=8080`,
   `PERSISTENCE_MODE=mock`, `BIGQUERY_EXPORT_MODE=mock` e `LOG_LEVEL=info`.
   Defina concorrencia como `1`, pois a fila de execucao e interna ao processo.
2. **Frontend:** use `frontend\Dockerfile`, informando
   `NEXT_PUBLIC_API_BASE_URL` e `NEXT_PUBLIC_WS_BASE_URL` como argumentos de
   build para a URL publica do backend.

As imagens podem ser construidas com Cloud Build:

```bash
gcloud builds submit --config=cloudbuild.backend.yaml \
  --substitutions=_IMAGE_URI=REGION-docker.pkg.dev/PROJECT/REPOSITORY/crawler-tag-backend:TAG .

gcloud builds submit --config=frontend/cloudbuild.yaml \
  --substitutions=_IMAGE_URI=REGION-docker.pkg.dev/PROJECT/REPOSITORY/crawler-tag-frontend:TAG,_API_BASE_URL=https://BACKEND_URL,_WS_BASE_URL=wss://BACKEND_URL/ws \
  frontend
```

Se a auditoria exigir allowlist de origem, configure egress/VPC/Cloud NAT
aprovados fora da aplicacao. Para manter dados entre instancias, a proxima
etapa deve substituir os adaptadores mock por BigQuery real.
