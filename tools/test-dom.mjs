#!/usr/bin/env node
/**
 * Abastece Certo — teste de integração do app real (index.html) em node:vm.
 *
 * Lê o index.html de verdade, extrai o(s) <script> inline e o executa num
 * DOM stub fiel (getElementById, querySelectorAll, classList, eventos,
 * localStorage com injeção de falha, navigator, location, history, fetch).
 * Nenhum navegador, nenhuma dependência, nenhuma rede.
 *
 * Cobre o que o CORE puro (tools/test.mjs) não alcança: carga inicial,
 * migração v1→v2/v3, storage corrompido/bloqueado, XSS de perfil,
 * ?modo= + limpeza da URL, preset do carro, aria-live/aria-invalid,
 * barra de atualização + SKIP_WAITING, compartilhar/copiar e (v3)
 * histórico local e preços automáticos da ANP.
 *
 * Uso:
 *   node tools/test-dom.mjs            # gate (exit 1 em falha)
 *   node tools/test-dom.mjs --verbose  # mostra evidências de cada caso
 *
 * Requisitos: Node >= 20.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");
const html = readFileSync(join(ROOT, "index.html"), "utf8");

// ------------------------------------------------------------------ reporter
const tests = [];
const failures = [];

function test(name, fn) {
  tests.push({ name, fn });
}
function ok(cond, message) {
  if (!cond) throw new Error(message || "condição falsa");
}
function eq(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      (message ? message + ": " : "") +
        "esperado " + JSON.stringify(expected) + ", obtido " + JSON.stringify(actual)
    );
  }
}
function includes(haystack, needle, message) {
  if (String(haystack).indexOf(needle) === -1) {
    throw new Error(
      (message ? message + ": " : "") +
        "esperava encontrar " + JSON.stringify(needle) + " em " +
        JSON.stringify(String(haystack).slice(0, 400))
    );
  }
}
function notIncludes(haystack, needle, message) {
  if (String(haystack).indexOf(needle) !== -1) {
    throw new Error(
      (message ? message + ": " : "") +
        "NÃO deveria conter " + JSON.stringify(needle) + " em " +
        JSON.stringify(String(haystack).slice(0, 400))
    );
  }
}
function matches(value, re, message) {
  if (!re.test(String(value))) {
    throw new Error(
      (message ? message + ": " : "") +
        "esperava casar " + re + " em " + JSON.stringify(String(value).slice(0, 400))
    );
  }
}
function note(text) {
  if (VERBOSE) console.log("      · " + text);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Rejeições não tratadas (ex.: fetch/promises do app) não podem derrubar o
// processo nem passar batido: são coletadas e cobradas no fim da suíte.
const unhandledRejections = [];
process.on("unhandledRejection", (reason) => {
  unhandledRejections.push(reason);
});

// ------------------------------------------------------------------ scripts
const inlineScripts = [];
for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  const attrs = m[1] || "";
  if (/\bsrc\s*=/i.test(attrs)) continue;
  if (/\btype\s*=\s*["'](?:application\/(?:ld\+)?json|text\/template)["']/i.test(attrs)) continue;
  inlineScripts.push(m[2]);
}

// ------------------------------------------------------------------ DOM stub
const VOID = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(" ")
);
const SKIP_CONTENT = new Set(["script", "style", "template"]);
const TAG_RE = /<\s*(\/?)\s*([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)\s*>/g;

function parseAttrs(raw) {
  const attrs = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    attrs[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : "";
  }
  return attrs;
}

function makeDoc() {
  const byId = new Map();
  const doc = {
    nodeType: 9,
    _byId: byId,
    _env: null,
    body: null,
    head: null,
    documentElement: null,
    activeElement: null,
    getElementById(id) {
      return byId.get(String(id)) || null;
    },
    querySelector(sel) {
      return (doc.body && doc.body.querySelector(sel)) || null;
    },
    querySelectorAll(sel) {
      return doc.body ? doc.body.querySelectorAll(sel) : [];
    },
    createElement(tag) {
      return createEl(doc, tag, {});
    },
    createTextNode(text) {
      return { nodeType: 3, textContent: String(text) };
    },
    execCommand() {
      const env = doc._env;
      if (env) env.execCommands.push([].slice.call(arguments));
      return env && typeof env.execCommandImpl === "function" ? !!env.execCommandImpl() : true;
    },
    addEventListener(type, fn) {
      doc._handlers = doc._handlers || {};
      (doc._handlers[type] = doc._handlers[type] || []).push(fn);
    },
    removeEventListener() {},
    _handlers: {}
  };
  return doc;
}

function createEl(doc, tag, attrs) {
  tag = String(tag).toLowerCase();
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    localName: tag,
    ownerDocument: doc,
    parentNode: null,
    children: [],
    _attrs: {},
    _classes: new Set(),
    _html: null,
    _hidden: false,
    _disabled: false,
    _value: "",
    _text: "",
    style: {},
    dataset: {},
    handlers: {},
    onclick: null,
    focused: false,
    _listeners: 0
  };

  for (const [k, v] of Object.entries(attrs || {})) el._attrs[k] = v;
  if (el._attrs.class) {
    for (const c of el._attrs.class.split(/\s+/)) if (c) el._classes.add(c);
  }
  if (Object.prototype.hasOwnProperty.call(el._attrs, "hidden")) el._hidden = true;
  if (Object.prototype.hasOwnProperty.call(el._attrs, "disabled")) el._disabled = true;
  if (Object.prototype.hasOwnProperty.call(el._attrs, "value")) el._value = String(el._attrs.value);
  if (el._attrs.id) doc._byId.set(el._attrs.id, el);

  el.classList = {
    add(...cs) { for (const c of cs) el._classes.add(String(c)); syncClass(); },
    remove(...cs) { for (const c of cs) el._classes.delete(String(c)); syncClass(); },
    contains(c) { return el._classes.has(String(c)); },
    toggle(c, force) {
      const on = force === undefined ? !el._classes.has(String(c)) : !!force;
      if (on) el._classes.add(String(c));
      else el._classes.delete(String(c));
      syncClass();
      return on;
    }
  };
  function syncClass() {
    if (el._classes.size) el._attrs.class = [...el._classes].join(" ");
    else delete el._attrs.class;
  }

  el.setAttribute = (k, v) => {
    k = String(k).toLowerCase();
    el._attrs[k] = String(v);
    if (k === "class") {
      el._classes.clear();
      for (const c of String(v).split(/\s+/)) if (c) el._classes.add(c);
    }
    if (k === "hidden") el._hidden = true;
    if (k === "disabled") el._disabled = true;
    if (k === "value") el._value = String(v);
  };
  el.getAttribute = (k) => {
    k = String(k).toLowerCase();
    return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null;
  };
  el.hasAttribute = (k) => Object.prototype.hasOwnProperty.call(el._attrs, String(k).toLowerCase());
  el.removeAttribute = (k) => {
    k = String(k).toLowerCase();
    delete el._attrs[k];
    if (k === "class") el._classes.clear();
    if (k === "hidden") el._hidden = false;
    if (k === "disabled") el._disabled = false;
  };

  Object.defineProperty(el, "hidden", {
    enumerable: true,
    get: () => el._hidden,
    set: (v) => {
      el._hidden = !!v;
      if (el._hidden) el._attrs.hidden = "";
      else delete el._attrs.hidden;
    }
  });
  Object.defineProperty(el, "disabled", {
    enumerable: true,
    get: () => el._disabled,
    set: (v) => {
      el._disabled = !!v;
      if (el._disabled) el._attrs.disabled = "";
      else delete el._attrs.disabled;
    }
  });
  Object.defineProperty(el, "value", {
    enumerable: true,
    get: () => (el.localName === "select" ? selectValueOf(el) : el._value),
    set: (v) => {
      const str = v === null || v === undefined ? "" : String(v);
      if (el.localName === "select") markSelectedOption(el, str);
      el._value = str;
    }
  });
  Object.defineProperty(el, "id", {
    enumerable: true,
    get: () => el._attrs.id || "",
    set: (v) => { el._attrs.id = String(v); doc._byId.set(String(v), el); }
  });
  Object.defineProperty(el, "className", {
    enumerable: true,
    get: () => [...el._classes].join(" "),
    set: (v) => {
      el._classes.clear();
      for (const c of String(v).split(/\s+/)) if (c) el._classes.add(c);
      syncClass();
    }
  });
  Object.defineProperty(el, "textContent", {
    enumerable: true,
    get: () => {
      if (!el.children.length) return el._text;
      return el.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
    },
    set: (v) => {
      el._html = null;
      el.children = [];
      el._text = String(v);
    }
  });
  Object.defineProperty(el, "innerHTML", {
    enumerable: true,
    get: () => (el._html !== null ? el._html : serializeChildren(el)),
    set: (v) => {
      el._html = String(v);
      el._text = "";
      el.children = [];
      parseInto(el._html, el, doc, false);
      // innerHTML novo em <select> reseta a seleção para o markup (como o browser).
      if (el.localName === "select") el._value = "";
    }
  });

  el.appendChild = (child) => {
    if (!child) return child;
    child.parentNode = el;
    el.children.push(child);
    if (el._html !== null) el._html = serializeChildren(el);
    return child;
  };
  el.removeChild = (child) => {
    el.children = el.children.filter((c) => c !== child);
    if (child && child.parentNode === el) child.parentNode = null;
    if (el._html !== null) el._html = serializeChildren(el);
    return child;
  };
  el.insertBefore = (child, ref) => {
    child.parentNode = el;
    const idx = el.children.indexOf(ref);
    if (idx === -1) el.children.push(child);
    else el.children.splice(idx, 0, child);
    if (el._html !== null) el._html = serializeChildren(el);
    return child;
  };
  el.addEventListener = (type, fn) => {
    (el.handlers[type] = el.handlers[type] || []).push(fn);
    el._listeners++;
  };
  el.removeEventListener = (type, fn) => {
    if (!el.handlers[type]) return;
    el.handlers[type] = el.handlers[type].filter((f) => f !== fn);
  };
  el.dispatchEvent = (ev) => {
    if (ev && !ev.target) ev.target = el;
    for (const fn of el.handlers[ev.type] || []) fn(ev);
    return true;
  };
  el.click = () => {
    if (tag === "a") {
      const env = doc._env;
      if (env) {
        env.downloads.push({
          href: el.href || el.getAttribute("href") || "",
          download: el.download || el.getAttribute("download") || ""
        });
      }
    }
    const ev = { type: "click", target: el, preventDefault() {}, stopPropagation() {} };
    for (const fn of el.handlers.click || []) fn(ev);
    if (typeof el.onclick === "function") el.onclick(ev);
  };
  el.focus = () => {
    doc.activeElement = el;
    el.focused = true;
  };
  el.blur = () => {
    if (doc.activeElement === el) doc.activeElement = null;
    el.focused = false;
  };
  el.select = () => {};
  el.setSelectionRange = () => {};
  el.scrollIntoView = () => {};
  el.remove = () => {
    if (el.parentNode) el.parentNode.removeChild(el);
  };
  el.getBoundingClientRect = () => ({ top: 0, left: 0, width: 320, height: 40, bottom: 40, right: 320 });
  el.querySelectorAll = (sel) => collectMatching(el, sel);
  el.querySelector = (sel) => collectMatching(el, sel)[0] || null;
  el.getElementsByTagName = (name) => collectMatching(el, name);
  el.matches = (sel) => matchesComplex(el, sel);
  el.closest = (sel) => {
    let node = el;
    while (node) {
      if (node.nodeType === 1 && matchesComplex(node, sel)) return node;
      node = node.parentNode;
    }
    return null;
  };
  if (el._attrs.tabindex !== undefined) el.tabIndex = Number(el._attrs.tabindex);

  return el;
}

function serializeChildren(el) {
  return el.children
    .map((c) => {
      if (typeof c === "string") return c;
      if (c.nodeType === 3) return c.textContent;
      const attrs = Object.entries(c._attrs || {})
        .map(([k, v]) => " " + k + '="' + String(v).replace(/"/g, "&quot;") + '"')
        .join("");
      const tag = (c.localName || "div").toLowerCase();
      if (VOID.has(tag)) return "<" + tag + attrs + ">";
      return "<" + tag + attrs + ">" + serializeChildren(c) + "</" + tag + ">";
    })
    .join("");
}

function collectMatching(root, selector) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (typeof child === "string" || child.nodeType !== 1) continue;
      if (matchesComplex(child, selector)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

// <select> de verdade: o value segue a <option selected>, não uma variável paralela.
function optionValueOf(option) {
  const attr = option.getAttribute("value");
  return attr === null ? option.textContent.trim() : attr;
}
function selectValueOf(select) {
  const options = collectMatching(select, "option");
  if (!options.length) return "";
  const chosen = options.find((o) => o.hasAttribute("selected")) || options[0];
  return optionValueOf(chosen);
}
function markSelectedOption(select, value) {
  const options = collectMatching(select, "option");
  let matched = false;
  for (const option of options) {
    if (!matched && optionValueOf(option) === value) {
      option.setAttribute("selected", "");
      matched = true;
    } else {
      option.removeAttribute("selected");
    }
  }
  if (!matched && options.length) {
    const fallback = options.find((o) => optionValueOf(o) === "") || options[0];
    fallback.setAttribute("selected", "");
  }
}

function matchesComplex(el, selector) {
  return String(selector)
    .split(",")
    .some((part) => matchesComplexOne(el, part.trim()));
}
function matchesComplexOne(el, selector) {
  const parts = selector.replace(/\s*>\s*/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  if (!matchesCompound(el, parts[parts.length - 1])) return false;
  let node = el.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    let found = false;
    while (node) {
      if (node.nodeType === 1 && matchesCompound(node, parts[i])) {
        found = true;
        node = node.parentNode;
        break;
      }
      node = node.parentNode;
    }
    if (!found) return false;
  }
  return true;
}
function matchesCompound(el, selector) {
  const m = selector.match(/^([a-zA-Z][\w-]*|\*)?((?:[.#][\w-]+)*)((?:\[[^\]]*\])*)$/);
  if (!m) return false;
  if (m[1] && m[1] !== "*" && el.localName !== m[1].toLowerCase()) return false;
  const classAndId = m[2] || "";
  for (const cls of classAndId.match(/\.[\w-]+/g) || []) {
    if (!el._classes.has(cls.slice(1))) return false;
  }
  const idMatch = classAndId.match(/#([\w-]+)/);
  if (idMatch && el.getAttribute("id") !== idMatch[1]) return false;
  for (const attrSel of m[3].match(/\[[^\]]*\]/g) || []) {
    const am = attrSel.match(/^\[\s*([\w:-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]$/);
    if (!am) return false;
    const name = am[1];
    const want = am[2] !== undefined ? am[2] : am[3] !== undefined ? am[3] : am[4];
    if (!Object.prototype.hasOwnProperty.call(el._attrs, name)) return false;
    if (want !== undefined && el._attrs[name] !== want) return false;
  }
  return true;
}

function parseInto(markup, parent, doc, registerIds) {
  const src = String(markup)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const root = parent;
  let last = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(src))) {
    const text = src.slice(last, m.index);
    if (text) parent.children.push(text);
    last = TAG_RE.lastIndex;
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (closing) {
      // Volta um nível; fechamentos órfãos (fragmento sem o pai) são ignorados.
      if (parent !== root) parent = parent.parentNode || root;
      continue;
    }
    if (SKIP_CONTENT.has(tag)) {
      const end = src.toLowerCase().indexOf("</" + tag, TAG_RE.lastIndex);
      if (end === -1) break;
      TAG_RE.lastIndex = src.indexOf(">", end) + 1;
      last = TAG_RE.lastIndex;
      continue;
    }
    const el = createEl(doc, tag, parseAttrs(m[3] || ""));
    if (!registerIds) doc._byId.delete(el.getAttribute("id"));
    el.parentNode = parent;
    parent.children.push(el);
    if (!VOID.has(tag) && m[4] !== "/") parent = el;
  }
  const tail = src.slice(last);
  if (tail) parent.children.push(tail);
  return parent;
}

function buildDocument() {
  const doc = makeDoc();
  const bodyMarkup = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [])[1] || "";
  const body = createEl(doc, "body", {});
  body.nodeType = 1;
  doc.body = body;
  doc.documentElement = createEl(doc, "html", { lang: "pt-BR" });
  doc.documentElement.children = [body];
  body.parentNode = doc.documentElement;
  const headMarkup = (html.match(/<head[^>]*>([\s\S]*?)<\/head>/i) || [])[1] || "";
  const head = createEl(doc, "head", {});
  doc.head = head;
  parseInto(bodyMarkup.replace(/<script\b[\s\S]*?<\/script>/gi, ""), body, doc, true);
  parseInto(headMarkup.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ""), head, doc, false);
  return doc;
}

// ------------------------------------------------------------- Response stub
class ResponseStub {
  constructor(body, init) {
    init = init || {};
    this._body = body === undefined ? null : body;
    this.status = init.status === undefined ? 200 : init.status;
    this.ok = this.status >= 200 && this.status < 300;
    this.type = init.type || "basic";
    this.url = init.url || "";
    this.headers = {
      get: (name) => {
        const h = init.headers || {};
        const key = Object.keys(h).find((k) => k.toLowerCase() === String(name).toLowerCase());
        return key ? h[key] : null;
      }
    };
  }
  clone() {
    return new ResponseStub(this._body, { status: this.status, type: this.type, url: this.url });
  }
  async text() {
    return this._body === null ? "" : String(this._body);
  }
  async json() {
    return JSON.parse(String(this._body));
  }
  static error() {
    const r = new ResponseStub(null, { status: 0, type: "error" });
    r.ok = false;
    return r;
  }
}

function asResponseStub(value) {
  if (value instanceof ResponseStub) return value;
  if (value && typeof value === "object" && "status" in value && ("_body" in value || "body" in value)) {
    return new ResponseStub(value.body !== undefined ? value.body : value._body, value);
  }
  return new ResponseStub(value);
}

// -------------------------------------------------------------------- sandbox
function resolveFlow(spec, value, label) {
  if (typeof spec === "function") {
    return Promise.resolve().then(() => spec(value));
  }
  if (spec === "reject") return Promise.reject(new Error(label + " rejeitado (stub)"));
  if (spec === "abort") {
    const err = new Error("cancelado pelo usuário");
    err.name = "AbortError";
    return Promise.reject(err);
  }
  return Promise.resolve();
}

function boot(opts) {
  opts = opts || {};
  const {
    storage = {},
    getThrows = false,
    setThrows = false,
    removeThrows = false,
    protocol = "https:",
    search = "",
    hash = "",
    pathname = "/repo/index.html",
    origin = "https://example.com",
    withSW = true,
    swController = true,
    swWaiting = null,
    onLine = true,
    share,
    clipboard,
    execCommand,
    fetchImpl,
    fetchAvailable = true,
    language = "pt-BR"
  } = opts;

  const doc = buildDocument();

  // localStorage com injeção de falha
  const storageMap = new Map(Object.entries(storage));
  const localStorage = {
    getItem(k) {
      if (getThrows) throw new Error("SecurityError: localStorage bloqueado");
      return storageMap.has(String(k)) ? storageMap.get(String(k)) : null;
    },
    setItem(k, v) {
      if (setThrows) throw new Error("QuotaExceededError: localStorage cheio");
      storageMap.set(String(k), String(v));
    },
    removeItem(k) {
      if (removeThrows) throw new Error("SecurityError: localStorage bloqueado");
      storageMap.delete(String(k));
    },
    clear() {
      storageMap.clear();
    },
    key(i) {
      const keys = [...storageMap.keys()];
      return i >= 0 && i < keys.length ? keys[i] : null;
    },
    get length() {
      return storageMap.size;
    }
  };

  // location + history
  const isFile = protocol === "file:";
  const reloads = [];
  const href = isFile
    ? "file:///F:/abastece-certo/index.html"
    : origin + pathname + search + hash;
  const location = {
    protocol,
    origin: isFile ? "null" : origin,
    pathname,
    search,
    hash,
    href,
    reload() {
      reloads.push({ at: Date.now() });
    },
    assign(url) {
      applyUrl(url);
    },
    replace(url) {
      applyUrl(url);
    }
  };
  const historyCalls = [];
  const history = {
    replaceState(state, title, url) {
      historyCalls.push({ op: "replace", state, title, url: String(url) });
      applyUrl(url);
    },
    pushState(state, title, url) {
      historyCalls.push({ op: "push", state, title, url: String(url) });
      applyUrl(url);
    }
  };
  function applyUrl(url) {
    if (url === undefined || url === null) return;
    url = String(url);
    try {
      if (url.charAt(0) === "#") {
        location.hash = url;
        location.href = location.pathname + location.search + location.hash;
        return;
      }
      if (url.charAt(0) === "?") {
        location.search = url;
        location.href = location.pathname + location.search + location.hash;
        return;
      }
      const next = new URL(url, location.href);
      location.protocol = next.protocol;
      location.origin = next.origin;
      location.pathname = next.pathname;
      location.search = next.search;
      location.hash = next.hash;
      location.href = next.href;
    } catch (e) {
      /* URL inválida no stub: ignora */
    }
  }

  // URL com createObjectURL (download de CSV no v3)
  const objectUrls = new Map();
  let blobSeq = 0;
  const URLCtor = function (url, base) {
    return base === undefined ? new URL(url) : new URL(url, base);
  };
  URLCtor.createObjectURL = (blob) => {
    const id = "blob:abastece-certo/" + ++blobSeq;
    objectUrls.set(id, blob);
    return id;
  };
  URLCtor.revokeObjectURL = (id) => {
    objectUrls.delete(id);
  };

  // fetch stub
  const fetchCalls = [];
  const fetchStub = (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    fetchCalls.push({ url, init: init || null });
    if (typeof fetchImpl !== "function") {
      return Promise.reject(new TypeError("Failed to fetch (stub offline)"));
    }
    return Promise.resolve()
      .then(() => fetchImpl(url, init))
      .then((value) => asResponseStub(value));
  };

  // eventos
  const winHandlers = {};
  const docHandlers = doc._handlers;
  const swHandlers = {};
  const regHandlers = {};
  const postedToSW = [];
  const registerCalls = [];
  const shareCalls = [];
  const clipboardTexts = [];
  const execCommands = [];
  const downloads = [];

  const reg = {
    waiting: swWaiting,
    installing: null,
    active: {},
    _handlers: regHandlers,
    addEventListener(type, fn) {
      (regHandlers[type] = regHandlers[type] || []).push(fn);
    }
  };

  const navigator = {
    onLine,
    language,
    languages: [language],
    userAgent: "node-vm-qa",
    platform: "node"
  };
  if (withSW) {
    navigator.serviceWorker = {
      controller: swController ? { state: "activated" } : null,
      register(url) {
        registerCalls.push(String(url));
        return Promise.resolve(reg);
      },
      addEventListener(type, fn) {
        (swHandlers[type] = swHandlers[type] || []).push(fn);
      },
      ready: Promise.resolve(reg),
      _handlers: swHandlers
    };
  }
  if (share !== undefined) {
    navigator.share = (data) => {
      shareCalls.push(data || {});
      return resolveFlow(share, data, "share");
    };
  }
  if (clipboard !== undefined) {
    navigator.clipboard = {
      writeText(text) {
        clipboardTexts.push(String(text));
        return resolveFlow(clipboard, text, "clipboard");
      }
    };
  }

  const window = {
    location,
    navigator,
    history,
    document: doc,
    addEventListener(type, fn) {
      (winHandlers[type] = winHandlers[type] || []).push(fn);
    },
    removeEventListener() {},
    matchMedia() {
      return { matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
    },
    scrollTo() {},
    _handlers: winHandlers
  };

  const execCommandImpl =
    typeof execCommand === "function"
      ? execCommand
      : execCommand === false
        ? () => false
        : () => true;

  const sandbox = {
    document: doc,
    window,
    navigator,
    location,
    history,
    localStorage,
    fetch: fetchAvailable ? fetchStub : undefined,
    Response: ResponseStub,
    URL: URLCtor,
    URLSearchParams,
    Blob: typeof Blob !== "undefined" ? Blob : undefined,
    AbortController: typeof AbortController !== "undefined" ? AbortController : undefined,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    Intl,
    crypto: {
      randomUUID() {
        return "00000000-0000-4000-8000-" + String(++blobSeq).padStart(12, "0");
      }
    },
    performance: { now: () => Date.now() },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id)
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const env = {
    document: doc,
    window,
    navigator,
    location,
    history,
    localStorage,
    sandbox,
    storage: storageMap,
    reloads,
    registerCalls,
    historyCalls,
    shareCalls,
    clipboardTexts,
    execCommands,
    downloads,
    objectUrls,
    fetchCalls,
    postedToSW,
    reg,
    execCommandImpl
  };
  doc._env = env;

  vm.createContext(sandbox);
  for (const [index, code] of inlineScripts.entries()) {
    vm.runInContext(code, sandbox, { filename: "index.html#inline-" + index });
  }

  // helpers de interação -----------------------------------------------------
  env.$ = (id) => doc.getElementById(id);
  env.fire = (target, type, ev) => {
    if (!target) throw new Error("fire(): elemento nulo para " + type);
    const event = ev || {};
    if (!event.target) event.target = target;
    if (!event.preventDefault) event.preventDefault = () => {};
    if (!event.stopPropagation) event.stopPropagation = () => {};
    let ran = 0;
    for (const fn of (target.handlers && target.handlers[type]) || []) {
      fn(event);
      ran++;
    }
    return ran;
  };
  env.fireWindow = (type, ev) => {
    let ran = 0;
    for (const fn of winHandlers[type] || []) {
      fn(ev || {});
      ran++;
    }
    return ran;
  };
  env.fireDocument = (type, ev) => {
    let ran = 0;
    for (const fn of docHandlers[type] || []) {
      fn(ev || {});
      ran++;
    }
    return ran;
  };
  env.fireSW = (type, ev) => {
    let ran = 0;
    for (const fn of swHandlers[type] || []) {
      fn(ev || {});
      ran++;
    }
    return ran;
  };
  env.fireReg = (type, ev) => {
    let ran = 0;
    for (const fn of regHandlers[type] || []) {
      fn(ev || {});
      ran++;
    }
    return ran;
  };
  env.input = (id, value) => {
    const el = doc.getElementById(id);
    if (!el) throw new Error("input(): elemento #" + id + " não existe");
    el.value = value;
    env.fire(el, "input");
  };
  env.keydown = (id, key) => {
    const el = doc.getElementById(id);
    const ev = {
      key,
      target: el,
      prevented: false,
      preventDefault() {
        ev.prevented = true;
      }
    };
    env.fire(el, "keydown", ev);
    return ev;
  };
  env.clickDelegated = (containerId, selector) => {
    const container = doc.getElementById(containerId);
    if (!container) throw new Error("clickDelegated(): #" + containerId + " não existe");
    const target = container.querySelector(selector);
    if (!target) throw new Error("clickDelegated(): " + selector + " não encontrado dentro de #" + containerId);
    env.fire(container, "click", { target });
    return target;
  };
  env.storageKey = () => {
    for (const key of storageMap.keys()) {
      if (/^ac\.v\d+$/.test(key)) return key;
    }
    return null;
  };
  env.saved = () => {
    const key = env.storageKey();
    if (!key) return null;
    try {
      return JSON.parse(storageMap.get(key));
    } catch (e) {
      return null;
    }
  };
  env.rendered = () => {
    const el = doc.getElementById("resultOut");
    return el ? el.innerHTML : "";
  };
  env.html = (id) => {
    const el = doc.getElementById(id);
    return el ? el.innerHTML : "";
  };
  env.text = (id) => {
    const el = doc.getElementById(id);
    return el ? el.textContent : "";
  };
  env.wait = (ms) => sleep(ms);
  env.flush = async () => {
    await sleep(0);
    await sleep(0);
  };
  env.downloadText = async (index) => {
    index = index || 0;
    const download = downloads[index];
    if (!download) throw new Error("nenhum download capturado (índice " + index + ")");
    const blob = objectUrls.get(download.href);
    if (!blob) return "";
    return typeof blob.text === "function" ? await blob.text() : String(blob);
  };
  env.downloadBytes = async (index) => {
    const download = downloads[index || 0];
    if (!download) throw new Error("nenhum download capturado (índice " + (index || 0) + ")");
    const blob = objectUrls.get(download.href);
    if (!blob || typeof blob.arrayBuffer !== "function") return new Uint8Array();
    return new Uint8Array(await blob.arrayBuffer());
  };
  return env;
}

function bootWith(env, extra) {
  return boot(Object.assign({ storage: Object.fromEntries(env.storage) }, extra || {}));
}
function storageOf(env) {
  return Object.fromEntries(env.storage);
}

// ==========================================================================
// A. Carga inicial e estado vazio
// ==========================================================================
test("init: app real executa e mostra o estado vazio do modo rápido", () => {
  const env = boot();
  const out = env.rendered();
  includes(out, "Informe os dois preços");
  eq(env.text("thresholdVal"), "72%", "limite padrão visível");
});

test("init: sem storage usa limite 72% no slider, rótulo e aria-valuetext", () => {
  const env = boot();
  eq(env.$("threshold").value, "72", "slider");
  eq(env.text("thresholdVal"), "72%", "rótulo");
  eq(env.$("threshold").getAttribute("aria-valuetext"), "72% do preço da gasolina", "aria-valuetext");
});

test("init: aba Rápido selecionada, painel Preciso oculto (ARIA/tabindex)", () => {
  const env = boot();
  eq(env.$("tab-fast").getAttribute("aria-selected"), "true", "tab-fast selecionada");
  eq(env.$("tab-precise").getAttribute("aria-selected"), "false", "tab-precise não selecionada");
  eq(env.$("tab-fast").getAttribute("tabindex"), "0", "roving tabindex da aba ativa");
  eq(env.$("tab-precise").getAttribute("tabindex"), "-1", "roving tabindex da aba inativa");
  eq(env.$("panel-fast").hidden, false, "painel rápido visível");
  eq(env.$("panel-precise").hidden, true, "painel preciso oculto");
});

test("init: presets 72/71/70 com aria-pressed e classe active coerentes", () => {
  const env = boot();
  const buttons = env.$("presets").querySelectorAll("button[data-t]");
  eq(buttons.length, 3, "quantidade de presets fixos");
  eq(buttons[0].getAttribute("data-t"), "72");
  eq(buttons[0].getAttribute("aria-pressed"), "true", "preset 72 pressionado");
  eq(buttons[1].getAttribute("aria-pressed"), "false", "preset 71 não pressionado");
  eq(buttons[2].getAttribute("aria-pressed"), "false", "preset 70 não pressionado");
  ok(buttons[0].classList.contains("active"), "classe active no preset aplicado");
});

test("init: estado inicial é persistido no storage", () => {
  const env = boot();
  const key = env.storageKey();
  ok(key, "nenhuma chave ac.vN foi gravada");
  note("chave de storage: " + key);
  const saved = env.saved();
  eq(saved.threshold, 72, "threshold salvo");
  eq(saved.mode, "fast", "mode salvo");
  eq(Array.isArray(saved.vehicles) && saved.vehicles.length, 0, "veículos salvos");
});

test("init: sem chaves da v1 não há aviso de migração", () => {
  const env = boot();
  eq(env.text("toast"), "", "toast inicial");
});

// ==========================================================================
// B. Cálculo pela UI (regressões da v2 que o core puro não vê)
// ==========================================================================
test("cálculo rápido: 5,89/3,99 → ETANOL, índice 67,7% e 4,3 p.p. abaixo", () => {
  const env = boot();
  env.input("gas", "5,89");
  env.input("eta", "3,99");
  const out = env.rendered();
  includes(out, "67,7", "índice");
  includes(out, "Abasteça com ETANOL", "veredito");
  includes(out, "4,3 p.p. abaixo do limite", "distância ao limite");
  includes(out, "dot-ratio green", "ponto verde");
  notIncludes(out, "NaN", "sem NaN");
  notIncludes(out, "Infinity", "sem Infinity");
});

test("cálculo rápido: empate técnico nunca diz acima/abaixo do limite", () => {
  const env = boot();
  env.input("threshold", "70");
  env.input("gas", "5,00");
  env.input("eta", "3,51");
  const out = env.rendered();
  includes(out, "Empate técnico", "veredito");
  includes(out, "dentro da margem", "texto de margem");
  notIncludes(out, "acima do limite", "contradição acima");
  notIncludes(out, "abaixo do limite", "contradição abaixo");
  includes(out, "dot-ratio amber", "ponto âmbar");
});

test("cálculo rápido: preço com ponto e 3 casas não vira milhar ('5.899')", () => {
  const env = boot();
  env.input("gas", "5.899");
  env.input("eta", "4,099");
  const out = env.rendered();
  notIncludes(out, "5.899,00", "preço interpretado como milhar");
  includes(out, "69,5", "índice coerente com 4,099/5,899");
  note("resultado: " + out.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160));
});

test("cálculo rápido: entradas extremas não colocam NaN/Infinity no DOM", () => {
  const env = boot();
  env.input("gas", "0," + "0".repeat(60) + "5");
  env.input("eta", "5");
  const out = env.rendered();
  notIncludes(out, "NaN", "NaN no DOM");
  notIncludes(out, "Infinity", "Infinity no DOM");
  notIncludes(out, "undefined", "undefined no DOM");
});

test("máscara de preço: só dígitos, com zeros automáticos", () => {
  const env = boot();
  const gas = env.$("gas");
  env.input("gas", "6");
  eq(gas.value, "6,00", "6 → 6,00");
  env.input("gas", "65");
  eq(gas.value, "65,00", "65 → 65,00 (transitório)");
  env.input("gas", "654");
  eq(gas.value, "6,54", "654 → 6,54");
  env.input("gas", "456");
  eq(gas.value, "4,56", "456 → 4,56");
  env.input("gas", "1050");
  eq(gas.value, "10,50", "1050 → 10,50");
  env.input("gas", "123456");
  eq(gas.value, "34,56", "máximo 4 dígitos (mantém os últimos)");
  env.input("gas", "abc");
  eq(gas.value, "", "letras são descartadas");
  env.input("gas", "0");
  eq(gas.value, "0,00", "0 → 0,00");
});

test("máscara de preço: valor formatado alimenta o cálculo", () => {
  const env = boot();
  env.input("gas", "654");
  env.input("eta", "414");
  const out = env.rendered();
  includes(out, "63,3", "índice com 6,54 / 4,14");
  includes(out, "ETANOL", "veredito");
});

test("máscara de preço: campo declara teclado numérico e ajuda visível", () => {
  const env = boot();
  eq(env.$("gas").getAttribute("inputmode"), "numeric");
  eq(env.$("eta").getAttribute("inputmode"), "numeric");
  includes(env.$("gas").getAttribute("aria-describedby") || "", "priceHelp");
});

test("cálculo rápido: preço zero é rejeitado com dica e sem resultado", () => {
  const env = boot();
  env.input("gas", "0");
  env.input("eta", "3,99");
  eq(env.$("gas").value, "0,00", "máscara normaliza o zero");
  eq(env.$("gas").getAttribute("aria-invalid"), "true", "aria-invalid no preço zero");
  includes(env.text("gasHint"), "Valor inválido", "dica textual");
  includes(env.rendered(), "Informe os dois preços", "volta ao estado vazio");
});

test("cálculo preciso: custo por 100 km, limite pessoal e economia", () => {
  const env = boot();
  env.fire(env.$("tab-precise"), "click");
  env.input("gas", "6,54");
  env.input("eta", "4,14");
  env.input("gasKmL", "12,0");
  env.input("etaKmL", "8,6");
  const out = env.rendered();
  includes(out, "R$ 6,36", "economia por 100 km");
  includes(out, "R$ 54,50", "custo gasolina/100 km");
  includes(out, "R$ 48,14", "custo etanol/100 km");
  includes(out, "71,7%", "limite pessoal");
  notIncludes(out, "NaN", "sem NaN");
});

test("modo preciso: consumo inválido marca aria-invalid e mantém estado vazio", () => {
  const env = boot();
  env.fire(env.$("tab-precise"), "click");
  env.input("gas", "6,54");
  env.input("eta", "4,14");
  env.input("gasKmL", "0");
  env.input("etaKmL", "8,6");
  eq(env.$("gasKmL").getAttribute("aria-invalid"), "true", "aria-invalid no consumo");
  includes(env.text("gasKmLHint"), "Valor inválido", "dica do consumo");
  includes(env.rendered(), "consumo do seu carro", "estado vazio do modo preciso");
});

test("modo preciso: alternar abas atualiza ARIA, painéis e persiste o modo", () => {
  const env = boot();
  env.fire(env.$("tab-precise"), "click");
  eq(env.$("tab-precise").getAttribute("aria-selected"), "true");
  eq(env.$("panel-precise").hidden, false);
  eq(env.$("panel-fast").hidden, true);
  eq(env.saved().mode, "precise", "modo persistido");
  env.fire(env.$("tab-fast"), "click");
  eq(env.$("tab-fast").getAttribute("aria-selected"), "true");
  eq(env.saved().mode, "fast", "modo rápido persistido");
});

test("modo preciso: preset 'seu carro' aplica exatamente o valor que exibe", () => {
  const env = boot();
  env.fire(env.$("tab-precise"), "click");
  env.input("gasKmL", "12,0");
  env.input("etaKmL", "8,6");
  const car = env.$("presetCar");
  eq(car.hidden, false, "preset do carro visível");
  const label = car.innerHTML.replace(/<[^>]+>/g, "");
  const labelPct = ((label.match(/([\d.,]+)\s*%/) || [])[0] || "").replace(/\s+/g, "");
  const shown = Number((label.match(/([\d.,]+)\s*%/) || [])[1].replace(".", "").replace(",", "."));
  const applied = Number(car.getAttribute("data-t"));
  note("rótulo=" + label + " data-t=" + applied);
  ok(isFinite(shown) && isFinite(applied), "rótulo/data-t numéricos");
  eq(applied, shown, "data-t deve ser o mesmo número exibido no rótulo");
  env.clickDelegated("presets", "#presetCar");
  eq(env.$("threshold").value, String(applied), "slider recebe o valor aplicado");
  eq(env.text("thresholdVal"), labelPct, "rótulo do limite após aplicar");
  eq(env.saved().threshold, applied, "limite persistido");
});

test("modo preciso: preset 'seu carro' oculto quando o limite pessoal é implausível", () => {
  const env = boot();
  env.fire(env.$("tab-precise"), "click");
  env.input("gasKmL", "12");
  env.input("etaKmL", "11");
  eq(env.$("presetCar").hidden, true, "preset escondido (91,7% fora da escala)");
});

test("modo preciso: salvar veículo persiste e atualiza o <select> (sem duplicar)", () => {
  const env = boot();
  env.fire(env.$("tab-precise"), "click");
  env.input("gasKmL", "12,0");
  env.input("etaKmL", "8,6");
  env.input("vehName", "Onix");
  env.$("vehSave").click();
  const saved = env.saved();
  eq(saved.vehicles.length, 1, "1 veículo salvo");
  eq(saved.vehicles[0].name, "Onix", "nome");
  eq(saved.activeId, saved.vehicles[0].id, "activeId");
  includes(env.text("toast"), "Veículo salvo", "toast de confirmação");
  includes(env.html("vehicleSelect"), "Onix", "opção no select");
  // salvar de novo com o mesmo veículo ativo atualiza, não duplica
  env.input("vehName", "Onix 2");
  env.$("vehSave").click();
  eq(env.saved().vehicles.length, 1, "não duplica veículo ativo");
  eq(env.saved().vehicles[0].name, "Onix 2", "nome atualizado");
});

test("modo preciso: excluir veículo limpa select, storage e desabilita Excluir", () => {
  const env = boot();
  env.fire(env.$("tab-precise"), "click");
  env.input("gasKmL", "12,0");
  env.input("etaKmL", "8,6");
  env.input("vehName", "Onix");
  env.$("vehSave").click();
  const id = env.saved().vehicles[0].id;
  eq(env.$("vehDelete").disabled, false, "Excluir habilitado com veículo ativo");
  env.$("vehicleSelect").value = id;
  env.fire(env.$("vehicleSelect"), "change");
  env.$("vehDelete").click();
  eq(env.saved().vehicles.length, 0, "veículo removido do storage");
  eq(env.saved().activeId, null, "activeId limpo");
  eq(env.$("vehDelete").disabled, true, "Excluir desabilitado");
  includes(env.text("toast"), "Veículo excluído", "toast");
});

test("modo preciso: veículo salvo é reaplicado após reload", () => {
  const env = boot();
  env.fire(env.$("tab-precise"), "click");
  env.input("gasKmL", "12,0");
  env.input("etaKmL", "8,6");
  env.input("vehName", "Onix");
  env.$("vehSave").click();
  const env2 = boot({ storage: storageOf(env) });
  eq(env2.$("tab-precise").getAttribute("aria-selected"), "true", "modo preciso restaurado");
  eq(env2.$("gasKmL").value, "12", "consumo com gasolina restaurado");
  eq(env2.$("etaKmL").value, "8,6", "consumo com etanol restaurado");
  eq(env2.$("vehName").value, "Onix", "nome restaurado");
  eq(env2.$("presetCar").hidden, false, "preset do carro restaurado");
});

// ==========================================================================
// C. Migração v1 → v2/v3
// ==========================================================================
test("migração v1: preços salvos são importados sem perder o limite personalizado", () => {
  const env = boot({ storage: { ac_gas: "5,89", ac_eta: "3,99", ac_threshold: "73.5" } });
  eq(env.$("gas").value, "5,89", "preço gasolina");
  eq(env.$("eta").value, "3,99", "preço etanol");
  eq(env.$("threshold").value, "73.5", "limite personalizado preservado");
  const saved = env.saved();
  eq(saved.threshold, 73.5, "limite no storage novo");
  includes(env.$("gas").value + "|" + env.$("eta").value, "5,89|3,99");
  eq(env.text("toast"), "", "limite preservado NÃO gera o aviso de atualização para 72%");
});

test("migração v1: limite 72 explícito também não gera aviso", () => {
  const env = boot({ storage: { ac_gas: "5,89", ac_eta: "3,99", ac_threshold: "72" } });
  eq(env.$("threshold").value, "72", "limite 72 preservado");
  eq(env.text("toast"), "", "sem aviso quando o valor já era 72");
});

test("migração v1: limite padrão 70 vira 72 (E32) e o usuário é avisado", () => {
  const env = boot({ storage: { ac_gas: "5,89", ac_eta: "3,99", ac_threshold: "70" } });
  eq(env.$("threshold").value, "72", "limite migrado para 72");
  eq(env.saved().threshold, 72, "storage com 72");
  includes(env.text("toast"), "Limite atualizado para 72%", "aviso de migração exibido");
});

test("migração v1: não sobrescreve dados existentes da v2/v3", () => {
  const existing = JSON.stringify({ mode: "fast", threshold: 73, gas: "6,00", eta: "4,00", vehicles: [], activeId: null });
  const env = boot({ storage: { "ac.v2": existing, ac_gas: "1,00", ac_eta: "2,00", ac_threshold: "70" } });
  eq(env.$("gas").value, "6,00", "preço da v2 preservado");
  eq(env.$("threshold").value, "73", "limite da v2 preservado");
  eq(env.text("toast"), "", "sem aviso quando já havia estado v2");
});

test("migração v1: chave de limite inválida cai no padrão 72", () => {
  const env = boot({ storage: { ac_gas: "5,89", ac_eta: "3,99", ac_threshold: "abc" } });
  eq(env.$("threshold").value, "72", "limite inválido da v1 → 72");
});

// ==========================================================================
// D. Storage corrompido / bloqueado
// ==========================================================================
test("storage: JSON inválido não quebra o app e cai nos padrões", () => {
  const env = boot({ storage: { "ac.v2": "{isso não é json" } });
  eq(env.$("threshold").value, "72", "limite padrão");
  eq(env.rendered().includes("Informe os dois preços"), true, "estado vazio renderizado");
});

test("storage: threshold corrompido cai no default 72 (nunca em 55)", () => {
  for (const raw of [
    '{"threshold":null}',
    '{"threshold":""}',
    '{"threshold":"abc"}',
    '{"threshold":100}',
    '{"threshold":54}',
    '{"threshold":-1}'
  ]) {
    const env = boot({ storage: { "ac.v2": raw } });
    eq(env.$("threshold").value, "72", "threshold " + raw);
  }
});

test("storage: threshold válido é restaurado", () => {
  const env = boot({ storage: { "ac.v2": '{"threshold":73.5}' } });
  eq(env.$("threshold").value, "73.5", "limite válido");
  eq(env.saved().threshold, 73.5);
});

test("storage: veículos inválidos são descartados na carga", () => {
  const data = {
    mode: "fast",
    threshold: 72,
    vehicles: [
      null,
      {},
      { id: "a", gasKmL: 0.1, etaKmL: 8 },        // consumo abaixo do mínimo
      { id: 5, gasKmL: 12, etaKmL: 8.6 },          // id não é string
      { name: "sem id", gasKmL: 12, etaKmL: 8.6 },
      { id: "ok", name: "Válido", gasKmL: 12, etaKmL: 8.6 }
    ],
    activeId: "ok"
  };
  const env = boot({ storage: { "ac.v2": JSON.stringify(data) } });
  const saved = env.saved();
  eq(saved.vehicles.length, 1, "apenas o veículo válido permanece");
  eq(saved.vehicles[0].id, "ok");
  includes(env.html("vehicleSelect"), "Válido");
});

test("storage: activeId órfão é ignorado", () => {
  const data = {
    vehicles: [{ id: "v1", name: "A", gasKmL: 12, etaKmL: 8.6 }],
    activeId: "fantasma"
  };
  const env = boot({ storage: { "ac.v2": JSON.stringify(data) } });
  eq(env.saved().activeId, null, "activeId órfão limpo");
});

test("storage: limite de 20 veículos é respeitado", () => {
  const vehicles = [];
  for (let i = 0; i < 25; i++) vehicles.push({ id: "v" + i, name: "Carro " + i, gasKmL: 12, etaKmL: 8.6 });
  const env = boot({ storage: { "ac.v2": JSON.stringify({ vehicles, activeId: null }) } });
  eq(env.saved().vehicles.length, 20, "corta em 20 veículos");
  eq(env.$("vehicleSelect").querySelectorAll("option").length, 21, "20 opções + placeholder");
});

test("storage: campos com tipo errado são ignorados (gas/eta não-string)", () => {
  const env = boot({ storage: { "ac.v2": JSON.stringify({ gas: 5.89, eta: 3.99, threshold: 72 }) } });
  eq(env.$("gas").value, "", "gas numérico não é usado como texto");
  eq(env.$("eta").value, "", "eta numérico não é usado como texto");
});

test("storage bloqueado (leitura e escrita): cálculo continua funcionando", () => {
  const env = boot({ getThrows: true, setThrows: true });
  env.input("gas", "5,89");
  env.input("eta", "3,99");
  includes(env.rendered(), "Abasteça com ETANOL", "veredito calculado sem storage");
});

test("storage bloqueado só na escrita: app não quebra ao digitar/salvar", () => {
  const env = boot({ setThrows: true });
  env.input("gas", "5,89");
  env.input("eta", "3,99");
  includes(env.rendered(), "67,7", "cálculo");
  env.$("tab-precise").click();
  env.input("gasKmL", "12");
  env.input("etaKmL", "8.6");
  env.$("vehSave").click();
  eq(env.storage.size, 0, "nada foi gravado (mas sem exceção)");
});

// ==========================================================================
// E. XSS / injeção de HTML
// ==========================================================================
test("xss: nome de veículo salvo é escapado no <select>", () => {
  const payload = '<img src=x onerror=alert(1)>';
  const data = {
    vehicles: [{ id: "v1", name: payload, gasKmL: 12, etaKmL: 8.6 }],
    activeId: "v1"
  };
  const env = boot({ storage: { "ac.v2": JSON.stringify(data) } });
  const sel = env.html("vehicleSelect");
  notIncludes(sel, "<img", "HTML injetado no select");
  includes(sel, "&lt;img", "escape HTML do nome");
});

test("xss: id de veículo adulterado também é escapado", () => {
  const payload = '"><img src=x onerror=alert(1)>';
  const data = {
    vehicles: [{ id: payload, name: "ok", gasKmL: 12, etaKmL: 8.6 }],
    activeId: payload
  };
  const env = boot({ storage: { "ac.v2": JSON.stringify(data) } });
  const sel = env.html("vehicleSelect");
  notIncludes(sel, "<img", "HTML injetado pelo id");
  includes(sel, "&lt;img", "id escapado");
});

test("xss: nome digitado com <svg> não injeta no select nem no resultado", () => {
  const payload = '"><svg onload=alert(1)>';
  const env = boot();
  env.$("tab-precise").click();
  env.input("gas", "6,54");
  env.input("eta", "4,14");
  env.input("gasKmL", "12,0");
  env.input("etaKmL", "8,6");
  env.input("vehName", payload);
  env.$("vehSave").click();
  const sel = env.html("vehicleSelect");
  notIncludes(sel, "<svg", "svg injetado no select");
  includes(sel, "&lt;svg", "escape no select");
  notIncludes(env.rendered(), "<svg onload", "payload injetado no resultado");
});

test("xss: nome do veículo é trimado e limitado a 30 caracteres", () => {
  const env = boot();
  env.$("tab-precise").click();
  env.input("gasKmL", "12");
  env.input("etaKmL", "8.6");
  env.input("vehName", "  " + "A".repeat(40) + "  ");
  env.$("vehSave").click();
  const saved = env.saved();
  eq(saved.vehicles[0].name.length, 30, "limite de 30 caracteres");
  eq(saved.vehicles[0].name, "A".repeat(30), "trim + slice");
});

test("xss: veículo sem nome usa rótulo padrão 'Meu carro'", () => {
  const env = boot();
  env.$("tab-precise").click();
  env.input("gasKmL", "12");
  env.input("etaKmL", "8.6");
  env.input("vehName", "   ");
  env.$("vehSave").click();
  eq(env.saved().vehicles[0].name, "Meu carro", "nome padrão");
});

// ==========================================================================
// F. Atalho ?modo= + limpeza da URL
// ==========================================================================
test("?modo=preciso: abre no modo Preciso", () => {
  const env = boot({ search: "?modo=preciso" });
  eq(env.$("tab-precise").getAttribute("aria-selected"), "true", "modo preciso ativo");
  eq(env.$("panel-precise").hidden, false, "painel preciso visível");
});

test("?modo=preciso: remove o parâmetro da URL via history.replaceState", () => {
  const env = boot({ search: "?modo=preciso" });
  eq(env.historyCalls.length, 1, "uma chamada de replaceState");
  eq(env.historyCalls[0].op, "replace");
  notIncludes(env.historyCalls[0].url, "modo=", "URL limpa");
  eq(env.location.search, "", "location.search limpo");
});

test("?modo=preciso: preserva outros parâmetros e o hash ao limpar a URL", () => {
  const env = boot({ search: "?utm=x&modo=preciso", hash: "#topo" });
  includes(env.historyCalls[0].url, "utm=x", "mantém utm");
  notIncludes(env.historyCalls[0].url, "modo=", "remove modo");
  includes(env.historyCalls[0].url, "#topo", "mantém hash");
});

test("?modo=rapido: abre no modo Rápido", () => {
  const env = boot({ search: "?modo=rapido" });
  eq(env.$("tab-fast").getAttribute("aria-selected"), "true");
  notIncludes(env.historyCalls[0].url, "modo=");
});

test("?modo=desconhecido: ignorado e a URL permanece intacta", () => {
  const env = boot({ search: "?modo=banana" });
  eq(env.historyCalls.length, 0, "não limpa URL de parâmetro desconhecido");
  eq(env.$("tab-fast").getAttribute("aria-selected"), "true", "mantém modo rápido");
});

test("?modo=: a escolha feita depois é a que vale no reload (URL limpa)", () => {
  const env1 = boot({ search: "?modo=preciso" });
  env1.$("tab-fast").click();
  const env2 = bootWith(env1, { search: "" });
  eq(env2.$("tab-fast").getAttribute("aria-selected"), "true", "reload respeita o modo salvo");
});

// ==========================================================================
// G. Acessibilidade comportamental
// ==========================================================================
test("a11y: entrada inválida marca aria-invalid e mostra dica textual", () => {
  const env = boot();
  env.input("gas", "0");
  eq(env.$("gas").getAttribute("aria-invalid"), "true");
  includes(env.text("gasHint"), "Valor inválido");
  includes(env.text("gasHint"), "6,54", "exemplo de valor no modo rápido");
});

test("a11y: erro de campo é anunciado na região viva (liveForm)", async () => {
  const env = boot();
  env.input("gas", "0");
  await env.wait(120);
  includes(env.text("liveForm"), "Gasolina", "campo identificado");
  includes(env.text("liveForm"), "inválido", "erro anunciado");
});

test("a11y: corrigir a entrada limpa aria-invalid e a dica", () => {
  const env = boot();
  env.input("gas", "0");
  env.input("gas", "589");
  eq(env.$("gas").getAttribute("aria-invalid"), "false");
  eq(env.text("gasHint"), "");
});

test("a11y: resultado é anunciado no #live após o debounce", async () => {
  const env = boot();
  env.input("gas", "5,89");
  env.input("eta", "3,99");
  await env.wait(420);
  includes(env.text("live"), "67,7", "índice anunciado");
  includes(env.text("live"), "ETANOL", "veredito anunciado");
});

test("a11y: resultado vazio limpa o anúncio do #live", async () => {
  const env = boot();
  env.input("gas", "5,89");
  env.input("eta", "3,99");
  await env.wait(420);
  env.input("eta", "");
  await env.wait(420);
  eq(env.text("live"), "", "anúncio limpo quando não há resultado");
});

test("a11y: abas respondem às setas (roving tabindex e foco)", () => {
  const env = boot();
  const ev = env.keydown("tab-fast", "ArrowRight");
  eq(ev.prevented, true, "preventDefault na seta");
  eq(env.$("tab-precise").getAttribute("aria-selected"), "true", "abriu Preciso");
  eq(env.document.activeElement, env.$("tab-precise"), "foco moveu para a aba nova");
  env.keydown("tab-precise", "ArrowLeft");
  eq(env.$("tab-fast").getAttribute("aria-selected"), "true", "voltou para Rápido");
});

test("a11y: badge offline aparece e some com eventos de rede", () => {
  const env = boot();
  eq(env.$("netBadge").hidden, true, "começa oculto");
  env.navigator.onLine = false;
  env.fireWindow("offline");
  eq(env.$("netBadge").hidden, false, "mostra offline");
  env.navigator.onLine = true;
  env.fireWindow("online");
  eq(env.$("netBadge").hidden, true, "some online");
});

// ==========================================================================
// H. Barra de atualização + SKIP_WAITING
// ==========================================================================
test("update: barra aparece quando há SW em espera e o app já é controlado", async () => {
  const waiting = { postMessage(message) { waiting.messages.push(message); }, messages: [] };
  const env = boot({ withSW: true, swController: true, swWaiting: waiting });
  env.fireWindow("load");
  await env.flush();
  eq(env.$("updateBar").hidden, false, "barra visível");
  await env.wait(120);
  includes(env.text("liveForm"), "Nova versão disponível", "anúncio em região viva");
  ok(env.document.body.classList.contains("has-update"), "classe has-update no body");
});

test("update: botão Atualizar envia SKIP_WAITING ao SW em espera", async () => {
  const waiting = { messages: [], postMessage(message) { this.messages.push(message); } };
  const env = boot({ withSW: true, swController: true, swWaiting: waiting });
  env.fireWindow("load");
  await env.flush();
  eq(env.registerCalls[0], "./sw.js", "registrou ./sw.js");
  env.$("updateBtn").click();
  eq(waiting.messages.length, 1, "uma mensagem enviada");
  eq(waiting.messages[0].type, "SKIP_WAITING");
});

test("update: controllerchange recarrega a página uma única vez", async () => {
  const waiting = { messages: [], postMessage(message) { this.messages.push(message); } };
  const env = boot({ withSW: true, swController: true, swWaiting: waiting });
  env.fireWindow("load");
  await env.flush();
  env.$("updateBtn").click();
  env.fireSW("controllerchange");
  await env.flush();
  eq(env.reloads.length, 1, "recarrega após o usuário aceitar");
  env.fireSW("controllerchange");
  eq(env.reloads.length, 1, "guarda evita reload duplo");
});

test("update: primeira visita (sem controller) não recarrega sozinha", async () => {
  const env = boot({ withSW: true, swController: false, swWaiting: { postMessage() {} } });
  env.fireWindow("load");
  await env.flush();
  env.fireSW("controllerchange");
  eq(env.reloads.length, 0, "clients.claim inicial não recarrega");
  env.fireSW("controllerchange");
  eq(env.reloads.length, 1, "uma atualização posterior recarrega");
});

test("update: updatefound + installed mostra a barra", async () => {
  const waiting = { messages: [], postMessage(message) { this.messages.push(message); } };
  const env = boot({ withSW: true, swController: true, swWaiting: null });
  env.fireWindow("load");
  await env.flush();
  eq(env.$("updateBar").hidden, true, "sem nova versão ainda");
  const installing = {
    state: "installing",
    _handlers: {},
    addEventListener(type, fn) {
      (installing._handlers[type] = installing._handlers[type] || []).push(fn);
    }
  };
  env.reg.installing = installing;
  env.fireReg("updatefound");
  env.reg.waiting = waiting;
  installing.state = "installed";
  for (const fn of installing._handlers.statechange || []) fn({});
  await env.flush();
  eq(env.$("updateBar").hidden, false, "barra aparece após installed");
});

test("update: sem SW em espera a barra permanece oculta", async () => {
  const env = boot({ withSW: true, swController: true, swWaiting: null });
  env.fireWindow("load");
  await env.flush();
  eq(env.$("updateBar").hidden, true, "barra oculta");
  eq(env.$("updateBtn").onclick, null, "sem handler de atualização pendente");
});

test("update: fallback do botão recarrega quando não há reg.waiting", async () => {
  const waiting = { messages: [], postMessage(message) { this.messages.push(message); } };
  const env = boot({ withSW: true, swController: true, swWaiting: waiting });
  env.fireWindow("load");
  await env.flush();
  eq(env.$("updateBar").hidden, false);
  env.reg.waiting = null;
  env.$("updateBtn").click();
  eq(env.reloads.length, 1, "recarrega direto sem worker em espera");
});

// ==========================================================================
// I. Compartilhar / copiar
// ==========================================================================
function renderFast(env) {
  env.input("gas", "5,89");
  env.input("eta", "3,99");
  return env;
}
function clickShare(env) {
  const btn = env.$("resultOut").querySelector('[data-action="share"]');
  ok(btn, "botão de compartilhar não foi renderizado");
  env.fire(env.$("resultOut"), "click", { target: btn });
}

test("share: botão 'Compartilhar resultado' existe no resultado renderizado", () => {
  const env = renderFast(boot());
  includes(env.rendered(), 'data-action="share"', "botão renderizado");
});

test("share: navigator.share é usado quando disponível", async () => {
  const env = renderFast(boot({ share: "resolve" }));
  clickShare(env);
  await env.flush();
  eq(env.shareCalls.length, 1, "share chamado");
  includes(env.shareCalls[0].text || "", "Abastece Certo", "texto compartilhado");
  eq(env.clipboardTexts.length, 0, "não copia quando share funciona");
});

test("share: share rejeitando cai para a área de transferência", async () => {
  const env = renderFast(boot({ share: "reject", clipboard: "resolve" }));
  clickShare(env);
  await env.flush();
  eq(env.clipboardTexts.length, 1, "clipboard usado como fallback");
  includes(env.clipboardTexts[0], "67,7", "texto copiado é o resultado");
  await env.flush();
  includes(env.text("toast"), "Resultado copiado", "confirmação ao usuário");
});

test("share: AbortError (usuário cancelou) não cai para clipboard", async () => {
  const env = renderFast(boot({ share: "abort", clipboard: "resolve" }));
  clickShare(env);
  await env.flush();
  eq(env.clipboardTexts.length, 0, "cancelamento não copia");
  eq(env.text("toast"), "", "sem toast");
});

test("share: sem navigator.share copia o texto direto", async () => {
  const env = renderFast(boot({ clipboard: "resolve" }));
  clickShare(env);
  await env.flush();
  eq(env.clipboardTexts.length, 1, "copiou");
  includes(env.clipboardTexts[0], "Abasteça com ETANOL");
});

test("share: clipboard rejeitando usa fallback execCommand", async () => {
  const env = renderFast(boot({ clipboard: "reject" }));
  clickShare(env);
  await env.flush();
  await env.flush();
  eq(env.execCommands.length, 1, "execCommand('copy') tentado");
  eq(env.execCommands[0][0], "copy");
  includes(env.text("toast"), "Resultado copiado", "confirma cópia via fallback");
});

test("share: fallback execCommand negado avisa a falha", async () => {
  const env = renderFast(boot({ clipboard: "reject", execCommand: () => false }));
  clickShare(env);
  await env.flush();
  await env.flush();
  includes(env.text("toast"), "Não foi possível copiar", "avisa falha");
});

test("share: texto do modo preciso cita custos e economia", async () => {
  const env = boot({ clipboard: "resolve" });
  env.$("tab-precise").click();
  env.input("gas", "6,54");
  env.input("eta", "4,14");
  env.input("gasKmL", "12,0");
  env.input("etaKmL", "8,6");
  clickShare(env);
  await env.flush();
  includes(env.clipboardTexts[0], "R$ 48,14", "custo etanol");
  includes(env.clipboardTexts[0], "R$ 54,50", "custo gasolina");
  includes(env.clipboardTexts[0], "ETANOL", "veredito");
});

// ==========================================================================
// J. file:// e ausência de service worker
// ==========================================================================
test("file://: app calcula sem SW e com localStorage bloqueado", () => {
  const env = boot({ protocol: "file:", getThrows: true, setThrows: true });
  env.input("gas", "5,89");
  env.input("eta", "3,99");
  includes(env.rendered(), "Abasteça com ETANOL");
  eq(env.registerCalls.length, 0, "não registra SW em file://");
});

test("file://: nenhum handler de load de SW é pendurado", () => {
  const env = boot({ protocol: "file:" });
  // o app só registra o SW fora de file://; disparar load não deve registrar nada
  env.fireWindow("load");
  eq(env.registerCalls.length, 0, "load sem registro de SW");
});

test("sem suporte a service worker: app carrega e calcula normalmente", () => {
  const env = boot({ withSW: false });
  env.input("gas", "5,89");
  env.input("eta", "3,99");
  includes(env.rendered(), "67,7");
  eq(env.registerCalls.length, 0);
});

// ==========================================================================
// K. Consistência em massa (decisão = texto = cor)
// ==========================================================================
test("propriedades: 120 casos aleatórios mantêm veredito = texto = cor", () => {
  const env = boot();
  const thresholds = [55, 60, 65, 70, 71, 72, 73, 75, 80, 85];
  let seed = 987654321;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const br = (n) => n.toFixed(3).replace(".", ",");
  const problems = [];
  for (let i = 0; i < 120; i++) {
    const t = thresholds[i % thresholds.length];
    const gas = Math.round((3 + rnd() * 7) * 1000) / 1000;
    const eta = Math.round((2 + rnd() * 6) * 1000) / 1000;
    env.input("threshold", String(t));
    env.input("gas", br(gas));
    env.input("eta", br(eta));
    const out = env.rendered();
    const verdict = (out.match(/class="verdict ([a-z]+)"/) || [])[1];
    const dot = (out.match(/class="dot-ratio ([a-z]+)/) || [])[1];
    const pct = (eta / gas) * 100;
    const diff = Math.round((pct - t) * 1e9) / 1e9;
    const expected = Math.abs(diff) < 0.5 ? "empate" : diff < 0 ? "etanol" : "gasolina";
    const expectedDot = expected === "empate" ? "amber" : expected === "etanol" ? "green" : "blue";
    if (verdict !== expected || dot !== expectedDot) {
      problems.push({ gas, eta, t, verdict, expected, dot, expectedDot });
    }
    if (expected === "empate" && /acima do limite|abaixo do limite/.test(out)) {
      problems.push({ gas, eta, t, tipo: "texto contraditório no empate" });
    }
    if (/NaN|Infinity|undefined/.test(out)) problems.push({ gas, eta, t, tipo: "NaN/Infinity/undefined" });
  }
  ok(problems.length === 0, "divergências: " + JSON.stringify(problems.slice(0, 3)));
});

// ==========================================================================
// L. v3 — histórico local
// ==========================================================================
const HIST_KEY = "ac.v3.history";
const PRICES_KEY = "ac.v3.prices";

function saveCurrent(env) {
  const btn = env.$("resultOut").querySelector('[data-action="save"]');
  ok(btn, "botão 'Salvar no histórico' não foi renderizado");
  env.fire(env.$("resultOut"), "click", { target: btn });
  return btn;
}
function histSaved(env) {
  const raw = env.storage.get(HIST_KEY);
  if (!raw) return null;
  return JSON.parse(raw);
}
function histEntry(delta) {
  return Object.assign(
    { ts: Date.now(), gas: 5.89, eta: 3.99, pct: 67.7, threshold: 72, verdict: "etanol", mode: "fast" },
    delta || {}
  );
}

test("v3 histórico: salvar cálculo grava entrada, contador e lista", () => {
  const env = renderFast(boot());
  saveCurrent(env);
  const saved = histSaved(env);
  eq(saved.length, 1, "1 entrada no storage");
  eq(saved[0].gas, 5.89, "preço gasolina");
  eq(saved[0].eta, 3.99, "preço etanol");
  eq(saved[0].pct, 67.7, "índice arredondado");
  eq(saved[0].threshold, 72, "limite aplicado");
  eq(saved[0].verdict, "etanol", "veredito");
  eq(saved[0].mode, "fast", "modo");
  ok(typeof saved[0].ts === "number", "timestamp numérico");
  eq(env.text("histCount"), "1", "contador do histórico");
  includes(env.html("histList"), "67,7%", "índice listado");
  includes(env.html("histList"), "Etanol", "veredito listado");
  includes(env.text("toast"), "Salvo no histórico", "toast");
});

test("v3 histórico: entradas sobrevivem ao reload", () => {
  const env1 = renderFast(boot());
  saveCurrent(env1);
  const env2 = bootWith(env1);
  eq(env2.text("histCount"), "1", "contador após reload");
  eq(env2.$("histList").querySelectorAll("li").length, 1, "item após reload");
  eq(env2.$("histExport").disabled, false, "exportar habilitado");
});

test("v3 histórico: sparkline a partir de 2 entradas e lista da mais nova", () => {
  const env = renderFast(boot());
  saveCurrent(env);
  eq(env.html("histChart"), "", "sem gráfico com 1 ponto");
  env.input("gas", "6,50");
  env.input("eta", "4,10");
  saveCurrent(env);
  const chart = env.html("histChart");
  includes(chart, "<svg", "gráfico gerado");
  includes(chart, "<path", "linha do gráfico");
  includes(chart, "aria-label", "gráfico acessível");
  includes(env.html("histList"), "63,1%", "índice do 2º cálculo (4,10/6,50)");
  const firstPct = (env.html("histList").match(/class="hist-pct">([^<]*)</) || [])[1];
  eq(firstPct, "63,1%", "lista em ordem reversa (mais recente primeiro)");
  includes(env.text("histHint"), "Linha tracejada", "legenda do gráfico");
});

test("v3 histórico: guarda no máximo 50 entradas", () => {
  const env = renderFast(boot());
  for (let i = 0; i < 55; i++) saveCurrent(env);
  eq(histSaved(env).length, 50, "teto de 50 entradas");
  eq(env.text("histCount"), "50", "contador no teto");
  eq(env.$("histList").querySelectorAll("li").length, 50, "50 itens na lista");
});

test("v3 histórico: storage corrompido ou entradas inválidas são ignorados", () => {
  const corrupt = boot({ storage: { [HIST_KEY]: "{não é json" } });
  eq(corrupt.text("histCount"), "0", "JSON inválido → histórico vazio");
  eq(corrupt.$("histExport").disabled, true, "exportar desabilitado");
  const mixed = boot({
    storage: {
      [HIST_KEY]: JSON.stringify([
        null,
        { ts: "agora", gas: 5.89, eta: 3.99, pct: 67.7, verdict: "etanol", mode: "fast" },
        { ts: 123, gas: "x", eta: 3.99, pct: 67.7, verdict: "etanol", mode: "fast" },
        histEntry()
      ])
    }
  });
  eq(mixed.text("histCount"), "1", "só a entrada válida permanece");
});

test("v3 histórico: Limpar exige confirmação antes de apagar", () => {
  const env = renderFast(boot());
  saveCurrent(env);
  env.$("histClear").click();
  includes(env.$("histClear").textContent, "Confirmar limpeza", "primeiro clique pede confirmação");
  eq(histSaved(env).length, 1, "nada apagado no primeiro clique");
  env.$("histClear").click();
  eq(env.text("histCount"), "0", "contador zerado");
  eq(histSaved(env).length, 0, "storage limpo");
  eq(env.$("histClear").textContent, "Limpar", "rótulo restaurado");
  eq(env.$("histExport").disabled, true, "exportar desabilitado");
  includes(env.text("toast"), "Histórico apagado", "toast de limpeza");
});

test("v3 histórico: exportar CSV gera download com BOM, cabeçalho e vírgula decimal", async () => {
  const env = renderFast(boot());
  saveCurrent(env);
  env.$("histExport").click();
  await env.flush();
  eq(env.downloads.length, 1, "um download gerado");
  eq(env.downloads[0].download, "abastece-certo-historico.csv", "nome do arquivo");
  const csv = await env.downloadText(0);
  const bytes = await env.downloadBytes(0);
  eq([bytes[0], bytes[1], bytes[2]].join(" "), "239 187 191", "CSV começa com BOM UTF-8 (Excel pt-BR)");
  const lines = csv.replace(/^\uFEFF/, "").split("\r\n");
  eq(lines[0], "data;hora;modo;gasolina;etanol;indice_percentual;limite;veredito", "cabeçalho");
  eq(lines.length, 2, "cabeçalho + 1 linha de dados");
  includes(lines[1], "rapido", "modo na linha");
  includes(lines[1], "5,89", "preço com vírgula decimal");
  includes(lines[1], "etanol", "veredito na linha");
  includes(env.text("toast"), "CSV exportado", "toast de exportação");
});

test("v3 histórico: exportar/limpar ficam desabilitados sem entradas", () => {
  const env = boot();
  eq(env.$("histExport").disabled, true, "exportar desabilitado");
  eq(env.$("histClear").disabled, true, "limpar desabilitado");
  env.$("histExport").click();
  eq(env.downloads.length, 0, "nenhum download sem entradas");
});

test("v3 histórico: cálculo do modo preciso é salvo como 'preciso' no CSV", async () => {
  const env = boot();
  env.$("tab-precise").click();
  env.input("gas", "6,54");
  env.input("eta", "4,14");
  env.input("gasKmL", "12,0");
  env.input("etaKmL", "8,6");
  saveCurrent(env);
  eq(histSaved(env)[0].mode, "precise", "modo registrado no storage");
  env.$("histExport").click();
  await env.flush();
  const csv = await env.downloadText(0);
  includes(csv, "preciso", "modo no CSV");
  includes(csv, "6,54", "preço da gasolina no CSV");
});

// ------------------------------------------------- entradas hostis (histórico)
test("v3 histórico hostil: timestamps futuro/negativo não geram NaN nem quebram a lista", () => {
  const entries = [
    histEntry({ ts: -86400000 }), // 31/12/1969
    histEntry({ ts: 4102444800000 }), // 01/01/2100
    histEntry({ ts: 0 }),
    histEntry({ ts: Date.now() })
  ];
  const env = boot({ storage: { [HIST_KEY]: JSON.stringify(entries) } });
  eq(env.text("histCount"), "4", "4 entradas aceitas");
  const html = env.html("histList");
  eq(env.$("histList").querySelectorAll("li").length, 4, "4 itens renderizados");
  notIncludes(html, "NaN", "sem NaN na data");
  notIncludes(html, "undefined", "sem undefined na data");
  notIncludes(html, "Invalid Date", "sem data inválida visível");
  note("lista com timestamps extremos: " + html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220));
});

test("v3 histórico hostil: entradas não finitas/inválidas são descartadas", () => {
  const raw =
    '[{"ts":1e999,"gas":5.89,"eta":3.99,"pct":67.7,"verdict":"etanol","mode":"fast"},' +
    '{"ts":123,"gas":1e999,"eta":3.99,"pct":67.7,"verdict":"etanol","mode":"fast"},' +
    '{"ts":123,"gas":5.89,"eta":3.99,"pct":67.7,"verdict":5,"mode":"fast"},' +
    '{"ts":123,"gas":5.89,"eta":3.99,"pct":67.7,"verdict":"etanol","mode":"outro"},' +
    '{"ts":123,"gas":5.89,"eta":3.99,"pct":67.7,"verdict":"etanol","mode":"fast"}]';
  const env = boot({ storage: { [HIST_KEY]: raw } });
  eq(env.text("histCount"), "1", "só a entrada completamente válida permanece");
});

test("v3 histórico hostil: 2000 entradas são cortadas em 50 sem travar", () => {
  const entries = [];
  for (let i = 0; i < 2000; i++) entries.push(histEntry({ ts: 1700000000000 + i, pct: 60 + (i % 20) }));
  const started = Date.now();
  const env = boot({ storage: { [HIST_KEY]: JSON.stringify(entries) } });
  const elapsed = Date.now() - started;
  eq(env.text("histCount"), "50", "corta em 50");
  eq(env.$("histList").querySelectorAll("li").length, 50, "50 itens na lista");
  ok(elapsed < 2000, "carga do histórico gigante demorou " + elapsed + "ms");
  // o excedente só é reescrito no próximo save/clear — não é perda de dados
  const next = bootWith(env);
  eq(next.text("histCount"), "50", "continua 50 após reload");
});

test("v3 histórico hostil: CSV com valores extremos mantém colunas e não quebra", async () => {
  const env = boot({
    storage: {
      [HIST_KEY]: JSON.stringify([
        histEntry({ gas: 0.000001, eta: 0.0000005, pct: 50, threshold: 55 }),
        histEntry({ gas: 99.99, eta: 99.98, pct: 99.99, threshold: 85 })
      ])
    }
  });
  env.$("histExport").click();
  await env.flush();
  const csv = await env.downloadText(0);
  const lines = csv.replace(/^\uFEFF/, "").split("\r\n");
  eq(lines.length, 3, "cabeçalho + 2 linhas");
  for (const line of lines) eq(line.split(";").length, 8, "linha com 8 colunas: " + line.slice(0, 80));
});

test("v3 histórico hostil: veredito desconhecido não injeta HTML nem quebra o CSV", async () => {
  const payload = '"><img src=x onerror=alert(1)>';
  const env = boot({
    storage: {
      [HIST_KEY]: JSON.stringify([
        histEntry({ verdict: payload }),
        histEntry({ verdict: "etanol;=cmd|' /C calc'!A0" }),
        histEntry()
      ])
    }
  });
  eq(env.text("histCount"), "3", "todas as entradas com verdict string são aceitas");
  const list = env.html("histList");
  notIncludes(list, "<img", "veredito é interpolado sem escape no class do <span> (injeção de DOM)");
  notIncludes(list, "onerror", "atributo de evento injetado pela lista do histórico");
  env.$("histExport").click();
  await env.flush();
  const csv = await env.downloadText(0);
  const lines = csv.replace(/^\uFEFF/, "").split("\r\n");
  eq(lines.length, 4, "cabeçalho + 3 linhas (sem quebra de linha extra)");
  for (const line of lines) eq(line.split(";").length, 8, "linha com 8 colunas: " + line.slice(0, 100));
  note("veredito adversário no innerHTML: " + list.slice(0, 260));
});

// ==========================================================================
// M. v3 — preços de referência da ANP (precos.json)
// ==========================================================================
const PRICES_FIXTURE = {
  fonte: "ANP — Levantamento de Preços de Combustíveis",
  semana: { inicio: "2026-10-04", fim: "2026-10-10" },
  brasil: {
    gasolinaComum: { media: 6.54, min: 5.39, max: 8.99, postos: 4474 },
    gasolinaAditivada: { media: 6.72, min: 5.59, max: 8.99, postos: 3443 },
    etanol: { media: 4.14, min: 3.09, max: 6.59, postos: 3833 }
  },
  estados: {
    SP: { gasolinaComum: 6.49, etanol: 4.09 },
    RJ: { gasolinaComum: 6.62, etanol: 4.21 }
  }
};
const WEEK_LABEL = "04\u201310/10/2026";

function jsonResponse(data, status) {
  return { body: JSON.stringify(data), status: status === undefined ? 200 : status };
}
function bootOnline(extra) {
  return boot(Object.assign({ fetchImpl: () => jsonResponse(PRICES_FIXTURE) }, extra || {}));
}

test("v3 preços: precos.json carrega, mostra semana/valores e cacheia", async () => {
  const env = bootOnline();
  await env.flush();
  await env.flush();
  eq(env.fetchCalls.length, 1, "um fetch no init");
  eq(env.fetchCalls[0].url, "./precos.json", "busca o arquivo do próprio site");
  const ref = env.html("priceRef");
  includes(ref, "Referência ANP", "bloco de referência");
  includes(ref, WEEK_LABEL, "semana formatada");
  includes(ref, "R$ 6,54", "média Brasil da gasolina");
  includes(ref, "R$ 4,14", "média Brasil do etanol");
  eq(env.$("priceRef").querySelector("#refUse") !== null, true, "botão Usar médias");
  const options = env.$("priceRef").querySelectorAll("option").map((o) => o.getAttribute("value"));
  eq(options.join(","), ",RJ,SP", "Brasil + UFs (ordenadas)");
  const cached = JSON.parse(env.storage.get(PRICES_KEY));
  eq(cached.brasil.gasolinaComum.media, 6.54, "precos.json cru cacheado");
  eq(cached.estados.SP.etanol, 4.09, "UF cacheada");
});

test("v3 preços: offline mantém o texto de referência embutido", async () => {
  const env = boot();
  await env.flush();
  includes(env.html("priceRef"), "Médias ANP da semana 04", "fallback embutido continua visível");
  eq(env.$("priceRef").querySelector("#refUse"), null, "sem botão Usar médias offline");
  eq(env.storage.has(PRICES_KEY), false, "nada cacheado sem dados");
});

test("v3 preços: cache local é usado quando o fetch falha", async () => {
  const env = boot({
    storage: { [PRICES_KEY]: JSON.stringify(PRICES_FIXTURE) },
    fetchImpl: () => {
      throw new Error("offline");
    }
  });
  await env.flush();
  includes(env.html("priceRef"), "Referência ANP", "usa cache");
  includes(env.html("priceRef"), WEEK_LABEL, "semana do cache");
  includes(env.html("priceRef"), "R$ 6,54", "valores do cache");
  ok(env.$("priceRef").querySelector("#refUse"), "Usar médias disponível com cache");
});

test("v3 preços: precos.json inválido (JSON ou schema) mantém o fallback", async () => {
  const badJson = boot({
    fetchImpl: () => ({ body: "{isso não é json", status: 200 })
  });
  await badJson.flush();
  await badJson.flush();
  includes(badJson.html("priceRef"), "Médias ANP da semana 04", "JSON inválido → fallback");
  eq(badJson.storage.has(PRICES_KEY), false, "não cacheia lixo");

  const badSchema = boot({
    fetchImpl: () => jsonResponse({ semana: { inicio: "x", fim: "y" }, brasil: { gasolinaComum: { media: 0 }, etanol: { media: -1 } } })
  });
  await badSchema.flush();
  await badSchema.flush();
  includes(badSchema.html("priceRef"), "Médias ANP da semana 04", "schema inválido → fallback");
  eq(badSchema.storage.has(PRICES_KEY), false, "schema inválido não é cacheado");
});

test("v3 preços: HTTP 404 mantém o fallback", async () => {
  const env = boot({ fetchImpl: () => ({ body: "", status: 404 }) });
  await env.flush();
  await env.flush();
  includes(env.html("priceRef"), "Médias ANP da semana 04", "404 → fallback");
  eq(env.storage.has(PRICES_KEY), false, "não cacheia erro HTTP");
});

test("v3 preços: 'Usar médias' preenche os preços do Brasil por padrão", async () => {
  const env = bootOnline();
  await env.flush();
  await env.flush();
  const use = env.$("priceRef").querySelector("#refUse");
  env.fire(env.$("priceRef"), "click", { target: use });
  eq(env.$("gas").value, "6,54", "gasolina Brasil aplicada");
  eq(env.$("eta").value, "4,14", "etanol Brasil aplicado");
  includes(env.rendered(), "63,3", "resultado calculado após aplicar");
  includes(env.text("toast"), "Médias de Brasil aplicadas", "toast");
  eq(env.saved().gas, "6,54", "preços persistidos");
});

test("v3 preços: 'Usar médias' aplica a UF selecionada", async () => {
  const env = bootOnline();
  await env.flush();
  await env.flush();
  const select = env.$("priceRef").querySelector("#refUf");
  select.value = "SP";
  env.fire(env.$("priceRef"), "change", { target: select });
  const after = env.$("priceRef").querySelector("#refUf");
  eq(after.value, "SP", "UF selecionada sobrevive ao re-render");
  includes(env.html("priceRef"), "R$ 6,49", "linha mostra a média de SP");
  env.fire(env.$("priceRef"), "click", { target: env.$("priceRef").querySelector("#refUse") });
  eq(env.$("gas").value, "6,49", "gasolina SP aplicada");
  eq(env.$("eta").value, "4,09", "etanol SP aplicado");
  includes(env.text("toast"), "Médias de SP aplicadas", "toast com a UF");
});

test("v3 preços: UFs e médias inválidas são descartadas na normalização", async () => {
  const data = {
    semana: { inicio: "2026-10-04", fim: "2026-10-10" },
    brasil: { gasolinaComum: { media: 6.54 }, etanol: { media: 4.14 } },
    estados: {
      xx: { gasolinaComum: 6.1, etanol: 4.0 },
      S: { gasolinaComum: 6.1, etanol: 4.0 },
      SP: { gasolinaComum: "abc", etanol: 4.09 },
      RJ: { gasolinaComum: 6.62, etanol: 4.21 }
    }
  };
  const env = boot({ fetchImpl: () => jsonResponse(data) });
  await env.flush();
  await env.flush();
  const options = env.$("priceRef").querySelectorAll("option").map((o) => o.getAttribute("value"));
  eq(options.join(","), ",RJ", "só UF válida permanece");
});

test("v3 preços: file:// não tenta buscar precos.json", () => {
  const env = boot({ protocol: "file:", getThrows: true });
  eq(env.fetchCalls.length, 0, "nenhum fetch em file://");
  includes(env.html("priceRef"), "Médias ANP da semana 04", "fallback em file://");
});

test("v3 preços: navegador sem fetch não quebra a inicialização", () => {
  const env = boot({ fetchAvailable: false });
  eq(env.fetchCalls.length, 0, "nenhum fetch");
  includes(env.html("priceRef"), "Médias ANP da semana 04", "fallback");
  env.input("gas", "5,89");
  env.input("eta", "3,99");
  includes(env.rendered(), "67,7", "app continua calculando");
});

// O artefato REAL gerado por tools/update-prices.mjs também é entrada do gate:
// se o schema do precos.json mudar, o app precisa continuar renderizando.
function realWeekLabel(week) {
  const a = String(week.inicio).split("-");
  const b = String(week.fim).split("-");
  if (a[0] === b[0] && a[1] === b[1]) return a[2] + "\u2013" + b[2] + "/" + b[1] + "/" + b[0];
  return a[2] + "/" + a[1] + "/" + a[0] + "\u2013" + b[2] + "/" + b[1] + "/" + b[0];
}
function brl(n) {
  return "R$ " + Number(n).toFixed(2).replace(".", ",");
}

test("v3 preços: o precos.json real do projeto é normalizado e exibido", async () => {
  ok(existsSync(join(ROOT, "precos.json")), "precos.json ausente na raiz (precache e app dependem dele)");
  const raw = readFileSync(join(ROOT, "precos.json"), "utf8");
  const data = JSON.parse(raw);
  const env = boot({ fetchImpl: () => ({ body: raw, status: 200 }) });
  await env.flush();
  await env.flush();
  const ref = env.html("priceRef");
  includes(ref, "Referência ANP", "bloco de referência");
  includes(ref, realWeekLabel(data.semana), "semana real");
  includes(ref, brl(data.brasil.gasolinaComum.media), "gasolina comum real");
  includes(ref, brl(data.brasil.etanol.media), "etanol real");
  const validUfs = Object.keys(data.estados).filter(
    (uf) =>
      /^[A-Z]{2}$/.test(uf) &&
      data.estados[uf] &&
      Number(data.estados[uf].gasolinaComum) > 0 &&
      Number(data.estados[uf].etanol) > 0
  );
  const options = env.$("priceRef").querySelectorAll("option").map((o) => o.getAttribute("value"));
  eq(options[0], "", "primeira opção é Brasil");
  eq(options.length, validUfs.length + 1, "todas as UFs reais no seletor");
  eq(options.slice(1).join(","), validUfs.sort().join(","), "UFs ordenadas e sem lixo");
  eq(JSON.parse(env.storage.get(PRICES_KEY)).semana.inicio, data.semana.inicio, "cache com o dado real");
});

test("v3 preços: dado novo da rede substitui o cache antigo", async () => {
  const stale = JSON.parse(JSON.stringify(PRICES_FIXTURE));
  stale.brasil.gasolinaComum.media = 6.1;
  stale.brasil.etanol.media = 3.9;
  const env = boot({
    storage: { [PRICES_KEY]: JSON.stringify(stale) },
    fetchImpl: () => jsonResponse(PRICES_FIXTURE)
  });
  await env.flush();
  await env.flush();
  includes(env.html("priceRef"), "R$ 6,54", "valor novo na tela");
  eq(JSON.parse(env.storage.get(PRICES_KEY)).brasil.etanol.media, 4.14, "cache atualizado");
});

// ---------------------------------------------------- entradas hostis (ANP)
test("v3 preços hostis: média como string numérica é aceita; vírgula decimal é rejeitada", async () => {
  const dotString = {
    semana: { inicio: "2026-10-04", fim: "2026-10-10" },
    brasil: { gasolinaComum: { media: "6.54" }, etanol: { media: "4.14" } },
    estados: {}
  };
  const envDot = boot({ fetchImpl: () => jsonResponse(dotString) });
  await envDot.flush();
  await envDot.flush();
  includes(envDot.html("priceRef"), "R$ 6,54", "string numérica com ponto é normalizada");

  const commaString = {
    semana: { inicio: "2026-10-04", fim: "2026-10-10" },
    brasil: { gasolinaComum: { media: "6,54" }, etanol: { media: "4,14" } },
    estados: {}
  };
  const envComma = boot({ fetchImpl: () => jsonResponse(commaString) });
  await envComma.flush();
  await envComma.flush();
  includes(envComma.html("priceRef"), "Médias ANP da semana 04", "vírgula decimal não é adivinhada");
  eq(envComma.storage.has(PRICES_KEY), false, "dado não numérico não é cacheado");
});

test("v3 preços hostis: UFs malformadas e chaves de protótipo são ignoradas", async () => {
  const raw =
    '{"semana":{"inicio":"2026-10-04","fim":"2026-10-10"},' +
    '"brasil":{"gasolinaComum":{"media":6.54},"etanol":{"media":4.14}},' +
    '"estados":{"__proto__":{"gasolinaComum":0.01,"etanol":0.01},' +
    '"constructor":{"gasolinaComum":0.01,"etanol":0.01},' +
    '"prototype":{"gasolinaComum":0.01,"etanol":0.01},' +
    '"SP":{"gasolinaComum":6.49,"etanol":4.09},' +
    '"sp":{"gasolinaComum":1,"etanol":1},"S1":{"gasolinaComum":1,"etanol":1},' +
    '"__":{"gasolinaComum":1,"etanol":1}}}';
  const env = boot({ fetchImpl: () => ({ body: raw, status: 200 }) });
  await env.flush();
  await env.flush();
  const options = env.$("priceRef").querySelectorAll("option").map((o) => o.getAttribute("value"));
  eq(options.join(","), ",SP", "só UF com formato válido permanece");
  const polluted = vm.runInContext(
    "(function(){ try { return typeof ({}).gasolinaComum !== 'undefined' || ({}).etanol === 0.01; } catch (e) { return 'erro'; } })()",
    env.sandbox
  );
  eq(polluted, false, "Object.prototype não pode ser poluído pelo precos.json");
  env.input("gas", "5,89");
  env.input("eta", "3,99");
  includes(env.rendered(), "67,7", "app continua calculando normalmente");
});

test("v3 preços hostis: JSON gigante é filtrado sem travar", async () => {
  const estados = { SP: { gasolinaComum: 6.49, etanol: 4.09 } };
  for (let i = 0; i < 2000; i++) estados["U" + i] = { gasolinaComum: 1 + (i % 5), etanol: 1 };
  const data = {
    fonte: "x".repeat(50000),
    semana: { inicio: "2026-10-04", fim: "2026-10-10" },
    brasil: { gasolinaComum: { media: 6.54, lixo: "y".repeat(20000) }, etanol: { media: 4.14 } },
    estados
  };
  const started = Date.now();
  const env = boot({ fetchImpl: () => jsonResponse(data) });
  await env.flush();
  await env.flush();
  const elapsed = Date.now() - started;
  const options = env.$("priceRef").querySelectorAll("option").map((o) => o.getAttribute("value"));
  eq(options.join(","), ",SP", "2000 chaves inválidas filtradas");
  ok(elapsed < 2000, "normalização do JSON gigante demorou " + elapsed + "ms");
});

test("v3 preços hostis: payloads de texto não chegam ao DOM", async () => {
  const data = {
    fonte: '<img src=x onerror=alert(1)>',
    semana: { inicio: '<svg onload=alert(1)>', fim: "2026-10-10" },
    brasil: { gasolinaComum: { media: 6.54 }, etanol: { media: 4.14 } },
    estados: { '<img src=x>': { gasolinaComum: 1, etanol: 1 } }
  };
  const env = boot({ fetchImpl: () => jsonResponse(data) });
  await env.flush();
  await env.flush();
  const ref = env.html("priceRef");
  notIncludes(ref, "<img", "payload não injetado no bloco de referência");
  notIncludes(ref, "onerror", "atributo de evento não injetado");
  notIncludes(ref, "<svg onload", "svg malicioso não injetado");
  eq(env.$("priceRef").querySelectorAll("option").length, 1, "só a opção Brasil");
});

test("v3 preços hostis: médias Infinity/negativas/zero caem no fallback", async () => {
  const raw =
    '{"semana":{"inicio":"2026-10-04","fim":"2026-10-10"},' +
    '"brasil":{"gasolinaComum":{"media":1e999},"gasolinaAditivada":{"media":-6.72},"etanol":{"media":0}},"estados":{}}';
  const env = boot({ fetchImpl: () => ({ body: raw, status: 200 }) });
  await env.flush();
  await env.flush();
  includes(env.html("priceRef"), "Médias ANP da semana 04", "valores não finitos → fallback embutido");
  eq(env.storage.has(PRICES_KEY), false, "dado inválido não é cacheado");
});

// ==========================================================================
// N. v3 — migração e convivência de chaves
// ==========================================================================
test("v3 migração: estado v2 + histórico + cache de preços convivem no mesmo aparelho", () => {
  const v2State = {
    mode: "precise",
    threshold: 73,
    gas: "6,00",
    eta: "4,00",
    gasKmL: "12,0",
    etaKmL: "8,6",
    vehName: "Onix",
    vehicles: [{ id: "v1", name: "Onix", gasKmL: 12, etaKmL: 8.6 }],
    activeId: "v1"
  };
  const env = boot({
    storage: {
      "ac.v2": JSON.stringify(v2State),
      [HIST_KEY]: JSON.stringify([histEntry()]),
      [PRICES_KEY]: JSON.stringify(PRICES_FIXTURE)
    }
  });
  eq(env.$("tab-precise").getAttribute("aria-selected"), "true", "modo preciso da v2");
  eq(env.$("threshold").value, "73", "limite da v2 preservado");
  eq(env.$("vehName").value, "Onix", "veículo da v2 preservado");
  eq(env.text("histCount"), "1", "histórico preservado");
  includes(env.html("priceRef"), "Referência ANP", "cache de preços usado");
});

test("v3 migração: dados da v2 não são apagados ao gravar histórico/preços", () => {
  const env = renderFast(boot());
  saveCurrent(env);
  const saved = env.saved();
  eq(saved.gas, "5,89", "estado principal intacto no ac.v2");
  eq(env.storage.has(HIST_KEY), true, "histórico em chave própria");
  eq(env.storage.has("ac.v2"), true, "estado principal em ac.v2");
});

// ==========================================================================
// O. v3 — manifest com screenshots
// ==========================================================================
function readManifest() {
  return JSON.parse(readFileSync(join(ROOT, "manifest.webmanifest"), "utf8"));
}

test("v3 manifest: screenshots narrow/wide declarados com label, tipo e tamanho", () => {
  const manifest = readManifest();
  const shots = manifest.screenshots || [];
  ok(shots.length >= 2, "esperava ao menos 2 screenshots");
  const variants = new Set();
  for (const shot of shots) {
    ok(shot.src, "screenshot sem src");
    eq(shot.type, "image/png", "tipo PNG em " + shot.src);
    matches(shot.sizes, /^\d+x\d+$/, "sizes válido em " + shot.src);
    ok(shot.label, "label ausente em " + shot.src);
    ok(["narrow", "wide"].includes(shot.form_factor), "form_factor inválido em " + shot.src);
    variants.add(shot.form_factor);
  }
  ok(variants.has("narrow") && variants.has("wide"), "precisa de um narrow e um wide");
});

test("v3 manifest: arquivos de screenshot existem e têm as dimensões declaradas", () => {
  const manifest = readManifest();
  for (const shot of manifest.screenshots || []) {
    const rel = String(shot.src).replace(/^\.\//, "");
    ok(existsSync(join(ROOT, rel)), "screenshot ausente: " + rel);
    const buf = readFileSync(join(ROOT, rel));
    eq(buf.slice(1, 4).toString(), "PNG", rel + " não é PNG");
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const size = String(shot.sizes).split("x").map(Number);
    eq(width + "x" + height, size[0] + "x" + size[1], rel + " tem dimensões diferentes do manifesto");
  }
});

// ==========================================================================
// P. Robustez: nenhuma promessa rejeitada sem tratamento
// ==========================================================================
test("robustez: nenhuma rejeição de Promise sem tratamento durante a suíte", async () => {
  await sleep(50);
  ok(
    unhandledRejections.length === 0,
    "rejeições não tratadas: " + unhandledRejections.map((r) => String((r && r.message) || r)).join(" | ")
  );
});

// ==========================================================================
// Execução
// ==========================================================================
for (const t of tests) {
  try {
    await t.fn();
    console.log("  ok    " + t.name);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    failures.push({ name: t.name, message });
    console.log("  FAIL  " + t.name + "\n        " + message.split("\n").join("\n        "));
  }
}

console.log("");
console.log("=".repeat(64));
if (failures.length === 0) {
  console.log("OK — " + tests.length + " testes passaram.");
} else {
  console.log("FALHOU — " + failures.length + " de " + tests.length + " testes.");
  for (const f of failures) console.log("  • " + f.name + ": " + f.message);
}
console.log("=".repeat(64));
process.exitCode = failures.length === 0 ? 0 : 1;
