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
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
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

  async setViewport(width, height) {
    await this.cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: 2, mobile: width < 600 },
      this.sessionId
    );
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

    // ---- 3. veredito oposto (gasolina)
    console.log("3) preço de etanol caro -> gasolina");
    const gasVerdict = await page.eval(`(() => {
      const el = document.getElementById('eta');
      el.value = '4,80'; el.dispatchEvent(new Event('input', { bubbles: true }));
      return document.querySelector('.verdict')?.innerText.trim();
    })()`);
    console.log(`   ${gasVerdict}`);
    if (!/GASOLINA/.test(gasVerdict || "")) errors.push(`esperava GASOLINA, obtive: ${gasVerdict}`);

    // ---- 4. preço inválido mostra dica
    console.log("4) validação de preço inválido");
    const invalid = await page.eval(`(() => {
      const el = document.getElementById('eta');
      el.value = 'abc'; el.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        hint: document.getElementById('etaHint').textContent,
        invalid: document.getElementById('eta').getAttribute('aria-invalid'),
        resultado: document.getElementById('resultOut').innerText.trim()
      };
    })()`);
    console.log(`   ${JSON.stringify(invalid)}`);
    if (!invalid.hint) errors.push("preço inválido deveria mostrar dica");
    if (invalid.invalid !== "true") errors.push("preço inválido deveria marcar aria-invalid");

    // ---- 5. empate técnico: veredito, texto e cor têm de concordar
    console.log("5) empate técnico (consistência veredito × texto × cor)");
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

    // ---- 6. modo preciso
    console.log("6) modo preciso (consumo real)");
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

    // ---- 7. salvar veículo e recarregar (persistência em localStorage)
    console.log("7) salvar veículo + recarregar");
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
      precoGas: document.getElementById('gas').value
    }))()`);
    console.log(`   ${JSON.stringify(restored)}`);
    if (restored.nome !== "Onix 1.4") errors.push(`nome do veículo não restaurado: ${restored.nome}`);
    if (restored.aba !== "true") errors.push("modo preciso não restaurado após reload");
    if (restored.opcoes < 2) errors.push("veículo salvo não apareceu no seletor");
    await page.shot("04-preciso-veiculo-salvo");

    // ---- 8. viewport estreito (360px)
    console.log("8) viewport estreito 360px");
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

    // ---- 9. acessibilidade básica: foco e tamanho de alvo
    console.log("9) acessibilidade (alvos de toque e foco)");
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
