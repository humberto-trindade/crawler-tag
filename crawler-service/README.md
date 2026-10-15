# crawler-service

Microserviço Python para exploração de jornadas com **Camoufox** (Firefox anti-detect).

## Por que Camoufox?

O Playwright/Chromium padrão é detectado pelo Cloudflare Bot Management por:
- TLS JA3 fingerprint de Chromium é conhecido como automação
- Propriedades JS (`navigator.webdriver`, WebGL, Canvas) detectáveis mesmo com JS spoofing

Camoufox resolve isso com:
- **Firefox** (SpiderMonkey) — TLS fingerprint diferente, menos detectável
- **Spoofing em C++** — indetectável via JS da página
- **BrowserForge** — fingerprints internamente consistentes

## Setup

```bash
# Criar ambiente virtual
python -m venv venv
source venv/bin/activate  # Linux/macOS
# ou: venv\Scripts\activate  # Windows

# Instalar dependências
pip install -r requirements.txt

# Baixar Firefox modificado (~200MB)
camoufox fetch

# Rodar o serviço
uvicorn main:app --host 0.0.0.0 --port 5001 --reload
```

## Docker

```bash
docker build -t crawler-service .
docker run -p 5001:5001 crawler-service
```

## API

```
GET  /health     → status do serviço
POST /crawl      → executar exploração (recebe CrawlConfig JSON)
GET  /docs       → Swagger UI
```

### Exemplo de request

```bash
curl -X POST http://localhost:5001/crawl \
  -H "Content-Type: application/json" \
  -d '{
    "urls": [{
      "url": "https://loja.alelo.com.br/",
      "depth": 2,
      "maxActions": 60,
      "maxStates": 30,
      "allowedDomains": ["loja.alelo.com.br"],
      "singleUrlMode": false
    }],
    "templateKeys": [
      {"key": "email", "value": "teste@example.com", "matchers": {"types": ["email"]}}
    ],
    "sessionCookies": [
      {"name": "cf_clearance", "value": "TOKEN_AQUI"}
    ]
  }'
```

## Integração com Backend TypeScript

O backend TypeScript usa `CRAWLER_ENGINE=camoufox` para rotear para este serviço:

```typescript
// src/crawler/crawlerBridge.ts
const result = await fetch("http://crawler-service:5001/crawl", {
  method: "POST",
  body: JSON.stringify(config),
});
```

```yaml
# docker-compose.yml
services:
  crawler-service:
    build: ./crawler-service
    ports: ["5001:5001"]
  backend:
    environment:
      CRAWLER_ENGINE: camoufox
      CRAWLER_SERVICE_URL: http://crawler-service:5001
```

## Status de Implementação

| Funcionalidade | Status |
|---|---|
| Estrutura FastAPI | ✅ |
| Modelos Pydantic (mirrors TypeScript) | ✅ |
| Detecção de WAF/Cloudflare | ✅ |
| Injeção de cookies de sessão | ✅ |
| Detecção de tracking no HTML | ✅ |
| Screenshots por estado | ✅ |
| Fill de formulários (port de fieldMapper.ts) | 🔲 TODO |
| Detecção e clique de CTA | 🔲 TODO |
| Exploração BFS de links | 🔲 TODO |
| Detecção de mudança de estado SPA | 🔲 TODO |

> **Fase 1 implementada:** navegação + detecção de tracking + WAF handling  
> **Fase 2 (port completo):** ver `explorer.py` TODOs para implementar fill/CTA/BFS

## Referências

- [Camoufox GitHub](https://github.com/daijro/camoufox)
- [Camoufox Docs](https://camoufox.com)
- Engine TypeScript de referência: `../src/crawler/explorer.ts`
- Decisão técnica: `../docs/DECISAO_TECNICA_CAMOUFOX.md`
