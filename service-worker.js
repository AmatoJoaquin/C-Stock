/*
 * C-Stock — Service Worker
 *
 * Alcance: el directorio donde está este archivo (en producción,
 * https://amatojoaquin.github.io/C-Stock/). Todas las rutas son relativas a
 * self.location, así que funciona igual en /C-Stock/ y en localhost.
 *
 * Qué SÍ se guarda en caché:
 *   - La interfaz estática propia: index.html, manifest.json e iconos.
 *   - Los módulos públicos y versionados del SDK de Firebase 13.4.0 desde
 *     www.gstatic.com/firebasejs/13.4.0/ (código estático, sin datos de
 *     usuario), para que la interfaz y la sesión local puedan abrir sin red.
 *
 * Qué NUNCA se intercepta ni se guarda:
 *   - Solicitudes que no sean GET (altas, ediciones, eliminaciones, POST).
 *   - Google Apps Script (script.google.com / googleusercontent.com).
 *   - Firebase Auth / Identity Toolkit / securetoken / firebaseapp.com.
 *   - Cualquier otro dominio externo o ruta fuera del alcance de la app.
 *   El transporte iframe hacia Apps Script es una navegación de otro origen,
 *   por lo que tampoco pasa por este service worker.
 *
 * Este archivo no reenvía solicitudes ni escribe en el backend.
 */

const VERSION = "2026.11.20-2";
const CACHE_PREFIX = "cstock-";
const SHELL_CACHE = CACHE_PREFIX + "shell-" + VERSION;
const LIB_CACHE = CACHE_PREFIX + "lib-firebase-13.4.0";

const SCOPE_URL = new URL("./", self.location).href;
const INDEX_URL = new URL("./index.html", self.location).href;

const SHELL_ASSETS = [
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
].map((path) => new URL(path, self.location).href);

const SHELL_PATHS = new Set(SHELL_ASSETS.map((url) => new URL(url).pathname));

// Prefijo versionado e inmutable del SDK de Firebase (no incluye APIs).
const FIREBASE_LIB_PREFIX = "https://www.gstatic.com/firebasejs/13.4.0/";
const FIREBASE_LIB_ASSETS = [
  FIREBASE_LIB_PREFIX + "firebase-app.js",
  FIREBASE_LIB_PREFIX + "firebase-auth.js",
];

const NAVIGATION_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------- install
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      // cache: "reload" evita copiar una versión vieja desde la caché HTTP.
      await shell.addAll(
        SHELL_ASSETS.map((url) => new Request(url, { cache: "reload" })),
      );

      // Firebase: mejor esfuerzo. Si falla, la instalación no se cancela;
      // se volverá a intentar en tiempo de ejecución.
      try {
        const lib = await caches.open(LIB_CACHE);
        await Promise.all(
          FIREBASE_LIB_ASSETS.map(async (url) => {
            if (await lib.match(url)) return;
            const response = await fetch(
              new Request(url, { mode: "cors", credentials: "omit" }),
            );
            if (response.ok) await lib.put(url, response);
          }),
        );
      } catch (error) {
        // Sin conexión o bloqueado: no crítico.
      }
      // No se llama a skipWaiting(): la versión nueva espera a que el
      // usuario la aplique (y la App no lo permite con envíos pendientes).
    })(),
  );
});

// --------------------------------------------------------------- activate
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (key) =>
              key.startsWith(CACHE_PREFIX) &&
              key !== SHELL_CACHE &&
              key !== LIB_CACHE,
          )
          .map((key) => caches.delete(key)),
      );
      // Toma control de las pestañas abiertas sin recargarlas.
      await self.clients.claim();
    })(),
  );
});

// ---------------------------------------------------------------- message
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (data.type === "GET_VERSION" && event.source) {
    event.source.postMessage({ type: "VERSION", version: VERSION });
  }
});

// ------------------------------------------------------------------ fetch
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // POST y demás: red directa.

  let url;
  try {
    url = new URL(request.url);
  } catch (error) {
    return;
  }

  // Mismo origen: solo recursos dentro del alcance /C-Stock/.
  if (url.origin === self.location.origin) {
    if (!url.href.startsWith(SCOPE_URL)) return;
    if (url.pathname.endsWith("/service-worker.js")) return;

    if (request.mode === "navigate") {
      event.respondWith(networkFirstNavigation(request, url));
      return;
    }

    if (SHELL_PATHS.has(url.pathname)) {
      event.respondWith(staleWhileRevalidate(request));
    }
    return; // cualquier otro recurso propio: red normal, sin caché
  }

  // Externo: únicamente el SDK versionado de Firebase.
  if (url.href.startsWith(FIREBASE_LIB_PREFIX)) {
    event.respondWith(cacheFirstLibrary(request));
  }
  // Todo lo demás (Apps Script, APIs de Firebase, etc.) no se intercepta.
});

function isAppShellPath(url) {
  const path = url.pathname;
  const scopePath = new URL(SCOPE_URL).pathname;
  return path === scopePath || path === scopePath + "index.html";
}

/**
 * Navegaciones: red primero (para recibir siempre el index.html nuevo) con
 * revalidación HTTP; si no hay red o tarda demasiado, la copia en caché.
 */
async function networkFirstNavigation(request, url) {
  const cache = await caches.open(SHELL_CACHE);

  const network = fetch(request.url, {
    cache: "no-cache",
    credentials: "same-origin",
    redirect: "follow",
  }).then(async (fetched) => {
    // Una respuesta "redirected" no puede responder a una navegación:
    // se reconstruye como respuesta simple.
    const response =
      fetched && fetched.redirected
        ? new Response(await fetched.blob(), {
            status: fetched.status,
            statusText: fetched.statusText,
            headers: fetched.headers,
          })
        : fetched;
    if (
      response &&
      response.ok &&
      fetched.type === "basic" &&
      isAppShellPath(url)
    ) {
      await cache.put(INDEX_URL, response.clone());
    }
    return response;
  });

  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), NAVIGATION_TIMEOUT_MS),
    );
    return await Promise.race([network, timeout]);
  } catch (error) {
    network.catch(() => {}); // si la red responde tarde, igual actualiza la caché
    const cached =
      (await cache.match(INDEX_URL)) ||
      (await caches.match(INDEX_URL, { ignoreSearch: true }));
    if (cached) return cached;
    return offlineFallback();
  }
}

/** Interfaz estática propia: respuesta inmediata desde caché y actualización en segundo plano. */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });

  const update = fetch(request)
    .then(async (response) => {
      if (response && response.ok && response.type === "basic") {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) return cached;
  const fresh = await update;
  return fresh || new Response("", { status: 504, statusText: "Sin conexión" });
}

/** SDK versionado de Firebase: inmutable, se sirve desde caché si existe. */
async function cacheFirstLibrary(request) {
  const cache = await caches.open(LIB_CACHE);
  const cached = await cache.match(request.url);
  if (cached) return cached;

  const response = await fetch(request);
  // Solo respuestas CORS correctas (no opacas) del CDN versionado.
  if (response && response.ok && response.type === "cors") {
    await cache.put(request.url, response.clone());
  }
  return response;
}

function offlineFallback() {
  const html =
    '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>C-Stock sin conexión</title>" +
    "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;" +
    "font-family:system-ui,sans-serif;background:#f2f5f8;color:#172433;padding:24px}" +
    "@media (prefers-color-scheme:dark){body{background:#0e1620;color:#e4ebf3}}" +
    "main{max-width:420px;text-align:center}button{margin-top:14px;padding:12px 18px;" +
    "border:0;border-radius:10px;background:#16804a;color:#fff;font-weight:700}</style>" +
    "</head><body><main><h1>C-Stock</h1><p>No hay conexión y la interfaz todavía " +
    "no se guardó en este dispositivo. Conectate a internet y volvé a intentar.</p>" +
    '<button onclick="location.reload()">Reintentar</button></main></body></html>';
  return new Response(html, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
