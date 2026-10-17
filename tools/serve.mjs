#!/usr/bin/env node
/**
 * Abastece Certo — servidor estático local, sem dependências.
 *
 * Necessário só para testar o PWA em http://localhost (service worker exige
 * http/https; em file:// o app funciona, mas não instala nem cacheia).
 *
 * Uso:
 *   node tools/serve.mjs            # http://localhost:5173
 *   node tools/serve.mjs 8080       # outra porta
 */
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const START_PORT = Number(process.argv[2]) || 5173;
const MAX_TRIES = 10;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

const NO_CACHE = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Service-Worker-Allowed": "/"
};

function safePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return null;   // URI malformada (ex.: "%" solto) -> 403, não derruba o servidor
  }
  const target = normalize(join(ROOT, decoded));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
  return target;
}

function send(res, status, body, headers) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    ...NO_CACHE,
    ...headers
  });
  res.end(body);
}

const server = createServer((req, res) => {
  const method = req.method || "GET";
  if (method !== "GET" && method !== "HEAD") {
    send(res, 405, "Método não permitido");
    return;
  }

  let target = safePath(req.url || "/");
  if (!target) {
    send(res, 403, "Caminho inválido");
    return;
  }

  let stat = null;
  try { stat = statSync(target); } catch { stat = null; }
  if (stat && stat.isDirectory()) {
    target = join(target, "index.html");
    try { stat = statSync(target); } catch { stat = null; }
  }

  // Fallback de navegação (como o service worker faz)
  if (!stat) {
    target = join(ROOT, "index.html");
    try { stat = statSync(target); } catch { stat = null; }
  }
  if (!stat) {
    send(res, 404, "Não encontrado");
    return;
  }

  const type = MIME[extname(target).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stat.size,
    ...NO_CACHE
  });
  if (method === "HEAD") { res.end(); return; }
  createReadStream(target).pipe(res);
});

function listen(port, tries) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && tries < MAX_TRIES) {
      listen(port + 1, tries + 1);
      return;
    }
    console.error(`Falha ao iniciar o servidor: ${err.message}`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`\n  Abastece Certo — servidor de desenvolvimento`);
    console.log(`  Raiz: ${ROOT}`);
    console.log(`  URL:  http://localhost:${port}\n`);
    console.log(`  O service worker e a instalação PWA só funcionam em localhost/https.`);
    console.log(`  Encerre com Ctrl+C.\n`);
  });
}

listen(START_PORT, 0);
