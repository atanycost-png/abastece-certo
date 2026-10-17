#!/usr/bin/env node
/**
 * Abastece Certo — checagem estrutural de entrega (QA).
 *
 * Complementa tools/test.mjs (que testa a matemática). Aqui validamos o pacote:
 * manifesto, ícones reais, service worker, integridade do HTML e sintaxe do
 * JavaScript embutido — tudo que quebraria a instalação do PWA silenciosamente.
 *
 * Uso: node tools/check.mjs
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const failures = [];
const warnings = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function warn(message) {
  warnings.push(message);
  console.log(`  aviso ${message}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function section(title) {
  console.log(`\n${title}`);
}

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const sizeOf = (rel) => statSync(join(ROOT, rel)).size;
const kb = (rel) => `${(sizeOf(rel) / 1024).toFixed(1)} KB`;

// ------------------------------------------------------------------ arquivos
section("Arquivos obrigatórios");
const REQUIRED = [
  "index.html",
  "sw.js",
  "manifest.webmanifest",
  "README.md",
  "REFERENCIA.md",
  "LICENSE",
  "package.json",
  "icons/favicon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
  "icons/apple-touch-icon.png",
  "tools/test.mjs",
  "tools/check.mjs",
  "tools/serve.mjs"
];
for (const rel of REQUIRED) {
  check(`${rel} existe`, () => assert(existsSync(join(ROOT, rel)), `${rel} não encontrado`));
}

// ------------------------------------------------------------------ manifesto
section("Manifesto PWA");
let manifest = null;
check("manifest.webmanifest é JSON válido", () => {
  manifest = JSON.parse(read("manifest.webmanifest"));
  assert(manifest && typeof manifest === "object", "manifesto não é objeto");
});
check("campos obrigatórios presentes", () => {
  for (const key of ["name", "short_name", "start_url", "display", "icons", "theme_color", "background_color", "description", "lang"]) {
    assert(manifest[key] !== undefined && manifest[key] !== "", `campo ausente: ${key}`);
  }
  assert(String(manifest.lang).toLowerCase().startsWith("pt"), "lang deveria ser pt-BR");
});
check("display é standalone ou similar", () => {
  assert(["standalone", "minimal-ui", "fullscreen"].includes(manifest.display), `display inválido: ${manifest.display}`);
});
check("start_url e scope relativos", () => {
  assert(!/^https?:/i.test(String(manifest.start_url)), "start_url deveria ser relativo (GitHub Pages/subpasta)");
  assert(!/^https?:/i.test(String(manifest.scope || "./")), "scope deveria ser relativo");
});
check("ícones 192 e 512 existem e têm o tamanho declarado", () => {
  const seen = new Set();
  for (const icon of manifest.icons || []) {
    assert(icon.src, "ícone sem src");
    const rel = icon.src.replace(/^\.\//, "");
    assert(existsSync(join(ROOT, rel)), `ícone ausente: ${rel}`);
    seen.add(icon.sizes);
  }
  assert(seen.has("192x192"), "falta ícone 192x192");
  assert(seen.has("512x512"), "falta ícone 512x512");
  assert((manifest.icons || []).some((i) => String(i.purpose || "").includes("maskable")), "falta ícone maskable");
});
check("dimensões reais dos PNG batem com o manifesto", () => {
  for (const icon of manifest.icons || []) {
    const rel = icon.src.replace(/^\.\//, "");
    const buf = readFileSync(join(ROOT, rel));
    assert(buf.slice(1, 4).toString() === "PNG", `${rel} não é PNG`);
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const [w, h] = String(icon.sizes).split("x").map(Number);
    assert(width === w && height === h, `${rel} é ${width}x${height}, manifesto diz ${icon.sizes}`);
  }
});
check("screenshots do manifest existem, são PNG e têm o tamanho declarado", () => {
  const shots = manifest.screenshots || [];
  assert(shots.length >= 2, "esperava 2 screenshots (narrow + wide)");
  const variants = new Set();
  for (const shot of shots) {
    const rel = String(shot.src || "").replace(/^\.\//, "");
    assert(rel, "screenshot sem src");
    assert(existsSync(join(ROOT, rel)), `screenshot ausente: ${rel}`);
    const buf = readFileSync(join(ROOT, rel));
    assert(buf.slice(1, 4).toString() === "PNG", `${rel} não é PNG`);
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const [w, h] = String(shot.sizes).split("x").map(Number);
    assert(width === w && height === h, `${rel} é ${width}x${height}, manifesto diz ${shot.sizes}`);
    assert(["narrow", "wide"].includes(shot.form_factor), `form_factor inválido: ${shot.form_factor}`);
    assert(shot.label, `screenshot sem label: ${rel}`);
    variants.add(shot.form_factor);
  }
  assert(variants.has("narrow") && variants.has("wide"), "precisa de um screenshot narrow e um wide");
});

// -------------------------------------------------------------------- ícone
section("Ícone vetorial");
check("favicon.svg é SVG plausível", () => {
  const svg = read("icons/favicon.svg");
  assert(svg.trim().startsWith("<svg"), "não começa com <svg");
  assert(svg.includes("viewBox"), "sem viewBox");
  assert(svg.trim().endsWith("</svg>"), "não termina com </svg>");
});

// ------------------------------------------------------------- service worker
section("Service worker");
check("sw.js tem sintaxe JavaScript válida", () => {
  new vm.Script(read("sw.js"), { filename: "sw.js" });
});
check("sw.js versiona o cache", () => {
  const src = read("sw.js");
  assert(/const VERSION = "v[\d.]+"/.test(src), "sem constante VERSION");
  assert(/abastece-certo-/.test(src), "nome de cache inesperado");
});
check("sw.js limpa caches antigos no activate", () => {
  const src = read("sw.js");
  assert(/caches\.delete/.test(src), "não apaga cache antigo");
  assert(/self\.clients\.claim/.test(src), "não assume controle dos clientes");
});
check("todo arquivo do PRECACHE existe em disco", () => {
  const src = read("sw.js");
  const block = src.match(/const PRECACHE = \[([\s\S]*?)\];/);
  assert(block, "PRECACHE não encontrado");
  const entries = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert(entries.length >= 4, "PRECACHE muito curto");
  for (const entry of entries) {
    const rel = entry.replace(/^\.\//, "");
    if (!rel) continue; // "./" é a raiz
    assert(existsSync(join(ROOT, rel)), `PRECACHE aponta para arquivo inexistente: ${entry}`);
  }
});
check("sw.js não intercepta requisições de outros domínios", () => {
  const src = read("sw.js");
  assert(/url\.origin !== self\.location\.origin/.test(src), "sem checagem de origem");
  assert(/request\.method !== "GET"/.test(src), "sem checagem de método");
});

// ------------------------------------------------------------- dados de preços
const html = read("index.html");
section("Dados de preços (ANP)");
let prices = null;
check("precos.json existe e é JSON válido", () => {
  assert(existsSync(join(ROOT, "precos.json")), "precos.json não encontrado");
  prices = JSON.parse(read("precos.json"));
  assert(prices && typeof prices === "object", "precos.json não é objeto");
});
check("precos.json segue o schema mínimo que o app consome", () => {
  assert(prices, "precos.json não carregou");
  assert(typeof prices.fonte === "string" && prices.fonte.length > 0, "fonte ausente");
  assert(prices.semana && /^\d{4}-\d{2}-\d{2}$/.test(prices.semana.inicio), "semana.inicio inválida");
  assert(/^\d{4}-\d{2}-\d{2}$/.test(prices.semana.fim), "semana.fim inválida");
  assert(typeof prices.atualizadoEm === "string", "atualizadoEm ausente");
  assert(prices.brasil && prices.brasil.gasolinaComum, "brasil.gasolinaComum ausente");
  assert(prices.brasil.etanol, "brasil.etanol ausente");
  const g = Number(prices.brasil.gasolinaComum.media);
  const e = Number(prices.brasil.etanol.media);
  assert(isFinite(g) && g > 2 && g < 15, `média da gasolina implausível: ${g}`);
  assert(isFinite(e) && e > 1 && e < 12, `média do etanol implausível: ${e}`);
  assert(prices.estados && Object.keys(prices.estados).length >= 5, "estados ausentes/insuficientes");
});
check("index.html busca precos.json na mesma origem (sem CORS)", () => {
  assert(/fetch\("\.\/precos\.json"/.test(html), "fetch relativo de precos.json ausente");
  assert(/normalizePrices/.test(html), "normalizePrices ausente no app");
});
check("precos.json está no precache do service worker", () => {
  assert(read("sw.js").includes('"./precos.json"'), "precos.json fora do PRECACHE");
});

// --------------------------------------------------------------------- HTML
section("Integridade do index.html");
// Para as checagens de marcação, ignora o conteúdo dos <script>: strings e
// comentários do JS não são HTML e gerariam falso positivo.
const markup = html.replace(/<script[\s\S]*?<\/script>/gi, "");

check("documento bem formado (tags essenciais)", () => {
  for (const tag of ["<!doctype html>", "<html", "</html>", "<head>", "</head>", "<body>", "</body>", "</script>"]) {
    assert(html.toLowerCase().includes(tag.toLowerCase()), `faltando ${tag}`);
  }
  assert(/<html[^>]+lang="pt-BR"/.test(html), "html sem lang=pt-BR");
  assert(/<meta charset="utf-8"/i.test(html), "sem charset");
  assert(/name="viewport"/.test(html), "sem viewport");
});
check("script embutido tem sintaxe válida", () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert(scripts.length > 0, "nenhum script inline encontrado");
  for (const [i, s] of scripts.entries()) {
    new vm.Script(s[1], { filename: `inline-${i}.js` });
  }
});
check("não há dependências externas de runtime", () => {
  const externals = [
    ...html.matchAll(/<script[^>]+src="(?!\.\/|data:)[^"]+"/gi),
    ...html.matchAll(/<link[^>]+href="(https?:)?\/\/[^"]+"/gi),
    ...html.matchAll(/@import\s+(?:url\()?["']?https?:/gi)
  ];
  assert(externals.length === 0, `${externals.length} recurso(s) externo(s)`);
});
check("manifest e ícones ligados ao HEAD", () => {
  assert(/rel="manifest"/.test(markup), "sem link manifest");
  assert(/rel="apple-touch-icon"/.test(markup), "sem apple-touch-icon");
  assert(/rel="icon"/.test(markup), "sem favicon");
  assert(markup.includes('href="./manifest.webmanifest"'), "manifest deveria ser arquivo relativo");
});
check("não usa manifest via data: URI (padrão antigo que quebra instalação)", () => {
  assert(!/application\/manifest\+json/.test(markup), "manifest em data: URI detectado");
});
check("tema: bootstrap, alternância e persistência presentes", () => {
  assert(/data-theme/.test(markup), "sem atributo data-theme no HTML");
  assert(/id="themeBtn"/.test(markup), "sem botão de tema");
  assert(/prefers-color-scheme/.test(html), "não lê o tema do sistema");
  assert(/localStorage\.getItem\("ac\.theme"\)/.test(html), "tema não é lido do storage");
  assert(/safeSet\(THEME_KEY/.test(html), "tema não é persistido");
});
check("tema: tokens de claro e escuro definidos", () => {
  assert(/:root\[data-theme="dark"\]/.test(html), "sem bloco de tokens escuros");
  assert(/--card: #ffffff/.test(html), "sem token de cartão claro");
  assert(/--card: #141926/.test(html), "sem token de cartão escuro");
  assert(/--ink: #e8edf5/.test(html), "sem token de texto escuro");
});
check("manifesto usa as cores do tema escuro padrão", () => {
  assert(String(manifest.theme_color).toLowerCase() === "#0b0e14", "theme_color deveria ser #0b0e14");
  assert(String(manifest.background_color).toLowerCase() === "#0b0e14", "background_color deveria ser #0b0e14");
});
check("meta de instalação mobile presentes", () => {
  assert(/name="mobile-web-app-capable"/.test(markup), "sem mobile-web-app-capable");
  assert(/name="apple-mobile-web-app-capable"/.test(markup), "sem apple-mobile-web-app-capable");
  assert(/name="theme-color"/.test(markup), "sem theme-color");
});
check("resultado tem região viva para leitores de tela", () => {
  assert(/aria-live="polite"/.test(markup), "sem aria-live");
  assert(/role="status"/.test(markup), "sem role=status");
});
check("abas seguem o padrão ARIA tablist", () => {
  assert(/role="tablist"/.test(markup), "sem tablist");
  assert(/role="tab"/.test(markup), "sem tab");
  assert(/role="tabpanel"/.test(markup), "sem tabpanel");
  assert(/aria-controls="panel-fast"/.test(markup) && /aria-controls="panel-precise"/.test(markup), "aria-controls ausente");
});
check("todo aria-controls/aria-labelledby/aria-describedby aponta para id existente", () => {
  const ids = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const attrs = [...markup.matchAll(/aria-(?:controls|labelledby|describedby|owns)="([^"]+)"/g)];
  for (const [, value] of attrs) {
    for (const id of value.split(/\s+/)) {
      assert(ids.has(id), `referência ARIA órfã: ${id}`);
    }
  }
});
check("nenhum id duplicado", () => {
  const seen = new Set();
  for (const [, id] of markup.matchAll(/\bid="([^"]+)"/g)) {
    assert(!seen.has(id), `id duplicado: ${id}`);
    seen.add(id);
  }
});
check("todo <label for> aponta para um id existente", () => {
  const ids = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const [, id] of markup.matchAll(/<label[^>]*\bfor="([^"]+)"/g)) {
    assert(ids.has(id), `label órfão: ${id}`);
  }
});
check("nenhum input sem label acessível", () => {
  const inputs = [...markup.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
  assert(inputs.length >= 5, "esperava os campos de preço, consumo e limite");
  for (const input of inputs) {
    const idMatch = input.match(/\bid="([^"]+)"/);
    const hasAria = /aria-label(?:ledby)?=/.test(input);
    const hasLabel = idMatch && new RegExp(`<label[^>]*\\bfor="${idMatch[1]}"`).test(markup);
    assert(hasAria || hasLabel, `input sem label: ${input.slice(0, 70)}…`);
  }
});
check("bloco CORE delimitado para os testes", () => {
  assert(/\/\* CORE-START \*\//.test(html), "marcador CORE-START ausente");
  assert(/\/\* CORE-END \*\//.test(html), "marcador CORE-END ausente");
});
check("slider tem regra de foco visível própria", () => {
  assert(/input\[type=range\]:focus-visible/.test(html), "o slider perde o foco visível para outline:none");
});
check("slider tem área de toque maior que o trilho", () => {
  const block = html.match(/input\[type=range\]\s*\{([^}]*)\}/);
  assert(block, "regra base do slider ausente");
  const height = Number((block[1].match(/height:\s*(\d+)px/) || [])[1]);
  assert(height >= 32, `altura do slider é ${height}px (mínimo 32)`);
});
check("preços têm teto duro (sem veredito absurdo com 500)", () => {
  assert(/MAX_PRICE = 99\.99/.test(html), "MAX_PRICE ausente");
  assert(/function parsePrice/.test(html), "parsePrice ausente");
});
check("diferença do empate é arredondada (sem ruído de float)", () => {
  assert(/function roundPp/.test(html), "roundPp ausente");
  assert(/diffPp = roundPp\(/.test(html), "diffPp não passa por roundPp");
});

// ------------------------------------------------------- orçamento de tamanho
section("Orçamento de tamanho");
check("index.html permanece autocontido (< 120 KB)", () => {
  assert(sizeOf("index.html") < 120 * 1024, `index.html tem ${kb("index.html")}`);
});
check("sw.js pequeno (< 20 KB)", () => {
  assert(sizeOf("sw.js") < 20 * 1024, `sw.js tem ${kb("sw.js")}`);
});
check("ícone 512 abaixo de 100 KB", () => {
  assert(sizeOf("icons/icon-512.png") < 100 * 1024, `icon-512.png tem ${kb("icons/icon-512.png")}`);
});

// ---------------------------------------------------------------- observações
if (manifest && !manifest.screenshots) {
  warn("manifest sem screenshots — opcional (só melhora a UI de instalação); omitido de propósito para não versionar imagens grandes.");
}
if (!existsSync(join(ROOT, "LICENSE"))) {
  warn("sem arquivo LICENSE (opcional).");
}
const coreFiles = ["index.html", "sw.js", "manifest.webmanifest", "icons/favicon.svg"];
const iconFiles = ["icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-touch-icon.png"];
const coreBytes = coreFiles.reduce((sum, rel) => sum + sizeOf(rel), 0);
const iconBytes = iconFiles.reduce((sum, rel) => sum + sizeOf(rel), 0);
console.log(`\n  Peso do app: ${((coreBytes + iconBytes) / 1024).toFixed(1)} KB`);
console.log(`  código+manifesto: ${(coreBytes / 1024).toFixed(1)} KB · ícones: ${(iconBytes / 1024).toFixed(1)} KB`);
console.log(`  index.html: ${kb("index.html")} · sw.js: ${kb("sw.js")} · manifest: ${kb("manifest.webmanifest")}`);

// ---------------------------------------------------------------------- resumo
console.log(`\n${"=".repeat(60)}`);
if (failures.length === 0) {
  console.log(`OK — ${passed} verificações passaram.`);
} else {
  console.log(`FALHOU — ${failures.length} de ${passed + failures.length} verificações.`);
  for (const f of failures) console.log(`  • ${f.name}: ${f.message}`);
}
if (warnings.length) console.log(`${warnings.length} aviso(s) não bloqueante(s).`);
console.log(`${"=".repeat(60)}`);
process.exitCode = failures.length === 0 ? 0 : 1;
