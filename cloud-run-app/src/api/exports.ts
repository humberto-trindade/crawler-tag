import { Router } from "express";
import { asyncHandler } from "../lib/http.js";
import { requireParam } from "../lib/request.js";
import {
  getExecutionById,
  listExecutionEvents,
  buildJourneyInventory,
  getManagementReport,
  getAnalystReport,
} from "../services/executionService.js";
import { getAuditById } from "../services/auditService.js";

export const exportsRouter = Router({ mergeParams: true });

exportsRouter.get(
  "/:executionId/visual",
  asyncHandler(async (req, res) => {
    const executionId = requireParam(req, "executionId");
    const execution = await getExecutionById(executionId);
    const audit = await getAuditById(execution.auditId);
    const events = await listExecutionEvents(executionId, {});

    const byTech = events.reduce<Record<string, number>>((acc, e) => {
      const tech = e.technology || "unknown";
      acc[tech] = (acc[tech] ?? 0) + 1;
      return acc;
    }, {});

    const byType = events.reduce<Record<string, number>>((acc, e) => {
      const type = e.event_type || "unknown";
      acc[type] = (acc[type] ?? 0) + 1;
      return acc;
    }, {});

    const byConfidence = events.reduce<Record<string, number>>((acc, e) => {
      const conf = e.correlation_confidence || "unknown";
      acc[conf] = (acc[conf] ?? 0) + 1;
      return acc;
    }, {});

    const warnings = (execution as any).warnings ?? [];
    const ignoredFields = (execution as any).ignoredFields ?? [];
    const results = (execution as any).results ?? {};
    const stopReason: string | undefined = results.stopReason;
    const stateScreenshots: Record<string, string> = results.stateScreenshots ?? {};
    const journeyInventory = await buildJourneyInventory(executionId);

    // Decode stop reason code into human-readable text
    const stopInfo = (() => {
      if (!stopReason) return null;
      if (stopReason.startsWith("max_states:")) return { icon: "🔢", color: "#f59e0b", label: "Limite de estados atingido", detail: stopReason.replace("max_states:", "") };
      if (stopReason.startsWith("max_actions:")) return { icon: "⚡", color: "#f59e0b", label: "Limite de ações atingido", detail: stopReason.replace("max_actions:", "") };
      if (stopReason.startsWith("max_duration:")) return { icon: "⏱️", color: "#f59e0b", label: "Tempo máximo atingido", detail: stopReason.replace("max_duration:", "") };
      if (stopReason.startsWith("queue_exhausted_partial:")) return { icon: "⚠️", color: "#f59e0b", label: "Exploração parcial — páginas bloqueadas", detail: stopReason.replace("queue_exhausted_partial:", "") };
      if (stopReason.startsWith("queue_exhausted:")) return { icon: "✅", color: "#16a34a", label: "Exploração completa — fila esgotada", detail: "O crawler visitou todos os caminhos disponíveis" };
      if (stopReason.startsWith("waf_blocked:")) return { icon: "🛡️", color: "#dc2626", label: "Bloqueio WAF/Cloudflare", detail: stopReason.replace("waf_blocked:", "") };
      if (stopReason === "captcha_paused") return { icon: "⏸️", color: "#3b82f6", label: "Pausado — CAPTCHA detectado", detail: "Resolva o CAPTCHA manualmente e retome" };
      if (stopReason.startsWith("error:")) return { icon: "❌", color: "#dc2626", label: "Erro inesperado", detail: stopReason.replace("error:", "") };
      return { icon: "ℹ️", color: "#64748b", label: stopReason, detail: "" };
    })();

    const screenshotEntries = Object.entries(stateScreenshots);

    const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Relatório de Auditoria - ${audit.name}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; }
    header { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    h1 { font-size: 28px; margin-bottom: 10px; color: #0f172a; }
    .subtitle { color: #64748b; font-size: 14px; }
    .status { display: inline-block; padding: 6px 12px; border-radius: 4px; font-size: 12px; font-weight: 600; margin-top: 10px; }
    .status.completed { background: #d1fae5; color: #065f46; }
    .status.paused { background: #fef3c7; color: #92400e; }
    .status.running { background: #dbeafe; color: #0c4a6e; }
    .status.failed { background: #fee2e2; color: #7f1d1d; }
    .stop-banner { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-radius: 8px; margin-bottom: 20px; border: 1px solid; }
    .stop-icon { font-size: 22px; }
    .stop-label { font-weight: 700; font-size: 15px; }
    .stop-detail { font-size: 13px; color: #475569; margin-top: 2px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; margin-bottom: 20px; }
    .card { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .card h3 { font-size: 12px; text-transform: uppercase; color: #64748b; margin-bottom: 8px; }
    .card .value { font-size: 32px; font-weight: 700; color: #0f172a; }
    .card.metric { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .metric-item { background: #f1f5f9; padding: 10px; border-radius: 4px; }
    .metric-item .label { font-size: 12px; color: #64748b; }
    .metric-item .number { font-size: 20px; font-weight: 700; color: #0f172a; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px; }
    thead { background: #f1f5f9; }
    th { padding: 12px; text-align: left; font-size: 12px; font-weight: 600; text-transform: uppercase; color: #475569; border-bottom: 1px solid #e2e8f0; }
    td { padding: 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px; }
    tbody tr:hover { background: #f8fafc; }
    .tech-badge { display: inline-block; padding: 4px 8px; border-radius: 3px; font-size: 11px; font-weight: 600; }
    .ga4 { background: #fef3c7; color: #92400e; }
    .meta_pixel { background: #ede9fe; color: #581c87; }
    .google_ads { background: #dbeafe; color: #0c4a6e; }
    .custom { background: #d1fae5; color: #065f46; }
    .warning { background: #fee2e2; color: #7f1d1d; padding: 8px; border-radius: 4px; margin-bottom: 8px; font-size: 13px; }
    .section { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .section h2 { font-size: 18px; margin-bottom: 15px; color: #0f172a; }
    .empty { text-align: center; padding: 30px; color: #94a3b8; }
    .high { color: #16a34a; font-weight: 600; }
    .low { color: #dc2626; font-weight: 600; }
    /* State screenshot gallery */
    .screenshot-gallery { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 14px; }
    .screenshot-item { cursor: pointer; border-radius: 8px; overflow: hidden; border: 2px solid #e2e8f0; transition: border-color .2s, transform .15s; width: 180px; flex-shrink: 0; }
    .screenshot-item:hover { border-color: #3b82f6; transform: scale(1.03); }
    .screenshot-item img { width: 180px; height: 100px; object-fit: cover; object-position: top; display: block; background: #f1f5f9; }
    .screenshot-item .ss-label { font-size: 10px; color: #475569; padding: 5px 7px; background: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    /* Lightbox */
    #ss-lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.82); z-index: 9999; align-items: center; justify-content: center; padding: 20px; }
    #ss-lightbox.open { display: flex; }
    #ss-lightbox img { max-width: 95vw; max-height: 90vh; border-radius: 8px; box-shadow: 0 8px 40px rgba(0,0,0,.6); }
    #ss-lightbox .lb-close { position: absolute; top: 16px; right: 20px; color: white; font-size: 32px; cursor: pointer; line-height: 1; }
    #ss-lightbox .lb-caption { position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,.6); color: #fff; padding: 6px 14px; border-radius: 6px; font-size: 13px; max-width: 80vw; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>${audit.name}</h1>
      <p class="subtitle">${audit.objective}</p>
      <div>
        <span class="status ${execution.status}">${execution.status.toUpperCase()}</span>
      </div>
    </header>

    ${stopInfo ? `
    <div class="stop-banner" style="background:${stopInfo.color}11;border-color:${stopInfo.color}44">
      <span class="stop-icon">${stopInfo.icon}</span>
      <div>
        <div class="stop-label" style="color:${stopInfo.color}">Condição de Parada: ${stopInfo.label}</div>
        ${stopInfo.detail ? `<div class="stop-detail">${stopInfo.detail}</div>` : ""}
      </div>
    </div>` : ""}

    <div class="grid">
      <div class="card">
        <h3>Total de Eventos</h3>
        <div class="value">${events.length}</div>
      </div>
      <div class="card">
        <h3>Tecnologias Detectadas</h3>
        <div class="value">${Object.keys(byTech).length}</div>
      </div>
      <div class="card">
        <h3>Campos Ignorados</h3>
        <div class="value">${ignoredFields.length ?? 0}</div>
      </div>
      <div class="card">
        <h3>Avisos</h3>
        <div class="value">${warnings.length ?? 0}</div>
      </div>
    </div>

    <div class="card metric">
      <div class="metric-item">
        <div class="label">Confiança Alta</div>
        <div class="number high">${byConfidence.high ?? 0}</div>
      </div>
      <div class="metric-item">
        <div class="label">Confiança Baixa</div>
        <div class="number low">${byConfidence.low ?? 0}</div>
      </div>
      ${Object.entries(byType)
        .map(
          ([type, count]) => `
        <div class="metric-item">
          <div class="label">${type}</div>
          <div class="number">${count}</div>
        </div>
      `,
        )
        .join("")}
      ${Object.entries(byTech)
        .map(
          ([tech, count]) => `
        <div class="metric-item">
          <div class="label">${tech}</div>
          <div class="number">${count}</div>
        </div>
      `,
        )
        .join("")}
    </div>

    ${(() => {
      // Group warnings by type instead of showing each one individually
      const wafWarnings = (warnings as any[]).filter((w: any) => w.type === "captcha");
      const spaWarnings = (warnings as any[]).filter((w: any) => w.type === "spa_router");
      const fieldIgnoredByReason: Record<string, number> = {};
      (ignoredFields as any[]).forEach((f: any) => { fieldIgnoredByReason[f.reason] = (fieldIgnoredByReason[f.reason] ?? 0) + 1; });
      const hasAny = wafWarnings.length > 0 || spaWarnings.length > 0 || Object.keys(fieldIgnoredByReason).length > 0;
      if (!hasAny) return "";
      return `
    <div class="section" style="padding:14px 20px">
      <h2 style="margin-bottom:10px">⚠️ Resumo de Avisos</h2>
      <div style="display:flex;flex-wrap:wrap;gap:10px">
        ${wafWarnings.length > 0 ? `
        <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:12px 16px;flex:1;min-width:250px">
          <div style="font-weight:700;color:#c2410c;margin-bottom:4px">🛡️ ${wafWarnings.length} domínio(s) com Cloudflare/WAF</div>
          <div style="font-size:12px;color:#475569">${wafWarnings.map((w: any) => w.message.split(".")[0]).join("<br/>")}</div>
          <div style="margin-top:8px;padding:8px;background:#fff;border-radius:6px;font-size:11px;color:#92400e;border:1px solid #fed7aa">
            💡 <strong>Próximo passo:</strong> trate a limitação com a equipe responsável pelo ambiente. A aplicação não tenta contornar controles de segurança.
          </div>
        </div>` : ""}
        ${Object.keys(fieldIgnoredByReason).length > 0 ? `
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;flex:1;min-width:200px">
          <div style="font-weight:700;color:#475569;margin-bottom:4px">🔧 ${(ignoredFields as any[]).length} campos não mapeados</div>
          ${Object.entries(fieldIgnoredByReason).map(([r, c]) => `<div style="font-size:12px;color:#64748b">${r}: <strong>${c}</strong></div>`).join("")}
        </div>` : ""}
        ${spaWarnings.length > 0 ? `
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;flex:1;min-width:200px">
          <div style="font-weight:700;color:#475569;margin-bottom:4px">🔀 ${spaWarnings.length} aviso(s) de navegação SPA</div>
          ${spaWarnings.slice(0,2).map((w: any) => `<div style="font-size:11px;color:#64748b">${w.message.substring(0,80)}...</div>`).join("")}
        </div>` : ""}
      </div>
    </div>`;
    })()}


    <div class="section">
      <h2>🗺️ Inventário de Jornada e Tags</h2>
      <div class="grid">
        <div class="card">
          <h3>Estados / URLs Visitados</h3>
          <div class="value">${journeyInventory.summary.totalStates}</div>
        </div>
        <div class="card">
          <h3>URLs Únicas</h3>
          <div class="value">${journeyInventory.summary.totalUniqueUrls}</div>
        </div>
        <div class="card">
          <h3>Ações Registradas</h3>
          <div class="value">${journeyInventory.summary.totalActions}</div>
        </div>
      </div>

      ${screenshotEntries.length > 0 ? `
      <h3 style="margin-top:20px;margin-bottom:10px;color:#0f172a;">📸 Print dos Estados Descobertos</h3>
      <p style="font-size:12px;color:#64748b;margin-bottom:12px">${screenshotEntries.length} estado(s) capturado(s) — clique para ampliar</p>
      <div class="screenshot-gallery">
        ${screenshotEntries.map(([name, src]) => `
        <div class="screenshot-item" onclick="openLightbox('${src.replace(/'/g, "\\'")}','${name.replace(/'/g, "\\'").substring(0, 80)}')" title="${name}">
          <img src="${src}" alt="Estado: ${name}" loading="lazy" />
          <div class="ss-label">${name.substring(0, 40)}</div>
        </div>`).join("")}
      </div>` : ""}

      <h3 style="margin-top:20px;margin-bottom:10px;color:#0f172a">Inventário de Estados — todos os estados visitados</h3>
      <p style="font-size:12px;color:#64748b;margin-bottom:10px">
        ✅ Com eventos de tracking &nbsp;|&nbsp; 🛡️ Visitado mas bloqueado por WAF (sem eventos) &nbsp;|&nbsp; 📸 Clique na miniatura para ampliar
      </p>
      <table>
        <thead>
          <tr>
            <th style="width:100px">📸 Print</th>
            <th>Estado / URL</th>
            <th>Contexto Visual</th>
            <th style="text-align:right">Eventos</th>
            <th>Tipos</th>
            <th>Tecnologias</th>
          </tr>
        </thead>
        <tbody>
          ${journeyInventory.states
            .slice(0, 20)
            .map(
              (state: any) => {
                const ssKey = Object.keys(stateScreenshots).find(k => k === state.stateName || k.startsWith(state.stateName));
                const ssData = ssKey ? stateScreenshots[ssKey] : null;
                const isBlocked = !state.hasEvents;
                return `
          <tr style="${isBlocked ? "background:#fff7ed;opacity:.85" : ""}">
            <td style="padding:6px">
              ${ssData
                ? `<img src="${ssData}" alt="State screenshot" loading="lazy"
                        onclick="openLightbox('${ssData.replace(/'/g, "\\'")}','${state.stateName.replace(/'/g, "\\'").substring(0,80)}')"
                        style="width:96px;height:54px;object-fit:cover;object-position:top;cursor:pointer;border-radius:4px;border:1px solid #e2e8f0" />`
                : `<div style="width:96px;height:54px;background:#f1f5f9;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#94a3b8">${isBlocked ? "🛡️ blocked" : "sem print"}</div>`}
            </td>
            <td>
              ${isBlocked ? '<span style="font-size:10px;background:#fed7aa;color:#c2410c;padding:1px 5px;border-radius:3px;margin-right:4px">WAF 403</span>' : '<span style="font-size:10px;background:#d1fae5;color:#065f46;padding:1px 5px;border-radius:3px;margin-right:4px">✓</span>'}
              <code style="font-size:11px">${state.baseUrl.substring(0, 55)}</code>
            </td>
            <td style="font-size:12px;color:#475569">${state.visualContext || "-"}</td>
            <td style="text-align:right"><strong>${state.eventCount || "—"}</strong></td>
            <td style="font-size:11px">${state.eventTypes.join(", ") || "-"}</td>
            <td>${Object.entries(state.technologies as Record<string,number>)
              .map(([tech, count]) => `<span class="tech-badge ${tech}">${tech}(${count})</span>`)
              .join(" ") || "-"}</td>
          </tr>`;
              }
            )
            .join("")}
        </tbody>
      </table>

      <h3 style="margin-top:20px;margin-bottom:10px;color:#0f172a">Transições de Estado</h3>
      <table>
        <thead>
          <tr>
            <th>De</th>
            <th>Para</th>
            <th style="text-align:right">Ações</th>
          </tr>
        </thead>
        <tbody>
          ${journeyInventory.transitions
            .slice(0, 10)
            .map(
              (trans: any) => `
          <tr>
            <td><code style="font-size: 11px;">${trans.from.substring(0, 50)}</code></td>
            <td><code style="font-size: 11px;">${trans.to.substring(0, 50)}</code></td>
            <td style="text-align:right"><strong>${trans.actionCount}</strong></td>
          </tr>
        `,
            )
            .join("")}
        </tbody>
      </table>
    </div>

    <div class="section">
      <h2>�📊 Distribuição de Eventos</h2>
      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Tecnologia</th>
            <th>Tipo</th>
            <th>Nome</th>
            <th>Confiança</th>
            <th>URL</th>
          </tr>
        </thead>
        <tbody>
          ${
            events.length === 0
              ? '<tr><td colspan="6" class="empty">Nenhum evento capturado</td></tr>'
              : events
                  .slice(0, 500)
                  .map(
                    (e: any) => `
          <tr>
            <td>${new Date(e.timestamp).toLocaleTimeString("pt-BR")}</td>
            <td><span class="tech-badge ${e.technology}">${e.technology}</span></td>
            <td>${e.event_type}</td>
            <td><code>${e.event_name ?? "-"}</code></td>
            <td><span class="${e.correlation_confidence}">${e.correlation_confidence}</span></td>
            <td style="max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${e.url}</td>
          </tr>
        `,
                  )
                  .join("")
          }
        </tbody>
      </table>
      ${events.length > 500 ? `<p class="empty">Exibindo primeiros 500 de ${events.length} eventos</p>` : ""}
    </div>

    <div style="text-align: center; padding: 20px; color: #94a3b8; font-size: 12px;">
      <p>Relatório gerado em ${new Date().toLocaleString("pt-BR")}</p>
    </div>
  </div>

  <!-- Lightbox para ampliar screenshots -->
  <div id="ss-lightbox" onclick="closeLightbox(event)">
    <span class="lb-close" onclick="closeLightbox()">&times;</span>
    <img id="ss-lb-img" src="" alt="" />
    <div id="ss-lb-caption" class="lb-caption"></div>
  </div>
  <script>
    function openLightbox(src, caption) {
      document.getElementById('ss-lb-img').src = src;
      document.getElementById('ss-lb-caption').textContent = caption;
      document.getElementById('ss-lightbox').classList.add('open');
    }
    function closeLightbox(e) {
      if (!e || e.target !== document.getElementById('ss-lb-img'))
        document.getElementById('ss-lightbox').classList.remove('open');
    }
    document.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('ss-lightbox').classList.remove('open'); });
  </script>
</body>
</html>
    `;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  }),
);

// ─── MANAGEMENT REPORT ────────────────────────────────────────────────────────
// GET /api/audits/:auditId/executions/:executionId/report/management
// Visão gerencial consolidada: tecnologias, eventos por plataforma, cobertura.
// ─────────────────────────────────────────────────────────────────────────────
exportsRouter.get(
  "/:executionId/report/management",
  asyncHandler(async (req, res) => {
    const executionId = requireParam(req, "executionId");
    const d = await getManagementReport(executionId);
    const audit = await getAuditById(d.execution.auditId);

    const techColors: Record<string, string> = {
      ga4: "#f59e0b",
      meta_pixel: "#8b5cf6",
      google_ads: "#3b82f6",
      custom: "#10b981",
    };
    const techColor = (t: string) => techColors[t] ?? "#64748b";

    const bar = (pct: number, color: string) =>
      `<div style="height:8px;border-radius:4px;background:#e2e8f0;overflow:hidden">` +
      `<div style="width:${pct}%;height:100%;background:${color};border-radius:4px"></div></div>`;

    const topTotal = d.byTechnology[0]?.total ?? 1;

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Relatório Gerencial — ${audit.name}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f1f5f9;color:#0f172a;padding:24px}
  h1{font-size:22px;font-weight:700}
  h2{font-size:15px;font-weight:600;margin-bottom:12px;color:#334155}
  .meta{color:#64748b;font-size:13px;margin-top:4px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:20px 0}
  .kpi{background:#fff;border-radius:10px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  .kpi .val{font-size:32px;font-weight:700;line-height:1}
  .kpi .lbl{font-size:11px;text-transform:uppercase;color:#94a3b8;margin-top:6px;letter-spacing:.05em}
  .card{background:#fff;border-radius:10px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:16px}
  .row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f1f5f9}
  .row:last-child{border-bottom:none}
  .badge{display:inline-block;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600}
  .chip{display:inline-block;padding:4px 10px;border-radius:20px;font-size:12px;margin:2px;font-weight:500}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:10px 8px;font-size:11px;font-weight:600;text-transform:uppercase;color:#475569;border-bottom:2px solid #e2e8f0}
  td{padding:9px 8px;border-bottom:1px solid #f1f5f9}
  tr:hover td{background:#f8fafc}
  .tag-url{font-family:monospace;font-size:12px;color:#475569;max-width:350px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  footer{text-align:center;color:#94a3b8;font-size:12px;margin-top:24px}
</style>
</head>
<body>
<div style="max-width:1100px;margin:0 auto">

  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px">
    <div>
      <h1>${audit.name}</h1>
      <p class="meta">${audit.objective}</p>
      <p class="meta" style="margin-top:4px">
        Execução v${d.execution.version} &nbsp;·&nbsp;
        ${d.execution.environment} &nbsp;·&nbsp;
        ${d.execution.status.toUpperCase()} &nbsp;·&nbsp;
        ${d.execution.startedAt ? new Date(d.execution.startedAt).toLocaleString("pt-BR") : "—"}
      </p>
    </div>
    <div style="display:flex;gap:8px">
      <a href="../${executionId}/report/analyst"
         style="padding:8px 16px;border-radius:6px;background:#3b82f6;color:#fff;text-decoration:none;font-size:13px;font-weight:600">
        Ver Relatório Analítico →
      </a>
    </div>
  </div>

  <!-- KPIs -->
  <div class="grid">
    <div class="kpi"><div class="val">${d.totalEvents}</div><div class="lbl">Total de Eventos</div></div>
    <div class="kpi"><div class="val">${d.byTechnology.length}</div><div class="lbl">Tecnologias</div></div>
    <div class="kpi"><div class="val">${d.visitedUrlCount}</div><div class="lbl">URLs com Eventos</div></div>
    <div class="kpi">
      <div class="val">${Math.round((d.byConfidence.find(r => r.correlation_confidence === "high")?.total ?? 0) / Math.max(d.totalEvents, 1) * 100)}%</div>
      <div class="lbl">Confiança Alta</div>
    </div>
  </div>

  <!-- Tecnologias detectadas -->
  <div class="card">
    <h2>📡 Tecnologias Detectadas</h2>
    ${d.byTechnology.map(r => `
    <div class="row">
      <div style="width:120px">
        <span class="badge" style="background:${techColor(r.technology)}22;color:${techColor(r.technology)}">${r.technology}</span>
      </div>
      <div style="flex:1">${bar(Math.round(r.total / topTotal * 100), techColor(r.technology))}</div>
      <div style="width:60px;text-align:right;font-weight:700">${r.total}</div>
    </div>`).join("")}
    ${d.byTechnology.length === 0 ? '<p style="color:#94a3b8;text-align:center;padding:20px">Nenhuma tecnologia detectada</p>' : ""}
  </div>

  <!-- Top eventos -->
  <div class="card">
    <h2>🏷️ Top Eventos por Plataforma</h2>
    <table>
      <thead><tr><th>Evento</th><th>Tecnologia</th><th style="text-align:right">Disparos</th></tr></thead>
      <tbody>
        ${d.topEventNames.map(r => `
        <tr>
          <td><code style="font-size:12px">${r.event_name}</code></td>
          <td><span class="chip" style="background:${techColor(r.technology)}22;color:${techColor(r.technology)}">${r.technology}</span></td>
          <td style="text-align:right;font-weight:600">${r.total}</td>
        </tr>`).join("")}
        ${d.topEventNames.length === 0 ? '<tr><td colspan="3" style="text-align:center;color:#94a3b8;padding:20px">Sem eventos</td></tr>' : ""}
      </tbody>
    </table>
  </div>

  <!-- Cobertura por URL -->
  <div class="card">
    <h2>🌐 URLs com Eventos</h2>
    <table>
      <thead><tr><th>URL</th><th>Tecnologias</th><th style="text-align:right">Eventos</th></tr></thead>
      <tbody>
        ${d.allUrls.map(r => `
        <tr>
          <td class="tag-url">${r.url}</td>
          <td style="font-size:11px;color:#475569">${r.technologies}</td>
          <td style="text-align:right;font-weight:600">${r.total}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  </div>

  <!-- Consentimento -->
  <div class="card" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
    <div>
      <h2>✅ Estado de Consentimento</h2>
      ${d.byConsent.map(r => `
      <div class="row">
        <span style="flex:1">${r.consent_state}</span>
        <strong>${r.total}</strong>
      </div>`).join("")}
    </div>
    <div>
      <h2>🎯 Confiança de Correlação</h2>
      ${d.byConfidence.map(r => `
      <div class="row">
        <span style="flex:1">${r.correlation_confidence}</span>
        <strong>${r.total}</strong>
      </div>`).join("")}
    </div>
  </div>

  <footer>Relatório gerencial · Gerado em ${new Date().toLocaleString("pt-BR")}</footer>
</div>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  }),
);

// ─── ANALYST REPORT ───────────────────────────────────────────────────────────
// GET /api/audits/:auditId/executions/:executionId/report/analyst
// Visão detalhada por URL: cada evento com parâmetros expandíveis.
// ─────────────────────────────────────────────────────────────────────────────
exportsRouter.get(
  "/:executionId/report/analyst",
  asyncHandler(async (req, res) => {
    const executionId = requireParam(req, "executionId");
    const d = await getAnalystReport(executionId);
    const audit = await getAuditById(d.execution.auditId);

    const escHtml = (s: unknown) =>
      String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    const techColors: Record<string, string> = {
      ga4: "#f59e0b", meta_pixel: "#8b5cf6", google_ads: "#3b82f6", custom: "#10b981",
    };
    const techColor = (t: string) => techColors[t] ?? "#64748b";

    const renderParams = (params: Record<string, unknown>, id: string) => {
      const entries = Object.entries(params);
      if (entries.length === 0) return '<span style="color:#94a3b8">—</span>';
      return `
        <button onclick="toggleParams('${id}')" style="font-size:11px;padding:2px 8px;border:1px solid #e2e8f0;border-radius:4px;cursor:pointer;background:#f8fafc">
          ${entries.length} params
        </button>
        <pre id="params-${id}" style="display:none;margin-top:6px;background:#1e293b;color:#e2e8f0;padding:10px;border-radius:6px;font-size:11px;overflow:auto;max-height:200px">${escHtml(JSON.stringify(params, null, 2))}</pre>`;
    };

    const urlSections = d.byUrl.map(({ url, events }) => {
      const techsHere = [...new Set(events.map(e => e.technology))];
      const rows = events.map((e, i) => {
        const uid = e.id.slice(0, 8);
        return `
        <tr>
          <td style="color:#64748b;font-size:11px">${new Date(e.timestamp).toLocaleTimeString("pt-BR")}</td>
          <td><span style="padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600;background:${techColor(e.technology)}22;color:${techColor(e.technology)}">${escHtml(e.technology)}</span></td>
          <td><code style="font-size:12px">${escHtml(e.event_name ?? "—")}</code></td>
          <td style="font-size:11px;color:#64748b">${escHtml(e.action_type ?? "—")} ${e.sequence != null ? `#${e.sequence}` : ""}</td>
          <td>${renderParams(e.parameters as Record<string, unknown>, uid + i)}</td>
          <td style="font-size:11px">
            <span style="padding:2px 6px;border-radius:3px;font-size:10px;background:${e.correlation_confidence === "high" ? "#d1fae5" : "#fee2e2"};color:${e.correlation_confidence === "high" ? "#065f46" : "#7f1d1d"}">${e.correlation_confidence}</span>
          </td>
        </tr>`;
      }).join("");

      return `
      <details style="background:#fff;border-radius:10px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow:hidden">
        <summary style="padding:14px 18px;cursor:pointer;display:flex;align-items:center;gap:10px;list-style:none">
          <span style="font-family:monospace;font-size:12px;color:#334155;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(url)}</span>
          <span style="font-size:12px;color:#64748b">${events.length} eventos</span>
          ${techsHere.map(t => `<span style="padding:2px 8px;border-radius:12px;font-size:11px;background:${techColor(t)}22;color:${techColor(t)};font-weight:600">${t}</span>`).join("")}
        </summary>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead style="background:#f8fafc">
              <tr>
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0">Hora</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0">Tecnologia</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0">Evento</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0">Ação</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0">Parâmetros</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0">Confiança</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </details>`;
    }).join("");

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Relatório Analítico — ${escHtml(audit.name)}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f1f5f9;color:#0f172a;padding:24px}
  h1{font-size:22px;font-weight:700} h2{font-size:15px;font-weight:600;margin-bottom:12px;color:#334155}
  .meta{color:#64748b;font-size:13px;margin-top:4px}
  footer{text-align:center;color:#94a3b8;font-size:12px;margin-top:24px}
  details summary::-webkit-details-marker{display:none}
  input[type=text]{width:100%;padding:10px 14px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;margin-bottom:16px;outline:none}
  input[type=text]:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.15)}
</style>
</head>
<body>
<div style="max-width:1100px;margin:0 auto">

  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px">
    <div>
      <h1>${escHtml(audit.name)}</h1>
      <p class="meta">${escHtml(audit.objective)}</p>
      <p class="meta" style="margin-top:4px">
        v${d.execution.version} · ${d.execution.environment} · ${d.execution.status.toUpperCase()} ·
        ${d.totalEvents} eventos em ${d.byUrl.length} URLs
      </p>
    </div>
    <a href="../${executionId}/report/management"
       style="padding:8px 16px;border-radius:6px;background:#64748b;color:#fff;text-decoration:none;font-size:13px;font-weight:600">
      ← Ver Relatório Gerencial
    </a>
  </div>

  <input type="text" id="urlFilter" placeholder="Filtrar por URL ou evento..." oninput="filterUrls(this.value)">

  <div id="urlList">${urlSections}</div>
  ${d.byUrl.length === 0 ? '<p style="text-align:center;color:#94a3b8;padding:40px">Nenhum evento capturado nesta execução</p>' : ""}

  <footer>Relatório analítico · Gerado em ${new Date().toLocaleString("pt-BR")}</footer>
</div>
<script>
function toggleParams(id){
  const el = document.getElementById('params-'+id);
  if(el) el.style.display = el.style.display==='none'?'block':'none';
}
function filterUrls(q){
  const lq = q.toLowerCase();
  document.querySelectorAll('#urlList details').forEach(d=>{
    const text = d.textContent.toLowerCase();
    d.style.display = text.includes(lq) ? '' : 'none';
  });
}
</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  }),
);
