import { Router } from "express";
import { z } from "zod";
import { createExecutionSchema, parseOrThrow } from "../domain/schemas.js";
import { asyncHandler, HttpError } from "../lib/http.js";
import { requireParam } from "../lib/request.js";
import {
  createExecution,
  exportExecution,
  getExecutionById,
  getExecutionHistoryByAudit,
  getExecutionReport,
  listExecutionActions,
  listExecutionEvents,
  listExecutionEventsPage,
  pauseExecution,
  resumeExecution,
  getManagementReport,
  getAnalystReport,
  buildJourneyInventory,
} from "../services/executionService.js";

export const executionsRouter = Router({ mergeParams: true });

const queryFilterSchema = z.object({
  technology: z.string().optional(),
  eventType: z.string().optional(),
  url: z.string().optional(),
  consentState: z.string().optional(),
  sort: z.enum(["asc", "desc"]).optional(),
  limit: z.coerce.number().int().min(1).max(10000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  includeMeta: z.string().optional(),
});

executionsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const payload = parseOrThrow(createExecutionSchema, req.body ?? {});
    const execution = await createExecution(requireParam(req, "auditId"), payload);
    res.status(201).json(execution);
  }),
);

executionsRouter.get(
  "/history",
  asyncHandler(async (req, res) => {
    const history = await getExecutionHistoryByAudit(requireParam(req, "auditId"));
    res.status(200).json(history);
  }),
);

executionsRouter.get(
  "/:executionId",
  asyncHandler(async (req, res) => {
    const execution = await getExecutionById(requireParam(req, "executionId"));
    if (execution.auditId !== requireParam(req, "auditId")) {
      throw new HttpError(404, "Execution not found for this audit");
    }
    res.status(200).json(execution);
  }),
);

executionsRouter.patch(
  "/:executionId/pause",
  asyncHandler(async (req, res) => {
    await pauseExecution(requireParam(req, "executionId"));
    res.status(200).json({ status: "paused" });
  }),
);

executionsRouter.patch(
  "/:executionId/resume",
  asyncHandler(async (req, res) => {
    await resumeExecution(requireParam(req, "executionId"));
    res.status(200).json({ status: "queued" });
  }),
);

executionsRouter.get(
  "/:executionId/actions",
  asyncHandler(async (req, res) => {
    const actions = await listExecutionActions(requireParam(req, "executionId"));
    res.status(200).json(actions);
  }),
);

executionsRouter.get(
  "/:executionId/events",
  asyncHandler(async (req, res) => {
    const filters = parseOrThrow(queryFilterSchema, req.query);
    const includeMeta = ["1", "true", "yes"].includes((filters.includeMeta ?? "").toLowerCase());
    if (includeMeta) {
      const page = await listExecutionEventsPage(requireParam(req, "executionId"), filters);
      res.status(200).json(page);
      return;
    }
    const events = await listExecutionEvents(requireParam(req, "executionId"), filters);
    res.status(200).json(events);
  }),
);

// Relatórios HTML específicos — devem vir ANTES de /:executionId/report/:format
executionsRouter.get(
  "/:executionId/report/management",
  asyncHandler(async (req, res) => {
    const execId = requireParam(req, "executionId");
    const d = await getManagementReport(execId);
    const inventory = await buildJourneyInventory(execId);
    const results = (d.execution as any).results ?? {};
    const stopReason: string | undefined = results.stopReason;
    const stateScreenshots: Record<string, string> = results.stateScreenshots ?? {};
    const executionWarnings: Array<{type: string; message: string}> = (d.execution as any).warnings ?? [];
    const execIgnoredFields: Array<{reason: string}> = (d.execution as any).ignoredFields ?? [];

    const stopInfo = (() => {
      if (!stopReason) return null;
      if (stopReason.startsWith("max_states:")) return { icon: "🔢", color: "#f59e0b", label: "Limite de estados atingido", detail: stopReason.replace("max_states:", "") };
      if (stopReason.startsWith("max_actions:")) return { icon: "⚡", color: "#f59e0b", label: "Limite de ações atingido", detail: stopReason.replace("max_actions:", "") };
      if (stopReason.startsWith("queue_exhausted_partial:")) return { icon: "⚠️", color: "#f59e0b", label: "Exploração parcial — páginas bloqueadas por Cloudflare", detail: stopReason.replace("queue_exhausted_partial:", "") };
      if (stopReason.startsWith("queue_exhausted:")) return { icon: "✅", color: "#16a34a", label: "Exploração completa", detail: "O crawler visitou todos os caminhos disponíveis" };
      if (stopReason.startsWith("error:")) return { icon: "❌", color: "#dc2626", label: "Erro inesperado", detail: stopReason.replace("error:", "") };
      return { icon: "ℹ️", color: "#64748b", label: stopReason, detail: "" };
    })();

    const wafWarnings = executionWarnings.filter(w => w.type === "captcha");
    const fieldIgnoredByReason: Record<string, number> = {};
    execIgnoredFields.forEach((f: any) => { fieldIgnoredByReason[f.reason] = (fieldIgnoredByReason[f.reason] ?? 0) + 1; });

    const esc = (s: unknown) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const tc = (t: string) => ({ ga4:"#f59e0b",meta_pixel:"#8b5cf6",google_ads:"#3b82f6",custom:"#10b981" } as Record<string,string>)[t] ?? "#64748b";
    const bar = (p: number, c: string) => `<div style="height:8px;border-radius:4px;background:#e2e8f0"><div style="width:${p}%;height:100%;background:${c};border-radius:4px"></div></div>`;
    const top = d.byTechnology[0]?.total ?? 1;
    const highConf = d.byConfidence.find((r: {correlation_confidence:string;total:number}) => r.correlation_confidence === "high")?.total ?? 0;
    const fmtDate = (ts: string | null | undefined) => ts ? new Date(ts).toLocaleString("pt-BR") : "—";
    const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Relatório Gerencial — ${esc(d.auditName)}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#f1f5f9;color:#0f172a;padding:24px}h1{font-size:22px;font-weight:700}h2{font-size:15px;font-weight:600;margin-bottom:12px;color:#334155}.meta{color:#64748b;font-size:13px;margin-top:4px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0}.kpi{background:#fff;border-radius:10px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}.kpi .val{font-size:28px;font-weight:700;line-height:1}.kpi .lbl{font-size:11px;text-transform:uppercase;color:#94a3b8;margin-top:6px}.card{background:#fff;border-radius:10px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:16px}.row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f1f5f9}.row:last-child{border-bottom:none}.badge{display:inline-block;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600}.chip{display:inline-block;padding:3px 9px;border-radius:20px;font-size:11px;margin:2px;font-weight:500}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;padding:9px 8px;font-size:11px;font-weight:600;text-transform:uppercase;color:#475569;border-bottom:2px solid #e2e8f0}td{padding:8px;border-bottom:1px solid #f1f5f9}tr:hover td{background:#f8fafc}.tag-url{font-family:monospace;font-size:11px;color:#334155;max-width:380px;word-break:break-all}footer{text-align:center;color:#94a3b8;font-size:12px;margin-top:24px}.tnav{position:sticky;top:0;z-index:100;background:#0f172a;display:flex;align-items:center;gap:8px;padding:0 20px;height:48px;box-shadow:0 2px 8px rgba(0,0,0,.3)}.tnav a,.tnav span{font-size:13px;text-decoration:none;white-space:nowrap}.tnav .bk{color:#94a3b8;font-weight:500}.tnav .bk:hover{color:#fff}.tnav .sp{color:#334155}.tnav .cr{color:#64748b}.tnav .ac{color:#fff;font-weight:600}.tnav .nl{margin-left:auto;display:flex;gap:6px}.tnav .nb{padding:5px 12px;border-radius:5px;font-size:12px;font-weight:600;color:#fff}.tnav .blu{background:#3b82f6}.tnav .vio{background:#7c3aed}.tnav .gry{background:#475569}.tnav .nb:hover{opacity:.85}</style></head>
<body>
<nav class="tnav">
  <a href="/analysis" class="bk tnav">← Análise</a>
  <span class="sp tnav">/</span>
  <span class="cr tnav">${esc(d.auditName)}</span>
  <span class="sp tnav">/</span>
  <span class="ac tnav">Gerencial v${d.execution.version}</span>
  <div class="nl">
    <a href="/audits/${esc(d.execution.auditId)}/report/management" class="nb vio tnav">📊 Consolidado</a>
    <a href="../${execId}/report/analyst" class="nb blu tnav">🔍 Analítico</a>
  </div>
</nav>
<div style="max-width:1100px;margin:0 auto;padding:24px">
<div style="margin-bottom:16px">
  <h1>${esc(d.auditName)}</h1><p class="meta">${esc(d.auditObjective)}</p>
  <p class="meta" style="margin-top:4px">v${d.execution.version} · ${d.execution.environment} · ${d.execution.status.toUpperCase()} · ${fmtDate(d.execution.startedAt)}</p>
</div>

${stopInfo ? `<div style="display:flex;align-items:flex-start;gap:12px;padding:14px 18px;border-radius:8px;margin-bottom:16px;background:${stopInfo.color}11;border:1px solid ${stopInfo.color}44">
  <span style="font-size:20px">${stopInfo.icon}</span>
  <div><div style="font-weight:700;color:${stopInfo.color};font-size:14px">Condição de Parada: ${stopInfo.label}</div>${stopInfo.detail ? `<div style="font-size:12px;color:#475569;margin-top:2px">${stopInfo.detail}</div>` : ""}</div>
</div>` : ""}

${wafWarnings.length > 0 ? `<div style="padding:12px 16px;border-radius:8px;background:#fff7ed;border:1px solid #fed7aa;margin-bottom:16px;font-size:13px">
  <strong style="color:#c2410c">🛡️ ${wafWarnings.length} domínio(s) bloqueado(s) por controle de acesso</strong> — esta limitação deve ser tratada com a equipe responsável pelo ambiente; a aplicação não tenta contornar controles de segurança.
</div>` : ""}

${Object.keys(fieldIgnoredByReason).length > 0 ? `<div style="padding:10px 16px;border-radius:8px;background:#f8fafc;border:1px solid #e2e8f0;margin-bottom:16px;font-size:12px;color:#475569">
  🔧 <strong>${execIgnoredFields.length} campos ignorados:</strong> ${Object.entries(fieldIgnoredByReason).map(([r,c]) => `${r} ×${c}`).join(", ")}
</div>` : ""}

<div class="grid">
  <div class="kpi"><div class="val">${d.totalEvents.toLocaleString("pt-BR")}</div><div class="lbl">Total Eventos</div></div>
  <div class="kpi"><div class="val">${d.byTechnology.length}</div><div class="lbl">Tecnologias</div></div>
  <div class="kpi"><div class="val">${d.configuredUrlCount}</div><div class="lbl">URLs Config.</div></div>
  <div class="kpi"><div class="val">${d.visitedUrlCount}</div><div class="lbl">URLs com Eventos</div></div>
  <div class="kpi"><div class="val" style="color:${d.urlsWithoutEvents.length?'#dc2626':'#16a34a'}">${d.urlsWithoutEvents.length}</div><div class="lbl">URLs sem Eventos</div></div>
  <div class="kpi"><div class="val">${Math.round(highConf/Math.max(d.totalEvents,1)*100)}%</div><div class="lbl">Confiança Alta</div></div>
</div>

<!-- Cobertura de URLs -->
<div class="card">
  <h2>🌐 URLs — Configuradas vs. Visitadas nesta Execução</h2>
  <table>
    <thead><tr><th>URL Configurada</th><th style="text-align:center">Com Eventos?</th><th style="text-align:right">Eventos</th><th>Tecnologias</th></tr></thead>
    <tbody>
      ${d.configuredUrls.map((cu: {url:string}) => {
        const row = d.allUrls.find((r: {url:string;total:number;technologies:string}) => r.url === cu.url);
        if (row) return `<tr><td class="tag-url">${esc(cu.url)}</td><td style="text-align:center">✅</td><td style="text-align:right;font-weight:600">${row.total}</td><td><span class="chip" style="background:#e0f2fe;color:#0369a1;font-size:10px">${esc(row.technologies)}</span></td></tr>`;
        return `<tr style="background:#fff1f2"><td class="tag-url">${esc(cu.url)}</td><td style="text-align:center">❌</td><td colspan="2" style="color:#dc2626;font-size:12px">Nenhum evento capturado</td></tr>`;
      }).join("") || '<tr><td colspan="4" style="color:#94a3b8;text-align:center;padding:12px">Nenhuma URL configurada</td></tr>'}
    </tbody>
  </table>
  ${d.allUrls.filter((r: {url:string}) => !d.configuredUrls.find((c: {url:string}) => c.url === r.url)).length > 0 ? `
  <details style="margin-top:12px;border:1px solid #e2e8f0;border-radius:8px;padding:10px">
    <summary style="cursor:pointer;font-weight:600;font-size:13px">➕ URLs descobertas pelo crawler (${d.allUrls.filter((r: {url:string}) => !d.configuredUrls.find((c: {url:string}) => c.url === r.url)).length})</summary>
    <table style="margin-top:8px">
      <thead><tr><th>URL Descoberta</th><th style="text-align:right">Eventos</th><th>Tecnologias</th></tr></thead>
      <tbody>${d.allUrls.filter((r: {url:string}) => !d.configuredUrls.find((c: {url:string}) => c.url === r.url)).map((r: {url:string;total:number;technologies:string}) =>
        `<tr><td class="tag-url">${esc(r.url)}</td><td style="text-align:right;font-weight:600">${r.total}</td><td><span class="chip" style="background:#e0f2fe;color:#0369a1;font-size:10px">${esc(r.technologies)}</span></td></tr>`
      ).join("")}</tbody>
    </table>
  </details>` : ""}
</div>

<div class="card"><h2>📡 Tecnologias Detectadas</h2>
  ${d.byTechnology.map((r: {technology:string;total:number}) => `<div class="row"><div style="width:120px"><span class="badge" style="background:${tc(r.technology)}22;color:${tc(r.technology)}">${esc(r.technology)}</span></div><div style="flex:1">${bar(Math.round(r.total/top*100),tc(r.technology))}</div><div style="width:60px;text-align:right;font-weight:700">${r.total}</div></div>`).join("") || '<p style="color:#94a3b8;text-align:center;padding:20px">Nenhuma tecnologia detectada</p>'}
</div>

<div class="card"><h2>🏷️ Top Eventos por Plataforma</h2>
  <table><thead><tr><th>Evento</th><th>Tecnologia</th><th style="text-align:right">Disparos</th></tr></thead><tbody>
    ${d.topEventNames.map((r: {event_name:string|null;technology:string;total:number}) => `<tr><td><code style="font-size:12px">${esc(r.event_name ?? "—")}</code></td><td><span class="chip" style="background:${tc(r.technology)}22;color:${tc(r.technology)}">${esc(r.technology)}</span></td><td style="text-align:right;font-weight:600">${r.total}</td></tr>`).join("") || '<tr><td colspan="3" style="text-align:center;color:#94a3b8;padding:16px">Sem eventos</td></tr>'}
  </tbody></table>
</div>

<div class="card" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
  <div><h2>✅ Consentimento</h2>${d.byConsent.map((r: {consent_state:string;total:number}) => `<div class="row"><span style="flex:1">${esc(r.consent_state)}</span><strong>${r.total}</strong></div>`).join("")}</div>
  <div><h2>🎯 Confiança de Correlação</h2>${d.byConfidence.map((r: {correlation_confidence:string;total:number}) => `<div class="row"><span style="flex:1">${esc(r.correlation_confidence)}</span><strong>${r.total}</strong></div>`).join("")}</div>
</div>

<!-- Estado descobertos com screenshots -->
${inventory.states.length > 0 ? `
<div class="card">
  <h2>📸 Estados Descobertos — ${inventory.states.length} estado(s)</h2>
  <p style="font-size:12px;color:#64748b;margin-bottom:12px">Clique para ampliar. <span style="background:#d1fae5;color:#065f46;padding:1px 5px;border-radius:3px;font-size:11px">✓ com eventos</span> <span style="background:#fed7aa;color:#c2410c;padding:1px 5px;border-radius:3px;font-size:11px">WAF 403</span></p>
  <div style="display:flex;flex-wrap:wrap;gap:12px">
    ${inventory.states.slice(0,20).map((s: any) => {
      const ssKey = Object.keys(stateScreenshots).find(k => k.trim() === s.stateName.trim() || k.startsWith(`${s.stateName}@@`));
      const img = ssKey ? stateScreenshots[ssKey] : null;
      const blocked = !s.hasEvents;
      return `<div style="width:180px;border:2px solid ${blocked?'#fed7aa':'#e2e8f0'};border-radius:8px;overflow:hidden;cursor:${img?'pointer':'default'}"
                   ${img ? `onclick="(function(s,c){const l=document.getElementById('lb');l.querySelector('img').src=s;l.querySelector('.lbc').textContent=c;l.style.display='flex'})(${JSON.stringify(img)},${JSON.stringify(s.stateName.substring(0,80))})"` : ''}>
        ${img
          ? `<img src="${img}" style="width:180px;height:100px;object-fit:cover;object-position:top;display:block" />`
          : `<div style="width:180px;height:100px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:11px;color:#94a3b8">${blocked?'🛡️ bloqueado':'sem print'}</div>`}
        <div style="padding:6px 8px;font-size:10px;color:#475569;background:#f8fafc;border-top:1px solid #e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(s.stateName)}">
          ${blocked?'<span style="color:#c2410c">WAF</span> ':''}${esc((s.visualContext||s.baseUrl).substring(0,30))}
        </div>
      </div>`;
    }).join("")}
  </div>
</div>
<div id="lb" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:9999;align-items:center;justify-content:center;padding:20px" onclick="this.style.display='none'">
  <img style="max-width:95vw;max-height:88vh;border-radius:8px" />
  <div class="lbc" style="position:absolute;bottom:14px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.6);color:#fff;padding:6px 14px;border-radius:6px;font-size:12px;max-width:80vw;text-align:center"></div>
</div>` : ""}

<footer>Relatório gerencial · v${d.execution.version} · Gerado em ${new Date().toLocaleString("pt-BR")}</footer>
</div></body></html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  }),
);

executionsRouter.get(
  "/:executionId/report/analyst",
  asyncHandler(async (req, res) => {
    const { getAnalystReport } = await import("../services/executionService.js");
    const { getAuditById } = await import("../services/auditService.js");
    const execId = requireParam(req, "executionId");
    const d = await getAnalystReport(execId);
    const audit = await getAuditById(d.execution.auditId);
    const esc = (s: unknown) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    const tc = (t: string) => ({ ga4:"#f59e0b",meta_pixel:"#8b5cf6",google_ads:"#3b82f6",custom:"#10b981" } as Record<string,string>)[t] ?? "#64748b";
    const rp = (params: Record<string,unknown>, id: string) => {
      const entries = Object.entries(params);
      if (!entries.length) return '<span style="color:#94a3b8">—</span>';
      return `<button onclick="var e=document.getElementById('p-${id}');e.style.display=e.style.display==='none'?'block':'none'" style="font-size:11px;padding:2px 8px;border:1px solid #e2e8f0;border-radius:4px;cursor:pointer;background:#f8fafc">${entries.length} params</button><pre id="p-${id}" style="display:none;margin-top:6px;background:#1e293b;color:#e2e8f0;padding:10px;border-radius:6px;font-size:11px;overflow:auto;max-height:200px">${esc(JSON.stringify(params,null,2))}</pre>`;
    };
    const sections = d.byUrl.map(({ url, events }: { url: string; events: { id: string; timestamp: string; technology: string; event_name: string | null; action_type: string | null; sequence: number | null; correlation_confidence: string; parameters: Record<string,unknown> }[] }) => {
      const techs = [...new Set(events.map(e => e.technology))];
      const rows = events.map((e, i) => {
        const uid = e.id.slice(0,8)+i;
        return `<tr><td style="color:#64748b;font-size:11px">${new Date(e.timestamp).toLocaleTimeString("pt-BR")}</td><td><span style="padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600;background:${tc(e.technology)}22;color:${tc(e.technology)}">${esc(e.technology)}</span></td><td><code style="font-size:12px">${esc(e.event_name ?? "—")}</code></td><td style="font-size:11px;color:#64748b">${esc(e.action_type ?? "—")} ${e.sequence != null ? `#${e.sequence}` : ""}</td><td>${rp(e.parameters, uid)}</td><td><span style="padding:2px 6px;border-radius:3px;font-size:10px;background:${e.correlation_confidence==="high"?"#d1fae5":"#fee2e2"};color:${e.correlation_confidence==="high"?"#065f46":"#7f1d1d"}">${e.correlation_confidence}</span></td></tr>`;
      }).join("");
      return `<details style="background:#fff;border-radius:10px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow:hidden"><summary style="padding:14px 18px;cursor:pointer;display:flex;align-items:center;gap:10px;list-style:none"><span style="font-family:monospace;font-size:12px;color:#334155;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(url)}</span><span style="font-size:12px;color:#64748b">${events.length} eventos</span>${techs.map(t => `<span style="padding:2px 8px;border-radius:12px;font-size:11px;background:${tc(t)}22;color:${tc(t)};font-weight:600">${t}</span>`).join("")}</summary><div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead style="background:#f8fafc"><tr><th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0">Hora</th><th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0">Tecnologia</th><th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0">Evento</th><th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0">Ação</th><th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0">Parâmetros</th><th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0">Confiança</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
    }).join("");
    const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Relatório Analítico — ${esc(audit.name)}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#f1f5f9;color:#0f172a;padding:24px}h1{font-size:22px;font-weight:700}.meta{color:#64748b;font-size:13px;margin-top:4px}footer{text-align:center;color:#94a3b8;font-size:12px;margin-top:24px}details summary::-webkit-details-marker{display:none}input[type=text]{width:100%;padding:10px 14px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;margin-bottom:16px;outline:none}input[type=text]:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.15)}.tnav{position:sticky;top:0;z-index:100;background:#0f172a;display:flex;align-items:center;gap:8px;padding:0 20px;height:48px;box-shadow:0 2px 8px rgba(0,0,0,.3)}.tnav a,.tnav span{font-size:13px;text-decoration:none;white-space:nowrap}.tnav .bk{color:#94a3b8;font-weight:500}.tnav .bk:hover{color:#fff}.tnav .sp{color:#334155}.tnav .cr{color:#64748b}.tnav .ac{color:#fff;font-weight:600}.tnav .nl{margin-left:auto;display:flex;gap:6px}.tnav .nb{padding:5px 12px;border-radius:5px;font-size:12px;font-weight:600;color:#fff}.tnav .vio{background:#7c3aed}.tnav .gry{background:#475569}.tnav .nb:hover{opacity:.85}</style></head>
<body>
<nav class="tnav">
  <a href="/analysis" class="bk tnav">← Análise</a>
  <span class="sp tnav">/</span>
  <span class="cr tnav">${esc(audit.name)}</span>
  <span class="sp tnav">/</span>
  <span class="ac tnav">Analítico v${d.execution.version}</span>
  <div class="nl">
    <a href="/audits/${esc(d.execution.auditId)}/report/management" class="nb vio tnav">📊 Consolidado</a>
    <a href="../${execId}/report/management" class="nb gry tnav">📋 Gerencial</a>
  </div>
</nav>
<div style="max-width:1100px;margin:0 auto;padding:24px">
<div style="margin-bottom:20px"><h1>${esc(audit.name)}</h1><p class="meta">${esc(audit.objective)}</p><p class="meta" style="margin-top:4px">v${d.execution.version} · ${d.execution.environment} · ${d.execution.status.toUpperCase()} · ${d.totalEvents} eventos em ${d.byUrl.length} URLs</p></div>
<input type="text" id="f" placeholder="Filtrar por URL ou evento..." oninput="document.querySelectorAll('#ul details').forEach(d=>{d.style.display=d.textContent.toLowerCase().includes(this.value.toLowerCase())?'':'none'})">
<div id="ul">${sections}</div>
${!d.byUrl.length ? '<p style="text-align:center;color:#94a3b8;padding:40px">Nenhum evento capturado nesta execução</p>' : ""}
<footer>Relatório analítico · Gerado em ${new Date().toLocaleString("pt-BR")}</footer></div></body></html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  }),
);

executionsRouter.get(
  "/:executionId/report/:format",
  asyncHandler(async (req, res) => {
    const format = req.params.format;
    if (format !== "json" && format !== "csv" && format !== "pdf") {
      throw new HttpError(400, "Invalid format. Use json, csv or pdf.");
    }
    const exported = await exportExecution(requireParam(req, "executionId"), format);
    res.setHeader("Content-Type", exported.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${exported.fileName}"`);
    res.status(200).send(exported.body);
  }),
);

executionsRouter.get(
  "/:executionId/report",
  asyncHandler(async (req, res) => {
    const report = await getExecutionReport(requireParam(req, "executionId"));
    res.status(200).json(report);
  }),
);

executionsRouter.get(
  "/:executionId/export",
  asyncHandler(async (req, res) => {
    const format = req.query.format;
    if (format !== "json" && format !== "csv" && format !== "pdf") {
      throw new HttpError(400, "Invalid format. Use json, csv or pdf.");
    }

    const exported = await exportExecution(requireParam(req, "executionId"), format);
    res.setHeader("Content-Type", exported.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${exported.fileName}"`);
    res.status(200).send(exported.body);
  }),
);
