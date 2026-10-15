"use client";

import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../lib/api";

type TemplateField = {
  key: string;
  value: string;
  matchers?: {
    attributes?: string[];
    labels?: string[];
    types?: string[];
    autocomplete?: string[];
    placeholders?: string[];
  };
};

type Template = {
  id: string;
  name: string;
  version: number;
  data: { keys: TemplateField[] };
  createdAt: string;
};

const defaultFields: TemplateField[] = [
  {
    key: "full_name",
    value: "Pessoa Teste",
    matchers: { attributes: ["nome", "full_name"], labels: ["nome completo"] },
  },
  {
    key: "email",
    value: "pessoa.teste@example.test",
    matchers: { attributes: ["email", "e-mail"], types: ["email"], autocomplete: ["email"] },
  },
  {
    key: "phone",
    value: "11999990000",
    matchers: { attributes: ["telefone", "phone", "celular"], types: ["tel"], autocomplete: ["tel"] },
  },
  {
    key: "cep",
    value: "01311000",
    matchers: {
      attributes: ["cep", "postal_code", "zipcode", "zip_code"],
      labels: ["cep", "codigo postal"],
      autocomplete: ["postal-code"],
    },
  },
  {
    key: "pcf",
    value: "00000000000",
    matchers: {
      attributes: ["pcf", "documento", "doc"],
      labels: ["pcf", "documento"],
      placeholders: ["pcf"],
    },
  },
  {
    key: "cpf",
    value: "11144477735",
    matchers: {
      attributes: ["cpf", "documento", "doc", "nr_cpf"],
      labels: ["cpf", "documento"],
      placeholders: ["cpf"],
    },
  },
  {
    key: "cnpj",
    value: "11222333000181",
    matchers: {
      attributes: ["cnpj", "nr_cnpj", "documento_empresa"],
      labels: ["cnpj"],
      placeholders: ["cnpj"],
    },
  },
  {
    key: "startDate",
    value: "2024-06-15",
    matchers: {
      attributes: ["startDate", "start_date", "inicio", "data_inicio"],
      labels: ["data de início", "date inicial"],
      types: ["date"],
      autocomplete: ["off"],
      placeholders: ["data de início"],
    },
  },
  {
    key: "endDate",
    value: "2024-12-31",
    matchers: {
      attributes: ["endDate", "end_date", "fim", "data_fim"],
      labels: ["data de fim", "date final"],
      types: ["date"],
      autocomplete: ["off"],
      placeholders: ["data de fim"],
    },
  },
  {
    key: "dataInicio",
    value: "2024-06-15",
    matchers: {
      attributes: ["dataInicio", "data_inicio"],
      labels: ["data de início"],
      types: ["date"],
      placeholders: ["data de início"],
    },
  },
  {
    key: "dataFim",
    value: "2024-12-31",
    matchers: {
      attributes: ["dataFim", "data_fim"],
      labels: ["data de fim"],
      types: ["date"],
      placeholders: ["data de fim"],
    },
  },
  {
    key: "birthDate",
    value: "1990-01-15",
    matchers: {
      attributes: ["birthDate", "birth_date", "data_nascimento", "data_nasc"],
      labels: ["data de nascimento"],
      types: ["date"],
      autocomplete: ["bday"],
      placeholders: ["data de nascimento"],
    },
  },
];

const serializeMatchers = (matchers?: TemplateField["matchers"]) => ({
  attributes: (matchers?.attributes ?? []).join(", "),
  labels: (matchers?.labels ?? []).join(", "),
  types: (matchers?.types ?? []).join(", "),
  autocomplete: (matchers?.autocomplete ?? []).join(", "),
  placeholders: (matchers?.placeholders ?? []).join(", "),
});

const parseCsv = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export function PersonaTemplatesManager() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [name, setName] = useState("");
  const [createdBy, setCreatedBy] = useState("analista.local");
  const [fields, setFields] = useState<TemplateField[]>(defaultFields);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);

  const selected = useMemo(
    () => templates.find((template) => template.id === selectedId) ?? null,
    [templates, selectedId],
  );

  const loadTemplates = async () => {
    try {
      const rows = await apiRequest<Template[]>("/api/templates");
      setTemplates(rows);
      if (!selectedId && rows[0]) {
        setSelectedId(rows[0].id);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Falha ao carregar personas");
    }
  };

  useEffect(() => {
    void loadTemplates();
  }, []);

  useEffect(() => {
    if (!selected) return;
    setName(selected.name);
    setFields(selected.data?.keys?.length ? selected.data.keys : defaultFields);
  }, [selected]);

  const updateField = (index: number, patch: Partial<TemplateField>) => {
    setFields((current) => {
      const next = [...current];
      const target = next[index];
      if (!target) return current;
      next[index] = { ...target, ...patch };
      return next;
    });
  };

  const updateMatcher = (index: number, field: keyof NonNullable<TemplateField["matchers"]>, value: string) => {
    const parsedValues = parseCsv(value);
    setFields((current) => {
      const next = [...current];
      const target = next[index];
      if (!target) return current;
      const currentMatchers = target.matchers ?? {};
      next[index] = {
        ...target,
        matchers: {
          ...currentMatchers,
          [field]: parsedValues,
        },
      };
      return next;
    });
  };

  const addField = () => {
    setFields((current) => [...current, { key: "custom_field", value: "valor_teste" }]);
  };

  const removeField = (index: number) => {
    setFields((current) => current.filter((_, fieldIndex) => fieldIndex !== index));
  };

  const saveNewVersion = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      await apiRequest(`/api/templates/${selected.id}`, {
        method: "PATCH",
        body: {
          name: name.trim(),
          createdBy: createdBy.trim(),
          data: { keys: fields },
        },
      });
      await loadTemplates();
      setStatus("Edição salva como nova versão da persona.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Falha ao salvar persona");
    } finally {
      setSaving(false);
    }
  };

  const createPersona = async () => {
    setCreating(true);
    setError(null);
    setStatus(null);
    try {
      const created = await apiRequest<Template>("/api/templates", {
        method: "POST",
        body: {
          name: "Nova Persona de Teste",
          createdBy: createdBy.trim(),
          data: { keys: defaultFields },
        },
      });
      await loadTemplates();
      setSelectedId(created.id);
      setStatus("Nova persona criada. Você já pode editar os campos e salvar uma nova versão.");
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Falha ao criar persona");
    } finally {
      setCreating(false);
    }
  };

  const archivePersona = async () => {
    if (!selected) return;
    setError(null);
    setStatus(null);
    const confirmed = window.confirm(
      "Arquivar remove esta persona da lista de uso. Deseja continuar?",
    );
    if (!confirmed) return;
    try {
      await apiRequest(`/api/templates/${selected.id}`, { method: "DELETE" });
      setSelectedId("");
      await loadTemplates();
      setStatus("Persona arquivada com sucesso.");
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : "Falha ao arquivar persona");
    }
  };

  return (
    <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Personas & Templates</h1>
          <p className="mt-1 text-sm text-slate-600">
            Edite os dados sintéticos usados para preencher formulários durante o crawl.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Fluxo: selecione uma persona na lista, edite os campos e clique em{" "}
            <strong>Salvar edição (nova versão)</strong>. Para remover da operação, use{" "}
            <strong>Arquivar persona</strong>.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded border px-3 py-2 text-sm"
            disabled={creating}
            onClick={createPersona}
          >
            {creating ? "Criando..." : "Nova persona"}
          </button>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <aside className="space-y-2 rounded border p-3">
          <h2 className="text-sm font-medium text-slate-700">Personas disponíveis</h2>
          {templates.map((template) => (
            <button
              type="button"
              key={template.id}
              className={`w-full rounded border p-2 text-left text-sm ${
                selectedId === template.id ? "border-slate-900 bg-slate-100" : "border-slate-200 bg-white"
              }`}
              onClick={() => setSelectedId(template.id)}
            >
              <p className="font-medium">{template.name}</p>
              <p className="text-xs text-slate-500">
                v{template.version} • {new Date(template.createdAt).toLocaleDateString("pt-BR")}
              </p>
            </button>
          ))}
          {templates.length === 0 && <p className="text-sm text-slate-500">Nenhuma persona cadastrada.</p>}
        </aside>

        <div className="space-y-3 lg:col-span-2">
          {!selected && (
            <div className="rounded border border-dashed p-4 text-sm text-slate-600">
              Selecione uma persona para visualizar e editar os dados.
            </div>
          )}

          {selected && (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="text-sm">
                  Nome amigável da persona
                  <input
                    className="mt-1 w-full rounded border p-2"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <label className="text-sm">
                  Usuário editor
                  <input
                    className="mt-1 w-full rounded border p-2"
                    value={createdBy}
                    onChange={(event) => setCreatedBy(event.target.value)}
                  />
                </label>
              </div>

              <div className="space-y-3 rounded border p-3">
                <h3 className="text-sm font-medium">Campos sintéticos usados pelo crawler</h3>
                {fields.map((field, index) => {
                  const matcherText = serializeMatchers(field.matchers);
                  return (
                    <div key={`${field.key}-${index}`} className="rounded border p-3">
                      <div className="grid gap-2 md:grid-cols-3">
                        <label className="text-xs">
                          Chave
                          <input
                            className="mt-1 w-full rounded border p-2 text-sm"
                            value={field.key}
                            onChange={(event) => updateField(index, { key: event.target.value })}
                          />
                        </label>
                        <label className="text-xs md:col-span-2">
                          Valor sintético
                          <input
                            className="mt-1 w-full rounded border p-2 text-sm"
                            value={field.value}
                            onChange={(event) => updateField(index, { value: event.target.value })}
                          />
                        </label>
                      </div>

                      <div className="mt-2 grid gap-2 md:grid-cols-2">
                        <label className="text-xs">
                          Matchers de atributo (CSV)
                          <input
                            className="mt-1 w-full rounded border p-2 text-sm"
                            value={matcherText.attributes}
                            onChange={(event) => updateMatcher(index, "attributes", event.target.value)}
                          />
                        </label>
                        <label className="text-xs">
                          Matchers de label (CSV)
                          <input
                            className="mt-1 w-full rounded border p-2 text-sm"
                            value={matcherText.labels}
                            onChange={(event) => updateMatcher(index, "labels", event.target.value)}
                          />
                        </label>
                        <label className="text-xs">
                          Types (CSV)
                          <input
                            className="mt-1 w-full rounded border p-2 text-sm"
                            value={matcherText.types}
                            onChange={(event) => updateMatcher(index, "types", event.target.value)}
                          />
                        </label>
                        <label className="text-xs">
                          Autocomplete (CSV)
                          <input
                            className="mt-1 w-full rounded border p-2 text-sm"
                            value={matcherText.autocomplete}
                            onChange={(event) => updateMatcher(index, "autocomplete", event.target.value)}
                          />
                        </label>
                      </div>

                      <div className="mt-2">
                        <button
                          type="button"
                          className="rounded border px-2 py-1 text-xs"
                          onClick={() => removeField(index)}
                        >
                          Remover campo
                        </button>
                      </div>
                    </div>
                  );
                })}
                <button type="button" className="rounded border px-3 py-2 text-sm" onClick={addField}>
                  Adicionar campo
                </button>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
                  disabled={saving}
                  onClick={saveNewVersion}
                >
                  {saving ? "Salvando..." : "Salvar edição (nova versão)"}
                </button>
                <button
                  type="button"
                  className="rounded border border-red-300 px-4 py-2 text-red-700"
                  onClick={archivePersona}
                >
                  Arquivar persona
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {status && <p className="rounded bg-emerald-50 p-3 text-sm text-emerald-700">{status}</p>}
    </section>
  );
}
