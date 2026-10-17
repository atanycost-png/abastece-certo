// Auditoria da v1 — harness sem dependencias (Node >=18).
// Le o index.html real, executa o <script> inline em um DOM stub (node:vm)
// e imprime evidencias concretas usadas em research/AUDITORIA.md.
//
// Uso: node research/audit-v1.mjs
// NAO edita nada; apenas le index.html.

import { readFileSync } from "node:fs";
import vm from "node:vm";

// Snapshot imutavel da v1 (commit 2dd8ab6:index.html), para a auditoria nao
// depender do index.html em reescrita pela v2. Regenerar com:
//   git -C . show 2dd8ab6:index.html > research/v1-index-snapshot.html
const SNAPSHOT = new URL("v1-index-snapshot.html", import.meta.url);
const html = readFileSync(SNAPSHOT, "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) {
  console.error("Nao achei o <script> inline");
  process.exit(1);
}
const script = m[1];
const src = script;

// ---------- extrai funcoes puras reais do arquivo ----------
function sliceFn(name, nextName) {
  const a = src.indexOf("function " + name);
  if (a < 0) throw new Error("fn " + name);
  const b = nextName ? src.indexOf("function " + nextName) : src.length;
  return src.slice(a, b);
}
const parsePriceSrc = sliceFn("parsePrice", "fmt");
const fmtSrc = sliceFn("fmt", "persist");
const pureCtx = {};
vm.createContext(pureCtx);
const parsePrice = vm.runInContext(parsePriceSrc + "\nparsePrice;", pureCtx);
const fmt = vm.runInContext(fmtSrc + "\nfmt;", pureCtx);

// ---------- DOM stub ----------
function makeEl(id) {
  return {
    id,
    value: "",
    textContent: "",
    innerHTML: "",
    handlers: {},
    addEventListener(ev, fn) {
      this.handlers[ev] = fn;
    },
    getAttribute() {
      return null;
    },
    classList: { toggle() {} },
    appendChild() {},
  };
}

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    setItem(k, v) {
      map.set(String(k), String(v));
    },
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
  };
}

function makeRangeEl() {
  let v = "70";
  const el = makeEl("threshold");
  Object.defineProperty(el, "value", {
    get() {
      return v;
    },
    // Aproxima a "value sanitization algorithm" do <input type=range>:
    // valor nao numerico -> default (min + metade do intervalo = 70);
    // fora de [min,max] -> clamp (60/80). step/multiple nao normaliza.
    set(x) {
      const n = Number(String(x));
      if (!isFinite(n)) v = "70";
      else v = String(Math.min(80, Math.max(60, n)));
    },
  });
  return el;
}

function makePreset(t) {
  return {
    attrs: { "data-t": t },
    classes: new Set(t === "70" ? ["active"] : []),
    addEventListener() {},
    getAttribute(k) {
      return this.attrs[k];
    },
    classList: {
      toggle(cls, on) {
        if (on) this_owner.classes.add(cls);
        else this_owner.classes.delete(cls);
      },
    },
  };
}

function runApp({ storage = makeStorage(), storageThrows = false } = {}) {
  const gas = makeEl("gas");
  const eta = makeEl("eta");
  const threshold = makeRangeEl();
  const thresholdVal = makeEl("thresholdVal");
  const result = makeEl("result");
  const presetEls = ["70", "71"].map((t) => {
    const p = makePreset(t);
    // amarra classList ao proprio preset
    p.classList = {
      toggle(cls, on) {
        if (on) p.classes.add(cls);
        else p.classes.delete(cls);
      },
    };
    return p;
  });
  const byId = { gas, eta, threshold, thresholdVal, result };
  const document = {
    getElementById: (id) => byId[id],
    querySelectorAll: (sel) =>
      sel === ".presets button" ? presetEls : [],
    createElement: () => ({ setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} },
    body: {},
  };
  const localStorage = storageThrows
    ? {
        getItem() {
          throw new Error("SecurityError: localStorage bloqueado");
        },
        setItem() {
          throw new Error("QuotaExceededError");
        },
      }
    : storage;
  const navigator = { serviceWorker: { register() {} } };
  const location = { protocol: "https:" };
  const window = { addEventListener() {}, location };
  const sandbox = { document, window, navigator, location, localStorage, console, URL, Intl };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try {
    vm.runInContext(script, sandbox, { filename: "index.html#inline" });
  } catch (e) {
    return { error: e, gas, eta, threshold, thresholdVal, result, presetEls };
  }
  return { gas, eta, threshold, thresholdVal, result, presetEls, storage };
}

function evalRender(app, gasText, etaText, thresholdText = "70") {
  app.gas.value = gasText;
  app.eta.value = etaText;
  if (thresholdText != null) app.threshold.value = thresholdText;
  // "input" no input de gas dispara persist()+render()
  app.gas.handlers.input();
  const htmlOut = app.result.innerHTML;
  const cls =
    (htmlOut.match(/class="verdict ([a-z]+)"/) || [])[1] || "(vazio)";
  const big = (htmlOut.match(/class="big">([^<]*)</) || [])[1] || "(vazio)";
  const label = (htmlOut.match(/class="label">([\s\S]*?)<\/div>/) || [])[1] || "(vazio)";
  const markerLeft = (htmlOut.match(/class="marker" style="left:([^"]*)"/) || [])[1] || "-";
  const dotLeft = (htmlOut.match(/class="dot-ratio ([a-z]+)" style="left:([^"]*)"/) || [])[1]
    ? htmlOut.match(/class="dot-ratio ([a-z]+)" style="left:([^"]*)"/)
    : [];
  const dotCls = dotLeft[1] || "-";
  const dotLeftVal = dotLeft[2] || "-";
  const empateVisible = /Empate t[eé]cnico/.test(htmlOut);
  return { big, label: label.replace(/\s+/g, " ").trim(), cls, markerLeft, dotCls, dotLeftVal, empateVisible, htmlOut };
}

// ---------- 1) parsePrice ----------
const parseCases = [
  ["5,89", "5,89"],
  ["5.89", "5.89"],
  ["1.234,56", "1.234,56"],
  ["1,234.56", "1,234.56 (formato en-US)"],
  ["R$ 5,89", "R$ 5,89 (com prefixo)"],
  ["R$5,89", "R$5,89"],
  ["5,8,9", "5,8,9"],
  ["", "(vazio)"],
  ["   ", "(so espacos)"],
  ["0", "0"],
  ["0,00", "0,00"],
  ["-3", "-3"],
  ["abc", "abc"],
  [" 5,89 ", " 5,89 (com espacos)"],
  ["\u00a05,89", "NBSP + 5,89"],
  ["1e3", "1e3"],
  ["1E-3", "1E-3"],
  ["0x10", "0x10"],
  ["+5,89", "+5,89"],
  ["5,", "5,"],
  ["5.", "5."],
  [".", "."],
  [",", ","],
  ["1.234", "1.234 (ponto sem virgula)"],
  ["12.345", "12.345 (ponto sem virgula)"],
  ["5,89\n6", "5,89 + quebra de linha + 6"],
  [" 5 89 ", "5 89"],
  ["(5,89)", "(5,89)"],
  ["5,89 R$", "5,89 R$"],
  ["999999999999999999999", "1e21"],
  ["1e309", "1e309 (Infinity)"],
  ["5e-324", "5e-324 (menor subnormal)"],
  ["0,0000000000000000000001", "1e-22"],
  ["Infinity", "Infinity"],
  ["NaN", "NaN"],
  ["0b11", "0b11"],
  ["１２,５", "digitos fullwidth"],
];
console.log("== 1) parsePrice (funcao real do index.html) ==");
for (const [inp, desc] of parseCases) {
  const out = parsePrice(inp);
  console.log(
    JSON.stringify(inp).padEnd(30),
    String(out).padEnd(24),
    isNaN(out) ? "NaN" : isFinite(out) ? "finite" : "nao-finito",
    "| " + desc
  );
}

// ---------- 2) fmt ----------
console.log("\n== 2) fmt(pt-BR) ==");
const fmtCases = [
  [0.05, 1],
  [0.25, 1],
  [1.005, 1],
  [69.95, 1],
  [70.05, 1],
  [70.049, 1],
  [Infinity, 1],
  [-0, 1],
  [1e21, 1],
  [1234567.891, 1],
  [0.004, 1],
];
for (const [n, d] of fmtCases) {
  console.log(String(n).padEnd(12), "d=" + d, "=>", fmt(n, d));
}

// ---------- 3) render: cenarios ----------
console.log("\n== 3) render() cenarios (limite 70% salvo se indicado) ==");
const scenarios = [
  ["basico etanol", "5,89", "3,99", null],
  ["basico gasolina", "5,89", "4,50", null],
  ["empate exato 4,20/6,00", "6,00", "4,20", null],
  ["empate +0,10 p.p. (fora da faixa 'exatamente')", "5,00", "3,505", null],
  ["empate +0,20 p.p. (mensagem contraditoria)", "5,00", "3,51", null],
  ["empate +0,49 p.p.", "5,00", "3,5249", null],
  ["empate -0,20 p.p.", "5,00", "3,49", null],
  ["empate -0,49 p.p.", "5,00", "3,4755", null],
  ["limite exato -0,50 p.p. => etanol", "5,00", "3,475", null],
  ["limite exato +0,50 p.p. => gasolina", "5,00", "3,525", null],
  ["exatamente no limite (diff 0)", "5,00", "3,50", null],
  ["'exatamente' com diff 0,04 p.p.", "5,00", "3,498", null],
  ["gauge abaixo de 60%", "5,00", "2,00", null],
  ["gauge acima de 80%", "5,00", "4,50", null],
  ["etanol mais caro que gasolina (120%)", "5,00", "6,00", null],
  ["limite 60 + ratio 59,5%", "5,00", "2,975", "60"],
  ["limite 60 + ratio 61%", "5,00", "3,05", "60"],
  ["limite 80 + ratio 79%", "5,00", "3,95", "80"],
  ["limite 80 + ratio 81%", "5,00", "4,05", "80"],
  ["preco invalido: R$ 5,89", "R$ 5,89", "3,99", null],
  ["preco invalido: 0", "0", "3,99", null],
  ["preco invalido: -3", "-3", "3,99", null],
  ["preco invalido: abc", "abc", "3,99", null],
  ["ambos vazios", "", "", null],
  ["so gasolina", "5,89", "", null],
  ["en-US 1,234.56 interpretado", "1,234.56", "3,99", null],
  ["1e3 aceito como 1000", "1e3", "3,99", null],
  ["subnormal => Infinity no DOM", "5e-324", "5", null],
  ["huge ratio layout", "0,000000001", "5", null],
  ["preco absurdo 500", "500", "3,99", null],
];
for (const [name, g, e, t] of scenarios) {
  const app = runApp();
  const r = evalRender(app, g, e, t);
  console.log(
    name.padEnd(46),
    "=> big=" + JSON.stringify(r.big).padEnd(14),
    "cls=" + r.cls.padEnd(10),
    "dot=" + r.dotCls + "@" + r.dotLeftVal.padEnd(6),
    "marker@" + r.markerLeft.padEnd(6),
    "| " + r.label
  );
  if (name.startsWith("subnormal") || name.startsWith("en-US") || name.startsWith("huge")) {
    console.log("    innerHTML:", r.htmlOut.replace(/\s+/g, " ").slice(0, 420));
  }
}

// ---------- 4) localStorage / restore ----------
console.log("\n== 4) restore() / localStorage ==");
{
  const app = runApp({ storage: makeStorage({ ac_gas: "5,89", ac_eta: "3,99", ac_threshold: "71" }) });
  app.result.innerHTML = "";
  app.gas.handlers.input();
  console.log("storage valido:", "gas=" + app.gas.value, "eta=" + app.eta.value, "threshold=" + app.threshold.value, "=>", evalRender(app, "5,89", "3,99", "71").label);
  console.log("presets ativos:", app.presetEls.filter((p) => p.classes.has("active")).map((p) => p.getAttribute("data-t")));
}
{
  const app = runApp({ storage: makeStorage({ ac_threshold: "abc" }) });
  console.log("threshold corrompido 'abc' => value imediato:", app.threshold.value, "| thresholdVal:", app.thresholdVal.textContent);
  app.gas.handlers.input();
  console.log("  depois de input => thresholdVal:", app.thresholdVal.textContent);
}
{
  const app = runApp({ storage: makeStorage({ ac_threshold: "0" }) });
  console.log("threshold '0' => value:", app.threshold.value);
  const app2 = runApp({ storage: makeStorage({ ac_threshold: "100" }) });
  console.log("threshold '100' => value:", app2.threshold.value);
}
{
  // syncPresets NAO roda se getItem lancar antes
  const app = runApp({ storageThrows: true });
  console.log("localStorage lanca (get+set):", "app carregou?", app.error ? "ERRO " + app.error.message : "sim", "| thresholdVal:", app.thresholdVal.textContent);
  const r = evalRender(app, "5,89", "3,99", "71");
  console.log("  render apos storage bloqueado:", r.label);
  console.log("  preset 70 ainda com classe active no HTML (stub):", app.presetEls.filter((p) => p.classes.has("active")).map((p) => p.getAttribute("data-t")));
}
{
  // storage com valores absurdos
  const app = runApp({ storage: makeStorage({ ac_gas: "0", ac_eta: "0", ac_threshold: "71.5" }) });
  console.log("storage preco 0/0 => render:", evalRender(app, "0", "0", "71.5").label);
  console.log("threshold '71.5' => value:", app.threshold.value, "presets ativos:", app.presetEls.filter((p) => p.classes.has("active")).map((p) => p.getAttribute("data-t")));
}
{
  // storage com strings gigantes / HTML (checa se chega a innerHTML)
  const app = runApp({ storage: makeStorage({ ac_gas: "<img src=x onerror=alert(1)>", ac_eta: "3,99" }) });
  const r = evalRender(app, app.gas.value, "3,99", null);
  console.log("storage com HTML no preco => texto do result contem '<img'?", /<img/i.test(r.htmlOut), "| label:", r.label);
}

// ---------- 5) contraste WCAG ----------
console.log("\n== 5) contraste WCAG (texto normal 4.5, grande 3.0, nao-texto 3.0) ==");
const hex = (h) => {
  const s = h.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const blend = (fg, alpha, bg) => fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));
const lum = (rgb) => {
  const ch = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const ratio = (a, b) => {
  const l1 = lum(a), l2 = lum(b);
  return ((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2);
};
const C = {
  bg: hex("#0b1020"),
  card: hex("#121a2e"),
  card2: hex("#0d1526"),
  text: hex("#e6edf7"),
  muted: hex("#8a97b0"),
  placeholder: hex("#4a566e"),
  blue: hex("#3b82f6"),
  green: hex("#22c55e"),
  amber: hex("#f59e0b"),
  verdictEtanol: hex("#4ade80"),
  verdictGasolina: hex("#60a5fa"),
  verdictEmpate: hex("#fbbf24"),
  whyText: hex("#c4cee0"),
  link: hex("#60a5fa"),
};
const pairs = [
  ["texto #e6edf7 / card #121a2e", C.text, C.card],
  ["muted #8a97b0 / card #121a2e (13px, 11px)", C.muted, C.card],
  ["muted #8a97b0 / bg #0b1020 (footer 11px)", C.muted, C.bg],
  ["muted #8a97b0 / card2 #0d1526 (presets)", C.muted, C.card2],
  ["placeholder #4a566e / card2 #0d1526", C.placeholder, C.card2],
  ["verde veredito #4ade80 / fundo verde misturado", C.verdictEtanol, blend(C.green, 0.14, C.card)],
  ["azul veredito #60a5fa / fundo azul misturado", C.verdictGasolina, blend(C.blue, 0.14, C.card)],
  ["ambar veredito #fbbf24 / fundo ambar misturado", C.verdictEmpate, blend(C.amber, 0.14, C.card)],
  ["texto .why #c4cee0 / card2 #0d1526", C.whyText, C.card2],
  ["link #60a5fa / card #121a2e", C.link, C.card],
  ["borda input rgba(255,255,255,.08) / card2 #0d1526 (nao-texto)", blend([255, 255, 255], 0.08, C.card2), C.card2],
  ["borda card rgba(255,255,255,.08) / bg #0b1020 (nao-texto)", blend([255, 255, 255], 0.08, C.bg), C.bg],
  ["focus ring azul #3b82f6 / card2 #0d1526 (nao-texto)", C.blue, C.card2],
  ["texto placeholder do input #4a566e / card2", C.placeholder, C.card2],
];
for (const [name, a, b] of pairs) console.log(name.padEnd(64), ratio(a, b) + ":1");

// ---------- 6) metadados / estrutura ----------
console.log("\n== 6) estrutura ==");
const count = (re) => (html.match(re) || []).length;
console.log("linhas index.html:", html.split("\n").length, "| bytes:", Buffer.byteLength(html, "utf8"));
console.log("<label for>:", count(/<label for=/g), "| <input>:", count(/<input/g), "| <button>:", count(/<button/g), "| aria-*:", count(/aria-[a-z]+=/g), "| role=:", count(/role=/g));
console.log("aria-live:", /aria-live/.test(html), "| aria-pressed:", /aria-pressed/.test(html), "| meta color-scheme:", /color-scheme/.test(html));
console.log("apple-mobile-web-app-capable:", /apple-mobile-web-app-capable/.test(html), "| apple-touch-icon PNG:", /apple-touch-icon[^>]*png/.test(html));
console.log("noscript:", /<noscript/.test(html), "| prefers-reduced-motion:", /prefers-reduced-motion/.test(html));
console.log("fetch(", /fetch\(/.test(html), "| XMLHttpRequest:", /XMLHttpRequest/.test(html));
