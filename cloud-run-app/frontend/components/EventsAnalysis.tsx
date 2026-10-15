"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiDownloadUrl, apiRequest } from "../lib/api";

type EventItem = {
  id: string;
  timestamp: string;
  action_id: string | null;
  event_type: string;
  technology: string;
  url: string;
  state_name: string | null;
  event_name: string | null;
  parameters: Record<string, unknown>;
  consent_state: string;
  request_payload: Record<string, unknown>;
  status: string;
  correlation_confidence: string;
};

type ActionItem = {
  id: string;
  sequence: number;
  action_type: string;
  target_selector: string | null;
  state_before: string | null;
  state_after: string | null;
  timestamp: string;
};

type Execution = {
  ignoredFields: Array<{ fieldName: string; reason: string }>;
  warnings: Array<{ type: string; message: string }>;
  results?: {
    stopReason?: string;
    stateScreenshots?: Record<string, string>;
    eventsCount?: number;
    actionsCount?: number;
  };
};

type Audit = {
  id: string;
  config?: { auditLevel?: string };
};

type EventsPageResponse = {
  items: EventItem[];
  meta: {
    total: number;
    returned: number;
    limit: number;
    offset: number;
    isPartial: boolean;
    sort: "asc" | "desc";
  };
};

type Props = {
  auditId: string;
  executionId: string;
};

type FlowNode = {
  url: string;
  eventCount: number;
  stateCount: number;
  stepCount: number;
  technologies: Record<string, number>;
};

type FlowEdge = {
  from: string;
  to: string;
  count: number;
  stepNumbers: number[];
  actionTypes: string[];
  dominantActionGroup: "click" | "form" | "navigation" | "other" | "unmapped";
  firstSeenIndex: number;
};

type PositionedFlowNode = FlowNode & {
  nodeId: string;
  x: number;
  y: number;
  depth: number;
};

type StepInventory = {
  key: string;
  order: number;
  title: string;
  action: ActionItem | null;
  events: EventItem[];
  byUrl: Array<{ url: string; eventCount: number; tags: Record<string, number>; states: string[] }>;
};

type ParsedTarget = {
  kind: string;
  text: string;
  aria: string;
  title: string;
  href: string;
  id: string;
  data: string;
  context: string;
  selector: string;
};

type DetailColumnKey =
  | "time"
  | "type"
  | "tag"
  | "event"
  | "element"
  | "consent"
  | "http"
  | "state"
  | "confidence"
  | "detail";

const normalizeUrl = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl);
    const path = parsed.pathname.endsWith("/") ? parsed.pathname.slice(0, -1) : parsed.pathname;
    return `${parsed.origin}${path || "/"}`;
  } catch {
    return rawUrl;
  }
};

const normalizeState = (stateName: string | null) => {
  const trimmed = stateName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "(sem nome de estado)";
};

const prettyJson = (value: unknown) => JSON.stringify(value ?? {}, null, 2);

const actionTypeToGroup = (
  actionType: string | null | undefined,
): "click" | "form" | "navigation" | "other" | "unmapped" => {
  const value = (actionType ?? "").toLowerCase();
  if (!value) return "unmapped";
  if (value.includes("click") || value.includes("tap") || value.includes("link")) return "click";
  if (
    value.includes("input") ||
    value.includes("fill") ||
    value.includes("select") ||
    value.includes("type") ||
    value.includes("submit") ||
    value.includes("form")
  ) {
    return "form";
  }
  if (value.includes("navigate") || value.includes("route") || value.includes("goto") || value.includes("url")) {
    return "navigation";
  }
  return "other";
};

const edgeGroupLabel = (group: "click" | "form" | "navigation" | "other" | "unmapped") => {
  if (group === "click") return "Clique/link";
  if (group === "form") return "Formulário";
  if (group === "navigation") return "Navegação";
  if (group === "other") return "Outra ação";
  return "Sem correlação";
};

const edgeGroupColor = (group: "click" | "form" | "navigation" | "other" | "unmapped") => {
  if (group === "click") return "#38bdf8";
  if (group === "form") return "#f97316";
  if (group === "navigation") return "#22c55e";
  if (group === "other") return "#eab308";
  return "#94a3b8";
};

const buildFlow = (events: EventItem[], steps: StepInventory[]) => {
  const sorted = [...events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const nodesMap = new Map<
    string,
    { eventCount: number; states: Set<string>; steps: Set<number>; technologies: Record<string, number> }
  >();
  const edgeMap = new Map<string, number>();
  const edgeStepsMap = new Map<string, number[]>();
  const edgeActionTypesMap = new Map<string, string[]>();
  const edgeActionGroupsCount = new Map<string, Record<string, number>>();
  const edgeFirstSeenIndex = new Map<string, number>();
  const actionStepMap = new Map<string, number>();
  const actionTypeMap = new Map<string, string>();
  for (const step of steps) {
    if (step.action) {
      actionStepMap.set(step.action.id, step.action.sequence + 1);
      actionTypeMap.set(step.action.id, step.action.action_type);
    }
  }

  for (const event of sorted) {
    const url = normalizeUrl(event.url);
    const current = nodesMap.get(url) ?? {
      eventCount: 0,
      states: new Set<string>(),
      steps: new Set<number>(),
      technologies: {},
    };
    current.eventCount += 1;
    current.states.add(normalizeState(event.state_name));
    if (event.action_id) {
      const stepNumber = actionStepMap.get(event.action_id);
      if (stepNumber) current.steps.add(stepNumber);
    }
    current.technologies[event.technology] = (current.technologies[event.technology] ?? 0) + 1;
    nodesMap.set(url, current);
  }

  for (let index = 1; index < sorted.length; index += 1) {
    const previousEvent = sorted[index - 1];
    const currentEvent = sorted[index];
    const previous = normalizeUrl(previousEvent?.url ?? "");
    const current = normalizeUrl(currentEvent?.url ?? "");
    if (!previous || !current || previous === current) continue;
    const key = `${previous}|||${current}`;
    edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
    if (!edgeFirstSeenIndex.has(key)) edgeFirstSeenIndex.set(key, index);

    const stepCandidates = [
      currentEvent?.action_id ? actionStepMap.get(currentEvent.action_id) : undefined,
      previousEvent?.action_id ? actionStepMap.get(previousEvent.action_id) : undefined,
    ].filter((value): value is number => typeof value === "number");
    const actionTypeCandidates = [
      currentEvent?.action_id ? actionTypeMap.get(currentEvent.action_id) : undefined,
      previousEvent?.action_id ? actionTypeMap.get(previousEvent.action_id) : undefined,
    ].filter((value): value is string => Boolean(value));

    if (stepCandidates.length > 0) {
      const existing = edgeStepsMap.get(key) ?? [];
      edgeStepsMap.set(key, [...existing, ...stepCandidates]);
    }
    if (actionTypeCandidates.length > 0) {
      const currentTypes = edgeActionTypesMap.get(key) ?? [];
      edgeActionTypesMap.set(key, [...currentTypes, ...actionTypeCandidates]);
      const currentGroups = edgeActionGroupsCount.get(key) ?? {};
      for (const actionType of actionTypeCandidates) {
        const group = actionTypeToGroup(actionType);
        currentGroups[group] = (currentGroups[group] ?? 0) + 1;
      }
      edgeActionGroupsCount.set(key, currentGroups);
    }
  }

  for (const step of steps) {
    if (!step.action) continue;
    const from = normalizeUrl(step.action.state_before ?? "");
    const to = normalizeUrl(step.action.state_after ?? "");
    if (!from || !to || from === to) continue;
    const key = `${from}|||${to}`;
    const list = edgeStepsMap.get(key) ?? [];
    list.push(step.action.sequence + 1);
    edgeStepsMap.set(key, list);
    const currentTypes = edgeActionTypesMap.get(key) ?? [];
    currentTypes.push(step.action.action_type);
    edgeActionTypesMap.set(key, currentTypes);
    const currentGroups = edgeActionGroupsCount.get(key) ?? {};
    const group = actionTypeToGroup(step.action.action_type);
    currentGroups[group] = (currentGroups[group] ?? 0) + 1;
    edgeActionGroupsCount.set(key, currentGroups);
    if (!edgeFirstSeenIndex.has(key)) {
      edgeFirstSeenIndex.set(key, Number.MAX_SAFE_INTEGER - Math.max(0, step.action.sequence));
    }
  }

  const nodes: FlowNode[] = Array.from(nodesMap.entries())
    .map(([url, meta]) => ({
      url,
      eventCount: meta.eventCount,
      stateCount: meta.states.size,
      stepCount: meta.steps.size,
      technologies: meta.technologies,
    }))
    .sort((a, b) => b.eventCount - a.eventCount);

  const allowed = new Set(nodes.map((node) => node.url));
  const edges: FlowEdge[] = Array.from(edgeMap.entries())
    .map(([key, count]) => {
      const [from, to] = key.split("|||");
      const stepNumbers = Array.from(new Set((edgeStepsMap.get(key) ?? []).sort((a, b) => a - b)));
      const actionTypes = Array.from(new Set((edgeActionTypesMap.get(key) ?? []).filter(Boolean)));
      const actionGroupCounts = edgeActionGroupsCount.get(key) ?? {};
      const dominantActionGroup =
        (Object.entries(actionGroupCounts).sort((a, b) => (b[1] as number) - (a[1] as number))[0]?.[0] as
          | "click"
          | "form"
          | "navigation"
          | "other"
          | "unmapped"
          | undefined) ?? "unmapped";
      return {
        from: from ?? "",
        to: to ?? "",
        count,
        stepNumbers,
        actionTypes,
        dominantActionGroup,
        firstSeenIndex: edgeFirstSeenIndex.get(key) ?? Number.MAX_SAFE_INTEGER,
      };
    })
    .filter((edge) => edge.from && edge.to && allowed.has(edge.from) && allowed.has(edge.to))
    .sort((a, b) => {
      const aFirst = a.stepNumbers[0] ?? Number.MAX_SAFE_INTEGER;
      const bFirst = b.stepNumbers[0] ?? Number.MAX_SAFE_INTEGER;
      if (aFirst !== bFirst) return aFirst - bFirst;
      if (a.firstSeenIndex !== b.firstSeenIndex) return a.firstSeenIndex - b.firstSeenIndex;
      return b.count - a.count;
    })
    .slice(0, 40);

  return { nodes, edges };
};

const getDominantOrigin = (nodes: FlowNode[]) => {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    try {
      const origin = new URL(node.url).origin;
      counts.set(origin, (counts.get(origin) ?? 0) + 1);
    } catch {
      continue;
    }
  }
  const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
  return top?.[0] ?? "";
};

const formatNodePathLabel = (url: string, dominantOrigin: string) => {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname || "/";
    const shortenedPath = path.length > 34 ? `${path.slice(0, 34)}...` : path;
    if (dominantOrigin && parsed.origin === dominantOrigin) {
      return shortenedPath;
    }
    const shortHost = parsed.host.length > 24 ? `${parsed.host.slice(0, 24)}...` : parsed.host;
    return `${shortHost}${shortenedPath}`;
  } catch {
    return url.length > 34 ? `${url.slice(0, 34)}...` : url;
  }
};

const formatNodeTitle = (url: string) => {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    if (path === "/") return "Página inicial";
    const lastSegment = path.split("/").filter(Boolean).at(-1) ?? path;
    const cleaned = decodeURIComponent(lastSegment).replace(/[-_]/g, " ").trim();
    return cleaned.length > 0 ? cleaned.slice(0, 36) : path.slice(0, 36);
  } catch {
    return "Página";
  }
};

const isRootPath = (url: string) => {
  try {
    return new URL(url).pathname === "/";
  } catch {
    return false;
  }
};

const extractFirstUrlFromText = (value: string) => {
  const match = value.match(/https?:\/\/[^\s)]+/i);
  return match?.[0] ? normalizeUrl(match[0]) : null;
};

const nodeStatusStyle = (score: number) => {
  if (score >= 4) {
    return { fill: "#7f1d1d", stroke: "#fecaca", label: "crítico" };
  }
  if (score >= 2.5) {
    return { fill: "#991b1b", stroke: "#fca5a5", label: "instável" };
  }
  if (score >= 1) {
    return { fill: "#854d0e", stroke: "#fde68a", label: "monitorar" };
  }
  return { fill: "#0f172a", stroke: "#334155", label: "ok" };
};

const buildFlowLayout = (nodes: FlowNode[], edges: FlowEdge[]) => {
  const nodeIds = new Map(nodes.map((node, index) => [node.url, `N${index + 1}`]));
  const nodeSet = new Set(nodes.map((node) => node.url));
  const indegree = new Map<string, number>(nodes.map((node) => [node.url, 0]));
  const outgoing = new Map<string, string[]>(nodes.map((node) => [node.url, []]));

  for (const edge of edges) {
    if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to)) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }

  const roots = nodes
    .filter((node) => (indegree.get(node.url) ?? 0) === 0)
    .sort((a, b) => b.eventCount - a.eventCount);
  const start = roots[0]?.url ?? nodes[0]?.url ?? "";

  const depth = new Map<string, number>();
  if (start) depth.set(start, 0);

  const queue = start ? [start] : [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const currentDepth = depth.get(current) ?? 0;
    for (const next of outgoing.get(current) ?? []) {
      const nextDepth = depth.get(next);
      if (nextDepth === undefined || nextDepth > currentDepth + 1) {
        depth.set(next, currentDepth + 1);
        queue.push(next);
      }
    }
  }

  for (const [index, node] of nodes.entries()) {
    if (!depth.has(node.url)) {
      depth.set(node.url, Math.min(5, 1 + (index % 4)));
    }
  }

  const groups = new Map<number, FlowNode[]>();
  for (const node of nodes) {
    const d = depth.get(node.url) ?? 0;
    groups.set(d, [...(groups.get(d) ?? []), node]);
  }
  for (const [d, group] of groups.entries()) {
    groups.set(
      d,
      [...group].sort((a, b) => b.eventCount - a.eventCount),
    );
  }

  const columnWidth = 280;
  const rowHeight = 110;
  const nodeWidth = 220;
  const nodeHeight = 64;
  const marginX = 40;
  const marginY = 24;

  const maxDepth = Math.max(...Array.from(groups.keys()), 0);
  const maxRows = Math.max(...Array.from(groups.values()).map((group) => group.length), 1);
  const svgWidth = marginX * 2 + (maxDepth + 1) * columnWidth;
  const svgHeight = marginY * 2 + maxRows * rowHeight + 20;

  const positioned = new Map<string, PositionedFlowNode>();
  for (const [d, group] of groups.entries()) {
    group.forEach((node, rowIndex) => {
      positioned.set(node.url, {
        ...node,
        nodeId: nodeIds.get(node.url) ?? "?",
        depth: d,
        x: marginX + d * columnWidth,
        y: marginY + rowIndex * rowHeight,
      });
    });
  }

  return {
    positioned,
    svgWidth,
    svgHeight,
    nodeWidth,
    nodeHeight,
  };
};

const buildSteps = (events: EventItem[], actions: ActionItem[]) => {
  const actionsById = new Map(actions.map((action) => [action.id, action]));
  const buckets = new Map<string, StepInventory>();

  for (const event of events) {
    const action = event.action_id ? actionsById.get(event.action_id) ?? null : null;
    const key = action ? action.id : "__unmapped";
    const order = action ? action.sequence : Number.MAX_SAFE_INTEGER;
    const title = action ? `Step ${action.sequence + 1}` : "Sem step correlacionado";
    const current =
      buckets.get(key) ??
      ({
        key,
        order,
        title,
        action,
        events: [],
        byUrl: [],
      } satisfies StepInventory);
    current.events.push(event);
    buckets.set(key, current);
  }

  const steps = Array.from(buckets.values()).sort((a, b) => {
    if (a.order === b.order) {
      return Date.parse(a.events[0]?.timestamp ?? "") - Date.parse(b.events[0]?.timestamp ?? "");
    }
    return a.order - b.order;
  });

  for (const step of steps) {
    const byUrlMap = new Map<string, { eventCount: number; tags: Record<string, number>; states: Set<string> }>();
    for (const event of step.events) {
      const url = normalizeUrl(event.url);
      const row = byUrlMap.get(url) ?? { eventCount: 0, tags: {}, states: new Set<string>() };
      row.eventCount += 1;
      row.tags[event.technology] = (row.tags[event.technology] ?? 0) + 1;
      row.states.add(normalizeState(event.state_name));
      byUrlMap.set(url, row);
    }
    step.byUrl = Array.from(byUrlMap.entries())
      .map(([url, details]) => ({
        url,
        eventCount: details.eventCount,
        tags: details.tags,
        states: Array.from(details.states).sort(),
      }))
      .sort((a, b) => b.eventCount - a.eventCount);
    step.events.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  }

  return steps;
};

const formatAuditLevel = (value: string | undefined) => {
  if (value === "quick_check") return "Análise rápida";
  if (value === "inventory") return "Inventário";
  if (value === "parameters") return "Parâmetros";
  return "Não definido";
};

const technologyColor = (technology: string) => {
  if (technology === "ga4") return "#f59e0b";
  if (technology === "meta_pixel") return "#8b5cf6";
  if (technology === "google_ads") return "#0ea5e9";
  if (technology === "custom") return "#10b981";
  return "#64748b";
};

const technologyLabel = (technology: string) => {
  if (technology === "ga4") return "GA4";
  if (technology === "meta_pixel") return "Meta Pixel";
  if (technology === "google_ads") return "Google Ads";
  if (technology === "custom") return "Custom";
  return technology;
};

const ignoredReasonLabel = (reason: string) => {
  if (reason === "no_mapping") return "Sem mapeamento na persona";
  if (reason === "ambiguous_mapping") return "Mapeamento ambíguo";
  if (reason === "unsupported_type") return "Tipo de campo não suportado para preenchimento";
  return reason;
};

const ignoredFieldContextLabel = (fieldName: string) => {
  if (/^ot-group-id-/i.test(fieldName)) return "Controle técnico de consentimento";
  if (/vendor-search-handler|select-all-hosts-groups-handler|select-all-vendor-groups-handler|select-all-vendor-leg-handler/i.test(fieldName)) {
    return "Controle técnico de fornecedor/terceiro";
  }
  return "Possível campo de jornada";
};

const technologyBadgeClass = (technology: string) => {
  if (technology === "ga4") return "bg-amber-100 text-amber-900";
  if (technology === "meta_pixel") return "bg-violet-100 text-violet-900";
  if (technology === "google_ads") return "bg-sky-100 text-sky-900";
  if (technology === "custom") return "bg-emerald-100 text-emerald-900";
  return "bg-slate-100 text-slate-900";
};

const mapActionTypeLabel = (actionType: string) => {
  if (actionType === "navigate") return "visualização";
  if (actionType === "click_link") return "clique";
  if (actionType === "inspect_form") return "formulário";
  if (actionType === "fill_field" || actionType === "select_field" || actionType === "check_field") {
    return "formulário";
  }
  if (actionType === "consent") return "consentimento";
  if (actionType.includes("scroll")) return "scroll";
  return actionType;
};

const parseTargetSelector = (rawValue: string | null | undefined): ParsedTarget => {
  const fallback: ParsedTarget = {
    kind: "",
    text: "",
    aria: "",
    title: "",
    href: "",
    id: "",
    data: "",
    context: "",
    selector: rawValue ?? "",
  };
  if (!rawValue || !rawValue.includes("|")) return fallback;
  const parts = rawValue.split("|").map((part) => part.trim());
  const parsed = { ...fallback };
  for (const part of parts) {
    const [key, ...rest] = part.split("=");
    const value = rest.join("=").trim();
    if (!key || !value) continue;
    if (key === "kind") parsed.kind = value;
    if (key === "text") parsed.text = value;
    if (key === "aria") parsed.aria = value;
    if (key === "title") parsed.title = value;
    if (key === "href") parsed.href = value;
    if (key === "id") parsed.id = value;
    if (key === "data") parsed.data = value;
    if (key === "context") parsed.context = value;
    if (key === "selector") parsed.selector = value;
  }
  return parsed;
};

export function EventsAnalysis({ auditId, executionId }: Props) {
  const stepDetailsRef = useRef<HTMLDetailsElement | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [execution, setExecution] = useState<Execution | null>(null);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [eventTechnologyVisibility, setEventTechnologyVisibility] = useState<Record<string, boolean>>({});
  const [consentStateFilter, setConsentStateFilter] = useState<"all" | "before_consent" | "after_consent" | "unknown">("all");
  const [eventType, setEventType] = useState("");
  const [urlFilter, setUrlFilter] = useState("");
  const [selectedNodeUrl, setSelectedNodeUrl] = useState("");
  const [detailKnownFilter, setDetailKnownFilter] = useState<"all" | "known" | "unknown">("all");
  const [detailActionTypeFilter, setDetailActionTypeFilter] = useState("all");
  const [detailHttpMethodFilter, setDetailHttpMethodFilter] = useState("all");
  const [detailHttpStatusFilter, setDetailHttpStatusFilter] = useState("all");
  const [detailParameterFilter, setDetailParameterFilter] = useState<"all" | "with_parameters" | "without_parameters">("all");
  const [graphTechnologyVisibility, setGraphTechnologyVisibility] = useState<Record<string, boolean>>({});
  const [edgeGroupVisibility, setEdgeGroupVisibility] = useState<
    Record<"click" | "form" | "navigation" | "other" | "unmapped", boolean>
  >({
    click: true,
    form: true,
    navigation: true,
    other: true,
    unmapped: true,
  });
  const [showUncorrelatedEdges, setShowUncorrelatedEdges] = useState(false);
  const [detailVisibleColumns, setDetailVisibleColumns] = useState<Record<DetailColumnKey, boolean>>({
    time: true,
    type: true,
    tag: true,
    event: true,
    element: true,
    consent: true,
    http: true,
    state: true,
    confidence: true,
    detail: true,
  });
  const [eventsMeta, setEventsMeta] = useState<EventsPageResponse["meta"] | null>(null);

  useEffect(() => {
    void (async () => {
      const buildEventQuery = (offset: number) => {
        const query = new URLSearchParams();
        query.set("sort", "asc");
        query.set("limit", "5000");
        query.set("offset", String(offset));
        query.set("includeMeta", "1");
        if (eventType) query.set("eventType", eventType);
        if (urlFilter) query.set("url", urlFilter);
        if (consentStateFilter !== "all") query.set("consentState", consentStateFilter);
        return query;
      };

      const [executionRow, actionRows, auditRow] = await Promise.all([
        apiRequest<Execution>(`/api/audits/${auditId}/executions/${executionId}`),
        apiRequest<ActionItem[]>(`/api/audits/${auditId}/executions/${executionId}/actions`),
        apiRequest<Audit>(`/api/audits/${auditId}`),
      ]);

      const pages: EventItem[] = [];
      const firstPage = await apiRequest<EventsPageResponse>(
        `/api/audits/${auditId}/executions/${executionId}/events?${buildEventQuery(0).toString()}`,
      );
      pages.push(...firstPage.items);
      let currentMeta = firstPage.meta;
      let safetyPage = 0;
      while (currentMeta.isPartial && safetyPage < 50) {
        safetyPage += 1;
        const nextOffset = currentMeta.offset + currentMeta.returned;
        const nextPage = await apiRequest<EventsPageResponse>(
          `/api/audits/${auditId}/executions/${executionId}/events?${buildEventQuery(nextOffset).toString()}`,
        );
        pages.push(...nextPage.items);
        currentMeta = nextPage.meta;
      }

      setEvents(pages);
      setEventsMeta({
        ...currentMeta,
        returned: pages.length,
        isPartial: pages.length < (firstPage.meta.total ?? pages.length),
      });
      setExecution(executionRow);
      setActions(actionRows);
      setAudit(auditRow);
    })();
  }, [auditId, executionId, eventType, urlFilter, consentStateFilter]);

  const technologies = useMemo(
    () => Array.from(new Set(events.map((item) => item.technology))).sort(),
    [events],
  );
  useEffect(() => {
    setEventTechnologyVisibility((previous) => {
      const next: Record<string, boolean> = { ...previous };
      for (const value of technologies) {
        if (next[value] === undefined) next[value] = true;
      }
      return next;
    });
  }, [technologies]);
  const scopedEvents = useMemo(
    () => events.filter((event) => eventTechnologyVisibility[event.technology] !== false),
    [events, eventTechnologyVisibility],
  );
  const eventTypes = useMemo(
    () => Array.from(new Set(scopedEvents.map((item) => item.event_type))).sort(),
    [scopedEvents],
  );
  const actionTypeOptions = useMemo(
    () => Array.from(new Set(actions.map((action) => action.action_type))).sort(),
    [actions],
  );
  const httpMethodOptions = useMemo(
    () =>
      Array.from(
        new Set(
          scopedEvents
            .map((event) => String((event.request_payload?.method as string | undefined) ?? "unknown").toUpperCase()),
        ),
      ).sort(),
    [scopedEvents],
  );
  const httpStatusOptions = useMemo(
    () =>
      Array.from(
        new Set(scopedEvents.map((event) => String((event.request_payload?.status as number | string | undefined) ?? "unknown"))),
      ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    [scopedEvents],
  );
  useEffect(() => {
    if (eventType && !eventTypes.includes(eventType)) {
      setEventType("");
    }
  }, [eventType, eventTypes]);
  useEffect(() => {
    setGraphTechnologyVisibility((previous) => {
      const next: Record<string, boolean> = { ...previous };
      for (const value of technologies) {
        if (next[value] === undefined) next[value] = true;
      }
      return next;
    });
  }, [technologies]);

  const allSteps = useMemo(() => buildSteps(scopedEvents, actions), [scopedEvents, actions]);
  const actionsById = useMemo(() => new Map(actions.map((action) => [action.id, action])), [actions]);
  const detailEvents = useMemo(() => {
    return scopedEvents.filter((event) => {
      if (selectedNodeUrl && normalizeUrl(event.url) !== selectedNodeUrl) return false;
      const known = event.technology !== "unclassified_tracker";
      if (detailKnownFilter === "known" && !known) return false;
      if (detailKnownFilter === "unknown" && known) return false;
      const action = event.action_id ? actionsById.get(event.action_id) : null;
      if (detailActionTypeFilter !== "all" && (action?.action_type ?? "none") !== detailActionTypeFilter) return false;
      const method = String((event.request_payload?.method as string | undefined) ?? "unknown").toUpperCase();
      if (detailHttpMethodFilter !== "all" && method !== detailHttpMethodFilter) return false;
      const status = String((event.request_payload?.status as number | string | undefined) ?? "unknown");
      if (detailHttpStatusFilter !== "all" && status !== detailHttpStatusFilter) return false;
      const hasParameters = Object.keys(event.parameters ?? {}).length > 0;
      if (detailParameterFilter === "with_parameters" && !hasParameters) return false;
      if (detailParameterFilter === "without_parameters" && hasParameters) return false;
      return true;
    });
  }, [
    scopedEvents,
    selectedNodeUrl,
    detailKnownFilter,
    detailActionTypeFilter,
    detailHttpMethodFilter,
    detailHttpStatusFilter,
    detailParameterFilter,
    actionsById,
  ]);
  const steps = useMemo(() => buildSteps(detailEvents, actions), [detailEvents, actions]);
  const flow = useMemo(() => buildFlow(scopedEvents, allSteps), [scopedEvents, allSteps]);
  const selectedGraphTechnologies = useMemo(
    () => technologies.filter((tag) => graphTechnologyVisibility[tag] !== false),
    [technologies, graphTechnologyVisibility],
  );
  const visibleFlowNodeUrls = useMemo(() => {
    return new Set(
      flow.nodes
        .filter((node) => {
          if (selectedGraphTechnologies.length === 0) return false;
          return selectedGraphTechnologies.some((tag) => (node.technologies[tag] ?? 0) > 0);
        })
        .map((node) => node.url),
    );
  }, [flow.nodes, selectedGraphTechnologies]);
  const filteredFlowEdges = useMemo(() => {
    return flow.edges.filter((edge) => {
      if (!visibleFlowNodeUrls.has(edge.from) || !visibleFlowNodeUrls.has(edge.to)) return false;
      if (!edgeGroupVisibility[edge.dominantActionGroup]) return false;
      if (!showUncorrelatedEdges && edge.stepNumbers.length === 0) return false;
      return true;
    });
  }, [flow.edges, visibleFlowNodeUrls, edgeGroupVisibility, showUncorrelatedEdges]);
  const connectedNodeUrls = useMemo(() => {
    const urls = new Set<string>();
    for (const edge of filteredFlowEdges) {
      urls.add(edge.from);
      urls.add(edge.to);
    }
    return urls;
  }, [filteredFlowEdges]);
  const filteredFlowNodes = useMemo(() => {
    return flow.nodes.filter(
      (node) => visibleFlowNodeUrls.has(node.url) && (connectedNodeUrls.has(node.url) || filteredFlowEdges.length === 0),
    );
  }, [flow.nodes, visibleFlowNodeUrls, connectedNodeUrls, filteredFlowEdges.length]);
  const flowNodeByUrl = useMemo(() => {
    return new Map(
      filteredFlowNodes.map((node, index) => [
        node.url,
        {
          nodeId: `N${index + 1}`,
          ...node,
        },
      ]),
    );
  }, [filteredFlowNodes]);
  const dominantOrigin = useMemo(() => getDominantOrigin(filteredFlowNodes), [filteredFlowNodes]);
  const flowLayout = useMemo(
    () => buildFlowLayout(filteredFlowNodes, filteredFlowEdges),
    [filteredFlowNodes, filteredFlowEdges],
  );
  const flowEdgesOrdered = useMemo(() => {
    return [...filteredFlowEdges].sort((a, b) => {
      if (a.firstSeenIndex !== b.firstSeenIndex) return a.firstSeenIndex - b.firstSeenIndex;
      const aFirst = a.stepNumbers[0] ?? Number.MAX_SAFE_INTEGER;
      const bFirst = b.stepNumbers[0] ?? Number.MAX_SAFE_INTEGER;
      if (aFirst !== bFirst) return aFirst - bFirst;
      return b.count - a.count;
    });
  }, [filteredFlowEdges]);
  const graphEdgesForRender = useMemo(() => {
    const byKey = new Map(flowEdgesOrdered.map((edge) => [`${edge.from}|||${edge.to}`, edge] as const));
    const consumedPairs = new Set<string>();
    const result: Array<FlowEdge & { hasReturnPath: boolean }> = [];
    for (const edge of flowEdgesOrdered) {
      const pairKey = [edge.from, edge.to].sort().join("|||");
      const reverse = byKey.get(`${edge.to}|||${edge.from}`);
      if (!reverse) {
        result.push({ ...edge, hasReturnPath: false });
        continue;
      }
      if (consumedPairs.has(pairKey)) continue;
      consumedPairs.add(pairKey);
      const chosen =
        edge.count > reverse.count
          ? edge
          : reverse.count > edge.count
            ? reverse
            : edge.firstSeenIndex <= reverse.firstSeenIndex
              ? edge
              : reverse;
      result.push({ ...chosen, hasReturnPath: true });
    }
    return result;
  }, [flowEdgesOrdered]);
  const startNodeUrl = useMemo(() => {
    const firstVisibleEvent = [...scopedEvents]
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .map((event) => normalizeUrl(event.url))
      .find((url) => visibleFlowNodeUrls.has(url));
    return firstVisibleEvent ?? filteredFlowNodes[0]?.url ?? "";
  }, [scopedEvents, visibleFlowNodeUrls, filteredFlowNodes]);
  const summary = useMemo(() => {
    const urls = new Set<string>();
    const states = new Set<string>();
    for (const event of scopedEvents) {
      urls.add(normalizeUrl(event.url));
      states.add(`${normalizeUrl(event.url)}|||${normalizeState(event.state_name)}`);
    }
    return {
      totalEvents: scopedEvents.length,
      totalSteps: actions.length,
      totalUrls: urls.size,
      totalStates: states.size,
    };
  }, [scopedEvents, actions]);

  const uniqueStatesByUrl = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const event of scopedEvents) {
      const url = normalizeUrl(event.url);
      const state = normalizeState(event.state_name);
      if (!map.has(url)) {
        map.set(url, new Set());
      }
      map.get(url)!.add(state);
    }
    return map;
  }, [scopedEvents]);
  const unmappedStep = useMemo(
    () => steps.find((step) => step.key === "__unmapped") ?? null,
    [steps],
  );
  const lowConfidenceCount = useMemo(
    () => scopedEvents.filter((event) => event.correlation_confidence === "low").length,
    [scopedEvents],
  );
  const ignoredByReason = useMemo(() => {
    const counts = new Map<string, number>();
    for (const field of execution?.ignoredFields ?? []) {
      counts.set(field.reason, (counts.get(field.reason) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [execution?.ignoredFields]);
  const technicalIgnoredCount = useMemo(() => {
    let count = 0;
    for (const field of execution?.ignoredFields ?? []) {
      if (ignoredFieldContextLabel(field.fieldName) !== "Possível campo de jornada") {
        count += 1;
      }
    }
    return count;
  }, [execution?.ignoredFields]);
  const warningsByType = useMemo(() => {
    const counts = new Map<string, number>();
    for (const warning of execution?.warnings ?? []) {
      counts.set(warning.type, (counts.get(warning.type) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [execution?.warnings]);
  const blockedUrlDetails = useMemo(() => {
    const byUrl = new Map<string, { url: string; status?: string; cfRay?: string; reason?: string }>();
    const warnings = execution?.warnings ?? [];
    for (const warning of warnings) {
      if (warning.type !== "navigation_blocked") continue;
      const full = warning.message ?? "";
      const urlMatch = full.match(/URL bloqueada:\s*(\S+)/i);
      if (!urlMatch?.[1]) continue;

      const url = urlMatch[1];
      const statusMatch = full.match(/status=(\d{3}|0)/i);
      const cfRayMatch = full.match(/cf-ray=([^,\)\s]+)/i);
      const reasonMatch = full.match(/\((?:[^\)]*?,\s*){2}([^\)]+)\)/i);

      if (!byUrl.has(url)) {
        byUrl.set(url, {
          url,
          status: statusMatch?.[1],
          cfRay: cfRayMatch?.[1],
          reason: reasonMatch?.[1]?.trim(),
        });
      }
    }
    return Array.from(byUrl.values());
  }, [execution?.warnings]);
  const warningBreakdown = useMemo(() => {
    const warnings = execution?.warnings ?? [];
    const blockingTypes = new Set(["captcha", "spa_router", "navigation_blocked"]);
    const limitationTypes = new Set(["cookie_blocked", "adblocker", "csp"]);
    let blocked = 0;
    let limitations = 0;
    let informational = 0;
    for (const warning of warnings) {
      if (blockingTypes.has(warning.type)) {
        blocked += 1;
      } else if (limitationTypes.has(warning.type)) {
        limitations += 1;
      } else {
        informational += 1;
      }
    }
    return {
      blocked,
      limitations,
      informational,
      total: warnings.length,
    };
  }, [execution?.warnings]);
  const warningHitsByUrl = useMemo(() => {
    const counts = new Map<string, number>();
    for (const warning of execution?.warnings ?? []) {
      const parsed = extractFirstUrlFromText(warning.message);
      if (!parsed) continue;
      counts.set(parsed, (counts.get(parsed) ?? 0) + 1);
    }
    return counts;
  }, [execution?.warnings]);
  const lowByUrl = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of scopedEvents) {
      if (event.correlation_confidence !== "low") continue;
      const url = normalizeUrl(event.url);
      counts.set(url, (counts.get(url) ?? 0) + 1);
    }
    return counts;
  }, [scopedEvents]);
  const unmappedByUrl = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of unmappedStep?.events ?? []) {
      const url = normalizeUrl(event.url);
      counts.set(url, (counts.get(url) ?? 0) + 1);
    }
    return counts;
  }, [unmappedStep]);
  const nodeHealthByUrl = useMemo(() => {
    const map = new Map<string, { score: number; warningCount: number; lowCount: number; unmappedCount: number }>();
    for (const node of filteredFlowNodes) {
      const warningCount = warningHitsByUrl.get(node.url) ?? 0;
      const lowCount = lowByUrl.get(node.url) ?? 0;
      const unmappedCount = unmappedByUrl.get(node.url) ?? 0;
      const lowRatio = node.eventCount > 0 ? lowCount / node.eventCount : 0;
      const unmappedRatio = node.eventCount > 0 ? unmappedCount / node.eventCount : 0;
      const score = warningCount * 1.2 + lowRatio * 3 + unmappedRatio * 2;
      map.set(node.url, { score, warningCount, lowCount, unmappedCount });
    }
    return map;
  }, [filteredFlowNodes, warningHitsByUrl, lowByUrl, unmappedByUrl]);
  const consentComparison = useMemo(() => {
    const rows = new Map<string, { before: number; after: number; unknown: number }>();
    for (const event of scopedEvents) {
      const row = rows.get(event.technology) ?? { before: 0, after: 0, unknown: 0 };
      if (event.consent_state === "before_consent") row.before += 1;
      else if (event.consent_state === "after_consent") row.after += 1;
      else row.unknown += 1;
      rows.set(event.technology, row);
    }
    return Array.from(rows.entries())
      .map(([technologyName, values]) => ({ technologyName, ...values }))
      .sort((a, b) => b.after + b.before + b.unknown - (a.after + a.before + a.unknown));
  }, [scopedEvents]);
  const nodePrimaryStepByUrl = useMemo(() => {
    const map = new Map<string, number>();
    for (const event of [...scopedEvents].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))) {
      if (!event.action_id) continue;
      const action = actionsById.get(event.action_id);
      if (!action) continue;
      const url = normalizeUrl(event.url);
      const current = map.get(url);
      const step = action.sequence + 1;
      if (current === undefined || step < current) {
        map.set(url, step);
      }
    }
    return map;
  }, [scopedEvents, actionsById]);
  const urlInventory = useMemo(() => {
    const rows = new Map<string, { total: number; tags: Record<string, number> }>();
    for (const event of scopedEvents) {
      const url = normalizeUrl(event.url);
      const row = rows.get(url) ?? { total: 0, tags: {} };
      row.total += 1;
      row.tags[event.technology] = (row.tags[event.technology] ?? 0) + 1;
      rows.set(url, row);
    }
    return Array.from(rows.entries())
      .map(([url, row]) => ({ url, ...row }))
      .sort((a, b) => b.total - a.total);
  }, [scopedEvents]);
  const nodeViewSummary = useMemo(
    () => `${filteredFlowNodes.length} nós visíveis • ${graphEdgesForRender.length} transições principais`,
    [filteredFlowNodes.length, graphEdgesForRender.length],
  );
  const correlationSummary = useMemo(
    () => `${unmappedStep?.events.length ?? 0} sem step • ${lowConfidenceCount} com confiança low`,
    [unmappedStep?.events.length, lowConfidenceCount],
  );
  const consentSummary = useMemo(() => {
    const before = consentComparison.reduce((total, row) => total + row.before, 0);
    const after = consentComparison.reduce((total, row) => total + row.after, 0);
    const unknown = consentComparison.reduce((total, row) => total + row.unknown, 0);
    return `Antes: ${before} • Depois: ${after} • Não identificado: ${unknown}`;
  }, [consentComparison]);
  const inventorySummary = useMemo(
    () => `${urlInventory.length} URLs inventariadas • ${summary.totalEvents} eventos no recorte`,
    [urlInventory.length, summary.totalEvents],
  );
  const stepSummary = useMemo(
    () => `${steps.length} blocos de step • ${detailEvents.length} eventos após filtros avançados`,
    [steps.length, detailEvents.length],
  );
  const hasAdvancedStepFilters = useMemo(() => {
    return (
      selectedNodeUrl.length > 0 ||
      detailKnownFilter !== "all" ||
      detailActionTypeFilter !== "all" ||
      detailHttpMethodFilter !== "all" ||
      detailHttpStatusFilter !== "all" ||
      detailParameterFilter !== "all"
    );
  }, [
    selectedNodeUrl,
    detailKnownFilter,
    detailActionTypeFilter,
    detailHttpMethodFilter,
    detailHttpStatusFilter,
    detailParameterFilter,
  ]);
  const activeTechnologyCount = useMemo(
    () => technologies.filter((tag) => eventTechnologyVisibility[tag] !== false).length,
    [technologies, eventTechnologyVisibility],
  );
  const detailColumnOptions: Array<{ key: DetailColumnKey; label: string }> = [
    { key: "time", label: "Hora" },
    { key: "type", label: "Tipo" },
    { key: "tag", label: "Tag" },
    { key: "event", label: "Evento" },
    { key: "element", label: "Elemento/Ação" },
    { key: "consent", label: "Consentimento" },
    { key: "http", label: "HTTP" },
    { key: "state", label: "Tela/estado" },
    { key: "confidence", label: "Confiança" },
    { key: "detail", label: "Detalhe" },
  ];
  const focusStepInventory = (nodeUrl: string) => {
    setSelectedNodeUrl((currentValue) => (currentValue === nodeUrl ? "" : nodeUrl));
    if (stepDetailsRef.current) {
      stepDetailsRef.current.open = true;
      stepDetailsRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const showParameters = audit?.config?.auditLevel === "parameters";
  const auditLevel = audit?.config?.auditLevel;

  // Decode stop reason into display info
  const stopReason = execution?.results?.stopReason;
  const stateScreenshots = execution?.results?.stateScreenshots ?? {};
  const screenshotEntries = Object.entries(stateScreenshots);

  // Lookup robusto: testa match exato, dedup (@@) e equivalência de URL-base
  // Lida com casos onde state = "URL" e key = "URL | Título" (e vice-versa)
  const findScreenshot = (stateName: string): string | null => {
    const exact = screenshotEntries.find(
      ([key]) => key === stateName || key.startsWith(`${stateName}@@`),
    );
    if (exact) return exact[1];
    // Extrair URL-base (antes de ' | ' ou '@@') para match parcial
    const stateBase = stateName.split(" | ")[0].split("@@")[0];
    const partial = screenshotEntries.find(([key]) => {
      const keyBase = key.split(" | ")[0].split("@@")[0];
      return keyBase === stateBase;
    });
    return partial?.[1] ?? null;
  };

  const stopInfo = (() => {
    if (!stopReason) return null;
    if (stopReason.startsWith("max_states:")) return { icon: "🔢", color: "#f59e0b", bg: "#fffbeb", border: "#fde68a", label: "Limite de estados atingido", detail: stopReason.replace("max_states:", "") };
    if (stopReason.startsWith("max_actions:")) return { icon: "⚡", color: "#f59e0b", bg: "#fffbeb", border: "#fde68a", label: "Limite de ações atingido", detail: stopReason.replace("max_actions:", "") };
    if (stopReason.startsWith("queue_exhausted_partial:")) return { icon: "⚠️", color: "#c2410c", bg: "#fff7ed", border: "#fed7aa", label: "Exploração parcial — páginas bloqueadas", detail: stopReason.replace("queue_exhausted_partial:", "") };
    if (stopReason.startsWith("queue_exhausted:")) return { icon: "✅", color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0", label: "Exploração completa", detail: "O crawler visitou todos os caminhos disponíveis" };
    if (stopReason.startsWith("error:")) return { icon: "❌", color: "#dc2626", bg: "#fff1f2", border: "#fecdd3", label: "Erro inesperado", detail: stopReason.replace("error:", "") };
    return { icon: "ℹ️", color: "#475569", bg: "#f8fafc", border: "#e2e8f0", label: stopReason, detail: "" };
  })();

  return (
    <section className="space-y-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Inventário de jornada e tags</h1>
          <p className="text-sm text-slate-600">Execução: {executionId}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/" className="rounded border px-3 py-2 text-sm">
            Voltar para início
          </Link>
          <Link href={`/audits/${auditId}/history`} className="rounded border px-3 py-2 text-sm">
            Voltar para histórico
          </Link>
        </div>
      </header>

      {/* Stop condition banner */}
      {stopInfo && (
        <div
          className="flex items-start gap-3 rounded-lg border p-4"
          style={{ background: stopInfo.bg, borderColor: stopInfo.border }}
        >
          <span className="text-xl">{stopInfo.icon}</span>
          <div>
            <p className="font-semibold" style={{ color: stopInfo.color }}>
              Critério de parada: {stopInfo.label}
            </p>
            {stopInfo.detail && <p className="mt-0.5 text-sm text-slate-600">{stopInfo.detail}</p>}
          </div>
        </div>
      )}

      {/* State screenshots gallery */}
      {screenshotEntries.length > 0 && (
        <section className="rounded border border-slate-200 bg-slate-50 p-4">
          <h2 className="mb-3 font-medium">
            📸 Prints dos estados descobertos{" "}
            <span className="ml-1 text-sm font-normal text-slate-500">
              ({screenshotEntries.length} estado(s) — clique para ampliar)
            </span>
          </h2>
          <div className="flex flex-wrap gap-3">
            {screenshotEntries.map(([name, src]) => (
              <button
                key={name}
                type="button"
                title={name}
                onClick={() => {
                  const lb = document.getElementById("ss-lightbox-ea");
                  const img = document.getElementById("ss-lb-img-ea") as HTMLImageElement | null;
                  const cap = document.getElementById("ss-lb-cap-ea");
                  if (lb && img && cap) {
                    img.src = src;
                    cap.textContent = name.substring(0, 100);
                    lb.style.display = "flex";
                  }
                }}
                className="overflow-hidden rounded-lg border-2 border-slate-200 transition-all hover:scale-105 hover:border-blue-400"
                style={{ width: 160 }}
              >
                <img
                  src={src}
                  alt={`Estado: ${name}`}
                  className="block h-[90px] w-full object-cover object-top"
                  loading="lazy"
                />
                <p className="truncate bg-slate-100 px-2 py-1 text-left text-[10px] text-slate-600">
                  {name.substring(0, 40)}
                </p>
              </button>
            ))}
          </div>
          {/* Lightbox */}
          <div
            id="ss-lightbox-ea"
            style={{ display: "none" }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-5"
            onClick={() => {
              const lb = document.getElementById("ss-lightbox-ea");
              if (lb) lb.style.display = "none";
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img id="ss-lb-img-ea" src="" alt="" className="max-h-[90vh] max-w-[95vw] rounded-lg shadow-2xl" />
            <p
              id="ss-lb-cap-ea"
              className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md bg-black/60 px-4 py-2 text-center text-sm text-white"
            />
          </div>
        </section>
      )}

      <section className="rounded border border-slate-200 bg-slate-50 p-4">
        <h2 className="font-medium">Modo atual da análise: {formatAuditLevel(auditLevel)}</h2>
        <p className="mt-1 text-sm text-slate-700">
          {auditLevel === "quick_check" &&
            "Mostra presença e volume de tags/eventos para validação rápida. Não foca em detalhamento de parâmetros."}
          {auditLevel === "inventory" &&
            "Mostra jornada por step, telas/URLs e quais tags dispararam em cada etapa. Parâmetros ficam resumidos."}
          {auditLevel === "parameters" &&
            "Mostra jornada por step com detalhamento completo de parâmetros/payload por evento."}
          {!auditLevel &&
            "Nível não encontrado no snapshot desta auditoria. Exibição em modo padrão de inventário."}
        </p>
      </section>

      <section className="rounded border border-slate-200 bg-slate-50 p-4 text-sm">
        <h2 className="font-medium">Resumo executivo da jornada</h2>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          <p>
            <strong>Tecnologias detectadas:</strong>{" "}
            {Array.from(new Set(scopedEvents.map((event) => technologyLabel(event.technology)))).join(", ") || "-"}
          </p>
          <p>
            <strong>Total de eventos:</strong> {summary.totalEvents}
            {eventsMeta
              ? ` (carregados ${eventsMeta.returned} de ${eventsMeta.total})`
              : ""}
          </p>
          <p>
            <strong>URLs/estados analisados:</strong> {summary.totalUrls} URLs • {summary.totalStates} estados
          </p>
          <p>
            <strong>Eventos desconhecidos:</strong>{" "}
            {scopedEvents.filter((event) => event.technology === "unclassified_tracker").length}
          </p>
          <p>
            <strong>Parâmetros sensíveis detectados:</strong>{" "}
            {scopedEvents.filter((event) => {
              const values = Object.values(event.parameters ?? {}).map((value) => String(value).toLowerCase());
              return values.some((value) => value.includes("[redacted]") || value.includes("[masked-"));
            }).length}
          </p>
          <p>
            <strong>Caminhos bloqueados/não explorados:</strong>{" "}
            {warningBreakdown.blocked}
          </p>
        </div>
        <p className="mt-2 text-xs text-slate-600">
          Critério de avisos: bloqueios duros ({warningBreakdown.blocked}), limitações técnicas ({warningBreakdown.limitations}) e informativos ({warningBreakdown.informational}).
        </p>
      </section>

      {eventsMeta?.isPartial && (
        <section className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">Dados parciais no inventário</p>
          <p className="mt-1">
            O relatório carregou {eventsMeta.returned} de {eventsMeta.total} eventos. Ajuste filtros ou use exportação para conferir o volume completo.
          </p>
        </section>
      )}

      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded border p-3">
          <p className="text-xs text-slate-500">Eventos (recorte atual)</p>
          <p className="text-2xl font-semibold">{summary.totalEvents}</p>
        </div>
        <div className="rounded border p-3">
          <p className="text-xs text-slate-500">Steps</p>
          <p className="text-2xl font-semibold">{summary.totalSteps}</p>
        </div>
        <div className="rounded border p-3">
          <p className="text-xs text-slate-500">URLs únicas</p>
          <p className="text-2xl font-semibold">{summary.totalUrls}</p>
        </div>
        <div className="rounded border p-3">
          <p className="text-xs text-slate-500">Telas/estados únicos</p>
          <p className="text-2xl font-semibold">{summary.totalStates}</p>
        </div>
      </div>

      <section className="space-y-3 rounded border border-slate-200 bg-slate-50 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-medium">Filtros principais (proposta operacional)</h2>
            <p className="text-xs text-slate-600">
              Priorize: tecnologia + consentimento + contexto (evento/URL). Filtros avançados ficam no inventário por step.
            </p>
          </div>
          <button
            type="button"
            className="rounded border bg-white px-3 py-2 text-xs"
            onClick={() => {
              setEventType("");
              setUrlFilter("");
              setConsentStateFilter("all");
              setEventTechnologyVisibility((previous) => {
                const next = { ...previous };
                for (const key of Object.keys(next)) next[key] = true;
                return next;
              });
            }}
          >
            Limpar filtros principais
          </button>
        </div>
        <div>
          <p className="mb-2 text-xs font-medium text-slate-700">
            Tecnologia (seleção múltipla): {activeTechnologyCount}/{technologies.length} ativa(s)
          </p>
          <div className="flex flex-wrap gap-2">
            {technologies.map((tag) => (
              <label
                key={`main-tech-${tag}`}
                className={`inline-flex cursor-pointer items-center gap-2 rounded border px-2 py-1 text-xs ${
                  eventTechnologyVisibility[tag] === false ? "bg-white text-slate-500" : "bg-slate-900 text-white"
                }`}
              >
                <input
                  type="checkbox"
                  className="h-3 w-3"
                  checked={eventTechnologyVisibility[tag] !== false}
                  onChange={(event) =>
                    setEventTechnologyVisibility((previous) => ({
                      ...previous,
                      [tag]: event.target.checked,
                    }))
                  }
                />
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: technologyColor(tag) }} />
                  {technologyLabel(tag)}
                </span>
              </label>
            ))}
            {technologies.length === 0 && <span className="text-xs text-slate-500">Sem tecnologias neste recorte.</span>}
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-sm">
            Consentimento
            <select
              className="mt-1 w-full rounded border p-2"
              value={consentStateFilter}
              onChange={(event) =>
                setConsentStateFilter(event.target.value as "all" | "before_consent" | "after_consent" | "unknown")
              }
            >
              <option value="all">Todos</option>
              <option value="before_consent">Antes do consentimento</option>
              <option value="after_consent">Depois do consentimento</option>
              <option value="unknown">Não identificado</option>
            </select>
          </label>
          <label className="text-sm">
            Tipo de evento
            <select
              className="mt-1 w-full rounded border p-2"
              value={eventType}
              onChange={(event) => setEventType(event.target.value)}
            >
              <option value="">Todos</option>
              {eventTypes.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            URL contém
            <input
              className="mt-1 w-full rounded border p-2"
              value={urlFilter}
              onChange={(event) => setUrlFilter(event.target.value)}
            />
          </label>
        </div>
      </section>

      <div className="flex flex-wrap gap-3">
        <a
          href={apiDownloadUrl(`/api/audits/${auditId}/executions/${executionId}/export?format=pdf`)}
          className="rounded border px-3 py-2"
        >
          ↓ PDF
        </a>
        <a
          href={apiDownloadUrl(`/api/audits/${auditId}/executions/${executionId}/export?format=csv`)}
          className="rounded border px-3 py-2"
        >
          ↓ CSV
        </a>
        <a
          href={apiDownloadUrl(`/api/audits/${auditId}/executions/${executionId}/export?format=json`)}
          className="rounded border px-3 py-2"
        >
          ↓ JSON
        </a>
      </div>

      <section className="space-y-3 rounded border p-4">
        <h2 className="font-medium">Grafo de fluxo (URL → URL)</h2>
        <div className="flex flex-wrap gap-3 text-xs text-slate-700">
          <span className="rounded bg-slate-100 px-2 py-1">
            <strong>E</strong> = total de eventos no nó
          </span>
          <span className="rounded bg-emerald-100 px-2 py-1 font-medium text-emerald-900">
            <strong>T</strong> = telas/estados descobertos no nó
          </span>
          <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1">
            <span className="inline-block h-2 w-2 rounded-full bg-amber-500" /> GA4
          </span>
          <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1">
            <span className="inline-block h-2 w-2 rounded-full bg-violet-500" /> Meta Pixel
          </span>
          <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1">
            <span className="inline-block h-2 w-2 rounded-full bg-sky-500" /> Google Ads
          </span>
          <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> Custom
          </span>
          <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1">
            <span className="inline-block h-2 w-2 rounded-full bg-slate-500" /> Outras tecnologias
          </span>
          <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1">
            <span className="inline-block h-2 w-2 rounded-full bg-slate-900" /> Nó OK
          </span>
          <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1">
            <span className="inline-block h-2 w-2 rounded-full bg-amber-700" /> Nó monitorar
          </span>
          <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1">
            <span className="inline-block h-2 w-2 rounded-full bg-red-700" /> Nó instável
          </span>
          <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1">
            <span className="inline-block h-2 w-2 rounded-full bg-red-900" /> Nó crítico
          </span>
          <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: edgeGroupColor("click") }} />{" "}
            Aresta: clique/link
          </span>
          <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: edgeGroupColor("form") }} />{" "}
            Aresta: formulário
          </span>
          <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: edgeGroupColor("navigation") }} />{" "}
            Aresta: navegação
          </span>
          <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: edgeGroupColor("other") }} /> Aresta: outra
          </span>
          <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: edgeGroupColor("unmapped") }} /> Aresta: sem correlação
          </span>
          <span className="rounded bg-slate-100 px-2 py-1">Linha contínua: transição determinística (com step)</span>
          <span className="rounded bg-slate-100 px-2 py-1">Linha tracejada: transição inferida por sequência de eventos</span>
        </div>
        <p className="text-xs text-slate-600">
          Step na aresta indica mudança entre URLs. Steps que só mudam estado interno (mesma URL/SPA) podem não aparecer no fluxo URL→URL.
        </p>
        <p className="text-xs text-slate-600">
          Observação: <strong>T</strong> usa o `state_name` capturado. Em páginas sem mudança explícita de estado, T pode ser 1.
        </p>
        {dominantOrigin && (
          <p className="text-xs text-slate-700">
            Base da jornada: <strong>{dominantOrigin}</strong> (nos nós, mostramos principalmente o path).
          </p>
        )}
        {selectedNodeUrl && (
          <p className="text-xs text-slate-700">
            Filtro ativo por nó: <strong>{selectedNodeUrl}</strong>{" "}
            <button type="button" className="ml-1 underline" onClick={() => setSelectedNodeUrl("")}>
              limpar
            </button>
          </p>
        )}
        <div className="grid gap-3 rounded border border-slate-200 bg-slate-50 p-3 text-xs md:grid-cols-3">
          <div>
            <p className="mb-1 font-medium">Exibir tecnologias no grafo</p>
            <div className="space-y-1">
              {technologies.map((tag) => (
                <label key={`graph-tag-${tag}`} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={graphTechnologyVisibility[tag] ?? true}
                    onChange={(event) =>
                      setGraphTechnologyVisibility((previous) => ({
                        ...previous,
                        [tag]: event.target.checked,
                      }))
                    }
                  />
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: technologyColor(tag) }} />
                    {technologyLabel(tag)}
                  </span>
                </label>
              ))}
              {technologies.length === 0 && <p className="text-slate-500">Sem tags na seleção atual.</p>}
            </div>
          </div>
          <div>
            <p className="mb-1 font-medium">Exibir tipos de transição</p>
            <div className="space-y-1">
              {(["click", "form", "navigation", "other", "unmapped"] as const).map((group) => (
                <label key={`graph-group-${group}`} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={edgeGroupVisibility[group]}
                    onChange={(event) =>
                      setEdgeGroupVisibility((previous) => ({
                        ...previous,
                        [group]: event.target.checked,
                      }))
                    }
                  />
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: edgeGroupColor(group) }} />
                    {edgeGroupLabel(group)}
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1 font-medium">Exibição de correlação</p>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={showUncorrelatedEdges}
                onChange={(event) => setShowUncorrelatedEdges(event.target.checked)}
              />
              <span>Mostrar transições inferidas sem step correlacionado (S~)</span>
            </label>
            <p className="mt-2 text-slate-600">
              Rótulo da aresta: <strong>#ordem</strong> da transição + <strong>Sx</strong> dos steps associados.
            </p>
          </div>
        </div>
        {filteredFlowNodes.length === 0 ? (
          <p className="text-sm text-slate-500">Sem dados suficientes para montar o fluxo.</p>
        ) : (
          <div className="space-y-4">
            <div className="overflow-x-auto rounded border bg-slate-50 p-2">
              <svg
                className="h-auto w-full min-w-[900px]"
                viewBox={`0 0 ${flowLayout.svgWidth} ${flowLayout.svgHeight}`}
                role="img"
                aria-label="Grafo de fluxo sem sobreposição"
              >
                <defs>
                  <marker id="flow-arrow-click" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
                    <path d="M0,0 L0,6 L9,3 z" fill={edgeGroupColor("click")} />
                  </marker>
                  <marker id="flow-arrow-form" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
                    <path d="M0,0 L0,6 L9,3 z" fill={edgeGroupColor("form")} />
                  </marker>
                  <marker
                    id="flow-arrow-navigation"
                    markerWidth="10"
                    markerHeight="10"
                    refX="8"
                    refY="3"
                    orient="auto"
                  >
                    <path d="M0,0 L0,6 L9,3 z" fill={edgeGroupColor("navigation")} />
                  </marker>
                  <marker id="flow-arrow-other" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
                    <path d="M0,0 L0,6 L9,3 z" fill={edgeGroupColor("other")} />
                  </marker>
                  <marker id="flow-arrow-unmapped" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
                    <path d="M0,0 L0,6 L9,3 z" fill={edgeGroupColor("unmapped")} />
                  </marker>
                </defs>

                {graphEdgesForRender.map((edge, index) => {
                  const from = flowLayout.positioned.get(edge.from);
                  const to = flowLayout.positioned.get(edge.to);
                  if (!from || !to) return null;
                  const x1 = from.x + flowLayout.nodeWidth;
                  const y1 = from.y + flowLayout.nodeHeight / 2;
                  const x2 = to.x;
                  const y2 = to.y + flowLayout.nodeHeight / 2;
                  const curve = Math.max(30, Math.abs(x2 - x1) / 3);
                  const midX = (x1 + x2) / 2;
                  const midY = (y1 + y2) / 2 - 12 - (index % 2) * 8;
                  const group = edge.dominantActionGroup;
                  const strokeColor = edgeGroupColor(group);
                  const isInferred = edge.stepNumbers.length === 0;
                  const stepLabel =
                    edge.stepNumbers.length > 0
                      ? `#${index + 1} • S${edge.stepNumbers.slice(0, 3).join(",S")}${edge.stepNumbers.length > 3 ? ",..." : ""}${edge.hasReturnPath ? " ↔" : ""}`
                      : `#${index + 1} • S~`;
                  return (
                    <g key={`${edge.from}-${edge.to}-${index}`}>
                      <path
                        d={`M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`}
                        fill="none"
                        stroke={strokeColor}
                        strokeWidth={Math.min(4, 1 + edge.count / 3)}
                        strokeDasharray={isInferred ? "6 4" : undefined}
                        markerEnd={`url(#flow-arrow-${group})`}
                      />
                      <rect x={midX - 56} y={midY - 8} width={112} height={16} rx={5} fill="#ffffff" stroke="#cbd5e1" />
                      <text x={midX} y={midY + 3} textAnchor="middle" fill="#334155" fontSize={9}>
                        {stepLabel}
                      </text>
                    </g>
                  );
                })}

                {filteredFlowNodes.map((node) => {
                  const positioned = flowLayout.positioned.get(node.url);
                  if (!positioned) return null;
                  const pageTitle = formatNodeTitle(node.url);
                  const shortUrl = formatNodePathLabel(node.url, dominantOrigin);
                  const ga4 = node.technologies.ga4 ?? 0;
                  const meta = node.technologies.meta_pixel ?? 0;
                  const ads = node.technologies.google_ads ?? 0;
                  const custom = node.technologies.custom ?? 0;
                  const others = Object.entries(node.technologies)
                    .filter(([tag]) => !["ga4", "meta_pixel", "google_ads", "custom"].includes(tag))
                    .reduce((total, [, count]) => total + count, 0);
                  const health = nodeHealthByUrl.get(node.url) ?? {
                    score: 0,
                    warningCount: 0,
                    lowCount: 0,
                    unmappedCount: 0,
                  };
                  const status = nodeStatusStyle(health.score);
                  const primaryStep = nodePrimaryStepByUrl.get(node.url);
                  return (
                    <g key={`node-${node.url}`}>
                      <rect
                        x={positioned.x}
                        y={positioned.y}
                        width={flowLayout.nodeWidth}
                        height={flowLayout.nodeHeight}
                        rx={10}
                        fill={status.fill}
                        stroke={status.stroke}
                        strokeWidth={1.2}
                        style={{ cursor: "pointer" }}
                        onClick={() => focusStepInventory(node.url)}
                      />
                      <text x={positioned.x + 10} y={positioned.y + 16} fill="#ffffff" fontSize={11} fontWeight="700">
                        {positioned.nodeId}
                        {primaryStep ? ` / S${primaryStep}` : " / S~"}
                      </text>
                      <text x={positioned.x + 170} y={positioned.y + 16} fill="#e2e8f0" fontSize={8}>
                        {status.label}
                      </text>
                      {node.url === startNodeUrl && (
                        <text x={positioned.x + 58} y={positioned.y + 16} fill="#facc15" fontSize={10} fontWeight="700">
                          START
                        </text>
                      )}
                      <text x={positioned.x + 10} y={positioned.y + 31} fill="#cbd5e1" fontSize={10}>
                        E:{node.eventCount} • T:{node.stateCount} • S:{node.stepCount}
                      </text>
                      <text x={positioned.x + 10} y={positioned.y + 47} fill="#e2e8f0" fontSize={10} fontWeight="600">
                        {pageTitle}
                      </text>
                      <text x={positioned.x + 10} y={positioned.y + 58} fill="#94a3b8" fontSize={9}>
                        {shortUrl}
                      </text>
                      <circle cx={positioned.x + 150} cy={positioned.y + 15} r={4} fill="#f59e0b" />
                      <text x={positioned.x + 158} y={positioned.y + 18} fill="#cbd5e1" fontSize={8}>
                        {ga4}
                      </text>
                      <circle cx={positioned.x + 150} cy={positioned.y + 28} r={4} fill="#8b5cf6" />
                      <text x={positioned.x + 158} y={positioned.y + 31} fill="#cbd5e1" fontSize={8}>
                        {meta}
                      </text>
                      <circle cx={positioned.x + 180} cy={positioned.y + 15} r={4} fill="#0ea5e9" />
                      <text x={positioned.x + 188} y={positioned.y + 18} fill="#cbd5e1" fontSize={8}>
                        {ads}
                      </text>
                      <circle cx={positioned.x + 180} cy={positioned.y + 28} r={4} fill="#10b981" />
                      <text x={positioned.x + 188} y={positioned.y + 31} fill="#cbd5e1" fontSize={8}>
                        {custom}
                      </text>
                      {others > 0 && (
                        <>
                          <circle cx={positioned.x + 208} cy={positioned.y + 22} r={4} fill="#64748b" />
                          <text x={positioned.x + 214} y={positioned.y + 25} fill="#cbd5e1" fontSize={8}>
                            {others}
                          </text>
                        </>
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>

            <details className="rounded border border-slate-200 bg-white">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-slate-700">
                Visão por nó/transição: {nodeViewSummary}
              </summary>
              <div className="overflow-x-auto rounded border-t">
                <table className="min-w-full text-left text-xs">
                <thead className="bg-slate-100">
                  <tr>
                    <th className="px-2 py-1">Nó</th>
                    <th className="px-2 py-1">Step principal</th>
                    <th className="px-2 py-1">URL</th>
                    <th className="px-2 py-1">E</th>
                    <th className="px-2 py-1">T</th>
                    <th className="px-2 py-1">S</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFlowNodes.map((node) => {
                    const indexed = flowNodeByUrl.get(node.url);
                    const parsedPath = formatNodePathLabel(node.url, dominantOrigin);
                    const rootLabel = isRootPath(node.url) ? " (raiz do domínio)" : "";
                    const primaryStep = nodePrimaryStepByUrl.get(node.url);
                    return (
                      <tr key={node.url} className="border-t">
                        <td className="px-2 py-1 font-medium">{indexed?.nodeId ?? "-"}</td>
                        <td className="px-2 py-1">{primaryStep ? `S${primaryStep}` : "S~"}</td>
                        <td className="break-all px-2 py-1">
                          {parsedPath}
                          {rootLabel}
                        </td>
                        <td className="px-2 py-1">{node.eventCount}</td>
                        <td className="px-2 py-1">{node.stateCount}</td>
                        <td className="px-2 py-1">{node.stepCount}</td>
                      </tr>
                    );
                  })}
                </tbody>
                </table>
              </div>

              <div className="overflow-x-auto rounded border-t">
                <table className="min-w-full text-left text-xs">
                <thead className="bg-slate-100">
                  <tr>
                    <th className="px-2 py-1">Ordem</th>
                    <th className="px-2 py-1">Steps</th>
                    <th className="px-2 py-1">Tipo de ação</th>
                    <th className="px-2 py-1">Confiança da transição</th>
                    <th className="px-2 py-1">Origem</th>
                    <th className="px-2 py-1">Destino</th>
                    <th className="px-2 py-1">Transições</th>
                  </tr>
                </thead>
                <tbody>
                  {graphEdgesForRender.map((edge, index) => {
                    const fromNode = flowNodeByUrl.get(edge.from);
                    const toNode = flowNodeByUrl.get(edge.to);
                    const stepLabel =
                      edge.stepNumbers.length > 0
                        ? `S${edge.stepNumbers.join(", S")}`
                        : "S~ (transição sem action_id correlacionado)";
                    return (
                      <tr key={`${edge.from}-${edge.to}-${index}`} className="border-t">
                        <td className="px-2 py-1">
                          #{index + 1}
                          {edge.hasReturnPath ? " ↔" : ""}
                        </td>
                        <td className="px-2 py-1">{stepLabel}</td>
                        <td className="px-2 py-1">
                          <span className="inline-flex items-center gap-1">
                            <span
                              className="inline-block h-2 w-2 rounded-full"
                              style={{ backgroundColor: edgeGroupColor(edge.dominantActionGroup) }}
                            />
                            {edgeGroupLabel(edge.dominantActionGroup)}
                          </span>
                        </td>
                        <td className="px-2 py-1">{edge.stepNumbers.length > 0 ? "determinística" : "inferida"}</td>
                        <td className="break-all px-2 py-1">
                          <span className="font-medium">{fromNode?.nodeId ?? "N?"}</span> {edge.from}
                        </td>
                        <td className="break-all px-2 py-1">
                          <span className="font-medium">{toNode?.nodeId ?? "N?"}</span> {edge.to}
                        </td>
                        <td className="px-2 py-1">{edge.count}x</td>
                      </tr>
                    );
                  })}
                  {graphEdgesForRender.length === 0 && (
                    <tr>
                      <td className="px-2 py-1 text-slate-500" colSpan={7}>
                        Nenhuma aresta de transição entre URLs foi identificada.
                      </td>
                    </tr>
                  )}
                </tbody>
                </table>
              </div>

              <div className="overflow-x-auto rounded border-t">
                <table className="min-w-full text-left text-xs">
                <thead className="bg-slate-100">
                  <tr>
                    <th className="px-2 py-1">Nó</th>
                    <th className="px-2 py-1">URL</th>
                    <th className="px-2 py-1">Estados Únicos Descobertos</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from(uniqueStatesByUrl.entries())
                    .sort((a, b) => b[1].size - a[1].size)
                    .map(([url, statesSet]) => {
                      const nodeId = flowNodeByUrl.get(url)?.nodeId ?? "N?";
                      const statesList = Array.from(statesSet).sort();
                      return (
                        <tr key={url} className="border-t">
                          <td className="px-2 py-1"><strong>{nodeId}</strong></td>
                          <td className="break-all px-2 py-1 max-w-xs text-slate-600">{formatNodePathLabel(url, dominantOrigin)}</td>
                          <td className="px-2 py-1">
                            <div className="flex flex-col gap-1">
                              {statesList.map((state) => (
                                <span key={state} className="inline-block rounded bg-slate-100 px-2 py-1 text-xs">
                                  {state}
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  {uniqueStatesByUrl.size === 0 && (
                    <tr>
                      <td className="px-2 py-1 text-slate-500" colSpan={3}>
                        Nenhum estado foi identificado nos eventos.
                      </td>
                    </tr>
                  )}
                </tbody>
                </table>
              </div>
            </details>
          </div>
        )}
      </section>

      <details className="rounded border border-slate-200 bg-slate-50 p-4 text-sm">
        <summary className="cursor-pointer font-medium">
          Leitura de correlação (step x evento): {correlationSummary}
        </summary>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          <p>
            <strong>Sem step correlacionado:</strong> {unmappedStep?.events.length ?? 0} eventos
          </p>
          <p>
            <strong>Confiança low:</strong> {lowConfidenceCount} eventos
          </p>
        </div>
        <p className="mt-2 text-xs text-slate-600">
          "Sem step" não significa erro do pixel: significa que o request foi capturado sem vínculo direto com uma ação registrada do crawler (ex.: disparo assíncrono de script).
        </p>
      </details>

      <details className="rounded border border-slate-200 bg-slate-50 p-4 text-sm">
        <summary className="cursor-pointer font-medium">Disparos antes/depois do consentimento: {consentSummary}</summary>
        <p className="mt-1 text-xs text-slate-600">
          Comparativo por tecnologia usando `consent_state` capturado em cada evento.
        </p>
        <div className="mt-3 overflow-x-auto rounded border bg-white">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-slate-100">
              <tr>
                <th className="px-2 py-1">Tecnologia</th>
                <th className="px-2 py-1">Antes do consentimento</th>
                <th className="px-2 py-1">Depois do consentimento</th>
                <th className="px-2 py-1">Sem fase definida</th>
              </tr>
            </thead>
            <tbody>
              {consentComparison.map((row) => (
                <tr key={`consent-${row.technologyName}`} className="border-t">
                  <td className="px-2 py-1">{technologyLabel(row.technologyName)}</td>
                  <td className="px-2 py-1">{row.before}</td>
                  <td className="px-2 py-1">{row.after}</td>
                  <td className="px-2 py-1">{row.unknown}</td>
                </tr>
              ))}
              {consentComparison.length === 0 && (
                <tr>
                  <td className="px-2 py-1 text-slate-500" colSpan={4}>
                    Sem eventos para comparar fases de consentimento.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </details>

      <details className="rounded border border-slate-200 bg-slate-50 p-4 text-sm">
        <summary className="cursor-pointer font-medium">Inventário por URL (conferência do grafo): {inventorySummary}</summary>
        <p className="mt-1 text-xs text-slate-600">
          Esta tabela mostra os mesmos totais por URL usados no grafo, incluindo telas/estados únicos (coluna T).
        </p>
        <div className="mt-3 overflow-x-auto rounded border bg-white">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-slate-100">
              <tr>
                <th className="px-2 py-1">URL</th>
                <th className="px-2 py-1">Total eventos</th>
                <th className="px-2 py-1">Telas/estados (T)</th>
                <th className="px-2 py-1">Tags</th>
              </tr>
            </thead>
            <tbody>
              {urlInventory.map((row) => {
                const states = Array.from(uniqueStatesByUrl.get(row.url) ?? []).sort();
                return (
                  <tr key={`url-inventory-${row.url}`} className="border-t align-top">
                    <td className="break-all px-2 py-1">{row.url}</td>
                    <td className="px-2 py-1">{row.total}</td>
                    <td className="px-2 py-1">
                      <div className="space-y-2">
                        <p className="text-[11px] font-medium">{states.length} estado(s)</p>
                        <div className="flex flex-col gap-2">
                          {states.map((state) => {
                            const ssSrc = findScreenshot(state);
                            return (
                              <div key={`${row.url}-${state}`} className="flex flex-col gap-1">
                                <div className="flex items-start gap-2">
                                  {ssSrc ? (
                                    <button
                                      type="button"
                                      title={`Ver print: ${state}`}
                                      onClick={() => {
                                        const lb = document.getElementById("ss-lightbox-ea");
                                        const img = document.getElementById("ss-lb-img-ea") as HTMLImageElement | null;
                                        const cap = document.getElementById("ss-lb-cap-ea");
                                        if (lb && img && cap) {
                                          img.src = ssSrc;
                                          cap.textContent = state.substring(0, 120);
                                          lb.style.display = "flex";
                                        }
                                      }}
                                      className="shrink-0 overflow-hidden rounded border-2 border-slate-200 transition-all hover:border-blue-400 hover:shadow-md"
                                      style={{ width: 64, height: 36 }}
                                    >
                                      {/* eslint-disable-next-line @next/next/no-img-element */}
                                      <img
                                        src={ssSrc}
                                        alt={`Print: ${state}`}
                                        className="block h-full w-full object-cover object-top"
                                        loading="lazy"
                                      />
                                    </button>
                                  ) : (
                                    <div
                                      className="flex shrink-0 items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50 text-[9px] text-slate-400"
                                      style={{ width: 64, height: 36 }}
                                      title="Sem print capturado para este estado"
                                    >
                                      sem print
                                    </div>
                                  )}
                                </div>
                                {ssSrc ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const lb = document.getElementById("ss-lightbox-ea");
                                      const img = document.getElementById("ss-lb-img-ea") as HTMLImageElement | null;
                                      const cap = document.getElementById("ss-lb-cap-ea");
                                      if (lb && img && cap) {
                                        img.src = ssSrc;
                                        cap.textContent = state.substring(0, 120);
                                        lb.style.display = "flex";
                                      }
                                    }}
                                    className="w-full truncate rounded bg-blue-50 px-2 py-1 text-left text-[11px] leading-tight text-blue-700 transition-all hover:bg-blue-100 hover:font-medium"
                                    title={state}
                                  >
                                    {state}
                                  </button>
                                ) : (
                                  <span className="rounded bg-slate-100 px-2 py-1 text-[11px] leading-tight text-slate-500">
                                    {state}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </td>
                    <td className="px-2 py-1">
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(row.tags)
                          .sort((a, b) => b[1] - a[1])
                          .map(([tag, count]) => (
                            <span key={`${row.url}-${tag}`} className={`rounded px-2 py-1 text-[11px] ${technologyBadgeClass(tag)}`}>
                              {technologyLabel(tag)}: {count}
                            </span>
                          ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {urlInventory.length === 0 && (
                <tr>
                  <td className="px-2 py-1 text-slate-500" colSpan={4}>
                    Sem eventos para inventário por URL.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </details>

      <details ref={stepDetailsRef} className="space-y-4 rounded border p-4">
        <summary className="cursor-pointer font-medium">
          Inventário por step da jornada: {stepSummary}
        </summary>
        {hasAdvancedStepFilters && (
          <p className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Filtros avançados ativos neste inventário por step. A contagem de telas/estados pode ficar menor que o T exibido no grafo.
          </p>
        )}
        <div className="grid gap-3 rounded border border-slate-200 bg-slate-50 p-3 text-xs md:grid-cols-4">
          <label>
            Nó/Página
            <select
              className="mt-1 w-full rounded border p-2"
              value={selectedNodeUrl}
              onChange={(event) => setSelectedNodeUrl(event.target.value)}
            >
              <option value="">Todos</option>
              {flow.nodes.map((node) => (
                <option key={`node-filter-${node.url}`} value={node.url}>
                  {node.url}
                </option>
              ))}
            </select>
          </label>
          <label>
            Evento conhecido
            <select
              className="mt-1 w-full rounded border p-2"
              value={detailKnownFilter}
              onChange={(event) => setDetailKnownFilter(event.target.value as "all" | "known" | "unknown")}
            >
              <option value="all">Todos</option>
              <option value="known">Conhecido</option>
              <option value="unknown">Desconhecido</option>
            </select>
          </label>
          <label>
            Tipo de ação
            <select
              className="mt-1 w-full rounded border p-2"
              value={detailActionTypeFilter}
              onChange={(event) => setDetailActionTypeFilter(event.target.value)}
            >
              <option value="all">Todos</option>
              <option value="none">Sem ação</option>
              {actionTypeOptions.map((actionType) => (
                <option key={`action-filter-${actionType}`} value={actionType}>
                  {mapActionTypeLabel(actionType)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Método HTTP
            <select
              className="mt-1 w-full rounded border p-2"
              value={detailHttpMethodFilter}
              onChange={(event) => setDetailHttpMethodFilter(event.target.value)}
            >
              <option value="all">Todos</option>
              {httpMethodOptions.map((method) => (
                <option key={`method-${method}`} value={method}>
                  {method}
                </option>
              ))}
            </select>
          </label>
          <label>
            Status HTTP
            <select
              className="mt-1 w-full rounded border p-2"
              value={detailHttpStatusFilter}
              onChange={(event) => setDetailHttpStatusFilter(event.target.value)}
            >
              <option value="all">Todos</option>
              {httpStatusOptions.map((status) => (
                <option key={`status-${status}`} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label>
            Parâmetros
            <select
              className="mt-1 w-full rounded border p-2"
              value={detailParameterFilter}
              onChange={(event) =>
                setDetailParameterFilter(event.target.value as "all" | "with_parameters" | "without_parameters")
              }
            >
              <option value="all">Todos</option>
              <option value="with_parameters">Com parâmetro</option>
              <option value="without_parameters">Sem parâmetro</option>
            </select>
          </label>
        </div>
        <div className="rounded border border-slate-200 bg-slate-50 p-3 text-xs">
          <p className="mb-2 font-medium">Colunas visíveis na tabela detalhada</p>
          <div className="flex flex-wrap gap-2">
            {detailColumnOptions.map((column) => (
              <label key={`detail-col-${column.key}`} className="inline-flex items-center gap-1 rounded border bg-white px-2 py-1">
                <input
                  type="checkbox"
                  checked={detailVisibleColumns[column.key]}
                  onChange={(event) =>
                    setDetailVisibleColumns((previous) => ({
                      ...previous,
                      [column.key]: event.target.checked,
                    }))
                  }
                />
                {column.label}
              </label>
            ))}
          </div>
        </div>
        {steps.length === 0 && <p className="text-sm text-slate-500">Nenhum evento encontrado para montar steps.</p>}

        {steps.map((step) => (
          <article key={step.key} className="rounded border border-slate-200 p-4">
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">{step.title}</h3>
                {step.action ? (
                  <p className="text-sm text-slate-600">
                    Ação: <strong>{step.action.action_type}</strong>
                    {step.action.target_selector ? ` • alvo: ${step.action.target_selector}` : ""}
                  </p>
                ) : (
                  <div className="space-y-1">
                    <p className="text-sm text-slate-600">
                      Eventos assíncronos sem correlação direta com uma ação (`action_id` ausente).
                    </p>
                    <p className="text-xs text-slate-500">
                      Comum para pixels/tags disparados por scripts, consentimento, timers e carregamentos em background.
                    </p>
                  </div>
                )}
                {step.action && (
                  <p className="text-xs text-slate-500">
                    {normalizeState(step.action.state_before)} → {normalizeState(step.action.state_after)}
                  </p>
                )}
              </div>
              <span className="rounded bg-slate-100 px-2 py-1 text-xs">{step.events.length} eventos</span>
            </header>

            <div className="mt-3 overflow-x-auto rounded border">
              <table className="min-w-full text-left text-xs">
                <thead className="bg-slate-100">
                  <tr>
                    <th className="px-2 py-1">Tela/URL</th>
                    <th className="px-2 py-1">Estados únicos no step</th>
                    <th className="px-2 py-1">Eventos</th>
                    <th className="px-2 py-1">Tags disparadas</th>
                  </tr>
                </thead>
                <tbody>
                  {step.byUrl.map((row) => (
                    <tr key={row.url} className="border-t">
                      <td className="break-all px-2 py-1">{row.url}</td>
                      <td className="px-2 py-1">
                        <div className="space-y-1">
                          <p className="text-[11px] font-medium">{row.states.length} estado(s)</p>
                          <div className="flex flex-wrap gap-2">
                            {row.states.slice(0, 6).map((state) => {
                              const ssSrc = findScreenshot(state);
                              return ssSrc ? (
                                <button
                                  key={`step-ss-${row.url}-${state}`}
                                  type="button"
                                  title={`Ver print: ${state}`}
                                  onClick={() => {
                                    const lb = document.getElementById("ss-lightbox-ea");
                                    const img = document.getElementById("ss-lb-img-ea") as HTMLImageElement | null;
                                    const cap = document.getElementById("ss-lb-cap-ea");
                                    if (lb && img && cap) {
                                      img.src = ssSrc;
                                      cap.textContent = state.substring(0, 120);
                                      lb.style.display = "flex";
                                    }
                                  }}
                                  className="flex flex-col overflow-hidden rounded border-2 border-slate-200 transition-all hover:border-blue-400 hover:shadow-md"
                                  style={{ width: 72 }}
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={ssSrc}
                                    alt={`Print: ${state}`}
                                    className="h-10 w-full object-cover object-top"
                                    loading="lazy"
                                  />
                                  <span className="truncate bg-blue-50 px-1 py-0.5 text-center text-[9px] text-blue-700">
                                    {state.split(" | ").pop()?.substring(0, 20) ?? state.substring(0, 20)}
                                  </span>
                                </button>
                              ) : (
                                <span key={`step-state-${row.url}-${state}`} className="rounded bg-slate-100 px-2 py-1 text-[11px]">
                                  {state}
                                </span>
                              );
                            })}
                            {row.states.length > 6 && (
                              <span className="rounded bg-slate-100 px-2 py-1 text-[11px]">
                                +{row.states.length - 6}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-1">{row.eventCount}</td>
                      <td className="px-2 py-1">
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(row.tags).map(([tag, count]) => (
                            <span key={tag} className={`rounded px-2 py-1 text-[11px] ${technologyBadgeClass(tag)}`}>
                              {technologyLabel(tag)}: {count}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-3 overflow-x-auto rounded border">
              <table className="min-w-full text-left text-xs">
                <thead className="bg-slate-100">
                  <tr>
                    {detailVisibleColumns.time && <th className="px-2 py-1">Hora</th>}
                    {detailVisibleColumns.type && <th className="px-2 py-1">Tipo</th>}
                    {detailVisibleColumns.tag && <th className="px-2 py-1">Tag</th>}
                    {detailVisibleColumns.event && <th className="px-2 py-1">Evento</th>}
                    {detailVisibleColumns.element && <th className="px-2 py-1">Elemento/Ação</th>}
                    {detailVisibleColumns.consent && <th className="px-2 py-1">Consentimento</th>}
                    {detailVisibleColumns.http && <th className="px-2 py-1">HTTP</th>}
                    {detailVisibleColumns.state && <th className="px-2 py-1">Tela/estado</th>}
                    {detailVisibleColumns.confidence && <th className="px-2 py-1">Confiança</th>}
                    {detailVisibleColumns.detail && <th className="px-2 py-1">Detalhe</th>}
                  </tr>
                </thead>
                <tbody>
                  {step.events.map((event) => {
                    const action = event.action_id ? actionsById.get(event.action_id) ?? null : null;
                    const parsedTarget = parseTargetSelector(action?.target_selector);
                    const actionLabel = action ? mapActionTypeLabel(action.action_type) : "navegação causada por ação anterior";
                    const triggerLabel = action ? `${actionLabel}` : "assíncrono (sem ação)";
                    const consentLabel =
                      event.consent_state === "before_consent"
                        ? "antes"
                        : event.consent_state === "after_consent"
                          ? "depois"
                          : "não identificado";
                    const method = String((event.request_payload?.method as string | undefined) ?? "unknown").toUpperCase();
                    const status = String((event.request_payload?.status as number | string | undefined) ?? "-");
                    return (
                      <tr key={event.id} className="border-t align-top">
                        {detailVisibleColumns.time && <td className="px-2 py-1">{new Date(event.timestamp).toLocaleTimeString("pt-BR")}</td>}
                        {detailVisibleColumns.type && <td className="px-2 py-1">{event.event_type}</td>}
                        {detailVisibleColumns.tag && <td className="px-2 py-1">{technologyLabel(event.technology)}</td>}
                        {detailVisibleColumns.event && <td className="px-2 py-1">{event.event_name ?? "-"}</td>}
                        {detailVisibleColumns.element && <td className="px-2 py-1">
                          <div className="space-y-1">
                            <p>{triggerLabel}</p>
                            <p className="text-[11px] text-slate-600">
                              {parsedTarget.kind || "elemento"} {parsedTarget.text ? `• ${parsedTarget.text}` : ""}
                            </p>
                            {(parsedTarget.href || parsedTarget.selector) && (
                              <p className="text-[11px] text-slate-500">
                                {parsedTarget.href ? `href: ${parsedTarget.href}` : ""}
                                {parsedTarget.href && parsedTarget.selector ? " • " : ""}
                                {parsedTarget.selector ? `id técnico: ${parsedTarget.selector}` : ""}
                              </p>
                            )}
                            {parsedTarget.context && (
                              <p className="text-[11px] text-slate-500">contexto: {parsedTarget.context}</p>
                            )}
                          </div>
                        </td>}
                        {detailVisibleColumns.consent && <td className="px-2 py-1">
                          <span
                            className={
                              event.consent_state === "before_consent"
                                ? "rounded bg-sky-100 px-2 py-1 text-[11px] text-sky-900"
                                : event.consent_state === "after_consent"
                                  ? "rounded bg-emerald-100 px-2 py-1 text-[11px] text-emerald-900"
                                  : "rounded bg-slate-100 px-2 py-1 text-[11px] text-slate-700"
                            }
                          >
                            {consentLabel}
                          </span>
                        </td>}
                        {detailVisibleColumns.http && <td className="px-2 py-1">
                          <span className="text-[11px]">
                            {method} {status}
                          </span>
                        </td>}
                        {detailVisibleColumns.state && <td className="px-2 py-1">{normalizeState(event.state_name)}</td>}
                        {detailVisibleColumns.confidence && <td className="px-2 py-1">
                          <span
                            className={
                              event.correlation_confidence === "low"
                                ? "rounded bg-amber-100 px-2 py-1 text-[11px] text-amber-900"
                                : "rounded bg-emerald-100 px-2 py-1 text-[11px] text-emerald-900"
                            }
                          >
                            {event.correlation_confidence}
                          </span>
                        </td>}
                        {detailVisibleColumns.detail && <td className="px-2 py-1">
                          <details>
                            <summary className="cursor-pointer text-blue-700">ver</summary>
                            <div className="mt-1 space-y-2">
                              <p className="text-[11px]">URL: {event.url}</p>
                              {showParameters ? (
                                <>
                                  <p className="text-[11px] font-medium">Parâmetros</p>
                                  <pre className="max-w-xl overflow-x-auto rounded bg-slate-100 p-2">
                                    {prettyJson(event.parameters)}
                                  </pre>
                                  <p className="text-[11px] font-medium">Payload</p>
                                  <pre className="max-w-xl overflow-x-auto rounded bg-slate-100 p-2">
                                    {prettyJson(event.request_payload)}
                                  </pre>
                                </>
                              ) : (
                                <p className="text-[11px] text-slate-600">
                                  Parâmetros ocultos para este nível de auditoria (
                                  {audit?.config?.auditLevel ?? "não informado"}).
                                </p>
                              )}
                            </div>
                          </details>
                        </td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </article>
        ))}
      </details>

      <section>
        <h2 className="font-medium">Campos ignorados</h2>
        {ignoredByReason.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {ignoredByReason.map(([reason, count]) => (
              <span key={`ignored-${reason}`} className="rounded bg-slate-100 px-2 py-1">
                {ignoredReasonLabel(reason)}: <strong>{count}</strong>
              </span>
            ))}
          </div>
        )}
        <p className="mt-2 text-xs text-slate-600">
          "Sem mapeamento" geralmente indica falta de matcher na persona ativa. Já "tipo não suportado" costuma ser controle técnico (ex.: consentimento/checkbox), não ausência de dado.
        </p>
        <p className="mt-1 text-xs text-slate-600">
          Para ajustar a persona padrão, use <Link href="/templates" className="text-blue-700 underline">Personas & Templates</Link>.
        </p>
        {technicalIgnoredCount > 0 && (
          <p className="mt-1 text-xs text-emerald-700">
            Nesta execução, {technicalIgnoredCount} campo(s) ignorado(s) parecem ser controles técnicos (consentimento/terceiros), não ausência de dado da persona.
          </p>
        )}
        <ul className="mt-2 list-disc pl-5 text-sm">
          {(execution?.ignoredFields ?? []).map((field, index) => (
            <li key={`${field.fieldName}-${index}`}>
              {field.fieldName} ({ignoredReasonLabel(field.reason)} · {ignoredFieldContextLabel(field.fieldName)})
            </li>
          ))}
          {(execution?.ignoredFields ?? []).length === 0 && <li>Nenhum campo ignorado.</li>}
        </ul>
      </section>

      <section>
        <h2 className="font-medium">Limitações e avisos</h2>
        {warningsByType.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {warningsByType.map(([type, count]) => (
              <span key={`warning-${type}`} className="rounded bg-slate-100 px-2 py-1">
                {type}: <strong>{count}</strong>
              </span>
            ))}
          </div>
        )}
        <ul className="mt-2 list-disc pl-5 text-sm">
          {(execution?.warnings ?? []).map((warning, index) => (
            <li key={`${warning.type}-${index}`}>
              {warning.type}: {warning.message}
            </li>
          ))}
          {(execution?.warnings ?? []).length === 0 && <li>Sem avisos registrados.</li>}
        </ul>
        {blockedUrlDetails.length > 0 && (
          <>
            <h3 className="mt-3 text-sm font-medium text-slate-700">URLs bloqueadas pelo Cloudflare</h3>
            <ul className="mt-1 list-disc pl-5 text-sm">
              {blockedUrlDetails.map((blocked) => (
                <li key={`blocked-${blocked.url}`}>
                  {blocked.url}
                  {blocked.status ? ` | status=${blocked.status}` : ""}
                  {blocked.cfRay ? ` | cf-ray=${blocked.cfRay}` : ""}
                  {blocked.reason ? ` | motivo=${blocked.reason}` : ""}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </section>
  );
}
