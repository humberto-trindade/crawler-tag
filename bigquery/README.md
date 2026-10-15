# BigQuery Integration

Esta pasta contém tudo necessário para exportar os dados da auditoria do PostgreSQL local para o Google BigQuery.

## Estrutura

```
bigquery/
├── schemas/
│   ├── executions.json   ← schema da tabela de execuções
│   └── events.json       ← schema da tabela de eventos (principal)
├── bigquery.config.example.json  ← template de config (copie e preencha)
└── README.md
```

## Configuração Inicial

### 1. Variáveis de ambiente

Adicione ao seu `.env`:

```env
# BigQuery (opcional — só necessário para exportação)
BIGQUERY_PROJECT_ID=seu-projeto-gcp
BIGQUERY_DATASET_ID=crawler_tag_audit
BIGQUERY_LOCATION=US
BIGQUERY_KEY_FILE=/caminho/para/service-account-key.json
# OU use Application Default Credentials (recomendado em GCP)
BIGQUERY_USE_ADC=true
```

### 2. Criar dataset e tabelas no BigQuery

```bash
# Via bq CLI
bq mk --location=US crawler_tag_audit

bq mk --table \
  --schema bigquery/schemas/events.json \
  --time_partitioning_field event_date \
  --clustering_fields audit_id,technology,event_type \
  crawler_tag_audit.events

bq mk --table \
  --schema bigquery/schemas/executions.json \
  crawler_tag_audit.executions
```

### 3. Autenticação

**Opção A — Service Account (recomendado para produção):**
1. Crie uma Service Account no GCP com permissão `BigQuery Data Editor`
2. Baixe o JSON da chave
3. Defina `BIGQUERY_KEY_FILE` no `.env`

**Opção B — Application Default Credentials (recomendado localmente):**
```bash
gcloud auth application-default login
```

## Como exportar

```bash
# Exportar execução específica
npm run bq:export -- --execution-id <uuid>

# Exportar todas execuções pendentes (não exportadas)
npm run bq:export

# Dry-run (mostra o que seria exportado sem gravar)
npm run bq:export -- --dry-run
```

## Modelo de dados no BigQuery

### Tabela `events` (principal)

Particionada por `event_date` e clusterizada por `audit_id`, `technology`, `event_type`.

**Query histórica — eventos por dia:**
```sql
SELECT
  event_date,
  audit_name,
  technology,
  event_name,
  COUNT(*) AS total
FROM `projeto.crawler_tag_audit.events`
WHERE audit_id = 'UUID_DA_AUDITORIA'
  AND event_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY) AND CURRENT_DATE()
GROUP BY 1,2,3,4
ORDER BY event_date DESC, total DESC
```

**Query de comparação — eventos de hoje vs ontem:**
```sql
WITH today AS (
  SELECT event_name, technology, COUNT(*) AS n
  FROM `projeto.crawler_tag_audit.events`
  WHERE event_date = CURRENT_DATE() AND audit_id = 'UUID'
  GROUP BY 1,2
),
yesterday AS (
  SELECT event_name, technology, COUNT(*) AS n
  FROM `projeto.crawler_tag_audit.events`
  WHERE event_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY) AND audit_id = 'UUID'
  GROUP BY 1,2
)
SELECT
  COALESCE(t.event_name, y.event_name) AS event_name,
  COALESCE(t.technology, y.technology) AS technology,
  COALESCE(t.n, 0) AS today_count,
  COALESCE(y.n, 0) AS yesterday_count,
  COALESCE(t.n, 0) - COALESCE(y.n, 0) AS delta
FROM today t
FULL OUTER JOIN yesterday y USING (event_name, technology)
ORDER BY ABS(COALESCE(t.n,0) - COALESCE(y.n,0)) DESC
```

**Query de novos eventos (apareceram hoje, não estavam ontem):**
```sql
SELECT event_name, technology, COUNT(*) AS total
FROM `projeto.crawler_tag_audit.events`
WHERE event_date = CURRENT_DATE() AND audit_id = 'UUID'
  AND event_name NOT IN (
    SELECT DISTINCT event_name
    FROM `projeto.crawler_tag_audit.events`
    WHERE event_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY) AND audit_id = 'UUID'
  )
GROUP BY 1,2
```

**Query de eventos que sumiram:**
```sql
SELECT event_name, technology
FROM `projeto.crawler_tag_audit.events`
WHERE event_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY) AND audit_id = 'UUID'
  AND event_name NOT IN (
    SELECT DISTINCT event_name
    FROM `projeto.crawler_tag_audit.events`
    WHERE event_date = CURRENT_DATE() AND audit_id = 'UUID'
  )
GROUP BY 1,2
```

## Segurança

- **Nunca commite** `bigquery.config.json` (está no .gitignore)
- **Nunca commite** arquivos de chave de Service Account
- Os campos `parameters` exportados já são sanitizados (sem PII)
- Adicione `bigquery/*.json` ao `.gitignore` exceto `bigquery.config.example.json`
