#!/usr/bin/env node
/**
 * Abastece Certo — verificação visual automatizada.
 *
 * Abre o app no Microsoft Edge em modo headless, conversa com ele pelo
 * DevTools Protocol (WebSocket nativo do Node — zero dependências), preenche os
 * campos como um usuário faria, troca de aba, salva um veículo e captura
 * screenshots de cada estado. Também coleta erros de console e de página.
 *
 * Uso: node tools/visual-check.mjs [--keep]
 * Saída: screenshots/*.png
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const SHOTS = join(ROOT, "screenshots");
const PORT = 5391;
const DEBUG_PORT = 9411;
const KEEP = process.argv.includes("--keep");

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].filter(Boolean);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

// ------------------------------------------------------------------ servidor
function startServer() {
  const server = createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    } catch {
      res.writeHead(403).end("forbidden");
      return;
    }
    let target = normalize(join(ROOT, urlPath));
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      if (!existsSync(target) || !readFileSync(target).length) throw new Error("vazio");
    } catch {
      target = join(ROOT, "index.html");
    }
    if (!existsSync(target) || !extname(target)) target = join(ROOT, "index.html");
    res.writeHead(200, {
      "Content-Type": MIME[extname(target).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(readFileSync(target));
  });
  return new Promise((ok) => server.listen(PORT, "127.0.0.1", () => ok(server)));
}

// --------------------------------------------------------------- CDP client
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    this.events = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data || "")})`));
        else resolve(msg.result);
        return;
      }
      this.events.push(msg);
      for (const l of [...this.listeners]) l(msg);
    });
  }

  static async connect(url, timeoutMs = 15000) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout no WebSocket do CDP")), timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("falha no WebSocket do CDP")); }, { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout na chamada CDP ${method}`));
        }
      }, 30000);
    });
  }

  waitFor(method, sessionId, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((l) => l !== listener);
        reject(new Error(`timeout esperando evento ${method}`));
      }, timeoutMs);
      const listener = (msg) => {
        if (msg.method === method && (!sessionId || msg.sessionId === sessionId)) {
          clearTimeout(timer);
          this.listeners = this.listeners.filter((l) => l !== listener);
          resolve(msg.params);
        }
      };
      this.listeners.push(listener);
    });
  }

  close() {
    try { this.ws.close(); } catch { /* já fechado */ }
  }
}

async function fetchJson(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch { /* Edge ainda subindo */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`não consegui falar com o Edge em ${url}`);
}

// -------------------------------------------------------------------- ações
const errors = [];
const logs = [];

function recordEvents(cdp, sessionId) {
  cdp.listeners.push((msg) => {
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails || {};
      errors.push(d.exception?.description || d.text || "exceção sem detalhes");
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
      logs.push(`[${msg.params.type}] ${text}`);
      if (msg.params.type === "error") errors.push(text);
    }
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      errors.push(`${msg.params.entry.source}: ${msg.params.entry.text}`);
    }
  });
}

class Page {
  constructor(cdp, sessionId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
  }

  async eval(expression) {
    const result = await this.cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      this.sessionId
    );
    if (result.exceptionDetails) {
      throw new Error(`erro no JS avaliado: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  async setViewport(width, height, dsf = 2) {
    await this.cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: dsf, mobile: width < 600 },
      this.sessionId
    );
  }

  // Captura exatamente a área pedida (para screenshots do manifest, que exigem
  // tamanhos fixos e não podem variar com o conteúdo). O clip é em coordenadas
  // do documento, então capturamos "além do viewport" a partir de um y escolhido.
  async shotClip(name, width, height, y = 0) {
    const result = await this.cdp.send(
      "Page.captureScreenshot",
      {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y, width, height, scale: 1 }
      },
      this.sessionId
    );
    const file = join(SHOTS, `${name}.png`);
    writeFileSync(file, Buffer.from(result.data, "base64"));
    console.log(`  screenshot ${name}.png (${width}x${height} @ y=${y})`);
    return file;
  }

  async shot(name) {
    const metrics = await this.cdp.send("Page.getLayoutMetrics", {}, this.sessionId);
    const size = metrics.cssContentSize || metrics.contentSize;
    const result = await this.cdp.send(
      "Page.captureScreenshot",
      {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }
      },
      this.sessionId
    );
    const file = join(SHOTS, `${name}.png`);
    writeFileSync(file, Buffer.from(result.data, "base64"));
    console.log(`  screenshot ${name}.png (${Math.ceil(size.width)}x${Math.ceil(size.height)})`);
    return file;
  }
}

// --------------------------------------------------------------------- main
async function main() {
  const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!edge) {
    console.log("Edge não encontrado — verificação visual ignorada.");
    console.log("Dica: defina EDGE_PATH ou use 'node tools/serve.mjs' e abra no navegador.");
    return;
  }
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

  const profile = join(tmpdir(), `abastece-visual-${Date.now()}`);
  const server = await startServer();
  let browser = null;

  try {
    browser = spawn(
      edge,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--force-color-profile=srgb",
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${profile}`,
        "about:blank"
      ],
      { stdio: "ignore" }
    );

    const info = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    console.log(`  Edge: ${info["Browser"] || "Microsoft Edge"}`);

    const cdp = await CDP.connect(info.webSocketDebuggerUrl);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Log.enable", {}, sessionId);
    recordEvents(cdp, sessionId);

    const page = new Page(cdp, sessionId);
    await page.setViewport(430, 900);

    // Tema claro como padrão das capturas (independente do SO de quem roda).
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }]
    }, sessionId);

    const loaded = cdp.waitFor("Page.loadEventFired", sessionId);
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` }, sessionId);
    await loaded;
    await new Promise((r) => setTimeout(r, 400));

    // ---- 1. estado inicial (modo rápido, sem preços)
    console.log("\n1) estado inicial");
    await page.shot("01-rapido-vazio");
    const initial = await page.eval(`(() => ({
      limite: document.getElementById('thresholdVal').textContent.trim(),
      presetAtivo: document.querySelector('.presets button.active small')?.textContent.trim()
    }))()`);
    console.log(`   ${JSON.stringify(initial)}`);
    if (initial.limite !== "72%") errors.push(`limite inicial deveria ser 72% (E32), obtive ${initial.limite}`);
    if (initial.presetAtivo !== "E32 · atual") errors.push(`preset ativo inesperado: ${initial.presetAtivo}`);

    // ---- 2. modo rápido com os dois preços
    console.log("2) modo rápido com preços");
    const fast = await page.eval(`(() => {
      const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set('gas', '5,89');
      set('eta', '3,99');
      return {
        veredito: document.querySelector('.verdict')?.innerText.trim(),
        indice: document.querySelector('.result .big')?.innerText.trim(),
        hint: document.getElementById('gasHint').textContent
      };
    })()`);
    console.log(`   ${JSON.stringify(fast)}`);
    await page.shot("02-rapido-resultado");
    if (!fast.veredito || !/ETANOL/.test(fast.veredito)) errors.push(`veredito inesperado no modo rápido: ${fast.veredito}`);
    if (!/67,7/.test(fast.indice || "")) errors.push(`índice inesperado: ${fast.indice}`);

    // ---- 3. referência ANP (precos.json) e "Usar médias"
    console.log("3) referência ANP + usar médias");
    const anp = await page.eval(`(() => {
      const ref = document.getElementById('priceRef');
      const use = document.getElementById('refUse');
      const sel = document.getElementById('refUf');
      if (!use) return { carregou: false, texto: ref.innerText.trim() };
      use.click();
      return {
        carregou: true,
        texto: ref.innerText.trim(),
        opcoesUf: sel ? sel.options.length : 0,
        gas: document.getElementById('gas').value,
        eta: document.getElementById('eta').value,
        indice: document.querySelector('.result .big')?.innerText.trim()
      };
    })()`);
    console.log(`   ${JSON.stringify(anp)}`);
    if (!anp.carregou) errors.push("precos.json não carregou (bloco de referência ANP ausente)");
    if (anp.carregou && (anp.gas !== "6,54" || anp.eta !== "4,14")) {
      errors.push(`"Usar médias" deveria preencher 6,54/4,14, obteve ${anp.gas}/${anp.eta}`);
    }
    if (anp.carregou && anp.opcoesUf < 2) errors.push("seletor de UF vazio");
    await page.shot("07-referencia-anp");

    // ---- 4. preço de etanol caro -> gasolina
    console.log("4) preço de etanol caro -> gasolina");
    const gasVerdict = await page.eval(`(() => {
      const el = document.getElementById('eta');
      el.value = '4,80'; el.dispatchEvent(new Event('input', { bubbles: true }));
      return document.querySelector('.verdict')?.innerText.trim();
    })()`);
    console.log(`   ${gasVerdict}`);
    if (!/GASOLINA/.test(gasVerdict || "")) errors.push(`esperava GASOLINA, obtive: ${gasVerdict}`);

    // ---- 5. preço inválido mostra dica
    console.log("5) validação de preço inválido");
    const invalid = await page.eval(`(() => {
      const el = document.getElementById('eta');
      el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        valor: el.value,
        hint: document.getElementById('etaHint').textContent,
        invalid: document.getElementById('eta').getAttribute('aria-invalid'),
        resultado: document.getElementById('resultOut').innerText.trim()
      };
    })()`);
    console.log(`   ${JSON.stringify(invalid)}`);
    if (!invalid.hint) errors.push("preço inválido deveria mostrar dica");
    if (invalid.invalid !== "true") errors.push("preço inválido deveria marcar aria-invalid");

    // ---- 6. empate técnico: veredito, texto e cor têm de concordar
    console.log("6) empate técnico (consistência veredito × texto × cor)");
    const tie = await page.eval(`(() => {
      const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      const t = document.getElementById('threshold');
      t.value = '70'; t.dispatchEvent(new Event('input', { bubbles: true }));
      set('gas', '5,00'); set('eta', '3,51');
      return {
        veredito: document.querySelector('.verdict')?.innerText.trim(),
        label: document.querySelector('.result .label')?.innerText.trim(),
        cor: document.querySelector('.dot-ratio')?.className,
        avisos: document.querySelectorAll('.warn li').length
      };
    })()`);
    console.log(`   ${JSON.stringify(tie)}`);
    if (!/Empate/.test(tie.veredito || "")) errors.push(`esperava empate técnico, obtive ${tie.veredito}`);
    if (!/amber/.test(tie.cor || "")) errors.push(`marcador do empate deveria ser âmbar, obtive ${tie.cor}`);
    if (/acima|abaixo/.test(tie.label || "")) errors.push(`texto contraditório no empate: ${tie.label}`);
    await page.shot("06-empate-tecnico");

    // ---- 7. modo preciso
    console.log("7) modo preciso (consumo real)");
    const precise = await page.eval(`(() => {
      const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set('gas', '5,89');
      set('eta', '3,99');
      document.getElementById('tab-precise').click();
      set('gasKmL', '10,5');
      set('etaKmL', '7,3');
      return {
        veredito: document.querySelector('.verdict')?.innerText.trim(),
        grande: document.querySelector('.result .big')?.innerText.trim(),
        nota: document.querySelector('.note')?.innerText.trim(),
        aba: document.getElementById('tab-precise').getAttribute('aria-selected')
      };
    })()`);
    console.log(`   ${JSON.stringify(precise)}`);
    await page.shot("03-preciso-resultado");
    if (!/ETANOL/.test(precise.veredito || "")) errors.push(`modo preciso: esperava ETANOL, obtive ${precise.veredito}`);
    if (!/R\$\s*1,44/.test(precise.grande || "")) errors.push(`economia esperada R$ 1,44, obtive ${precise.grande}`);

    // ---- 8. histórico local (salvar, sparkline, exportação)
    console.log("8) histórico local (salvar, sparkline, CSV)");
    const hist = await page.eval(`(() => {
      const save = () => document.querySelector('[data-action="save"]').click();
      save();
      const g = document.getElementById('gas');
      g.value = '6,50'; g.dispatchEvent(new Event('input', { bubbles: true }));
      const e = document.getElementById('eta');
      e.value = '4,10'; e.dispatchEvent(new Event('input', { bubbles: true }));
      save();
      const details = document.querySelector('.hist details');
      if (details) details.open = true;
      return {
        contagem: document.getElementById('histCount').textContent,
        itens: document.querySelectorAll('#histList .hist-item').length,
        spark: !!document.querySelector('#histChart svg path'),
        pontos: document.querySelectorAll('#histChart circle').length,
        exportHabilitado: !document.getElementById('histExport').disabled,
        persistiu: !!localStorage.getItem('ac.v3.history')
      };
    })()`);
    console.log(`   ${JSON.stringify(hist)}`);
    if (hist.contagem !== "2") errors.push(`histórico deveria ter 2 entradas, obteve ${hist.contagem}`);
    if (hist.itens !== 2) errors.push(`lista do histórico deveria ter 2 itens, obteve ${hist.itens}`);
    if (!hist.spark) errors.push("sparkline do histórico não foi gerada");
    if (hist.pontos !== 2) errors.push(`sparkline deveria ter 2 pontos, obteve ${hist.pontos}`);
    if (!hist.exportHabilitado) errors.push("exportar CSV deveria estar habilitado");
    if (!hist.persistiu) errors.push("histórico não foi persistido no localStorage");
    await page.shot("08-historico");

    // ---- 9. salvar veículo e recarregar (persistência em localStorage)
    console.log("9) salvar veículo + recarregar");
    const saved = await page.eval(`(() => {
      const el = document.getElementById('vehName');
      el.value = 'Onix 1.4'; el.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('vehSave').click();
      const raw = localStorage.getItem('ac.v2');
      return { toast: document.getElementById('toast').textContent, salvo: !!raw && raw.includes('Onix 1.4') };
    })()`);
    console.log(`   ${JSON.stringify(saved)}`);
    if (!saved.salvo) errors.push("veículo não foi persistido no localStorage");

    const reloaded = cdp.waitFor("Page.loadEventFired", sessionId);
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` }, sessionId);
    await reloaded;
    await new Promise((r) => setTimeout(r, 500));
    const restored = await page.eval(`(() => ({
      aba: document.getElementById('tab-precise').getAttribute('aria-selected'),
      nome: document.getElementById('vehName').value,
      gasKmL: document.getElementById('gasKmL').value,
      opcoes: document.getElementById('vehicleSelect').options.length,
      precoGas: document.getElementById('gas').value,
      histCount: document.getElementById('histCount').textContent
    }))()`);
    console.log(`   ${JSON.stringify(restored)}`);
    if (restored.nome !== "Onix 1.4") errors.push(`nome do veículo não restaurado: ${restored.nome}`);
    if (restored.aba !== "true") errors.push("modo preciso não restaurado após reload");
    if (restored.opcoes < 2) errors.push("veículo salvo não apareceu no seletor");
    if (restored.histCount !== "2") errors.push(`histórico deveria sobreviver ao reload (2), obteve ${restored.histCount}`);
    await page.shot("04-preciso-veiculo-salvo");

    // ---- 10. viewport estreito (360px)
    console.log("10) viewport estreito 360px");
    await page.setViewport(360, 900);
    await new Promise((r) => setTimeout(r, 300));
    const overflow = await page.eval(`(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      bigFits: (() => { const b = document.querySelector('.result .big'); if (!b) return true; const r = b.getBoundingClientRect(); return r.width <= document.documentElement.clientWidth; })()
    }))()`);
    console.log(`   ${JSON.stringify(overflow)}`);
    if (overflow.scrollW > overflow.clientW + 1) errors.push(`overflow horizontal em 360px (${overflow.scrollW} > ${overflow.clientW})`);
    await page.shot("05-estreito-360");

    // ---- 11. acessibilidade básica: foco e tamanho de alvo
    console.log("11) acessibilidade (alvos de toque e foco)");
    await page.setViewport(430, 900);
    const a11y = await page.eval(`(() => {
      const small = [];
      document.querySelectorAll('button, input, select').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.height < 32) small.push(el.id || el.textContent.trim().slice(0, 12) || el.tagName);
      });
      const tab = document.getElementById('tab-precise');
      tab.focus();
      return { alvosPequenos: small, focoOk: document.activeElement === tab };
    })()`);
    console.log(`   ${JSON.stringify(a11y)}`);
    if (a11y.alvosPequenos.length) errors.push(`alvos de toque < 32px: ${a11y.alvosPequenos.join(", ")}`);
    if (!a11y.focoOk) errors.push("foco programático não funcionou na aba");

    // ---- 12. atalho do manifest (?modo=preciso)
    console.log("12) atalho do manifest ?modo=preciso");
    const shortcutLoaded = cdp.waitFor("Page.loadEventFired", sessionId);
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/?modo=preciso` }, sessionId);
    await shortcutLoaded;
    await new Promise((r) => setTimeout(r, 400));
    const shortcut = await page.eval(`(() => ({
      aba: document.getElementById('tab-precise').getAttribute('aria-selected'),
      painelVisivel: !document.getElementById('panel-precise').hidden
    }))()`);
    console.log(`   ${JSON.stringify(shortcut)}`);
    if (shortcut.aba !== "true" || !shortcut.painelVisivel) errors.push("atalho ?modo=preciso não abriu o modo preciso");

    // ---- 13. screenshots do manifest (tamanhos fixos e estáveis)
    console.log("13) screenshots do manifest");
    const resultOffset = `(() => {
      const r = document.querySelector('.result');
      return r ? Math.max(0, Math.round(r.offsetTop) - 90) : 0;
    })()`;
    await page.setViewport(1280, 720, 1);
    await new Promise((r) => setTimeout(r, 400));
    const yWide = await page.eval(resultOffset);
    await page.shotClip("install-wide-1280x720", 1280, 720, yWide);
    await page.setViewport(430, 932, 1);
    await new Promise((r) => setTimeout(r, 400));
    const yNarrow = await page.eval(resultOffset);
    await page.shotClip("install-narrow-430x932", 430, 932, yNarrow);

    // ---- 14. máscara de preço digitando de verdade (Input.insertText)
    console.log("14) máscara de preço (digitação real)");
    await page.setViewport(430, 900);
    await new Promise((r) => setTimeout(r, 200));
    await page.eval(`(() => { const el = document.getElementById('gas'); el.focus(); el.select(); return true; })()`);
    await cdp.send("Input.insertText", { text: "456" }, sessionId);
    await new Promise((r) => setTimeout(r, 150));
    const maskTyped = await page.eval(`({
      gas: document.getElementById('gas').value,
      hint: document.getElementById('priceHelp').innerText
    })`);
    console.log(`   ${JSON.stringify(maskTyped)}`);
    if (maskTyped.gas !== "4,56") errors.push(`máscara: digitando 456 esperava 4,56, obteve ${maskTyped.gas}`);

    // regressão: digitação tecla por tecla (6 → 5 → 4) não pode embaralhar os dígitos
    await page.eval(`(() => { const el = document.getElementById('eta'); el.focus(); el.select(); return true; })()`);
    for (const digito of ["6", "5", "4"]) {
      await cdp.send("Input.insertText", { text: digito }, sessionId);
      await new Promise((r) => setTimeout(r, 80));
    }
    const maskSequencial = await page.eval(`document.getElementById('eta').value`);
    console.log(`   sequencial: ${maskSequencial}`);
    if (maskSequencial !== "6,54") {
      errors.push(`máscara sequencial: digitando 6,5,4 esperava 6,54, obteve ${maskSequencial}`);
    }

    // ---- 15. temas: padrão escuro, alternância e automático
    console.log("15) temas (padrão escuro → automático → claro)");
    const tema = await page.eval(`(() => {
      const btn = document.getElementById('themeBtn');
      const root = document.documentElement;
      const out = { inicial: root.getAttribute('data-theme'), modoInicial: root.getAttribute('data-theme-mode') };
      btn.click();                                   // escuro -> automático (sistema claro)
      out.autoTema = root.getAttribute('data-theme');
      out.autoModo = root.getAttribute('data-theme-mode');
      btn.click();                                   // automático -> claro
      out.claroTema = root.getAttribute('data-theme');
      out.claroModo = root.getAttribute('data-theme-mode');
      out.persistido = localStorage.getItem('ac.theme');
      return out;
    })()`);
    await new Promise((r) => setTimeout(r, 450));
    const temaClaroVisual = await page.eval(`({
      fundo: getComputedStyle(document.body).backgroundColor,
      meta: (document.querySelector('meta[name="theme-color"]') || {}).content,
      tabBg: getComputedStyle(document.querySelector('.tabs button[aria-selected="true"]')).backgroundColor,
      cardBg: getComputedStyle(document.querySelector('.card')).backgroundColor
    })`);
    console.log(`   ${JSON.stringify(tema)}`);
    console.log(`   ${JSON.stringify(temaClaroVisual)}`);
    if (tema.inicial !== "dark") errors.push(`tema inicial deveria ser escuro, obteve ${tema.inicial}`);
    if (tema.modoInicial !== "dark") errors.push(`modo inicial deveria ser escuro, obteve ${tema.modoInicial}`);
    if (tema.autoModo !== "auto" || tema.autoTema !== "light") {
      errors.push(`automático com sistema claro deveria resolver claro: ${JSON.stringify(tema)}`);
    }
    if (tema.claroTema !== "light" || tema.persistido !== "light") {
      errors.push(`tema claro não aplicado/persistido: ${JSON.stringify(tema)}`);
    }
    if (!/rgb\(241, 244, 249\)/.test(temaClaroVisual.fundo)) {
      errors.push(`fundo claro inesperado: ${temaClaroVisual.fundo}`);
    }
    if (temaClaroVisual.meta !== "#f1f4f9") errors.push(`theme-color claro inesperado: ${temaClaroVisual.meta}`);
    if (temaClaroVisual.tabBg !== temaClaroVisual.cardBg) {
      errors.push(`aba ativa deveria usar a cor do cartão (${temaClaroVisual.cardBg}), obteve ${temaClaroVisual.tabBg}`);
    }
    await page.eval(`(() => {
      const set = (id, v) => {
        const el = document.getElementById(id);
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      set("gas", "5,89");
      set("eta", "3,99");
      document.getElementById("tab-fast").click();
      document.getElementById("toast").classList.remove("show");
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    await page.shot("09-tema-claro");

    // volta ao escuro e valida o automático seguindo o sistema escuro
    await page.eval(`(() => { document.getElementById('themeBtn').click(); return true; })()`); // claro -> escuro
    await new Promise((r) => setTimeout(r, 250));
    const voltouEscuro = await page.eval(`document.documentElement.getAttribute('data-theme')`);
    if (voltouEscuro !== "dark") errors.push(`voltar ao escuro falhou: ${voltouEscuro}`);
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }]
    }, sessionId);
    await page.eval(`(() => { document.getElementById('themeBtn').click(); return true; })()`); // escuro -> automático
    await new Promise((r) => setTimeout(r, 300));
    const autoDark = await page.eval(`({
      modo: document.documentElement.getAttribute('data-theme-mode'),
      tema: document.documentElement.getAttribute('data-theme')
    })`);
    console.log(`   ${JSON.stringify(autoDark)}`);
    if (autoDark.modo !== "auto" || autoDark.tema !== "dark") {
      errors.push(`automático não seguiu o sistema escuro: ${JSON.stringify(autoDark)}`);
    }
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }]
    }, sessionId);
    await page.eval(`localStorage.removeItem("ac.theme")`);

    try { await cdp.send("Browser.close"); } catch { /* fecha junto com o WS */ }
    cdp.close();
  } finally {
    try { server.close(); } catch { /* já fechado */ }
    if (browser && !browser.killed) {
      try { browser.kill(); } catch { /* já morto */ }
    }
    if (!KEEP) {
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* perfil em uso */ }
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  if (logs.length) {
    console.log(`Console (${logs.length}):`);
    for (const line of logs.slice(0, 10)) console.log(`  ${line}`);
  }
  if (errors.length) {
    console.log(`FALHOU — ${errors.length} problema(s) detectado(s):`);
    for (const e of errors) console.log(`  • ${e}`);
    process.exitCode = 1;
  } else {
    console.log("OK — nenhum erro de console, layout íntegro e estados corretos.");
  }
  console.log(`${"=".repeat(60)}`);
}

main().catch((err) => {
  console.error(`\nFalha na verificação visual: ${err.message}`);
  process.exitCode = 1;
});
