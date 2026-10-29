"""Operações de página (Playwright sync) portadas de explorer.ts.

Os trechos JS executados no navegador são mantidos como strings e seguem a
mesma lógica da versão TypeScript (scores, seletores e regex).
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from typing import Any, Optional
from urllib.parse import urljoin, urlparse

log = logging.getLogger("crawler-tag-portable")

DYNAMIC_CTA_SELECTOR = (
    "button, [role='button'], input[type='submit'], input[type='button'], a[href], "
    "a[role='button'], a[class*='button'], a[class*='btn'], [onclick]"
)

OVERLAY_SELECTORS = [
    '[role="dialog"][aria-modal="true"]',
    ".modal.show",
    ".modal-backdrop.show",
    ".MuiBackdrop-root",
    ".ReactModal__Overlay",
    '[class*="loading-overlay"]',
    '[class*="loader-overlay"]',
    '[id*="overlay"][style*="display: block"]',
]

LOADING_SIGNAL_SELECTOR = (
    "[class*='loading'], [class*='spinner'], [aria-busy='true'], [role='progressbar'], "
    ".modal-backdrop, .MuiBackdrop-root, [class*='skeleton']"
)

CONSENT_SELECTORS = [
    "#onetrust-accept-btn-handler",
    ".cc-btn.cc-allow",
    "button[aria-label*='permit']",
    "button[id*='permit']",
    "button[class*='permit']",
    "button[aria-label*='aceit']",
    "button[aria-label*='accept']",
    "button[id*='accept']",
    "button[class*='accept']",
    "button[class*='consent']",
]

CONSENT_TEXT_RE = re.compile(
    r"aceitar|aceito|allow all|accept all|concordo|permitir|permito|entendi|ok,? entendi", re.I
)

# Script de furtividade (addInitScript) — idêntico ao da versão completa.
STEALTH_INIT_JS = r"""
() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  window["chrome"] = {
    app: { isInstalled: false, InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" }, RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" } },
    csi: () => ({}),
    loadTimes: () => ({}),
    runtime: {},
  };
  const pluginData = [
    { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format" },
    { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
    { name: "Native Client", filename: "internal-nacl-plugin", description: "" },
  ];
  Object.defineProperty(navigator, "plugins", { get: () => pluginData });
  Object.defineProperty(navigator, "mimeTypes", { get: () => [] });
  Object.defineProperty(navigator, "languages", { get: () => ["pt-BR", "pt", "en-US", "en"] });
  const origPerms = window.navigator.permissions && window.navigator.permissions.query.bind(window.navigator.permissions);
  if (origPerms) {
    Object.defineProperty(window.navigator.permissions, "query", {
      value: (params) => params.name === "notifications" ? Promise.resolve({ state: "default", onchange: null }) : origPerms(params),
    });
  }
  if ("userAgentData" in navigator) {
    Object.defineProperty(navigator, "userAgentData", {
      get: () => ({
        brands: [
          { brand: "Google Chrome", version: "131" },
          { brand: "Chromium", version: "131" },
          { brand: "Not_A Brand", version: "24" },
        ],
        mobile: false,
        platform: "Windows",
        getHighEntropyValues: (hints) => Promise.resolve(
          Object.fromEntries(hints.map(h => [h, h === "platform" ? "Windows" : h === "platformVersion" ? "10.0.0" : ""]))
        ),
      }),
    });
  }
  for (const k of ["__playwright", "__pwInitScripts", "__pw_manual", "cdc_adoQpoasnfa76pfcZLmcfl_Array", "cdc_adoQpoasnfa76pfcZLmcfl_Promise", "cdc_adoQpoasnfa76pfcZLmcfl_Symbol"]) {
    try { delete window[k]; } catch (e) { /* noop */ }
  }
  Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
  Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
  const getParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (param) {
    if (param === 37445) return "Intel Inc.";
    if (param === 37446) return "Intel Iris OpenGL Engine";
    return getParam.call(this, param);
  };
}
"""

JS_OVERLAY_VISIBLE = r"""
(sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.width > 50 && rect.height > 50 && style.display !== "none" &&
    style.visibility !== "hidden" && style.opacity !== "0";
}
"""

JS_UI_LOADING_VISIBLE = r"""
() => {
  const candidates = Array.from(document.querySelectorAll(
    "[class*='loading'], [class*='spinner'], [aria-busy='true'], [role='progressbar'], .modal-backdrop, .MuiBackdrop-root"
  ));
  return candidates.some((node) => {
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  });
}
"""

JS_LOADING_SIGNALS = r"""
(selector) => {
  const nodes = Array.from(document.querySelectorAll(selector));
  let visible = 0;
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    const isVisible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    if (isVisible) visible += 1;
  }
  return { busy: visible > 0, visibleSignals: visible };
}
"""

JS_TRANSITION_SIGNATURE = r"""
() => {
  const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const activeHeading = Array.from(document.querySelectorAll("h1, h2, [role='heading'], [class*='step'], [class*='wizard']"))
    .map((el) => normalize(el.textContent)).find(Boolean);
  const visibleFormControls = Array.from(document.querySelectorAll("input, select, textarea")).filter(isVisible).length;
  const visibleButtons = Array.from(document.querySelectorAll("button, [role='button'], input[type='submit'], input[type='button']"))
    .filter(isVisible)
    .map((el) => normalize(el.textContent || el.value || ""))
    .filter(Boolean).slice(0, 20);
  const visibleFieldHints = Array.from(document.querySelectorAll("input, select, textarea"))
    .filter(isVisible)
    .map((el) => normalize(el.name || el.id || el.getAttribute("aria-label") || el.placeholder || ""))
    .filter(Boolean).slice(0, 20);
  const activeStepHints = Array.from(document.querySelectorAll(
    "[aria-current='step'], [aria-current='true'], [class*='step'][class*='active'], [class*='wizard'][class*='active']"
  )).filter(isVisible).map((el) => normalize(el.textContent)).filter(Boolean).slice(0, 6);
  const errorHints = Array.from(document.querySelectorAll("[role='alert'], .error, [class*='error'], [aria-invalid='true']"))
    .filter(isVisible).map((el) => normalize(el.textContent)).filter(Boolean).slice(0, 6);
  const summaryContainer =
    document.querySelector("aside") || document.querySelector("[class*='summary']") ||
    document.querySelector("[class*='resumo']") || document.querySelector("[class*='proposal']") ||
    document.querySelector("[class*='proposta']") || document.querySelector("[class*='cart']") ||
    document.querySelector("[class*='cesta']") || document.querySelector("[class*='basket']") ||
    document.querySelector("[class*='drawer']") || document.querySelector("[class*='sidebar']");
  const focusContainer =
    document.querySelector("[role='dialog']") || summaryContainer || document.querySelector("form") ||
    document.querySelector("[class*='wizard']") || document.querySelector("[class*='step']") ||
    document.querySelector("main") || document.querySelector("article") || document.body;
  const contentSnippet = normalize((focusContainer && focusContainer.innerText) || "").slice(0, 900);
  return {
    url: location.href,
    title: normalize(document.title),
    activeHeading: activeHeading || "",
    visibleFormControls,
    visibleButtons,
    visibleFieldHints,
    activeStepHints,
    errorHints,
    contentSnippet,
  };
}
"""

JS_CAPTURE_STATE = r"""
() => {
  const isVis = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const clean = (s, n) => (s || "").trim().replace(/\s+/g, " ").slice(0, n);
  // 1. Step indicator com aria-current ou active
  const stepCurrent = document.querySelector(
    "[aria-current='step'], [class*='step'][class*='active'], [class*='step'][class*='current'], " +
    "[class*='wizard'][class*='active'], [class*='progress'][class*='active']"
  );
  if (stepCurrent) {
    const stepText = clean(stepCurrent.textContent, 80);
    if (stepText) return { context: `Step: ${stepText}`, semantic: "" };
  }
  // 2. Indicador numérico de step
  const stepLabels = document.querySelectorAll(
    "[class*='step-label'], [class*='step-title'], [class*='wizard-step'], " +
    "[class*='step-indicator'], [class*='breadcrumb-item'][class*='active']"
  );
  for (const el of Array.from(stepLabels)) {
    const text = clean(el.textContent, 80);
    if (text && /\d/.test(text)) return { context: `Step: ${text}`, semantic: "" };
  }
  // 3. Heading ativo de modal/dialog
  const openModal = document.querySelector(
    "[role='dialog']:not([hidden]), [role='dialog'][open], .modal.show, .modal.active, " +
    "[class*='modal'][class*='open'], [aria-modal='true']"
  );
  if (openModal) {
    const modalTitle = openModal.querySelector("h1, h2, h3, [class*='modal-title'], [class*='dialog-title']");
    const titleText = clean(modalTitle && modalTitle.textContent, 80);
    if (titleText) return { context: `Modal: ${titleText}`, semantic: "" };
    const firstText = clean((openModal.querySelector("h1, h2, h3") || {}).textContent, 80);
    if (firstText) return { context: `Modal: ${firstText}`, semantic: "" };
  }
  // 4. Heurísticas estruturais
  const visibleButtons = Array.from(document.querySelectorAll("button, [role='button']")).filter(isVis);
  const buttonTexts = visibleButtons.map((b) => (b.textContent || "").trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean);
  const bodyText = ((document.body && document.body.innerText) || "").trim().replace(/\s+/g, " ").toLowerCase();
  const summaryPanel = document.querySelector(
    "aside, [class*='summary'], [class*='resumo'], [class*='proposal'], [class*='proposta'], [class*='cart'], " +
    "[class*='cesta'], [class*='basket'], [class*='drawer'], [class*='sidebar']"
  );
  const summaryPanelText = ((summaryPanel && summaryPanel.textContent) || "").trim().replace(/\s+/g, " ").toLowerCase();
  const cartCtaText = buttonTexts.join(" | ");
  if (/(ver proposta|atualizar cesta|editar produtos|checkout|fechar pedido|finalizar pedido)/.test(cartCtaText) ||
      /(ver proposta|atualizar cesta|editar produtos|checkout|fechar pedido|finalizar pedido)/.test(summaryPanelText)) {
    return { context: "Step: Resumo de proposta", semantic: "" };
  }
  // 5. Formulário ativo com título
  const activeForm = document.querySelector("form:not([hidden]), [role='form']");
  if (activeForm) {
    const formTitle = activeForm.querySelector("legend, [class*='form-title'], h1, h2, h3");
    const formText = clean(formTitle && formTitle.textContent, 80);
    if (formText) return { context: `Form: ${formText}`, semantic: "" };
  }
  // 6. H1 visível principal
  const h1 = document.querySelector("h1");
  const h1Text = clean(h1 && h1.textContent, 80);
  if (h1Text && h1Text.length > 3) return { context: h1Text, semantic: "" };

  const visibleInputs = Array.from(document.querySelectorAll("input, select, textarea")).filter(isVis);
  const inputHints = visibleInputs
    .map((el) => `${el.name || ""} ${el.id || ""} ${el.getAttribute("placeholder") || ""}`.toLowerCase())
    .join(" | ");

  if (/(cpf|data.?nascimento|nome.?completo|celular|email|endereco|endereço)/.test(inputHints)) {
    return { context: "Step: Dados pessoais", semantic: "" };
  }
  if (buttonTexts.some((txt) => /quero este|selecionar plano|contratar plano|simular plano/.test(txt)) ||
      /(selecione o plano|escolha o plano|resumo da viagem|coberturas|quero este)/.test(bodyText)) {
    return { context: "Step: Seleção de plano", semantic: "" };
  }
  if (/(startdate|enddate|data de ida|data de volta|react-select-2-input|seguir com a cotação)/.test(inputHints + " | " + buttonTexts.join(" | "))) {
    return { context: "Step: Informações da viagem", semantic: "" };
  }
  // 7. Título do documento (fallback)
  const title = clean(document.title, 80);
  if (title && title.length > 3) {
    const semanticTitle = [title.toLowerCase(), buttonTexts.slice(0, 8).join("|"), inputHints.slice(0, 180)].join("::");
    return { context: title, semantic: semanticTitle };
  }
  const fallbackHeading = clean((document.querySelector("h1, h2, h3") || {}).textContent, 80);
  const semantic = [fallbackHeading.toLowerCase(), buttonTexts.slice(0, 8).join("|"), inputHints.slice(0, 180)]
    .join("::").slice(0, 350);
  return { context: "", semantic };
}
"""


# Compra e pagamento: o crawler para antes da última etapa dos fluxos (pagamento / cartão).
PURCHASE_TEXT_RE = re.compile(
    r"(comprar|pagar|pagamento|pague|finalizar (a )?(compra|pedido|contrata[cç][aã]o)|fechar pedido|"
    r"concluir (a )?compra|confirmar (e pagar|compra|pagamento|contrata)|ir para (o )?pagamento|"
    r"contratar agora|contratar e pagar|checkout|efetuar|emitir ap[oó]lice|assinar)",
    re.I,
)
PURCHASE_URL_RE = re.compile(r"/(checkout|pagamento|pagamentos|carrinho|cesta|comprar)(/|\?|$)", re.I)
# URLs onde o avanço é a compra (informadas na jornada): o motor preenche, mas não clica em nenhum botão de avanço.
COMPRA_URLS: set[str] = set()


def definir_urls_de_compra(urls: list[str]) -> None:
    COMPRA_URLS.clear()
    COMPRA_URLS.update(_url_sem_query(u) for u in urls if u)


def _url_sem_query(url: str) -> str:
    parsed = urlparse((url or "").strip())
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}{parsed.path.rstrip('/') or '/'}"


def em_url_de_compra(page: Any) -> bool:
    return bool(COMPRA_URLS) and _url_sem_query(page.url) in COMPRA_URLS


PAYMENT_FIELD_RE = re.compile(r"(card|cart[aã]o|cvv|cvc|csc|validade|expiry|cc-number|cc-csc|cc-exp)", re.I)

JS_FIND_BEST_CTA = r"""
(args) => {
  const excluded = args.excluded, selector = args.selector;
  const normalizedExcluded = excluded.map((item) => item.toLowerCase().trim()).filter(Boolean);
  const normalize = (value) => (value || "").toLowerCase().replace(/\s+/g, " ").trim();
  const purchaseRe = /(comprar|pagar|pagamento|pague|finalizar (a )?(compra|pedido|contrata[cç][aã]o)|fechar pedido|concluir (a )?compra|confirmar (e pagar|compra|pagamento|contrata)|ir para (o )?pagamento|contratar agora|contratar e pagar|checkout|efetuar|emitir ap[oó]lice|assinar)/i;
  const paymentFieldRe = /(card|cart[aã]o|cvv|cvc|csc|validade|expiry|cc-number|cc-csc|cc-exp)/i;
  const paymentScreen = Array.from(document.querySelectorAll("input, select")).some((el) =>
    paymentFieldRe.test(`${el.name || ""} ${el.id || ""} ${el.getAttribute("autocomplete") || ""} ${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""}`));
  if (paymentScreen) return null;
  const elements = Array.from(document.querySelectorAll(selector));
  const isUsable = (node) => {
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    if (!visible) return false;
    const disabled = node.hasAttribute("disabled") || node.getAttribute("aria-disabled") === "true" ||
      Array.from(node.classList).some((c) => /disabled/.test(c)) || style.pointerEvents === "none";
    return !disabled;
  };
  let best = null;
  for (let index = 0; index < elements.length; index += 1) {
    const node = elements[index];
    if (!isUsable(node)) continue;
    const rawText = node.textContent || node.getAttribute("value") || node.getAttribute("aria-label") || node.getAttribute("title") || "";
    const text = normalize(rawText);
    if (!text) continue;
    if (normalizedExcluded.includes(text)) continue;
    if (/(hand talk|vlibras|libras|acessibilidade|plugin de acessibilidade|plugin)/.test(text)) continue;
    if (purchaseRe.test(text)) continue;

    let score = 0;
    if (/(seguir|continuar|avançar|avancar|pr[oó]ximo|proximo|cotação|cotacao|contratar|simular|finalizar|agendar)/.test(text)) score += 45;
    if (/(ver quanto custa|ver proposta|atualizar cesta|adicionar ou editar produtos)/.test(text)) score += 42;
    if (/(quero este|quero essa|quero esta|escolher|selecionar|contratar este|comprar agora|compre agora)/.test(text)) score += 38;
    if (/(seguir com a cota[cç][aã]o|seguir com essa cota[cç][aã]o|seguir com esta cota[cç][aã]o)/.test(text)) score += 35;
    if (/(ve[ií]culo.*0\s*km|0\s*km.*sem\s*placa|sem\s*placa|n[aã]o\s*sei\s*a\s*placa|consultar\s*placa|pesquisar\s*ve[ií]culo)/.test(text)) score += 38;
    if (/(voltar|fechar|cancelar|sair|ajuda|parceiros|área do cliente|area do cliente)/.test(text)) score -= 55;
    if (/(nossos produtos|loja virtual|sua cesta)/.test(text)) score -= 45;
    if (/(saiba mais|ver mais|detalhes|conhe[çc]a|entenda)/.test(text)) score -= 20;
    // Controles de carrossel ("Próximo" do banner) não são o fluxo: perdem para CTAs reais de simulação/contratação
    if (/^(pr[oó]ximo|anterior|next|previous)$/.test(text)) score -= 40;
    if (/(contrate|simule|simular|cota[cç][aã]o)/.test(text)) score += 12;

    const cls = normalize(node.className);
    const id = normalize(node.id);
    if (/(primary|cta|submit|continue|next)/.test(`${cls} ${id}`)) score += 18;
    if (node.closest("[role='dialog'], .modal, [class*='modal']")) score += 24;
    const formScope = node.closest("form, [role='form'], [class*='form'], [class*='wizard'], [class*='step']") ||
      node.closest("section, article, main");
    if (formScope) score += 18;
    if (formScope && formScope.querySelector("#startDate, #endDate, input[id*='react-select']")) score += 22;
    if (node.closest("header, footer, nav")) score -= 28;
    const inputType = normalize(node.type || "");
    if (inputType === "submit") score += 20;

    if (!best || score > best.score) best = { index, text, score };
  }

  if (!best || best.score < 8) {
    let fallback = null;
    for (let index = 0; index < elements.length; index += 1) {
      const node = elements[index];
      if (!isUsable(node)) continue;
      if (node.closest("header, footer, nav")) continue;
      const text = normalize(node.textContent || node.getAttribute("value") || node.getAttribute("aria-label") || "");
      if (!text || normalizedExcluded.includes(text)) continue;
      if (/(hand talk|vlibras|libras|acessibilidade|plugin de acessibilidade|plugin)/.test(text)) continue;
      if (/(voltar|fechar|cancelar|sair)/.test(text)) continue;
      if (purchaseRe.test(text)) continue;
      if (!node.closest("form, [role='form'], [class*='form'], [class*='wizard'], [class*='step'], section, article, main")) continue;
      fallback = { index, text, score: 8 };
    }
    return fallback;
  }
  return best;
}
"""

JS_TRAVEL_READY = r"""
() => {
  const normalize = (v) => (v || "").trim();
  const startDate = normalize((document.querySelector("#startDate") || {}).value);
  const endDate = normalize((document.querySelector("#endDate") || {}).value);
  const countryHidden = normalize((document.querySelector("input[name='select_country']") || {}).value);
  const motoRe = /acidentes? de moto|am[eé]rica latina|assinale o campo acima para continuar/i;
  const checkboxes = Array.from(document.querySelectorAll("input[type='checkbox']"));
  let needsMotoConsent = false;
  let motoConsentChecked = true;
  for (const checkbox of checkboxes) {
    const byLabel = checkbox.id ? document.querySelector(`label[for='${checkbox.id}']`) : null;
    const container = checkbox.closest("label") || checkbox.closest("div") || checkbox.parentElement;
    const contextText = `${(byLabel && byLabel.textContent) || ""} ${(container && container.textContent) || ""}`.replace(/\s+/g, " ");
    if (motoRe.test(contextText)) {
      needsMotoConsent = true;
      motoConsentChecked = checkbox.checked;
      break;
    }
  }
  return Boolean(startDate) && Boolean(endDate) && Boolean(countryHidden) && (!needsMotoConsent || motoConsentChecked);
}
"""

JS_BLOCKERS = r"""
() => {
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const normalize = (v) => (v || "").replace(/\s+/g, " ").trim();
  const invalidCount = Array.from(document.querySelectorAll("input, select, textarea")).filter((input) => {
    if (!isVisible(input)) return false;
    if (typeof input.checkValidity !== "function") return false;
    return !input.checkValidity();
  }).length;
  const requiredEmptyCount = Array.from(document.querySelectorAll("input[required], select[required], textarea[required]"))
    .filter((input) => isVisible(input) && !normalize(input.value)).length;
  const errorHints = Array.from(document.querySelectorAll(
    ".error, [class*='error'], [aria-invalid='true'], [role='alert'], [class*='invalid']"
  )).filter(isVisible).map((n) => normalize(n.textContent)).filter(Boolean).slice(0, 6);
  return { invalidCount, requiredEmptyCount, errorHints };
}
"""

JS_MOTO_CHECKBOX_INDEX = r"""
() => {
  const normalize = (v) => (v || "").toLowerCase().replace(/\s+/g, " ").trim();
  const re = /acidentes? de moto|am[eé]rica latina|assinale o campo acima para continuar/;
  const checkboxes = Array.from(document.querySelectorAll("input[type='checkbox']"));
  for (let index = 0; index < checkboxes.length; index += 1) {
    const checkbox = checkboxes[index];
    const byLabel = checkbox.id ? document.querySelector(`label[for="${checkbox.id}"]`) : null;
    const nearest = checkbox.closest("label") || checkbox.closest("div") || checkbox.closest("section") || checkbox.parentElement;
    const contextText = normalize(`${(byLabel && byLabel.textContent) || ""} ${(nearest && nearest.textContent) || ""}`);
    if (re.test(contextText)) return index;
  }
  return -1;
}
"""

JS_REACT_SELECTED_TEXT = r"""
(prefix) => {
  const normalized = (s) => (s ? s.trim().replace(/\s+/g, " ") : "");
  const selectedNode = prefix
    ? document.querySelector(`[id='${prefix}-single-value']`)
    : document.querySelector("[class*='singleValue'], [class*='single-value']");
  if (selectedNode && selectedNode.textContent) return normalized(selectedNode.textContent);
  const fallbackRoot = prefix
    ? document.querySelector(`[id='${prefix}-value-container']`)
    : document.querySelector("[class*='select__value-container']");
  return normalized(fallbackRoot && fallbackRoot.textContent);
}
"""

JS_FIELD_HINTS = r"""
() => {
  const lower = (v) => (v || "").toLowerCase().trim();
  const out = [];
  const elements = Array.from(document.querySelectorAll("input, select, textarea"));
  elements.forEach((element, index) => {
    const tagName = (element.tagName || "").toLowerCase();
    const inputType = (element.getAttribute("type") || "").toLowerCase();
    const inlineStyle = (element.getAttribute("style") || "").toLowerCase();
    const isHiddenLike = inputType === "hidden" || element.getAttribute("disabled") !== null ||
      element.getAttribute("readonly") !== null || element.getAttribute("aria-hidden") === "true" ||
      inlineStyle.includes("display:none") || inlineStyle.includes("visibility:hidden");
    if (isHiddenLike) return;
    const id = element.getAttribute("id");
    const name = element.getAttribute("name");
    let label = "";
    if (id) {
      const l = document.querySelector(`label[for="${id}"]`);
      label = lower(l ? l.textContent : "");
    }
    if (!label) {
      const cl = element.closest("label");
      label = lower(cl ? cl.textContent : "");
    }
    const formScope = element.closest("form, section, article, div");
    const hints = {
      name: lower(name),
      id: lower(id),
      dataField: lower(element.getAttribute("data-field")),
      type: lower(element.getAttribute("type")),
      autocomplete: lower(element.getAttribute("autocomplete")),
      placeholder: lower(element.getAttribute("placeholder")),
      ariaLabel: lower(element.getAttribute("aria-label")),
      label,
      contextText: lower(formScope ? formScope.textContent : "").slice(0, 240),
    };
    const labelNode = element.closest("label") || (id ? document.querySelector(`label[for='${id}']`) : null);
    out.push({
      index,
      tagName,
      inputType,
      hints,
      rawName: name,
      rawId: id,
      ariaLabel: (element.getAttribute("aria-label") || "").trim().slice(0, 80),
      title: (element.getAttribute("title") || "").trim().slice(0, 80),
      labelText: ((labelNode && labelNode.textContent) || "").trim().replace(/\s+/g, " ").slice(0, 80),
      dataAttr: Array.from(element.attributes).map((a) => a.name).filter((n) => n.startsWith("data-")).slice(0, 3).join(","),
      context: element.closest("[role='dialog'], .modal, [class*='modal']") ? "modal"
        : element.closest("header") ? "header"
        : element.closest("footer") ? "footer"
        : element.closest("[id*='banner'], [class*='banner']") ? "banner"
        : "content",
    });
  });
  return out;
}
"""

JS_LINKS_STATIC = r"""
(base) => {
  const out = [];
  Array.from(document.querySelectorAll("a[href]")).slice(0, 80).forEach((a) => {
    const href = a.getAttribute("href");
    if (!href) return;
    try { out.push(new URL(href, base).toString()); } catch (e) { /* ignora */ }
  });
  return out;
}
"""

JS_LINKS_DYNAMIC = r"""
() => Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")).filter(Boolean)
"""

JS_ANCHOR_META = r"""
(node) => {
  const text = (node.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
  const ariaLabel = (node.getAttribute("aria-label") || "").trim().slice(0, 80);
  const title = (node.getAttribute("title") || "").trim().slice(0, 80);
  const id = (node.id || "").trim().slice(0, 80);
  const dataAttrs = Array.from(node.attributes).map((a) => a.name).filter((n) => n.startsWith("data-")).slice(0, 3).join(",");
  const context = node.closest("header") ? "header"
    : node.closest("footer") ? "footer"
    : node.closest("[role='dialog'], .modal, [class*='modal']") ? "modal"
    : node.closest("[id*='banner'], [class*='banner']") ? "banner"
    : "content";
  const stableSelector = id ? `#${id}` : dataAttrs ? `${node.tagName.toLowerCase()}[${dataAttrs.split(",")[0]}]` : `${node.tagName.toLowerCase()}[href]`;
  return { kind: "link", text, ariaLabel, title, href: node.getAttribute("href") || "", id, dataAttr: dataAttrs, context, stableSelector };
}
"""

JS_BUTTON_IS_VISIBLE_FOR_SCAN = r"""
(el) => {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
}
"""

JS_CTA_SNAPSHOT = r"""
(node) => {
  const text = node.textContent || node.value || node.getAttribute("aria-label") || node.getAttribute("title") || "";
  const className = node.className || "";
  const disabledLike = node.hasAttribute("disabled") || node.getAttribute("aria-disabled") === "true" ||
    String(className).toLowerCase().includes("disabled") || window.getComputedStyle(node).pointerEvents === "none";
  return {
    text,
    inModal: Boolean(node.closest("[role='dialog'], .modal, [class*='modal']")),
    inFormArea: Boolean(node.closest("form, [role='form'], [class*='form'], [class*='wizard'], [class*='step']")),
    inChromeArea: Boolean(node.closest("header, footer, nav")),
    disabledLike,
  };
}
"""


def hash_content(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def summarize_element_target(
    *, kind: str, text: str = "", aria_label: str = "", title: str = "", href: str = "",
    id: str = "", data_attr: str = "", context: str = "", selector: str,
) -> str:
    pairs = [
        f"kind={kind}",
        f"text={text}" if text else "",
        f"aria={aria_label}" if aria_label else "",
        f"title={title}" if title else "",
        f"href={href}" if href else "",
        f"id={id}" if id else "",
        f"data={data_attr}" if data_attr else "",
        f"context={context}" if context else "",
        f"selector={selector}",
    ]
    return " | ".join(p for p in pairs if p)


def to_brazil_date(raw: str) -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        return raw
    year, month, day = raw.split("-")
    return f"{day}/{month}/{year}"


def is_date_like_field(field_name: str, id_value: str, label_text: str, input_type: str) -> bool:
    hints = f"{field_name} {id_value} {label_text} {input_type}".lower()
    return re.search(r"(date|data|inicio|fim|partida|retorno|checkin|checkout|fakedate|startdate|enddate)", hints) is not None


def normalize_field_descriptor(value: Optional[str]) -> str:
    return re.sub(r"\s+", " ", value or "").strip()[:80]


def wait_for_overlay_to_disappear(page: Any) -> None:
    for selector in OVERLAY_SELECTORS:
        try:
            if page.evaluate(JS_OVERLAY_VISIBLE, selector):
                log.info("overlay detectado: %s, aguardando desaparecimento", selector)
                try:
                    page.wait_for_selector(selector, state="hidden", timeout=4_000)
                except Exception:
                    log.warning("overlay %s nao desapareceu no timeout (continuando)", selector)
        except Exception:
            continue


def wait_for_ui_to_settle(page: Any, max_wait_ms: int = 18_000) -> None:
    start = time.monotonic()
    while (time.monotonic() - start) * 1000 < max_wait_ms:
        try:
            loading = page.evaluate(JS_UI_LOADING_VISIBLE)
        except Exception:
            loading = False
        if not loading:
            return
        page.wait_for_timeout(500)


def detect_page_loading_signals(page: Any) -> dict[str, Any]:
    try:
        return page.evaluate(JS_LOADING_SIGNALS, LOADING_SIGNAL_SELECTOR)
    except Exception:
        return {"busy": False, "visibleSignals": 0}


def wait_for_page_ready(page: Any, context_label: str, max_wait_ms: int = 12_000) -> dict[str, Any]:
    start = time.monotonic()
    last_signals = 0
    wait_for_overlay_to_disappear(page)
    while (time.monotonic() - start) * 1000 < max_wait_ms:
        loading = detect_page_loading_signals(page)
        last_signals = loading["visibleSignals"]
        if not loading["busy"]:
            try:
                page.wait_for_load_state("networkidle", timeout=1_500)
            except Exception:
                pass
            recheck = detect_page_loading_signals(page)
            last_signals = recheck["visibleSignals"]
            if not recheck["busy"]:
                elapsed = int((time.monotonic() - start) * 1000)
                log.info("READY %s: ready in %sms", context_label, elapsed)
                return {"ready": True, "elapsedMs": elapsed, "visibleSignals": last_signals}
        page.wait_for_timeout(300)
    elapsed = int((time.monotonic() - start) * 1000)
    log.warning("READY %s: timeout after %sms (signals=%s)", context_label, elapsed, last_signals)
    return {"ready": False, "elapsedMs": elapsed, "visibleSignals": last_signals}


def capture_transition_signature(page: Any) -> str:
    try:
        summary = page.evaluate(JS_TRANSITION_SIGNATURE)
    except Exception:
        summary = {"url": page.url, "title": "", "activeHeading": "", "visibleFormControls": 0,
                   "visibleButtons": [], "visibleFieldHints": [], "activeStepHints": [],
                   "errorHints": [], "contentSnippet": ""}
    return hash_content(json.dumps(summary, ensure_ascii=False))


PASSO_RE = re.compile(r"\b\d+\s*de\s*\d+\b[^\n|]{0,40}", re.I)


def detect_passo(page: Any) -> str:
    """Indicador de passo visível (ex.: '1 de 3 - Agendamento'). Os modais de fluxo não mudam a URL."""
    try:
        textos = page.evaluate("""() => Array.from(document.querySelectorAll('body *'))
          .filter(e => e.children.length === 0 && e.getBoundingClientRect().width > 0)
          .map(e => (e.innerText || '').trim()).filter(t => t && t.length < 80).slice(0, 400)""")
    except Exception:
        return ""
    for texto in textos:
        match = PASSO_RE.search(texto)
        if match:
            return re.sub(r"\s+", " ", match.group(0)).strip(" -")
    return ""


def capture_page_state(page: Any, base_url: Optional[str] = None) -> str:
    url = page.url or base_url or ""
    try:
        state = page.evaluate(JS_CAPTURE_STATE)
        passo = detect_passo(page)
        base = ""
        if state and state.get("context"):
            base = f"{url} | {state['context']}"
        elif state and state.get("semantic"):
            base = f"{url} | State:{hash_content(state['semantic'])[:10]}"
        if base:
            return f"{base} | passo {passo}" if passo else base
    except Exception as error:
        log.warning("STATE capture_page_state fallback to URL: %s", error)
    return url


def find_best_dynamic_cta(page: Any, excluded: list[str]) -> Optional[dict[str, Any]]:
    try:
        return page.evaluate(JS_FIND_BEST_CTA, {"excluded": excluded, "selector": DYNAMIC_CTA_SELECTOR})
    except Exception:
        return None


def has_travel_form(page: Any) -> bool:
    """Formulário de viagem: campos de data da cotação ou seletor de país."""
    try:
        return page.locator(
            "#startDate, #endDate, input[name='select_country'], "
            "#react-select-2-input, input[id*='react-select'][id$='-input']"
        ).count() > 0
    except Exception:
        return False


def is_payment_screen(page: Any) -> bool:
    """Tela de pagamento: há campo de cartão de crédito visível."""
    try:
        fields = page.locator("input, select").all()
    except Exception:
        return False
    for field in fields[:200]:
        try:
            if not field.is_visible(timeout=300):
                continue
            hints = " ".join(filter(None, [
                field.get_attribute("name"), field.get_attribute("id"), field.get_attribute("autocomplete"),
                field.get_attribute("placeholder"), field.get_attribute("aria-label")]))
        except Exception:
            continue
        if PAYMENT_FIELD_RE.search(hints):
            return True
    return False


DISMISS_OVERLAY_RE = re.compile(r"^(fechar|close|cancelar|ok|x|×)$", re.I)


TERMO_LABEL_RE = re.compile(r"(li e estou de acordo|estou de acordo|condi[cç][oõ]es gerais|termos de uso|autorizo o uso)", re.I)


def marcar_termos_customizados(page: Any) -> bool:
    """Checkbox personalizado (div.checkbox__root, sem input nativo) de termos/consentimento.

    Só clica se o botão de avanço ainda estiver desabilitado, para não desmarcar um termo já aceito.
    """
    try:
        rotulos = page.locator(".checkbox__label:visible")
        for index in range(min(rotulos.count(), 10)):
            rotulo = rotulos.nth(index)
            if not TERMO_LABEL_RE.search(rotulo.inner_text(timeout=500)):
                continue
            avancar = page.locator("button:visible", has_text=re.compile(r"^(continuar|avançar|avancar|próximo|proximo)$", re.I))
            if avancar.count() and not avancar.first.is_disabled():
                return False
            rotulo.click(timeout=1_500)
            page.wait_for_timeout(400)
            return True
    except Exception:
        pass
    return False


AVANCAR_RE = re.compile(r"^(continuar|avançar|avancar|próximo|proximo)$", re.I)


def escolher_item_em_modal(page: Any) -> bool:
    """Modal que exige escolher ao menos um item (ex.: "Selecione até 3 serviços", contador com "+").

    Só age se o botão de avanço estiver desabilitado: clica uma vez no primeiro controle de adicionar item.
    """
    try:
        avancar = page.locator("button:visible", has_text=AVANCAR_RE)
        if not avancar.count():
            return False
        botao = avancar.first
        if not (botao.is_disabled() or "disabled" in (botao.get_attribute("class") or "").lower()):
            return False
        mais = page.locator("[aria-label*='adicionar item' i]:visible, [aria-label*='aumentar' i]:visible, "
                            "[aria-label*='increase' i]:visible")
        if not mais.count():
            return False
        mais.first.click(timeout=1_500)
        page.wait_for_timeout(500)
        log.info("Item escolhido em modal para habilitar o avanço")
        return True
    except Exception:
        return False


def preencher_dropdowns_customizados(page: Any) -> int:
    """Dropdowns somente leitura (ex.: tamanho do sofá) não recebem fill: abre e escolhe a primeira opção."""
    escolhidos = 0
    try:
        gatilhos = page.locator(".dropdown__trigger")
        for index in range(min(gatilhos.count(), 5)):
            gatilho = gatilhos.nth(index)
            campo = gatilho.locator("input[readonly]")
            if not campo.count() or campo.first.input_value().strip() or not gatilho.is_visible():
                continue
            gatilho.click(timeout=1_500)
            page.wait_for_timeout(400)
            opcao = page.locator(".dropdown__item:visible").first
            if opcao.count():
                opcao.click(timeout=1_500)
                escolhidos += 1
                page.wait_for_timeout(400)
    except Exception:
        pass
    return escolhidos


def dismiss_overlays(page: Any) -> None:
    """Fecha overlays que interceptam cliques: Escape e botões de fechar visíveis em diálogos."""
    try:
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
    except Exception:
        pass
    try:
        closers = page.locator("[role=dialog] button:visible, .c-modal button:visible, [aria-label*='echar' i]:visible")
        for index in range(min(closers.count(), 5)):
            label = (closers.nth(index).inner_text(timeout=500) or closers.nth(index).get_attribute("aria-label") or "").strip()
            if DISMISS_OVERLAY_RE.match(label):
                closers.nth(index).click(timeout=1_000)
                page.wait_for_timeout(400)
                break
    except Exception:
        pass


def diagnose_click_effect(page: Any) -> dict[str, Any]:
    """Estado da tela depois de um clique sem efeito: o que o usuário veria e não está sendo visto."""
    try:
        return page.evaluate("""() => {
          const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const text = (e) => (e.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 140);
          const dialogs = Array.from(document.querySelectorAll('[role=dialog], .c-modal')).filter(visible).map(text).filter(Boolean);
          const alerts = Array.from(document.querySelectorAll('[role=alert], [class*=error], [class*=erro], [class*=alert], [class*=warning]'))
            .filter(e => visible(e) && text(e)).map(text).slice(0, 5);
          const invalid = Array.from(document.querySelectorAll('input,select,textarea'))
            .filter(e => !e.checkValidity()).map(e => (e.name || e.id || e.type) + ': ' + e.validationMessage).slice(0, 5);
          const disabled = Array.from(document.querySelectorAll('button[type=submit], button[aria-disabled=true]'))
            .filter(visible).map(e => text(e)).slice(0, 5);
          const overlays = Array.from(document.querySelectorAll('[class*=overlay]')).filter(visible).length;
          return { dialogs, alerts, invalid, disabled, overlays };
        }""")
    except Exception:
        return {}


def click_best_dynamic_cta(page: Any, excluded_texts: Optional[list[str]] = None, min_score: int = 8) -> dict[str, Any]:
    excluded_texts = excluded_texts or []
    if em_url_de_compra(page):
        log.info("Guarda de compra: nenhum botão de avanço é clicado em %s", page.url)
        return {"clicked": False, "failureReason": "purchase_guard"}
    log.info("Dynamic CTA search start (excluded=%s)", len([t for t in excluded_texts if t]))
    normalized_excluded = [t.lower().strip() for t in excluded_texts if t and t.strip()]
    candidates = page.locator(DYNAMIC_CTA_SELECTOR)

    selected = find_best_dynamic_cta(page, excluded_texts)
    if not selected:
        wait_for_ui_to_settle(page, 2_500)
        page.wait_for_timeout(300)
        selected = find_best_dynamic_cta(page, excluded_texts)

    if not selected and is_payment_screen(page):
        log.info("Dynamic CTA: tela de pagamento detectada; parando antes da compra")
        return {"clicked": False, "failureReason": "payment_screen"}

    if not selected:
        total = min(_safe_count(candidates), 120)
        fallback = None
        for index in range(total):
            candidate = candidates.nth(index)
            if not _safe_visible(candidate):
                continue
            try:
                disabled_via_api = candidate.is_disabled(timeout=1_000)
            except Exception:
                disabled_via_api = False
            try:
                snapshot = candidate.evaluate(JS_CTA_SNAPSHOT)
            except Exception:
                continue
            if disabled_via_api or snapshot["disabledLike"]:
                continue
            text = re.sub(r"\s+", " ", (snapshot["text"] or "").lower()).strip()
            if not text or text in normalized_excluded:
                continue
            if re.search(r"(hand talk|vlibras|libras|acessibilidade|plugin de acessibilidade|plugin)", text):
                continue
            if PURCHASE_TEXT_RE.search(text):
                continue
            score = _score_cta_text_fallback(text)
            if snapshot["inModal"]:
                score += 20
            if snapshot["inFormArea"]:
                score += 16
            if snapshot["inChromeArea"]:
                score -= 24
            if score < min_score:
                continue
            if fallback is None or score > fallback["score"]:
                fallback = {"index": index, "text": text, "score": score}
        if fallback:
            selected = fallback
            log.info('Dynamic CTA Playwright fallback candidate: text="%s" score=%s', selected["text"], selected["score"])

    if not selected:
        log.info("Dynamic CTA: no suitable candidate found")
        return {"clicked": False}
    log.info('Dynamic CTA candidate: text="%s" score=%s', selected["text"], selected["score"])

    total_candidates = _safe_count(candidates)
    if selected["index"] < 0 or selected["index"] >= total_candidates:
        log.info("Dynamic CTA: candidate index out of bounds (%s/%s)", selected["index"], total_candidates)
        return {"clicked": False}

    target = candidates.nth(selected["index"])
    # Links que abrem nova aba (target=_blank, ex.: "Contrate agora") são mantidos na mesma aba,
    # para o crawler acompanhar o fluxo na página atual.
    try:
        target.evaluate("el => { const a = el.closest('a'); if (a) a.removeAttribute('target'); }")
    except Exception:
        pass
    # Espera carregamentos assíncronos (ex.: endereço após o CEP) terminarem antes da referência,
    # para não atribuir ao clique uma mudança que já estava acontecendo.
    wait_for_ui_to_settle(page, 2_500)
    before_signature = capture_transition_signature(page)
    before_state = capture_page_state(page, page.url)
    try:
        target.scroll_into_view_if_needed(timeout=2_500)
    except Exception:
        pass
    wait_for_overlay_to_disappear(page)
    clicked = False
    overlay_blocked = False
    try:
        target.click(timeout=3_000)
        clicked = True
    except Exception as error:
        if "intercepts pointer events" in str(error):
            # overlay (modal, banner) na frente: fecha e tenta de novo; nunca clica no elemento de trás
            dismiss_overlays(page)
            try:
                target.click(timeout=3_000)
                clicked = True
            except Exception:
                overlay_blocked = True
        else:
            try:
                target.click(force=True, timeout=3_000)
                clicked = True
            except Exception:
                clicked = False
    if not clicked:
        log.info('Dynamic CTA click failed: text="%s" overlay=%s', selected["text"], overlay_blocked)
        return {"clicked": False, "text": selected["text"],
                "failureReason": "overlay_intercepts" if overlay_blocked else "click_failed"}

    ready_after = wait_for_page_ready(page, "after_dynamic_cta_click", 12_000)
    after_signature = capture_transition_signature(page)
    after_state = capture_page_state(page, page.url)
    page_changed = before_signature != after_signature or before_state != after_state

    if not page_changed and ready_after["ready"]:
        page.wait_for_timeout(1_800)
        delayed_ready = wait_for_page_ready(page, "after_dynamic_cta_click_grace", 4_000)
        delayed_signature = capture_transition_signature(page)
        delayed_state = capture_page_state(page, page.url)
        page_changed = before_signature != delayed_signature or before_state != delayed_state
        if page_changed:
            log.info('Dynamic CTA clicked and state changed after grace period: text="%s"', selected["text"])
            return {"clicked": True, "text": selected["text"], "pageChanged": True,
                    "stableAfterClick": delayed_ready["ready"]}

    if not page_changed and ready_after["ready"]:
        log.error('Dynamic CTA clicked but page did not change in stable state: text="%s"', selected["text"])
        return {"clicked": True, "text": selected["text"], "pageChanged": False,
                "stableAfterClick": True, "failureReason": "no_state_change_after_click",
                "diagnostico": diagnose_click_effect(page)}

    log.info('Dynamic CTA clicked: text="%s"', selected["text"])
    return {"clicked": True, "text": selected["text"], "pageChanged": page_changed,
            "stableAfterClick": ready_after["ready"]}


def _score_cta_text_fallback(text: str) -> int:
    # Mesma pontuação do fallback do Playwright (sem "contratar" em step 1, igual ao original).
    score = 0
    if re.search(r"(seguir|continuar|avançar|avancar|pr[oó]ximo|proximo|cotação|cotacao|simular|finalizar|agendar)", text):
        score += 45
    if re.search(r"(ver quanto custa|ver proposta|atualizar cesta|adicionar ou editar produtos)", text):
        score += 42
    if re.search(r"(quero este|quero essa|quero esta|escolher|selecionar|contratar este|comprar agora|compre agora)", text):
        score += 38
    if re.search(r"(seguir com a cota[cç][aã]o|seguir com essa cota[cç][aã]o|seguir com esta cota[cç][aã]o)", text):
        score += 35
    if re.search(r"(ve[ií]culo.*0\s*km|0\s*km.*sem\s*placa|sem\s*placa|n[aã]o\s*sei\s*a\s*placa|consultar\s*placa|pesquisar\s*ve[ií]culo)", text):
        score += 38
    if re.search(r"(voltar|fechar|cancelar|sair|ajuda|parceiros|área do cliente|area do cliente)", text):
        score -= 55
    if re.search(r"(nossos produtos|loja virtual|sua cesta)", text):
        score -= 45
    if re.search(r"(saiba mais|ver mais|detalhes|conhe[çc]a|entenda)", text):
        score -= 20
    return score


def _safe_count(locator: Any) -> int:
    try:
        return locator.count()
    except Exception:
        return 0


def _safe_visible(locator: Any) -> bool:
    try:
        return locator.is_visible()
    except Exception:
        return False


def is_travel_form_ready_for_submit(page: Any) -> bool:
    try:
        return bool(page.evaluate(JS_TRAVEL_READY))
    except Exception:
        return False


def diagnose_post_click_blockers(page: Any) -> dict[str, Any]:
    try:
        return page.evaluate(JS_BLOCKERS)
    except Exception:
        return {"invalidCount": 0, "requiredEmptyCount": 0, "errorHints": []}


def try_repair_after_no_change(page: Any) -> bool:
    before = diagnose_post_click_blockers(page)
    log.info("RECOVERY blockers before repair: invalid=%s requiredEmpty=%s hints=%s",
             before["invalidCount"], before["requiredEmptyCount"], " | ".join(before["errorHints"]))
    if before["invalidCount"] == 0 and before["requiredEmptyCount"] == 0 and not before["errorHints"]:
        return False

    country = page.locator("#react-select-2-input, input[id*='react-select'][id$='-input']").first
    if _safe_visible(country):
        try_interact_react_select(page, country, "Brasil")

    _fill_travel_dates(page)

    checkboxes = page.locator("input[type='checkbox']")
    for index in range(min(_safe_count(checkboxes), 6)):
        box = checkboxes.nth(index)
        if not _safe_visible(box):
            continue
        try:
            if not box.is_checked(timeout=1_500):
                box.check(timeout=1_500)
        except Exception:
            pass

    consume_consent_prompts(page)
    wait_for_page_ready(page, "after_repair_no_change", 8_000)
    after = diagnose_post_click_blockers(page)
    log.info("RECOVERY blockers after repair: invalid=%s requiredEmpty=%s hints=%s",
             after["invalidCount"], after["requiredEmptyCount"], " | ".join(after["errorHints"]))
    return True


TRAVEL_START_OFFSET_DAYS = 30
TRAVEL_END_OFFSET_DAYS = 37


def _future_date(offset_days: int, iso: bool) -> str:
    """Data futura dinâmica (hoje + offset) para a jornada de viagem.

    Substitui as datas fixas da versão completa, que já estão no passado.
    """
    from datetime import date, timedelta

    target = date.today() + timedelta(days=offset_days)
    return target.strftime("%Y-%m-%d") if iso else target.strftime("%d/%m/%Y")


def _fill_travel_dates(page: Any) -> None:
    """Datas da jornada de viagem usadas pela versão completa (valores fixos de validação)."""
    start = page.locator("#startDate").first
    if _safe_visible(start):
        start_type = ((start.get_attribute("type") or "")).lower()
        start_value = _future_date(TRAVEL_START_OFFSET_DAYS, start_type == "date")
        try:
            start.fill(start_value, timeout=2_500)
        except Exception:
            pass
        try:
            start.press("Tab")
        except Exception:
            pass
    end = page.locator("#endDate").first
    if _safe_visible(end):
        end_type = ((end.get_attribute("type") or "")).lower()
        end_value = _future_date(TRAVEL_END_OFFSET_DAYS, end_type == "date")
        try:
            end.fill(end_value, timeout=2_500)
        except Exception:
            pass
        try:
            end.press("Tab")
        except Exception:
            pass


def try_interact_react_select(page: Any, locator: Any, value_text: str) -> None:
    log.info("ReactSelect start selection: %s", value_text)
    expected = value_text.strip().lower()
    try:
        input_id = locator.get_attribute("id") or ""
    except Exception:
        input_id = ""
    react_prefix = input_id[:-6] if input_id.endswith("-input") else input_id

    def read_selected() -> str:
        try:
            return (page.evaluate(JS_REACT_SELECTED_TEXT, react_prefix) or "")
        except Exception:
            return ""

    try:
        locator.click(timeout=2_500)
    except Exception:
        pass
    try:
        locator.fill(value_text, timeout=2_500)
    except Exception:
        pass
    page.wait_for_timeout(300)

    escaped = value_text.replace("\\", "\\\\").replace('"', '\\"')
    option_candidates = [
        f'.react-select__option:has-text("{value_text}")',
        f'.select__option:has-text("{value_text}")',
        f'[id*=\'react-select\'][id*=\'option\']:has-text("{value_text}")',
        "[class*='option']",
    ]
    selected = False
    for selector in option_candidates:
        option = page.locator(selector).first
        if _safe_count(option) == 0:
            continue
        if not _safe_visible(option):
            continue
        try:
            option.click(timeout=2_500)
        except Exception:
            pass
        page.wait_for_timeout(350)
        if expected in read_selected().lower():
            selected = True
            break

    if not selected:
        try:
            page.keyboard.press("ArrowDown")
            page.keyboard.press("Enter")
        except Exception:
            pass
        page.wait_for_timeout(350)
        selected = expected in read_selected().lower()

    if not selected:
        fallback = page.locator(f"[id*='react-select'][id*='option']:has-text(\"{escaped}\")").first
        if _safe_count(fallback) > 0 and _safe_visible(fallback):
            try:
                fallback.click(timeout=2_500)
            except Exception:
                pass
    log.info("ReactSelect selection finished: %s", value_text)


def try_accept_consent_banner(page: Any) -> bool:
    for selector in CONSENT_SELECTORS:
        locator = page.locator(selector).first
        if _safe_count(locator) == 0:
            continue
        try:
            locator.click(timeout=1_500)
            page.wait_for_timeout(400)
            return True
        except Exception:
            continue
    try:
        page.locator("button, a[role='button'], [role='button']").filter(has_text=CONSENT_TEXT_RE).first.click(timeout=1_500)
        page.wait_for_timeout(400)
        return True
    except Exception:
        return False


def consume_consent_prompts(page: Any) -> int:
    accepted_count = 0
    for _ in range(5):
        try:
            accepted = try_accept_consent_banner(page)
        except Exception:
            accepted = False
        if not accepted:
            break
        accepted_count += 1
        log.info("CONSENT accepted prompt #%s", accepted_count)
        wait_for_page_ready(page, f"after_consent_{accepted_count}", 8_000)
    return accepted_count


def collect_field_hints(page: Any) -> list[dict[str, Any]]:
    try:
        return page.evaluate(JS_FIELD_HINTS)
    except Exception:
        return []


def collect_links(page: Any, base_url: str) -> list[str]:
    """Une links estáticos (primeiros 80) e dinâmicos, como em runPlaywrightEngine."""
    try:
        static_links = page.evaluate(JS_LINKS_STATIC, base_url)
    except Exception:
        static_links = []
    try:
        raw_dynamic = page.evaluate(JS_LINKS_DYNAMIC)
    except Exception:
        raw_dynamic = []
    dynamic_links: list[str] = []
    for href in raw_dynamic:
        try:
            dynamic_links.append(urljoin(page.url, href))
        except Exception:
            continue
    seen: dict[str, None] = {}
    for link in list(static_links) + dynamic_links:
        seen.setdefault(link, None)
    return list(seen.keys())
