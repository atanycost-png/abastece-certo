#!/usr/bin/env node
/**
 * Abastece Certo — suíte de testes da lógica pura.
 *
 * O app é um arquivo HTML único, sem build e sem dependências. Para testar a
 * lógica sem duplicar código, este script lê o index.html, extrai o bloco
 * delimitado por CORE-START / CORE-END e o executa no contexto isolado do
 * node:vm. Assim o mesmo código que roda no navegador é o que é testado.
 *
 * Uso: node tools/test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = join(ROOT, "index.html");

// ------------------------------------------------------------------ harness
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ok    ${name}\n`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
  }
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

function eq(actual, expected, label) {
  const ok = Object.is(actual, expected);
  if (!ok) {
    throw new Error(`${label || "valor"} => esperado ${format(expected)}, obtido ${format(actual)}`);
  }
}

function close(actual, expected, eps, label) {
  eps = eps === undefined ? 1e-9 : eps;
  if (typeof actual !== "number" || !isFinite(actual)) {
    throw new Error(`${label || "valor"} => esperado número ~${expected}, obtido ${format(actual)}`);
  }
  if (Math.abs(actual - expected) > eps) {
    throw new Error(`${label || "valor"} => esperado ~${expected} (±${eps}), obtido ${actual}`);
  }
}

function isNaNValue(actual, label) {
  if (!Number.isNaN(actual)) {
    throw new Error(`${label || "valor"} => esperado NaN, obtido ${format(actual)}`);
  }
}

function isNull(actual, label) {
  if (actual !== null) {
    throw new Error(`${label || "valor"} => esperado null, obtido ${format(actual)}`);
  }
}

function ok(cond, label) {
  if (!cond) throw new Error(label || "condição falsa");
}

function includes(haystack, needle, label) {
  if (typeof haystack !== "string" || haystack.indexOf(needle) === -1) {
    throw new Error(`${label || "texto"} => esperava conter ${JSON.stringify(needle)}, obtido ${format(haystack)}`);
  }
}

function notIncludes(haystack, needle, label) {
  if (typeof haystack === "string" && haystack.indexOf(needle) !== -1) {
    throw new Error(`${label || "texto"} => NÃO deveria conter ${JSON.stringify(needle)}: ${format(haystack)}`);
  }
}

function format(v) {
  if (typeof v === "number" && Number.isNaN(v)) return "NaN";
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

// ---------------------------------------------------------------- extração
function loadCore() {
  const html = readFileSync(HTML_PATH, "utf8");
  const match = html.match(/\/\* CORE-START \*\/([\s\S]*?)\/\* CORE-END \*\//);
  if (!match) {
    throw new Error("Bloco CORE-START/CORE-END não encontrado em index.html");
  }
  const script = match[1];
  const context = vm.createContext({});
  const core = vm.runInContext(`${script}\n;AC`, context, { filename: "ac-core.js" });
  if (!core || typeof core !== "object") {
    throw new Error("O bloco CORE não expôs o objeto AC");
  }
  return { core, script, html };
}

// ------------------------------------------------------------------- testes
const { core: AC, html } = loadCore();

section("parseNumber — entrada de preço pt-BR");
[
  ["5,89", 5.89],
  ["5.89", 5.89],
  ["1.234,56", 1234.56],
  ["1,234.56", 1234.56],
  ["1.234.567,89", 1234567.89],
  ["1,234,567.89", 1234567.89],
  ["R$ 5,89", 5.89],
  ["r$5,89", 5.89],
  [" 5,89 ", 5.89],
  ["5,", 5],
  [",5", 5],
  ["0", 0],
  ["1234", 1234],
  ["1.234", 1.234],
  ["5.899", 5.899],
  ["5.890", 5.89],
  ["4.099", 4.099],
  ["12.345", 12.345],
  ["10.500", 10.5],
  ["1.234.567", 1234567],
  ["12.34", 12.34],
  ["10,5 km/L", 10.5],
  ["7,3km/l", 7.3],
  ["5,89 reais", 5.89]
].forEach(([input, expected]) => {
  test(`parseNumber(${JSON.stringify(input)}) === ${expected}`, () => {
    eq(AC.parseNumber(input), expected);
  });
});

section("parseNumber — entradas inválidas");
["", "   ", "abc", "R$", ",", ".", "-3", "+3", "5,8,9", "5.8.9", "1e3", "1.2.3", "NaN", "Infinity", "5 89"].forEach((input) => {
  test(`parseNumber(${JSON.stringify(input)}) é NaN`, () => {
    isNaNValue(AC.parseNumber(input));
  });
});

section("parseNumber — rejeições que a v1 aceitava errado");
[
  ["５,89", "dígitos fullwidth (não podem virar 89)"],
  ["0x10", "hexadecimal"],
  ["0b11", "binário"],
  ["5,89abc", "letras grudadas"],
  ["1,234.56abc", "texto após número"],
  ["R$ 5,89 BRL", "código de moeda no fim"],
  ["1 234,56", "espaço como separador de milhar"]
].forEach(([input, why]) => {
  test(`parseNumber(${JSON.stringify(input)}) é NaN (${why})`, () => {
    isNaNValue(AC.parseNumber(input));
  });
});

test("parseNumber(null) é NaN", () => isNaNValue(AC.parseNumber(null)));
test("parseNumber(undefined) é NaN", () => isNaNValue(AC.parseNumber(undefined)));

section("parsePositive / parsePrice / parseKmL / priceStatus");
test('parsePositive("0") é NaN (combustível grátis não existe)', () => isNaNValue(AC.parsePositive("0")));
test('parsePositive("5,89") === 5.89', () => eq(AC.parsePositive("5,89"), 5.89));
test('parsePrice("6,54") === 6.54', () => eq(AC.parsePrice("6,54"), 6.54));
test('parsePrice("5.899") === 5.899 (3 casas com ponto)', () => eq(AC.parsePrice("5.899"), 5.899));
test('parsePrice("100") é NaN (acima do teto de 99,99)', () => isNaNValue(AC.parsePrice("100")));
test('parsePrice("500") é NaN (erro de vírgula não gera veredito)', () => isNaNValue(AC.parsePrice("500")));
test('parsePrice("abc") é NaN', () => isNaNValue(AC.parsePrice("abc")));
test('parseKmL("12,5") === 12.5', () => eq(AC.parseKmL("12,5"), 12.5));
test('parseKmL("0,4") é NaN (abaixo do mínimo)', () => isNaNValue(AC.parseKmL("0,4")));
test('parseKmL("61") é NaN (acima do máximo)', () => isNaNValue(AC.parseKmL("61")));
test('parseKmL("0") é NaN', () => isNaNValue(AC.parseKmL("0")));
test("isValidKmL aceita número na faixa e rejeita o resto", () => {
  eq(AC.isValidKmL(12), true);
  eq(AC.isValidKmL(0.5), true);
  eq(AC.isValidKmL(60), true);
  eq(AC.isValidKmL(0.1), false);
  eq(AC.isValidKmL(61), false);
  eq(AC.isValidKmL("12"), false);
  eq(AC.isValidKmL(NaN), false);
  eq(AC.isValidKmL(Infinity), false);
});
test('priceStatus("") === "empty"', () => eq(AC.priceStatus(""), "empty"));
test('priceStatus("   ") === "empty"', () => eq(AC.priceStatus("   "), "empty"));
test('priceStatus("abc") === "invalid"', () => eq(AC.priceStatus("abc"), "invalid"));
test('priceStatus("0") === "invalid"', () => eq(AC.priceStatus("0"), "invalid"));
test('priceStatus("500") === "invalid" (teto de preço)', () => eq(AC.priceStatus("500"), "invalid"));
test('priceStatus("5,89") === "ok"', () => eq(AC.priceStatus("5,89"), "ok"));

section("formatação pt-BR");
test("fmtNum(67.7419, 1) === '67,7'", () => eq(AC.fmtNum(67.7419, 1), "67,7"));
test("fmtNum(1234.5, 1) === '1.234,5'", () => eq(AC.fmtNum(1234.5, 1), "1.234,5"));
test("fmtNum(69.5238, 1) === '69,5'", () => eq(AC.fmtNum(69.5238, 1), "69,5"));
test("fmtNum(NaN) === '—'", () => eq(AC.fmtNum(NaN), "\u2014"));
test("fmtNum(Infinity) === '—'", () => eq(AC.fmtNum(Infinity), "\u2014"));
test("fmtBRL(5.89) === 'R$ 5,89'", () => eq(AC.fmtBRL(5.89), "R$ 5,89"));
test("fmtBRL(1234.5) === 'R$ 1.234,50'", () => eq(AC.fmtBRL(1234.5), "R$ 1.234,50"));
test("fmtBRL(1.4377) === 'R$ 1,44'", () => eq(AC.fmtBRL(1.4377), "R$ 1,44"));
test("pctLabel(70) === '70%'", () => eq(AC.pctLabel(70), "70%"));
test("pctLabel(71.5) === '71,5%'", () => eq(AC.pctLabel(71.5), "71,5%"));
test("pctLabel(69.5238) === '69,5%'", () => eq(AC.pctLabel(69.5238), "69,5%"));
test("fmtNum(-0) === '0' (não exibe -0)", () => eq(AC.fmtNum(-0, 0), "0"));

section("toInputValue — repreenchimento sem perder precisão");
test("toInputValue(10.5) === '10,5'", () => eq(AC.toInputValue(10.5), "10,5"));
test("toInputValue(10) === '10'", () => eq(AC.toInputValue(10), "10"));
test("toInputValue(12.35) === '12,35' (não arredonda)", () => eq(AC.toInputValue(12.35), "12,35"));
test("toInputValue(NaN) === ''", () => eq(AC.toInputValue(NaN), ""));
test("ida e volta: toInputValue(parsePositive('12,35')) é reparseável", () => {
  close(AC.parsePositive(AC.toInputValue(AC.parsePositive("12,35"))), 12.35, 1e-12);
});

section("fastResult — regra dos 70/71%");
test("3,99 / 5,89 -> índice 67,74% e ETANOL no limite 70", () => {
  const r = AC.fastResult(5.89, 3.99, 70);
  ok(r, "resultado não pode ser null");
  close(r.pct, 67.7419, 1e-3);
  eq(r.verdict, "etanol");
  close(r.diffPp, -2.2581, 1e-3);
});
test("mesmo preço com limite 67% -> GASOLINA", () => {
  const r = AC.fastResult(5.89, 3.99, 67);
  eq(r.verdict, "gasolina");
});
test("4,20 / 5,89 = 71,3%: limite 70,5% -> GASOLINA", () => {
  const r = AC.fastResult(5.89, 4.2, 70.5);
  close(r.pct, 71.3073, 1e-3);
  eq(r.verdict, "gasolina");
});
test("4,20 / 5,89 = 71,3%: limite 71% -> empate técnico (0,3 p.p.)", () => {
  eq(AC.fastResult(5.89, 4.2, 71).verdict, "empate");
});
test("4,20 / 5,89 = 71,3%: limite 72% -> ETANOL", () => {
  eq(AC.fastResult(5.89, 4.2, 72).verdict, "etanol");
});
test("índice exatamente igual ao limite -> empate técnico", () => {
  const r = AC.fastResult(10, 7, 70);
  close(r.pct, 70, 1e-12);
  eq(r.verdict, "empate");
  close(r.gapPp, 0, 1e-12);
});
test("diferença de 0,4 p.p. -> empate técnico (tolerância 0,5 p.p.)", () => {
  eq(AC.fastResult(10, 7.04, 70).verdict, "empate");
});
test("diferença de 0,6 p.p. -> gasolina (fora da tolerância)", () => {
  eq(AC.fastResult(10, 7.06, 70).verdict, "gasolina");
});
test("diferença de 0,4 p.p. para baixo -> empate técnico", () => {
  eq(AC.fastResult(10, 6.96, 70).verdict, "empate");
});
test("g preço inválido -> null", () => isNull(AC.fastResult("abc", 3.99, 70)));
test("e preço zero -> null", () => isNull(AC.fastResult(5.89, 0, 70)));
test("limite zero -> null", () => isNull(AC.fastResult(5.89, 3.99, 0)));
test("limite inválido -> null", () => isNull(AC.fastResult(5.89, 3.99, "x")));
test("etanol mais caro que gasolina -> GASOLINA", () => {
  eq(AC.fastResult(5.0, 6.0, 70).verdict, "gasolina");
});
test("preços altos continuam válidos", () => {
  const r = AC.fastResult(8.99, 6.99, 70);
  close(r.pct, 77.7530, 1e-3);
  eq(r.verdict, "gasolina");
});
test("preço 500 é rejeitado (sem veredito absurdo)", () => isNull(AC.fastResult(500, 4.14, 72)));

section("fronteira exata do empate (±0,5 p.p.)");
test("diferença exatamente +0,5 p.p. -> gasolina (regra é < 0,5)", () => {
  const r = AC.fastResult(10, 7.05, 70);
  close(r.diffPp, 0.5, 1e-9);
  eq(r.verdict, "gasolina");
});
test("diferença exatamente -0,5 p.p. -> etanol", () => {
  const r = AC.fastResult(10, 6.95, 70);
  close(r.diffPp, -0.5, 1e-9);
  eq(r.verdict, "etanol");
});
test("roundPp elimina ruído de ponto flutuante", () => {
  eq(AC.roundPp(-0.499999999999993), -0.5);
  eq(AC.roundPp(0.499999999999993), 0.5);
  eq(AC.roundPp(0.1234567891234), 0.123456789);
});

section("preciseResult — custo por km");
const base = AC.preciseResult(5.89, 3.99, 10.5, 7.3);
test("resultado válido para 10,5 / 7,3 km/L", () => ok(base, "resultado não pode ser null"));
test("custo por 100 km: gasolina R$ 56,10", () => close(base.per100Gas, 56.095238, 1e-5));
test("custo por 100 km: etanol R$ 54,66", () => close(base.per100Eta, 54.657534, 1e-5));
test("limite pessoal 69,52%", () => close(base.personalPct, 69.523810, 1e-5));
test("índice de preço 67,74% -> ETANOL", () => {
  close(base.pct, 67.7419, 1e-3);
  eq(base.verdict, "etanol");
});
test("economia por 100 km = R$ 1,44", () => close(base.savingsPer100, 1.437704, 1e-5));
test("preço de equilíbrio do etanol = R$ 4,09", () => close(base.breakEvenEta, 4.094952, 1e-5));
test("preço de equilíbrio da gasolina = R$ 5,74", () => close(base.breakEvenGas, 5.739041, 1e-5));
test("consumo em litros por 100 km", () => {
  close(base.litersPer100Gas, 9.523810, 1e-5);
  close(base.litersPer100Eta, 13.698630, 1e-5);
});
test("gasolina vence quando o etanol está caro", () => {
  const r = AC.preciseResult(5.89, 4.5, 10.5, 7.3);
  eq(r.verdict, "gasolina");
  close(r.savingsPer100, Math.abs(r.per100Gas - r.per100Eta), 1e-9);
});
test("preço de equilíbrio confere com o preço praticado no empate", () => {
  const r = AC.preciseResult(5.89, 4.094952, 10.5, 7.3);
  eq(r.verdict, "empate");
});
test("consumo zero -> null", () => isNull(AC.preciseResult(5.89, 3.99, 0, 7.3)));
test("consumo negativo textual -> null", () => isNull(AC.preciseResult(5.89, 3.99, "-10", 7.3)));
test("preço faltando -> null", () => isNull(AC.preciseResult("", 3.99, 10.5, 7.3)));
test("consumos iguais -> limite pessoal 100% (etanol nunca vence)", () => {
  const r = AC.preciseResult(5.0, 4.9, 10, 10);
  close(r.personalPct, 100, 1e-9);
  eq(r.verdict, "etanol");
});

section("gauge");
test("gaugePos(55) === 0", () => close(AC.gaugePos(55), 0, 1e-12));
test("gaugePos(85) === 100", () => close(AC.gaugePos(85), 100, 1e-12));
test("gaugePos(70) === 50", () => close(AC.gaugePos(70), 50, 1e-12));
test("gaugePos(50) clampa em 0", () => close(AC.gaugePos(50), 0, 1e-12));
test("gaugePos(90) clampa em 100", () => close(AC.gaugePos(90), 100, 1e-12));
test("gaugePos(NaN) === 0", () => close(AC.gaugePos(NaN), 0, 1e-12));
test("gaugeOutside(54) / gaugeOutside(55)", () => {
  eq(AC.gaugeOutside(54), true);
  eq(AC.gaugeOutside(55), false);
  eq(AC.gaugeOutside(85), false);
  eq(AC.gaugeOutside(86), true);
});

section("consistência veredito × texto × cor (bug da v1)");
test("empate técnico NUNCA diz 'acima' ou 'abaixo' do limite", () => {
  const r = AC.fastResult(5.0, 3.51, 70); // 70,2% vs limite 70% -> empate
  eq(r.verdict, "empate");
  const txt = AC.gapText(r);
  includes(txt, "dentro da margem");
  notIncludes(txt, "acima");
  notIncludes(txt, "abaixo");
});
test("veredito etanol diz 'abaixo do limite'", () => {
  const txt = AC.gapText(AC.fastResult(5.89, 3.99, 72));
  includes(txt, "abaixo do limite");
});
test("veredito gasolina diz 'acima do limite'", () => {
  const txt = AC.gapText(AC.fastResult(5.89, 4.8, 72));
  includes(txt, "acima do limite");
});
test("invariante: empate implica |diferença| < EPS_PP", () => {
  for (let g = 3; g <= 9; g += 0.1) {
    for (let e = 2; e <= 7; e += 0.05) {
      for (let t = 55; t <= 85; t += 0.5) {
        const r = AC.fastResult(g, e, t);
        if (!r) continue;
        if (r.verdict === "empate") {
          if (!(r.gapPp < AC.EPS_PP)) {
            throw new Error(`empate com gap ${r.gapPp} em g=${g} e=${e} t=${t}`);
          }
          if (/acima|abaixo/.test(AC.gapText(r))) {
            throw new Error(`texto contraditório em g=${g} e=${e} t=${t}: ${AC.gapText(r)}`);
          }
        } else if (r.gapPp < AC.EPS_PP) {
          throw new Error(`deveria ser empate em g=${g} e=${e} t=${t}`);
        }
      }
    }
  }
});

section("avisos de sanidade");
test("preços normais não geram aviso", () => {
  eq(AC.sanityWarnings(AC.fastResult(6.54, 4.14, 72)).length, 0);
});
test("preço no limite superior ainda é válido e gera aviso", () => {
  const r = AC.fastResult(9.9, 4.14, 72);
  ok(r, "9,90 deveria ser válido");
  const w = AC.sanityWarnings(r);
  ok(w.some((t) => /gasolina/i.test(t)), `avisos: ${w.join(" | ")}`);
});
test("etanol absurdamente caro gera aviso de relação", () => {
  const w = AC.sanityWarnings(AC.fastResult(5.0, 6.0, 72));
  ok(w.some((t) => /Relação|relação/i.test(t)), "deveria avisar relação fora da faixa");
});
test("consumos incoerentes no modo preciso geram aviso", () => {
  const w = AC.sanityWarnings(AC.preciseResult(6.54, 4.14, 12, 11.5));
  ok(w.some((t) => /Consumos inconsistentes/i.test(t)), `avisos: ${w.join(" | ")}`);
});
test("consumos coerentes não geram aviso", () => {
  eq(AC.sanityWarnings(AC.preciseResult(6.54, 4.14, 12, 8.6)).length, 0);
});
test("sanityWarnings(null) === []", () => eq(AC.sanityWarnings(null).length, 0));
test("rótulos de veredito", () => {
  eq(AC.verdictLabel("etanol"), "Abasteça com ETANOL");
  eq(AC.verdictLabel("gasolina"), "Abasteça com GASOLINA");
  eq(AC.verdictLabel("empate"), "Empate técnico — indiferente");
  eq(AC.verdictLabel("outro"), "");
});
test("shareText do modo rápido menciona o veredito", () => {
  const s = AC.shareText(AC.fastResult(5.89, 3.99, 70));
  includes(s, "ETANOL");
  includes(s, "67,7%");
  includes(s, "70%");
  notIncludes(s, "NaN");
  notIncludes(s, "undefined");
});
test("shareText do modo preciso menciona custos", () => {
  const s = AC.shareText(AC.preciseResult(5.89, 3.99, 10.5, 7.3));
  includes(s, "ETANOL");
  includes(s, "R$ 54,66");
  includes(s, "R$ 56,10");
  notIncludes(s, "NaN");
});
test("shareText(null) === ''", () => eq(AC.shareText(null), ""));

section("v3 — preços de referência ANP");
const samplePrices = {
  fonte: "ANP — Levantamento de Preços",
  semana: { inicio: "2026-10-04", fim: "2026-10-10" },
  brasil: {
    gasolinaComum: { media: 6.54, min: 5.39, max: 8.99, postos: 4474 },
    gasolinaAditivada: { media: 6.72 },
    etanol: { media: 4.14 }
  },
  estados: {
    SP: { gasolinaComum: 6.36, etanol: 3.86 },
    RN: { gasolinaComum: 6.6, etanol: 5.03 },
    XX: {},
    "s": { gasolinaComum: 1, etanol: 1 }
  }
};
test("normalizePrices aceita o schema do precos.json", () => {
  const p = AC.normalizePrices(samplePrices);
  ok(p, "deveria normalizar");
  close(p.brasil.gasolina, 6.54, 1e-12);
  close(p.brasil.aditivada, 6.72, 1e-12);
  close(p.brasil.etanol, 4.14, 1e-12);
  close(p.estados.SP.gasolina, 6.36, 1e-12);
  close(p.estados.SP.etanol, 3.86, 1e-12);
  eq(Object.keys(p.estados).length, 2, "UFs inválidas devem ser descartadas");
  eq(p.semana.inicio, "2026-10-04");
});
test("normalizePrices rejeita dados incompletos", () => {
  isNull(AC.normalizePrices(null));
  isNull(AC.normalizePrices({}));
  isNull(AC.normalizePrices({ brasil: {} }));
  isNull(AC.normalizePrices({ brasil: { gasolinaComum: { media: 6.54 } } }), "falta etanol");
  isNull(AC.normalizePrices({ brasil: { gasolinaComum: { media: 0 }, etanol: { media: 4 } } }), "média zero");
  isNull(AC.normalizePrices({ brasil: { gasolinaComum: { media: "abc" }, etanol: { media: 4 } } }), "média inválida");
});
test("normalizePrices tolera semana malformada e estados ruins", () => {
  const p = AC.normalizePrices({
    brasil: { gasolinaComum: { media: 6.5 }, etanol: { media: 4.1 } },
    semana: { inicio: "2026-10", fim: "x" },
    estados: { sp: { gasolinaComum: 1, etanol: 1 } }
  });
  ok(p);
  isNull(p.semana, "semana inválida deve virar null");
  eq(Object.keys(p.estados).length, 0);
});
test("formatWeek formata mesma semana e virada de mês", () => {
  eq(AC.formatWeek({ inicio: "2026-10-04", fim: "2026-10-10" }), "04\u201310/10/2026");
  eq(AC.formatWeek({ inicio: "2026-09-27", fim: "2026-10-03" }), "27/09/2026\u201303/10/2026");
  eq(AC.formatWeek({ inicio: "x", fim: "2026-10-10" }), "");
  eq(AC.formatWeek(null), "");
});

section("v3 — histórico local");
test("historyEntry monta entrada a partir do resultado", () => {
  const r = AC.fastResult(6.54, 4.14, 72);
  const e = AC.historyEntry(r, 1750000000000);
  ok(e, "deveria criar entrada");
  eq(e.mode, "fast");
  close(e.gas, 6.54, 1e-12);
  close(e.eta, 4.14, 1e-12);
  close(e.pct, 63.3, 1e-9);
  close(e.threshold, 72, 1e-12);
  eq(e.verdict, "etanol");
  eq(e.ts, 1750000000000);
});
test("historyEntry usa modo preciso quando aplicável", () => {
  const e = AC.historyEntry(AC.preciseResult(6.54, 4.14, 12, 8.6), 1);
  eq(e.mode, "precise");
  close(e.pct, 63.3, 1e-9);
  close(e.threshold, 71.7, 0.05);
});
test("historyEntry rejeita resultado/timestamp inválidos", () => {
  isNull(AC.historyEntry(null, 1));
  isNull(AC.historyEntry(AC.fastResult(6.54, 4.14, 72), NaN));
  isNull(AC.historyEntry(AC.fastResult("abc", 4.14, 72), 1));
});
test("historyCsv tem cabeçalho, ponto e vírgula e decimal pt-BR", () => {
  const csv = AC.historyCsv([
    AC.historyEntry(AC.fastResult(6.54, 4.14, 72), 1750000000000),
    AC.historyEntry(AC.preciseResult(6.54, 4.14, 12, 8.6), 1750000600000)
  ]);
  const lines = csv.split("\r\n");
  eq(lines[0], "data;hora;modo;gasolina;etanol;indice_percentual;limite;veredito");
  eq(lines.length, 3);
  includes(lines[1], ";rapido;");
  includes(lines[1], "6,54");
  includes(lines[1], "4,14");
  includes(lines[1], ";72;etanol");
  includes(lines[2], ";preciso;");
});
test("historyCsv ignora entradas inválidas", () => {
  const csv = AC.historyCsv([null, {}, { ts: "x" }, AC.historyEntry(AC.fastResult(6.5, 4.1, 72), 1)]);
  eq(csv.split("\r\n").length, 2);
});
test("historyCsv sanitiza veredito hostil (sem tag e sem separador extra)", () => {
  const csv = AC.historyCsv([{
    ts: 1750000000000, mode: "fast", gas: 6.54, eta: 4.14,
    pct: 63.3, threshold: 72, verdict: '"><img src=x onerror=alert(1)>'
  }]);
  const row = csv.split("\r\n")[1];
  eq(row.split(";").length, 8, "linha do CSV precisa ter 8 colunas");
  notIncludes(row, "<", "CSV não pode conter tag");
  notIncludes(row, "alert");
});
test("fmtDateTime devolve dd/mm/aaaa hh:mm", () => {
  ok(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(AC.fmtDateTime(1750000000000)), AC.fmtDateTime(1750000000000));
  eq(AC.fmtDateTime(NaN), "");
});
test("verdictShort", () => {
  eq(AC.verdictShort("etanol"), "Etanol");
  eq(AC.verdictShort("gasolina"), "Gasolina");
  eq(AC.verdictShort("empate"), "Empate");
  eq(AC.verdictShort("x"), "Empate");
});
test("sparkline precisa de ao menos 2 pontos", () => {
  isNull(AC.sparkline([], 320, 90));
  isNull(AC.sparkline([63], 320, 90));
  isNull(AC.sparkline(null, 320, 90));
});
test("sparkline gera caminho e yFor dentro do viewBox", () => {
  const sp = AC.sparkline([63, 70, 68, 75], 320, 90);
  ok(sp, "deveria gerar");
  eq(sp.points.length, 4);
  ok(sp.path.indexOf("M") === 0, "path começa com M");
  for (const p of sp.points) {
    ok(p.x >= 0 && p.x <= 320, `x fora: ${p.x}`);
    ok(p.y >= 0 && p.y <= 90, `y fora: ${p.y}`);
  }
  const y = sp.yFor(70);
  ok(y >= 0 && y <= 90, `yFor fora: ${y}`);
});
test("sparkline lida com valores todos iguais", () => {
  const sp = AC.sparkline([70, 70, 70], 320, 90);
  ok(sp, "deveria gerar mesmo sem variação");
  ok(sp.max > sp.min, "faixa precisa ser não nula");
});

section("integridade do HTML");
test("todo id referenciado no script existe no HTML", () => {
  const ids = new Set();
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
  const refs = new Set();
  for (const m of html.matchAll(/getElementById\("([^"]+)"\)/g)) refs.add(m[1]);
  for (const m of html.matchAll(/\$\("([^"]+)"\)/g)) refs.add(m[1]);
  for (const m of html.matchAll(/aria-(?:describedby|controls|labelledby)="([^"]+)"/g)) {
    for (const part of m[1].split(/\s+/)) refs.add(part);
  }
  const missing = [...refs].filter((r) => !ids.has(r));
  if (missing.length) throw new Error(`ids ausentes: ${missing.join(", ")}`);
});
test("não há ids duplicados", () => {
  const seen = new Set();
  const dups = [];
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) {
    if (seen.has(m[1])) dups.push(m[1]);
    seen.add(m[1]);
  }
  if (dups.length) throw new Error(`ids duplicados: ${[...new Set(dups)].join(", ")}`);
});
test("todo label tem for apontando para um id existente", () => {
  const ids = new Set();
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
  const bad = [];
  for (const m of html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)) {
    if (!ids.has(m[1])) bad.push(m[1]);
  }
  if (bad.length) throw new Error(`labels órfãos: ${bad.join(", ")}`);
});
test("não há recursos externos obrigatórios (offline-first)", () => {
  const external = [
    ...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="(https?:)?\/\/[^"]+"/g),
    ...html.matchAll(/@import\s+url\(/g)
  ];
  eq(external.length, 0, "recursos externos");
});
test("manifest e ícones são referenciados com caminho relativo", () => {
  includes(html, 'href="./manifest.webmanifest"');
  includes(html, 'href="./icons/favicon.svg"');
  includes(html, 'href="./icons/apple-touch-icon.png"');
});

// ------------------------------------------------------------------ resumo
process.stdout.write(`\n${"=".repeat(60)}\n`);
if (failed === 0) {
  process.stdout.write(`OK — ${passed} testes passaram.\n`);
} else {
  process.stdout.write(`FALHOU — ${failed} de ${passed + failed} testes.\n`);
  for (const f of failures) {
    process.stdout.write(`  • ${f.name}: ${f.err.message}\n`);
  }
}
process.stdout.write(`${"=".repeat(60)}\n`);
process.exitCode = failed === 0 ? 0 : 1;
