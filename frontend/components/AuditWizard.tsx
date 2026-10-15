"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiRequest } from "../lib/api";

type WizardState = {
  name: string;
  objective: string;
  createdBy: string;
  url: string;
  domain: string;
  depth: number;
  maxActions: number;
  maxStates: number;
  technologies: Array<"ga4" | "meta_pixel" | "google_ads" | "custom">;
  auditLevel: "quick_check" | "inventory" | "parameters";
  templateId: string;
  syntheticPolicy: "ignore_unknown_fields" | "stop" | "request_approval";
  blockedActions: string;
  maxDurationMinutes: number;
};

const initialState: WizardState = {
  name: "",
  objective: "",
  createdBy: "",
  url: "",
  domain: "",
  depth: 3,
  maxActions: 500,
  maxStates: 100,
  technologies: ["ga4", "meta_pixel"],
  auditLevel: "inventory",
  templateId: "11111111-1111-4111-8111-111111111111",
  syntheticPolicy: "ignore_unknown_fields",
  blockedActions: "logout,delete,checkout",
  maxDurationMinutes: 30,
};

export function AuditWizard() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [state, setState] = useState<WizardState>(initialState);
  const [error, setError] = useState<string | null>(null);

  const canNext = useMemo(() => {
    if (step === 1) return state.name.trim().length > 2 && state.objective.trim().length > 4;
    if (step === 2) return state.url.startsWith("http") && state.domain.trim().length > 0;
    if (step === 3) return state.technologies.length > 0;
    if (step === 4) return true;
    if (step === 5) return state.templateId.length > 0;
    if (step === 6) return state.createdBy.trim().length > 2;
    return false;
  }, [state, step]);

  const toggleTechnology = (value: WizardState["technologies"][number]) => {
    setState((prev) => {
      const has = prev.technologies.includes(value);
      if (has) {
        return { ...prev, technologies: prev.technologies.filter((item) => item !== value) };
      }
      return { ...prev, technologies: [...prev.technologies, value] };
    });
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const audit = await apiRequest<{ id: string }>("/api/audits", {
        method: "POST",
        body: {
          name: state.name,
          objective: state.objective,
          createdBy: state.createdBy,
          templateId: state.templateId,
          urls: [
            {
              url: state.url,
              depth: state.depth,
              maxActions: state.maxActions,
              maxStates: state.maxStates,
              allowedDomains: [state.domain],
            },
          ],
          config: {
            technologies: state.technologies,
            auditLevel: state.auditLevel,
            syntheticPolicy: state.syntheticPolicy,
            blockedActions: state.blockedActions
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
            maxDurationMinutes: state.maxDurationMinutes,
          },
        },
      });
      router.push(`/audits/${audit.id}/execute`);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Falha ao criar auditoria");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-2xl font-semibold">Nova auditoria</h1>
      <p className="mt-2 text-sm text-slate-600">Etapa {step} de 6</p>

      {step === 1 && (
        <div className="mt-4 space-y-3">
          <input
            className="w-full rounded border p-2"
            placeholder="Nome da auditoria"
            value={state.name}
            onChange={(event) => setState((prev) => ({ ...prev, name: event.target.value }))}
          />
          <textarea
            className="w-full rounded border p-2"
            placeholder="Objetivo"
            rows={3}
            value={state.objective}
            onChange={(event) => setState((prev) => ({ ...prev, objective: event.target.value }))}
          />
        </div>
      )}

      {step === 2 && (
        <div className="mt-4 space-y-3">
          <input
            className="w-full rounded border p-2"
            placeholder="URL raiz"
            value={state.url}
            onChange={(event) => setState((prev) => ({ ...prev, url: event.target.value }))}
          />
          <input
            className="w-full rounded border p-2"
            placeholder="Domínio permitido (ex.: porto.com.br)"
            value={state.domain}
            onChange={(event) => setState((prev) => ({ ...prev, domain: event.target.value }))}
          />
          <div className="grid grid-cols-3 gap-3">
            <label className="text-sm">
              Profundidade
              <input
                type="number"
                min={1}
                max={5}
                className="mt-1 w-full rounded border p-2"
                value={state.depth}
                onChange={(event) => setState((prev) => ({ ...prev, depth: Number(event.target.value) }))}
              />
            </label>
            <label className="text-sm">
              Máx. ações
              <input
                type="number"
                min={1}
                className="mt-1 w-full rounded border p-2"
                value={state.maxActions}
                onChange={(event) => setState((prev) => ({ ...prev, maxActions: Number(event.target.value) }))}
              />
            </label>
            <label className="text-sm">
              Máx. estados
              <input
                type="number"
                min={1}
                className="mt-1 w-full rounded border p-2"
                value={state.maxStates}
                onChange={(event) => setState((prev) => ({ ...prev, maxStates: Number(event.target.value) }))}
              />
            </label>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="mt-4 space-y-2">
          {[
            { value: "ga4", label: "GA4" },
            { value: "meta_pixel", label: "Meta Pixel" },
            { value: "google_ads", label: "Google Ads" },
            { value: "custom", label: "Custom" },
          ].map((item) => (
            <label key={item.value} className="block">
              <input
                type="checkbox"
                checked={state.technologies.includes(item.value as WizardState["technologies"][number])}
                onChange={() => toggleTechnology(item.value as WizardState["technologies"][number])}
              />
              <span className="ml-2">{item.label}</span>
            </label>
          ))}
        </div>
      )}

      {step === 4 && (
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            Nível de auditoria
            <select
              className="mt-1 w-full rounded border p-2"
              value={state.auditLevel}
              onChange={(event) =>
                setState((prev) => ({ ...prev, auditLevel: event.target.value as WizardState["auditLevel"] }))
              }
            >
              <option value="quick_check">Verificação rápida</option>
              <option value="inventory">Inventário</option>
              <option value="parameters">Parâmetros</option>
            </select>
          </label>
        </div>
      )}

      {step === 5 && (
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            Template sintético
            <input
              className="mt-1 w-full rounded border p-2"
              value={state.templateId}
              onChange={(event) => setState((prev) => ({ ...prev, templateId: event.target.value }))}
            />
          </label>
        </div>
      )}

      {step === 6 && (
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            Política de campo desconhecido
            <select
              className="mt-1 w-full rounded border p-2"
              value={state.syntheticPolicy}
              onChange={(event) =>
                setState((prev) => ({
                  ...prev,
                  syntheticPolicy: event.target.value as WizardState["syntheticPolicy"],
                }))
              }
            >
              <option value="ignore_unknown_fields">Ignorar</option>
              <option value="stop">Parar</option>
              <option value="request_approval">Pedir aprovação</option>
            </select>
          </label>
          <label className="block text-sm">
            Ações bloqueadas (CSV)
            <input
              className="mt-1 w-full rounded border p-2"
              value={state.blockedActions}
              onChange={(event) => setState((prev) => ({ ...prev, blockedActions: event.target.value }))}
            />
          </label>
          <label className="block text-sm">
            Usuário executor
            <input
              className="mt-1 w-full rounded border p-2"
              value={state.createdBy}
              onChange={(event) => setState((prev) => ({ ...prev, createdBy: event.target.value }))}
            />
          </label>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <div className="mt-6 flex items-center justify-between">
        <button
          className="rounded border px-4 py-2 disabled:opacity-50"
          type="button"
          disabled={step === 1}
          onClick={() => setStep((value) => Math.max(1, value - 1))}
        >
          Voltar
        </button>
        {step < 6 ? (
          <button
            className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
            type="button"
            disabled={!canNext}
            onClick={() => setStep((value) => Math.min(6, value + 1))}
          >
            Próximo
          </button>
        ) : (
          <button
            className="rounded bg-green-700 px-4 py-2 text-white disabled:opacity-50"
            type="button"
            disabled={!canNext || submitting}
            onClick={handleSubmit}
          >
            {submitting ? "Executando..." : "Executar"}
          </button>
        )}
      </div>
    </section>
  );
}
