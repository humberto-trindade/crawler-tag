"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiRequest, wsBaseUrl } from "../lib/api";

type Execution = {
  id: string;
  status: string;
  platform: string;
  environment: string;
  pauseCheckpoint?: { url?: string; reason?: string } | null;
  ignoredFields: Array<{ fieldName: string; reason: string }>;
  warnings: Array<{ type: string; message: string }>;
  results?: { eventsCount?: number; statesCount?: number; actionsCount?: number };
};

type ProgressState = {
  phase: string;
  currentUrl: string;
  queuedUrls: number;
  actionsCount: number;
  eventsCount: number;
  statesDiscovered: number;
  visitedUrls: string[];
  message: string;
  lastUpdate: string;
};

type WsPayload = {
  executionId: string;
  type: "status" | "warning" | "progress";
  data: Record<string, unknown>;
};

type DashboardProps = {
  auditId: string;
  initialExecution: Execution;
};

export function ExecutionDashboard({ auditId, initialExecution }: DashboardProps) {
  const [execution, setExecution] = useState<Execution>(initialExecution);
  const [events, setEvents] = useState<Array<Record<string, unknown>>>([]);
  const [socketState, setSocketState] = useState("connecting");
  const [progress, setProgress] = useState<ProgressState | null>(null);

  const refreshSnapshot = async () => {
    const [current, currentEvents] = await Promise.all([
      apiRequest<Execution>(`/api/audits/${auditId}/executions/${initialExecution.id}`),
      apiRequest<Array<Record<string, unknown>>>(
        `/api/audits/${auditId}/executions/${initialExecution.id}/events?limit=10&sort=desc`,
      ),
    ]);
    setExecution(current);
    setEvents(currentEvents.slice(0, 10));
  };

  useEffect(() => {
    const socket = new WebSocket(`${wsBaseUrl}?executionId=${initialExecution.id}`);
    socket.onopen = () => setSocketState("connected");
    socket.onclose = () => setSocketState("closed");
    socket.onmessage = async (event) => {
      const payload = JSON.parse(event.data) as WsPayload;
      if (payload.type === "progress") {
        setProgress({
          phase: String(payload.data.phase ?? ""),
          currentUrl: String(payload.data.currentUrl ?? ""),
          queuedUrls: Number(payload.data.queuedUrls ?? 0),
          actionsCount: Number(payload.data.actionsCount ?? 0),
          eventsCount: Number(payload.data.eventsCount ?? 0),
          statesDiscovered: Number(payload.data.statesDiscovered ?? 0),
          visitedUrls: Array.isArray(payload.data.visitedUrls)
            ? payload.data.visitedUrls.map((item) => String(item))
            : [],
          message: String(payload.data.message ?? ""),
          lastUpdate: new Date().toISOString(),
        });
        return;
      }
      await refreshSnapshot();
    };
    return () => socket.close();
  }, [auditId, initialExecution.id]);

  useEffect(() => {
    void refreshSnapshot();
  }, [auditId, initialExecution.id]);

  useEffect(() => {
    if (!["running", "queued"].includes(execution.status)) return;
    const handle = setInterval(() => {
      void refreshSnapshot();
    }, 6000);
    return () => clearInterval(handle);
  }, [execution.status]);

  const statusLabel = useMemo(() => {
    if (execution.status === "running") return "Em execução";
    if (execution.status === "paused") return "Pausada";
    if (execution.status === "completed") return "Concluída";
    if (execution.status === "queued") return "Na fila";
    return execution.status;
  }, [execution.status]);
  const captchaWarning = useMemo(
    () => (execution.warnings ?? []).find((warning) => warning.type === "captcha") ?? null,
    [execution.warnings],
  );
  const captchaUrl = useMemo(() => {
    const fromCheckpoint = execution.pauseCheckpoint?.url?.trim();
    if (fromCheckpoint) return fromCheckpoint;
    const fromWarning = captchaWarning?.message.match(/https?:\/\/[^\s)]+/i)?.[0];
    if (fromWarning) return fromWarning;
    return progress?.currentUrl ?? "";
  }, [execution.pauseCheckpoint?.url, captchaWarning?.message, progress?.currentUrl]);

  const pause = async () => {
    await apiRequest(`/api/audits/${auditId}/executions/${initialExecution.id}/pause`, { method: "PATCH" });
    const current = await apiRequest<Execution>(`/api/audits/${auditId}/executions/${initialExecution.id}`);
    setExecution(current);
  };

  const resume = async () => {
    await apiRequest(`/api/audits/${auditId}/executions/${initialExecution.id}/resume`, { method: "PATCH" });
    const current = await apiRequest<Execution>(`/api/audits/${auditId}/executions/${initialExecution.id}`);
    setExecution(current);
  };

  return (
    <section className="space-y-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Execução em andamento</h1>
          <p className="text-sm text-slate-600">
            Status: <strong>{statusLabel}</strong> • Socket: {socketState}
          </p>
          <p className="text-xs text-slate-500">ID técnico: {execution.id}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/" className="rounded border px-3 py-2">
            Voltar para início
          </Link>
          <Link href={`/audits/${auditId}/history`} className="rounded border px-3 py-2">
            Ver histórico
          </Link>
          <button className="rounded border px-3 py-2" type="button" onClick={pause}>
            Pausar
          </button>
          <button className="rounded border px-3 py-2" type="button" onClick={resume}>
            Retomar
          </button>
          <Link
            href={`/audits/${auditId}/analysis/${execution.id}`}
            className="rounded bg-slate-900 px-3 py-2 text-white"
          >
            Analisar
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-3 gap-3 text-sm">
        <div className="rounded border p-3">Ambiente: {execution.environment}</div>
        <div className="rounded border p-3">Plataforma: {execution.platform}</div>
        <div className="rounded border p-3">
          Eventos: {progress?.eventsCount ?? execution.results?.eventsCount ?? events.length}
        </div>
      </div>

      <section className="space-y-3 rounded border border-slate-200 bg-slate-50 p-4">
        <h2 className="font-medium">Status em tempo real</h2>
        {(execution.status === "paused" && captchaWarning) && (
          <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">
            <p className="font-medium text-amber-900">CAPTCHA detectado: intervenção necessária</p>
            <p className="mt-1 text-amber-800">
              Abra a página bloqueada e, se o desafio estiver visível, resolva antes de clicar em <strong>Retomar</strong>.
            </p>
            <p className="mt-1 text-xs text-amber-700">
              Observação: alguns desafios são condicionais de sessão e podem não aparecer ao abrir a URL fora do contexto original.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {captchaUrl && (
                <a
                  href={captchaUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded border border-amber-400 bg-white px-3 py-2 text-xs text-amber-900"
                >
                  Abrir página do CAPTCHA
                </a>
              )}
              <button className="rounded border border-amber-400 bg-white px-3 py-2 text-xs text-amber-900" type="button" onClick={resume}>
                Retomar execução
              </button>
            </div>
          </div>
        )}
        <div className="grid gap-3 text-sm md:grid-cols-4">
          <div className="rounded border bg-white p-3">
            <p className="text-xs text-slate-500">Fase</p>
            <p className="font-medium">{progress?.phase || "aguardando"}</p>
          </div>
          <div className="rounded border bg-white p-3">
            <p className="text-xs text-slate-500">Estados descobertos</p>
            <p className="font-medium">
              {progress?.statesDiscovered ?? execution.results?.statesCount ?? 0}
            </p>
          </div>
          <div className="rounded border bg-white p-3">
            <p className="text-xs text-slate-500">Ações executadas</p>
            <p className="font-medium">{progress?.actionsCount ?? execution.results?.actionsCount ?? 0}</p>
          </div>
          <div className="rounded border bg-white p-3">
            <p className="text-xs text-slate-500">URLs na fila</p>
            <p className="font-medium">{progress?.queuedUrls ?? 0}</p>
          </div>
        </div>
        <div className="rounded border bg-white p-3 text-sm">
          <p className="text-xs text-slate-500">Página atual</p>
          <p className="font-medium">{progress?.currentUrl || "Aguardando navegação..."}</p>
          <p className="mt-1 text-xs text-slate-600">
            {progress?.message || "Sem atualização de progresso ainda."}
          </p>
          {progress?.lastUpdate && (
            <p className="mt-1 text-xs text-slate-500">
              Última atualização: {new Date(progress.lastUpdate).toLocaleTimeString("pt-BR")}
            </p>
          )}
        </div>
        <div className="rounded border bg-white p-3">
          <p className="text-xs text-slate-500">Últimas URLs visitadas</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {(progress?.visitedUrls ?? []).slice(-8).map((url) => (
              <li key={url}>{url}</li>
            ))}
            {(progress?.visitedUrls ?? []).length === 0 && <li>Sem URLs registradas ainda.</li>}
          </ul>
        </div>
      </section>

      <section>
        <h2 className="font-medium">Avisos</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {(execution.warnings ?? []).map((warning, index) => (
            <li key={`${warning.type}-${index}`}>
              {warning.type}: {warning.message}
            </li>
          ))}
          {(execution.warnings ?? []).length === 0 && <li>Sem avisos até o momento.</li>}
        </ul>
      </section>

      <section>
        <h2 className="font-medium">Eventos recentes</h2>
        <div className="mt-2 overflow-x-auto rounded border">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="px-3 py-2">Timestamp</th>
                <th className="px-3 py-2">Tipo</th>
                <th className="px-3 py-2">Tecnologia</th>
                <th className="px-3 py-2">URL</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event, index) => (
                <tr key={`event-${index}`} className="border-t">
                  <td className="px-3 py-2">{String(event.timestamp ?? "")}</td>
                  <td className="px-3 py-2">{String(event.event_type ?? "")}</td>
                  <td className="px-3 py-2">{String(event.technology ?? "")}</td>
                  <td className="px-3 py-2">{String(event.url ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
