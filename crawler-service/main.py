"""
FastAPI server para o crawler-service Camoufox.
Expõe endpoints para o backend TypeScript consumir via HTTP.

Uso:
  uvicorn main:app --host 0.0.0.0 --port 5001
  
  # Ou com Docker:
  docker build -t crawler-service .
  docker run -p 5001:5001 crawler-service
"""
from __future__ import annotations

import os
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from models import CrawlConfig, CrawlOutput
from explorer import explore_journeys

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("crawler-service")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("crawler-service iniciando (engine: camoufox)")
    yield
    logger.info("crawler-service encerrando")


app = FastAPI(
    title="Crawler Service (Camoufox)",
    description="Microserviço de exploração de jornadas com Camoufox (Firefox anti-detect)",
    version="1.0.0",
    lifespan=lifespan,
)


@app.get("/health")
def health():
    """Health check para o backend TypeScript e Docker healthcheck."""
    return {
        "status": "ok",
        "engine": "camoufox",
        "version": "1.0.0",
    }


@app.post("/crawl", response_model=CrawlOutput)
async def crawl(config: CrawlConfig) -> CrawlOutput:
    """
    Executa uma exploração de jornada com Camoufox.
    
    O backend TypeScript chama este endpoint em vez de rodar o Playwright
    diretamente quando CRAWLER_ENGINE=camoufox.
    """
    logger.info(f"Iniciando crawl: {[u.url for u in config.urls]}")
    try:
        result = await explore_journeys(config)
        logger.info(
            f"Crawl finalizado: status={result.status} "
            f"events={len(result.events)} actions={len(result.actions)} "
            f"states={result.states_discovered}"
        )
        return result
    except Exception as exc:
        logger.exception("Erro no crawl")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/")
def root():
    return {"service": "crawler-service", "engine": "camoufox", "docs": "/docs"}
