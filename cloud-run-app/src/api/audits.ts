import { Router } from "express";
import { z } from "zod";
import { createAuditSchema, parseOrThrow, updateAuditSchema } from "../domain/schemas.js";
import { asyncHandler } from "../lib/http.js";
import { requireParam } from "../lib/request.js";
import { createAudit, getAuditById, listAudits, updateAudit } from "../services/auditService.js";
import { getExecutionHistoryByAudit, getExecutionDiff, getAuditManagementReport } from "../services/executionService.js";
import { HttpError } from "../lib/http.js";

export const auditsRouter = Router();

const legacyCreateAuditSchema = z.object({
  name: z.string().trim().min(3).max(255),
  description: z.string().trim().min(5).max(2_000).optional(),
  urls: z.array(z.string().url()).min(1),
  createdBy: z.string().trim().min(3).max(255).optional(),
});

const normalizeCreateAuditPayload = (payload: unknown) => {
  const modernParsed = createAuditSchema.safeParse(payload);
  if (modernParsed.success) {
    return modernParsed.data;
  }

  const legacyParsed = legacyCreateAuditSchema.safeParse(payload);
  if (!legacyParsed.success) {
    return parseOrThrow(createAuditSchema, payload);
  }

  const legacy = legacyParsed.data;
  const mappedUrls = legacy.urls.map((value) => {
    const parsed = new URL(value);
    return {
      url: value,
      depth: 2,
      maxActions: 80,
      maxStates: 60,
      allowedDomains: [parsed.hostname],
    };
  });

  return parseOrThrow(createAuditSchema, {
    name: legacy.name,
    objective: legacy.description ?? `Auditoria iniciada a partir de ${legacy.urls[0]}`,
    createdBy: legacy.createdBy ?? "api-legacy",
    urls: mappedUrls,
    config: {
      technologies: ["ga4", "meta_pixel", "google_ads", "custom"],
      auditLevel: "inventory",
      syntheticPolicy: "ignore_unknown_fields",
      blockedActions: ["logout", "delete", "checkout", "payment", "submit_order"],
      maxDurationMinutes: 15,
    },
  });
};

auditsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const payload = normalizeCreateAuditPayload(req.body);
    const audit = await createAudit(payload);
    res.status(201).json(audit);
  }),
);

auditsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const audits = await listAudits();
    res.status(200).json(audits);
  }),
);

auditsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const audit = await getAuditById(requireParam(req, "id"));
    res.status(200).json(audit);
  }),
);

auditsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const payload = parseOrThrow(updateAuditSchema, req.body);
    const updated = await updateAudit(requireParam(req, "id"), payload);
    res.status(200).json(updated);
  }),
);

auditsRouter.get(
  "/:id/history",
  asyncHandler(async (req, res) => {
    const history = await getExecutionHistoryByAudit(requireParam(req, "id"));
    res.status(200).json(history);
  }),
);

// GET /api/audits/:id/diff?vA=1&vB=2  — delta de eventos entre duas versões
auditsRouter.get(
  "/:id/diff",
  asyncHandler(async (req, res) => {
    const auditId = requireParam(req, "id");
    const vA = parseInt(String(req.query.vA ?? ""), 10);
    const vB = parseInt(String(req.query.vB ?? ""), 10);
    if (isNaN(vA) || isNaN(vB)) throw new HttpError(400, "Query params vA and vB (integers) are required");
    const diff = await getExecutionDiff(auditId, vA, vB);
    res.status(200).json(diff);
  }),
);

// GET /api/audits/:id/report/management?urlFilter=... — relatório gerencial agregado
auditsRouter.get(
  "/:id/report/management",
  asyncHandler(async (req, res) => {
    const auditId = requireParam(req, "id");
    const urlFilter = typeof req.query.urlFilter === "string" && req.query.urlFilter.trim()
      ? req.query.urlFilter.trim()
      : undefined;

    const d = await getAuditManagementReport(auditId, urlFilter);

    const esc = (s: unknown) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    const tc = (t: string) => ({ ga4:"#f59e0b",meta_pixel:"#8b5cf6",google_ads:"#3b82f6",custom:"#10b981" } as Record<string,string>)[t] ?? "#64748b";
    const fmtDate = (ts: string | null) => ts ? new Date(ts).toLocaleString("pt-BR") : "—";
    const statusColor = (s: string) => ({ completed:"#16a34a",failed:"#dc2626",running:"#3b82f6",paused:"#f59e0b" } as Record<string,string>)[s] ?? "#64748b";
    const topEvt = d.byTechnology[0]?.total ?? 1;
    const bar = (p: number, c: string) => `<div style="height:8px;border-radius:4px;background:#e2e8f0"><div style="width:${p}%;height:100%;background:${c};border-radius:4px"></div></div>`;

    // Trend arrow between first and last execution for a URL
    const trend = (byV: Record<number, number>, versions: number[]) => {
      if (versions.length < 2) return "";
      const first = byV[versions[0]!] ?? 0;
      const last = byV[versions[versions.length - 1]!] ?? 0;
      if (last > first) return `<span style="color:#16a34a;font-weight:700">↑${last - first}</span>`;
      if (last < first) return `<span style="color:#dc2626;font-weight:700">↓${first - last}</span>`;
      return `<span style="color:#64748b">→</span>`;
    };

    const currentUrl = req.originalUrl.split("?")[0];

    // Build sorted URL list (general → specific) for the picker
    // Deduplicate by extracting scheme+host+path, strip query strings
    const allUrlsSorted = [...new Set(
      d.allUrls.map(r => {
        try { const u = new URL(r.url); return u.origin + u.pathname.replace(/\/$/, ""); }
        catch { return r.url; }
      })
    )].sort((a, b) => {
      try {
        const segsA = new URL(a).pathname.split("/").filter(Boolean).length;
        const segsB = new URL(b).pathname.split("/").filter(Boolean).length;
        return segsA !== segsB ? segsA - segsB : a.localeCompare(b);
      } catch { return a.length - b.length; }
    });

    const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<title>Relatório Consolidado — ${esc(d.audit.name)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#f1f5f9;color:#0f172a;padding:24px}
h1{font-size:22px;font-weight:700}h2{font-size:15px;font-weight:600;margin-bottom:12px;color:#334155}
.meta{color:#64748b;font-size:13px;margin-top:4px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:20px 0}
.kpi{background:#fff;border-radius:10px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.kpi .val{font-size:28px;font-weight:700;line-height:1}.kpi .lbl{font-size:11px;text-transform:uppercase;color:#94a3b8;margin-top:6px}
.card{background:#fff;border-radius:10px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:16px}
.row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f1f5f9}.row:last-child{border-bottom:none}
.badge{display:inline-block;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600}
.chip{display:inline-block;padding:3px 9px;border-radius:20px;font-size:11px;margin:2px;font-weight:500}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:8px;font-size:11px;font-weight:600;text-transform:uppercase;color:#475569;border-bottom:2px solid #e2e8f0}
td{padding:8px;border-bottom:1px solid #f1f5f9}tr:hover td{background:#f8fafc}
.tag-url{font-family:monospace;font-size:11px;color:#334155;max-width:320px;word-break:break-all}
.url-picker{background:#fff;border-radius:10px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:16px}
.url-picker input{width:100%;padding:10px 14px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;outline:none;margin-bottom:8px}
.url-picker input:focus{border-color:#7c3aed;box-shadow:0 0 0 3px rgba(124,58,237,.15)}
.url-list{max-height:260px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px}
.url-item{padding:9px 12px;font-family:monospace;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:8px;border-bottom:1px solid #f1f5f9}
.url-item:last-child{border-bottom:none}
.url-item:hover{background:#f0f0ff}
.url-item.active{background:#7c3aed22;font-weight:700}
.url-depth-0{color:#0f172a}
.url-depth-1{color:#334155;padding-left:20px}
.url-depth-2{color:#475569;padding-left:36px}
.url-depth-3{color:#64748b;padding-left:52px}
.url-depth-n{color:#94a3b8;padding-left:60px}
.depth-dot{width:6px;height:6px;border-radius:50%;background:#7c3aed;flex-shrink:0;opacity:.4}
.filter-active{display:flex;align-items:center;gap:10px;background:#7c3aed22;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px}
.filter-active strong{color:#7c3aed}
.filter-clear{padding:4px 12px;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600}
.matrix-cell{text-align:right;padding:6px 8px;font-size:12px}
.matrix-cell.zero{color:#94a3b8}
footer{text-align:center;color:#94a3b8;font-size:12px;margin-top:24px}
details summary::-webkit-details-marker{display:none}
details summary{cursor:pointer;padding:10px 14px;background:#f8fafc;border-radius:8px;margin-bottom:8px;font-weight:600;font-size:13px}
.tnav{position:sticky;top:0;z-index:100;background:#0f172a;display:flex;align-items:center;gap:8px;padding:0 20px;height:48px;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.tnav a,.tnav span{font-size:13px;text-decoration:none;white-space:nowrap}
.tnav .bk{color:#94a3b8;font-weight:500}.tnav .bk:hover{color:#fff}
.tnav .sp{color:#334155}.tnav .cr{color:#64748b}.tnav .ac{color:#fff;font-weight:600}
.tnav .nl{margin-left:auto;display:flex;gap:6px}
.tnav .nb{padding:5px 12px;border-radius:5px;font-size:12px;font-weight:600;color:#fff}.tnav .gry{background:#475569}.tnav .nb:hover{opacity:.85}
</style>
</head><body>
<nav class="tnav">
  <a href="/analysis" class="bk tnav">← Análise</a>
  <span class="sp tnav">/</span>
  <span class="cr tnav">${esc(d.audit.name)}</span>
  <span class="sp tnav">/</span>
  <span class="ac tnav">📊 Consolidado</span>
  <div class="nl">
    <a href="/analysis" class="nb gry tnav">Escolher outro relatório</a>
  </div>
</nav>
<div style="max-width:1200px;margin:0 auto;padding:24px">

<!-- Header -->
<div style="margin-bottom:16px">
  <h1>${esc(d.audit.name)}</h1>
  <p class="meta">${esc(d.audit.objective)}</p>
  <p class="meta" style="margin-top:4px">Criada em ${fmtDate(d.audit.createdAt)} · ${d.totalExecutions} execuções (${d.completedExecutions} completas)</p>
</div>

<!-- Filtro ativo -->
${urlFilter ? `
<div class="filter-active">
  <span>Filtro ativo:</span>
  <strong>${esc(urlFilter)}</strong>
  <span style="color:#64748b">→ ${d.allUrls.length} URLs encontradas, ${d.totalEvents.toLocaleString("pt-BR")} eventos</span>
  <form method="GET" action="" style="margin-left:auto">
    <button class="filter-clear" type="submit">✕ Limpar filtro</button>
  </form>
</div>` : ""}

<!-- Seletor de URL -->
<div class="url-picker">
  <p style="font-size:13px;font-weight:600;margin-bottom:8px;color:#334155">
    🔍 Filtrar por URL — selecione para ver eventos de um caminho específico
  </p>
  <input type="text" id="urlSearch" placeholder="Digite para buscar (ex: servicos, auto, viagem)..."
         value="${esc(urlFilter ?? "")}"
         oninput="filterList(this.value)" autocomplete="off" />
  <div class="url-list" id="urlList">
    ${allUrlsSorted.map(url => {
      let depth = 0;
      try { depth = Math.min(new URL(url).pathname.split("/").filter(Boolean).length, 3); }
      catch { depth = (url.match(/\//g) || []).length > 2 ? 3 : 0; }
      const active = urlFilter && url.includes(urlFilter);
      const indent = depth === 0 ? "url-depth-0" : depth === 1 ? "url-depth-1" : depth === 2 ? "url-depth-2" : "url-depth-n";
      return `<div class="url-item ${active ? "active" : ""} ${indent}" data-url="${esc(url)}" onclick="applyFilter('${esc(url.replace(/'/g, "\\'"))}')">
        <span class="depth-dot" style="opacity:${0.2 + depth * 0.2}"></span>
        <span style="font-size:${12 - depth}px">${esc(url)}</span>
        ${active ? '<span style="margin-left:auto;font-size:10px;color:#7c3aed">✓ ativo</span>' : ""}
      </div>`;
    }).join("")}
    ${allUrlsSorted.length === 0 ? '<div style="padding:16px;color:#94a3b8;text-align:center">Nenhuma URL disponível</div>' : ""}
  </div>
  <p style="font-size:11px;color:#94a3b8;margin-top:6px">
    ${allUrlsSorted.length} URLs disponíveis · Ordenadas da mais geral (raiz) para a mais específica · Clique para filtrar
  </p>
</div>

<!-- KPIs -->
<div class="grid">
  <div class="kpi"><div class="val">${d.totalEvents.toLocaleString("pt-BR")}</div><div class="lbl">Total Eventos${urlFilter ? "*" : ""}</div></div>
  <div class="kpi"><div class="val">${d.byTechnology.length}</div><div class="lbl">Tecnologias</div></div>
  <div class="kpi"><div class="val">${d.allUrls.length}</div><div class="lbl">URLs com Eventos</div></div>
  <div class="kpi"><div class="val">${d.totalExecutions}</div><div class="lbl">Execuções Total</div></div>
  <div class="kpi"><div class="val">${d.completedExecutions}</div><div class="lbl">Completas</div></div>
  <div class="kpi"><div class="val" style="color:${d.urlsWithoutEvents.length ? "#dc2626" : "#16a34a"}">${d.urlsWithoutEvents.length}</div><div class="lbl">URLs sem Eventos</div></div>
</div>

<!-- MATRIZ DE EVOLUÇÃO: URL × Execução -->
<div class="card">
  <h2>📈 Evolução por URL × Execução${urlFilter ? ` — "${esc(urlFilter)}"` : ""}</h2>
  <p style="font-size:12px;color:#64748b;margin-bottom:12px">Cada coluna = 1 execução. ↑ = cresceu, ↓ = diminuiu vs. primeira execução. <strong>—</strong> = URL não coberta nessa execução.</p>
  <div style="overflow-x:auto">
    <table>
      <thead>
        <tr>
          <th style="min-width:200px">URL</th>
          ${d.versions.map(v => {
            const exec = d.executions.find(e => e.version === v);
            const dateStr = exec?.started_at ? new Date(exec.started_at).toLocaleDateString("pt-BR") : `v${v}`;
            return `<th style="text-align:right;min-width:70px;font-size:10px">v${v}<br><span style="font-weight:400;color:#64748b">${dateStr}</span></th>`;
          }).join("")}
          <th style="text-align:right">Total</th>
          <th style="text-align:center">Tendência</th>
          <th>Tecnologias</th>
        </tr>
      </thead>
      <tbody>
        ${d.urlMatrix.slice(0, 100).map(row => {
          const cells = d.versions.map(v => {
            const n = row.byVersion[v] ?? 0;
            return `<td class="matrix-cell ${n === 0 ? "zero" : ""}">${n === 0 ? "—" : n.toLocaleString("pt-BR")}</td>`;
          }).join("");
          return `<tr>
            <td class="tag-url">${esc(row.url)}</td>
            ${cells}
            <td style="text-align:right;font-weight:700">${row.total.toLocaleString("pt-BR")}</td>
            <td style="text-align:center">${trend(row.byVersion, d.versions)}</td>
            <td><span class="chip" style="background:#e0f2fe;color:#0369a1;font-size:10px">${esc(row.technologies)}</span></td>
          </tr>`;
        }).join("")}
        ${d.urlMatrix.length === 0 ? '<tr><td colspan="99" style="text-align:center;color:#94a3b8;padding:20px">Nenhuma URL encontrada</td></tr>' : ""}
      </tbody>
    </table>
  </div>
  ${d.urlMatrix.length > 100 ? `<p style="color:#64748b;font-size:12px;margin-top:8px;text-align:center">Exibindo 100 de ${d.urlMatrix.length} URLs. Use o filtro para focar em um subdomínio.</p>` : ""}
</div>

<!-- Execuções -->
<div class="card">
  <h2>🔄 Histórico de Execuções</h2>
  <table>
    <thead><tr><th>Versão</th><th>Status</th><th style="text-align:right">Eventos${urlFilter ? "*" : ""}</th><th style="text-align:right">URLs</th><th>Início</th><th>Fim</th><th>Ver Relatório</th></tr></thead>
    <tbody>
      ${d.executions.map(e => `
      <tr>
        <td><strong>v${e.version}</strong></td>
        <td><span style="padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:${statusColor(e.status)}22;color:${statusColor(e.status)}">${e.status}</span></td>
        <td style="text-align:right">${e.events_count.toLocaleString("pt-BR")}</td>
        <td style="text-align:right">${e.urls_count}</td>
        <td style="font-size:11px;color:#64748b">${fmtDate(e.started_at)}</td>
        <td style="font-size:11px;color:#64748b">${fmtDate(e.ended_at)}</td>
        <td><a href="./executions/${e.id}/report/management" style="font-size:12px;color:#3b82f6;text-decoration:none;font-weight:600">Gerencial →</a> &nbsp; <a href="./executions/${e.id}/report/analyst" style="font-size:12px;color:#64748b;text-decoration:none;font-weight:600">Analítico →</a></td>
      </tr>`).join("")}
    </tbody>
  </table>
  ${urlFilter ? '<p style="color:#64748b;font-size:11px;margin-top:8px">* Contagens filtradas por URL contendo "' + esc(urlFilter) + '"</p>' : ""}
</div>

<!-- Tecnologias -->
<div class="card">
  <h2>📡 Tecnologias Detectadas${urlFilter ? ` em URLs com "${esc(urlFilter)}"` : " (Todas as Execuções)"}</h2>
  ${d.byTechnology.map(r => `
  <div class="row">
    <div style="width:120px"><span class="badge" style="background:${tc(r.technology)}22;color:${tc(r.technology)}">${esc(r.technology)}</span></div>
    <div style="flex:1">${bar(Math.round(r.total/topEvt*100), tc(r.technology))}</div>
    <div style="width:140px;text-align:right;font-size:12px;color:#64748b">${r.in_executions} exec · <strong>${r.total.toLocaleString("pt-BR")}</strong> eventos</div>
  </div>`).join("") || '<p style="color:#94a3b8;text-align:center;padding:20px">Nenhuma tecnologia detectada</p>'}
</div>

<!-- Top eventos -->
<div class="card">
  <h2>🏷️ Eventos por Plataforma${urlFilter ? ` em "${esc(urlFilter)}"` : " (Todas as Execuções)"}</h2>
  <table>
    <thead><tr><th>Evento</th><th>Tecnologia</th><th style="text-align:right">Total</th><th style="text-align:right">Em # Exec.</th></tr></thead>
    <tbody>
      ${d.topEventNames.slice(0,30).map(r => `
      <tr>
        <td><code style="font-size:12px">${esc(r.event_name)}</code></td>
        <td><span class="chip" style="background:${tc(r.technology)}22;color:${tc(r.technology)}">${esc(r.technology)}</span></td>
        <td style="text-align:right;font-weight:600">${r.total.toLocaleString("pt-BR")}</td>
        <td style="text-align:right;color:#64748b">${r.in_executions}</td>
      </tr>`).join("") || '<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:16px">Sem eventos</td></tr>'}
    </tbody>
  </table>
</div>

<!-- Cobertura de URLs configuradas -->
${!urlFilter ? `
<div class="card">
  <h2>🌐 URLs Configuradas vs. Visitadas</h2>
  <table>
    <thead><tr><th>URL Configurada</th><th style="text-align:center">Com Eventos?</th><th style="text-align:right">Total Eventos</th><th style="text-align:right">Em # Exec.</th><th>Tecnologias</th></tr></thead>
    <tbody>
      ${d.configuredUrls.map(cu => {
        const row = d.allUrls.find(r => r.url === cu.url);
        if (row) return `<tr><td class="tag-url">${esc(cu.url)}</td><td style="text-align:center">✅</td><td style="text-align:right;font-weight:600">${row.total_events}</td><td style="text-align:right">${row.in_executions}</td><td><span class="chip" style="background:#e0f2fe;color:#0369a1;font-size:10px">${esc(row.technologies)}</span></td></tr>`;
        return `<tr style="background:#fff1f2"><td class="tag-url">${esc(cu.url)}</td><td style="text-align:center">❌</td><td colspan="3" style="color:#dc2626;font-size:12px">Nenhum evento capturado</td></tr>`;
      }).join("") || '<tr><td colspan="5" style="color:#94a3b8;text-align:center;padding:12px">Nenhuma URL configurada</td></tr>'}
    </tbody>
  </table>
</div>` : ""}

<!-- Consentimento -->
<div class="card">
  <h2>✅ Estado de Consentimento</h2>
  ${d.byConsent.map(r => `<div class="row"><span style="flex:1">${esc(r.consent_state)}</span><strong>${r.total.toLocaleString("pt-BR")}</strong></div>`).join("") || '<p style="color:#94a3b8;text-align:center;padding:16px">Sem dados</p>'}
</div>

<footer>Relatório consolidado · ${esc(d.audit.name)}${urlFilter ? ` · Filtro: "${esc(urlFilter)}"` : ""} · Gerado em ${new Date().toLocaleString("pt-BR")}</footer>
</div>
<script>
// Filtra a lista de URLs à medida que o usuário digita
function filterList(q) {
  const lq = q.toLowerCase();
  document.querySelectorAll('#urlList .url-item').forEach(function(el) {
    const url = el.getAttribute('data-url') || '';
    el.style.display = url.toLowerCase().includes(lq) ? '' : 'none';
  });
}

// Aplica o filtro submetendo o formulário com o valor selecionado
function applyFilter(url) {
  // Constrói URL relativa preservando o path atual
  const base = window.location.pathname;
  window.location.href = base + '?urlFilter=' + encodeURIComponent(url);
}

// Inicializa: se há filtro ativo, rola a lista até o item selecionado
document.addEventListener('DOMContentLoaded', function() {
  const active = document.querySelector('.url-item.active');
  if (active) {
    active.scrollIntoView({ block: 'center' });
  }
  // Aplica o filtro de busca inicial se houver valor no input
  const input = document.getElementById('urlSearch');
  if (input && input.value) filterList(input.value);
});
</script>
</body></html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  }),
);
