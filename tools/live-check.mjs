#!/usr/bin/env node
/**
 * Abastece Certo — verificação do app PUBLICADO (ex.: GitHub Pages).
 *
 * Abre a URL no Edge headless via DevTools Protocol e confere o que só se vê
 * em produção: MIME do manifest, registro/ativação do service worker, cache
 * offline, precos.json na mesma origem e a referência ANP renderizada.
 * Também testa o app com a rede desligada (modo offline do CDP).
 *
 * Uso:
 *   node tools/live-check.mjs                          # URL padrão (GitHub Pages)
 *   node tools/live-check.mjs https://exemplo.com/app/ # outra URL
 *
 * Sai com código != 0 se algo essencial falhar. Requer Microsoft Edge.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(ROOT, "screenshots");
const TARGET = process.argv[2] || "https://atanycost-png.github.io/abastece-certo/";
const DEBUG_PORT = 9421;

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].filter(Boolean);

const problems = [];
function check(cond, message) {
  if (cond) {
    console.log(`  ok    ${message}`);
  } else {
    problems.push(message);
    console.log(`  FAIL  ${message}`);
  }
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        return;
      }
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
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout na chamada CDP ${method}`));
        }
      }, 40000);
    });
  }

  waitFor(method, sessionId, timeoutMs = 20000) {
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

  close() { try { this.ws.close(); } catch { /* já fechado */ } }
}

async function fetchJson(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch { /* Edge subindo */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`não consegui falar com o Edge em ${url}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!edge) {
    console.log("Edge não encontrado — verificação do app publicado ignorada.");
    return;
  }
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

  const profile = join(tmpdir(), `abastece-live-${Date.now()}`);
  let browser = null;
  let cdp = null;

  try {
    browser = spawn(edge, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--force-color-profile=srgb",
      `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, "about:blank"
    ], { stdio: "ignore" });

    const info = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    console.log(`  Edge: ${info.Browser || "Microsoft Edge"}`);
    console.log(`  URL:  ${TARGET}\n`);

    cdp = await CDP.connect(info.webSocketDebuggerUrl);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    for (const domain of ["Page", "Runtime", "Log", "Network"]) {
      await cdp.send(`${domain}.enable`, {}, sessionId);
    }
    const consoleErrors = [];
    cdp.listeners.push((msg) => {
      if (msg.method === "Runtime.exceptionThrown") {
        consoleErrors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
      }
      if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        consoleErrors.push(msg.params.entry.text);
      }
    });

    const evaluate = async (expression) => {
      const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };

    const loaded = cdp.waitFor("Page.loadEventFired", sessionId);
    await cdp.send("Page.navigate", { url: TARGET }, sessionId);
    await loaded;
    await sleep(800);

    // ---- manifest, service worker, cache e precos.json na origem publicada
    const live = await evaluate(`(async () => {
      const out = { href: location.href, title: document.title };
      try {
        const man = await fetch('./manifest.webmanifest', { cache: 'no-cache' });
        out.manifest = { ok: man.ok, status: man.status, type: man.headers.get('content-type') };
      } catch (e) { out.manifest = { error: String(e) }; }
      try {
        const pj = await fetch('./precos.json', { cache: 'no-cache' });
        const body = await pj.json();
        out.precos = { ok: pj.ok, status: pj.status, type: pj.headers.get('content-type'), semana: body.semana || null };
      } catch (e) { out.precos = { error: String(e) }; }
      if ('serviceWorker' in navigator) {
        try {
          const reg = await navigator.serviceWorker.ready;
          for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) {
            await new Promise(r => setTimeout(r, 100));
          }
          out.sw = { scope: reg.scope, active: !!reg.active, state: reg.active && reg.active.state, controller: !!navigator.serviceWorker.controller };
        } catch (e) { out.sw = { error: String(e) }; }
      } else { out.sw = { unsupported: true }; }
      try { out.caches = await caches.keys(); } catch (e) { out.caches = []; }
      out.referencia = (document.getElementById('priceRef') || {}).innerText || '';
      out.aba = (document.getElementById('tab-fast') || {}).getAttribute ? document.getElementById('tab-fast').getAttribute('aria-selected') : null;
      return out;
    })()`);

    console.log("  manifest : " + JSON.stringify(live.manifest));
    console.log("  precos   : " + JSON.stringify(live.precos));
    console.log("  sw       : " + JSON.stringify(live.sw));
    console.log("  caches   : " + JSON.stringify(live.caches));

    check(/Abastece Certo/.test(live.title || ""), "título correto na origem publicada");
    check(live.manifest && live.manifest.ok, "manifest.webmanifest responde 200");
    check(!live.manifest || !live.manifest.type || !/octet-stream/.test(live.manifest.type || ""),
      "manifest com Content-Type adequado (" + (live.manifest && live.manifest.type) + ")");
    check(live.precos && live.precos.ok && live.precos.semana, "precos.json carrega na mesma origem");
    check(live.sw && live.sw.active && live.sw.state === "activated", "service worker ativo");
    check(live.sw && live.sw.controller, "service worker controlando a página");
    check((live.caches || []).some((k) => k.indexOf("abastece-certo-") === 0), "cache offline criado");
    check(/Referência ANP/.test(live.referencia || ""), "bloco de referência ANP renderizado");
    check(/semana/i.test(live.referencia || ""), "semana da ANP exibida");

    // ---- recorte do app publicado para evidência
    const metrics = await cdp.send("Page.getLayoutMetrics", {}, sessionId);
    const size = metrics.cssContentSize || metrics.contentSize;
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }
    }, sessionId);
    writeFileSync(join(SHOTS, "live-pages.png"), Buffer.from(shot.data, "base64"));
    console.log("  screenshot live-pages.png");

    // ---- offline de verdade: desliga a rede e recarrega
    await cdp.send("Network.emulateNetworkConditions", {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0
    }, sessionId);
    const offlineLoad = cdp.waitFor("Page.loadEventFired", sessionId);
    await cdp.send("Page.reload", { ignoreCache: false }, sessionId);
    await offlineLoad;
    await sleep(600);
    const offline = await evaluate(`(() => ({
      title: document.title,
      temCampo: !!document.getElementById('gas'),
      temResultado: !!document.getElementById('resultOut')
    }))()`);
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
    }, sessionId);
    console.log("  offline  : " + JSON.stringify(offline));
    check(offline.temCampo && offline.temResultado && /Abastece/.test(offline.title || ""),
      "app abre OFFLINE a partir do cache do service worker");

    if (consoleErrors.length) {
      console.log("\n  Erros de console:");
      for (const e of consoleErrors.slice(0, 6)) console.log("   • " + e);
    }
  } finally {
    try { await cdp?.send("Browser.close"); } catch { /* fecha junto */ }
    cdp?.close();
    if (browser && !browser.killed) { try { browser.kill(); } catch { /* já morto */ } }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* em uso */ }
  }

  console.log(`\n${"=".repeat(60)}`);
  if (problems.length) {
    console.log(`FALHOU — ${problems.length} problema(s):`);
    for (const p of problems) console.log("  • " + p);
    process.exitCode = 1;
  } else {
    console.log("OK — app publicado com manifest, service worker e offline funcionando.");
  }
  console.log(`${"=".repeat(60)}`);
}

main().catch((err) => {
  console.error(`\nFalha na verificação do app publicado: ${err.message}`);
  process.exitCode = 1;
});
