// Service worker do Abastece Certo — offline-first com atualização segura.
//
// Estratégia:
//   • navegação (abrir/recarregar o app)     -> network-first, cai para o cache offline;
//   • demais arquivos (ícones/manifest/SW)   -> stale-while-revalidate.
// Assim o usuário sempre pega a versão nova quando está online, mas o app
// continua abrindo sem internet. O index.html não fica congelado no cache:
// o network-first evita o clássico "deploy novo, app velho no celular".
//
// Ao publicar uma versão, mude VERSION: o activate apaga os caches antigos.

const VERSION = "v4.6.0";
const CACHE = "abastece-certo-" + VERSION;

const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./precos.json",
  "./icons/favicon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // add() individual + catch: um 404 não pode abortar a instalação inteira.
    await Promise.all(
      PRECACHE.map((url) =>
        cache.add(new Request(url, { cache: "reload" })).catch(() => null)
      )
    );
    // NÃO chamamos skipWaiting() aqui de propósito: ativar a versão nova no meio
    // de uma sessão pode misturar HTML/JS de versões diferentes. O app avisa
    // "Nova versão disponível" e, quando o usuário aceita, envia SKIP_WAITING.
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.indexOf("abastece-certo-") === 0 && key !== CACHE)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

// O app pede para o SW em espera assumir o controle quando o usuário aceita atualizar.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      cache.put(request, fresh.clone()).catch(() => null);
    }
    return fresh;
  } catch (error) {
    const cached =
      (await cache.match(request)) ||
      (await cache.match("./index.html")) ||
      (await cache.match("./"));
    if (cached) return cached;
    throw error;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        // QuotaExceededError/Modo privado não podem virar unhandled rejection.
        cache.put(request, response.clone()).catch(() => null);
      }
      return response;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;           // não intercepta terceiros
  if (url.pathname.indexOf("/sw.js") !== -1) return;        // nunca serve o SW do cache

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});
