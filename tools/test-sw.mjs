#!/usr/bin/env node
/**
 * Abastece Certo — teste de runtime do service worker (sw.js) em node:vm.
 *
 * Executa o sw.js REAL com stubs fiéis de `self`, `caches` (Cache API),
 * `fetch`, `Request`, `Response` e `clients`. Nenhum navegador, nenhuma
 * dependência, nenhuma rede.
 *
 * Cobre: install (precache completo e tolerante a 404/offline), activate
 * (limpeza só do prefixo abastece-certo- + clients.claim), message
 * SKIP_WAITING, filtros de fetch (método/origem/sw.js), network-first na
 * navegação com fallback offline e SWR dos assets — inclusive em subpasta
 * (escopo do GitHub Pages) — e consistência de VERSION com o app.
 *
 * Uso:
 *   node tools/test-sw.mjs            # gate (exit 1 em falha)
 *   node tools/test-sw.mjs --verbose  # mostra evidências de cada caso
 *
 * Requisitos: Node >= 20.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");
const swSrc = readFileSync(join(ROOT, "sw.js"), "utf8");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");

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
        "esperava encontrar " + JSON.stringify(needle) + " em " + JSON.stringify(String(haystack).slice(0, 300))
    );
  }
}
function matches(value, re, message) {
  if (!re.test(String(value))) {
    throw new Error(
      (message ? message + ": " : "") +
        "esperava casar " + re + " em " + JSON.stringify(String(value).slice(0, 300))
    );
  }
}
function note(text) {
  if (VERBOSE) console.log("      · " + text);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unhandledRejections = [];
process.on("unhandledRejection", (reason) => {
  unhandledRejections.push(reason);
});

// ------------------------------------------------------------- constantes SW
const VERSION_MATCH = swSrc.match(/const VERSION\s*=\s*"([^"]+)"/);
const PRECACHE_MATCH = swSrc.match(/const PRECACHE\s*=\s*\[([\s\S]*?)\];/);
const PRECACHE = PRECACHE_MATCH
  ? [...PRECACHE_MATCH[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  : [];

// ------------------------------------------------------------- stubs padrão
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
        const headers = init.headers || {};
        const key = Object.keys(headers).find((k) => k.toLowerCase() === String(name).toLowerCase());
        return key ? headers[key] : null;
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
    const response = new ResponseStub(null, { status: 0, type: "error" });
    response.ok = false;
    return response;
  }
}

class RequestStub {
  constructor(input, init) {
    init = init || {};
    if (input instanceof RequestStub) {
      this.url = input.url;
      this.method = input.method;
      this.mode = input.mode;
      this.cache = input.cache;
      return;
    }
    const base = this.constructor.base || "https://example.com/";
    this.url = new URL(String(input), base).href;
    this.method = (init.method || "GET").toUpperCase();
    this.mode = init.mode || "cors";
    this.cache = init.cache;
  }
}

// ------------------------------------------------------------- harness do SW
function createSW(options) {
  options = options || {};
  const BASE = options.base || "https://example.com/repo/";
  const ORIGIN = new URL(BASE).origin;
  const VERSION = VERSION_MATCH ? VERSION_MATCH[1] : "";
  const CACHE = "abastece-certo-" + VERSION;
  const abs = (url) => new URL(url, BASE).href;
  const reqUrl = (request) => {
    if (typeof request === "string") return abs(request);
    if (!request) return "";
    if (request.url) return request.url;
    return abs(String(request));
  };

  const store = new Map(); // nome do cache -> Map(url -> ResponseStub)
  const addCalls = [];
  const putCalls = [];
  const matchCalls = [];
  const deleted = [];
  const skipWaits = [];
  const claimCalls = [];
  const fetchCalls = [];
  const handlers = {};
  let failAdd = null;
  let failPut = false;
  let netMode = "ok";

  function response(body, status) {
    return new ResponseStub(body === undefined ? "stub" : body, { status: status === undefined ? 200 : status });
  }

  function cacheFor(name) {
    return {
      async add(request) {
        const url = reqUrl(request);
        addCalls.push({ name, url, cache: request && request.cache });
        if (failAdd && failAdd(url)) throw new Error("404 simulado: " + url);
        store.get(name).set(url, response("cached:" + url));
        return undefined;
      },
      async put(request, res) {
        const url = reqUrl(request);
        putCalls.push({ name, url });
        if (failPut) throw new Error("QuotaExceededError simulado");
        if (!store.has(name)) store.set(name, new Map());
        store.get(name).set(url, res);
        return undefined;
      },
      async match(request) {
        const url = reqUrl(request);
        matchCalls.push({ name, url });
        const cache = store.get(name);
        return cache ? cache.get(url) : undefined;
      }
    };
  }

  const caches = {
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      return cacheFor(name);
    },
    async keys() {
      return [...store.keys()];
    },
    async delete(name) {
      deleted.push(name);
      return store.delete(name);
    },
    async match(request) {
      const url = reqUrl(request);
      for (const cache of store.values()) if (cache.has(url)) return cache.get(url);
      return undefined;
    }
  };

  const self = {
    location: { origin: ORIGIN, href: abs("sw.js"), pathname: new URL(abs("sw.js")).pathname },
    addEventListener(type, fn) {
      handlers[type] = fn;
    },
    skipWaiting() {
      skipWaits.push(Date.now());
    },
    clients: {
      async claim() {
        claimCalls.push(Date.now());
      }
    }
  };

  const fetchStub = async (request) => {
    const url = reqUrl(request);
    fetchCalls.push({ url, method: request && request.method });
    if (netMode === "fail") throw new TypeError("Failed to fetch (simulado offline)");
    if (netMode && typeof netMode === "object" && netMode.status) {
      return response("net-status:" + netMode.status + ":" + url, netMode.status);
    }
    return response("net:" + url);
  };

  // `new Request("./x")` dentro do sw.js resolve relativo à localização do SW.
  class LocalRequest extends RequestStub {}
  LocalRequest.base = BASE;

  const sandbox = {
    self,
    caches,
    fetch: fetchStub,
    Request: LocalRequest,
    Response: ResponseStub,
    URL,
    URLSearchParams,
    Promise,
    console,
    setTimeout,
    clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(swSrc, sandbox, { filename: "sw.js" });

  function lifecycle(type) {
    let promise;
    ok(typeof handlers[type] === "function", "handler '" + type + "' ausente no sw.js");
    handlers[type]({ waitUntil(p) { promise = p; } });
    return promise;
  }

  const env = {
    BASE,
    ORIGIN,
    VERSION,
    CACHE,
    handlers,
    store,
    addCalls,
    putCalls,
    matchCalls,
    deleted,
    skipWaits,
    claimCalls,
    fetchCalls,
    abs,
    response,
    install: () => lifecycle("install"),
    activate: () => lifecycle("activate"),
    message: (data) => {
      ok(typeof handlers.message === "function", "handler 'message' ausente");
      handlers.message({ data });
    },
    runFetch: (url, opts) => {
      opts = opts || {};
      const request = new RequestStub(url, { method: opts.method || "GET", mode: opts.mode || "no-cors" });
      let responded;
      handlers.fetch({ request, respondWith(p) { responded = p; } });
      return { request, responded, intercepted: responded !== undefined };
    },
    seed(cacheName, url, body) {
      if (!store.has(cacheName)) store.set(cacheName, new Map());
      store.get(cacheName).set(abs(url), response(body));
    },
    hasCacheEntry(cacheName, url) {
      const cache = store.get(cacheName);
      return !!(cache && cache.has(abs(url)));
    },
    cacheEntry(cacheName, url) {
      const cache = store.get(cacheName);
      return cache ? cache.get(abs(url)) : undefined;
    },
    setNet: (mode) => {
      netMode = mode;
    },
    setFailAdd: (predicate) => {
      failAdd = predicate;
    },
    setFailPut: (value) => {
      failPut = !!value;
    },
    tick: async () => {
      await sleep(0);
      await sleep(0);
    }
  };
  return env;
}

function extractPrecache() {
  return PRECACHE;
}

// ==========================================================================
// 1. Metadados e consistência com o app
// ==========================================================================
test("sw: declara handlers install/activate/fetch/message", () => {
  const env = createSW();
  for (const type of ["install", "activate", "fetch", "message"]) {
    eq(typeof env.handlers[type], "function", "handler " + type);
  }
});

test("sw: VERSION é 'v' + version do package.json", () => {
  ok(VERSION_MATCH, "const VERSION não encontrada no sw.js");
  eq(VERSION_MATCH[1], "v" + pkg.version, "VERSION × package.json");
  note("VERSION=" + VERSION_MATCH[1] + " · package=" + pkg.version);
});

test("sw: VERSION bate com a versão exibida no rodapé do app", () => {
  const footer = indexHtml.match(/·\s*(v\d+(?:\.\d+)*)\s*·/);
  ok(footer, "rodapé sem marcador de versão '· vN ·'");
  ok(VERSION_MATCH[1].startsWith(footer[1]), "VERSION " + VERSION_MATCH[1] + " não casa com o rodapé " + footer[1]);
});

test("sw: precache usa o cache versionado do app", async () => {
  const env = createSW();
  await env.install();
  ok(env.addCalls.length > 0, "install não tentou pré-cachear nada");
  for (const call of env.addCalls) eq(call.name, env.CACHE, "nome do cache no precache");
  matches(env.CACHE, /^abastece-certo-v[\d.]+$/, "prefixo do cache");
});

test("sw: PRECACHE cobre os arquivos essenciais e evita URLs externas", () => {
  const entries = extractPrecache();
  ok(entries.length >= 6, "PRECACHE curto demais: " + entries.length);
  for (const required of ["./", "./index.html", "./manifest.webmanifest", "./precos.json", "./icons/icon-192.png", "./icons/icon-512.png"]) {
    ok(entries.includes(required), "PRECACHE sem " + required);
  }
  eq(new Set(entries).size, entries.length, "PRECACHE com entradas duplicadas");
  for (const entry of entries) {
    ok(!/^https?:/i.test(entry), "PRECACHE com URL absoluta: " + entry);
  }
  note("PRECACHE (" + entries.length + "): " + entries.join(" "));
});

test("sw: todo arquivo do PRECACHE existe em disco", () => {
  for (const entry of extractPrecache()) {
    const rel = entry.replace(/^\.\//, "");
    if (!rel) continue; // "./" é a raiz servida pelo servidor
    ok(existsSync(join(ROOT, rel)), "PRECACHE aponta para arquivo inexistente: " + entry);
  }
});

// ==========================================================================
// 2. install
// ==========================================================================
test("sw: install pré-cacheia todos os arquivos com cache:'reload'", async () => {
  const env = createSW();
  await env.install();
  const entries = extractPrecache();
  eq(env.addCalls.length, entries.length, "quantidade de add()");
  eq(env.addCalls.map((c) => c.url).sort().join("|"), entries.map((e) => env.abs(e)).sort().join("|"), "URLs do precache");
  for (const call of env.addCalls) eq(call.cache, "reload", "cache:'reload' em " + call.url);
  for (const entry of entries) {
    const rel = entry.replace(/^\.\//, "");
    if (!rel) continue;
    ok(env.hasCacheEntry(env.CACHE, entry), "não entrou no cache: " + entry);
  }
});

test("sw: install NÃO chama skipWaiting (atualização só com consentimento)", async () => {
  const env = createSW();
  await env.install();
  eq(env.skipWaits.length, 0, "skipWaiting no install");
});

test("sw: install tolera um asset 404 e instala o restante", async () => {
  const env = createSW();
  env.setFailAdd((url) => url.indexOf("favicon.svg") !== -1);
  let error = null;
  try {
    await env.install();
  } catch (e) {
    error = e;
  }
  eq(error, null, "install rejeitou por causa de 1 asset: " + (error && error.message));
  eq(env.skipWaits.length, 0, "skipWaiting no install tolerante");
  eq(env.addCalls.length, extractPrecache().length, "tentou todos os assets");
  ok(!env.hasCacheEntry(env.CACHE, "./icons/favicon.svg"), "asset com 404 não deveria estar no cache");
  ok(env.hasCacheEntry(env.CACHE, "./index.html"), "index.html deveria estar no cache");
});

test("sw: install resolve mesmo se todos os assets falharem", async () => {
  const env = createSW();
  env.setFailAdd(() => true);
  let error = null;
  try {
    await env.install();
  } catch (e) {
    error = e;
  }
  eq(error, null, "install rejeitou com todos os assets fora do ar");
  eq(env.skipWaits.length, 0, "skipWaiting indevido");
});

// ==========================================================================
// 3. activate
// ==========================================================================
test("sw: activate apaga somente caches antigos do próprio app", async () => {
  const env = createSW();
  env.store.set(env.CACHE, new Map());
  env.store.set("abastece-certo-v1", new Map());
  env.store.set("abastece-certo-v2.0.0", new Map());
  env.store.set("outro-app-v1", new Map());
  env.store.set("abastece-certo-", new Map());
  await env.activate();
  const removed = env.deleted.slice().sort();
  eq(removed.join(","), ["abastece-certo-", "abastece-certo-v1", "abastece-certo-v2.0.0"].sort().join(","), "caches removidos");
  ok(!env.deleted.includes(env.CACHE), "não pode apagar o cache da versão atual");
  ok(!env.deleted.includes("outro-app-v1"), "não pode apagar cache de outro app");
  ok(env.store.has(env.CACHE), "cache atual preservado");
});

test("sw: activate chama clients.claim", async () => {
  const env = createSW();
  await env.activate();
  eq(env.claimCalls.length, 1, "clients.claim()");
});

test("sw: activate não remove caches quando não há versões antigas", async () => {
  const env = createSW();
  env.store.set(env.CACHE, new Map());
  await env.activate();
  eq(env.deleted.length, 0, "nada removido");
  eq(env.claimCalls.length, 1, "claim mesmo assim");
});

// ==========================================================================
// 4. message
// ==========================================================================
test("sw: message SKIP_WAITING chama skipWaiting", () => {
  const env = createSW();
  env.message({ type: "SKIP_WAITING" });
  eq(env.skipWaits.length, 1, "skipWaiting chamado");
});

test("sw: message sem tipo/desconhecido é ignorada", () => {
  const env = createSW();
  env.message(null);
  env.message(undefined);
  env.message({});
  env.message({ type: "OUTRA_COISA" });
  eq(env.skipWaits.length, 0, "skipWaiting indevido");
});

// ==========================================================================
// 5. filtros do fetch
// ==========================================================================
test("sw: não intercepta métodos diferentes de GET", () => {
  const env = createSW();
  for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
    const result = env.runFetch(env.abs("api"), { method });
    eq(result.intercepted, false, method + " não deveria ser interceptado");
  }
});

test("sw: não intercepta requisições cross-origin", () => {
  const env = createSW();
  const result = env.runFetch("https://cdn.example.com/imagem.png", { mode: "no-cors" });
  eq(result.intercepted, false, "cross-origin interceptado");
});

test("sw: não intercepta o próprio sw.js (inclusive com query)", () => {
  const env = createSW();
  for (const url of [env.abs("sw.js"), env.abs("sw.js?v=3"), env.abs("sub/sw.js")]) {
    const result = env.runFetch(url, { mode: "no-cors" });
    eq(result.intercepted, false, "sw.js interceptado: " + url);
  }
});

// ==========================================================================
// 6. network-first (navegação)
// ==========================================================================
test("sw: navegação online usa a rede e atualiza o cache", async () => {
  const env = createSW();
  const url = env.abs("?modo=preciso");
  const result = env.runFetch(url, { mode: "navigate" });
  eq(result.intercepted, true, "navegação deveria ser interceptada");
  const response = await result.responded;
  eq(response.status, 200, "status da navegação");
  eq(await response.text(), "net:" + url, "veio da rede");
  eq(env.putCalls.length, 1, "gravou no cache");
  eq(env.putCalls[0].url, url, "URL gravada");
  eq(env.putCalls[0].name, env.CACHE, "cache versionado");
});

test("sw: navegação online com HTTP 404 devolve 404 e não cacheia", async () => {
  const env = createSW();
  env.setNet({ status: 404 });
  const url = env.abs("rota-inexistente");
  const result = env.runFetch(url, { mode: "navigate" });
  const response = await result.responded;
  eq(response.status, 404, "status propagado");
  eq(response.ok, false, "resposta não-ok");
  eq(env.putCalls.length, 0, "não pode cachear erro HTTP");
});

test("sw: navegação offline usa o cache da própria URL", async () => {
  const env = createSW();
  const url = env.abs("?modo=preciso");
  env.seed(env.CACHE, url, "cached-navegacao");
  env.setNet("fail");
  const response = await env.runFetch(url, { mode: "navigate" }).responded;
  eq(await response.text(), "cached-navegacao", "serviu do cache");
});

test("sw: navegação offline cai para index.html quando a URL não está no cache", async () => {
  const env = createSW();
  env.seed(env.CACHE, "./index.html", "cached-index");
  env.setNet("fail");
  const response = await env.runFetch(env.abs("qualquer/rota?x=1"), { mode: "navigate" }).responded;
  eq(await response.text(), "cached-index", "fallback index.html");
});

test("sw: navegação offline cai para './' quando não há index.html cacheado", async () => {
  const env = createSW();
  env.seed(env.CACHE, "./", "cached-raiz");
  env.setNet("fail");
  const response = await env.runFetch(env.abs("rota"), { mode: "navigate" }).responded;
  eq(await response.text(), "cached-raiz", "fallback raiz do escopo");
});

test("sw: navegação offline sem nenhum cache rejeita a promessa", async () => {
  const env = createSW();
  env.setNet("fail");
  let error = null;
  try {
    await env.runFetch(env.abs("sem-cache"), { mode: "navigate" }).responded;
  } catch (e) {
    error = e;
  }
  ok(error, "a promessa deveria rejeitar (sem fallback offline)");
  note("rejeição esperada: " + (error && error.message));
});

test("sw: fallback de navegação funciona em subpasta/escopo arbitrário", async () => {
  const env = createSW({ base: "https://example.com/apps/abastece-certo/" });
  env.seed(env.CACHE, "./index.html", "subpasta-index");
  env.setNet("fail");
  const response = await env.runFetch("https://example.com/apps/abastece-certo/pagina/x", {
    mode: "navigate"
  }).responded;
  eq(await response.text(), "subpasta-index", "fallback relativo ao escopo");
});

// ==========================================================================
// 7. stale-while-revalidate (assets)
// ==========================================================================
test("sw: SWR serve o cache na hora e revalida em background", async () => {
  const env = createSW();
  const url = env.abs("icons/icon-192.png");
  env.seed(env.CACHE, url, "icon-antigo");
  const response = await env.runFetch(url).responded;
  eq(await response.text(), "icon-antigo", "serviu o cache rapidamente");
  await env.tick();
  eq(env.fetchCalls.length, 1, "buscou a rede em background");
  const updated = env.cacheEntry(env.CACHE, url);
  ok(updated, "cache deveria existir");
  eq(await updated.text(), "net:" + url, "cache revalidado");
});

test("sw: SWR cache miss online busca na rede e cacheia", async () => {
  const env = createSW();
  const url = env.abs("precos.json");
  const response = await env.runFetch(url).responded;
  eq(await response.text(), "net:" + url, "veio da rede");
  await env.tick();
  const cached = env.cacheEntry(env.CACHE, url);
  ok(cached, "asset novo não foi cacheado");
  eq(await cached.text(), "net:" + url, "conteúdo cacheado");
});

test("sw: SWR cache miss offline devolve Response.error()", async () => {
  const env = createSW();
  env.setNet("fail");
  const response = await env.runFetch(env.abs("nao-existe.js")).responded;
  eq(response.status, 0, "status de Response.error()");
  eq(response.ok, false, "Response.error() não é ok");
});

test("sw: SWR não grava respostas de erro no cache", async () => {
  const env = createSW();
  env.setNet({ status: 500 });
  const url = env.abs("assets/erro.js");
  const response = await env.runFetch(url).responded;
  eq(response.status, 500, "erro propagado");
  await env.tick();
  eq(env.putCalls.length, 0, "não pode cachear HTTP 500");
});

// ==========================================================================
// 8. resiliência a falhas de quota
// ==========================================================================
test("sw: falha no cache.put não derruba a navegação online", async () => {
  const env = createSW();
  env.setFailPut(true);
  const response = await env.runFetch(env.abs("index.html"), { mode: "navigate" }).responded;
  eq(response.status, 200, "navegação continua servida");
  eq(await response.text(), "net:" + env.abs("index.html"), "resposta da rede íntegra");
});

test("sw: falha no cache.put não gera rejeição não tratada", async () => {
  const env = createSW();
  env.setFailPut(true);
  await env.runFetch(env.abs("?x=1"), { mode: "navigate" }).responded;
  await env.runFetch(env.abs("icons/icon-192.png")).responded;
  await env.tick();
  await sleep(20);
  eq(unhandledRejections.length, 0, "rejeições não tratadas: " + unhandledRejections.map(String).join(" | "));
});

test("sw: SWR com cache e rede offline não rejeita em background", async () => {
  const env = createSW();
  const url = env.abs("manifest.webmanifest");
  env.seed(env.CACHE, url, "manifest-antigo");
  env.setNet("fail");
  const response = await env.runFetch(url).responded;
  eq(await response.text(), "manifest-antigo", "cache servido");
  await env.tick();
  await sleep(20);
  eq(unhandledRejections.length, 0, "rejeição em background: " + unhandledRejections.map(String).join(" | "));
});

// ==========================================================================
// 9. robustez final
// ==========================================================================
test("sw: nenhuma rejeição de Promise sem tratamento durante a suíte", async () => {
  await sleep(50);
  eq(unhandledRejections.length, 0, unhandledRejections.map((r) => String((r && r.message) || r)).join(" | "));
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
