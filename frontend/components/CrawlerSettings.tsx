"use client";

import { useMemo, useState } from "react";

type Technology = "ga4" | "meta_pixel" | "google_ads" | "custom";
type AuditLevel = "quick_check" | "inventory" | "parameters";
type SyntheticPolicy = "ignore_unknown_fields" | "stop" | "request_approval";

type Defaults = {
  depth: number;
  maxActions: number;
  maxStates: number;
  maxDurationMinutes: number;
  technologies: Technology[];
  auditLevel: AuditLevel;
  syntheticPolicy: SyntheticPolicy;
};

const SETTINGS_KEY = "crawler-tag-defaults-v2";

const fallbackDefaults: Defaults = {
  depth: 2,
  maxActions: 80,
  maxStates: 60,
  maxDurationMinutes: 15,
  technologies: ["ga4", "meta_pixel", "google_ads", "custom"],
  auditLevel: "inventory",
  syntheticPolicy: "ignore_unknown_fields",
};

const loadDefaults = (): Defaults => {
  if (typeof window === "undefined") return fallbackDefaults;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return fallbackDefaults;
    const parsed = JSON.parse(raw) as Partial<Defaults>;
    return {
      depth: parsed.depth ?? fallbackDefaults.depth,
      maxActions: parsed.maxActions ?? fallbackDefaults.maxActions,
      maxStates: parsed.maxStates ?? fallbackDefaults.maxStates,
      maxDurationMinutes: parsed.maxDurationMinutes ?? fallbackDefaults.maxDurationMinutes,
      technologies:
        parsed.technologies && parsed.technologies.length > 0
          ? parsed.technologies
          : fallbackDefaults.technologies,
      auditLevel: parsed.auditLevel ?? fallbackDefaults.auditLevel,
      syntheticPolicy: parsed.syntheticPolicy ?? fallbackDefaults.syntheticPolicy,
    };
  } catch {
    return fallbackDefaults;
  }
};

export function CrawlerSettings() {
  const saved = useMemo(loadDefaults, []);
  const [depth, setDepth] = useState(saved.depth);
  const [maxActions, setMaxActions] = useState(saved.maxActions);
  const [maxStates, setMaxStates] = useState(saved.maxStates);
  const [maxDurationMinutes, setMaxDurationMinutes] = useState(saved.maxDurationMinutes);
  const [auditLevel, setAuditLevel] = useState<AuditLevel>(saved.auditLevel);
  const [syntheticPolicy, setSyntheticPolicy] = useState<SyntheticPolicy>(saved.syntheticPolicy);
  const [technologies, setTechnologies] = useState<Technology[]>(saved.technologies);
  const [status, setStatus] = useState<string | null>(null);

  const toggleTechnology = (value: Technology) => {
    setTechnologies((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    );
  };

  const save = () => {
    const payload: Defaults = {
      depth,
      maxActions,
      maxStates,
      maxDurationMinutes,
      technologies: technologies.length > 0 ? technologies : fallbackDefaults.technologies,
      auditLevel,
      syntheticPolicy,
    };
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload));
    setStatus("Configurações salvas.");
  };

  const reset = () => {
    window.localStorage.removeItem(SETTINGS_KEY);
    setDepth(fallbackDefaults.depth);
    setMaxActions(fallbackDefaults.maxActions);
    setMaxStates(fallbackDefaults.maxStates);
    setMaxDurationMinutes(fallbackDefaults.maxDurationMinutes);
    setTechnologies(fallbackDefaults.technologies);
    setAuditLevel(fallbackDefaults.auditLevel);
    setSyntheticPolicy(fallbackDefaults.syntheticPolicy);
    setStatus("Defaults restaurados.");
  };

  return (
    <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <header>
        <h1 className="text-2xl font-semibold">Configurações de Crawl</h1>
        <p className="mt-1 text-sm text-slate-600">
          Esses valores são aplicados automaticamente no Início Rápido.
        </p>
      </header>

      <div className="grid gap-3 md:grid-cols-4">
        <label className="text-sm">
          Profundidade
          <input
            className="mt-1 w-full rounded border p-2"
            type="number"
            min={1}
            max={5}
            value={depth}
            onChange={(event) => setDepth(Number(event.target.value))}
          />
        </label>
        <label className="text-sm">
          Máx. ações
          <input
            className="mt-1 w-full rounded border p-2"
            type="number"
            min={1}
            value={maxActions}
            onChange={(event) => setMaxActions(Number(event.target.value))}
          />
        </label>
        <label className="text-sm">
          Máx. estados
          <input
            className="mt-1 w-full rounded border p-2"
            type="number"
            min={1}
            value={maxStates}
            onChange={(event) => setMaxStates(Number(event.target.value))}
          />
        </label>
        <label className="text-sm">
          Duração máx. (min)
          <input
            className="mt-1 w-full rounded border p-2"
            type="number"
            min={1}
            max={180}
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
          Política de campo não mapeado
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
      </div>

      <div>
        <p className="text-sm font-medium">Tecnologias padrão</p>
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
                onChange={() => toggleTechnology(item.value as Technology)}
              />
              <span className="ml-2">{item.label}</span>
            </label>
          ))}
        </div>
      </div>

      {status && <p className="text-sm text-emerald-700">{status}</p>}

      <div className="flex gap-3">
        <button type="button" className="rounded bg-slate-900 px-4 py-2 text-white" onClick={save}>
          Salvar defaults
        </button>
        <button type="button" className="rounded border px-4 py-2" onClick={reset}>
          Restaurar padrão
        </button>
      </div>
    </section>
  );
}
