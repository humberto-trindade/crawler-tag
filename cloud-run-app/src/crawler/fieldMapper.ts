import type { CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

export type TemplateKey = {
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

export type FieldMappingResult =
  | { type: "mapped"; key: string; value: string }
  | { type: "ignored"; reason: "no_mapping" | "ambiguous_mapping" | "unsupported_type" };

export type FieldHints = {
  name: string;
  id: string;
  dataField: string;
  type: string;
  autocomplete: string;
  placeholder: string;
  ariaLabel: string;
  label: string;
  contextText: string;
};

const normalize = (value: string | undefined) => (value ?? "").toLowerCase().trim();

const formatDateOffset = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const findTemplateValue = (templateKeys: TemplateKey[], includesAny: string[]) => {
  const target = templateKeys.find((item) => {
    const key = item.key.toLowerCase();
    return includesAny.some((term) => key.includes(term));
  });
  return target?.value;
};

const collectInputHints = ($: CheerioAPI, element: AnyNode): FieldHints => {
  const name = normalize($(element).attr("name"));
  const id = normalize($(element).attr("id"));
  const dataField = normalize($(element).attr("data-field"));
  const type = normalize($(element).attr("type"));
  const autocomplete = normalize($(element).attr("autocomplete"));
  const placeholder = normalize($(element).attr("placeholder"));
  const ariaLabel = normalize($(element).attr("aria-label"));
  const contextText = normalize($(element).closest("form, section, article, div").text()).slice(0, 240);
  let label = "";

  if (id) {
    const labelText = $(`label[for="${id}"]`).first().text();
    label = normalize(labelText);
  }

  if (!label) {
    label = normalize($(element).closest("label").text());
  }

  return { name, id, dataField, type, autocomplete, placeholder, ariaLabel, label, contextText };
};

const matches = (hints: FieldHints, key: TemplateKey) => {
  const matcher = key.matchers;
  if (!matcher) {
    return false;
  }

  const attributes = matcher.attributes ?? [];
  const labels = matcher.labels ?? [];
  const types = matcher.types ?? [];
  const autocompletes = matcher.autocomplete ?? [];
  const placeholders = matcher.placeholders ?? [];

  const attributeMatched = attributes.some((term) =>
    [hints.name, hints.id, hints.dataField].some((candidate) => candidate.includes(term.toLowerCase())),
  );
  const labelMatched = labels.some((term) => hints.label.includes(term.toLowerCase()));
  const typeMatched = types.some((term) => hints.type === term.toLowerCase());
  const autocompleteMatched = autocompletes.some((term) => hints.autocomplete === term.toLowerCase());
  const placeholderMatched = placeholders.some(
    (term) => hints.placeholder.includes(term.toLowerCase()) || hints.ariaLabel.includes(term.toLowerCase()),
  );

  return attributeMatched || labelMatched || typeMatched || autocompleteMatched || placeholderMatched;
};

export const resolveFieldMapping = (
  $: CheerioAPI,
  element: AnyNode,
  templateKeys: TemplateKey[],
): FieldMappingResult => {
  const hints = collectInputHints($, element);
  return resolveFieldMappingFromHints(hints, templateKeys);
};

export const resolveFieldMappingFromHints = (
  hints: FieldHints,
  templateKeys: TemplateKey[],
): FieldMappingResult => {
  const joinedHints = [
    hints.name,
    hints.id,
    hints.dataField,
    hints.autocomplete,
    hints.placeholder,
    hints.ariaLabel,
    hints.label,
    hints.contextText,
  ]
    .join(" ")
    .toLowerCase();
  
  // Admin/3p element filtering (expanded patterns)
  const adminPatterns = [
    // Cookiebot/Consent
    "ot-group-id",
    "optanon",
    "cookie-consent",
    "cookie-consent-plus",
    
    // BMC Software (Help Chat)
    "bmc-",
    "valvechat",
    
    // Vendor Management
    "vendor-",
    "storage-access",
    "storage-",
    
    // Batch Operations
    "select-all",
    "selectall",
    
    // Placeholders
    "replace-with",
    "replace_with",
    "dyanmic-host-id",
    
    // Portocap Admin
    "portocap__",
    "func__",
    
    // Admin/DevTools
    "__admin",
    "admin-",
    "dev-",
    "test-"
  ];
  
  if (
    ["file", "password", "hidden", "button", "submit", "reset"].includes(hints.type) ||
    adminPatterns.some(pattern => joinedHints.includes(pattern))
  ) {
    return { type: "ignored", reason: "unsupported_type" };
  }

  const isSearchLikeField = /(buscar|busca|search|pesquisa|encontre|localize|procurar|o que voc[eê] procura)/i.test(joinedHints);
  const hasWeakIdentity = !hints.name && !hints.id && !hints.dataField && !hints.placeholder && !hints.ariaLabel && !hints.label;
  if (hints.type === "search" || (hasWeakIdentity && isSearchLikeField)) {
    return { type: "ignored", reason: "unsupported_type" };
  }
  
  // Support for date inputs (new)
  if (hints.type === "date" || hints.type === "datetime-local") {
    // Look for template keys that contain "date"/"data"
    const dateKeys = templateKeys.filter(key => {
      const lowerKey = key.key.toLowerCase();
      return lowerKey.includes("date") || 
             lowerKey.includes("data") ||
             lowerKey.includes("inicio") ||
             lowerKey.includes("fim") ||
             lowerKey.includes("start") ||
             lowerKey.includes("end");
    });
    
    if (dateKeys.length > 0) {
      // Try to match by field name/id first
      const fieldMatched = dateKeys.find(k => 
        matches(hints, k)
      );
      
      if (fieldMatched) {
        return { type: "mapped", key: fieldMatched.key, value: fieldMatched.value };
      }
      
      // Prefer more specific keys based on field name hints
      const targetKey = dateKeys.find(k => k.key.toLowerCase().includes("start")) || 
                        dateKeys.find(k => k.key.toLowerCase().includes("end")) ||
                        dateKeys.find(k => k.key.toLowerCase().includes("inicio")) ||
                        dateKeys.find(k => k.key.toLowerCase().includes("fim")) ||
                        dateKeys[0];
      
      if (targetKey) {
        return { type: "mapped", key: targetKey.key, value: targetKey.value };
      }
    }
    // No suitable date key found - return no mapping
    return { type: "ignored", reason: "no_mapping" };
  }

  // Fallbacks práticos para SPAs quando os matchers não cobrem variações comuns.
  const isStartDateField = /(startdate|data.?ida|partida|inicio.?viagem|checkin|data.?inicio|fakedate)/i.test(
    joinedHints,
  );
  const isEndDateField = /(enddate|data.?volta|retorno|checkout|data.?fim|fim.?viagem)/i.test(joinedHints);
  const isDateLikeText = hints.type === "text" && /(date|data|calend)/i.test(joinedHints);
  if (isStartDateField || isEndDateField || isDateLikeText) {
    const isStart = isStartDateField || (!isEndDateField && /(start|inicio|ida|fakedate)/i.test(joinedHints));
    const preferred = isStart
      ? findTemplateValue(templateKeys, ["start", "inicio", "ida", "date"])
      : findTemplateValue(templateKeys, ["end", "fim", "volta", "date"]);
    return {
      type: "mapped",
      key: isStart ? "fallback_start_date" : "fallback_end_date",
      value: preferred ?? formatDateOffset(isStart ? 7 : 14),
    };
  }

  const isReactSelectInput = hints.id.includes("react-select") || hints.name.includes("react-select");
  const isDropdownLike = hints.ariaLabel.includes("select") || hints.placeholder.includes("select");
  if (isReactSelectInput || isDropdownLike) {
    const preferred = findTemplateValue(templateKeys, ["destino", "pais", "country", "trip", "produto"]);
    return {
      type: "mapped",
      key: "fallback_select_option",
      value: preferred ?? "Brasil",
    };
  }

  if (["checkbox", "radio"].includes(hints.type)) {
    const preferred = findTemplateValue(templateKeys, ["consent", "aceite", "termo", "accept", "lgpd"]);
    return {
      type: "mapped",
      key: "fallback_checkbox",
      value: preferred ?? "true",
    };
  }

  const isMoneyLikeField = /(monthlyvalue|valor|amount|pre[cç]o|price|r\$|mensal|saldo|custo)/i.test(joinedHints);
  const isNumericLikeField = ["tel", "number", "text"].includes(hints.type || "text");
  if (isMoneyLikeField && isNumericLikeField) {
    const preferred = findTemplateValue(templateKeys, ["monthly", "mensal", "valor", "amount", "price", "custo"]);
    return {
      type: "mapped",
      key: "fallback_money_value",
      value: preferred ?? "250",
    };
  }

  const matched = templateKeys.filter((key) => matches(hints, key));
  if (matched.length === 0) {
    return { type: "ignored", reason: "no_mapping" };
  }
  if (matched.length > 1) {
    // If all matching keys resolve to the same value, use the best match instead of skipping.
    // This handles forms with multiple identical inputs (e.g., cardQuantity per benefit group).
    const uniqueValues = new Set(matched.map((k) => k.value));
    if (uniqueValues.size === 1) {
      return { type: "mapped", key: matched[0]!.key, value: matched[0]!.value };
    }
    return { type: "ignored", reason: "ambiguous_mapping" };
  }

  const target = matched[0];
  if (!target) {
    return { type: "ignored", reason: "no_mapping" };
  }

  return { type: "mapped", key: target.key, value: target.value };
};
