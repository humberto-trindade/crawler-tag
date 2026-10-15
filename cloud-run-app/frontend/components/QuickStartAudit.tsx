"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiRequest } from "../lib/api";

type Technology = "ga4" | "meta_pixel" | "google_ads" | "custom";
type AuditLevel = "quick_check" | "inventory" | "parameters";
type SyntheticPolicy = "ignore_unknown_fields" | "stop" | "request_approval";
type BrowserMode = "headless" | "visual";

type Template = {
  id: string;
  name: string;
  version: number;
};

type Defaults = {
  depth: number;
  maxActions: number;
  maxStates: number;
  maxDurationMinutes: number;
  technologies: Technology[];
  auditLevel: AuditLevel;
  syntheticPolicy: SyntheticPolicy;
};

const DEFAULT_SETTINGS_KEY = "crawler-tag-defaults-v2";

const defaultValues: Defaults = {
  depth: 2,
  maxActions: 80,
  maxStates: 60,
  maxDurationMinutes: 15,
  technologies: ["ga4", "meta_pixel", "google_ads", "custom"],
  auditLevel: "inventory",
  syntheticPolicy: "ignore_unknown_fields",
};

const parseSettings = (): Defaults => {
  if (typeof window === "undefined") return defaultValues;
  try {
    const raw = window.localStorage.getItem(DEFAULT_SETTINGS_KEY);
    if (!raw) return defaultValues;
    const parsed = JSON.parse(raw) as Partial<Defaults>;
    return {
      depth: parsed.depth ?? defaultValues.depth,
      maxActions: parsed.maxActions ?? defaultValues.maxActions,
      maxStates: parsed.maxStates ?? defaultValues.maxStates,
      maxDurationMinutes: parsed.maxDurationMinutes ?? defaultValues.maxDurationMinutes,
      technologies:
        parsed.technologies && parsed.technologies.length > 0
          ? parsed.technologies
          : defaultValues.technologies,
      auditLevel: parsed.auditLevel ?? defaultValues.auditLevel,
      syntheticPolicy: parsed.syntheticPolicy ?? defaultValues.syntheticPolicy,
    };
  } catch {
    return defaultValues;
  }
};

const normalizeUrl = (rawValue: string): string | null => {
  const value = rawValue.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
};

const parseUrlList = (startUrl: string, rawList: string): string[] => {
  const normalized = [normalizeUrl(startUrl)]
    .filter((value): value is string => Boolean(value));
  
  if (rawList.trim()) {
    const additional = rawList
      .split(/[\n,;]+/g)
      .map((line) => normalizeUrl(line.trim()))
      .filter((value): value is string => Boolean(value));
    normalized.push(...additional);
  }
  
  return Array.from(new Set(normalized));
};

const toggleTechnology = (technologies: Technology[], value: Technology) => {
  if (technologies.includes(value)) {
    return technologies.filter((technology) => technology !== value);
  }
  return [...technologies, value];
};

export function QuickStartAudit() {
  const router = useRouter();
  const defaults = useMemo(parseSettings, []);
  const [startUrl, setStartUrl] = useState("https://www.portoseguro.com.br/loja/seguro-viagem");
  const [extraUrls, setExtraUrls] = useState("");
  const [executionName, setExecutionName] = useState("");
  const [createdBy, setCreatedBy] = useState("analista.local");
  const [templateId, setTemplateId] = useState("");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [depth, setDepth] = useState(defaults.depth);
  const [maxActions, setMaxActions] = useState(defaults.maxActions);
  const [maxStates, setMaxStates] = useState(defaults.maxStates);
  const [maxDurationMinutes, setMaxDurationMinutes] = useState(defaults.maxDurationMinutes);
  const [auditLevel, setAuditLevel] = useState<AuditLevel>(defaults.auditLevel);
  const [syntheticPolicy, setSyntheticPolicy] = useState<SyntheticPolicy>(defaults.syntheticPolicy);
  const [technologies, setTechnologies] = useState<Technology[]>(defaults.technologies);
  const [singleUrlMode, setSingleUrlMode] = useState(false);
  const [browserMode, setBrowserMode] = useState<BrowserMode>("headless");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = await apiRequest<Template[]>("/api/templates");
        setTemplates(list);
        if (list[0]) {
          setTemplateId(list[0].id);
        }
      } catch (loadError) {
        // Falha silenciosa ao carregar templates - não é crítico
        console.warn("Aviso ao carregar personas:", loadError);
      } finally {
        setLoadingTemplates(false);
      }
    })();
  }, []);

  const canSubmit = useMemo(() => {
    return Boolean(normalizeUrl(startUrl)) && technologies.length > 0 && createdBy.trim().length >= 3;
  }, [startUrl, technologies, createdBy]);

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const normalizedStart = normalizeUrl(startUrl);
      if (!normalizedStart) {
        throw new Error("URL inicial inválida. Use http:// ou https://");
      }
      
      const urls = singleUrlMode 
        ? [normalizedStart]
        : parseUrlList(startUrl, extraUrls);
      
      if (urls.length === 0) {
        throw new Error("Informe ao menos uma URL válida.");
      }
      if (maxActions < 1 || maxStates < 1 || maxDurationMinutes < 1) {
        throw new Error("Os limites de ações, estados e duração devem ser maiores que zero.");
      }

      const firstHost = new URL(urls[0] ?? startUrl).hostname;
      const timestamp = new Date().toLocaleString("pt-BR");
      const auditName = executionName.trim() || `Auditoria rápida - ${firstHost} - ${timestamp}`;
      const objective = `Execução rápida a partir de ${urls[0]}`;

      const audit = await apiRequest<{ id: string }>("/api/audits", {
        method: "POST",
        body: {
          name: auditName,
          objective,
          createdBy: createdBy.trim(),
          templateId: templateId || undefined,
          urls: urls.map((url) => {
            const hostname = new URL(url).hostname;
            return {
              url,
              depth: singleUrlMode ? 0 : depth,
              maxActions,
              maxStates,
              allowedDomains: [hostname],
              singleUrlMode,
            };
          }),
          config: {
            technologies,
            auditLevel,
            syntheticPolicy,
            browserMode,
            blockedActions: ["logout", "delete", "checkout", "payment", "submit_order"],
            maxDurationMinutes,
          },
        },
      });

      const execution = await apiRequest<{ id: string }>(`/api/audits/${audit.id}/executions`, {
        method: "POST",
        body: { platform: "web", environment: "cloud-run" },
      });
      if (!execution.id) {
        throw new Error("A auditoria foi criada, mas a execução não foi registrada.");
      }

      router.push(`/audits/${audit.id}/execute`);
    } catch (submitError) {
      const errorMessage = submitError instanceof Error 
        ? submitError.message 
        : "Não foi possível iniciar a execução. Verifique se o servidor está respondendo.";
      setError(errorMessage);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="space-y-5 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <header>
        <h1 className="text-2xl font-semibold">Início Rápido</h1>
        <p className="mt-1 text-sm text-slate-600">
          Informe a URL inicial e execute agora. As opções avançadas são opcionais e já têm defaults.
        </p>
      </header>

      <label className="block text-sm">
        URL inicial <span className="text-red-600">*</span>
        <input
          className="mt-1 w-full rounded border p-2"
          value={startUrl}
          onChange={(event) => setStartUrl(event.target.value)}
          placeholder="https://www.exemplo.com.br/jornada"
        />
      </label>

      {!singleUrlMode && (
        <label className="block text-sm">
          Lista de URLs (opcional, uma por linha)
          <textarea
            className="mt-1 w-full rounded border p-2"
            rows={4}
            value={extraUrls}
            onChange={(event) => setExtraUrls(event.target.value)}
            placeholder="https://site.com/url-2&#10;https://site.com/url-3"
          />
        </label>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={singleUrlMode}
          onChange={(event) => setSingleUrlMode(event.target.checked)}
        />
        <span>
          <strong>Modo URL Única</strong> - Validar apenas a URL inicial (sem navegar para outros links). A página pode ter múltiplos estados interativos.
        </span>
      </label>

      <label className="block text-sm">
        Modo de execução do navegador
        <select
          className="mt-1 w-full rounded border p-2"
          value={browserMode}
          onChange={(event) => setBrowserMode(event.target.value as BrowserMode)}
        >
          <option value="headless">Headless (rápido, em segundo plano)</option>
          <option value="visual">Visual (abre navegador para acompanhamento)</option>
        </select>
      </label>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm">
          Nome da execução (opcional)
          <input
            className="mt-1 w-full rounded border p-2"
            value={executionName}
            onChange={(event) => setExecutionName(event.target.value)}
            placeholder="Será gerado automaticamente se vazio"
          />
        </label>
        <label className="block text-sm">
          Usuário executor
          <input
            className="mt-1 w-full rounded border p-2"
            value={createdBy}
            onChange={(event) => setCreatedBy(event.target.value)}
          />
        </label>
      </div>

      <button
        type="button"
        className="rounded border px-3 py-2 text-sm"
        onClick={() => setAdvancedOpen((value) => !value)}
      >
        {advancedOpen ? "Ocultar opções avançadas" : "Abrir opções avançadas"}
      </button>

      {advancedOpen && (
        <div className="space-y-4 rounded border border-slate-200 bg-slate-50 p-4">
          <h2 className="text-sm font-medium text-slate-700">Configurações avançadas (opcionais)</h2>

          <div className="grid gap-3 md:grid-cols-4">
            {!singleUrlMode && (
              <label className="text-sm">
                Profundidade
                <input
                  type="number"
                  min={1}
                  max={5}
                  className="mt-1 w-full rounded border p-2"
                  value={depth}
                  onChange={(event) => setDepth(Number(event.target.value))}
                />
              </label>
            )}
            <label className="text-sm">
              Máx. ações
              <input
                type="number"
                min={1}
                className="mt-1 w-full rounded border p-2"
                value={maxActions}
                onChange={(event) => setMaxActions(Number(event.target.value))}
              />
            </label>
            <label className="text-sm">
              Máx. estados
              <input
                type="number"
                min={1}
                className="mt-1 w-full rounded border p-2"
                value={maxStates}
                onChange={(event) => setMaxStates(Number(event.target.value))}
              />
            </label>
            <label className="text-sm">
              Duração máx. (min)
              <input
                type="number"
                min={1}
                max={180}
                className="mt-1 w-full rounded border p-2"
                value={maxDurationMinutes}
                onChange={(event) => setMaxDurationMinutes(Number(event.target.value))}
              />
            </label>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              Nível de auditoria
              <select
                className="mt-1 w-full rounded border p-2"
                value={auditLevel}
                onChange={(event) => setAuditLevel(event.target.value as AuditLevel)}
              >
                <option value="quick_check">Verificação rápida</option>
                <option value="inventory">Inventário</option>
                <option value="parameters">Auditoria de parâmetros</option>
              </select>
            </label>
            <label className="text-sm">
              Persona de dados
              <select
                className="mt-1 w-full rounded border p-2"
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
                disabled={loadingTemplates || templates.length === 0}
              >
                {templates.length === 0 && <option value="">Sem personas cadastradas</option>}
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name} (v{template.version})
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="text-sm">
            Política para campo não mapeado
            <select
              className="mt-1 w-full rounded border p-2"
              value={syntheticPolicy}
              onChange={(event) => setSyntheticPolicy(event.target.value as SyntheticPolicy)}
            >
              <option value="ignore_unknown_fields">Ignorar e registrar aviso</option>
              <option value="stop">Parar execução</option>
              <option value="request_approval">Pedir aprovação</option>
            </select>
          </label>

          <div>
            <p className="text-sm font-medium">Tecnologias monitoradas</p>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              {[
                { value: "ga4", label: "GA4" },
                { value: "meta_pixel", label: "Meta Pixel" },
                { value: "google_ads", label: "Google Ads" },
                { value: "custom", label: "Custom" },
              ].map((item) => (
                <label key={item.value} className="text-sm">
                  <input
                    type="checkbox"
                    checked={technologies.includes(item.value as Technology)}
                    onChange={() =>
                      setTechnologies((prev) => toggleTechnology(prev, item.value as Technology))
                    }
                  />
                  <span className="ml-2">{item.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
          disabled={!canSubmit || submitting}
          onClick={submit}
        >
          {submitting ? "Iniciando..." : "Executar agora"}
        </button>
      </div>
    </section>
  );
}
