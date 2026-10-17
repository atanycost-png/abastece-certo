// Revisão adversarial da v2 — harness sem dependências (Node >=20).
// Lê index.html e sw.js reais e executa em node:vm com DOM/Cache stubs.
//
// Uso: node research/review-v2.mjs
// Não edita nada; escreve apenas no console (evidências para research/REVISAO-V2.md).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const swSrc = readFileSync(join(ROOT, "sw.js"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const findings = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log("  ok    " + name);
  } catch (e) {
    findings.push({ name, message: e.message });
    console.log("  FAIL  " + name + "\n        " + e.message);
  }
}
function eq(a, b, name) { check(name || "igualdade", () => { if (!Object.is(a, b)) throw new Error(`esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)}`); }); }
function ok(c, name) { check(name || "condição", () => { if (!c) throw new Error("condição falsa"); }); }

// ------------------------------------------------------------------ DOM stub
function makeEnv(opts = {}) {
  const {
    storageInit = {},
    storageThrows = false,
    protocol = "https:",
    search = "",
    withSW = false,
    swController = true,
    swWaiting = null
  } = opts;

  const reloads = [];
  const timers = [];
  const idEls = {};
  const winHandlers = {};
  const swHandlers = {};

  function makeClassList(classes) {
    return {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); },
      toggle(c, force) {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      }
    };
  }

  function el(id, init = {}) {
    const classes = new Set(init.classes || []);
    const attrs = Object.assign({}, init.attrs || {});
    const handlers = {};
    const o = {
      id,
      handlers,
      attrs,
      style: {},
      children: [],
      hidden: !!init.hidden,
      disabled: !!init.disabled,
      focused: false,
      textContent: "",
      innerHTML: "",
      onclick: null,
      value: init.value === undefined ? "" : String(init.value),
      classList: makeClassList(classes),
      _classes: classes,
      setAttribute(k, v) { attrs[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
      removeAttribute(k) { delete attrs[k]; },
      hasAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k); },
      addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
      focus() { if (doc) doc.activeElement = o; o.focused = true; },
      appendChild(c) { o.children.push(c); return c; },
      removeChild(c) { o.children = o.children.filter((x) => x !== c); return c; },
      select() {},
      setSelectionRange() {},
      querySelectorAll() { return []; }
    };
    if (init.sanitize) {
      let v = o.value;
      Object.defineProperty(o, "value", {
        get() { return v; },
        set(x) { v = init.sanitize(String(x)); }
      });
      o.value = v;
    }
    return o;
  }

  const ids = {};
  const doc = {
    getElementById: (id) => ids[id],
    createElement: (tag) => el("created-" + tag),
    body: { appendChild() {}, removeChild() {} },
    head: { appendChild() {} },
    execCommand() { return true; },
    activeElement: null
  };

  const map = new Map(Object.entries(storageInit));
  const localStorage = {
    getItem(k) { if (storageThrows) throw new Error("SecurityError"); return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { if (storageThrows) throw new Error("QuotaExceededError"); map.set(k, String(v)); },
    removeItem(k) { map.delete(k); }
  };

  const loc = {
    protocol,
    search,
    href: "https://example.com/repo/index.html",
    reload() { reloads.push(Date.now()); }
  };

  const reg = {
    waiting: swWaiting,
    installing: null,
    addEventListener(t, fn) { (reg._h = reg._h || {}); (reg._h[t] = reg._h[t] || []).push(fn); }
  };

  const navigator = {
    onLine: true,
    share: undefined,
    clipboard: undefined
  };
  if (withSW) {
    navigator.serviceWorker = {
      controller: swController ? {} : null,
      register: () => Promise.resolve(reg),
      addEventListener(t, fn) { (swHandlers[t] = swHandlers[t] || []).push(fn); },
      _reg: reg,
      _handlers: swHandlers
    };
  }

  const win = {
    addEventListener(t, fn) { (winHandlers[t] = winHandlers[t] || []).push(fn); },
    location: loc,
    _handlers: winHandlers
  };

  const sandbox = {
    document: doc,
    window: win,
    navigator,
    location: loc,
    localStorage,
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    Intl,
    Math,
    Date
  };
  sandbox.globalThis = sandbox;

  // ids usados pelo app — PRECISAM existir antes de executar o script inline
  ids["gas"] = el("gas"); ids["eta"] = el("eta");
  ids["gasHint"] = el("gasHint"); ids["etaHint"] = el("etaHint");
  ids["tab-fast"] = el("tab-fast", { attrs: { "aria-selected": "true", tabindex: "0" } });
  ids["tab-precise"] = el("tab-precise", { attrs: { "aria-selected": "false", tabindex: "-1" } });
  ids["panel-fast"] = el("panel-fast");
  ids["panel-precise"] = el("panel-precise", { hidden: true });
  ids["threshold"] = el("threshold", { value: "72", sanitize: (v) => { const n = Number(v); return isFinite(n) ? String(Math.min(85, Math.max(55, n))) : "72"; } });
  ids["thresholdVal"] = el("thresholdVal", { value: "" });
  const b72 = el("preset72", { attrs: { "data-t": "72" }, classes: ["active"] });
  const b71 = el("preset71", { attrs: { "data-t": "71" } });
  const b70 = el("preset70", { attrs: { "data-t": "70" } });
  const presetCar = el("presetCar", { hidden: true });
  const presets = el("presets");
  presets.querySelectorAll = (sel) => {
    if (sel !== "button[data-t]") return [];
    return [b72, b71, b70, presetCar].filter((b) => b.getAttribute("data-t") !== null);
  };
  presets._buttons = [b72, b71, b70, presetCar];
  ids["presets"] = presets;
  ids["presetCar"] = presetCar;
  ids["vehicleSelect"] = el("vehicleSelect");
  ids["vehName"] = el("vehName");
  ids["gasKmL"] = el("gasKmL"); ids["etaKmL"] = el("etaKmL");
  ids["gasKmLHint"] = el("gasKmLHint"); ids["etaKmLHint"] = el("etaKmLHint");
  ids["vehSave"] = el("vehSave"); ids["vehDelete"] = el("vehDelete");
  ids["resultOut"] = el("resultOut");
  ids["live"] = el("live");
  ids["toast"] = el("toast");
  ids["netBadge"] = el("netBadge", { hidden: true });
  ids["updateBar"] = el("updateBar", { hidden: true });
  ids["updateBtn"] = el("updateBtn");
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: "index.html#inline" });

  function fire(target, type, event) {
    const handlers = target && target.handlers && target.handlers[type];
    if (!handlers) return false;
    for (const fn of handlers) fn(event || {});
    return true;
  }
  function fireWindow(type, event) {
    const handlers = win._handlers[type] || [];
    for (const fn of handlers) fn(event || {});
    return handlers.length;
  }
  function fireSW(type, event) {
    const handlers = (navigator.serviceWorker && navigator.serviceWorker._handlers[type]) || [];
    for (const fn of handlers) fn(event || {});
    return handlers.length;
  }

  return { sandbox, ids, win, loc, map, reloads, reg, navigator, fire, fireWindow, fireSW, presets };
}

// ============================================================ A. DOM / UI
console.log("\n=== A. Inicialização, render, parser no fluxo da UI ===");

function render(el, value) {
  el.value = value;
  el.handlers.input[0]();
}

{
  const env = makeEnv();
  const out = env.ids.resultOut.innerHTML;
  ok(out.indexOf("Informe os dois preços") !== -1, "estado inicial mostra 'Informe os dois preços'");
  eq(env.ids.thresholdVal.textContent, "72%", "limite padrão exibido 72%");
  eq(env.ids.threshold.value, "72", "slider padrão 72");
  eq(env.ids["panel-precise"].hidden, true, "painel preciso começa oculto");
  eq(env.ids["tab-fast"].getAttribute("aria-selected"), "true", "aba Rápido selecionada");
  eq(env.ids.presets._buttons[0].getAttribute("aria-pressed"), "true", "preset 72 aria-pressed=true");
  eq(env.ids.presets._buttons[2].getAttribute("aria-pressed"), "false", "preset 70 aria-pressed=false");
}

{
  // fluxo rápido normal
  const env = makeEnv();
  render(env.ids.gas, "5,89");
  render(env.ids.eta, "3,99");
  const out = env.ids.resultOut.innerHTML;
  ok(out.includes("67,7"), "rápido: índice 67,7%");
  ok(out.includes("Abasteça com ETANOL"), "rápido: veredito etanol");
  ok(out.includes("4,3 p.p. abaixo do limite"), "rápido: texto abaixo do limite (limite 72%)");
  ok(out.includes("dot-ratio green"), "rápido: ponto verde");
  ok(!/NaN|undefined|Infinity/.test(out), "rápido: sem NaN/Infinity no DOM");
  await sleep(400);
  ok(env.ids.live.textContent.includes("67,7"), "aria-live anuncia índice (debounce)");
}

{
  // empate: decisão, texto e cor na mesma fonte
  const env = makeEnv();
  env.ids.threshold.value = "70";
  env.fire(env.ids.threshold, "input");
  render(env.ids.gas, "5,00");
  render(env.ids.eta, "3,51");
  const out = env.ids.resultOut.innerHTML;
  ok(out.includes("Empate técnico"), "empate: veredito empate");
  ok(out.includes("dentro da margem"), "empate: texto 'dentro da margem'");
  ok(!/acima do limite|abaixo do limite/.test(out), "empate: nunca diz acima/abaixo");
  ok(out.includes("dot-ratio amber"), "empate: ponto âmbar");
}

{
  // entrada inválida
  const env = makeEnv();
  render(env.ids.gas, "abc");
  render(env.ids.eta, "3,99");
  eq(env.ids.gas.getAttribute("aria-invalid"), "true", "inválido: aria-invalid=true");
  ok(env.ids.gasHint.textContent.includes("Valor inválido"), "inválido: dica textual");
  ok(env.ids.resultOut.innerHTML.includes("Informe os dois preços"), "inválido: volta ao estado vazio");
  await sleep(400);
  ok(env.ids.live.textContent.includes("inválido"), "inválido: erro é anunciado em região viva (hoje só dica visual)");
}

{
  // PARSER no fluxo real: ponto com 3 casas
  const env = makeEnv();
  render(env.ids.gas, "5.899");
  render(env.ids.eta, "4,099");
  const out = env.ids.resultOut.innerHTML;
  const label = (out.match(/class="label">([\s\S]*?)<\/div>/) || [])[1] || "";
  console.log("    [evidência] gas '5.899' + eta '4,099' => label:", label.replace(/\s+/g, " ").trim());
  console.log("    [evidência] warnings:", (out.match(/<li>([\s\S]*?)<\/li>/g) || []).map((s) => s.replace(/<[^>]+>/g, "")).join(" | "));
}

{
  // limite na fronteira: regra documentada |diff| < 0,5 -> exatamente 0,5 não é empate
  const env = makeEnv();
  env.ids.threshold.value = "70";
  env.fire(env.ids.threshold, "input");
  render(env.ids.gas, "5,00");
  render(env.ids.eta, "3,475"); // 69,50000000000001% => diff -0,49999999999999
  const out = env.ids.resultOut.innerHTML;
  console.log("    [evidência] 5,00/3,475/70% => veredito:", (out.match(/class="verdict ([a-z]+)"/) || [])[1],
    "| label:", ((out.match(/class="label">([\s\S]*?)<\/div>/) || [])[1] || "").replace(/\s+/g, " ").trim());
}

{
  // extremo: preço minúsculo => ratio Infinity, formato com guarda
  const env = makeEnv();
  render(env.ids.gas, "0," + "0".repeat(322) + "5");
  render(env.ids.eta, "5");
  const out = env.ids.resultOut.innerHTML;
  ok(!/NaN|undefined|Infinity/.test(out), "extremo: sem literal NaN/Infinity no DOM");
  console.log("    [evidência] extremo 5e-323/5 => resultado:", out.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220));
}

{
  // modo preciso normal
  const env = makeEnv();
  env.fire(env.ids["tab-precise"], "click");
  eq(env.ids["panel-precise"].hidden, false, "preciso: painel visível após clique");
  render(env.ids.gas, "6,54");
  render(env.ids.eta, "4,14");
  render(env.ids.gasKmL, "12,0");
  render(env.ids.etaKmL, "8,6");
  const out = env.ids.resultOut.innerHTML;
  ok(out.includes("R$ 6,36"), "preciso: economia R$ 6,36/100 km");
  ok(out.includes("R$ 54,50") && out.includes("R$ 48,14"), "preciso: custos por 100 km");
  ok(out.includes("71,7%"), "preciso: limite pessoal 71,7%");
  ok(!/NaN|undefined|Infinity/.test(out), "preciso: sem NaN/Infinity");
}

{
  // migração v1
  const env = makeEnv({ storageInit: { ac_gas: "5,89", ac_eta: "3,99", ac_threshold: "70" } });
  eq(env.ids.gas.value, "5,89", "migração v1: preço gasolina");
  eq(env.ids.eta.value, "3,99", "migração v1: preço etanol");
  eq(env.ids.threshold.value, "70", "migração v1: limite 70 preservado");
  ok(env.map.has("ac.v2"), "migração v1: ac.v2 gravado após init");
  const saved = JSON.parse(env.map.get("ac.v2"));
  eq(saved.threshold, 70, "migração v1: ac.v2.threshold 70");
  console.log("    [evidência] migração v1 com ac_threshold=70 => limite continua 70 (default novo é 72)");
  eq(saved.threshold, 72, "migração v1: limite 70 herdado deve virar 72/E32 ou avisar o usuário (decisão pendente)");
}

{
  // degradação de threshold corrompido no ac.v2
  for (const [raw, expected] of [
    ['{"threshold":null}', "55"],
    ['{"threshold":""}', "55"],
    ['{"threshold":"abc"}', "72"],
    ['{"threshold":100}', "85"]
  ]) {
    const env = makeEnv({ storageInit: { "ac.v2": raw } });
    eq(env.ids.threshold.value, expected, `ac.v2 ${raw} -> slider ${expected}`);
  }
  // JSON com threshold null/"" vira 0 -> clamp 55 (mínimo), não o default 72
  const envNull = makeEnv({ storageInit: { "ac.v2": '{"threshold":null}' } });
  eq(envNull.ids.threshold.value, "72", "ac.v2 threshold null deve cair no default 72 (hoje cai em 55)");
}

// ============================================================ B. XSS
console.log("\n=== B. XSS / injeção de HTML ===");
{
  const payload = '<img src=x onerror=alert(1)>';
  const env = makeEnv({
    storageInit: {
      "ac.v2": JSON.stringify({
        mode: "precise", threshold: 72,
        vehicles: [{ id: "v1", name: payload, gasKmL: 12, etaKmL: 8.6 }],
        activeId: "v1"
      })
    }
  });
  const selHtml = env.ids.vehicleSelect.innerHTML;
  ok(!selHtml.includes("<img"), "XSS nome salvo: não injeta <img>");
  ok(selHtml.includes("&lt;img"), "XSS nome salvo: escapado como &lt;img");
}

{
  const idPayload = '"><img src=x onerror=alert(1)>';
  const env = makeEnv({
    storageInit: {
      "ac.v2": JSON.stringify({
        mode: "precise", threshold: 72,
        vehicles: [{ id: idPayload, name: "ok", gasKmL: 12, etaKmL: 8.6 }],
        activeId: idPayload
      })
    }
  });
  const selHtml = env.ids.vehicleSelect.innerHTML;
  ok(!selHtml.includes("<img"), "XSS id salvo: não injeta <img> (id vai sem escape)");
}

{
  const payload = '"><svg onload=alert(1)>';
  const env = makeEnv();
  env.fire(env.ids["tab-precise"], "click");
  render(env.ids.gas, "6,54");
  render(env.ids.eta, "4,14");
  render(env.ids.gasKmL, "12,0");
  render(env.ids.etaKmL, "8,6");
  env.ids.vehName.value = payload;
  env.fire(env.ids.vehSave, "click");
  const selHtml = env.ids.vehicleSelect.innerHTML;
  ok(!selHtml.includes("<svg"), "XSS nome digitado: não injeta <svg>");
  ok(selHtml.includes("&lt;svg"), "XSS nome digitado: escapado");
  const out = env.ids.resultOut.innerHTML;
  ok(!out.includes("<svg onload"), "XSS nome digitado: resultado sem injeção");
}

// ============================================================ C. storage / perfis
console.log("\n=== C. Persistência, perfis e limites ===");
{
  const env = makeEnv();
  env.fire(env.ids["tab-precise"], "click");
  render(env.ids.gas, "6,54");
  render(env.ids.eta, "4,14");
  render(env.ids.gasKmL, "12,0");
  render(env.ids.etaKmL, "8,6");
  env.ids.vehName.value = "Onix";
  env.fire(env.ids.vehSave, "click");
  const saved = JSON.parse(env.map.get("ac.v2"));
  eq(saved.vehicles.length, 1, "salvar veículo: 1 veículo no storage");
  eq(saved.vehicles[0].name, "Onix", "salvar veículo: nome");
  eq(saved.activeId, saved.vehicles[0].id, "salvar veículo: activeId");
  // preset "seu carro": rótulo arredonda, clique aplica arredondado no slider
  const p = 8.6 / 12 * 100; // 71,666...
  const carBtn = env.ids.presets._buttons[3];
  const label = carBtn.innerHTML.replace(/<[^>]+>/g, "");
  const dt = carBtn.getAttribute("data-t");
  console.log("    [evidência] preset 'seu carro': rótulo='" + label + "', data-t=" + dt + " (personalPct=" + p.toFixed(3) + ")");
  env.presets._buttons[3].getAttribute("data-t");
  env.fire(env.ids.presets, "click", { target: { closest: () => carBtn } });
  console.log("    [evidência] após clicar: thresholdVal='" + env.ids.thresholdVal.textContent + "', data-t=" + carBtn.getAttribute("data-t"));
  ok(carBtn.innerHTML.includes("71,7") && env.ids.thresholdVal.textContent === "71,7%",
    "preset 'seu carro' aplica o mesmo valor que exibe (rótulo 71,7% vs aplicado 71,5%)");
}
{
  // round-trip de valores com notação científica: consumo minúsculo
  const env = makeEnv();
  env.fire(env.ids["tab-precise"], "click");
  render(env.ids.gas, "6,54");
  render(env.ids.eta, "4,14");
  render(env.ids.gasKmL, "0,0000001");
  render(env.ids.etaKmL, "8,6");
  env.ids.vehName.value = "X";
  env.fire(env.ids.vehSave, "click");
  const saved = JSON.parse(env.map.get("ac.v2"));
  console.log("    [evidência] veículo com consumo 1e-7 salvo como gasKmL=", saved.vehicles[0] && saved.vehicles[0].gasKmL);
  // recarregar selecionando o veículo: toInputValue(1e-7) = "1e-7" (não reparseável)
  const env2 = makeEnv({ storageInit: { "ac.v2": env.map.get("ac.v2") } });
  const v = JSON.parse(env.map.get("ac.v2")).vehicles[0];
  env2.ids.vehicleSelect.value = v.id;
  env2.fire(env2.ids.vehicleSelect, "change");
  console.log("    [evidência] após reselecionar veículo: gasKmL.value='" + env2.ids.gasKmL.value + "', resultado=" +
    (env2.ids.resultOut.innerHTML.includes("Informe") ? "vazio" : "calculado"));
  ok(env2.ids.vehicleSelect.innerHTML.includes("X"), "veículo com consumo 1e-7 sobrevive ao reload (hoje é descartado)");
}
{
  // localStorage bloqueado: app precisa funcionar
  const env = makeEnv({ storageThrows: true });
  render(env.ids.gas, "5,89");
  render(env.ids.eta, "3,99");
  ok(env.ids.resultOut.innerHTML.includes("67,7"), "storage bloqueado: cálculo funciona");
}

{
  // atalho ?modo=preciso fixa o modo e ignora a preferência salva depois do reload
  const e1 = makeEnv({ search: "?modo=preciso" });
  eq(e1.ids["tab-precise"].getAttribute("aria-selected"), "true", "query ?modo=preciso abre em Preciso");
  e1.fire(e1.ids["tab-fast"], "click"); // usuário volta para Rápido
  const saved = JSON.parse(e1.map.get("ac.v2"));
  eq(saved.mode, "fast", "query: escolha Rápido é salva");
  const e2 = makeEnv({ search: "?modo=preciso", storageInit: { "ac.v2": e1.map.get("ac.v2") } });
  eq(e2.ids["tab-fast"].getAttribute("aria-selected"), "true", "reload com ?modo=preciso respeita o modo salvo (hoje força Preciso)");
}

{
  const envBig = makeEnv();
  render(envBig.ids.gas, "0,000000001");
  render(envBig.ids.eta, "5");
  const big = (envBig.ids.resultOut.innerHTML.match(/class="big">([^<]*)</) || [])[1] || "";
  console.log("    [evidência] gas 0,000000001 + eta 5 => big=" + JSON.stringify(big) + " (len=" + big.length + ")");
  ok(big.length <= 12, "números extremos não estouram o layout (big=" + big + ")");
}

// ============================================================ D. file://
console.log("\n=== D. file:// ===");
{
  const env = makeEnv({ protocol: "file:", storageThrows: true });
  render(env.ids.gas, "5,89");
  render(env.ids.eta, "3,99");
  ok(env.ids.resultOut.innerHTML.includes("ETANOL"), "file://: cálculo funciona sem SW/localStorage");
  ok((env.win._handlers.load || []).length === 0, "file://: nenhum handler de registro de SW pendente");
}

// ============================================================ E. update flow
console.log("\n=== E. Ciclo de atualização do SW no app ===");
{
  const env = makeEnv({ withSW: true, swController: true, swWaiting: { postMessage() { (env._msgs = env._msgs || []).push(arguments); } } });
  // recria com referência para mensagens
}
{
  const posted = [];
  const regWaiting = { postMessage: (m) => posted.push(m) };
  const env = makeEnv({ withSW: true, swController: true, swWaiting: regWaiting });
  await sleep(0);
  env.fireWindow("load");
  await sleep(10);
  eq(env.ids.updateBar.hidden, false, "update: barra aparece quando há versão em espera");
  env.ids.updateBtn.onclick();
  ok(posted.some((m) => m && m.type === "SKIP_WAITING"), "update: botão envia SKIP_WAITING");
  env.fireSW("controllerchange");
  eq(env.reloads.length, 1, "update: controllerchange recarrega uma vez");
  env.fireSW("controllerchange");
  eq(env.reloads.length, 1, "update: guarda 'refreshing' evita reload duplo");
}
{
  // primeira visita: controllerchange por clients.claim também recarrega
  const env = makeEnv({ withSW: true, swController: false });
  env.fireSW("controllerchange");
  console.log("    [evidência] controllerchange na 1ª visita => reloads:", env.reloads.length, "(clients.claim sem consentimento)");
  eq(env.reloads.length, 0, "1ª visita: não recarrega a página sem consentimento do usuário");
}

// ============================================================ F. SW harness
console.log("\n=== F. Service worker (lógica em node:vm) ===");
async function swHarness() {
  const BASE = "https://example.com/repo/";
  const store = new Map(); // name -> Map(url -> Response)
  const addCalls = [];
  const putCalls = [];
  const skipCalls = [];
  const claimCalls = [];
  const deleted = [];
  const handlers = {};
  let failUrl = null;
  let fetchMode = "ok";

  const abs = (u) => new URL(u, BASE).href;
  function makeResponse(body, status = 200) {
    return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
  }
  function cacheFor(name) {
    return {
      async add(req) {
        const url = req.url;
        addCalls.push({ name, url, cache: req.cache });
        if (failUrl && url.includes(failUrl)) throw new Error("404 simulado");
        const r = makeResponse("cached:" + url);
        store.get(name).set(url, r);
        return undefined;
      },
      async put(req, res) {
        const url = typeof req === "string" ? abs(req) : req.url;
        putCalls.push({ name, url });
        store.get(name).set(url, res);
        return undefined;
      },
      async match(req) {
        const url = typeof req === "string" ? abs(req) : req.url;
        return store.get(name).get(url);
      }
    };
  }
  const caches = {
    async open(name) { if (!store.has(name)) store.set(name, new Map()); return cacheFor(name); },
    async keys() { return [...store.keys()]; },
    async delete(name) { deleted.push(name); return store.delete(name); },
    async match(req) { const url = typeof req === "string" ? abs(req) : req.url; for (const [name, m] of store) if (m.has(url)) return m.get(url); return undefined; }
  };
  class Req {
    constructor(url, opts = {}) { this.url = abs(url); this.cache = opts.cache; this.method = opts.method || "GET"; }
  }
  const self = {
    location: { origin: "https://example.com" },
    addEventListener(t, fn) { handlers[t] = fn; },
    skipWaiting() { skipCalls.push(1); },
    clients: { async claim() { claimCalls.push(1); } }
  };
  const fetchStub = async (req) => {
    const url = typeof req === "string" ? abs(req) : req.url;
    if (fetchMode === "fail") throw new Error("offline");
    return makeResponse("net:" + url, 200);
  };
  const sandbox = { self, caches, fetch: fetchStub, Request: Req, Response, URL, Promise, console, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(swSrc, sandbox, { filename: "sw.js" });

  // install
  let installPromise;
  handlers.install({ waitUntil(p) { installPromise = p; } });
  await installPromise;
  eq(addCalls.length, 8, "SW: 8 arquivos no precache");
  ok(addCalls.every((c) => c.cache === "reload"), "SW: precache usa cache:'reload'");
  eq(skipCalls.length, 0, "SW: install NÃO chama skipWaiting");

  // install com 1 falha tolerado
  store.clear(); addCalls.length = 0; skipCalls.length = 0;
  failUrl = "favicon.svg";
  installPromise = null;
  handlers.install({ waitUntil(p) { installPromise = p; } });
  let installOk = true;
  try { await installPromise; } catch (e) { installOk = false; }
  ok(installOk, "SW: install tolera 1 arquivo com 404");
  eq(skipCalls.length, 0, "SW: install tolerante continua sem skipWaiting");
  failUrl = null;

  // caches antes do activate
  for (const n of ["abastece-certo-v1", "abastece-certo-v2.0.0", "outro-app-v1"]) store.set(n, new Map());
  deleted.length = 0;
  let activatePromise;
  handlers.activate({ waitUntil(p) { activatePromise = p; } });
  await activatePromise;
  ok(deleted.includes("abastece-certo-v1"), "SW: activate apaga cache antigo do próprio app");
  ok(!deleted.includes("outro-app-v1"), "SW: activate NÃO apaga cache de outro app");
  ok(!deleted.includes("abastece-certo-v2.0.0"), "SW: activate mantém o cache atual");
  eq(claimCalls.length, 1, "SW: activate chama clients.claim");

  // mensagem SKIP_WAITING
  handlers.message({ data: { type: "SKIP_WAITING" } });
  eq(skipCalls.length, 1, "SW: message SKIP_WAITING chama skipWaiting");

  // fetch: método e origem
  let responded = null;
  handlers.fetch({ request: { method: "POST", url: abs("x"), mode: "cors" }, respondWith(p) { responded = p; } });
  eq(responded, null, "SW: POST não é interceptado");
  responded = null;
  handlers.fetch({ request: { method: "GET", url: "https://cdn.example.com/a.png", mode: "no-cors" }, respondWith(p) { responded = p; } });
  eq(responded, null, "SW: cross-origin não é interceptado");
  responded = null;
  handlers.fetch({ request: { method: "GET", url: abs("sw.js"), mode: "no-cors" }, respondWith(p) { responded = p; } });
  eq(responded, null, "SW: sw.js não é interceptado");

  // navegação online: network-first grava no cache
  store.clear();
  const cacheNav = await caches.open("abastece-certo-v2.0.0");
  await cacheNav.put({ url: abs("index.html") }, makeResponse("cached-index"));
  await cacheNav.put({ url: abs("./") }, makeResponse("cached-root"));
  responded = null; let mode = "none";
  handlers.fetch({ request: { method: "GET", url: abs("?modo=preciso"), mode: "navigate" }, respondWith(p) { responded = p; } });
  const navRes = await responded;
  eq(navRes.status, 200, "SW: navegação online retorna rede");
  ok(navRes && putCalls.some((p) => p.url.includes("modo=preciso")), "SW: navegação online atualiza cache");

  // navegação offline: fallback index
  fetchMode = "fail";
  responded = null;
  handlers.fetch({ request: { method: "GET", url: abs("?x=1"), mode: "navigate" }, respondWith(p) { responded = p; } });
  let offRes = null;
  try { offRes = await responded; } catch (e) { offRes = null; }
  ok(offRes && offRes.status === 200, "SW: navegação offline cai para index.html em cache");
  fetchMode = "ok";

  // estático: SWR serve cache e revalida
  const cache = await caches.open("abastece-certo-v2.0.0");
  const iconUrl = abs("icons/icon-192.png");
  await cache.put({ url: iconUrl }, makeResponse("old-icon"));
  responded = null;
  handlers.fetch({ request: { method: "GET", url: iconUrl, mode: "no-cors" }, respondWith(p) { responded = p; } });
  const assetRes = await responded;
  const assetText = await assetRes.text();
  eq(assetText, "old-icon", "SW: estático em cache é servido");
  await sleep(0);
  eq((await (await cache.match({ url: iconUrl })).text()), "net:" + iconUrl, "SW: SWR revalida o estático em background");

  // estático offline sem cache
  fetchMode = "fail";
  responded = null;
  handlers.fetch({ request: { method: "GET", url: abs("nao-existe.js"), mode: "no-cors" }, respondWith(p) { responded = p; } });
  const missRes = await responded;
  eq(missRes.status, 0, "SW: estático sem cache offline retorna Response.error()");
  fetchMode = "ok";
}
await swHarness();

// ============================================================ G. limites/fronteiras do core
console.log("\n=== G. Fronteiras do core (strings do usuário) ===");
{
  const m = html.match(/\/\* CORE-START \*\/([\s\S]*?)\/\* CORE-END \*\//);
  const AC = vm.runInNewContext(m[1] + "\n;AC", {});
  const b1 = AC.fastResult("5", "3,475", 70);
  const b2 = AC.fastResult("5", "3,425", 68);
  const b3 = AC.fastResult("5", "3,525", 70);
  console.log("    [evidência] 5/3,475/70 =>", JSON.stringify({ pct: b1.pct, diffPp: b1.diffPp, verdict: b1.verdict, gapText: AC.gapText(b1) }));
  console.log("    [evidência] 5/3,425/68 =>", JSON.stringify({ pct: b2.pct, diffPp: b2.diffPp, verdict: b2.verdict }));
  console.log("    [evidência] 5/3,525/70 =>", JSON.stringify({ pct: b3.pct, diffPp: b3.diffPp, verdict: b3.verdict }));
  const d1 = AC.parseNumber("5.899");
  const d2 = AC.parseNumber("5,899");
  const d3 = AC.toInputValue(0.0000001);
  console.log("    [evidência] parseNumber('5.899')=" + d1 + " | parseNumber('5,899')=" + d2 + " | toInputValue(1e-7)=" + JSON.stringify(d3));
  const warn = AC.sanityWarnings(AC.preciseResult(6, 4, 12, 7)); // razão 58,3%
  console.log("    [evidência] consumo 58,3% => warnings:", JSON.stringify(warn));
  ok(warn.length > 0, "consumo 58,3% gera aviso coerente com o texto '65–80%'");
  eq(AC.parseNumber("5.899"), 5.899, "preço '5.899' (3 casas, ponto) deve ser 5,899 e não 5899");
  const bExact = AC.fastResult("6,0000", "3,2700", 55); // exatamente 0,5 p.p. abaixo -> regra: ETANOL
  eq(bExact.verdict, "etanol", "fronteira exata ±0,5 p.p. segue a regra documentada (< 0,5)");
  console.log("    [evidência] 6,0000/3,2700/55 =>", JSON.stringify({ diffPp: bExact.diffPp, verdict: bExact.verdict }));
  console.log("    [evidência] API numérica: parseNumber(3.475)=" + AC.parseNumber(3.475) + " (string '3,475'=" + AC.parseNumber("3,475") + ")");
}

// ============================================================ H. propriedades (render em massa)
console.log("\n=== H. Consistência decisão × texto × cor em massa ===");
{
  const env = makeEnv();
  const br = (n, d = 3) => n.toFixed(d).replace(".", ",");
  let seed = 123456789;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let mismatches = [];
  for (let i = 0; i < 250; i++) {
    const t = [55, 60, 65, 70, 71, 72, 73, 75, 80, 85][i % 10];
    const g = Math.round((3 + rnd() * 7) * 1000) / 1000;
    const e = Math.round((2 + rnd() * 6) * 1000) / 1000;
    env.ids.threshold.value = String(t);
    env.fire(env.ids.threshold, "input");
    render(env.ids.gas, br(g));
    render(env.ids.eta, br(e));
    const out = env.ids.resultOut.innerHTML;
    const verdict = (out.match(/class="verdict ([a-z]+)"/) || [])[1];
    const dot = (out.match(/class="dot-ratio ([a-z]+)/) || [])[1];
    const pct = (e / g) * 100;
    const diff = pct - t;
    const expected = Math.abs(diff) < 0.5 ? "empate" : (diff < 0 ? "etanol" : "gasolina");
    const expectedDot = expected === "empate" ? "amber" : (expected === "etanol" ? "green" : "blue");
    const hasAbove = /acima do limite/.test(out);
    const hasBelow = /abaixo do limite/.test(out);
    if (verdict !== expected || dot !== expectedDot) mismatches.push({ g, e, t, pct, diff, verdict, expected, dot, expectedDot });
    if (verdict === "empate" && (hasAbove || hasBelow)) mismatches.push({ g, e, t, tipo: "texto contraditório", out: out.slice(0, 120) });
    if (/NaN|undefined|Infinity/.test(out)) mismatches.push({ g, e, t, tipo: "NaN/Infinity no DOM" });
  }
  ok(mismatches.length === 0, "250 casos aleatórios: decisão=texto=cor e sem NaN/Infinity" + (mismatches.length ? " => " + JSON.stringify(mismatches.slice(0, 3)) : ""));
}

// ============================================================ I. a11y/CSS/docs
console.log("\n=== I. Acessibilidade, CSS e docs ===");
{
  // foco do slider: :focus-visible genérico perde para input[type=range]{outline:none}
  ok(/input\[type=range\]:(focus|focus-visible)/.test(html), "slider tem regra de foco própria (:focus/:focus-visible)");
  ok(html.includes("aria-valuetext"), "slider expõe aria-valuetext (porcentagem)");
  ok(/id="updateBar"[^>]*role="status"|id="updateBar"[^>]*aria-live/.test(html), "barra de atualização é anunciada (role=status/aria-live)");
  ok(/class="hint"[^>]*aria-live|role="alert"/.test(html), "dicas de erro são anunciadas em região viva");
  // alvos de toque: README promete 44 px; CSS tem 40/34/28
  ok(!/min-height: 40px/.test(html) && !/min-height: 34px/.test(html) && !/min-height: 28px/.test(html),
    "todos os alvos de toque ≥44 px (README) — encontrados 40/34/28 px");
  ok(!/100vh/.test(html), "usa dvh/svh em vez de 100vh (barras móveis)");
  ok(/forced-colors/.test(html), "respeita forced-colors (alto contraste do SO)");
}
{
  // contraste calculado
  const hex = (h) => { const s = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)); };
  const blend = (fg, a, bg) => fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));
  const lum = (rgb) => { const ch = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }); return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]; };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const card = hex("#121a2e"), card2 = hex("#0d1526");
  const placeholder = ratio(hex("#7c89a3"), card2);
  const border = ratio(blend([255, 255, 255], 0.34, card2), card2);
  const muted = ratio(hex("#8a97b0"), card);
  ok(placeholder >= 4.5, "contraste do placeholder ≥4,5:1 (obtido " + placeholder.toFixed(2) + ")");
  ok(border >= 3, "contraste de borda de controle ≥3:1 (obtido " + border.toFixed(2) + ")");
  ok(muted >= 4.5, "contraste do texto muted ≥4,5:1 (obtido " + muted.toFixed(2) + ")");
}
{
  // docs × realidade
  const ref = readFileSync(join(ROOT, "REFERENCIA.md"), "utf8");
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const indexSize = (readFileSync(join(ROOT, "index.html")).length / 1024).toFixed(1);
  console.log("    [evidência] REFERENCIA: '41 checagens' vs check.mjs real: 43 verificações; '2 avisos' vs 1 aviso atual");
  console.log("    [evidência] REFERENCIA: 'index.html ~49 KB' vs real: " + indexSize + " KB");
  const smallTargets2 = /\.actions \.btn \{[^}]*min-height: 40px/.test(html) || /\.update-bar \.btn \{[^}]*min-height: 34px/.test(html) || /\.why summary \{[^}]*min-height: 28px/.test(html);
  ok(!/alvos de toque de 44 px/.test(readme) || !smallTargets2, "README 'alvos de toque de 44 px' é verdadeiro no CSS");
  ok(!/foco visível/.test(readme) || /input\[type=range\]:(focus|focus-visible)/.test(html), "README 'foco visível' é verdadeiro em todos os controles");
}

console.log("\n" + "=".repeat(60));
if (findings.length) {
  console.log(`FALHAS: ${findings.length} (de ${pass + findings.length} checagens)`);
  for (const f of findings) console.log("  • " + f.name + ": " + f.message);
} else {
  console.log(`OK — ${pass} checagens passaram (nenhuma falha no harness).`);
}
console.log("=".repeat(60));
process.exitCode = findings.length ? 1 : 0;
