/* eslint-disable no-restricted-globals */
"use strict";

const fs = require("fs/promises");
const path = require("path");
const vm = require("vm");
const nodeCrypto = require("crypto");

const DEFAULT_PAGE_URL = "https://y.qq.com/n/ryqq/songDetail/002xpBxA13oPjq";
const DEFAULT_MUSICS_URL = "https://u6.y.qq.com/cgi-bin/musics.fcg";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error("input too large"));
        process.stdin.destroy();
      }
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function sanitizeError(err) {
  const msg = String((err && (err.stack || err.message)) || err || "unknown error");
  return msg.replace(/\s+/g, " ").slice(0, 800);
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function fetchText(url, timeoutMs) {
  const timeout = withTimeout(timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: timeout.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "referer": "https://y.qq.com/",
      },
    });
    if (!resp.ok) {
      throw new Error(`fetch ${url} returned ${resp.status}`);
    }
    return await resp.text();
  } finally {
    timeout.done();
  }
}

function resolveScriptURL(pageURL, src) {
  return new URL(src, pageURL).href;
}

function pickRequiredScripts(pageURL, html) {
  const scripts = [];
  const re = /<script\b[^>]*\bsrc=["']([^"']+\.js(?:\?[^"']*)?)["'][^>]*>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    scripts.push(resolveScriptURL(pageURL, match[1]));
  }

  const vendor = scripts.find(src => /\/vendor\.chunk\.[^/]+\.js/i.test(src));
  const page = scripts.find(src => /\/Page\.chunk\.[^/]+\.js/i.test(src));
  if (!vendor || !page) {
    throw new Error("qq security scripts not found in page");
  }
  return { vendor, page };
}

async function loadCachedAssets(cacheDir, ttlMs) {
  const manifestPath = path.join(cacheDir, "manifest.json");
  const vendorPath = path.join(cacheDir, "vendor.js");
  const pagePath = path.join(cacheDir, "page.js");
  const raw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  if (!manifest || Date.now() - Number(manifest.fetchedAt || 0) > ttlMs) {
    throw new Error("qq security cache expired");
  }
  const [vendor, page] = await Promise.all([
    fs.readFile(vendorPath, "utf8"),
    fs.readFile(pagePath, "utf8"),
  ]);
  return { vendor, page };
}

async function fetchAssets(cacheDir, pageURL, timeoutMs) {
  await fs.mkdir(cacheDir, { recursive: true });
  const html = await fetchText(pageURL, timeoutMs);
  const scripts = pickRequiredScripts(pageURL, html);
  const [vendor, page] = await Promise.all([
    fetchText(scripts.vendor, timeoutMs),
    fetchText(scripts.page, timeoutMs),
  ]);
  await Promise.all([
    fs.writeFile(path.join(cacheDir, "vendor.js"), vendor, "utf8"),
    fs.writeFile(path.join(cacheDir, "page.js"), page, "utf8"),
    fs.writeFile(path.join(cacheDir, "manifest.json"), JSON.stringify({
      fetchedAt: Date.now(),
      pageURL,
      scripts,
    }), "utf8"),
  ]);
  return { vendor, page };
}

async function loadAssets(input) {
  const cacheDir = input.cacheDir || path.join(process.cwd(), "data", "cache", "qq-security");
  const pageURL = process.env.MUSIC_DL_QQ_SECURITY_PAGE_URL || DEFAULT_PAGE_URL;
  const ttlMs = Number(process.env.MUSIC_DL_QQ_SECURITY_CACHE_TTL_MS || DEFAULT_TTL_MS);
  try {
    return await loadCachedAssets(cacheDir, ttlMs);
  } catch (_) {
    return await fetchAssets(cacheDir, pageURL, input.timeoutMs || 15000);
  }
}

function makeAnchor() {
  let parsed = new URL("https://y.qq.com/");
  return {
    setAttribute(key, value) {
      if (key === "href") this.href = value;
    },
    get href() { return parsed.href; },
    set href(value) { parsed = new URL(value, "https://y.qq.com/"); },
    get protocol() { return parsed.protocol; },
    get host() { return parsed.host; },
    get hostname() { return parsed.hostname; },
    get port() { return parsed.port; },
    get pathname() { return parsed.pathname; },
    get search() { return parsed.search; },
    get hash() { return parsed.hash; },
  };
}

function buildBrowserContext(pushes) {
  function FakeXHR() {}
  const win = {};
  Object.assign(win, {
    Array,
    ArrayBuffer,
    Uint8Array,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
    DataView,
    Date,
    Math,
    String,
    Number,
    Boolean,
    Object,
    RegExp,
    Error,
    TypeError,
    Promise,
    Function,
    JSON,
    parseInt,
    parseFloat,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    escape,
    unescape,
    setTimeout,
    clearTimeout,
    atob: globalThis.atob || (value => Buffer.from(value, "base64").toString("binary")),
    btoa: globalThis.btoa || (value => Buffer.from(value, "binary").toString("base64")),
    Buffer,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    crypto: globalThis.crypto || nodeCrypto.webcrypto,
    XMLHttpRequest: FakeXHR,
    FormData: function FormData() {},
    navigator: {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      appVersion: "5.0 (Windows)",
      appName: "Netscape",
    },
    location: {
      href: "https://y.qq.com/",
      protocol: "https:",
      host: "y.qq.com",
      hostname: "y.qq.com",
      origin: "https://y.qq.com",
      pathname: "/",
    },
    localStorage: { setItem() {}, removeItem() {}, getItem() { return null; } },
    sessionStorage: { setItem() {}, removeItem() {}, getItem() { return null; } },
    webpackJsonp: { push: value => pushes.push(value) },
  });
  win.window = win;
  win.self = win;
  win.globalThis = win;

  const document = {
    cookie: "",
    querySelector: () => null,
    getElementById: () => null,
    getElementsByTagName: () => [],
    head: { appendChild() {} },
    body: { appendChild() {}, removeChild() {} },
    createElement: tag => tag === "a" ? makeAnchor() : ({
      tagName: String(tag || "").toUpperCase(),
      style: {},
      setAttribute() {},
      appendChild() {},
      parentNode: { removeChild() {} },
    }),
  };
  win.document = document;

  return vm.createContext({
    ...win,
    window: win,
    self: win,
    globalThis: win,
    document,
    console: { log() {}, warn() {}, error() {} },
  });
}

function buildRequire(modules, win) {
  const cache = { 16: { i: 16, l: true, exports: win } };
  function req(id) {
    if (cache[id]) return cache[id].exports;
    if (!modules[id]) throw new Error(`missing webpack module ${id}`);
    const mod = { i: id, l: false, exports: {} };
    cache[id] = mod;
    modules[id].call(mod.exports, mod, mod.exports, req);
    mod.l = true;
    return mod.exports;
  }
  req.d = (exports, name, getter) => {
    if (!Object.prototype.hasOwnProperty.call(exports, name)) {
      Object.defineProperty(exports, name, { enumerable: true, get: getter });
    }
  };
  req.r = exports => {
    Object.defineProperty(exports, "__esModule", { value: true });
    if (typeof Symbol !== "undefined" && Symbol.toStringTag) {
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    }
  };
  req.n = mod => {
    const getter = mod && mod.__esModule ? () => mod.default : () => mod;
    req.d(getter, "a", getter);
    return getter;
  };
  req.o = (obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop);
  req.p = "";
  req.m = modules;
  req.c = cache;
  return req;
}

async function loadSecurity(input) {
  const assets = await loadAssets(input);
  const pushes = [];
  const context = buildBrowserContext(pushes);
  vm.runInContext(assets.vendor, context, { filename: "qq-vendor.js", timeout: 5000 });
  vm.runInContext(assets.page, context, { filename: "qq-page.js", timeout: 5000 });

  const modules = {};
  for (const push of pushes) {
    Object.assign(modules, push[1] || {});
  }

  let encrypt;
  let decrypt;
  const win = context.window;
  Object.defineProperty(win, "__cgiEncrypt", {
    configurable: true,
    get() { return encrypt; },
    set(value) { encrypt = value; },
  });
  Object.defineProperty(win, "__cgiDecrypt", {
    configurable: true,
    get() { return decrypt; },
    set(value) { decrypt = value; },
  });

  const req = buildRequire(modules, win);
  const sign = req(412).default;
  req(8);
  if (typeof sign !== "function" || typeof encrypt !== "function" || typeof decrypt !== "function") {
    throw new Error("qq security functions unavailable");
  }
  return { sign, encrypt, decrypt };
}

function appendQuery(rawURL, params) {
  const url = new URL(rawURL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.href;
}

function normalizeHeaders(inputHeaders) {
  const headers = {};
  for (const [key, value] of Object.entries(inputHeaders || {})) {
    if (value === undefined || value === null || value === "") continue;
    headers[String(key).toLowerCase()] = String(value);
  }
  headers.accept = "application/octet-stream";
  headers["content-type"] = "text/plain";
  if (!headers.referer) headers.referer = "https://y.qq.com/";
  if (!headers["user-agent"]) {
    headers["user-agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";
  }
  return headers;
}

async function securePost(input) {
  if (!input || typeof input.body !== "string" || input.body === "") {
    throw new Error("missing request body");
  }
  const timeoutMs = Number(input.timeoutMs || 15000);
  const security = await loadSecurity(input);
  const sign = security.sign(input.body);
  const encrypted = await security.encrypt(input.body);
  const rawURL = process.env.MUSIC_DL_QQ_MUSICS_URL || input.musicsURL || DEFAULT_MUSICS_URL;
  const url = appendQuery(rawURL, {
    _: String(Date.now()),
    encoding: "ag-1",
    sign,
  });

  const timeout = withTimeout(timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: timeout.signal,
      headers: normalizeHeaders(input.headers),
      body: encrypted,
    });
    const buffer = await resp.arrayBuffer();
    if (!resp.ok) {
      throw new Error(`qq musics http status ${resp.status}`);
    }
    return {
      ok: true,
      status: resp.status,
      body: security.decrypt(buffer),
    };
  } finally {
    timeout.done();
  }
}

(async () => {
  try {
    const input = JSON.parse(await readStdin());
    const result = await securePost(input);
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: sanitizeError(err) }));
    process.exitCode = 1;
  }
})();
