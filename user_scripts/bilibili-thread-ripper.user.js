// ==UserScript==
// @name         Bilibili 线程撕裂者
// @namespace    https://github.com/MrTangLuyao/Bilibili-thread-ripper
// @version      2026.11.13.1
// @description  解决海外B站卡顿的最后一个脚本
// @icon         https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper/main/icons/icon-128.png
// @author       MrTangLuyao
// @license      MIT
// @homepageURL  https://github.com/MrTangLuyao/Bilibili-thread-ripper
// @supportURL   https://github.com/MrTangLuyao/Bilibili-thread-ripper/issues
// @updateURL    https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper/main/user_scripts/bilibili-thread-ripper.user.js
// @downloadURL  https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper/main/user_scripts/bilibili-thread-ripper.user.js
// @match        https://*.bilibili.com/*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_addElement
// @grant        unsafeWindow
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM_addValueChangeListener
// @sandbox      JavaScript
// @inject-into  content
// ==/UserScript==

// 这个文件由 scripts/build.mjs 生成，不要直接修改。
(function () {
"use strict";

function pageCode() {
"use strict";
if (document.documentElement?.hasAttribute("data-btr-userscript")) return;
document.documentElement?.setAttribute("data-btr-userscript", "");
if (window.top !== window && !/^live\.bilibili\.com$/i.test(location.hostname)) return;

/* user_scripts/adapter/storage-shim.js */
// This small stand-in keeps the part of the chrome.* API that bridge.js uses: storage. Its
// callbacks also get runtime.lastError, as in the extension, though bridge.js does not read it.
//
// The settings live in the script manager's storage, which every bilibili subdomain shares.
// Only the manager's side of the script (loader.js) can reach it, so this page code asks it
// with events. loader.js marks the page when it answers them; without that mark, or when it
// does not answer, the settings stay in this site's localStorage as before, which is kept per
// subdomain. Changes made in another tab arrive from the manager, or, where the manager does
// not report them, are read again when this tab comes back into view.
//
// What the manager holds is also copied to this site's localStorage for fallback when the
// manager is unavailable. Each manager keeps its own settings; an empty manager never
// imports this copy.
const chrome = (() => {
  const PREFIX = "BTR_Userscript.";
  const AREAS = ["sync", "local"];
  const mark = document.documentElement?.getAttribute("data-btr-userscript-storage") || "";
  const listeners = new Set();
  const parse = (text) => {
    try {
      const value = typeof text === "string" ? JSON.parse(text || "{}") : text;
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (_error) {
      return {};
    }
  };
  const diff = (before, after) => {
    const changes = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = { oldValue: before[key], newValue: after[key] };
    }
    return changes;
  };
  const notify = (changes, area) => {
    if (!Object.keys(changes).length) return;
    for (const listener of listeners) {
      try { listener(changes, area); }
      catch (error) { console.error("BTR settings listener", error); }
    }
  };

  // This site's localStorage: the fallback, and what every version before 2026 used.
  const localBackend = {
    load: (area) => {
      try { return Promise.resolve(parse(localStorage.getItem(PREFIX + area))); }
      catch (_error) { return Promise.resolve({}); }
    },
    change: (area, op, value) => {
      let next = {};
      try { next = parse(localStorage.getItem(PREFIX + area)); } catch (_error) {}
      if (op === "set") Object.assign(next, value);
      else for (const key of value) delete next[key];
      try { localStorage.setItem(PREFIX + area, JSON.stringify(next)); }
      catch (error) { return Promise.reject(error); }
      return Promise.resolve(next);
    }
  };

  // The manager's storage, through loader.js. Requests and answers are JSON text: objects
  // would not cross Firefox's boundary between the page and the manager's sandbox.
  let requestCount = 0;
  const pending = new Map();
  const managerBackend = {
    request(message) {
      return new Promise((resolve, reject) => {
        const id = String(++requestCount);
        pending.set(id, { resolve, reject });
        document.dispatchEvent(new CustomEvent("btr-userscript-storage-request", { detail: JSON.stringify({ ...message, id }) }));
      });
    },
    load(area) { return this.request({ op: "get", area }); },
    change(area, op, value) { return this.request(op === "set" ? { op, area, items: value } : { op, area, keys: value }); }
  };
  document.addEventListener("btr-userscript-storage-reply", (event) => {
    let reply = null;
    try { reply = JSON.parse(event.detail); } catch (_error) { return; }
    const entry = pending.get(String(reply?.id));
    if (!entry) return;
    pending.delete(String(reply.id));
    if (reply.error) entry.reject(new Error(reply.error));
    else entry.resolve(parse(reply.value));
  });

  const cache = {};
  const loads = {};
  let backend = mark ? managerBackend : localBackend;
  const keepCopy = (area, value) => {
    if (backend !== managerBackend) return;
    try { localStorage.setItem(PREFIX + area, JSON.stringify(value)); } catch (_error) {}
  };
  // A manager that marked the page but never answers must not keep the settings from loading.
  const load = (area) => {
    loads[area] ||= (backend === managerBackend
      ? Promise.race([backend.load(area), new Promise((_resolve, reject) => setTimeout(() => reject(new Error("no answer")), 3000))])
        .catch(() => { backend = localBackend; return backend.load(area); })
      : backend.load(area)).then((value) => { cache[area] = value; keepCopy(area, value); return value; });
    return loads[area];
  };
  // What the storage now holds after a change, from this tab or from another one.
  const settle = (area, value) => {
    const before = cache[area] || {};
    cache[area] = value;
    keepCopy(area, value);
    notify(diff(before, value), area);
  };

  const runtime = { lastError: null };
  // Callers either pass a callback and read runtime.lastError, or await the promise.
  const finish = (promise, callback) => {
    const done = promise.then((value) => [value, null], (error) => [undefined, error]);
    if (typeof callback !== "function") return done.then(([value, error]) => (error ? Promise.reject(error) : value));
    return done.then(([value, error]) => {
      runtime.lastError = error ? { message: String(error.message || error) } : null;
      try { callback(value); }
      finally { runtime.lastError = null; }
      return value;
    });
  };
  // The change shows at once in this tab; the storage's own answer, which may also carry
  // another tab's change, settles it.
  const change = (area, op, value) => load(area).then((stored) => {
    const next = { ...stored };
    if (op === "set") Object.assign(next, value);
    else for (const key of value) delete next[key];
    settle(area, next);
    return backend.change(area, op, value).then((result) => settle(area, result));
  });
  const storageArea = (area) => ({
    get(keys, callback) {
      return finish(load(area).then((stored) => {
        if (keys === null || keys === undefined) return { ...stored };
        if (typeof keys === "string") return keys in stored ? { [keys]: stored[keys] } : {};
        if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]]));
        return Object.fromEntries(Object.keys(keys).map((key) => [key, key in stored ? stored[key] : keys[key]]));
      }), callback);
    },
    set(items, callback) {
      return finish(change(area, "set", { ...items }), callback);
    },
    remove(keys, callback) {
      return finish(change(area, "remove", [].concat(keys)), callback);
    }
  });

  // Another tab changed something.
  addEventListener("storage", (event) => {
    if (backend !== localBackend || !event.key?.startsWith(PREFIX)) return;
    const area = event.key.slice(PREFIX.length);
    if (AREAS.includes(area) && cache[area]) settle(area, parse(event.newValue));
  });
  document.addEventListener("btr-userscript-storage-change", (event) => {
    let message = null;
    try { message = JSON.parse(event.detail); } catch (_error) { return; }
    if (backend === managerBackend && AREAS.includes(message?.area) && cache[message.area]) settle(message.area, parse(message.value));
  });
  // Managers that do not report other tabs' changes ("live" is missing from the mark): read
  // the storage again whenever this tab comes back.
  if (mark && !mark.split(" ").includes("live")) {
    const refresh = () => {
      if (document.visibilityState !== "visible" || backend !== managerBackend) return;
      for (const area of AREAS) if (cache[area]) backend.load(area).then((value) => settle(area, value), () => {});
    };
    addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
  }

  return Object.freeze({
    runtime,
    storage: Object.freeze({
      sync: storageArea("sync"),
      local: storageArea("local"),
      onChanged: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) }
    })
  });
})();

/* src/range-core.js */
(function installRangeCore(root) {
  "use strict";

  const MEDIA_SUFFIX_RE = /\.(?:m4s|mp4|flv)$/i;
  const MEDIA_HOST_RE = /(?:^|\.)(?:bilivideo\.(?:com|cn|net)|akamaized\.net|szbdyd\.com|hdslb\.com|xycdn\.com|mountaintoys\.cn|nexusedgeio\.com|ahdohpiechei\.com)$/i;

  function parseByteRange(value) {
    if (typeof value !== "string") return null;
    const match = /^(\d+)-(\d+)$/.exec(value.trim());
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
    return { start, end, length: end - start + 1 };
  }

  function parseRangeHeader(value) {
    if (typeof value !== "string") return null;
    const match = /^bytes=(\d+)-(\d+)$/i.exec(value.trim());
    return match ? parseByteRange(`${match[1]}-${match[2]}`) : null;
  }

  function parseContentRange(value) {
    if (typeof value !== "string") return null;
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = match[3] === "*" ? null : Number(match[3]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
    if (total !== null && (!Number.isSafeInteger(total) || total <= end)) return null;
    return { start, end, total, length: end - start + 1 };
  }

  function splitRange(start, end, concurrency, minChunkBytes = 128 * 1024) {
    const length = end - start + 1;
    const limit = Math.max(1, Math.min(512, Math.trunc(concurrency) || 1));
    const minimum = Math.max(32 * 1024, Math.trunc(minChunkBytes) || 128 * 1024);
    const count = Math.max(1, Math.min(limit, Math.ceil(length / minimum)));
    const base = Math.floor(length / count);
    const remainder = length % count;
    const pieces = [];
    let cursor = start;
    for (let index = 0; index < count; index += 1) {
      const size = base + (index < remainder ? 1 : 0);
      pieces.push({ index, start: cursor, end: cursor + size - 1, length: size });
      cursor += size;
    }
    return pieces;
  }

  function concatChunks(chunks, expectedLength) {
    const output = new Uint8Array(expectedLength);
    let offset = 0;
    for (const chunk of chunks) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (offset + bytes.byteLength > expectedLength) throw new RangeError("子区间超出目标长度");
      output.set(bytes, offset);
      offset += bytes.byteLength;
    }
    if (offset !== expectedLength) throw new RangeError(`子区间长度不符：${offset}/${expectedLength}`);
    return output;
  }

  function isBilibiliMediaUrl(value) {
    try {
      const url = new URL(value, root.location?.href);
      return url.protocol === "https:" && MEDIA_SUFFIX_RE.test(url.pathname) && MEDIA_HOST_RE.test(url.hostname);
    } catch (_error) {
      return false;
    }
  }

  // A server added by hand in the custom CDN mode. Only its host name is kept, and only for
  // the Bilibili video servers isBilibiliMediaUrl accepts: the signed download addresses
  // must never be sent to anyone else.
  function normalizeCdnHost(value) {
    const text = String(value || "").trim().toLowerCase();
    if (!text || text.length > 253) return "";
    let host = "";
    try { host = new URL(/^[a-z][a-z\d+.-]*:\/\//.test(text) ? text : `https://${text}`).hostname; }
    catch (_error) { return ""; }
    return /^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/.test(host) && MEDIA_HOST_RE.test(host) ? host : "";
  }

  function normalizeSettings(input) {
    const source = input && typeof input === "object" ? input : {};
    const allowed = [4, 8, 16, 32, 64, 128];
    const requested = Math.trunc(Number(source.concurrency));
    return {
      enabled: source.enabled !== false,
      theme: ["light", "dark"].includes(source.theme) ? source.theme : "auto",
      // The live module on live.bilibili.com; the master switch above still rules. Off unless
      // switched on: a viewer who never chose keeps Bilibili's own live player.
      liveEnabled: source.liveEnabled === true,
      // 剧集加速: episode pages (/bangumi/play/ep… and ss…: anime, films, documentaries, …),
      // sped up in the compatibility mode only.
      episodeEnabled: source.episodeEnabled !== false,
      // 阻止使用国际版: keeps the viewer on Bilibili's domestic site (bilibili-site.js). Off unless
      // switched on.
      blockInternational: source.blockInternational === true,
      // "full" replaces Bilibili's playback core; "compat" leaves it in charge and only
      // downloads its media requests.
      takeover: source.takeover === "compat" ? "compat" : "full",
      mode: ["overseas", "custom"].includes(source.mode) ? source.mode : "mainland",
      customHosts: (Array.isArray(source.customHosts) ? source.customHosts : [])
        .map(normalizeCdnHost)
        .filter((host, index, all) => host && all.indexOf(host) === index)
        .slice(0, 32),
      // The round button in the page corner that opens the settings panel.
      floatingButton: source.floatingButton !== false,
      // Where the viewer dragged it, as shares of the window (0 = flush left, 1 = flush
      // right); null when it was never moved.
      floatingButtonLeft: source.floatingButtonLeft != null && Number(source.floatingButtonLeft) >= 0 && Number(source.floatingButtonLeft) <= 1 ? Number(source.floatingButtonLeft) : null,
      floatingButtonTop: source.floatingButtonTop != null && Number(source.floatingButtonTop) >= 0 && Number(source.floatingButtonTop) <= 1 ? Number(source.floatingButtonTop) : null,
      // The first-run guide to the floating button was answered (settings-panel.js).
      guideDone: source.guideDone === true,
      concurrency: allowed.includes(requested) ? requested : 8,
      // 自动线程数: the downloader picks the thread count itself, between 8 and 64, and
      // `concurrency` above is only what the viewer set by hand. Off when the value is
      // missing here; the userscript's stored settings (bridge.js) default it to on.
      autoConcurrency: source.autoConcurrency === true,
      minChunkBytes: 64 * 1024,
      firstByteTimeoutMs: 5500,
      stallTimeoutMs: 4000,
      attemptTimeoutMs: 15000,
      hedgeDelayMs: 900,
      // 全接管预缓冲时长: how far ahead the full takeover buffers, one of a few choices.
      bufferAheadSeconds: [30, 45, 90, 180].includes(Number(source.bufferAheadSeconds)) ? Number(source.bufferAheadSeconds) : 45,
      // 二级缓冲: what the browser's buffer has no room for waits in memory (native-mse-player.js).
      // Experimental, off unless switched on.
      secondaryBuffer: source.secondaryBuffer === true
    };
  }

  root.__BILI_RANGE_CORE__ = Object.freeze({
    concatChunks,
    isBilibiliMediaUrl,
    normalizeCdnHost,
    normalizeSettings,
    parseByteRange,
    parseContentRange,
    parseRangeHeader,
    splitRange
  });
})(globalThis);

/* src/bilibili-site.js */
// Bilibili's international site: the same pages under a language, /zh-Hans/video/…,
// /en/bangumi/play/…, /ja/list/watchlater, or with ?site=OVERSEAS&lang=…, and a home page
// without the channel bar. The user_site cookie (CN or OVERSEAS) tells both Bilibili's
// server and its page code which site to show. page-hook.js reads addresses with the language
// taken off; bridge.js keeps viewers on the domestic site while BTR and 阻止使用国际版 are both
// on (阻止使用国际版 is off unless switched on).
//
// The languages keep growing, so one is recognised by its form and by the browser knowing it
// as a language, besides the ones the site has today (Chrome knows fewer languages than Node).
//
// A video's address can also name it by its av number (/video/av170001: an old link, or an
// address another script rewrote); avToBv gives the BV number of the same video.
(function installBilibiliSite(root) {
  "use strict";

  const KNOWN = ["zh-hans", "zh-hant", "en", "ja", "th", "vi", "id", "ar", "pt", "es", "tr", "ru", "ms"];
  const TAG = /^[a-z]{2,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?$/i;
  const COOKIE = "domain=.bilibili.com; path=/; max-age=31536000";
  // Two trips back to the domestic site within this time: Bilibili keeps sending this tab to
  // the international one (a signed-in account it allows nothing else), so it is left there.
  const REDIRECT_WINDOW_MS = 15000;
  const REDIRECT_KEY = "btr-domestic-site-redirects";
  let names = null;
  try { names = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }); } catch (_error) {}

  function isLanguage(segment) {
    const value = String(segment || "");
    if (!TAG.test(value)) return false;
    if (KNOWN.includes(value.toLowerCase())) return true;
    try { return Boolean(names?.of(value)); } catch (_error) { return false; }
  }

  // The address's path without the language in front: /zh-Hans/video/BV… → /video/BV….
  function withoutLanguage(pathname) {
    const [, first = "", ...rest] = String(pathname || "/").split("/");
    return isLanguage(first) ? `/${rest.join("/")}` : String(pathname || "/");
  }

  // The same page on the domestic site, or "" when this already is one. Space pages have an
  // international site too (space.bilibili.com/en/2); there only the site's own languages are
  // taken off, as its router has them.
  function domesticAddress(href) {
    let url;
    try { url = new URL(String(href)); } catch (_error) { return ""; }
    let path = url.pathname;
    if (url.hostname === "www.bilibili.com") path = withoutLanguage(path);
    else if (url.hostname === "space.bilibili.com") {
      const [, first = "", ...rest] = path.split("/");
      if (KNOWN.includes(first.toLowerCase())) path = `/${rest.join("/")}`;
    } else return "";
    if (path === url.pathname && String(url.searchParams.get("site") || "").toUpperCase() !== "OVERSEAS") return "";
    url.pathname = path;
    url.search = withoutSiteParameters(url.search);
    return url.href;
  }

  // The query without the international site's own parameters (site=, lang=), the rest kept as
  // written, as Bilibili's page code does.
  function withoutSiteParameters(search) {
    const kept = String(search || "").replace(/^\?/, "").split("&").filter((part) => !/^(site|lang)=/i.test(part));
    return kept.join("&") ? `?${kept.join("&")}` : "";
  }

  // Whether a navigation goes from a domestic page to the same page on the international
  // site: the redirect Bilibili's page code makes once it knows who is signed in. For a signed-
  // in viewer it decides by the account (its default_sites cookie) and not by user_site, so
  // keeping user_site on CN does not stop it (#68).
  function isSiteRedirect(destination, current) {
    let from, to;
    try { from = new URL(String(current)); to = new URL(String(destination)); } catch (_error) { return false; }
    if (from.host !== to.host || domesticAddress(from.href)) return false;
    const twin = domesticAddress(to.href);
    if (!twin) return false;
    const page = (url) => { const parsed = new URL(url); return `${parsed.pathname.replace(/\/+$/, "") || "/"}${withoutSiteParameters(parsed.search)}`; };
    return page(twin) === page(from.href);
  }

  function readCookie(name) {
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(document.cookie);
    return match ? match[1] : null;
  }

  // Tells the server and Bilibili's page code to show the domestic site, so that
  // bilibili.com/ is never sent on to bilibili.com/<language>.
  function keepDomestic() {
    if (readCookie("user_site") !== "CN") document.cookie = `user_site=CN; ${COOKIE}`;
  }

  // When the switch goes off, Bilibili chooses the site again, as it would without BTR.
  function stopKeepingDomestic() {
    if (readCookie("user_site") === "CN") document.cookie = `user_site=; domain=.bilibili.com; path=/; max-age=0`;
  }

  // Without the tab's own storage there is no way to tell a loop, so no redirect either.
  function mayRedirect(now = Date.now()) {
    try {
      const recent = JSON.parse(sessionStorage.getItem(REDIRECT_KEY) || "[]").filter((at) => now - at < REDIRECT_WINDOW_MS);
      if (recent.length >= 2) return false;
      sessionStorage.setItem(REDIRECT_KEY, JSON.stringify([...recent, now]));
      return true;
    } catch (_error) { return false; }
  }

  // Bilibili's published conversion, for every av number below 2^51; "" for anything else.
  function avToBv(aid) {
    const text = String(aid ?? "").trim();
    if (!/^\d{1,16}$/.test(text)) return "";
    const number = BigInt(text);
    if (number < 1n || number >= 1n << 51n) return "";
    const table = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";
    const chars = ["B", "V", "1", "0", "0", "0", "0", "0", "0", "0", "0", "0"];
    let value = ((1n << 51n) | number) ^ 23442827791579n;
    for (let index = chars.length - 1; value > 0n; index -= 1) {
      chars[index] = table[Number(value % 58n)];
      value /= 58n;
    }
    [chars[3], chars[9]] = [chars[9], chars[3]];
    [chars[4], chars[7]] = [chars[7], chars[4]];
    return chars.join("");
  }

  root.__BTR_BILIBILI_SITE__ = Object.freeze({ isLanguage, withoutLanguage, domesticAddress, isSiteRedirect, keepDomestic, stopKeepingDomestic, mayRedirect, avToBv });
})(globalThis);

/* src/cdn-resolver.js */
(function installCdnResolver(root) {
  "use strict";

  const core = root.__BILI_RANGE_CORE__;
  if (!core) return;

  const MAINLAND_HOSTS = Object.freeze([
    "upos-sz-mirrorali.bilivideo.com",
    "upos-sz-mirrorhw.bilivideo.com",
    "upos-sz-mirrorbos.bilivideo.com",
    "upos-sz-mirror08c.bilivideo.com",
    "upos-sz-mirrorbd.bilivideo.com",
    "upos-sz-mirror14b.bilivideo.com",
    "upos-sz-estgoss.bilivideo.com",
    "upos-sz-mirrorcos.bilivideo.com",
    "upos-sz-mirrorcoso1.bilivideo.com"
  ]);

  const OVERSEAS_HOSTS = Object.freeze([
    "upos-sz-mirrorcosov.bilivideo.com",
    "upos-sz-mirroraliov.bilivideo.com",
    "cn-hk-eq-01-01.bilivideo.com",
    "cn-hk-eq-01-03.bilivideo.com"
  ]);

  function isAkamaiUrl(value) {
    try { return new URL(value).hostname.toLowerCase().endsWith(".akamaized.net"); }
    catch (_error) { return false; }
  }

  // A P2P or edge-cache relay (an mcdn node, or the mountaintoys.cn caches beside them) wraps
  // the file in its own path and signature. Its address works only on relays: every ordinary
  // node refuses it.
  function isRelayUrl(value) {
    try {
      const url = new URL(value);
      return /(?:^|\.)mcdn\./i.test(url.hostname) || /^\/v1\/resource\//i.test(url.pathname)
        || String(url.searchParams.get("os") || "").toLowerCase() === "mcdn";
    } catch (_error) {
      return false;
    }
  }

  function safeMediaUrl(value) {
    try {
      const url = new URL(String(value));
      return core.isBilibiliMediaUrl(url.href) ? url.href : null;
    } catch (_error) {
      return null;
    }
  }

  function swapOrdinaryHost(rawUrl, targetHost, allowAkamai = false) {
    if (!allowAkamai && isAkamaiUrl(rawUrl)) return null;
    const host = String(targetHost || "").toLowerCase();
    if (core.normalizeCdnHost(host) !== host) return null;
    try {
      const url = new URL(rawUrl);
      // Setting only the host name would keep a non-standard port, such as a peer CDN's
      // :4483, so the port is cleared too.
      url.hostname = host;
      url.port = "";
      return url.href;
    } catch (_error) {
      return null;
    }
  }

  // The custom mode uses only the servers picked in the settings. Without any, it uses the
  // mainland node list.
  function customServers(mode, customHosts) {
    return mode === "custom" && Array.isArray(customHosts) ? customHosts.map(core.normalizeCdnHost).filter(Boolean) : [];
  }

  function representationUrls(representation, mode, customHosts = []) {
    const primary = representation?.baseUrl || representation?.base_url;
    const backup = representation?.backupUrl || representation?.backup_url || representation?.backup_url_list || [];
    const originals = [primary, ...(Array.isArray(backup) ? backup : [])]
      .map(safeMediaUrl)
      .filter(Boolean)
      .filter((value, index, all) => all.indexOf(value) === index);
    const custom = customServers(mode, customHosts);
    const hosts = custom.length ? custom : mode === "overseas" ? OVERSEAS_HOSTS : MAINLAND_HOSTS;
    // A relay address moved to an ordinary node is refused there, so only ordinary addresses
    // are moved to the other nodes.
    const ordinary = originals.filter((url) => !isRelayUrl(url));
    const donor = ordinary.find((url) => !isAkamaiUrl(url));
    // Some overseas accounts are given nothing but akamaized.net addresses. That used to leave
    // no node at all in mainland mode and a single one in overseas mode. The nodes accept
    // those signatures too, so only in that case the akamaized.net addresses are the donors.
    // Bilibili may hand out an address that every node refuses (HTTP 403) next to one that
    // works, so each of them is tried; the ban list drops the refused one. Node-major order
    // puts every address in the first few requests, so one that every node refuses cannot
    // take all of them.
    const synthetic = (donor
      ? hosts.map((host) => swapOrdinaryHost(donor, host))
      : hosts.flatMap((host) => ordinary.map((url) => swapOrdinaryHost(url, host, true))))
      .map(safeMediaUrl)
      .filter(Boolean);
    const allowedOriginals = custom.length
      ? originals.filter((url) => custom.includes(hostOf(url)))
      : mode === "overseas"
        ? originals.filter((url) => !MAINLAND_HOSTS.includes(hostOf(url)))
        : originals.filter((url) => MAINLAND_HOSTS.includes(hostOf(url)));
    // Bilibili sometimes hands a track out only through relays. No other node can serve it
    // then, so the relays are used whatever the mode, rather than giving the video up.
    const relays = ordinary.length ? [] : originals;
    return [...allowedOriginals, ...synthetic, ...relays].filter((value, index, all) => all.indexOf(value) === index);
  }

  function hostOf(value) {
    try { return new URL(value).hostname.toLowerCase(); }
    catch (_error) { return ""; }
  }

  // The signed address without its node: the same address can be asked of any node.
  function addressOf(value) {
    try {
      const url = new URL(value);
      return url.pathname + url.search;
    } catch (_error) {
      return "";
    }
  }

  // A CDN node that twice fails without sending a single byte is skipped for the
  // rest of the current video. The owner resets the list when the video changes.
  //
  // HTTP 4xx means the node answered and refused the signed address, and either side can be
  // at fault: a node may lack the file, or Bilibili may have handed out an address that every
  // node refuses. What has delivered data decides it. Refused by a node that serves other
  // addresses, the address is dropped; refused where other nodes serve it, the node is.
  // With neither known yet, the reply counts against nobody until one of them delivers.
  function createBanList(options = {}) {
    const limit = Math.max(1, Math.trunc(Number(options.limit)) || 2);
    const emptyReplies = new Map();
    const goodNodes = new Set();
    const goodAddresses = new Set();
    const reported = new Set();
    let banned = new Set();

    function judge(url, error) {
      const strikes = new Map();
      for (const [key, count] of emptyReplies) {
        const [node, address, refused] = key.split("\n");
        // A node that serves other addresses and refuses one that other nodes serve loses only
        // that pair; it is often the fastest node for the addresses it does serve.
        const blamed = !refused ? `node:${node}`
          : goodNodes.has(node) ? (goodAddresses.has(address) ? `pair:${node} ${address}` : `address:${address}`)
            : goodAddresses.has(address) ? `node:${node}` : "";
        if (blamed) strikes.set(blamed, (strikes.get(blamed) || 0) + count);
      }
      banned = new Set([...strikes].filter(([, count]) => count >= limit).map(([key]) => key));
      let added = false;
      for (const key of banned) {
        if (reported.has(key)) continue;
        reported.add(key);
        added = true;
        const isNode = key.startsWith("node:");
        try { options.onBan?.(isNode ? key.slice(5) : hostOf(url), strikes.get(key), error, isNode ? "node" : "address"); } catch (_error) {}
      }
      return added;
    }

    return Object.freeze({
      record(url, receivedBytes, error) {
        if (error?.name === "AbortError" || Number(receivedBytes) > 0) return false;
        const node = hostOf(url);
        if (!node) return false;
        const status = Number(error?.status) || 0;
        const key = `${node}\n${addressOf(url)}\n${status >= 400 && status < 500 ? "refused" : ""}`;
        emptyReplies.set(key, (emptyReplies.get(key) || 0) + 1);
        return judge(url, error);
      },
      success(url) {
        const node = hostOf(url);
        const address = addressOf(url);
        if (!node || (goodNodes.has(node) && goodAddresses.has(address))) return;
        goodNodes.add(node);
        goodAddresses.add(address);
        judge(url, null);
      },
      allows: (url) => !banned.has(`node:${hostOf(url)}`) && !banned.has(`address:${addressOf(url)}`) && !banned.has(`pair:${hostOf(url)} ${addressOf(url)}`),
      allowsNode: (url) => !banned.has(`node:${hostOf(url)}`),
      allowsAddress: (url) => !banned.has(`address:${addressOf(url)}`),
      hosts: () => [...banned].filter((key) => key.startsWith("node:")).map((key) => key.slice(5)),
      reset() {
        emptyReplies.clear();
        goodNodes.clear();
        goodAddresses.clear();
        reported.clear();
        banned = new Set();
      }
    });
  }

  // How long a measured speed counts. A node in use is measured again with every segment; one
  // that was left out for being slow goes back to the untested ones after this, and gets
  // another try through the exploration slot.
  const MEASUREMENT_TTL_MS = 90000;

  function createResolver(representation, getMode, bans = null, getCustomHosts = null) {
    const health = new Map();
    // What is known about a node's speed, per node and file, without the query. An address
    // with a fresh signature is the same route, so it starts with what its predecessor
    // measured. Failures are not kept here: those belong to the address they happened on.
    const routes = new Map();
    const routeKeys = new Map();
    const routeOf = (url) => {
      let key = routeKeys.get(url);
      if (!key) {
        try {
          const parsed = new URL(url);
          key = `${parsed.host}${parsed.pathname}`;
        } catch (_error) { key = String(url); }
        if (routeKeys.size > 512) routeKeys.clear();
        routeKeys.set(url, key);
      }
      return key;
    };
    const measurement = (url) => routes.get(routeOf(url)) || null;
    // Only a transfer long enough to measure a speed renews it. The short tail of a resumed
    // piece proves the node works, and must not keep an old speed alive for ever.
    const measuredNow = (url, now = Date.now()) => {
      const item = measurement(url);
      return Boolean(item?.lastMeasuredAt) && now - item.lastMeasuredAt < MEASUREMENT_TTL_MS;
    };
    const bySpeed = (a, b) => {
      const am = measurement(a) || {};
      const bm = measurement(b) || {};
      return Number(Boolean(bm.lastSuccessAt)) - Number(Boolean(am.lastSuccessAt)) || (bm.bps || 0) - (am.bps || 0);
    };
    let cursor = 0;
    let mediaRangeCount = 0;
    let rangeCursor = 0;

    function allUrls() {
      return representationUrls(representation, getMode?.(), getCustomHosts?.() || []);
    }

    // Banned nodes, addresses and node/address pairs are left out. If everything is banned,
    // keep using the full list rather than leaving the video with no download address at all.
    function unbanned(list) {
      if (!bans) return list;
      const allowed = list.filter(bans.allows);
      return allowed.length ? allowed : list;
    }

    function urls() {
      return unbanned(allUrls());
    }

    function ordered(pieceIndex = 0, exclude = new Set()) {
      const now = Date.now();
      const candidates = urls().filter((url) => !exclude.has(url));
      const available = candidates.filter((url) => (health.get(url)?.blockedUntil || 0) <= now);
      const pool = available.length ? available : candidates;
      if (!pool.length) return [];
      const offset = (cursor + pieceIndex) % pool.length;
      const rotated = pool.slice(offset).concat(pool.slice(0, offset));
      cursor = (cursor + 1) % pool.length;
      return rotated;
    }

    function rangeCandidates() {
      const now = Date.now();
      const pool = urls()
        .filter((url) => (health.get(url)?.blockedUntil || 0) <= now)
        .sort(bySpeed);
      if (!pool.length) return urls();
      const firstRange = mediaRangeCount === 0;
      const width = Math.min(firstRange ? pool.length : 6, pool.length);
      let selected;
      const warmupRanges = getMode?.() === "mainland" ? 1 : 4;
      if (mediaRangeCount < warmupRanges) {
        selected = pool.slice(0, width);
        rangeCursor = width % pool.length;
      } else {
        // After the warm-up the measured nodes carry the segments in speed order; the
        // downloader gives the fast ones the larger share. One other node rides along per
        // segment: one that never answered, or one whose measurement has gone stale because
        // it was too slow to be used. Routes change, so a slow node is not slow for good.
        // While fewer nodes are measured than a segment uses, the free places go to the others
        // as well: the downloader gives an unmeasured node only a trial piece or two, so
        // finding the good nodes quickly costs little.
        const measured = pool.filter((url) => measuredNow(url, now));
        const rest = pool.filter((url) => !measuredNow(url, now));
        const places = Math.min(rest.length, Math.max(1, width - measured.length));
        const explore = Array.from({ length: places }, (_item, index) => rest[(rangeCursor + index) % rest.length]);
        rangeCursor = (rangeCursor + places) % Math.max(1, pool.length);
        selected = [...measured.slice(0, width - explore.length), ...explore];
        for (const url of pool) {
          if (selected.length >= Math.min(3, pool.length)) break;
          if (!selected.includes(url)) selected.push(url);
        }
      }
      mediaRangeCount += 1;
      return selected;
    }

    function startupCandidates() {
      const now = Date.now();
      const primary = representation?.baseUrl || representation?.base_url;
      const backup = representation?.backupUrl || representation?.backup_url || representation?.backup_url_list || [];
      // The first request also races the addresses Bilibili handed out, except in the custom
      // mode, which keeps to the picked servers.
      const originals = customServers(getMode?.(), getCustomHosts?.()).length ? [] : [primary, ...(Array.isArray(backup) ? backup : [])]
        .map(safeMediaUrl)
        .filter(Boolean);
      const candidates = unbanned([...originals, ...allUrls()]
        .filter((url, index, all) => all.indexOf(url) === index))
        .filter((url) => (health.get(url)?.blockedUntil || 0) <= now);
      return candidates.slice(0, 8);
    }

    function rescueCandidates() {
      const now = Date.now();
      return urls()
        .filter((url) => (health.get(url)?.blockedUntil || 0) <= now)
        .sort(bySpeed);
    }

    function success(url, bps) {
      bans?.success?.(url);
      const old = measurement(url) || {};
      const now = Date.now();
      const measured = bps > 0;
      health.set(url, { failures: 0, blockedUntil: 0, lastSuccessAt: now });
      routes.set(routeOf(url), {
        lastSuccessAt: now,
        // No speed comes with a transfer too short to measure one; the last one stays, and
        // keeps its age.
        lastMeasuredAt: measured ? now : old.lastMeasuredAt || 0,
        bps: !measured ? old.bps || 0 : old.bps ? old.bps * 0.65 + bps * 0.35 : bps
      });
    }

    // The speed of a transfer that was cut off before its end. It says how fast the node is
    // and nothing more: the address has not proven itself, and earlier failures stay.
    function sample(url, bps) {
      if (!(bps > 0)) return;
      const old = measurement(url) || {};
      routes.set(routeOf(url), {
        lastSuccessAt: old.lastSuccessAt || 0,
        lastMeasuredAt: Date.now(),
        bps: old.bps ? old.bps * 0.65 + bps * 0.35 : bps
      });
    }

    function failure(url, error, receivedBytes = 0) {
      if (error?.name === "AbortError") return;
      bans?.record(url, receivedBytes, error);
      const old = health.get(url) || {};
      const failures = (old.failures || 0) + 1;
      health.set(url, {
        ...old,
        failures,
        blockedUntil: Date.now() + Math.min(60000, 3000 * (2 ** Math.min(failures, 4)))
      });
    }

    function status() {
      const now = Date.now();
      // A refused address says nothing about its node, so it is left out of the node list.
      const all = allUrls();
      const usable = bans?.allowsAddress ? all.filter(bans.allowsAddress) : all;
      return (usable.length ? usable : all).map((url) => {
        const item = health.get(url) || {};
        const nodeBanned = bans && !(bans.allowsNode ? bans.allowsNode(url) : bans.allows(url));
        return {
          host: new URL(url).hostname,
          state: nodeBanned ? "banned" : (item.blockedUntil || 0) > now ? "blocked" : measurement(url)?.lastSuccessAt ? "healthy" : "untested",
          bps: measurement(url)?.bps || 0
        };
      });
    }

    const allows = (url) => !bans || bans.allows(url);
    // The measured download speed of an address, for weighting piece assignments. 0 when
    // there is none or it has gone stale.
    const speed = (url) => (measuredNow(url) ? measurement(url)?.bps || 0 : 0);
    return Object.freeze({ allows, failure, ordered, rangeCandidates, rescueCandidates, sample, speed, startupCandidates, status, success, urls });
  }

  root.__BILI_CDN_RESOLVER_FACTORY__ = Object.freeze({
    MAINLAND_HOSTS,
    OVERSEAS_HOSTS,
    createBanList,
    createResolver,
    isAkamaiUrl,
    isRelayUrl,
    representationUrls,
    swapOrdinaryHost
  });
})(globalThis);

/* src/sidx.js */
(function installSidx(root) {
  "use strict";

  function readUint64(view, offset) {
    const value = view.getUint32(offset) * (2 ** 32) + view.getUint32(offset + 4);
    return Number.isSafeInteger(value) ? value : null;
  }

  function readType(bytes, offset) {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  }

  function parseSidx(buffer, absoluteStart = 0) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let boxOffset = 0;

    while (boxOffset + 8 <= bytes.byteLength) {
      let boxSize = view.getUint32(boxOffset);
      const type = readType(bytes, boxOffset + 4);
      let headerSize = 8;
      if (boxSize === 1) {
        if (boxOffset + 16 > bytes.byteLength) return null;
        boxSize = readUint64(view, boxOffset + 8);
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = bytes.byteLength - boxOffset;
      }
      if (!boxSize || boxSize < headerSize || boxOffset + boxSize > bytes.byteLength) return null;

      if (type === "sidx") {
        let cursor = boxOffset + headerSize;
        if (cursor + 12 > boxOffset + boxSize) return null;
        const version = view.getUint8(cursor);
        cursor += 4;
        cursor += 4;
        const timescale = view.getUint32(cursor);
        cursor += 4;
        if (!timescale) return null;

        let earliestPresentationTime;
        let firstOffset;
        if (version === 0) {
          if (cursor + 8 > boxOffset + boxSize) return null;
          earliestPresentationTime = view.getUint32(cursor);
          firstOffset = view.getUint32(cursor + 4);
          cursor += 8;
        } else if (version === 1) {
          if (cursor + 16 > boxOffset + boxSize) return null;
          earliestPresentationTime = readUint64(view, cursor);
          firstOffset = readUint64(view, cursor + 8);
          cursor += 16;
          if (earliestPresentationTime === null || firstOffset === null) return null;
        } else {
          return null;
        }

        cursor += 2;
        if (cursor + 2 > boxOffset + boxSize) return null;
        const referenceCount = view.getUint16(cursor);
        cursor += 2;
        if (referenceCount < 1 || referenceCount > 10000 || cursor + referenceCount * 12 > boxOffset + boxSize) return null;

        let byteCursor = absoluteStart + boxOffset + boxSize + firstOffset;
        let timeCursor = earliestPresentationTime;
        const segments = [];
        for (let index = 0; index < referenceCount; index += 1) {
          const reference = view.getUint32(cursor);
          const referenceType = reference >>> 31;
          const referencedSize = reference & 0x7fffffff;
          const duration = view.getUint32(cursor + 4);
          cursor += 12;
          if (!referencedSize) return null;
          if (referenceType === 0) {
            segments.push({
              index: segments.length,
              start: byteCursor,
              end: byteCursor + referencedSize - 1,
              length: referencedSize,
              time: timeCursor,
              duration,
              startTime: timeCursor / timescale,
              endTime: (timeCursor + duration) / timescale,
              durationSeconds: duration / timescale
            });
          }
          byteCursor += referencedSize;
          timeCursor += duration;
        }
        if (!segments.length) return null;
        return { earliestPresentationTime, firstOffset, segments, timescale };
      }
      boxOffset += boxSize;
    }
    return null;
  }

  function segmentIndexAt(segments, seconds) {
    if (!Array.isArray(segments) || !segments.length) return -1;
    const target = Math.max(0, Number(seconds) || 0);
    let low = 0;
    let high = segments.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const segment = segments[middle];
      if (target < segment.startTime) high = middle - 1;
      else if (target >= segment.endTime) low = middle + 1;
      else return middle;
    }
    return Math.max(0, Math.min(segments.length - 1, low));
  }

  root.__BILI_SIDX__ = Object.freeze({ parseSidx, segmentIndexAt });
})(globalThis);

/* src/idm-downloader.js */
(function installIdmDownloader(root) {
  "use strict";

  const core = root.__BILI_RANGE_CORE__;
  if (!core) return;

  const PIECE_ROUNDS = 3;
  const PIECE_RETRY_WINDOW_MS = 25000;
  // The pause before a piece's next round of addresses: half a second, doubling, at most two.
  const roundPause = (round) => Math.min(2000, 500 * (2 ** (round - 1)));
  // Below this a resumed request saves less than its own round trip costs.
  const RESUME_MIN_BYTES = 32 * 1024;
  // Hedging a piece with a playback deadline (see hedgeDue): a first copy projected to finish
  // this long before the deadline gets no copy yet; one receiving at least HEDGE_PACE of the
  // usual connection speed is on pace; a copy's node measured HEDGE_FASTER times faster than the
  // first copy is receiving is worth a copy anyway.
  const HEDGE_SLACK_MS = 1500;
  const HEDGE_PACE = 0.6;
  const HEDGE_FASTER = 1.5;
  // Queue classes, served in this order: the startup probe and init/index, then startup
  // pieces, then everything else. A class never waits behind a lower one.
  const QUEUE_CRITICAL = 0, QUEUE_STARTUP = 1, QUEUE_ORDINARY = 2;
  // Priority an ordinary request with a playback deadline gains per millisecond of waiting:
  // 20 (a hedge copy's boost) in 0.9 s.
  const QUEUE_AGING_PER_MS = 20 / 900;
  // A shorter transfer is mostly round trip. The tail of a resumed piece can be a few KiB,
  // and counting it would mark down the very node that came to the rescue.
  const SPEED_SAMPLE_MIN_BYTES = 48 * 1024;

  function abortError(reason) {
    if (reason instanceof Error || reason instanceof DOMException) return reason;
    return new DOMException("播放器任务已取消", "AbortError");
  }

  class Semaphore {
    constructor(limit) {
      this.limit = limit;
      this.active = 0;
      this.queue = [];
      this.sequence = 0;
    }

    setLimit(limit) {
      this.limit = Math.max(1, Math.min(512, Math.trunc(limit) || 1));
      this.drain();
    }

    drain() {
      try { this.drainQueue(); } finally { this.onChange?.(this.active, this.limit, this.queue.length); }
    }

    drainQueue() {
      while (this.active < this.limit && this.queue.length) {
        const now = performance.now();
        const urgency = entry => {
          // Read again at every pass: the player's deadline moves with the playhead and the
          // playback rate, and a queued piece may have become due while it waited.
          const deadlineAt = entry.deadline ? entry.deadline() : entry.deadlineAt;
          if (!Number.isFinite(deadlineAt)) return 0;
          const remaining = deadlineAt - now;
          if (remaining <= 0) return 12;
          if (remaining <= 750) return 9;
          if (remaining <= 2000) return 6;
          return 0;
        };
        // A bounded, recomputed boost prevents overdue primaries from sitting behind
        // prefetch work without turning the queue back into strict deadline ordering. A
        // request with a deadline also gains priority while it waits, so a piece queued long
        // ago is not passed over again and again by newer ones of a slightly higher priority;
        // requests without one (compatibility mode, the desktop client) keep the fixed order.
        // Sorting inside the class keeps the startup probe, init and index, and then the
        // startup pieces, ahead of ordinary media whatever the boosts add up to.
        const rank = entry => entry.priority + urgency(entry)
          + (entry.ages ? (now - entry.queuedAt) * QUEUE_AGING_PER_MS : 0);
        this.queue.sort((a, b) => a.queueClass - b.queueClass || rank(b) - rank(a)
          || a.sequence - b.sequence);
        const entry = this.queue.shift();
        entry.signal?.removeEventListener("abort", entry.cancel);
        if (entry.signal?.aborted) {
          entry.reject(abortError(entry.signal.reason));
          continue;
        }
        this.active += 1;
        entry.resolve(() => {
          if (entry.released) return;
          entry.released = true;
          this.active = Math.max(0, this.active - 1);
          this.drain();
        });
      }
    }

    // deadline: a function giving the clock time playback needs this request, or null; the
    // fixed deadlineAt is what callers without one pass.
    acquire(signal, priority = 0, deadlineAt = Infinity, queueClass = QUEUE_CRITICAL, ages = false, deadline = null) {
      if (signal?.aborted) return Promise.reject(abortError(signal.reason));
      return new Promise((resolve, reject) => {
        const entry = {
          reject,
          resolve,
          signal,
          released: false,
          priority: Number(priority) || 0,
          deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : Infinity,
          deadline,
          queueClass,
          ages,
          queuedAt: performance.now(),
          sequence: this.sequence++
        };
        entry.cancel = () => {
          const index = this.queue.indexOf(entry);
          if (index < 0) return;
          this.queue.splice(index, 1);
          signal.removeEventListener("abort", entry.cancel);
          reject(abortError(signal.reason));
        };
        signal?.addEventListener("abort", entry.cancel, { once: true });
        this.queue.push(entry);
        this.drain();
      });
    }
  }

  // 自动线程数. One controller for the whole page: the thread count starts at 8 and climbs a
  // ladder towards 64 on every sign that the download is not keeping up with playback
  // (the player stalls; a low buffer stops growing while bytes keep arriving; a
  // connection waits too long for its first byte while every slot is busy). Every step up
  // is a trial: ten seconds later the bytes per second must have grown, otherwise the
  // step is taken back to where it started and that level rests for a while — more
  // connections that bring nothing only add risk. A server refusing the load (412, 429)
  // steps it back too, and nothing climbs past a refused level until it has rested. The
  // level is kept across videos on the same page; a new page starts at 8 again.
  //
  // Each start (a new video, a seek outside the buffer) opens with at least 16 threads: the
  // first seconds are when a slow node turns into a spinning wheel. Once the buffer is well
  // ahead, the count steps back down to the level the page had before. A sign of not keeping
  // up meanwhile climbs as usual and ends the start there; so does half a minute without
  // catching up. From then on the rules above carry on.
  //
  // Stalls, the buffer and new starts come from the player (stall, buffer, newSession); a
  // caller that reports none of them (the userscript's compatibility mode) gets only the
  // slow-first-byte climb and the refusals.
  const AUTO_LADDER = Object.freeze([8, 12, 16, 24, 32, 48, 64]);
  const AUTO_STARTUP_LEVEL = 2;
  const AUTO_STARTUP_COMFORT_SECONDS = 15;
  const AUTO_STARTUP_MAX_MS = 30000;
  const AUTO_STEP_COOLDOWN_MS = 2500;
  const AUTO_TRIAL_MS = 10000;
  const AUTO_WINDOW_MS = 5000;
  const AUTO_BUCKET_MS = 250;
  const AUTO_REST_MS = 90000;
  const AUTO_PUSHBACK_REST_MS = 180000;
  const AUTO_LOW_BUFFER_SECONDS = 6;
  const AUTO_PRESSURE_MS = 1000;
  const AUTO_ACTIVITY_MS = 1500;

  function createAutoConcurrency({ now = () => performance.now() } = {}) {
    const listeners = new Set();
    const state = {
      level: 0, changedAt: 0, reason: "起步", steps: 0, trial: null,
      // level index -> { until, hard }: hard rests (refusals) also cap every level above.
      resting: new Map(),
      buckets: [], lastActivityAt: -Infinity,
      // Time the connections spent saturated: intervals of { from, to } within the window.
      saturated: false, saturatedSince: 0, saturatedSpans: [],
      aheadSamples: [], pressureSince: 0,
      // The start of a session while it runs above the page's own level: { base, until }.
      startup: null
    };
    const threads = () => AUTO_LADDER[state.level];

    function pruneBuckets(at) {
      while (state.buckets.length && at - state.buckets[0].at > AUTO_WINDOW_MS) state.buckets.shift();
    }

    // Bytes per second over the window, from completed pieces only: a hedge copy that lost
    // its race is not delivery.
    function throughput(at = now()) {
      pruneBuckets(at);
      if (!state.buckets.length) return 0;
      const bytes = state.buckets.reduce((sum, item) => sum + item.bytes, 0);
      // Over the time between the first and the last delivery in the window: an idle tail
      // (nothing wanted) is not slowness.
      return bytes * 1000 / Math.max(1000, state.buckets.at(-1).at - state.buckets[0].at + AUTO_BUCKET_MS);
    }

    // The share of the window during which every slot was busy and pieces were queued.
    function saturation(at = now()) {
      const from = at - AUTO_WINDOW_MS;
      state.saturatedSpans = state.saturatedSpans.filter((span) => span.to > from);
      let busy = state.saturatedSpans.reduce((sum, span) => sum + Math.max(0, span.to - Math.max(span.from, from)), 0);
      if (state.saturated) busy += Math.max(0, at - Math.max(state.saturatedSince, from));
      return Math.min(1, busy / AUTO_WINDOW_MS);
    }

    function resting(level, at) {
      const rest = state.resting.get(level);
      if (!rest) return null;
      if (rest.until <= at) { state.resting.delete(level); return null; }
      return rest;
    }

    function setLevel(level, reason, trial) {
      const previous = threads();
      const at = now();
      state.level = level;
      state.changedAt = at;
      state.reason = reason;
      state.steps += 1;
      state.trial = trial || null;
      state.pressureSince = 0;
      for (const listener of listeners) {
        try { listener({ threads: threads(), previous, reason }); } catch (_error) {}
      }
    }

    // Up one level. A level resting after a refusal caps the climb; one resting after a
    // fruitless trial is skipped only by a strong signal (a stall), not by pressure.
    function stepUp(reason, strong) {
      const at = now();
      if (at - state.changedAt < AUTO_STEP_COOLDOWN_MS) return false;
      if (resting(state.level, at)?.hard) return false;
      let next = state.level + 1;
      while (next < AUTO_LADDER.length) {
        const rest = resting(next, at);
        if (!rest) break;
        if (rest.hard || !strong) return false;
        next += 1;
      }
      if (next >= AUTO_LADDER.length) return false;
      setLevel(next, reason, { from: state.level, level: next, at, baseline: throughput(at), stalled: false });
      // Not keeping up even with the start's threads: the start ends at this level.
      state.startup = null;
      return true;
    }

    // How high a start may go: up to 16 threads, but not onto or past a level the server
    // refused (a fruitless trial does not hold it back; the start comes down on its own).
    function startupLevel(at) {
      if (resting(state.level, at)?.hard) return state.level;
      let level = state.level;
      while (level < AUTO_STARTUP_LEVEL && !resting(level + 1, at)?.hard) level += 1;
      return level;
    }

    function stepDown(target, restLevel, reason, restMs, hard) {
      state.resting.set(restLevel, { until: now() + restMs, hard });
      if (target >= state.level) return false;
      setLevel(target, reason, null);
      return true;
    }

    // A step up has had its time: did the extra connections deliver? Only judged when the
    // connections were busy meanwhile; an idle download (buffer full) proves nothing, and
    // so does a stall in between. Without any gain the step goes back to where it started.
    function judgeTrial(at) {
      const trial = state.trial;
      if (!trial || at - trial.at < AUTO_TRIAL_MS) return;
      state.trial = null;
      if (trial.stalled || saturation(at) < 0.6 || trial.baseline <= 0) return;
      if (throughput(at) < trial.baseline) {
        stepDown(trial.from, trial.level, `${AUTO_LADDER[trial.level]} 线程没有比 ${AUTO_LADDER[trial.from]} 线程更快`, AUTO_REST_MS, false);
      }
    }

    return Object.freeze({
      ladder: AUTO_LADDER,
      threads,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      // A piece arrived whole.
      delivered(bytes, at = now()) {
        const last = state.buckets.at(-1);
        if (last && at - last.at < AUTO_BUCKET_MS) last.bytes += bytes;
        else state.buckets.push({ at, bytes });
        pruneBuckets(at);
        judgeTrial(at);
      },
      // Bytes are flowing on some connection right now.
      activity(at = now()) {
        state.lastActivityAt = at;
      },
      // The connections' state whenever it changes.
      demand(active, limit, queued, at = now()) {
        const saturated = active >= limit && queued > 0;
        if (saturated === state.saturated) return;
        if (state.saturated) state.saturatedSpans.push({ from: state.saturatedSince, to: at });
        state.saturated = saturated;
        state.saturatedSince = at;
        saturation(at);
      },
      // The player stalled: more threads at once.
      stall(reason = "播放卡了一下") {
        if (state.trial) state.trial.stalled = true;
        return stepUp(reason, true);
      },
      // The buffer ahead of the playhead, a few times a second while playing. A low buffer
      // that has not grown over the last second although bytes keep arriving, for a whole
      // second, means the connections are too few.
      buffer(ahead, playing, at = now()) {
        state.aheadSamples.push({ at, ahead });
        while (state.aheadSamples.length && at - state.aheadSamples[0].at > AUTO_PRESSURE_MS + AUTO_BUCKET_MS) state.aheadSamples.shift();
        // The start: once well ahead, one step back down per cooldown towards the page's level.
        const start = state.startup;
        if (start && at >= start.until) state.startup = null;
        else if (start && ahead >= AUTO_STARTUP_COMFORT_SECONDS && at - state.changedAt >= AUTO_STEP_COOLDOWN_MS) {
          if (state.level > start.base) setLevel(state.level - 1, `开头已经跟上，线程数降到 ${AUTO_LADDER[state.level - 1]}`, null);
          if (state.level <= start.base) state.startup = null;
        }
        const earlier = state.aheadSamples.find((item) => at - item.at >= AUTO_PRESSURE_MS);
        const downloading = at - state.lastActivityAt < AUTO_ACTIVITY_MS;
        const pressed = playing && downloading && ahead < AUTO_LOW_BUFFER_SECONDS && earlier && ahead <= earlier.ahead + 0.05;
        if (!pressed) { state.pressureSince = 0; return false; }
        if (!state.pressureSince) { state.pressureSince = at; return false; }
        if (at - state.pressureSince < AUTO_PRESSURE_MS) return false;
        state.pressureSince = 0;
        return stepUp("缓冲跟不上播放", false);
      },
      // A connection waited too long for its first byte while every slot was busy.
      slow() {
        return saturation() >= 0.6 ? stepUp("连接排队等太久", false) : false;
      },
      // The server refused the load: back one level, and nothing climbs past this one for
      // a while.
      pushback(status) {
        return stepDown(Math.max(0, state.level - 1), state.level, `服务器返回 ${status}`, AUTO_PUSHBACK_REST_MS, true);
      },
      // A new playback session: what the buffer did before means nothing now, and the start
      // runs with more threads. A session that begins while another one's start is still
      // running keeps the page's own level to come back to.
      newSession() {
        const at = now();
        state.aheadSamples.length = 0;
        state.pressureSince = 0;
        state.trial = null;
        state.buckets.length = 0;
        state.saturatedSpans.length = 0;
        if (state.saturated) state.saturatedSince = at;
        const base = state.startup ? state.startup.base : state.level;
        const target = startupLevel(at);
        if (target > state.level) setLevel(target, `开头先用 ${AUTO_LADDER[target]} 线程`, null);
        state.startup = state.level > base ? { base, until: at + AUTO_STARTUP_MAX_MS } : null;
      },
      status() {
        const at = now();
        return {
          threads: threads(), level: state.level, reason: state.reason, steps: state.steps, changedAt: state.changedAt,
          throughputBps: Math.round(throughput(at)), saturation: Math.round(saturation(at) * 100) / 100,
          buckets: state.buckets.length, activityAgeMs: Math.round(at - state.lastActivityAt),
          resting: [...state.resting.entries()].filter(([, rest]) => rest.until > at).map(([level, rest]) => ({ threads: AUTO_LADDER[level], hard: rest.hard, forMs: Math.round(rest.until - at) })),
          trial: state.trial ? { from: AUTO_LADDER[state.trial.from], level: AUTO_LADDER[state.trial.level], ageMs: Math.round(at - state.trial.at), baselineBps: Math.round(state.trial.baseline), stalled: state.trial.stalled } : null,
          startup: state.startup ? { base: AUTO_LADDER[state.startup.base], forMs: Math.round(state.startup.until - at) } : null
        };
      },
      reset() {
        state.level = 0; state.changedAt = 0; state.reason = "起步"; state.steps = 0; state.trial = null;
        state.resting.clear(); state.buckets.length = 0; state.lastActivityAt = -Infinity;
        state.saturated = false; state.saturatedSince = 0; state.saturatedSpans.length = 0;
        state.aheadSamples.length = 0; state.pressureSince = 0; state.startup = null;
      }
    });
  }
  const autoConcurrency = createAutoConcurrency();
  // Every downloader on the page follows the controller's count at once.
  const autoFollowers = new Set();
  autoConcurrency.subscribe(() => {
    for (const ref of autoFollowers) {
      const follow = ref.deref();
      if (follow) follow(); else autoFollowers.delete(ref);
    }
  });

  function createDownloader(options) {
    const nativeFetch = options.nativeFetch || root.fetch.bind(root);
    const getSettings = options.getSettings;
    const onTransfer = typeof options.onTransfer === "function" ? options.onTransfer : () => null;
    // getSettings returns a new object whenever something changes (the userscript's page
    // does), so the reference tells whether the previous normalization is still valid.
    let rawSettings = null;
    let normalizedSettings = null;
    let autoView = null;
    function config() {
      const raw = getSettings();
      if (raw !== rawSettings || !normalizedSettings) {
        rawSettings = raw;
        normalizedSettings = core.normalizeSettings(raw);
        autoView = null;
      }
      if (!normalizedSettings.autoConcurrency) return normalizedSettings;
      // In the automatic mode the thread count is the controller's, everything else the viewer's.
      const threads = autoConcurrency.threads();
      if (!autoView || autoView.concurrency !== threads) autoView = { ...normalizedSettings, concurrency: threads };
      return autoView;
    }
    const semaphore = new Semaphore(config().concurrency);
    const applySettings = () => semaphore.setLimit(config().concurrency);
    autoFollowers.add(new WeakRef(applySettings));
    semaphore.onChange = (active, limit, queued) => { if (config().autoConcurrency) autoConcurrency.demand(active, limit, queued); };

    // What one connection typically delivers here and how long a sub-chunk typically
    // takes. Sub-chunk sizing and the hedge delay follow these measurements.
    const meter = { connectionBps: 0, pieceMs: 0 };
    function recordMeter(bytes, elapsedMs) {
      if (bytes < SPEED_SAMPLE_MIN_BYTES || elapsedMs <= 0) return;
      const bps = bytes * 1000 / elapsedMs;
      meter.connectionBps = meter.connectionBps ? meter.connectionBps * 0.7 + bps * 0.3 : bps;
      meter.pieceMs = meter.pieceMs ? meter.pieceMs * 0.7 + elapsedMs * 0.3 : elapsedMs;
    }

    // A sub-chunk should keep its connection busy for a good part of a second, otherwise
    // request round trips dominate on high-latency routes. 64 KiB stays the floor while
    // the speed is still unknown, and a range still splits into at least one piece per
    // node: the total bandwidth only grows by spreading over hosts, and the hedges
    // against a stalling one need more than a single request to work with.
    function adaptiveMinChunk(settings, rangeLength, pieceLimit, hostCount = 4) {
      if (!meter.connectionBps) return settings.minChunkBytes;
      const target = Math.floor(meter.connectionBps * 0.6 / (64 * 1024)) * 64 * 1024;
      const spread = Math.ceil(rangeLength / Math.max(1, Math.min(Math.max(4, hostCount), pieceLimit)));
      return Math.max(settings.minChunkBytes, Math.min(1024 * 1024, target, spread));
    }

    // A second copy starts once a piece takes clearly longer than pieces have been
    // taking, instead of always waiting the full fixed delay.
    function hedgeDelayMs(settings) {
      return meter.pieceMs
        ? Math.max(250, Math.min(settings.hedgeDelayMs, Math.round(meter.pieceMs * 1.5)))
        : settings.hedgeDelayMs;
    }

    // Whether the second copy of a piece with a playback deadline should start now. Checked
    // every 50 ms once the first copy holds a connection (a copy of a request still queued
    // would only queue as well, and with its higher priority take the connection meant for
    // it). first: the first copy (when it started, bytes received, bytes asked for); the delay
    // counts from its start. copyBps: the measured speed of the copy's node, 0 when unknown.
    // - No data yet, or nothing new for a whole delay (stopped): copy.
    // - A deadline it meets with time to spare at its speed so far: no copy yet, the bandwidth
    //   goes to pieces needed sooner.
    // - The copy's node known to be clearly faster (HEDGE_FASTER times): copy.
    // - Slower than connections usually are, or no usual speed measured yet: copy.
    // - On pace: a copy on a node not known to be HEDGE_FASTER times faster only takes the
    //   next piece's connection and bandwidth; one on a node not measured yet is tried, as
    //   the chance of a faster one. A piece that will miss its deadline even so may spend one
    //   of the range's rescue slots on that node anyway: its measurement can be stale (a node
    //   that was slow a minute ago may have recovered), and waiting for the request to time
    //   out costs far more.
    function hedgeDue(first, delayMs, deadlineAt, copyBps, rescue) {
      const now = performance.now(), ran = now - first.startedAt;
      const got = first.recorder.bytes;
      if (got !== first.seenBytes) {
        first.seenBytes = got;
        first.seenAt = now;
      }
      if (ran < delayMs) return false;
      if (!got || now - first.seenAt >= delayMs) return true;
      const rate = got * 1000 / ran;
      if (now + Math.max(0, first.length - got) * 1000 / rate <= deadlineAt - HEDGE_SLACK_MS) return false;
      if (copyBps > rate * HEDGE_FASTER) return true;
      if (!(meter.connectionBps > 0) || rate < meter.connectionBps * HEDGE_PACE) return true;
      if (!(copyBps > 0)) return true;
      return now + Math.max(0, first.length - got) * 1000 / rate > deadlineAt
        && Boolean(rescue?.claimStale?.());
    }

    // When playback needs a range, as a clock time; Infinity when the caller did not say.
    // options.deadlineAt is that time, options.deadlineMs the time left; either can be a
    // function, read again at every check, so a new playback rate or position also moves the
    // deadline of pieces already on their way.
    function deadlineOf(options) {
      const read = (value, relative) => {
        const ms = Number(value);
        if (value == null || !Number.isFinite(ms)) return Infinity;
        return relative ? performance.now() + Math.max(0, ms) : ms;
      };
      const live = (value, relative) => () => {
        try { return read(value(), relative); } catch (_error) { return Infinity; }
      };
      if (typeof options.deadlineAt === "function") return live(options.deadlineAt, false);
      if (options.deadlineAt != null && Number.isFinite(Number(options.deadlineAt))) {
        const fixed = Number(options.deadlineAt);
        return () => fixed;
      }
      if (typeof options.deadlineMs === "function") return live(options.deadlineMs, true);
      const fixed = read(options.deadlineMs, true);
      return () => fixed;
    }

    // Only measured per-request progress can spend this bounded rescue budget. The second
    // budget is for pieces that will miss their deadline while their copy's node is not
    // measured as HEDGE_FASTER times faster: that measurement can be stale, and a bounded
    // number of such copies per range is far cheaper than waiting for a timeout.
    function createEarlyHedge(limit) {
      return {
        progressRemaining: Math.max(0, limit),
        claimProgress() {
          if (this.progressRemaining <= 0) return false;
          this.progressRemaining -= 1;
          return true;
        },
        // At least one per range, even where no connection is held back (a single-piece
        // download): one request is much cheaper than waiting out a timeout.
        staleRemaining: Math.max(1, limit),
        claimStale() {
          if (this.staleRemaining <= 0) return false;
          this.staleRemaining -= 1;
          return true;
        }
      };
    }

    async function readBody(response, controller, transferId, settings, received, report = onTransfer) {
      if (!response.body?.getReader) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        received.bytes += bytes.byteLength;
        received.chunks?.push(bytes);
        if (settings.autoConcurrency) autoConcurrency.activity();
        report({ phase: "progress", id: transferId, bytes: bytes.byteLength });
        return bytes;
      }
      const reader = response.body.getReader();
      // Do not rely on fetch implementations to unblock read() after abort. A
      // pending reader must release its concurrency slot before a quality change.
      const cancelReader = () => { reader.cancel(controller.signal.reason).catch(() => {}); };
      controller.signal.addEventListener("abort", cancelReader, { once: true });
      if (controller.signal.aborted) cancelReader();
      const chunks = [];
      let total = 0;
      let stallTimer = null;
      const armStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => controller.abort(new DOMException("CDN 子块停止传输", "TimeoutError")), settings.stallTimeoutMs);
      };
      armStall();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) throw abortError(controller.signal.reason);
          if (done) break;
          armStall();
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          chunks.push(chunk);
          total += chunk.byteLength;
          received.bytes += chunk.byteLength;
          // The recorder keeps what a failed attempt already received, so a retry or a
          // hedge copy can ask only for the missing tail.
          received.chunks?.push(chunk);
          if (settings.autoConcurrency) autoConcurrency.activity();
          report({ phase: "progress", id: transferId, bytes: chunk.byteLength });
        }
      } finally {
        clearTimeout(stallTimer);
        controller.signal.removeEventListener("abort", cancelReader);
        reader.releaseLock?.();
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }

    // begin: called once the request has its connection slot, and returns what to ask for.
    // A copy that waited in the queue resumes from what the first copy has received by then,
    // not from what it had when the copy was queued.
    async function attempt(piece, url, signal, kind, resolver, priority = 0, begin = null,
      deadline = null, observeProgress = null, queueClass = QUEUE_CRITICAL) {
      const settings = config();
      const deadlineAt = deadline ? deadline() : Infinity;
      const release = await semaphore.acquire(signal, priority, deadlineAt, queueClass,
        queueClass === QUEUE_ORDINARY && Number.isFinite(deadlineAt), deadline);
      let received = { bytes: 0, chunks: [] };
      if (begin) {
        try {
          const plan = begin();
          piece = plan.part;
          received = plan.recorder;
        } catch (error) {
          release();
          throw error;
        }
      }
      const controller = new AbortController();
      const cancel = () => controller.abort(abortError(signal?.reason));
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
      const firstByteTimer = setTimeout(() => controller.abort(new DOMException("CDN 首字节超时", "TimeoutError")), settings.firstByteTimeoutMs);
      const totalTimer = setTimeout(() => controller.abort(new DOMException("CDN 子块总耗时超限", "TimeoutError")), settings.attemptTimeoutMs);
      const startedAt = performance.now();
      const report = event => {
        const elapsedMs = Math.max(1, performance.now() - startedAt);
        const bps = received.bytes * 1000 / elapsedMs;
        const remaining = Math.max(0, piece.length - received.bytes);
        const payload = { ...event, receivedBytes: received.bytes, totalBytes: piece.length,
          bps, etaMs: bps > 0 ? Math.round(remaining * 1000 / bps) : null };
        observeProgress?.({ ...payload, elapsedMs });
        return onTransfer(payload);
      };
      const transferId = report({ phase: "start", kind, totalBytes: piece.length, url,
        deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : null });
      try {
        const response = await nativeFetch(url, {
          method: "GET",
          headers: { Range: `bytes=${piece.start}-${piece.end}` },
          credentials: "omit",
          cache: "no-store",
          mode: "cors",
          referrer: root.location?.href,
          referrerPolicy: "strict-origin-when-cross-origin",
          priority: priority >= 100 ? "high" : "auto",
          signal: controller.signal
        });
        clearTimeout(firstByteTimer);
        const contentRange = core.parseContentRange(response.headers.get("content-range"));
        if (response.status !== 206 || !contentRange || contentRange.start !== piece.start || contentRange.end !== piece.end) {
          // The status tells a refused signed address (4xx) apart from a node that is down.
          throw Object.assign(new Error(`Range 校验失败：HTTP ${response.status}`), { status: response.status });
        }
        const bytes = await readBody(response, controller, transferId, settings, received, report);
        if (bytes.byteLength !== piece.length) throw new Error(`子块长度不符：${bytes.byteLength}/${piece.length}`);
        const elapsedMs = Math.max(1, performance.now() - startedAt);
        recordMeter(bytes.byteLength, elapsedMs);
        // The node answered either way; only a large enough transfer says how fast it is.
        resolver.success(url, bytes.byteLength >= SPEED_SAMPLE_MIN_BYTES ? bytes.byteLength * 1000 / elapsedMs : 0);
        report({ phase: "done", id: transferId });
        return { bytes, total: contentRange.total, url };
      } catch (error) {
        const canceled = error?.name === "AbortError";
        // A copy that lost the race was cut off, not broken, and what it had received by then
        // is a measurement of its node. Without it a slow node is never measured at all: its
        // pieces are always finished by a faster copy first, and an unmeasured node only ever
        // gets trial pieces.
        if (canceled && received.bytes >= SPEED_SAMPLE_MIN_BYTES && typeof resolver.sample === "function") {
          resolver.sample(url, received.bytes * 1000 / Math.max(1, performance.now() - startedAt));
        }
        // Received bytes tell a dead node (0 KiB) apart from a transfer that stalled midway.
        resolver.failure(url, error, received.bytes);
        if (settings.autoConcurrency) {
          if (error?.status === 412 || error?.status === 429) autoConcurrency.pushback(error.status);
          else if (!canceled && error?.name === "TimeoutError" && received.bytes === 0) autoConcurrency.slow();
        }
        report({ phase: canceled ? "cancel" : "error", id: transferId, error });
        throw error;
      } finally {
        clearTimeout(firstByteTimer);
        clearTimeout(totalTimer);
        // Invalid headers can reject before readBody obtains a reader. Stop that
        // response too, otherwise it keeps downloading after releasing the slot.
        controller.abort();
        signal?.removeEventListener("abort", cancel);
        release();
      }
    }

    function pause(delayMs, signal) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(done, delayMs);
        function done() {
          signal?.removeEventListener("abort", canceled);
          resolve();
        }
        function canceled() {
          clearTimeout(timer);
          reject(abortError(signal.reason));
        }
        if (signal?.aborted) canceled();
        else signal?.addEventListener("abort", canceled, { once: true });
      });
    }

    function pieceCandidates(piece, resolver, preferredUrls, round) {
      const preferred = Array.isArray(preferredUrls) ? preferredUrls : [];
      // The first preferred address is the node this piece was assigned to by speed;
      // only a retry round moves past it.
      const preferredOffset = preferred.length ? round % preferred.length : 0;
      const rotatedPreferred = preferred.slice(preferredOffset).concat(preferred.slice(0, preferredOffset));
      const rescue = (typeof resolver.rescueCandidates === "function" ? resolver.rescueCandidates() : resolver.ordered(piece.index))
        .filter((url) => !rotatedPreferred.includes(url));
      if (typeof resolver.speed === "function") {
        // The copies after the first go to the fastest known nodes, wherever they were
        // listed: a hedge that lands on the slowest node saves nothing.
        const rest = [...rotatedPreferred.slice(1), ...rescue]
          .sort((left, right) => resolver.speed(right) - resolver.speed(left));
        const candidates = rotatedPreferred.length ? [rotatedPreferred[0], ...rest] : rest;
        for (const url of resolver.ordered(piece.index)) {
          if (!candidates.includes(url)) candidates.push(url);
        }
        return candidates;
      }
      const candidates = [];
      const width = Math.max(rotatedPreferred.length, rescue.length);
      for (let index = 0; index < width; index += 1) {
        if (rotatedPreferred[index]) candidates.push(rotatedPreferred[index]);
        if (rescue[index]) candidates.push(rescue[index]);
      }
      for (const url of resolver.ordered(piece.index)) {
        if (!candidates.includes(url)) candidates.push(url);
      }
      return candidates;
    }

    async function downloadPiece(piece, resolver, signal, kind, preferredUrls, startupMode = false, priority = 0,
      deadline = null, earlyHedge = null) {
      const hasDeadline = Boolean(deadline) && Number.isFinite(deadline());
      const deadlineNow = () => (deadline ? deadline() : Infinity);
      const settings = config();
      const allowed = (url) => typeof resolver.allows !== "function" || resolver.allows(url);
      const startup = startupMode === true || startupMode === "probe";
      const probe = startupMode === "probe";
      const startedAt = performance.now();
      let lastError = null;

      // The longest contiguous run of bytes fetched from the front of this piece so far.
      // A retry or a hedge copy asks only for what is still missing and splices the two
      // halves, instead of downloading the whole piece again. Every kept byte came out
      // of a response whose 206 Content-Range was verified against this piece.
      let prefix = null;
      const keepProgress = (base, recorder) => {
        const bytes = (base?.bytes || 0) + recorder.bytes;
        if (bytes > (prefix?.bytes || 0) && bytes < piece.length) {
          prefix = { bytes, chunks: base ? [...base.chunks, ...recorder.chunks] : recorder.chunks.slice() };
        }
      };
      const liveProgress = (context) => {
        if (!context) return null;
        const chunks = context.recorder.chunks.slice();
        let bytes = context.base?.bytes || 0;
        for (const chunk of chunks) bytes += chunk.byteLength;
        return { bytes, chunks: context.base ? [...context.base.chunks, ...chunks] : chunks };
      };

      // Failing a piece ends acceleration for the whole video, and the list can be as short as
      // one working address. One slow reply must not decide that, so the list is walked again
      // after a pause; node health and bans have changed by then, so it is rebuilt each time.
      for (let round = 0; round < PIECE_ROUNDS; round += 1) {
        if (round) {
          if (performance.now() - startedAt > PIECE_RETRY_WINDOW_MS) break;
          await pause(roundPause(round), signal);
        }
        const candidates = pieceCandidates(piece, resolver, preferredUrls, round);
        const limit = Math.min(8, candidates.length);
        const batchWidth = probe ? limit : 2;
        const tried = new Set();
        while (tried.size < limit) {
          if (signal?.aborted) throw abortError(signal.reason);
          // A node banned while this piece was waiting is skipped, unless only banned nodes are left.
          const untried = candidates.filter((url) => !tried.has(url));
          const open = untried.filter(allowed);
          const pair = (open.length ? open : untried).slice(0, batchWidth);
          if (!pair.length) break;
          pair.forEach((url) => tried.add(url));
          const controllers = pair.map(() => new AbortController());
          const cancelAll = () => controllers.forEach((controller) => controller.abort(abortError(signal?.reason)));
          if (signal?.aborted) cancelAll();
          else signal?.addEventListener("abort", cancelAll, { once: true });
          // A first copy that is refused at once (HTTP 403) should not leave the piece idle
          // for the rest of the hedge delay.
          let firstFailed = () => {};
          const firstFailure = new Promise((resolve) => { firstFailed = resolve; });
          let firstStartedAt = 0, deadlineDeficitSamples = 0, firstBecameStraggler = () => {};
          const firstStraggler = new Promise((resolve) => { firstBecameStraggler = resolve; });
          const observeFirst = event => {
            if (!hasDeadline || event.phase !== "progress" || !Number.isFinite(event.etaMs)) return;
            const deadlineAt = deadlineNow();
            const missesDeadline = Number.isFinite(deadlineAt)
              && event.etaMs >= Math.max(0, deadlineAt - performance.now());
            const slowerThanPeers = meter.connectionBps > 0 && event.bps < meter.connectionBps * 0.5
              && event.etaMs >= 500;
            const remainingToDeadline = deadlineAt - performance.now();
            deadlineDeficitSamples = Number.isFinite(deadlineAt)
              && event.etaMs - remainingToDeadline >= 250
              ? deadlineDeficitSamples + 1
              : 0;
            // A clearly slow node is rescued immediately. If the whole route is slow,
            // two consecutive deficit samples may spend the same per-range rescue budget
            // (createEarlyHedge).
            if (Number.isFinite(deadlineAt)
              && ((missesDeadline && slowerThanPeers) || deadlineDeficitSamples >= 2)) {
              firstBecameStraggler();
            }
          };
          const contexts = [];
          const attempts = pair.map((url, pairIndex) => (async () => {
            if (pairIndex) await new Promise((resolve, reject) => {
              let timer = null, settled = false, earlyClaimed = false;
              const finish = (operation) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                controllers[pairIndex].signal.removeEventListener("abort", canceled);
                operation();
              };
              const measured = hedgeDelayMs(settings);
              const delay = probe ? 0 : startup
                ? Math.min(hasDeadline ? 200 : 250, measured)
                : measured;
              const copyBps = () => (typeof resolver.speed === "function" ? resolver.speed(url) || 0 : 0);
              // A playback-deadline request decides once its first copy has a connection (see
              // hedgeDue); one without a deadline (compatibility mode, the desktop client)
              // keeps the fixed hedge delay (hedgeDelayMs), counted from the moment the piece
              // asked, queue time included.
              const check = () => {
                if (settled) return;
                if (contexts[0] && hedgeDue(contexts[0], delay, deadlineNow(), copyBps(), earlyHedge)) return finish(resolve);
                timer = setTimeout(check, 50);
              };
              if (hasDeadline && !probe) timer = setTimeout(check, 0);
              else timer = setTimeout(() => finish(resolve), delay);
              firstStraggler.then(() => {
                if (settled || probe || earlyClaimed || !earlyHedge?.claimProgress?.()) return;
                earlyClaimed = true;
                if (timer) clearTimeout(timer);
                const grace = Math.max(0, 250 - (performance.now() - firstStartedAt));
                timer = setTimeout(() => finish(resolve), grace);
              });
              firstFailure.then(() => finish(resolve));
              const canceled = () => {
                finish(() => reject(abortError(controllers[pairIndex].signal.reason)));
              };
              if (controllers[pairIndex].signal.aborted) canceled();
              else controllers[pairIndex].signal.addEventListener("abort", canceled, { once: true });
            });
            // Resume from the longest prefix known when the request really starts: an earlier
            // failed attempt, or what the still-running first copy has received by then.
            let base = null;
            const recorder = { bytes: 0, chunks: [] };
            const begin = () => {
              if (!pairIndex) firstStartedAt = performance.now();
              base = prefix && prefix.bytes >= RESUME_MIN_BYTES ? prefix : null;
              if (pairIndex) {
                const live = liveProgress(contexts[0]);
                if (live && live.bytes >= RESUME_MIN_BYTES && live.bytes > (base?.bytes || 0)) base = live;
              }
              if (base && base.bytes >= piece.length) base = null;
              const startedAt = performance.now();
              contexts[pairIndex] = { base, recorder, startedAt, seenBytes: 0, seenAt: startedAt, length: piece.length - (base?.bytes || 0) };
              return {
                recorder,
                part: base
                  ? { index: piece.index, start: piece.start + base.bytes, end: piece.end, length: piece.length - base.bytes }
                  : piece
              };
            };
            try {
              const result = await attempt(piece, url, controllers[pairIndex].signal, kind, resolver,
                priority + (pairIndex ? 20 : 0), begin, deadline, pairIndex ? null : observeFirst,
                probe ? QUEUE_CRITICAL : startup ? QUEUE_STARTUP : QUEUE_ORDINARY);
              return base
                ? { bytes: core.concatChunks([...base.chunks, result.bytes], piece.length), total: result.total, url: result.url }
                : result;
            } catch (error) {
              keepProgress(base, recorder);
              if (!pairIndex) firstFailed();
              throw error;
            }
          })());
          try {
            const winner = await Promise.any(attempts);
            controllers.forEach((controller) => {
              if (!controller.signal.aborted) controller.abort(new DOMException("并发副本已取消", "AbortError"));
            });
            if (settings.autoConcurrency) autoConcurrency.delivered(piece.length);
            return winner;
          } catch (aggregate) {
            lastError = aggregate?.errors?.at?.(-1) || aggregate;
            if (signal?.aborted) throw abortError(signal.reason);
          } finally {
            signal?.removeEventListener("abort", cancelAll);
          }
        }
      }
      throw lastError || new Error("没有可用 CDN");
    }

    async function delayedAttempt(piece, url, delayMs, signal, kind, resolver, controller, priority = 0) {
      if (delayMs > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          const canceled = () => {
            clearTimeout(timer);
            reject(abortError(controller.signal.reason));
          };
          if (controller.signal.aborted) canceled();
          else controller.signal.addEventListener("abort", canceled, { once: true });
        });
      }
      if (signal?.aborted) throw abortError(signal.reason);
      return attempt(piece, url, controller.signal, kind, resolver, priority);
    }

    async function startupAttempt(piece, candidates, resolver, options) {
      const controllers = candidates.map(() => new AbortController());
      const cancelAll = () => controllers.forEach((controller) => {
        if (!controller.signal.aborted) controller.abort(abortError(options.signal?.reason));
      });
      if (options.signal?.aborted) cancelAll();
      else options.signal?.addEventListener("abort", cancelAll, { once: true });
      try {
        let winner;
        try {
          winner = await Promise.any(candidates.map((url, index) => delayedAttempt(
            piece,
            url,
            index === 0 ? 0 : index === 1 ? 120 : 300,
            options.signal,
            options.kind || "meta",
            resolver,
            controllers[index],
            220
          )));
        } catch (aggregate) {
          if (options.signal?.aborted) throw abortError(options.signal.reason);
          throw aggregate?.errors?.at?.(-1) || aggregate;
        }
        controllers.forEach((controller) => {
          if (!controller.signal.aborted) controller.abort(new DOMException("并发副本已取消", "AbortError"));
        });
        return winner;
      } finally {
        options.signal?.removeEventListener("abort", cancelAll);
      }
    }

    // Which address each piece tries first. The fastest node gets the most pieces, and a node
    // measured at under a twelfth of the best is left out entirely: a piece it starts has to
    // be rescued anyway. Its measurement goes stale after a while, and the resolver's
    // exploration slot then gives it, like any untested node, another try.
    let assignTurn = 0;
    // Trials are counted per resolver: the video and the audio track take turns on this
    // downloader, and one shared count could leave a track without a trial for good.
    const trialStates = new WeakMap();
    function assignPrimaries(urls, resolver, count) {
      if (!urls.length || count <= 0) return [];
      if (urls.length === 1) return new Array(count).fill(urls[0]);
      // Each range opens one node further on, so ranges in flight together do not all
      // send their first pieces to the same node.
      const turn = assignTurn;
      assignTurn = (assignTurn + 1) % 4096;
      const measure = typeof resolver.speed === "function" ? (url) => Math.max(0, Number(resolver.speed(url)) || 0) : () => 0;
      let known = urls.map(measure);
      const positive = known.filter((value) => value > 0);
      if (!positive.length) return Array.from({ length: count }, (_ignored, index) => urls[(index + turn) % urls.length]);
      const top = Math.max(...known);
      const eligible = urls.filter((_url, index) => !known[index] || known[index] >= top / 12);
      if (eligible.length && eligible.length < urls.length) {
        urls = eligible;
        known = urls.map(measure);
      }
      // A node without a measurement is a trial. It gets a piece or two from the end of the
      // range, which are needed last and may take longest, enough to measure it and cheap
      // when it turns out to be slow. With very few pieces there is none to spare.
      const unknown = urls.filter((_url, index) => !known[index]);
      let trials = Math.min(unknown.length * 2, Math.floor(count / 4));
      let trialState = trialStates.get(resolver);
      if (!trialState) trialStates.set(resolver, trialState = { waited: 0, cursor: 0 });
      // Small segments never have a piece to spare, and a node left out for being slow would
      // stay unmeasured for good. Every fourth such range gives up its last piece for a trial.
      if (!trials && unknown.length && count >= 2) {
        trialState.waited += 1;
        if (trialState.waited >= 4) trials = 1;
      }
      if (trials) trialState.waited = 0;
      if (unknown.length) {
        urls = urls.filter((_url, index) => known[index]);
        known = urls.map(measure);
        count -= trials;
      }
      const weights = known.map((value) => Math.max(value, top * 0.05));
      const total = weights.reduce((sum, value) => sum + value, 0);
      // Handed out in turns (smooth weighted round-robin), not in one block per node. The
      // pieces with the lowest numbers get the free connections first, and the player has
      // several segments in flight: with blocks, every segment's first pieces went to the
      // same node and the others sat idle.
      const primaries = [];
      const credit = weights.map(() => 0);
      const order = urls.map((_url, index) => (index + turn) % urls.length);
      for (let index = 0; index < count; index += 1) {
        let best = order[0];
        for (const urlIndex of order) {
          credit[urlIndex] += weights[urlIndex];
          if (credit[urlIndex] > credit[best]) best = urlIndex;
        }
        credit[best] -= total;
        primaries.push(urls[best]);
      }
      for (let index = 0; index < trials; index += 1) primaries.push(unknown[(index + trialState.cursor) % unknown.length]);
      trialState.cursor = (trialState.cursor + trials) % 4096;
      return primaries;
    }

    function preferredFor(primary, urls) {
      return primary ? [primary, ...urls.filter((url) => url !== primary)] : urls;
    }

    // Hands the finished pieces to onOrderedChunk in order: each one as soon as every piece
    // before it has been handed over. done() waits for what has been handed over so far.
    function orderedDelivery(pieces, onOrderedChunk) {
      const ordered = new Array(pieces.length);
      let next = 0;
      let operation = Promise.resolve();
      return {
        add(index, result) {
          ordered[index] = result;
          operation = operation.then(async () => {
            while (ordered[next]) {
              const item = ordered[next];
              ordered[next] = null;
              await onOrderedChunk(item.bytes, pieces[next], item.total);
              next += 1;
            }
          });
          return operation;
        },
        done: () => operation
      };
    }

    async function downloadStartupRange(range, resolver, options) {
      semaphore.setLimit(config().concurrency);
      const piece = { index: 0, start: range.start, end: range.end, length: range.length };
      const startedAt = performance.now();
      let lastError = null;
      // The addresses that just failed are backing off by the next round, so each round
      // moves on to the next three.
      for (let round = 0; round < PIECE_ROUNDS; round += 1) {
        if (round) {
          if (performance.now() - startedAt > PIECE_RETRY_WINDOW_MS) break;
          await pause(roundPause(round), options.signal);
        }
        let candidates = (typeof resolver.startupCandidates === "function" ? resolver.startupCandidates() : resolver.urls())
          .filter((url, index, all) => all.indexOf(url) === index)
          .slice(0, 3);
        if (!candidates.length && round) candidates = resolver.ordered(round).slice(0, 3);
        if (!candidates.length) break;
        try {
          const winner = await startupAttempt(piece, candidates, resolver, options);
          return {
            bytes: winner.bytes,
            pieceCount: 1,
            total: winner.total || null,
            hosts: [new URL(winner.url).hostname]
          };
        } catch (error) {
          if (options.signal?.aborted) throw abortError(options.signal.reason);
          lastError = error;
        }
      }
      throw lastError || new Error("没有可用 CDN");
    }

    async function downloadStartupMediaRange(range, resolver, options, settings) {
      const effectiveConcurrency = settings.concurrency;
      semaphore.setLimit(effectiveConcurrency);
      const candidateUrls = (typeof resolver.rangeCandidates === "function" ? resolver.rangeCandidates() : resolver.urls())
        .filter((url, index, all) => all.indexOf(url) === index);
      const headLength = Math.min(range.length, Math.max(64 * 1024, settings.minChunkBytes));
      const head = {
        index: 0,
        start: range.start,
        end: range.start + headLength - 1,
        length: headLength
      };
      const headResult = await downloadPiece(
        head,
        resolver,
        options.signal,
        options.kind || "media",
        candidateUrls,
        "probe",
        220,
        options.deadline
      );
      await options.onOrderedChunk(headResult.bytes, head, headResult.total);
      if (head.end >= range.end) {
        options.onStartupScheduled?.();
        return {
          bytes: null,
          byteLength: range.length,
          pieceCount: 1,
          streamed: true,
          total: headResult.total || null,
          hosts: [new URL(headResult.url).hostname]
        };
      }

      const rescueReserve = Math.max(1, Math.min(16, Math.ceil(effectiveConcurrency / 8)));
      const mediaBudget = Math.max(1, effectiveConcurrency - rescueReserve);
      const audioBudget = Math.max(1, Math.min(mediaBudget, Math.ceil(effectiveConcurrency / 8)));
      const pieceBudget = options.kind === "audio"
        ? audioBudget
        : Math.max(1, mediaBudget - audioBudget);
      const pieces = core.splitRange(
        head.end + 1,
        range.end,
        pieceBudget,
        adaptiveMinChunk(settings, range.end - head.end, pieceBudget, candidateUrls.length)
      ).map((piece, index) => ({ ...piece, index: index + 1 }));
      const delivery = orderedDelivery(pieces, options.onOrderedChunk);
      // The probe measured at least its own winner, so the pieces spread over the nodes by
      // speed at once; the proven address is among each piece's fallbacks, which
      // pieceCandidates orders by measured speed. Only the probe's winner and nodes with a
      // speed measurement carry the first segment: a node whose probe never finished would
      // otherwise get a share of it and hold up the start. The others stay available for
      // rescue, and later ranges try them.
      const measured = typeof resolver.speed === "function" ? (url) => resolver.speed(url) > 0 : () => false;
      const provenUrls = candidateUrls.filter((url) => url === headResult.url || measured(url));
      const primaries = assignPrimaries(provenUrls.length ? provenUrls : [headResult.url], resolver, pieces.length);
      const earlyHedge = createEarlyHedge(rescueReserve);
      const pendingPieces = pieces.map(async (piece, orderedIndex) => {
        const result = await downloadPiece(
          piece,
          resolver,
          options.signal,
          options.kind || "media",
          preferredFor(primaries[orderedIndex], [headResult.url, ...candidateUrls.filter((url) => url !== headResult.url)]),
          true,
          120 - Math.min(30, piece.index),
          options.deadline,
          earlyHedge
        );
        await delivery.add(orderedIndex, result);
        return result;
      });
      options.onStartupScheduled?.();
      const results = await Promise.all(pendingPieces);
      await delivery.done();
      const totals = [headResult, ...results].map((item) => item.total).filter(Number.isSafeInteger);
      if (totals.length && totals.some((value) => value !== totals[0])) throw new Error("不同 CDN 返回的文件总长度不一致");
      return {
        bytes: null,
        byteLength: range.length,
        pieceCount: pieces.length + 1,
        streamed: true,
        total: totals[0] || null,
        hosts: [...new Set([headResult, ...results].map((item) => new URL(item.url).hostname))]
      };
    }

    async function downloadRange(range, resolver, options = {}) {
      const settings = config();
      if (options.kind === "meta") return downloadStartupRange(range, resolver, options);
      // One deadline for the whole range, resolved at its boundary: every piece, including work
      // scheduled after the startup probe, refers to the same playback instant.
      const deadline = deadlineOf(options);
      const parallel = options.parallel !== false;
      if (options.startup === true && parallel && typeof options.onOrderedChunk === "function") {
        return downloadStartupMediaRange(range, resolver, { ...options, deadline }, settings);
      }
      const preferredUrls = parallel && typeof resolver.rangeCandidates === "function"
        ? resolver.rangeCandidates()
        : resolver.urls();
      const globalConcurrency = parallel ? settings.concurrency : 1;
      const requestedConcurrency = Number.isFinite(Number(options.maxConcurrency))
        ? Math.max(1, Math.trunc(Number(options.maxConcurrency)))
        : globalConcurrency;
      const effectiveConcurrency = parallel ? Math.min(globalConcurrency, requestedConcurrency) : 1;
      // Fewer primary pieces than slots is not a hard-reserved connection: it gives a
      // stalled piece's hedge/retry room to start immediately while the other primaries run.
      semaphore.setLimit(globalConcurrency);
      const basePriority = Number.isFinite(Number(options.priority)) ? Number(options.priority) : 50;
      const rescueReserve = parallel && effectiveConcurrency >= 8
        ? Math.min(8, Math.max(1, Math.ceil(effectiveConcurrency / 8)))
        : 0;
      const pieceConcurrency = options.startup === true
        ? Math.max(1, Math.min(22, effectiveConcurrency))
        : Math.max(1, effectiveConcurrency - rescueReserve);
      const pieces = core.splitRange(
        range.start,
        range.end,
        pieceConcurrency,
        parallel ? adaptiveMinChunk(settings, range.length, pieceConcurrency, preferredUrls.length) : Number.MAX_SAFE_INTEGER
      );
      const primaries = parallel ? assignPrimaries(preferredUrls, resolver, pieces.length) : [];
      const earlyHedge = createEarlyHedge(rescueReserve);
      const progressive = typeof options.onOrderedChunk === "function";
      const delivery = orderedDelivery(pieces, options.onOrderedChunk);
      const results = await Promise.all(pieces.map(async (piece) => {
        const result = await downloadPiece(
          piece,
          resolver,
          options.signal,
          options.kind || "media",
          preferredFor(primaries[piece.index], preferredUrls),
          options.startup === true,
          basePriority - Math.min(20, piece.index),
          deadline,
          earlyHedge
        );
        if (progressive) await delivery.add(piece.index, result);
        return result;
      }));
      if (progressive) await delivery.done();
      const totals = results.map((item) => item.total).filter(Number.isSafeInteger);
      if (totals.length && totals.some((value) => value !== totals[0])) throw new Error("不同 CDN 返回的文件总长度不一致");
      return {
        bytes: progressive ? null : core.concatChunks(results.map((item) => item.bytes), range.length),
        byteLength: range.length,
        pieceCount: pieces.length,
        streamed: progressive,
        total: totals[0] || null,
        hosts: [...new Set(results.map((item) => new URL(item.url).hostname))]
      };
    }

    return Object.freeze({ downloadRange, applySettings, getConcurrency: () => semaphore.limit });
  }

  root.__BILI_IDM_DOWNLOADER_FACTORY__ = Object.freeze({ createDownloader, createAutoConcurrency, autoConcurrency });
})(globalThis);

/* src/native-mse-player.js */
(function installNativeMsePlayer(root) {
  "use strict";

  const core = root.__BILI_RANGE_CORE__;
  const sidxTools = root.__BILI_SIDX__;
  const resolverFactory = root.__BILI_CDN_RESOLVER_FACTORY__;
  const downloaderFactory = root.__BILI_IDM_DOWNLOADER_FACTORY__;
  if (!core || !sidxTools || !resolverFactory || !downloaderFactory || !root.MediaSource) return;

  const STARTUP_BUFFER_MIN_SECONDS = 2.5;
  const STARTUP_BUFFER_MAX_SECONDS = 10;
  const STARTUP_RECOVERY_SECONDS = 6;
  const NATIVE_UI_BUFFER_SECONDS = 10;
  const NATIVE_UI_WAIT_MS = 45000;
  const STARTUP_PROTECTION_MS = 20000;
  // How long a wait for data reads as playing to the page (see readsAsPlaying).
  const HOLD_SHOWN_AS_PLAYING_MS = 1500;
  // A pause() made during a wait this close before Bilibili's player puts its own source in
  // place belongs to that switch (see sourceObserver): its reset pauses and changes the source
  // in one go. A pause the viewer pressed this close before an unrelated switch counts as the
  // switch's too.
  const SWITCH_PAUSE_MS = 300;
  // When the browser's buffer quota is hit: the forward buffer is never brought below the
  // floor, and a full buffer with less than this ahead is a failure, not something to wait out.
  const QUOTA_AHEAD_FLOOR_SECONDS = 8;
  const QUOTA_FATAL_AHEAD_SECONDS = 10;
  // A session that finds its buffer full more than this many times (since it started or
  // last seeked, both tracks together) is given up after all.
  const QUOTA_MAX_WAITS = 8;
  // 二级缓冲: segments the browser's buffer has no room for wait in memory, at most this much
  // for both tracks together; 64 MB for each GB the browser reports, 4 GB when it reports none.
  const RESERVE_MAX_MB = 512;
  const RESERVE_MB_PER_GB = 64;
  const reserveLimitBytes = () => Math.min(RESERVE_MAX_MB, (Number(root.navigator?.deviceMemory) || 4) * RESERVE_MB_PER_GB) * 1024 * 1024;

  function playbackDeadlineAt(segmentStart, currentTime, playbackRate, now = performance.now()) {
    const rate = Math.max(0.25, Math.abs(Number(playbackRate) || 1));
    return now + Math.max(0, (Number(segmentStart) - Number(currentTime)) * 1000 / rate);
  }

  // Bilibili's core keeps the position it saved when it last reloaded its own source (a
  // quality switch, or the retry it makes once BTR replaced the source) and seeks back to
  // it every time the element reports new metadata, until the video ends or the page
  // moves on. Every BTR session starts with new metadata, so after one such reload every
  // drag of the progress bar (each one then started a new session) and every quality switch
  // ended up back at that old position.
  // The moment of its last reload is known here, so its seek can be told from a viewer's
  // and undone. Kept across players: the retake after a fallback is a new player.
  let nativeRestore = { key: "", time: 0 };
  function rememberNativeRestore(key, time) {
    if (Number(time) >= 1) nativeRestore = { key, time: Number(time) };
  }
  const QUALITY_NAMES = Object.freeze({
    127: "8K", 126: "杜比视界", 125: "HDR", 120: "4K", 116: "1080P 60帧",
    112: "1080P 高码率", 80: "1080P", 74: "720P 60帧", 64: "720P",
    32: "480P", 16: "360P", 6: "240P"
  });

  function dashBody(playinfo) {
    return playinfo?.data?.dash ? playinfo.data : playinfo?.result?.dash ? playinfo.result : playinfo;
  }

  function mimeFor(representation, fallbackKind) {
    const mime = representation?.mimeType || representation?.mime_type || `${fallbackKind}/mp4`;
    const codecs = representation?.codecs || representation?.codec;
    return codecs ? `${mime}; codecs="${codecs}"` : mime;
  }

  function frameRate(representation) {
    const raw = String(representation?.frameRate || representation?.frame_rate || "0");
    if (!raw.includes("/")) return Number(raw) || 0;
    const [top, bottom] = raw.split("/").map(Number);
    return bottom ? top / bottom : 0;
  }

  function codecFamily(representation) {
    const codec = String(representation?.codecs || representation?.codec || "").toLowerCase();
    const codecId = Number(representation?.codecid || representation?.codec_id);
    if (codec.startsWith("av01") || codecId === 13) return "av1";
    if (codec.startsWith("hev1") || codec.startsWith("hvc1") || codecId === 12) return "hevc";
    if (codec.startsWith("avc1") || codecId === 7) return "avc";
    return "other";
  }

  function normalizeCodec(value) {
    return ["av1", "hevc", "avc"].includes(value) ? value : "";
  }

  // The audio picked in the player: 0 the ordinary track, 1 杜比全景声, 2 Hi-Res 无损
  // (Bilibili's own numbering, the newA of player.getQuality()).
  function normalizeAudio(value) {
    const audio = Math.trunc(Number(value)) || 0;
    return audio === 1 || audio === 2 ? audio : 0;
  }

  // "默认" in the player's 播放策略 menu keeps AV1 > HEVC > AVC. A codec picked there comes
  // first; a quality that does not have it falls back to that order.
  function codecPriority(representation, preferredCodec = "") {
    const family = codecFamily(representation);
    if (preferredCodec && family === preferredCodec) return 4;
    return { av1: 3, hevc: 2, avc: 1, other: 0 }[family] || 0;
  }

  function qualityLabel(representation) {
    const id = Number(representation?.id);
    const fps = frameRate(representation);
    if (QUALITY_NAMES[id]) {
      const label = QUALITY_NAMES[id];
      return fps >= 50 && !label.includes("60帧") && [120, 80, 64, 32, 16].includes(id)
        ? `${label} ${Math.round(fps)}帧`
        : label;
    }
    const height = Number(representation?.height) || 0;
    const label = height >= 2160 ? "4K" : height ? `${height}P` : `清晰度 ${id || "?"}`;
    return fps >= 50 ? `${label} ${Math.round(fps)}帧` : label;
  }

  function supported(representation, kind) {
    try { return MediaSource.isTypeSupported(mimeFor(representation, kind)); }
    catch (_error) { return false; }
  }

  // The height of each quality, for a quality this browser cannot play in the codecs given.
  const QUALITY_HEIGHTS = Object.freeze({ 127: 4320, 126: 2160, 125: 2160, 120: 2160, 116: 1080, 112: 1080, 80: 1080, 74: 720, 64: 720, 32: 480, 16: 360, 6: 240 });

  // preferredQuality is the quality chosen in the native menu, 0 for 自动. In 自动 the menu shows
  // the quality the native player picked itself (autoQuality, its realQ); the playinfo only
  // names the one it was asked for, which the native player soon leaves (#69). Without it the
  // quality already playing (currentId) stays, then the playinfo's own. preferredCodec is the
  // codec chosen there, "" for "默认". preferredAudio is the audio chosen there (see
  // normalizeAudio).
  function selectRepresentations(playinfo, preferredQuality = 0, preferredCodec = "", preferredAudio = 0, autoQuality = 0, currentId = 0) {
    const body = dashBody(playinfo);
    const dash = body?.dash;
    if (!dash) throw new Error("页面没有 DASH 播放清单");
    const codec = normalizeCodec(preferredCodec);
    const byQuality = new Map();
    for (const representation of (dash.video || []).filter((item) => supported(item, "video"))) {
      const key = Number(representation.id) || `${Number(representation.height) || 0}-${Math.round(frameRate(representation))}`;
      const existing = byQuality.get(key);
      if (!existing || codecPriority(representation, codec) > codecPriority(existing, codec) ||
          (codecPriority(representation, codec) === codecPriority(existing, codec) && (Number(representation.bandwidth) || 0) > (Number(existing.bandwidth) || 0))) {
        byQuality.set(key, representation);
      }
    }
    const videos = Array.from(byQuality.values()).sort((a, b) =>
      (Number(b.height) || 0) - (Number(a.height) || 0) || frameRate(b) - frameRate(a) ||
      (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0));
    // Dolby and Hi-Res sources keep their tracks in dash.dolby.audio / dash.flac.audio;
    // some of them have nothing in dash.audio at all, which used to fail the takeover.
    // The track picked in the player comes first when this browser can play it; otherwise
    // the ordinary track, like the native player's default.
    const audioOf = (list) => [].concat(list || []).filter((item) => supported(item, "audio"))
      .sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0))[0];
    const picked = { 1: dash.dolby?.audio, 2: dash.flac?.audio }[normalizeAudio(preferredAudio)];
    const audio = audioOf(picked) || audioOf(dash.audio) || audioOf(dash.flac?.audio) || audioOf(dash.dolby?.audio);
    if (!videos.length || !audio) throw new Error("浏览器不支持清单中的视频或音频编码");
    const requestedQuality = Number(body?.quality || body?.qn) || 0;
    const byId = (quality) => (quality ? videos.find((item) => Number(item.id) === quality) : null);
    const chosen = Number(preferredQuality) || 0;
    const shown = chosen ? 0 : Number(autoQuality) || 0;
    // The quality shown, or the best this browser plays at or below its height.
    const shownHeight = shown ? Number((dash.video || []).find((item) => Number(item.id) === shown)?.height) || QUALITY_HEIGHTS[shown] || 0 : 0;
    const preferred = byId(chosen)
      || byId(shown)
      || (shownHeight ? videos.find((item) => (Number(item.height) || 0) <= shownHeight) : null)
      || (!chosen && !shown ? byId(Number(currentId) || 0) : null)
      || byId(requestedQuality)
      || videos.find((item) => (Number(item.height) || 0) <= 2160)
      || videos[0];
    return { audio, dash, preferred, videos };
  }

  function representationUrl(representation) {
    return String(representation?.baseUrl || representation?.base_url || "");
  }

  // The file without its node and signature: a refreshed playinfo names the same file again.
  function representationPath(representation) {
    try { return new URL(representationUrl(representation)).pathname; }
    catch (_error) { return representationUrl(representation); }
  }

  function sameRepresentation(left, right) {
    return Number(left?.id) === Number(right?.id)
      && codecFamily(left) === codecFamily(right)
      && representationPath(left) === representationPath(right);
  }

  function segmentBase(representation) {
    const base = representation?.segment_base || representation?.segmentBase || representation?.SegmentBase || {};
    const init = core.parseByteRange(base.initialization || base.Initialization || base.initialization_range);
    const index = core.parseByteRange(base.index_range || base.indexRange || base.IndexRange);
    if (!init || !index) throw new Error("播放清单缺少初始化或 SIDX 字节范围");
    return { init, index };
  }

  function waitEvent(target, successName, errorName = "error", signal = null) {
    return new Promise((resolve, reject) => {
      const abortReason = () => signal?.reason instanceof Error
        ? signal.reason
        : new DOMException("播放任务已取消", "AbortError");
      const success = () => { cleanup(); resolve(); };
      const failure = () => { cleanup(); reject(new Error(`${successName} 失败`)); };
      const aborted = () => { cleanup(); reject(abortReason()); };
      const cleanup = () => {
        target.removeEventListener(successName, success);
        target.removeEventListener(errorName, failure);
        signal?.removeEventListener("abort", aborted);
      };
      if (signal?.aborted) {
        reject(abortReason());
        return;
      }
      target.addEventListener(successName, success, { once: true });
      target.addEventListener(errorName, failure, { once: true });
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  function isBufferedAt(sourceBuffer, time) {
    let ranges;
    try { ranges = sourceBuffer?.buffered; }
    catch (_error) { return false; }
    if (!ranges) return false;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) <= time + 0.25 && ranges.end(index) >= time - 0.25) return true;
    }
    return false;
  }

  function bufferedEndAt(sourceBuffer, time) {
    let ranges;
    try { ranges = sourceBuffer?.buffered; }
    catch (_error) { return time; }
    if (!ranges) return time;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) <= time + 0.25 && ranges.end(index) >= time - 0.25) return ranges.end(index);
    }
    return time;
  }

  function bufferedStart(sourceBuffer, fallback) {
    try { return sourceBuffer.buffered.length ? sourceBuffer.buffered.start(0) : fallback; }
    catch (_error) { return fallback; }
  }

  function kbpsAhead(track, from, seconds = 30) {
    let bytes = 0, duration = 0;
    for (const segment of track?.sidx?.segments || []) {
      if (segment.endTime <= from) continue;
      if (segment.startTime >= from + seconds) break;
      bytes += Number(segment.length) || 0;
      duration += Number(segment.durationSeconds) || 0;
    }
    return duration > 0 ? Math.round(bytes * 8 / duration / 1000) : 0;
  }

  function mediaBytesPerSecond(track) {
    const segment = track?.sidx?.segments?.[track.startupIndex];
    if (segment?.durationSeconds > 0 && segment?.length > 0) return segment.length / segment.durationSeconds;
    return Math.max(0, Number(track?.representation?.bandwidth) || 0) / 8;
  }

  // While BTR plays the video, Bilibili's own core keeps timers that read its SourceBuffers,
  // which detached from their MediaSource when the takeover replaced the element's source.
  // HDR and 8K sources poll especially often, and every read throws InvalidStateError into
  // the page's error reporting. While a takeover is active, such a read answers with an
  // empty range instead; without one the browser behaves as before.
  let bufferedShimInstalled = false;
  const ownSourceBuffers = new WeakSet();
  function installBufferedShim() {
    if (bufferedShimInstalled || !root.SourceBuffer) return;
    const descriptor = Object.getOwnPropertyDescriptor(root.SourceBuffer.prototype, "buffered");
    if (!descriptor?.get || !descriptor.configurable) return;
    bufferedShimInstalled = true;
    const emptyRanges = Object.freeze({
      length: 0,
      start() { throw new DOMException("空的缓冲区间", "IndexSizeError"); },
      end() { throw new DOMException("空的缓冲区间", "IndexSizeError"); }
    });
    Object.defineProperty(root.SourceBuffer.prototype, "buffered", {
      ...descriptor,
      get() {
        try {
          return descriptor.get.call(this);
        } catch (error) {
          if (error?.name === "InvalidStateError" && !ownSourceBuffers.has(this) && document.querySelector('[data-btr-mse-active="true"]')) return emptyRanges;
          throw error;
        }
      }
    });
  }

  // Bilibili's core keeps its own element listeners while BTR plays, and they run against
  // state it never finished initializing: its seek handler reads DVRWindow off a
  // representation info it only fills once its own stream starts, and its buffer checks read
  // 'updating' off a SourceBuffer that left its MediaSource. Both throw into the page on every
  // drag, where its own error reporter picks them up. While a takeover is active these two are
  // swallowed and counted for the diagnostic report; every other error, and every error while
  // Bilibili itself plays, is left untouched.
  const nativeLeftovers = { suppressed: 0, last: "" };
  const NATIVE_LEFTOVER_RE = /DVRWindow|reading '?updating'?/;
  let leftoverGuardInstalled = false;
  function installNativeErrorGuard() {
    if (leftoverGuardInstalled || typeof root.addEventListener !== "function") return;
    leftoverGuardInstalled = true;
    root.addEventListener("error", (event) => {
      if (!NATIVE_LEFTOVER_RE.test(String(event.message || ""))) return;
      let source = null;
      try { source = new URL(String(event.filename || "")); } catch (_error) { return; }
      if (!/(^|\.)hdslb\.com$/i.test(source.hostname) || !/\/player\//i.test(source.pathname)) return;
      if (!document.querySelector('[data-btr-mse-active="true"]')) return;
      nativeLeftovers.suppressed += 1;
      nativeLeftovers.last = String(event.message || "").slice(0, 120);
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  // Bilibili's player attaches its own MediaSource to the element and creates its source
  // buffers a moment after it opens. A takeover that replaced the element's source in
  // between closed that MediaSource under it, so its addSourceBuffer threw, and Bilibili took
  // that for "this browser cannot play the codec" (#29): it stopped using HEVC in the whole
  // tab, so 杜比视界 and HDR vanished from the quality menu, it stopped offering Hi-Res and
  // Dolby audio on the page, and it restarted at a lower quality. The page's MediaSources
  // are remembered by their object URL, and a takeover waits while the element holds one
  // that is open without its buffers.
  const pageMediaSources = new Map();
  const ownMediaSources = new WeakSet();
  const NATIVE_SOURCE_WAIT_MS = 1000;
  let mediaSourceWatchInstalled = false;
  function installMediaSourceWatch() {
    if (mediaSourceWatchInstalled || typeof root.URL?.createObjectURL !== "function") return;
    mediaSourceWatchInstalled = true;
    const createObjectURL = root.URL.createObjectURL;
    root.URL.createObjectURL = function (object) {
      const url = createObjectURL.apply(this, arguments);
      if (object instanceof root.MediaSource) {
        pageMediaSources.set(url, object);
        if (pageMediaSources.size > 16) pageMediaSources.delete(pageMediaSources.keys().next().value);
      }
      return url;
    };
  }

  // Resolves once Bilibili's MediaSource on the element has its buffers, has closed, or after
  // a second at most. null when there is nothing to wait for.
  function nativeSourceSettled(video) {
    const source = (video.srcObject instanceof root.MediaSource ? video.srcObject : null)
      || pageMediaSources.get(video.src) || pageMediaSources.get(video.currentSrc);
    if (!source || ownMediaSources.has(source) || source.readyState !== "open" || source.sourceBuffers.length >= 2) return null;
    return new Promise((resolve) => {
      let grace = null;
      const done = () => {
        clearTimeout(limit);
        clearTimeout(grace);
        source.sourceBuffers.removeEventListener("addsourcebuffer", added);
        source.removeEventListener("sourceclose", done);
        source.removeEventListener("sourceended", done);
        resolve();
      };
      // Video and audio are added one right after the other; a source with a single track
      // only costs the short grace period.
      const added = () => {
        if (source.sourceBuffers.length >= 2) done();
        else if (!grace) grace = setTimeout(done, 150);
      };
      const limit = setTimeout(done, NATIVE_SOURCE_WAIT_MS);
      source.sourceBuffers.addEventListener("addsourcebuffer", added);
      source.addEventListener("sourceclose", done);
      source.addEventListener("sourceended", done);
    });
  }

  // Should Bilibili still record a codec failure while BTR plays, the failure is about BTR's
  // takeover and not about the browser, yet it would keep HEVC and the Hi-Res / Dolby tracks
  // off for the rest of the tab (sessionStorage) or, when its server asks for it, for days
  // (localStorage). While a takeover is active those records are not written.
  const CODEC_FAILURE_KEYS = new Set(["enableHEVCError", "enableAV1Error", "decodeHEVCError", "decodeAV1Error", "bilibili_decode_error_obj"]);
  const codecFailures = { blocked: 0 };
  let codecFailureGuardInstalled = false;
  function installCodecFailureGuard() {
    const storage = root.Storage?.prototype;
    if (codecFailureGuardInstalled || typeof storage?.setItem !== "function") return;
    codecFailureGuardInstalled = true;
    const setItem = storage.setItem;
    storage.setItem = function (key, value) {
      if (CODEC_FAILURE_KEYS.has(String(key)) && document.querySelector('[data-btr-mse-active="true"]')) {
        codecFailures.blocked += 1;
        return;
      }
      return setItem.apply(this, arguments);
    };
    // Versions up to 0.9.4.2 could leave such records behind; they are cleared once.
    try {
      if (root.localStorage.getItem("BTR.codecFailuresCleared") !== "1") {
        for (const key of CODEC_FAILURE_KEYS) {
          root.localStorage.removeItem(key);
          root.sessionStorage.removeItem(key);
        }
        setItem.call(root.localStorage, "BTR.codecFailuresCleared", "1");
      }
    } catch (_error) {}
  }

  function createNativePlayer(options) {
    const getSettings = options.getSettings;
    const video = options.container.querySelector("video");
    if (!video) throw new Error("没有找到 B 站原生 video 元素");
    let currentPlayinfo = options.playinfo;
    let preferredQuality = Math.max(0, Math.trunc(Number(options.preferredQuality)) || 0);
    let preferredCodec = normalizeCodec(options.preferredCodec);
    const preferredAudio = normalizeAudio(options.preferredAudio);
    // In 自动, the quality the native player shows (see selectRepresentations).
    let autoQuality = Math.max(0, Math.trunc(Number(options.autoQuality)) || 0);
    let selection = selectRepresentations(currentPlayinfo, preferredQuality, preferredCodec, preferredAudio, autoQuality);
    // The two representation objects the running session downloads from. Its resolvers keep
    // reading them, so fresh addresses always go into these two and never into a newer
    // selection's copies.
    let selectedVideo = selection.preferred;
    let selectedAudio = selection.audio;
    let sessionStarts = 0;
    let sessionRequests = 0;
    let session = null;
    let destroyed = false;
    let nativeUiReady = typeof options.isNativeUiReady !== "function";
    let uiBufferLimit = 0;
    const uiWaitUntil = performance.now() + NATIVE_UI_WAIT_MS;
    let generationSequence = 0;
    let seekTimer = null;
    let seekReloads = 0;
    let seekRequestedAt = 0;
    let nativeRestoresUndone = 0;
    const restoreKey = options.identity?.key || representationPath(selection.preferred) || "";
    if (nativeRestore.key !== restoreKey) nativeRestore = { key: restoreKey, time: 0 };
    let seekStartedAt = 0;
    let seekSettledAt = 0;
    let lastSeekMs = 0;
    let stallsAfterSeek = 0;
    let endedAt = 0;
    function noteSeekSettled() {
      if (!seekStartedAt) return;
      lastSeekMs = performance.now() - seekStartedAt;
      seekStartedAt = 0;
      seekSettledAt = performance.now();
      stallsAfterSeek = 0;
      note("seek settled", `${Math.round(lastSeekMs)} ms`);
    }
    // The initialization segment and the index of a representation never change, and a later
    // session often plays the same one again (a replay after the end, another audio track, a
    // switch back to an earlier quality or codec). Asking for them again cost every such
    // start a round trip to the CDN before any media could be requested.
    const trackHeaders = new Map();
    const timeline = [];
    function note(what, detail = "") {
      timeline.push({ at: Math.round(performance.now()), time: Math.round((Number(video.currentTime) || 0) * 10) / 10, what, detail: String(detail) });
      if (timeline.length > 120) timeline.shift();
    }
    const eventController = new AbortController();
    // The viewer's position and intent, as last seen while our source was on the element.
    // Bilibili's player can put its own source for the same video in place at any time, and
    // the element then reads that source's zero and is paused, whatever the viewer had (#54).
    const lastSeen = { time: 0, playing: false };
    // When a pause() made during a wait for data last took back the wish to play.
    let heldPauseAt = -Infinity;
    const sourceObserver = new MutationObserver(() => {
      const candidate = session;
      if (destroyed || !candidate || candidate.disposed || video.src === candidate.objectUrl) return;
      if (candidate.externalSourceDetected) return;
      candidate.externalSourceDetected = true;
      // Bilibili's player pauses the element right before it puts its own source in place.
      // That pause belongs to the switch: read as the viewer's, the retake stayed paused at
      // zero while Bilibili went on showing the video playing (#65). A playing element's own
      // "pause" of that reset never comes in Chrome: the load of the new source drops it.
      const sincePause = performance.now() - heldPauseAt;
      if (sincePause < SWITCH_PAUSE_MS) {
        lastSeen.playing = true;
        note("pause taken as the switch's", `${Math.round(sincePause)} ms before the new source`);
      }
      rememberNativeRestore(restoreKey, lastSeen.time);
      candidate.controller.abort(new DOMException("B站原生播放器正在切换媒体源", "AbortError"));
      clearInterval(candidate.timer);
      clearTimeout(candidate.endRetryTimer);
      sourceObserver.disconnect();
      options.onNativeSourceChange?.({ src: video.currentSrc || video.src || "" });
    });
    const original = {
      src: video.currentSrc || video.src || "",
      srcAttribute: video.getAttribute("src"),
      volume: video.volume,
      muted: video.muted,
      playbackRate: video.playbackRate,
      currentTime: Number(video.currentTime) || 0,
      wasPaused: video.paused
    };

    // Bilibili's play button reads video.paused. While the element waits for data the viewer
    // means to play (the start, a refill, a drag), BTR holds it paused, and the button showed
    // ▶ until the wait was over. To the page the element reads as playing then; BTR itself
    // always reads the real state (elementPaused). A pause() from the page during such a wait
    // would find the element paused already and change nothing, so it records the viewer's
    // pause and tells the page.
    // What the element answers now (its own, or one the page already put in place) is what
    // BTR reads and what comes back when the player goes.
    const ownPaused = Object.getOwnPropertyDescriptor(video, "paused");
    const ownPause = Object.getOwnPropertyDescriptor(video, "pause");
    const ownPlay = Object.getOwnPropertyDescriptor(video, "play");
    let pausedSource = null;
    for (let target = video; target && !pausedSource; target = Object.getPrototypeOf(target)) {
      pausedSource = Object.getOwnPropertyDescriptor(target, "paused") || null;
    }
    const realPaused = pausedSource?.get;
    const realPause = video.pause;
    const realPlay = video.play;
    const reportsIntent = typeof realPaused === "function" && typeof realPause === "function" && typeof realPlay === "function"
      && ownPaused?.configurable !== false && ownPause?.configurable !== false && ownPlay?.configurable !== false;
    const elementPaused = () => (reportsIntent ? realPaused.call(video) : video.paused);
    const pauseElement = () => (reportsIntent ? realPause.call(video) : video.pause());
    function holdingForPlay() {
      const candidate = session;
      return Boolean(candidate && sessionIsCurrent(candidate) && !candidate.externalSourceDetected
        && (!candidate.playbackActivated || candidate.recovering) && candidate.resumeWanted && elementPaused());
    }
    // Only for a moment, though. Bilibili's player reads video.paused when it hears "pause";
    // while the element read as playing it showed the video playing and kept its danmaku
    // running over a picture that did not move, for as long as a slow wait took. A wait that
    // takes longer than a start or a drag usually does is shown for what it is (see
    // beginHold); once the data is in, the video plays on by itself and the page hears that.
    function readsAsPlaying() {
      return holdingForPlay() && performance.now() - session.holdStartedAt < HOLD_SHOWN_AS_PLAYING_MS;
    }
    // While the start loads, Bilibili's core and other scripts play and pause the element too,
    // so a play or pause then is the viewer's only right after a click or a key press. The
    // core starts the element by itself when it hears that the element can play (its autoplay,
    // seen on a real page), also within seconds of a click: a call made while the page handles
    // one of the element's own events is not the viewer's.
    const viewerActed = () => root.navigator?.userActivation?.isActive ?? true;
    const VIEWER_INPUT = /^(click|dblclick|key(down|up|press)|pointer(down|up)|mouse(down|up)|touch(start|end))$/;
    function viewersCall() {
      const current = root.event;
      if (current?.isTrusted && current.target === video && !VIEWER_INPUT.test(current.type)) return false;
      return viewerActed();
    }
    // A viewer who paused while the start loaded means the video to stay paused once it is
    // ready, and the core's autoplay used to start it anyway (#61).
    function holdsBackPlay() {
      const candidate = session;
      return Boolean(candidate && sessionIsCurrent(candidate) && !candidate.playbackActivated
        && !candidate.resumeWanted && candidate.viewerPaused && !viewersCall());
    }
    if (reportsIntent) {
      Object.defineProperty(video, "paused", { configurable: true, get: () => elementPaused() && !readsAsPlaying() });
      Object.defineProperty(video, "pause", {
        configurable: true,
        writable: true,
        value() {
          if (!holdingForPlay()) return pauseElement();
          // While the start loads, a pause() is the viewer's only right after a click or a key
          // press, as for play(). Bilibili's core pauses the element then too: right before
          // it puts its own source in place (#65), and when it puts back the state it had saved.
          if (!session.playbackActivated && !viewersCall()) {
            note("pause not the viewer's", root.event?.type || "no event");
            return;
          }
          const shown = readsAsPlaying();
          heldPauseAt = performance.now();
          session.resumeWanted = false;
          session.viewerPaused = true;
          if (shown) video.dispatchEvent(new Event("pause"));
        }
      });
      Object.defineProperty(video, "play", {
        configurable: true,
        writable: true,
        value() {
          if (!holdsBackPlay()) return realPlay.apply(video, arguments);
          note("play held back", "paused by the viewer during the start");
          // What the browser answers a play() that a pause interrupted.
          return Promise.reject(new DOMException("The play() request was interrupted by a call to pause().", "AbortError"));
        }
      });
    }
    function releaseElement() {
      if (!reportsIntent) return;
      if (ownPaused) Object.defineProperty(video, "paused", ownPaused);
      else delete video.paused;
      if (ownPause) Object.defineProperty(video, "pause", ownPause);
      else delete video.pause;
      if (ownPlay) Object.defineProperty(video, "play", ownPlay);
      else delete video.play;
    }
    const downloader = downloaderFactory.createDownloader({
      getSettings,
      nativeFetch: options.nativeFetch,
      onTransfer: options.onTransfer
    });

    function sessionIsCurrent(candidate) {
      return !destroyed && session === candidate && !candidate.disposed && !candidate.externalSourceDetected;
    }

    function publishState(extra = {}) {
      const resolvers = session ? [session.videoResolver, session.audioResolver] : [];
      const health = resolvers.flatMap((resolver) => resolver.status());
      const current = Number(video.currentTime) || 0;
      options.onState?.({
        mode: core.normalizeSettings(getSettings()).mode,
        playerState: session?.fatal ? "error" : video.ended ? "ended" : session?.recovering ? "buffering" : session?.playbackActivated ? "ready" : "loading",
        quality: qualityLabel(selectedVideo),
        codec: codecFamily(selectedVideo),
        bufferedAhead: session?.tracks?.length
          ? Math.max(0, Math.min(...session.tracks.map((track) => bufferedEndAt(track.sourceBuffer, current))) - current)
          : 0,
        startupTargetSeconds: session?.startupTargetSeconds || 0,
        startupThroughputBps: session?.startupThroughputBps || 0,
        mediaBytesPerSecond: session?.mediaBytesPerSecond || 0,
        startupWaitingEvents: session?.startupWaitingEvents || 0,
        cdnHosts: health,
        ...extra
      });
    }

    async function queuedSourceOperation(candidate, track, operation) {
      const next = track.operation.catch(() => {}).then(async () => {
        if (!sessionIsCurrent(candidate)) return;
        if (track.sourceBuffer.updating) await waitEvent(track.sourceBuffer, "updateend", "error", candidate.controller.signal);
        if (!sessionIsCurrent(candidate)) return;
        return operation();
      });
      track.operation = next;
      return next;
    }

    function append(candidate, track, bytes, generation) {
      return queuedSourceOperation(candidate, track, async () => {
        if (!sessionIsCurrent(candidate) || generation !== candidate.generation) return;
        try {
          track.sourceBuffer.appendBuffer(bytes);
        } catch (error) {
          // The browser caps how much a SourceBuffer holds (about 150 MB of video in
          // Chromium), which a 4K video can reach at the default 45 seconds ahead
          // (预缓冲时长), and lower qualities at 90 or 180. Freeing played data and asking
          // for less ahead keeps the video playing; failing the append here would hand the
          // whole video back to Bilibili.
          if (error?.name !== "QuotaExceededError") throw error;
          const current = Number(video.currentTime) || 0;
          const ahead = Math.max(0, bufferedEndAt(track.sourceBuffer, current) - current);
          candidate.bufferAheadLimit = Math.max(QUOTA_AHEAD_FLOOR_SECONDS, Math.min(candidate.bufferAheadLimit || Infinity, ahead * 0.75));
          note("buffer quota hit", `${track.kind} keeps ${candidate.bufferAheadLimit.toFixed(0)}s ahead`);
          const behindEnd = Math.max(0, current - 5);
          if (behindEnd > 0 && bufferedStart(track.sourceBuffer, behindEnd) < behindEnd) {
            forgetWritten(track, 0, behindEnd);
            track.sourceBuffer.remove(0, behindEnd);
            await waitEvent(track.sourceBuffer, "updateend", "error", candidate.controller.signal);
          }
          if (!sessionIsCurrent(candidate) || generation !== candidate.generation) return;
          try {
            track.sourceBuffer.appendBuffer(bytes);
          } catch (again) {
            if (again?.name !== "QuotaExceededError") throw again;
            // Nothing played is left to free: what is buffered ahead fills the quota by
            // itself. This write ends here so the buffer's queue stays free; the caller
            // keeps the bytes and writes them once playback has used up some of the buffer.
            throw Object.assign(again, { bufferFull: true, aheadSeconds: ahead });
          }
        }
        await waitEvent(track.sourceBuffer, "updateend", "error", candidate.controller.signal);
      });
    }

    // A segment a removal takes out, even in part, has to be downloaded again.
    function forgetWritten(track, start, end) {
      for (const index of track.written) {
        const segment = track.sidx.segments[index];
        if (segment.startTime < end && segment.endTime > start) track.written.delete(index);
      }
    }

    // Whether the buffer still holds the whole of a segment this session wrote. Only whole
    // writes count: one cut short by a drag, or cut into since, is downloaded again. With
    // B-frames a video range starts a few frames after the time the index gives (0.1 s for
    // AVC at 30 frames a second).
    function alreadyBuffered(track, index) {
      if (!track.written.has(index)) return false;
      const segment = track.sidx.segments[index];
      let ranges;
      try { ranges = track.sourceBuffer.buffered; } catch (_error) { return false; }
      for (let at = 0; at < ranges.length; at += 1) {
        if (ranges.start(at) <= segment.startTime + 0.25 && ranges.end(at) >= segment.endTime - 0.1) return true;
      }
      return false;
    }

    function removeRange(candidate, track, start, end) {
      if (end <= start || candidate.mediaSource.readyState !== "open") return Promise.resolve();
      forgetWritten(track, start, end);
      return queuedSourceOperation(candidate, track, async () => {
        if (!sessionIsCurrent(candidate) || candidate.mediaSource.readyState !== "open") return;
        track.sourceBuffer.remove(start, end);
        await waitEvent(track.sourceBuffer, "updateend", "error", candidate.controller.signal);
      });
    }

    async function loadTrack(candidate, kind, representation, resolver, sourceBuffer, startTime) {
      const headerKey = `${kind}:${Number(representation?.id) || 0}:${codecFamily(representation)}:${representationPath(representation)}`;
      let header = trackHeaders.get(headerKey);
      note(header ? "headers kept" : "headers requested", kind);
      if (!header) {
        const ranges = segmentBase(representation);
        const [initialization, indexBytes] = await Promise.all([
          downloader.downloadRange(ranges.init, resolver, { signal: candidate.controller.signal, parallel: false, kind: "meta" }),
          downloader.downloadRange(ranges.index, resolver, { signal: candidate.controller.signal, parallel: false, kind: "meta" })
        ]);
        if (!sessionIsCurrent(candidate)) throw new DOMException("播放任务已取消", "AbortError");
        const parsed = sidxTools.parseSidx(indexBytes.bytes, ranges.index.start);
        if (!parsed?.segments?.length) throw new Error(`${kind === "video" ? "视频" : "音频"} SIDX 解析失败`);
        note("index parsed", `${kind} ${parsed.segments.length} segments`);
        header = { initialization: initialization.bytes, sidx: parsed };
        trackHeaders.set(headerKey, header);
      }
      const { sidx } = header;
      const startupIndex = sidxTools.segmentIndexAt(sidx.segments, startTime);
      const track = {
        kind, representation, resolver, sourceBuffer, sidx,
        nextIndex: startupIndex,
        startupIndex,
        complete: false,
        // The generation whose fill loop holds this track, 0 when no loop runs.
        filling: 0,
        started: false,
        startupComplete: false,
        startupScheduled: false,
        followupScheduled: false,
        prefetches: new Map(),
        // The prefetched segments that are in, whole and not yet written: with 二级缓冲 on, a
        // seek keeps those still ahead of it; only the others count as downloads on their way.
        ready: new Set(),
        // The segments written whole in this session (see alreadyBuffered).
        written: new Set(),
        operation: Promise.resolve()
      };
      await append(candidate, track, header.initialization, candidate.generation);
      return track;
    }

    // Each generation of a session downloads under its own signal, chained to the session's:
    // a seek inside the session cancels the segments of the position left behind without
    // ending the session itself.
    function openGeneration(candidate) {
      candidate.generation = ++generationSequence;
      candidate.generationController = new AbortController();
      const reason = () => candidate.controller.signal.reason || new DOMException("播放任务已取消", "AbortError");
      if (candidate.controller.signal.aborted) candidate.generationController.abort(reason());
      else if (!candidate.generationLinked) {
        // One listener for the session, cancelling whichever generation is current: a session
        // with many seeks must not pile up listeners on its own signal.
        candidate.generationLinked = true;
        candidate.controller.signal.addEventListener("abort", () => candidate.generationController?.abort(reason()), { once: true });
      }
      return candidate.generationController;
    }

    function generationSignal(candidate) {
      return (candidate.generationController || candidate.controller).signal;
    }

    function segmentDownload(candidate, track, segment, index, downloadOptions = {}) {
      // Read again at every check of the downloader: a new playback rate, or the playhead
      // standing still during a stall, moves the deadline of pieces already on their way.
      const deadlineAt = () => playbackDeadlineAt(segment.startTime, Number(video.currentTime) || candidate.startTime, video.playbackRate);
      return downloader.downloadRange(segment, track.resolver, {
        signal: generationSignal(candidate),
        parallel: true,
        kind: track.kind,
        priority: downloadOptions.priority,
        deadlineAt,
        startup: downloadOptions.startup === true,
        onStartupScheduled: downloadOptions.onStartupScheduled,
        onOrderedChunk: downloadOptions.onOrderedChunk || null
      }).then(
        (result) => {
          if (!result.streamed) track.ready.add(index);
          return { index, result };
        },
        (error) => ({ error, index })
      );
    }

    // Measured once, when the first segments are in. It used to be measured again on every
    // check with the same bytes over a longer time, so the longer the player waited for its
    // target, the slower the network looked and the further the target moved away.
    function updateStartupProfile(candidate) {
      if (candidate.startupProfiled) return candidate.startupTargetSeconds;
      candidate.startupProfiled = candidate.tracks.length > 0 && candidate.tracks.every((track) => track.startupComplete);
      const elapsedSeconds = Math.max(0.25, (performance.now() - candidate.startupStartedAt) / 1000);
      const throughput = candidate.startupCompletedBytes / elapsedSeconds;
      const required = candidate.tracks.reduce((sum, track) => sum + mediaBytesPerSecond(track), 0);
      const ratio = required > 0 ? throughput / required : 0;
      let target = ratio >= 3 ? STARTUP_BUFFER_MIN_SECONDS : ratio >= 1.8 ? 4 : ratio >= 1.25 ? 6 : ratio > 0 ? 8 : 6;
      if ((Number(selectedVideo?.height) || 0) >= 2160 && ratio < 1.8) target = Math.max(target, 8);
      candidate.startupThroughputBps = throughput;
      candidate.mediaBytesPerSecond = required;
      candidate.startupTargetSeconds = Math.max(STARTUP_BUFFER_MIN_SECONDS, Math.min(STARTUP_BUFFER_MAX_SECONDS, target));
      return candidate.startupTargetSeconds;
    }

    function maybeStartStartupPrefetch(candidate) {
      if (candidate.startupPrefetchLaunched || !sessionIsCurrent(candidate) || !candidate.tracks.length) return;
      if (!candidate.tracks.every((track) => track.startupScheduled)) return;
      candidate.startupPrefetchLaunched = true;
      for (const track of candidate.tracks) {
        const index = track.startupIndex + 1;
        track.followupScheduled = true;
        const segment = track.sidx.segments[index];
        if (segment) track.prefetches.set(index, segmentDownload(candidate, track, segment, index, {
          priority: 70
        }));
      }
      ensureBuffer(candidate);
    }

    // How far ahead this session may buffer: the setting, brought down each time the
    // browser's own buffer quota was hit, and to ten seconds while Bilibili's controls load.
    function aheadTarget(candidate) {
      // Controls and thumbnails still need bandwidth while the native UI loads (#28).
      // Keep enough media for startup without filling the whole forward window yet.
      // Stop checking once ready, and stop waiting after NATIVE_UI_WAIT_MS: an upstream
      // layout change cannot cap buffering forever.
      if (!nativeUiReady) nativeUiReady = performance.now() >= uiWaitUntil || Boolean(options.isNativeUiReady());
      uiBufferLimit = nativeUiReady ? 0 : NATIVE_UI_BUFFER_SECONDS;
      return Math.min(core.normalizeSettings(getSettings()).bufferAheadSeconds, candidate.bufferAheadLimit || Infinity, uiBufferLimit || Infinity);
    }

    // The buffer a start or a recovery waits for must be one the tracks can still reach: with
    // the limit brought down to eight seconds, waiting for ten would never end.
    function reachableSeconds(candidate, seconds) {
      return Math.min(seconds, Math.max(0.5, aheadTarget(candidate) - 2));
    }

    // 二级缓冲: once the browser's buffer holds what it can, further segments are downloaded up
    // to the whole 预缓冲时长 and wait in memory, written as playback makes room. Without it
    // the downloads stop where the buffer does, as they always did.
    function downloadTarget(candidate) {
      const settings = core.normalizeSettings(getSettings());
      // Called in either case: it also refreshes uiBufferLimit, read below.
      const buffer = aheadTarget(candidate);
      return settings.secondaryBuffer ? Math.min(settings.bufferAheadSeconds, uiBufferLimit || Infinity) : buffer;
    }

    // Bytes of the segments downloaded or on their way and not yet written, both tracks, the
    // ordinary window included; a segment held back by a full buffer (track.held) is not
    // counted.
    function reserveBytes(candidate) {
      let bytes = 0;
      for (const track of candidate.tracks) {
        for (const index of track.prefetches.keys()) bytes += Number(track.sidx.segments[index]?.length) || 0;
      }
      return bytes;
    }

    // How many segments of a track are on their way at once, once it has started.
    const fillWindow = (track) => (track.kind === "video" ? 3 : 4);

    // A drag back into the gap before what is still buffered restarts the track there; once
    // it meets the kept range, the segments the buffer already holds are passed over instead
    // of downloaded and written again (a minute back at 4K was hundreds of MB).
    function skipBuffered(track) {
      while (!track.held && track.nextIndex < track.sidx.segments.length && alreadyBuffered(track, track.nextIndex)) {
        track.prefetches.delete(track.nextIndex);
        track.ready.delete(track.nextIndex);
        track.nextIndex += 1;
        track.started = true;
      }
    }

    function scheduleReserve(candidate, track, current) {
      const target = downloadTarget(candidate);
      const limit = reserveLimitBytes();
      // A few at a time, like the window that fills the buffer, behind its segments.
      let onTheirWay = 0;
      for (const index of track.prefetches.keys()) if (!track.ready.has(index)) onTheirWay += 1;
      for (let index = track.nextIndex; onTheirWay < fillWindow(track); index += 1) {
        const segment = track.sidx.segments[index];
        if (!segment || segment.startTime - current >= target) break;
        if (track.prefetches.has(index) || track.held?.index === index || alreadyBuffered(track, index)) continue;
        if (reserveBytes(candidate) + (Number(segment.length) || 0) > limit) break;
        onTheirWay += 1;
        track.prefetches.set(index, segmentDownload(candidate, track, segment, index, { priority: 20 }).then((settled) => {
          // The next one starts as soon as this one is in, not at the next check.
          if (!settled.error && sessionIsCurrent(candidate)) ensureBuffer(candidate);
          return settled;
        }));
      }
    }

    async function fillTrack(candidate, track) {
      // The lock carries its generation: a loop cancelled by a seek must not unlock the loop
      // that replaced it, which would leave two loops downloading the same segments.
      if (track.filling === candidate.generation || track.complete || !sessionIsCurrent(candidate) || candidate.fatal) return;
      const generation = candidate.generation;
      track.filling = generation;
      const signal = generationSignal(candidate);
      try {
        while (sessionIsCurrent(candidate) && generation === candidate.generation && !signal.aborted) {
          const current = Number(video.currentTime) || candidate.startTime;
          skipBuffered(track);
          if (track.nextIndex >= track.sidx.segments.length) {
            track.complete = true;
            break;
          }
          if (bufferedEndAt(track.sourceBuffer, current) - current >= aheadTarget(candidate)) {
            if (core.normalizeSettings(getSettings()).secondaryBuffer) scheduleReserve(candidate, track, current);
            break;
          }
          // A sliding window: the next segment starts as soon as one has been appended. Waiting
          // for a whole batch left the connections idle until its slowest segment arrived.
          const windowSize = track.started ? fillWindow(track) : 1;
          let projectedEnd = bufferedEndAt(track.sourceBuffer, current);
          for (let offset = 0; offset < windowSize; offset += 1) {
            const index = track.nextIndex + offset;
            const segment = track.sidx.segments[index];
            if (!segment || projectedEnd - current >= aheadTarget(candidate)) break;
            projectedEnd = segment.endTime;
            if (track.prefetches.has(index) || track.held?.index === index || alreadyBuffered(track, index)) continue;
            const startup = !track.startupComplete && index === track.startupIndex;
            track.prefetches.set(index, segmentDownload(candidate, track, segment, index, {
              priority: startup ? 120 : Math.max(30, 55 - offset * 5),
              startup,
              onStartupScheduled: startup ? () => {
                track.startupScheduled = true;
                maybeStartStartupPrefetch(candidate);
              } : null,
              // The first segment is written piece by piece as it arrives. A full buffer here,
              // with next to nothing buffered yet, ends the download and the takeover as it
              // always did; only whole segments further on are kept and written later.
              onOrderedChunk: startup ? async (bytes) => {
                if (!sessionIsCurrent(candidate) || generation !== candidate.generation || signal.aborted) return;
                candidate.progressiveAppends += 1;
                await append(candidate, track, bytes, generation);
                ensureBuffer(candidate);
              } : null
            }));
          }
          // A segment the buffer had no room for comes first. The check at the top of this
          // loop let it through, so playback has used up a quarter of what was buffered since.
          const pending = track.held ? null : track.prefetches.get(track.nextIndex);
          if (!track.held && !pending) break;
          const settled = track.held || await pending;
          if (!track.held) {
            track.prefetches.delete(settled.index);
            track.ready.delete(settled.index);
          }
          if (settled.error) throw settled.error;
          if (!sessionIsCurrent(candidate) || generation !== candidate.generation || signal.aborted) break;
          if (!settled.result.streamed) {
            try {
              await append(candidate, track, settled.result.bytes, generation);
              if (!sessionIsCurrent(candidate) || generation !== candidate.generation || signal.aborted) break;
              track.held = null;
            } catch (error) {
              // With this little buffered there is nothing left to give up, and waiting
              // would only stall the video: that stays a failure, as it always was.
              if (!sessionIsCurrent(candidate) || generation !== candidate.generation || signal.aborted) break;
              if (!error?.bufferFull || error.aheadSeconds < QUOTA_FATAL_AHEAD_SECONDS) throw error;
              candidate.quotaWaits += 1;
              if (candidate.quotaWaits > QUOTA_MAX_WAITS) throw error;
              track.held = settled;
              break;
            }
          }
          if (!sessionIsCurrent(candidate) || generation !== candidate.generation || signal.aborted) break;
          if (!track.startupComplete && settled.index === track.startupIndex) {
            note("first segment in", `${track.kind} ${Math.round(settled.result.byteLength / 1024)} KiB in ${settled.result.pieceCount} pieces`);
            track.startupComplete = true;
            candidate.startupCompletedBytes += settled.result.byteLength;
            updateStartupProfile(candidate);
          }
          track.nextIndex = settled.index + 1;
          track.written.add(settled.index);
          track.started = true;
          options.onSegment?.({ kind: track.kind, bytes: settled.result.byteLength, pieces: settled.result.pieceCount, hosts: settled.result.hosts });
          ensureBuffer(candidate);
        }
      } catch (error) {
        if (!signal.aborted && sessionIsCurrent(candidate)) fatal(candidate, error);
      } finally {
        if (track.filling === generation) track.filling = 0;
        maybeEndStream(candidate);
      }
    }

    function maybeEndStream(candidate = session) {
      if (!candidate || !sessionIsCurrent(candidate) || candidate.fatal || candidate.streamEnded || candidate.ending) return;
      if (!candidate.tracks.length || !candidate.tracks.every((track) => track.complete)) return;
      candidate.ending = true;
      const generation = candidate.generation;
      // A seek inside the session opens a new generation whose tracks are not complete: an
      // end prepared by the old one is dropped.
      const stillWanted = () => generation === candidate.generation && candidate.tracks.every((track) => track.complete);
      Promise.all(candidate.tracks.map((track) => track.operation.catch(() => {}))).then(() => {
        if (!stillWanted()) return;
        if (!sessionIsCurrent(candidate) || candidate.fatal || candidate.streamEnded || candidate.mediaSource.readyState !== "open") return;
        if (candidate.tracks.some((track) => track.sourceBuffer.updating)) {
          candidate.ending = false;
          candidate.endRetryTimer = setTimeout(() => maybeEndStream(candidate), 50);
          return;
        }
        // endOfStream() itself trims the duration to the end of the buffered media. Setting a
        // shorter duration from the SIDX first is refused once coded frames run past it (HEVC
        // frames often end a few milliseconds after the SIDX total), which kept the stream open
        // and left the player buffering at the end forever.
        candidate.mediaSource.endOfStream();
        candidate.streamEnded = true;
        publishState();
      }).catch((error) => {
        if (!stillWanted()) return;
        candidate.ending = false;
        if (sessionIsCurrent(candidate) && error?.name !== "InvalidStateError") fatal(candidate, error);
        else if (sessionIsCurrent(candidate)) {
          // A buffer that just started updating is retried. Say so if it keeps failing.
          candidate.endAttempts = (candidate.endAttempts || 0) + 1;
          if (candidate.endAttempts === 40) {
            note("end of stream failed", `${candidate.endAttempts} attempts: ${String(error?.message || error).slice(0, 160)}`);
          }
          candidate.endRetryTimer = setTimeout(() => maybeEndStream(candidate), 50);
        }
      });
    }

    function setCurrentTimeInternal(candidate, target) {
      candidate.internalSeekTarget = Number(target) || 0;
      try { video.currentTime = target; }
      catch (_error) { candidate.internalSeekTarget = null; }
      setTimeout(() => {
        if (sessionIsCurrent(candidate) && candidate.internalSeekTarget === (Number(target) || 0)) candidate.internalSeekTarget = null;
      }, 300);
    }

    // Bilibili's own player core downloads nothing while BTR plays, so it may report errors
    // about that. The stylesheet hides its error panels only while BTR is active; what they
    // said goes to the timeline instead of being lost.
    let reportedNativeError = "";
    function clearNativeErrorOverlay() {
      for (const node of options.container.querySelectorAll(".bpx-player-error-wrap,.bpx-player-error-panel")) {
        const text = String(node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
        if (!text || text === reportedNativeError) continue;
        reportedNativeError = text;
        // Bilibili's own words; the report keeps only their numbers (an error code).
        note("Bilibili error overlay", text);
      }
    }

    // Pauses the element to wait for data. Its "pause" event comes later and only if it was
    // playing; counting those keeps it from being read as the viewer's pause.
    function pauseForData(candidate) {
      if (!elementPaused()) candidate.ownPauses += 1;
      pauseElement();
      beginHold(candidate);
    }

    // A wait for data begins: it reads as playing for a moment, then the page hears "pause"
    // and reads the video as paused, unless the wait is over by then. The pause is BTR's own:
    // the viewer still means the video to play.
    function beginHold(candidate) {
      candidate.holdStartedAt = performance.now();
      clearTimeout(candidate.holdTimer);
      candidate.holdTimer = setTimeout(() => {
        if (!reportsIntent || session !== candidate || !holdingForPlay() || readsAsPlaying()) return;
        candidate.ownPauses += 1;
        video.dispatchEvent(new Event("pause"));
      }, HOLD_SHOWN_AS_PLAYING_MS + 20);
    }

    function attemptAutoplay(candidate) {
      if (candidate.playAttempted || !candidate.resumeWanted || !sessionIsCurrent(candidate)) return;
      candidate.playAttempted = true;
      video.play().then(clearNativeErrorOverlay).catch((error) => {
        // The browser would not start it by itself: a tab opened without a click on the page
        // yet. Nothing told the page, which went on showing the video playing and running the
        // danmaku over a still picture. Now it hears that the video is paused, and its play
        // button starts it.
        if (error?.name !== "NotAllowedError" || !sessionIsCurrent(candidate) || !elementPaused()) return;
        candidate.resumeWanted = false;
        candidate.ownPauses += 1;
        video.dispatchEvent(new Event("pause"));
        note("autoplay refused", String(error?.message || error?.name || "NotAllowedError").slice(0, 160));
      });
    }

    function activateWhenReady(candidate) {
      if (candidate.playbackActivated || !sessionIsCurrent(candidate) || !candidate.tracks.length) return;
      if (!candidate.tracks.every((track) => track.startupComplete && track.followupScheduled)) return;
      // Bilibili may call video.play() as soon as the first appended ranges are
      // decodable, before our larger startup buffer is complete. Treat that
      // visible progress as the new handoff point: activation may seek forward
      // to the captured start time, but must never rewind frames already shown.
      const liveTime = Math.max(0, Number(video.currentTime) || 0);
      const target = Math.max(candidate.startTime, liveTime);
      candidate.startTime = target;
      if (!candidate.tracks.every((track) => isBufferedAt(track.sourceBuffer, target))) return;
      const ends = candidate.tracks.map((track) => bufferedEndAt(track.sourceBuffer, target));
      const required = reachableSeconds(candidate, updateStartupProfile(candidate));
      const remaining = Math.max(0.5, (Number(candidate.mediaSource.duration) || target + required) - target);
      if (Math.min(...ends) - target < Math.max(0.5, Math.min(required, remaining))) return;
      candidate.playbackActivated = true;
      note("ready to play", `needed ${required.toFixed(1)} s buffered`);
      noteSeekSettled();
      candidate.playbackActivatedAt = performance.now();
      if (target - (Number(video.currentTime) || 0) > 0.05) setCurrentTimeInternal(candidate, target);
      // The volume, mute and speed are the element's own by now: whatever the viewer or
      // another script (记忆倍速, #60) set while the start was loading stands.
      clearNativeErrorOverlay();
      attemptAutoplay(candidate);
    }

    // Whether a wait for this many seconds of buffer would end at once: both tracks hold the
    // playhead and as much ahead as the wait asks for (or as the tracks can still reach). A
    // track written to its end has nothing more to come: its last segment can end a little
    // before the duration, and a wait for that last bit never ended near the end of a video.
    function waitIsOver(candidate, seconds) {
      const current = Number(video.currentTime) || candidate.startTime;
      if (!candidate.tracks.every((track) => isBufferedAt(track.sourceBuffer, current))) return false;
      const loading = candidate.tracks.filter((track) => !track.complete);
      if (!loading.length) return true;
      const ahead = Math.min(...loading.map((track) => bufferedEndAt(track.sourceBuffer, current))) - current;
      const remaining = Math.max(0.5, (Number(candidate.mediaSource.duration) || current + seconds) - current);
      return ahead >= Math.min(reachableSeconds(candidate, seconds), remaining);
    }

    function ensureBuffer(candidate = session) {
      noteViewer();
      if (!candidate || !sessionIsCurrent(candidate) || candidate.fatal || !candidate.tracks.length) return;
      for (const track of candidate.tracks) fillTrack(candidate, track);
      activateWhenReady(candidate);
      const current = Number(video.currentTime) || candidate.startTime;
      const ready = candidate.tracks.every((track) => isBufferedAt(track.sourceBuffer, current));
      const ahead = ready ? Math.max(0, Math.min(...candidate.tracks.map((track) => bufferedEndAt(track.sourceBuffer, current))) - current) : 0;
      // Chromium may advance the audio clock for several seconds after video runs out,
      // before it emits "waiting". That leaves a frozen picture with sound still playing
      // (#45). Protect steady playback too, not only the first twenty seconds of a session.
      const lowWater = Math.max(0.5, Math.abs(Number(video.playbackRate) || 1));
      const remaining = Number(candidate.mediaSource.duration) - current;
      if (candidate.playbackActivated && !candidate.recovering && !elementPaused() && !video.seeking && !video.ended
        && candidate.tracks.some((track) => !track.complete) && remaining > lowWater + 0.25 && ahead < lowWater) {
        candidate.recovering = true;
        candidate.resumeWanted = true;
        candidate.playAttempted = false;
        candidate.recoveryTargetSeconds = Math.max(STARTUP_RECOVERY_SECONDS, candidate.startupTargetSeconds);
        candidate.underflowRebuffers += 1;
        note("rebuffer before underflow", `${ahead.toFixed(2)}s ahead`);
        pauseForData(candidate);
        if (core.normalizeSettings(getSettings()).autoConcurrency) downloaderFactory.autoConcurrency?.stall("前方缓冲快用完了");
      }
      if (candidate.recovering && ready) {
        if (waitIsOver(candidate, candidate.recoveryTargetSeconds)) {
          candidate.recovering = false;
          // A seek inside the session waits here instead of in activateWhenReady, so this is
          // where the panel's "how long did the jump take" is measured.
          if (candidate.seekPending) {
            candidate.seekPending = false;
            noteSeekSettled();
          }
          note("rebuffer done", `${ahead.toFixed(1)} s ahead`);
          candidate.playAttempted = false;
          attemptAutoplay(candidate);
        }
      }
      publishState();
    }

    function prune(candidate = session) {
      if (!candidate || !sessionIsCurrent(candidate) || candidate.fatal || video.currentTime < 75) return;
      const end = video.currentTime - 30;
      for (const track of candidate.tracks) {
        // A removal waits in the same queue as the appends. Asking for one on every tick put a
        // buffer operation there every 750 ms, so it waits until ten seconds can go at once.
        if (end - bufferedStart(track.sourceBuffer, end) < 10) continue;
        removeRange(candidate, track, 0, end).catch(() => {});
      }
    }

    function disposeSession(candidate, detach = true) {
      if (!candidate || candidate.disposed) return;
      candidate.disposed = true;
      candidate.generation = ++generationSequence;
      candidate.controller.abort(new DOMException("播放任务已取消", "AbortError"));
      clearInterval(candidate.timer);
      clearTimeout(candidate.endRetryTimer);
      clearTimeout(candidate.holdTimer);
      if (detach && video.src === candidate.objectUrl) {
        pauseElement();
        video.removeAttribute("src");
        video.load();
      }
      URL.revokeObjectURL(candidate.objectUrl);
    }

    function fatal(candidate, error) {
      if (!sessionIsCurrent(candidate) || candidate.fatal || error?.name === "AbortError") return;
      candidate.fatal = true;
      candidate.controller.abort(new DOMException("播放内核发生错误", "AbortError"));
      const message = String(error?.message || error).slice(0, 160);
      publishState({ playerState: "error", lastError: message });
      options.onFatal?.(error);
    }

    async function startSession(representation, playbackState) {

      downloaderFactory.autoConcurrency?.newSession();
      if (destroyed) return;
      const request = ++sessionRequests;
      const settling = nativeSourceSettled(video);
      if (settling) {
        const waitedFrom = performance.now();
        await settling;
        note("waited for Bilibili's source buffers", `${Math.round(performance.now() - waitedFrom)} ms`);
        // A later start replaced this one meanwhile.
        if (destroyed || request !== sessionRequests) return;
      }
      const previous = session;
      // Read once: selection can be replaced by a new playinfo while this session starts.
      const audio = selection.audio;
      selectedVideo = representation;
      selectedAudio = audio;
      sessionStarts += 1;
      // The quality by its id: the label is for the screen (1080P 60帧).
      note("session", `qn ${Number(representation?.id) || 0} ${codecFamily(representation)} from ${Number(playbackState.time || 0).toFixed(1)}`);
      const mediaSource = new MediaSource();
      ownMediaSources.add(mediaSource);
      const objectUrl = URL.createObjectURL(mediaSource);
      const candidate = {
        disposed: false, fatal: false, externalSourceDetected: false, generation: 0,
        generationController: null, generationLinked: false, seekPending: false,
        controller: new AbortController(), mediaSource, objectUrl,
        timer: null, endRetryTimer: null, tracks: [], ending: false, streamEnded: false,
        playAttempted: false, playbackActivated: false, playbackActivatedAt: 0,
        recovering: false, recoveryTargetSeconds: STARTUP_RECOVERY_SECONDS, bufferAheadLimit: 0, quotaWaits: 0,
        startupCompletedBytes: 0, startupPrefetchLaunched: false, startupStartedAt: performance.now(),
        progressiveAppends: 0, underflowRebuffers: 0,
        startupTargetSeconds: 6, startupThroughputBps: 0, mediaBytesPerSecond: 0,
        startupWaitingEvents: 0, resumeWanted: playbackState.resume, ownPauses: 0, takeoverPause: false, holdStartedAt: 0, holdTimer: null,
        // A start that replaces one the viewer paused (a quality switch while it loads) is
        // one the viewer paused too.
        viewerPaused: Boolean(previous?.viewerPaused && !previous.playbackActivated && !playbackState.resume),
        volume: playbackState.volume, muted: playbackState.muted, playbackRate: playbackState.playbackRate,
        startTime: Math.max(0, Number(playbackState.time) || 0),
        forceStartTime: Boolean(playbackState.forceTime),
        internalSeekTarget: null, metadataAt: 0, restoreUndoneAt: 0,
        // One ban list per video, shared by every quality and by the audio track.
        videoResolver: resolverFactory.createResolver(representation, () => core.normalizeSettings(getSettings()).mode, options.cdnBans, () => core.normalizeSettings(getSettings()).customHosts),
        audioResolver: resolverFactory.createResolver(audio, () => core.normalizeSettings(getSettings()).mode, options.cdnBans, () => core.normalizeSettings(getSettings()).customHosts)
      };
      openGeneration(candidate);
      session = candidate;
      if (previous) disposeSession(previous, false);
      // The start is a wait for data too.
      beginHold(candidate);
      // The speed the element has now, which may have changed while this start waited for
      // Bilibili's source buffers; the values passed in were read earlier. The load below
      // resets the speed to the default, so it is written back. The volume and mute survive
      // a load and are left alone.
      candidate.playbackRate = video.playbackRate || candidate.playbackRate;
      // Taking the element over pauses it: our pause, also when it follows a click (a
      // recommended video clicked in the page). The load below drops its "pause" event in
      // Chrome, as the standard says; a browser that fires it anyway fires it before the
      // "loadstart" of that load, which ends the wait for it.
      candidate.takeoverPause = !elementPaused();
      pauseElement();
      video.src = objectUrl;
      video.load();
      video.playbackRate = candidate.playbackRate;
      video.dataset.btrMediaEngine = "progressive-mse-0.8-core";
      options.container.dataset.btrMseActive = "true";
      publishState({ playerState: "loading", quality: qualityLabel(selectedVideo), lastError: "" });
      try {
        if (mediaSource.readyState !== "open") await waitEvent(mediaSource, "sourceopen", "error", candidate.controller.signal);
        if (!sessionIsCurrent(candidate)) return;
        const videoBuffer = mediaSource.addSourceBuffer(mimeFor(representation, "video"));
        const audioBuffer = mediaSource.addSourceBuffer(mimeFor(audio, "audio"));
        ownSourceBuffers.add(videoBuffer);
        ownSourceBuffers.add(audioBuffer);
        const [videoTrack, audioTrack] = await Promise.all([
          loadTrack(candidate, "video", representation, candidate.videoResolver, videoBuffer, candidate.startTime),
          loadTrack(candidate, "audio", audio, candidate.audioResolver, audioBuffer, candidate.startTime)
        ]);
        if (!sessionIsCurrent(candidate)) return;
        candidate.tracks = [videoTrack, audioTrack];
        // A seek made while this session was starting only moves the element's start
        // position and fires no "seeking" event. Only the indexes are loaded so far, so the
        // tracks can simply start from there.
        const requested = Number(video.currentTime) || 0;
        if (!candidate.forceStartTime && requested > 0 && Math.abs(requested - candidate.startTime) > 0.5) {
          candidate.startTime = requested;
          for (const track of candidate.tracks) track.startupIndex = track.nextIndex = sidxTools.segmentIndexAt(track.sidx.segments, requested);
        }
        const duration = Math.max(
          Number(selection.dash.duration) || 0,
          videoTrack.sidx.segments.at(-1)?.endTime || 0,
          audioTrack.sidx.segments.at(-1)?.endTime || 0
        );
        if (duration > 0) mediaSource.duration = duration;
        if ((candidate.forceStartTime || candidate.startTime > 0) && Number.isFinite(mediaSource.duration)) {
          setCurrentTimeInternal(candidate, Math.min(candidate.startTime, Math.max(0, mediaSource.duration - 0.1)));
        }
        candidate.startupStartedAt = performance.now();
        candidate.timer = setInterval(() => { ensureBuffer(candidate); prune(candidate); }, 750);
        ensureBuffer(candidate);
      } catch (error) {
        if (sessionIsCurrent(candidate)) fatal(candidate, error);
      }
    }

    // Seeking inside the running session: the tracks move to the target's segment and the
    // element keeps its MediaSource. Rebuilding the session for every seek reset the element
    // to zero first (video.src + load()) and only then restored the position, so anything
    // else watching the same element — Bilibili's own core, another user script — could catch
    // it at zero and put its own position back. Nothing writes currentTime here at all.
    async function seekWithinSession(candidate, target) {
      const previousGeneration = candidate.generationController;
      openGeneration(candidate);
      // 自动线程数 judges the buffer ahead of the playhead: the new position starts that watch afresh.
      downloaderFactory.autoConcurrency?.newSession();
      // The segments of the position left behind are no longer wanted.
      previousGeneration?.abort(new DOMException("已经跳到新的位置", "AbortError"));
      candidate.startTime = target;
      candidate.streamEnded = false;
      candidate.ending = false;
      clearTimeout(candidate.endRetryTimer);
      candidate.quotaWaits = 0;
      const keepReady = core.normalizeSettings(getSettings()).secondaryBuffer;
      for (const track of candidate.tracks) {
        // Queued, so it runs after whatever write is in progress and before the new
        // position's first one: the parser forgets any half-written segment.
        queuedSourceOperation(candidate, track, async () => {
          if (candidate.mediaSource.readyState === "open") track.sourceBuffer.abort();
        }).catch(() => {});
        const index = sidxTools.segmentIndexAt(track.sidx.segments, target);
        // 二级缓冲: segments already in memory past the new position are used, not downloaded
        // again; the ones still on their way were cancelled with the old generation.
        const kept = keepReady ? [...track.prefetches].filter(([at]) => at >= index && track.ready.has(at)) : [];
        track.prefetches.clear();
        track.ready.clear();
        for (const [at, entry] of kept) {
          track.prefetches.set(at, entry);
          track.ready.add(at);
        }
        track.held = null;
        track.complete = false;
        track.started = false;
        track.nextIndex = track.startupIndex = index;
      }
      // Media buffered far from the target only takes room the new position needs.
      const duration = Number(candidate.mediaSource.duration);
      if (Number.isFinite(duration)) {
        for (const track of candidate.tracks) {
          removeRange(candidate, track, 0, Math.max(0, target - 5)).catch(() => {});
          removeRange(candidate, track, target + aheadTarget(candidate) + 30, duration).catch(() => {});
        }
      }
      candidate.resumeWanted = wantsToPlay();
      // Once playing, the wait for the new position is the same wait as a rebuffer.
      if (candidate.playbackActivated) {
        candidate.recovering = true;
        candidate.recoveryTargetSeconds = Math.max(STARTUP_RECOVERY_SECONDS, candidate.startupTargetSeconds);
        candidate.playAttempted = false;
        candidate.seekPending = true;
        pauseForData(candidate);
      }
      ensureBuffer(candidate);
      publishState();
    }

    async function seek() {
      const candidate = session;
      if (!candidate || !sessionIsCurrent(candidate) || !candidate.tracks.length) return;
      const target = Number(video.currentTime) || 0;
      if (candidate.internalSeekTarget !== null && Math.abs(target - candidate.internalSeekTarget) < 0.25) {
        candidate.internalSeekTarget = null;
        return;
      }
      if (candidate.tracks.every((track) => isBufferedAt(track.sourceBuffer, target))) {
        note("seek inside buffer", `to ${target.toFixed(1)}`);
        ensureBuffer(candidate);
        return;
      }
      seekReloads += 1;
      seekStartedAt = seekRequestedAt || performance.now();
      note("seek outside the buffer", target.toFixed(1));
      // A video sent back to its start right after it ended is the player's 单集循环 or its
      // replay button, which mean to play it again. The video is paused at that moment, so
      // without this the next round would stop at the first frame (issue #17); that case keeps
      // the full restart, which owns the intent to play again.
      const restarting = target < 1 && (video.ended || performance.now() - endedAt < 2000);
      if (!restarting && candidate.mediaSource.readyState !== "closed") {
        await seekWithinSession(candidate, target);
        return;
      }
      await startSession(selectedVideo, {
        time: target,
        resume: wantsToPlay() || restarting,
        volume: video.volume,
        muted: video.muted,
        playbackRate: video.playbackRate
      });
    }

    function scheduleSeek() {
      const candidate = session;
      const target = Number(video.currentTime) || 0;
      if (candidate && sessionIsCurrent(candidate) && !candidate.playbackActivated && candidate.metadataAt
        && performance.now() - candidate.metadataAt < 250 && candidate.restoreUndoneAt !== candidate.metadataAt
        && nativeRestore.time && Math.abs(target - nativeRestore.time) < 1 && Math.abs(target - candidate.startTime) >= 0.5) {
        // The core restores once per metadata; a second seek to that position is the viewer's.
        candidate.restoreUndoneAt = candidate.metadataAt;
        nativeRestoresUndone += 1;
        note("native restore undone", `${target.toFixed(1)} -> ${candidate.startTime.toFixed(1)}`);
        setCurrentTimeInternal(candidate, candidate.startTime);
        // Its restore also plays or pauses as things were back then; the viewer's intent wins.
        if (!candidate.resumeWanted && !elementPaused()) pauseElement();
        return;
      }
      seekRequestedAt = performance.now();
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => {
        seekTimer = null;
        seek().catch((error) => { if (session && sessionIsCurrent(session)) fatal(session, error); });
      }, 140);
    }

    video.addEventListener("loadedmetadata", () => { if (session) session.metadataAt = performance.now(); }, { signal: eventController.signal });
    video.addEventListener("seeking", scheduleSeek, { signal: eventController.signal });
    video.addEventListener("timeupdate", () => {
      ensureBuffer();
      // 自动线程数 watches the buffer ahead of the playhead while playing.
      const candidate = session;
      if (candidate && sessionIsCurrent(candidate) && candidate.playbackActivated && candidate.tracks.length && core.normalizeSettings(getSettings()).autoConcurrency) {
        const current = Number(video.currentTime) || 0;
        const ahead = Math.max(0, Math.min(...candidate.tracks.map((track) => bufferedEndAt(track.sourceBuffer, current))) - current);
        downloaderFactory.autoConcurrency?.buffer(ahead, !elementPaused() && !video.seeking);
      }
    }, { signal: eventController.signal });
    video.addEventListener("waiting", () => {
      const candidate = session;
      note("waiting", candidate?.playbackActivated ? "after start" : "before start");
      if (candidate && sessionIsCurrent(candidate) && candidate.playbackActivated) {
        candidate.startupWaitingEvents += 1;
        const recoveryTarget = Math.min(STARTUP_BUFFER_MAX_SECONDS, Math.max(STARTUP_RECOVERY_SECONDS, candidate.startupTargetSeconds + 2));
        // With that much already buffered ahead the element waits for its decoder, not for
        // data: a device that decodes the stream too slowly (#58). Pausing for data ended at
        // once and the element waited again, thousands of times a minute, and more threads do
        // not decode any faster.
        const dataMissing = !waitIsOver(candidate, recoveryTarget);
        if (dataMissing && !video.seeking && !elementPaused() && core.normalizeSettings(getSettings()).autoConcurrency) downloaderFactory.autoConcurrency?.stall("播放卡了一下");
        if (seekSettledAt && performance.now() - seekSettledAt < 15000 && !video.seeking) stallsAfterSeek += 1;
        if (performance.now() - candidate.playbackActivatedAt <= STARTUP_PROTECTION_MS && !candidate.recovering && !video.seeking && dataMissing) {
          candidate.recovering = true;
          candidate.resumeWanted = true;
          candidate.playAttempted = false;
          candidate.recoveryTargetSeconds = recoveryTarget;
          pauseForData(candidate);
        }
        ensureBuffer(candidate);
      }
    }, { signal: eventController.signal });
    // While a session waits for data after a seek or a stall, the element is paused and the
    // session remembers whether the viewer means it to play. Play or pause pressed meanwhile
    // changes that: a second drag used to read the intent from before and leave the video
    // paused for good. The pauses that start such a wait are ours and do not count.
    // While the start loads, Bilibili's player may already have started the element, and a
    // pause the viewer pressed then was lost: once its buffer was ready the start played the
    // video again (#61). Only a play or pause right after a click or a key press counts then
    // (see viewerActed).
    const changesIntent = (candidate) => (candidate.playbackActivated ? candidate.recovering : viewerActed());
    video.addEventListener("play", () => {
      const candidate = session;
      if (candidate && sessionIsCurrent(candidate) && changesIntent(candidate)) candidate.resumeWanted = true;
    }, { signal: eventController.signal });
    video.addEventListener("pause", () => {
      const candidate = session;
      if (!candidate || !sessionIsCurrent(candidate)) return;
      if (candidate.takeoverPause) candidate.takeoverPause = false;
      else if (candidate.ownPauses > 0) candidate.ownPauses -= 1;
      else if (changesIntent(candidate)) {
        candidate.resumeWanted = false;
        candidate.viewerPaused = true;
      }
    }, { signal: eventController.signal });
    video.addEventListener("loadstart", () => {
      const candidate = session;
      if (!candidate) return;
      const pauseDropped = candidate.takeoverPause;
      candidate.takeoverPause = false;
      // Chrome dropped the "pause" of a playing element taken over. A start that plays the
      // video does not need it; one that keeps it paused does: the page went on showing the
      // video playing, ran its danmaku over a still picture, and its play button only paused
      // the element again, which changed nothing (#65).
      if (pauseDropped && sessionIsCurrent(candidate) && video.src === candidate.objectUrl && !candidate.resumeWanted && elementPaused()) {
        candidate.ownPauses += 1;
        video.dispatchEvent(new Event("pause"));
      }
    }, { signal: eventController.signal });
    for (const name of ["play", "pause", "seeked"]) video.addEventListener(name, noteViewer, { signal: eventController.signal });
    video.addEventListener("playing", clearNativeErrorOverlay, { signal: eventController.signal });
    video.addEventListener("playing", () => note("playing"), { signal: eventController.signal });
    video.addEventListener("ended", () => {
      endedAt = performance.now();
      publishState({ playerState: "ended", bufferedAhead: 0 });
    }, { signal: eventController.signal });

    // Whether the viewer means the video to play. While a session is still loading, or while
    // we paused it ourselves to rebuffer, the element is paused whatever the viewer wants and
    // the session remembers the intent. Reading video.paused then made a second drag of the
    // progress bar, or a quality change during loading, leave the video paused for good.
    function wantsToPlay() {
      const candidate = session;
      if (candidate?.externalSourceDetected) return lastSeen.playing;
      if (candidate && sessionIsCurrent(candidate) && (!candidate.playbackActivated || candidate.recovering)) return Boolean(candidate.resumeWanted);
      return !elementPaused();
    }

    // Where the viewer is in the video. A session that is still starting has just given the
    // element its source, which reads zero until the session has moved it to its start.
    function playbackPosition() {
      const candidate = session;
      if (candidate?.externalSourceDetected) return lastSeen.time;
      const current = Number(video.currentTime) || 0;
      return current === 0 && candidate && sessionIsCurrent(candidate) && !candidate.playbackActivated ? candidate.startTime : current;
    }

    function noteViewer() {
      const candidate = session;
      if (!candidate || !sessionIsCurrent(candidate) || video.src !== candidate.objectUrl) return;
      lastSeen.time = playbackPosition();
      lastSeen.playing = wantsToPlay();
    }

    function playbackState() {
      // A pending source still reports zero and is paused by us. The session already knows
      // its target and intent; the initial autoplay choice must not be made again here.
      return {
        time: playbackPosition(),
        resume: wantsToPlay(),
        volume: video.volume,
        muted: video.muted,
        playbackRate: video.playbackRate || 1
      };
    }

    // The expiry (seconds since the epoch) in an address's signature; 0 when it has none.
    function deadlineOf(representation) {
      try { return Number(new URL(representationUrl(representation)).searchParams.get("deadline")) || 0; }
      catch (_error) { return 0; }
    }

    // Whether a playinfo names, for any file already known, an address that expires sooner.
    function namesOlderAddresses(playinfo) {
      const listed = (item) => {
        const dash = dashBody(item)?.dash;
        return [...(dash?.video || []), ...(dash?.audio || []), ...[].concat(dash?.dolby?.audio || [], dash?.flac?.audio || [])];
      };
      const known = [...listed(currentPlayinfo), selectedVideo, selectedAudio].filter(Boolean);
      return listed(playinfo).some((item) => {
        const deadline = deadlineOf(item);
        return deadline > 0 && known.some((other) => sameRepresentation(other, item) && deadline < deadlineOf(other));
      });
    }

    // A refreshed playinfo names the same files with fresh signatures. The resolvers of a
    // running session keep reading their representation objects, so those objects receive
    // the new addresses; nothing else about the session changes.
    function refreshRepresentationUrls(target, source) {
      if (!target || !source || target === source) return;
      // Bilibili's page and the timed refresh both bring addresses, and the answer that
      // arrives last is not always the newer one.
      if (deadlineOf(source) < deadlineOf(target)) return;
      for (const key of ["baseUrl", "base_url", "backupUrl", "backup_url", "backup_url_list"]) {
        if (source[key] !== undefined) target[key] = source[key];
      }
    }

    // When the earliest signed address of the playing tracks expires, in seconds since the
    // epoch. 0 when no address carries a deadline.
    function urlDeadlineSeconds() {
      let earliest = 0;
      for (const representation of [selectedVideo, selectedAudio]) {
        const deadline = deadlineOf(representation);
        if (deadline > 0 && (!earliest || deadline < earliest)) earliest = deadline;
      }
      return earliest;
    }

    // Whether an address names one of this video's own files, on any node and with any
    // signature: Bilibili's own core asks its nodes for the very files BTR is playing (#49).
    let ownedPaths = { dash: null, paths: new Set() };
    function ownsMediaUrl(url) {
      const dash = selection?.dash;
      if (ownedPaths.dash !== dash) {
        const paths = new Set();
        for (const representation of [].concat(dash?.video || [], dash?.audio || [], dash?.dolby?.audio || [], dash?.flac?.audio || [])) {
          const addresses = [representationUrl(representation)].concat(representation?.backupUrl || representation?.backup_url || representation?.backup_url_list || []);
          for (const address of addresses) {
            try { if (address) paths.add(new URL(String(address)).pathname); } catch (_error) {}
          }
        }
        ownedPaths = { dash, paths };
      }
      try { return ownedPaths.paths.has(new URL(String(url), root.location?.href).pathname); }
      catch (_error) { return false; }
    }

    async function updatePlayinfo(playinfo) {
      if (destroyed) return;
      // A refreshed playinfo names a quality of its own; in 自动 the one playing stays. So does
      // a quality picked by hand that the viewer just left for 自动: the menu goes on showing
      // it there, and the playinfo's own quality is often a lower one (#69).
      const next = selectRepresentations(playinfo, preferredQuality, preferredCodec, preferredAudio, autoQuality, preferredQuality ? 0 : Number(selectedVideo?.id) || 0);
      // Bilibili's page and the timed refresh both bring playinfos, and the one that arrives
      // last is not always the newer one. An older one is dropped whole: kept as the current
      // playinfo it would hand its addresses to the next session, after a seek or a quality
      // change, although the running session was protected from them. Every file the two
      // name in common counts, not only the quality that is playing.
      if (playinfo !== currentPlayinfo && namesOlderAddresses(playinfo)) return;
      currentPlayinfo = playinfo;
      const nextVideo = next.preferred;
      const audioChanged = !sameRepresentation(selectedAudio, next.audio);
      selection = next;
      if (!audioChanged && sameRepresentation(selectedVideo, nextVideo)) {
        refreshRepresentationUrls(selectedVideo, nextVideo);
        refreshRepresentationUrls(selectedAudio, next.audio);
        return;
      }
      await startSession(nextVideo, playbackState());
    }

    // The native quality menu switches between qualities already in the playinfo without
    // asking for a new one, so the page tells us what was chosen. Choosing the quality that
    // is already playing does not restart anything.
    async function setQuality(quality) {
      const wanted = Math.max(0, Math.trunc(Number(quality)) || 0);
      if (destroyed || wanted === preferredQuality) return;
      preferredQuality = wanted;
      await updatePlayinfo(currentPlayinfo);
    }

    // In 自动 the native player may settle on another quality (see selectRepresentations).
    async function setAutoQuality(quality) {
      const wanted = Math.max(0, Math.trunc(Number(quality)) || 0);
      if (destroyed || wanted === autoQuality) return;
      autoQuality = wanted;
      await updatePlayinfo(currentPlayinfo);
    }

    // The same for the codec picked in the 播放策略 menu.
    async function setCodec(codec) {
      const wanted = normalizeCodec(codec);
      if (destroyed || wanted === preferredCodec) return;
      preferredCodec = wanted;
      await updatePlayinfo(currentPlayinfo);
    }

    // handBack(video, time, play) asks Bilibili's own player to take the video back; it says
    // false when it cannot, and the old source is put back instead.
    function destroy({ resumeNative = true, handBack = null } = {}) {
      if (destroyed) return;
      // Read while the session still counts: one that is starting knows the viewer's intent.
      const state = playbackState();
      const time = playbackPosition() || original.currentTime;
      destroyed = true;
      releaseElement();
      clearTimeout(seekTimer);
      eventController.abort();
      sourceObserver.disconnect();
      if (session) disposeSession(session, true);
      delete video.dataset.btrMediaEngine;
      delete options.container.dataset.btrMseActive;
      if (resumeNative && typeof handBack === "function" && handBack(video, time, state.resume)) {
        // Bilibili's core remembers this position (see nativeRestore).
        rememberNativeRestore(restoreKey, time);
        return;
      }
      if (resumeNative && original.src) {
        // Bilibili's core reloads from here and remembers this position (see nativeRestore).
        rememberNativeRestore(restoreKey, time);
        video.src = original.src;
        video.volume = original.volume;
        video.muted = original.muted;
        // At the speed the viewer has now, not the one from before the takeover.
        video.playbackRate = state.playbackRate;
        video.load();
        try { video.currentTime = time; } catch (_error) {}
        // A video the viewer paused stays paused. One that was playing goes on once there is
        // something to play: Bilibili's core replaces this old source with a new one, and a
        // play() on the old one held the video back for seconds after the new one was ready
        // (seen on a real page).
        if (!state.resume) return;
        const play = () => {
          clearTimeout(giveUp);
          video.removeEventListener("canplay", play);
          video.play().catch(() => {});
        };
        const giveUp = setTimeout(() => video.removeEventListener("canplay", play), 15000);
        video.addEventListener("canplay", play);
      } else if (resumeNative && original.srcAttribute !== null) {
        video.setAttribute("src", original.srcAttribute);
        video.load();
      }
    }

    if (!document.getElementById("__btr_native_mse_style__")) {
      const style = document.createElement("style");
      style.id = "__btr_native_mse_style__";
      style.textContent = `
        [data-btr-mse-active="true"] .bpx-player-error-wrap,
        [data-btr-mse-active="true"] .bpx-player-error-panel,
        [data-btr-retaking="true"] .bpx-player-error-wrap,
        [data-btr-retaking="true"] .bpx-player-error-panel{display:none!important}
      `;
      (document.head || document.documentElement).append(style);
    }
    sourceObserver.observe(video, { attributes: true, attributeFilter: ["src"] });
    const hasInitialTime = options.initialTime !== undefined && Number.isFinite(Number(options.initialTime));
    const initialTime = hasInitialTime
      ? Math.max(0, Number(options.initialTime))
      : original.currentTime;
    // A video that has not started yet only starts by itself when the player's "自动开播" is on
    // (issue #13); the page passes that setting as options.autoplay.
    const initialResume = options.initialResume !== undefined
      ? Boolean(options.initialResume)
      : !original.wasPaused || (original.currentTime < 1 && options.autoplay !== false);
    lastSeen.time = initialTime;
    lastSeen.playing = initialResume;
    startSession(selectedVideo, {
      // The native player may already have rendered its first frames before the
      // accelerated MediaSource is ready. Preserve that exact position: forcing
      // every handoff below two seconds back to zero produces a visible replay.
      time: initialTime,
      forceTime: hasInitialTime,
      resume: initialResume,
      volume: original.volume,
      muted: original.muted,
      playbackRate: original.playbackRate || 1
    }).catch((error) => { if (session) fatal(session, error); });

    return Object.freeze({
      applySettings() { ensureBuffer(); },
      wantsToPlay,
      playbackPosition,
      destroy,
      setCodec,
      setQuality,
      setAutoQuality,
      updatePlayinfo,
      urlDeadlineSeconds,
      ownsMediaUrl,
      // The qualities this browser plays, each in the codec that would be used, with its
      // bitrate: what the page chooses among for 自动 (driveAutoQuality in page-hook.js).
      playableQualities: () => selection.videos.map((item) => ({ id: Number(item.id) || 0, bandwidth: Number(item.bandwidth) || 0 })).filter((item) => item.id),
      video,
      getDebug: () => ({
        version: "2026.11.13.1",
        architecture: "bilibili-native-ui-progressive-mse-0.8-core",
        quality: qualityLabel(selectedVideo),
        qualityId: Number(selectedVideo?.id) || 0,
        // Every quality the playinfo offers, whether this browser plays it or not.
        qualities: [...new Set((selection.dash?.video || []).map((item) => Number(item?.id) || 0).filter(Boolean))].sort((a, b) => b - a),
        // The element's own paused state; video.paused answers for the page (see above).
        elementPaused: elementPaused(),
        preferredQuality,
        autoQuality,
        preferredCodec,
        preferredAudio,
        codecFailuresBlocked: codecFailures.blocked,
        sessionStarts,
        codec: codecFamily(selectedVideo),
        width: Number(selectedVideo?.width) || 0,
        height: Number(selectedVideo?.height) || 0,
        frameRate: frameRate(selectedVideo),
        videoType: mimeFor(selectedVideo, "video"),
        audioType: mimeFor(selection.audio, "audio"),
        videoBandwidth: Number(selectedVideo?.bandwidth) || 0,
        // The bitrate of the next half minute of the video being played, in kbit/s, from its
        // index. The bandwidth above is an average over the whole video: a busy stretch was
        // measured at nearly three times as much, and 自动 chooses by what is coming.
        videoKbpsAhead: kbpsAhead(session?.tracks?.find((track) => track.kind === "video"), Number(video.currentTime) || session?.startTime || 0),
        audioBandwidth: Number(selection.audio?.bandwidth) || 0,
        currentTime: Number(video.currentTime) || 0,
        mediaSourceState: session?.mediaSource?.readyState || "closed",
        playbackActivated: Boolean(session?.playbackActivated),
        resumeWanted: Boolean(session?.resumeWanted),
        sessionStartTime: session?.startTime || 0,
        startupBufferSeconds: session?.startupTargetSeconds || 0,
        startupWaitingEvents: session?.startupWaitingEvents || 0,
        bufferAheadLimit: session?.bufferAheadLimit || 0,
        // 二级缓冲: the seconds of video waiting in memory, and the bytes downloaded or on
        // their way and not yet written (see reserveBytes).
        reserve: session?.tracks?.length ? {
          seconds: Math.round([...(session.tracks.find((track) => track.kind === "video")?.ready || [])]
            .reduce((sum, index) => sum + (Number(session.tracks.find((track) => track.kind === "video").sidx.segments[index]?.durationSeconds) || 0), 0) * 10) / 10,
          bytes: reserveBytes(session),
          limitBytes: reserveLimitBytes()
        } : null,
        uiBufferLimit,
        urlDeadline: urlDeadlineSeconds(),
        // Errors from Bilibili's idle core that were kept out of the page's console.
        nativeLeftoversSuppressed: nativeLeftovers.suppressed,
        lastNativeLeftover: nativeLeftovers.last,
        progressiveAppends: session?.progressiveAppends || 0,
        underflowRebuffers: session?.underflowRebuffers || 0,
        seekReloads,
        nativeRestoresUndone,
        lastSeekMs: Math.round(lastSeekMs),
        stallsAfterSeek,
        timeline: timeline.slice(),
        tracks: (session?.tracks || []).map((track) => ({ kind: track.kind, nextIndex: track.nextIndex, segments: track.sidx.segments.length }))
      })
    });
  }

  installBufferedShim();
  installNativeErrorGuard();
  installMediaSourceWatch();
  installCodecFailureGuard();
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = Object.freeze({ createNativePlayer, playbackDeadlineAt, qualityLabel, selectRepresentations });
})(globalThis);

/* src/native-range-transport.js */
(function installNativeRangeTransport(root) {
  "use strict";

  const core = root.__BILI_RANGE_CORE__;
  if (root.__BILI_NATIVE_RANGE_PLAYER_FACTORY__) return;
  const resolvers = root.__BILI_CDN_RESOLVER_FACTORY__;
  const downloaders = root.__BILI_IDM_DOWNLOADER_FACTORY__;
  if (!core || !resolvers || !downloaders || !root.fetch || !root.XMLHttpRequest) return;
  const nativeFetch = root.fetch.bind(root);
  // The compatibility mode ("兼容模式" in the settings): Bilibili's own player keeps the
  // decoder, the buffer and the quality switching, and only its media requests are
  // downloaded here. Safari needs it, because replacing the MediaSource breaks its quality
  // switching. Nothing is intercepted until a player of this mode is created.
  let active = null;
  let passthroughFetch = nativeFetch;

  function nativeCore(video) {
    const wrapper = root.player?.__core?.(), dash = wrapper?.getCorePlayer?.();
    if (!dash || dash.getVideoElement?.() !== video) return null;
    if (![video.requestVideoFrameCallback, wrapper.fire, wrapper.getQualityChangedData,
      dash.on, dash.off, dash.getQualityFor].every(method => typeof method === "function")) {
      throw new Error("原生播放器接口不兼容");
    }
    return dash;
  }

  function nativeSwitchPending() {
    try {
      const quality = root.player?.getQuality?.();
      const current = Number(quality?.nowQ), target = Number(quality?.newQ);
      return Number.isFinite(current) && Number.isFinite(target) && current > 0 && target > 0 && current !== target;
    } catch (_error) { return false; }
  }

  // A completed VOD scheduler stays stopped when Bilibili changes quality.
  // Reopen scheduling during that request; native rules still choose every
  // fragment. Never restart a running scheduler: start() clears its append lock.
  function attachQualityGuard(dash, video, note, unavailable) {
    const records = new Map();
    let disposed = false;
    const fail = error => {
      release();
      note("native quality guard unavailable", String(error?.message || error));
      unavailable(error);
    };
    const protect = fn => (...args) => {
      if (disposed) return;
      try { return fn(...args); }
      catch (error) { fail(error); }
    };
    const clear = record => {
      record.pending = null;
      clearTimeout(record.timer);
      if (record.frame) video.cancelVideoFrameCallback?.(record.frame);
      record.frame = 0;
    };
    const restore = record => {
      clear(record);
      if (record.buffer.getIsBufferingCompleted === record.wrapped) record.buffer.getIsBufferingCompleted = record.original;
    };
    function oldFuture(record) {
      const model = record.processor.getFragmentModel?.(), target = dash.getQualityFor(record.processor.getType());
      const history = model?.getRequests?.({ state: "executed", type: "MediaSegment" }) || [];
      return history.some(request => request && request.quality !== target && request.startTime > video.currentTime
        && model.getRequests({ state: "executed", time: request.startTime + request.duration / 2, threshold: 0 })?.[0] === request);
    }
    function finishSource() {
      const source = [...records.values()][0]?.buffer.getMediaSource?.();
      if (disposed || source?.readyState !== "open" || source.sourceBuffers.length !== records.size) return;
      if ([...records.values()].every(record => record.buffer.getMediaSource?.() === source
        && record.buffer.getIsBufferingCompleted() && !record.processor.getFragmentModel?.()?.getLoadingRequests?.().length)
        && [...source.sourceBuffers].every(buffer => !buffer.updating)) source.endOfStream();
    }
    function resumeFuture(record) {
      if (disposed || dash.getFastSwitchEnabled?.() === false) return;
      const processor = record.processor, scheduler = processor.getScheduleController();
      if (scheduler.isStarted()) return;
      const target = dash.getQualityFor(processor.getType());
      const duration = processor.getRepresentationInfoForQuality?.(target)?.fragmentDuration || 5;
      const offsets = dash.getFastSwitchQnV2Enabled?.() ? [1, 1.5] : [1.5];
      const due = offsets.some(offset => {
        const request = processor.getFragmentModel?.()?.getRequests?.({ state: "executed", time: video.currentTime + duration * offset, threshold: 0 })?.[0];
        return request?.type === "MediaSegment" && request.quality !== target;
      });
      if (due) { scheduler.start(); note("native future replacement resumed", processor.getType()); }
    }
    function observe(event) {
      const buffer = event.sender, processor = buffer?.getStreamProcessor?.(), type = processor?.getType?.();
      if (type !== "video" && type !== "audio") return;
      if (typeof buffer.getIsBufferingCompleted !== "function" || typeof processor.getScheduleController !== "function") {
        throw new Error("原生缓冲接口不兼容");
      }
      const scheduler = processor.getScheduleController();
      if (typeof scheduler?.isStarted !== "function" || typeof scheduler.start !== "function") throw new Error("原生调度接口不兼容");
      const previous = records.get(type);
      if (previous?.processor === processor) {
        queueMicrotask(protect(() => { if (records.get(type) === previous) { resumeFuture(previous); finishSource(); } }));
        return;
      }
      if (previous) restore(previous);
      const record = { buffer, processor, original: buffer.getIsBufferingCompleted, pending: null, frame: 0 };
      // A successful switch only confirms the current segment. Keep native
      // replacement scheduling alive while later buffered segments are old.
      record.wrapped = function () {
        const completed = record.original.call(this);
        if (!completed) return false;
        try { return !record.pending && !oldFuture(record); }
        catch (error) { fail(error); return completed; }
      };
      buffer.getIsBufferingCompleted = record.wrapped;
      records.set(type, record);
    }
    function requested(event) {
      const record = records.get(event.mediaType);
      if (!record || !Number.isInteger(event.newQuality)) return;
      clear(record);
      record.pending = event;
      // Only a cleanup bound: Bilibili keeps its original switch timeout.
      record.timer = setTimeout(() => clear(record), 21000);
      const processor = record.processor;
      queueMicrotask(protect(() => {
        if (record.pending !== event) return;
        const scheduler = processor.getScheduleController();
        if (!scheduler.isStarted()) { scheduler.start(); note("native stopped scheduler resumed", event.mediaType); }
      }));

      // After seeking back into an old rendition, the requested quality can
      // already be displayed. Native rendering notifications require a change
      // from the previous frame and otherwise never resolve this request.
      const wrapper = root.player?.__core?.();
      if (event.mediaType !== "video" || !video.requestVideoFrameCallback || typeof wrapper?.fire !== "function"
        || typeof wrapper.getQualityChangedData !== "function") return;
      const at = time => processor.getFragmentModel?.()?.getRequests?.({ state: "executed", time, threshold: 0 })
        ?.find(request => request?.type === "MediaSegment");
      const target = processor.getMediaInfo?.()?.bitrateList?.[event.newQuality];
      if (!target) return;
      let frames = 0, switching = null;
      const confirm = (_now, metadata) => {
        record.frame = 0;
        if (disposed || record.pending !== event || wrapper.getCorePlayer() !== dash) return;
        const current = wrapper.qnSwitchingInfo?.video, request = at(metadata.mediaTime);
        if (!current?.switching || current.qn !== event.newQuality || typeof current.listener !== "function"
          || (switching && switching !== current)) return;
        switching = current;
        // Native history may be absent immediately after a seek. Observe until
        // matching frames arrive; an index/init response alone is never success.
        frames = request?.quality === event.newQuality && video.videoWidth === target.width
          && video.videoHeight === target.height ? frames + 1 : 0;
        if (frames < 2) { record.frame = video.requestVideoFrameCallback(protect(confirm)); return; }
        const rendered = { type: "qualityChangeRendered", mediaType: "video", oldQuality: event.oldQuality, newQuality: event.newQuality,
          index: request.index, requestType: request.type, isMediaSegment: true };
        wrapper.fire("qualityChangeRendered", wrapper.getQualityChangedData(rendered));
        current.listener(rendered);
        clear(record);
        note("native already-rendered quality confirmed", `${target.width}x${target.height} / 2 decoded frames`);
      };
      record.frame = video.requestVideoFrameCallback(protect(confirm));
    }
    function rendered(event) {
      const record = records.get(event.mediaType);
      if (record?.pending?.newQuality === event.newQuality) clear(record);
    }
    const handlers = { bufferLevelUpdated: protect(observe), qualityChangeRequested: protect(requested), qualityChangeRendered: protect(rendered) };
    try {
      for (const [name, handler] of Object.entries(handlers)) dash.on(name, handler);
    } catch (error) {
      release();
      throw error;
    }
    function release() {
      if (disposed) return;
      disposed = true;
      for (const [name, handler] of Object.entries(handlers)) {
        try { dash.off(name, handler); } catch (_error) { /* Still restore buffers if the native core changed. */ }
      }
      for (const record of records.values()) {
        try { restore(record); } catch (_error) { /* Continue cleaning other processors. */ }
      }
      records.clear();
    }
    return release;
  }

  // Only bounded, ordinary media GETs are replaced. Authentication, conditional
  // requests, open-ended ranges, sync XHR and unknown files retain native behavior.
  function planRequest(url, method, headers, credentials) {
    const owner = active;
    if (!owner || owner.disposed || !owner.settings().enabled || method !== "GET"
      || credentials === "include" || !core.isBilibiliMediaUrl(url)) return null;
    if ([...headers.keys()].some(name => !["range", "accept"].includes(name))) return null;
    const range = core.parseRangeHeader(headers.get("range"));
    if (!range || !Number.isSafeInteger(range.length)) return null;
    const track = owner.track(url);
    if (!track || !owner.sampleQuality()) return null;
    if (nativeSwitchPending()) owner.nativeSwitchRequest();
    return { owner, url, range, track };
  }

  // Both loaders use one downloader, with the existing CDN policy, retries,
  // thread budget and transfer statistics. FetchLoader can swallow reader errors:
  // finish and validate the range before resolving fetch, so failure rejects the
  // request instead of becoming an invisible error in a partially delivered body.
  async function download(plan, signal, progress = () => {}) {
    const { owner, range, track } = plan;
    if (signal?.aborted) throw signal.reason;
    if (owner.disposed) throw new DOMException("加速任务已停止", "AbortError");
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    owner.jobs.add(controller);
    track.jobs?.add(controller);
    let received = 0, total = null;
    const chunks = [];
    // Only a start gets the startup treatment (racing the head on every node, copying each
    // piece early): the first media of a track, a seek, a retry. The segment that follows
    // the last one delivered is an ordinary download; treating every request as a start
    // cost a third to half of each segment's time and a fifth of the traffic.
    const following = Boolean(track.warmEnd) && range.start === track.warmEnd;
    try {
      const result = await owner.downloader.downloadRange(range, owner.resolver(plan.url, track), {
        signal: controller.signal, parallel: true, startup: !following, kind: track.kind,
        onOrderedChunk(bytes, piece, fileTotal) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (piece.start !== range.start + received || bytes.byteLength !== piece.length
            || !Number.isSafeInteger(fileTotal) || fileTotal <= range.end
            || (total !== null && total !== fileTotal)) throw new Error("媒体 Range 校验失败");
          total = fileTotal;
          chunks.push(bytes);
          received += bytes.byteLength;
          progress(received, total);
        }
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      if (received !== range.length || result.total !== total) throw new Error("媒体 Range 长度不符");
      const bytes = core.concatChunks(chunks, received);
      // The init segment and the index are small and come first; media follows them.
      if (track.warmEnd || range.length > 64 * 1024) track.warmEnd = range.end + 1;
      owner.delivered(track, result);
      return { bytes, headers: new Headers({
        "Content-Type": track.representation.mimeType || track.representation.mime_type || `${track.kind}/mp4`,
        "Content-Length": String(range.length), "Content-Range": `bytes ${range.start}-${range.end}/${total}`,
        "Accept-Ranges": "bytes"
      }) };
    } catch (error) {
      track.warmEnd = 0;
      if (!controller.signal.aborted && !owner.disposed) owner.failed(error, track);
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      controller.abort();
      signal?.removeEventListener("abort", cancel);
      owner.jobs.delete(controller);
      track.jobs?.delete(controller);
    }
  }

  function responseURL(response, url) {
    const clone = response.clone.bind(response);
    Object.defineProperties(response, {
      url: { value: url },
      clone: { value: () => responseURL(clone(), url) }
    });
    return response;
  }

  function interceptedFetch(input, init) {
    const url = input instanceof Request ? input.url : String(input);
    const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!active || method !== "GET" || !core.isBilibiliMediaUrl(url)) return passthroughFetch(input, init);
    let request;
    try { request = new Request(input instanceof Request ? input : new URL(String(input), root.location.href), init); }
    catch (_error) { return passthroughFetch(input, init); }
    const plan = request.mode === "no-cors" || request.integrity ? null
      : planRequest(request.url, request.method, request.headers, request.credentials);
    if (!plan) return passthroughFetch(input, init);
    return download(plan, request.signal).then(({ bytes, headers }) => {
      if (request.signal.aborted) throw request.signal.reason;
      return responseURL(new Response(bytes, { status: 206, statusText: "Partial Content", headers }), request.url);
    });
  }

  // Preserve the actual XMLHttpRequest object, event handlers and prototype. Only
  // eligible arraybuffer requests receive a synthetic response. Calling open()
  // again restores all native response accessors before the object is reused.
  const proto = root.XMLHttpRequest.prototype;
  // Taken when the interception is installed, so anything already wrapping fetch or
  // XMLHttpRequest (the playurl reader of page-hook.js) stays in the chain.
  let nativeOpen, nativeSend, nativeAbort, nativeSetHeader, nativeGetHeader, nativeGetHeaders;
  const requests = new WeakMap();
  const fields = ["readyState", "status", "statusText", "response", "responseText", "responseURL"];
  function emit(xhr, type, progress) {
    xhr.dispatchEvent(progress ? new ProgressEvent(type, progress) : new Event(type));
  }
  function restore(xhr, entry) {
    if (!entry?.synthetic) return;
    for (const key of fields) {
      const descriptor = entry.descriptors[key];
      if (descriptor) Object.defineProperty(xhr, key, descriptor);
      else delete xhr[key];
    }
    entry.synthetic = false;
  }
  function isCurrent(xhr, entry) { return requests.get(xhr) === entry && entry.sending; }
  function finish(xhr, entry, type) {
    if (!isCurrent(xhr, entry)) return;
    clearTimeout(entry.timer);
    entry.sending = false;
    entry.state = 4;
    emit(xhr, "readystatechange");
    if (requests.get(xhr) !== entry || entry.state !== 4) return;
    const progress = { lengthComputable: type === "load", loaded: entry.body?.byteLength || 0, total: entry.body?.byteLength || 0 };
    emit(xhr, type, progress);
    if (requests.get(xhr) === entry) emit(xhr, "loadend", progress);
  }
  const patchedOpen = function (method, url, async = true, ...rest) {
    const previous = requests.get(this);
    requests.delete(this);
    if (previous) {
      previous.sending = false;
      clearTimeout(previous.timer);
      previous.controller?.abort();
      restore(this, previous);
    }
    const result = nativeOpen.call(this, method, url, async, ...rest);
    requests.set(this, { method: String(method).toUpperCase(), url: new URL(String(url), root.location.href).href,
      async: async !== false, headers: new Headers(), authenticated: rest.some(value => value != null), sending: false, synthetic: false });
    return result;
  };
  const patchedSetRequestHeader = function (name, value) {
    const entry = requests.get(this);
    if (entry?.synthetic) throw new DOMException("Call open() before sending again", "InvalidStateError");
    const result = nativeSetHeader.call(this, name, value);
    entry?.headers.append(name, value);
    return result;
  };
  const patchedGetResponseHeader = function (name) {
    const entry = requests.get(this);
    return entry?.synthetic ? (entry.state >= 2 ? entry.responseHeaders.get(name) : null) : nativeGetHeader.call(this, name);
  };
  const patchedGetAllResponseHeaders = function () {
    const entry = requests.get(this);
    return entry?.synthetic ? (entry.state >= 2 ? [...entry.responseHeaders].map(([key, value]) => `${key}: ${value}\r\n`).join("") : "") : nativeGetHeaders.call(this);
  };
  const patchedAbort = function () {
    const entry = requests.get(this);
    if (!entry?.synthetic) return nativeAbort.call(this);
    entry.status = 0; entry.statusText = ""; entry.responseUrl = ""; entry.body = null; entry.responseHeaders = new Headers();
    if (entry.sending) {
      entry.controller.abort();
      finish(this, entry, "abort");
    }
    if (requests.get(this) === entry && !entry.sending) entry.state = 0;
  };
  const patchedSend = function (body) {
    const entry = requests.get(this);
    if (entry?.synthetic) throw new DOMException("Call open() before sending again", "InvalidStateError");
    if (this.readyState !== 1) return nativeSend.call(this, body);
    const plan = entry?.async && !entry.authenticated && body == null && this.responseType === "arraybuffer"
      ? planRequest(entry.url, entry.method, entry.headers, this.withCredentials ? "include" : "same-origin") : null;
    if (!plan) return nativeSend.call(this, body);
    entry.sending = true; entry.synthetic = true; entry.state = 1;
    entry.status = 0; entry.statusText = ""; entry.body = null; entry.responseUrl = "";
    entry.responseHeaders = new Headers(); entry.controller = new AbortController();
    entry.descriptors = Object.fromEntries(fields.map(key => [key, Object.getOwnPropertyDescriptor(this, key)]));
    Object.defineProperties(this, {
      readyState: { configurable: true, get: () => entry.state },
      status: { configurable: true, get: () => entry.status },
      statusText: { configurable: true, get: () => entry.statusText },
      response: { configurable: true, get: () => entry.state === 4 ? entry.body : null },
      responseText: { configurable: true, get() { throw new DOMException("arraybuffer response", "InvalidStateError"); } },
      responseURL: { configurable: true, get: () => entry.responseUrl }
    });
    if (this.timeout > 0) entry.timer = setTimeout(() => {
      if (!isCurrent(this, entry)) return;
      entry.controller.abort();
      entry.status = 0; entry.statusText = ""; entry.responseUrl = ""; entry.responseHeaders = new Headers();
      finish(this, entry, "timeout");
    }, this.timeout);
    emit(this, "loadstart", { lengthComputable: false, loaded: 0, total: 0 });
    if (!isCurrent(this, entry)) return;
    entry.loaded = 0;
    const reportProgress = (received, total) => {
      if (!isCurrent(this, entry)) return;
      if (entry.state === 1) {
        entry.status = 206; entry.statusText = "Partial Content"; entry.responseUrl = entry.url;
        entry.responseHeaders = new Headers({ "content-range": `bytes ${plan.range.start}-${plan.range.end}/${total}`, "content-length": String(plan.range.length), "content-type": plan.track.representation.mimeType || plan.track.representation.mime_type || `${plan.track.kind}/mp4` });
        entry.state = 2; emit(this, "readystatechange");
      }
      if (!isCurrent(this, entry) || received <= entry.loaded) return;
      entry.loaded = received;
      entry.state = 3; emit(this, "readystatechange");
      if (isCurrent(this, entry)) emit(this, "progress", { lengthComputable: true, loaded: received, total: plan.range.length });
    };
    download(plan, entry.controller.signal, reportProgress).then(result => {
      if (!isCurrent(this, entry)) return;
      entry.responseHeaders = result.headers; entry.responseUrl = entry.url;
      entry.body = result.bytes.buffer;
      finish(this, entry, "load");
    }).catch(() => {
      if (!isCurrent(this, entry)) return;
      entry.status = 0; entry.statusText = ""; entry.responseUrl = ""; entry.body = null; entry.responseHeaders = new Headers();
      finish(this, entry, "error");
    });
  };

  // Only a player of this mode installs the interception, and what is in place then keeps
  // working under it. The other mode never sees any of this.
  let intercepting = false;
  function installInterception() {
    if (intercepting) return;
    intercepting = true;
    passthroughFetch = root.fetch.bind(root);
    nativeOpen = proto.open;
    nativeSend = proto.send;
    nativeAbort = proto.abort;
    nativeSetHeader = proto.setRequestHeader;
    nativeGetHeader = proto.getResponseHeader;
    nativeGetHeaders = proto.getAllResponseHeaders;
    root.fetch = interceptedFetch;
    proto.open = patchedOpen;
    proto.setRequestHeader = patchedSetRequestHeader;
    proto.getResponseHeader = patchedGetResponseHeader;
    proto.getAllResponseHeaders = patchedGetAllResponseHeaders;
    proto.abort = patchedAbort;
    proto.send = patchedSend;
  }

  function createNativePlayer(options) {
    const video = options.container.querySelector("video");
    if (!video) throw new Error("没有找到 B 站原生 video 元素");
    installInterception();
    if (active) active.destroy();
    let tracks = [], lastVideo = null, lastAudio = null;
    let delivered = 0, failures = 0, nativeSwitchRequests = 0;
    let qualityState = "", guardedDash = null, releaseGuard = null;
    let coreWaitStarted = null, coreWaitTimer = null;
    const cache = new Map(), jobs = new Set(), timeline = [];
    let lastError = "";
    const settings = () => core.normalizeSettings(options.getSettings());
    // In English for the diagnostic copy; an error goes in as the message it was thrown with.
    const note = (what, detail = "") => {
      timeline.push({ at: Math.round(performance.now()), time: Math.round((Number(video.currentTime) || 0) * 10) / 10, what, detail: String(detail) });
      if (timeline.length > 120) timeline.shift();
    };
    const update = playinfo => {
      const dash = playinfo?.data?.dash || playinfo?.result?.dash || playinfo?.dash;
      if (!dash) return;
      const audio = [...(dash.audio || []), ...[].concat(dash.dolby?.audio || [], dash.flac?.audio || [])];
      tracks = (dash.video || []).map(representation => ({ kind: "video", representation }))
        .concat(audio.map(representation => ({ kind: "audio", representation })));
      // Retain healthy-node history across same-video playurl updates.
    };
    update(options.playinfo);
    const urls = representation => [representation.baseUrl || representation.base_url, ...[].concat(representation.backupUrl || representation.backup_url || [])].filter(Boolean);
    const pathOf = url => { try { return new URL(url).pathname; } catch (_error) { return ""; } };
    // A file of this video that the playinfo BTR holds does not list (#71). Another script
    // can hand Bilibili's player a playinfo of its own, with a quality or an address BTR
    // never saw; BTR reads Bilibili's answers before such a script changes them. The
    // request is still the player's own and goes to a Bilibili video server, so it is sped
    // up like the others, from its own address: the servers of the list are asked for the
    // same file. It used to be left alone, and with it the whole video track, while the
    // audio next to it was sped up.
    //
    // Only files of the video being played: a file is named after the video's cid, and the
    // files BTR knows give that away. A preview or an advertisement elsewhere on the page
    // is not this player's business. A file the other servers refuse is left to Bilibili
    // from then on.
    const outside = new Map();
    // Their refusals are counted apart from the ban list of the listed files: an address
    // another script brought along must not get a server banned for the rest of the video.
    const outsideBans = resolvers.createBanList();
    // After this many refusals (HTTP 4xx) the file is left to Bilibili at once: the
    // downloader would otherwise try every server for every piece, three rounds each.
    const OUTSIDE_REFUSALS = 3;
    const watched = new Map();
    let transferIds = 0;
    function watchTransfer(event) {
      if (event?.phase === "start") {
        const id = options.onTransfer ? options.onTransfer(event) : ++transferIds;
        const track = outside.get(pathOf(event.url));
        if (track) watched.set(id, track);
        return id;
      }
      const track = watched.get(event?.id);
      if (track && event.phase !== "progress") {
        watched.delete(event.id);
        const status = Number(event.error?.status) || 0;
        if (event.phase === "error" && status >= 400 && status < 500 && !track.refused && ++track.refusals >= OUTSIDE_REFUSALS) {
          track.refused = true;
          note("file outside the playinfo left to Bilibili", `HTTP ${status} from the other servers`);
          for (const controller of track.jobs) controller.abort(new Error("其他服务器没有这个文件"));
        }
      }
      return options.onTransfer ? options.onTransfer(event) : event?.id;
    }
    const cidOf = url => /\/(\d+)[^/]*-\d+-\d+\.m4s$/.exec(pathOf(url))?.[1] || "";
    function outsideTrack(url) {
      const path = pathOf(url), cid = cidOf(url);
      if (!cid || !tracks.some(track => urls(track.representation).some(candidate => cidOf(candidate) === cid))) return null;
      let track = outside.get(path);
      if (!track) {
        if (outside.size >= 16) outside.delete(outside.keys().next().value);
        // Bilibili numbers its audio files 30216, 30232, 30280 (AAC), 30250 (Dolby) and 30251 (Hi-Res).
        const id = Number(/-(\d+)\.m4s$/.exec(path)?.[1]) || 0;
        track = { kind: [30216, 30232, 30280, 30250, 30251].includes(id) ? "audio" : "video", representation: { id: 0, baseUrl: url, base_url: url },
          outside: true, refused: false, refusals: 0, failures: 0, jobs: new Set() };
        outside.set(path, track);
        note("file outside the playinfo", `${track.kind} ${path.slice(path.lastIndexOf("/") + 1)}`);
      }
      return track.refused ? null : track;
    }
    function unavailable(error) {
      if (owner.disposed) return;
      owner.destroy();
      lastError = `原生播放器接口发生变化，已停止加速：${error?.message || error}`;
      note("native quality guard unavailable", `acceleration stopped: ${error?.message || error}`);
      options.onState?.({ playerState: "native-fallback", lastError });
    }
    function sampleQuality() {
      if (owner.disposed || !settings().enabled) return false;
      try {
        const dash = nativeCore(video);
        if (dash !== guardedDash) {
          releaseGuard?.(); releaseGuard = null; guardedDash = null;
        }
        if (!dash) {
          // Codec/source changes can briefly remove the native core. Suspend
          // interception during that gap; never accelerate without the guard.
          if (coreWaitStarted === null) {
            coreWaitStarted = performance.now();
            for (const controller of jobs) controller.abort();
            note("native core transition: acceleration suspended");
          }
          if (performance.now() - coreWaitStarted >= 3000) throw new Error("原生内核未恢复");
          coreWaitTimer ??= setTimeout(() => { coreWaitTimer = null; sampleQuality(); }, 100);
          return false;
        }
        clearTimeout(coreWaitTimer); coreWaitTimer = null; coreWaitStarted = null;
        if (!releaseGuard) {
          releaseGuard = attachQualityGuard(dash, video, note, unavailable);
          guardedDash = dash;
        }
        const quality = root.player?.getQuality?.();
        const value = `${quality?.nowQ}/${quality?.newQ}/${quality?.realQ}`;
        if (value !== qualityState) { qualityState = value; note("native quality now/target/rendered", value); }
        return true;
      } catch (error) { unavailable(error); return false; }
    }
    const publish = () => {
      if (owner.disposed) return;
      sampleQuality();
      if (owner.disposed) return;
      const playing = tracks.find(track => track.kind === "video" && Number(track.representation.id) === Number(qualityState.split("/")[0]))?.representation;
      options.onState?.({ playerState: video.error ? "error" : video.ended ? "ended" : video.readyState >= 3 ? "ready" : "buffering",
        lastError: video.error ? video.error.message || `media error ${video.error.code}` : lastError,
        // "native" when Bilibili's player has not said which it plays.
        mode: settings().mode, quality: playing ? root.__BILI_NATIVE_MSE_PLAYER_FACTORY__?.qualityLabel?.(playing) || String(playing.id) : "native",
        bufferedAhead: bufferedAhead(), cdnHosts: [...cache.values()].flatMap(resolver => resolver.status()) });
    };
    function bufferedAhead() {
      const time = Number(video.currentTime) || 0;
      for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= time && video.buffered.end(i) > time) return video.buffered.end(i) - time;
      return 0;
    }
    const owner = {
      disposed: false, jobs, settings, sampleQuality,
      track: url => tracks.find(track => urls(track.representation).some(candidate => pathOf(candidate) === pathOf(url))) || outsideTrack(url),
      resolver(url, track) {
        const parsed = new URL(url), key = parsed.pathname + parsed.search;
        if (!cache.has(key)) {
          if (cache.size >= 64) cache.delete(cache.keys().next().value);
          cache.set(key, resolvers.createResolver({ ...track.representation, baseUrl: url, base_url: url }, () => settings().mode,
            track.outside ? outsideBans : options.cdnBans, () => settings().customHosts));
        }
        return cache.get(key);
      },
      delivered(track, result) {
        if (owner.disposed) return;
        if (track.kind === "video") lastVideo = track.representation;
        else lastAudio = track.representation;
        if (track.outside) track.failures = 0;
        lastError = "";
        delivered++;
        note("native range delivered", `${track.kind} ${result.byteLength} bytes / ${result.pieceCount} pieces`);
        options.onSegment?.({ kind: track.kind, bytes: result.byteLength, pieces: result.pieceCount, hosts: result.hosts });
        publish();
      },
      nativeSwitchRequest() {
        nativeSwitchRequests++;
        note("quality switch: accelerated request");
      },
      failed(error, track) {
        // One failure can be the network's, and Bilibili's player asks again. Two in a row:
        // from now on it gets this file from where it asked.
        if (track?.outside && !track.refused && ++track.failures >= 2) {
          track.refused = true;
          note("file outside the playinfo left to Bilibili", String(error?.message || error));
        }
        failures++;
        lastError = String(error?.message || error);
        note("native range failed", lastError);
        publish();
        // Reject the original loader request; Bilibili owns playback recovery.
      },
      destroy() {
        if (owner.disposed) return;
        owner.disposed = true;
        clearTimeout(coreWaitTimer); coreWaitTimer = null;
        releaseGuard?.(); releaseGuard = null; guardedDash = null;
        for (const controller of jobs) controller.abort();
        events.abort();
        if (active === owner) active = null;
        // The native media source, buffers, playback position and pause state are untouched.
      }
    };
    owner.downloader = downloaders.createDownloader({ getSettings: settings, nativeFetch, onTransfer: watchTransfer });
    const events = new AbortController();
    for (const name of ["playing", "waiting", "stalled", "seeking", "seeked", "ended", "loadedmetadata", "error", "progress", "timeupdate"]) video.addEventListener(name, () => {
      if (name !== "timeupdate" && name !== "progress") note(`media ${name}`, `buffer ${bufferedAhead().toFixed(2)}s`);
      if (name === "playing") lastError = "";
      if (name === "timeupdate") sampleQuality();
      else publish();
    }, { signal: events.signal });
    active = owner;
    note("native transport attached");
    queueMicrotask(publish);
    return Object.freeze({
      nativeTransport: true, video,
      get transportActive() { return !owner.disposed && settings().enabled && !!releaseGuard && coreWaitStarted === null; },
      applySettings() {
        if (owner.disposed) return;
        if (!settings().enabled) { owner.destroy(); return; }
        owner.downloader.applySettings(); sampleQuality();
      },
      async updatePlayinfo(playinfo) { update(playinfo); },
      destroy: owner.destroy,
      getDebug: () => ({ architecture: "native-player-range-transport", transportRevision: 6, qualityGuardRevision: 11, nativeQualityGuard: !!guardedDash,
        qualityId: Number(qualityState.split("/")[0]) || 0, downloadedQualityId: Number(lastVideo?.id) || 0,
        width: video.videoWidth, height: video.videoHeight, currentTime: Number(video.currentTime) || 0,
        videoType: lastVideo?.mimeType || lastVideo?.mime_type || "", audioType: lastAudio?.mimeType || lastAudio?.mime_type || "",
        videoBandwidth: Number(lastVideo?.bandwidth) || 0, audioBandwidth: Number(lastAudio?.bandwidth) || 0,
        codec: lastVideo?.codecs || "", frameRate: (() => {
          const [n, d = 1] = String(lastVideo?.frameRate || lastVideo?.frame_rate || 0).split("/").map(Number);
          return d ? n / d : 0;
        })(),
        acceleratedRanges: delivered, failedRanges: failures, nativeSwitchRequests, filesOutsidePlayinfo: outside.size,
        nativeQuality: qualityState, nativeSwitchPending: nativeSwitchPending(), activeRequests: jobs.size,
        mediaSourceReplacements: 0, timeline: timeline.slice() })
    });
  }
  root.__BILI_NATIVE_RANGE_PLAYER_FACTORY__ = Object.freeze({
    createNativePlayer,
    supports(container) {
      try {
        const video = container?.querySelector("video");
        return !!video && !!nativeCore(video);
      } catch (_error) { return false; }
    }
  });
})(globalThis);

/* src/runtime-notices.js */
(function installRuntimeNotices(root) {
  "use strict";

  const EVENT_NAMES = ["playing", "pause", "waiting", "stalled", "seeking", "seeked", "ended", "error", "emptied", "loadedmetadata", "canplay", "ratechange"];
  let settings = {};
  let attachment = null;
  let controller = null;
  let heartbeat = null;
  let lastTime = 0;
  let lastProgress = -Infinity;
  let lastReportedPlaying = null;
  // The element's own events, in English, for the diagnostic copy (diagnostic-report.js).
  // Capped so a stuttering stream cannot crowd out everything else; a repeat of the same
  // event within a second only counts up.
  const media = [];
  const MEDIA_LIMIT = 150;
  function remember(name, detail = "") {
    const at = Math.round(performance.now());
    const last = media.at(-1);
    if (last && last.name === name && last.detail === detail && at - last.at < 1000) {
      last.count = (last.count || 1) + 1;
      return;
    }
    media.push({ at, name, time: Math.round((Number(attachment?.video?.currentTime) || 0) * 10) / 10, detail });
    if (media.length > MEDIA_LIMIT) media.shift();
  }

  function current() {
    return attachment && attachment.video?.isConnected && attachment.isCurrent();
  }

  function sample() {
    if (!settings.enabled) return;
    const video = attachment?.video;
    const valid = Boolean(current());
    const now = performance.now();
    const time = Number(video?.currentTime) || 0;
    if (valid && !video.paused && !video.seeking && !video.ended && time > lastTime + 0.001) lastProgress = now;
    lastTime = time;
    const playing = valid && !video.paused && !video.ended && !video.seeking && !video.error && video.readyState >= 2 && now - lastProgress < 1800;
    if (playing !== lastReportedPlaying) {
      // The first sample after attaching only says where the watch started.
      if (valid && lastReportedPlaying !== null) remember("progress", playing ? "advancing" : "not advancing");
      lastReportedPlaying = playing;
    }
  }

  function stopWatch() {
    controller?.abort();
    controller = null;
    clearInterval(heartbeat);
    heartbeat = null;
    lastReportedPlaying = null;
    lastProgress = -Infinity;
  }

  function watch() {
    stopWatch();
    if (!settings.enabled || !attachment) return;
    const captured = attachment;
    const video = captured.video;
    controller = new AbortController();
    lastTime = Number(video.currentTime) || 0;
    for (const name of EVENT_NAMES) {
      video.addEventListener(name, () => {
        if (attachment !== captured || !current()) return;
        if (name === "playing") lastProgress = performance.now();
        else if (["pause", "waiting", "stalled", "seeking", "ended", "error", "emptied"].includes(name)) {
          lastProgress = -Infinity;
          lastTime = Number(video.currentTime) || 0;
        }
        remember(name, name === "error" ? `code ${video.error?.code || 0}${video.error?.message ? `: ${video.error.message}` : ""}`
          : name === "ratechange" ? `${Math.round((Number(video.playbackRate) || 0) * 100) / 100}x` : "");
        sample();
      }, { signal: controller.signal });
    }
    video.addEventListener("timeupdate", () => sample(), { signal: controller.signal });
    // A stalled picture fires no timeupdate, so only this heartbeat records "not advancing".
    heartbeat = setInterval(sample, 500);
    sample();
  }

  root.__BTR_RUNTIME_NOTICES__ = Object.freeze({
    history: () => media.map((entry) => ({ ...entry })),
    configure(next) {
      const changed = settings.enabled !== (next.enabled !== false);
      settings = { enabled: next.enabled !== false };
      if (changed) watch();
    },
    // Callers, the desktop app included, pass a route and a session; neither is used here.
    attach(video, _route, _session, isCurrent) {
      attachment = { video, isCurrent };
      watch();
    },
    detach(_reason) {
      stopWatch();
      attachment = null;
    }
  });
})(globalThis);

/* src/diagnostic-report.js */
// The diagnostic report that 复制诊断信息 copies, format 1. settings-panel.js only collects a
// snapshot of what each part of BTR knows at that moment; this file turns it into plain English
// ASCII text in one fixed layout, for the `text` field of an issue. It touches no DOM, so the
// same code runs in the page and under Node (dev/diagnostic-report-test.js).
//
// The layout keeps a few rules so that a report reads at a glance and two reports diff line by
// line: one clock (T+s.mmm, seconds since the top document loaded), one fact per line, every key
// printed in the same order (n/a when its source is absent, none for an empty list, - for a
// table cell with nothing measured), fixed units (B/KiB/MiB, Mbit/s, ms or s) and no raw floats.
// BTR's own Chinese messages become English through translate(); text it does not know
// (Bilibili's own messages) is replaced, and a last pass over every line takes the query off any
// address, drops cookie and signature fields and turns whatever is still not ASCII into "?".
(function installDiagnosticReport(root) {
  "use strict";

  const FORMAT = "1";
  const LINE_LIMIT = 200;
  // GitHub takes 65 536 characters in an issue body; the rest is left for the form's own text
  // and what the viewer writes.
  const CHAR_LIMIT = 48000;
  const EVENT_LIMIT = 400;
  const NODE_LIMIT = 40;
  const LIVE_LIMIT = 4;
  const LIVE_NODE_LIMIT = 16;
  // Adjacent repeats of one event within this time are printed once, with a count.
  const FOLD_MS = 10000;

  // bridge.js DEFAULTS, the stored settings before anything is changed: Settings marks every
  // value that differs with *. dev/diagnostic-report-test.js checks that the two stay equal.
  const DEFAULTS = Object.freeze({ enabled: true, liveEnabled: false, episodeEnabled: true, blockInternational: false, bufferAheadSeconds: 45, secondaryBuffer: false, theme: "auto", concurrency: 8, autoConcurrency: true, takeover: "full", mode: "mainland", customHosts: Object.freeze([]), floatingButton: true, floatingButtonLeft: null, floatingButtonTop: null, guideDone: false });

  // English names of Bilibili's quality ids; the player's own labels are Chinese (1080P 60帧).
  const QUALITY_LABELS = Object.freeze({ 127: "8K", 126: "Dolby Vision", 125: "HDR", 120: "4K", 116: "1080P60", 112: "1080P+", 80: "1080P", 74: "720P60", 64: "720P", 32: "480P", 16: "360P", 6: "240P" });
  const READY_STATES = ["HAVE_NOTHING", "HAVE_METADATA", "HAVE_CURRENT_DATA", "HAVE_FUTURE_DATA", "HAVE_ENOUGH_DATA"];
  const NETWORK_STATES = ["EMPTY", "IDLE", "LOADING", "NO_SOURCE"];
  const MEDIA_ERRORS = Object.freeze({ 1: "MEDIA_ERR_ABORTED", 2: "MEDIA_ERR_NETWORK", 3: "MEDIA_ERR_DECODE", 4: "MEDIA_ERR_SRC_NOT_SUPPORTED" });

  // ---- translation ----

  // Every message BTR itself writes in Chinese: what its errors are thrown with (the cancel
  // reasons among them), what 自动线程数 gives as its reason, and the few Chinese words older
  // builds left in their English records. The patterns also match inside a longer text, as in
  // "range failed: video <host> after 0 KiB: 并发副本已取消", and keep the numbers and hosts
  // around them. A message that wraps another comes first, and each message before the shorter
  // ones it ends with (并发副本已取消 before 已取消, 媒体 Range 校验失败 before Range 校验失败).
  const DICTIONARY = [
    [/原生播放器接口发生变化，?已停止加速：?\s*/g, "native player API changed, acceleration stopped: "],
    // Downloads: idm-downloader.js and range-core.js.
    [/并发副本已取消/g, "hedge lost"],
    [/播放器任务已取消/g, "player task cancelled"],
    [/播放任务已取消/g, "session cancelled"],
    [/播放清单请求已取消/g, "playlist request cancelled"],
    [/已经跳到新的位置/g, "seeked elsewhere"],
    [/播放内核发生错误/g, "player core failed"],
    [/B ?站原生播放器正在切换媒体源/g, "Bilibili's player is switching sources"],
    [/CDN ?首字节超时/g, "CDN first byte timed out"],
    [/CDN ?子块停止传输/g, "CDN piece stalled"],
    [/CDN ?子块总耗时超限/g, "CDN piece took too long"],
    [/媒体 ?Range ?校验失败/g, "media range check failed"],
    [/媒体 ?Range ?长度不符/g, "media range length mismatch"],
    [/Range ?校验失败：?\s*/g, "range check failed: "],
    [/子块长度不符：?\s*/g, "piece length mismatch: "],
    [/子区间超出目标长度/g, "sub-range past the target length"],
    [/子区间长度不符：?\s*/g, "sub-range length mismatch: "],
    [/没有可用 ?CDN/g, "no usable CDN"],
    [/不同 ?CDN ?返回的文件总长度不一致/g, "CDNs disagree on the file size"],
    // The full takeover: native-mse-player.js.
    [/页面没有 ?DASH ?播放清单/g, "page has no DASH playlist"],
    [/新视频没有 ?DASH ?播放清单/g, "new video has no DASH playlist"],
    [/这一集没有 ?DASH ?播放清单/g, "episode has no DASH playlist"],
    [/浏览器不支持清单中的视频或音频编码/g, "browser supports none of the playlist's codecs"],
    [/播放清单缺少初始化或 ?SIDX ?字节范围/g, "playlist lacks init or SIDX ranges"],
    [/空的缓冲区间/g, "empty buffered range"],
    [/没有找到 ?B ?站原生 ?video ?元素/g, "Bilibili's video element not found"],
    [/(?:(视频|音频)\s*)?SIDX ?解析失败/g, (_match, kind) => `${kind === "视频" ? "video " : kind === "音频" ? "audio " : ""}SIDX parse failed`],
    // waitEvent: `${successName} 失败`, the name of the event that never came.
    [/([\w-]+) 失败/g, "$1 failed"],
    // The compatibility mode: native-range-transport.js.
    [/原生播放器接口不兼容/g, "native player API incompatible"],
    [/原生缓冲接口不兼容/g, "native buffer API incompatible"],
    [/原生调度接口不兼容/g, "native scheduler API incompatible"],
    [/原生内核未恢复/g, "native core not restored"],
    [/加速任务已停止/g, "transport stopped"],
    [/其他服务器没有这个文件/g, "the other servers do not have this file"],
    // The page: page-hook.js.
    [/视频已经换了/g, "video changed"],
    [/B ?站 ?15 ?秒内没有回应/g, "Bilibili did not answer within 15 s"],
    [/读取视频信息失败/g, "video info request failed"],
    [/新视频缺少 ?CID/g, "new video has no CID"],
    [/读取播放清单失败/g, "playlist request failed"],
    [/未知接管错误/g, "unknown takeover error"],
    [/\s*[（(]兼容模式[)）]/g, " (compat)"],
    [/兼容模式/g, "compat"],
    [/全接管/g, "full"],
    // Live: live-hook.js.
    [/直播已切换或加速已关闭/g, "live stream changed or acceleration off"],
    [/直播节点探测超时/g, "live node probe timed out"],
    [/直播分片响应异常：?\s*/g, "live segment failed: "],
    [/直播分片只返回了一部分/g, "live segment came back partial"],
    [/直播分片首字节超时/g, "live segment first byte timed out"],
    [/直播分片为空/g, "live segment empty"],
    [/直播分片长度不对：?\s*收到\s*([^，,]*?)\s*[，,]\s*应为\s*/g, "live segment length wrong: got $1, expected "],
    [/没有可用直播节点/g, "no usable live node"],
    [/直播分片总超时/g, "live segment timed out"],
    [/直播/g, "live"],
    // 自动线程数: idm-downloader.js, and the stalls native-mse-player.js reports to it.
    [/开头已经跟上，?\s*线程数降到\s*(\d+)/g, "start caught up, down to $1"],
    [/开头先用\s*(\d+)\s*线程/g, "start with $1 threads"],
    [/(\d+)\s*线程没有比\s*(\d+)\s*线程更快/g, "$1 threads were not faster than $2"],
    [/服务器返回\s*(\d+)/g, "server returned HTTP $1"],
    [/播放卡了一下/g, "playback stalled"],
    [/前方缓冲快用完了/g, "buffer nearly empty"],
    [/缓冲跟不上播放/g, "buffer not keeping up"],
    [/连接排队等太久/g, "connections queued too long"],
    [/起步/g, "initial"],
    // The player's quality labels, which older builds wrote into their timelines.
    [/杜比视界/g, "Dolby Vision"],
    [/(\d+P) ?(\d+)帧/g, "$1$2"],
    [/(\d+P) ?高码率/g, "$1+"],
    [/(\d+)帧/g, "$1 fps"],
    [/清晰度 ?/g, "qn "],
    [/已取消/g, "cancelled"]
  ];
  const PUNCTUATION = [
    [/：/g, ": "], [/[，、]/g, ", "], [/；/g, "; "], [/。/g, ". "], [/（/g, " ("], [/）/g, ")"],
    [/！/g, "! "], [/？/g, "? "], [/[“”「」『』]/g, "\""], [/[‘’]/g, "'"], [/[—–―]/g, "-"],
    [/…/g, "..."], [/→/g, "->"], [/←/g, "<-"], [/×/g, "x"], [/[·•‧∙⋅]/g, ", "], [/[\u00a0\u3000]/g, " "]
  ];
  const CJK_RUN = /[\u2e80-\u2fff\u3000-\u303f\u3040-\u31ff\u3200-\u9fff\ua000-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]+/g;
  const UNKNOWN = "[non-English text]";

  // Any text BTR may print, as English ASCII. ASCII comes back as it was; anything Chinese the
  // dictionary does not know, such as Bilibili's own API messages, becomes [non-English text],
  // and the numbers and codes around it stay.
  function translate(value) {
    let out = typeof value === "string" ? value
      : typeof value === "number" || typeof value === "boolean" ? String(value)
        : value && typeof value === "object" && typeof value.message === "string" ? value.message : "";
    if (!/[^\x00-\x7f]/.test(out)) return out;
    for (const [pattern, english] of DICTIONARY) out = out.replace(pattern, english);
    for (const [pattern, ascii] of PUNCTUATION) out = out.replace(pattern, ascii);
    try { out = out.normalize("NFKC"); } catch (_error) {}
    // One marker per stretch of unknown text, so "请求错误 请稍后再试" is one placeholder.
    out = out.replace(CJK_RUN, "\ue000").replace(/\ue000(?:[\s,.;:!?'"-]*\ue000)*/g, UNKNOWN);
    return out.replace(/[^\x00-\x7f]/g, "?").replace(/ {2,}/g, " ").replace(/ +([,.;:)])/g, "$1").trim();
  }

  // ---- reading the snapshot ----

  // The snapshot comes from several sources that may be missing, older, or broken; each value
  // is read as the type it should have, or as nothing.
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  const list = (value) => Array.isArray(value) ? value : [];
  const num = (value) => {
    const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    return Number.isFinite(number) ? number : null;
  };
  const bool = (value) => typeof value === "boolean" ? value : null;
  const text = (value) => typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";

  // ---- units ----

  const yesNo = (value) => value === true ? "yes" : value === false ? "no" : "n/a";
  const count = (value) => { const n = num(value); return n === null ? "n/a" : String(Math.round(n)); };
  const plural = (value, one, many = `${one}s`) => { const n = num(value); return n === null ? `n/a ${many}` : `${Math.round(n)} ${Math.round(n) === 1 ? one : many}`; };
  const fixed = (value, digits) => { const n = num(value); return n === null ? "n/a" : (Math.abs(n) < 0.5 / 10 ** digits ? 0 : n).toFixed(digits); };
  // Media positions: 3 decimals in sections, 1 in the event list.
  const position = (value) => fixed(value, 3);
  const secondsAmount = (value) => num(value) === null ? "n/a" : `${fixed(value, 1)} s`;
  function size(value) {
    const bytes = num(value);
    if (bytes === null || bytes < 0) return "n/a";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const kib = bytes / 1024;
    if (kib < 10) return `${kib.toFixed(1)} KiB`;
    if (Math.round(kib) < 1024) return `${Math.round(kib)} KiB`;
    return `${(bytes / 1048576).toFixed(2)} MiB`;
  }
  // DASH bandwidth is bits per second already; the downloader's speeds are bytes per second
  // and are multiplied by 8 where they are read.
  const mbit = (bitsPerSecond) => num(bitsPerSecond) === null ? "n/a" : `${(num(bitsPerSecond) / 1e6).toFixed(2)} Mbit/s`;
  function duration(value) {
    const ms = num(value);
    if (ms === null) return "n/a";
    if (Math.abs(ms) < 10000) return `${Math.round(ms)} ms`;
    if (Math.abs(ms) < 600000) return `${(ms / 1000).toFixed(1)} s`;
    return `${(ms / 60000).toFixed(1)} min`;
  }
  const fps = (value) => Math.abs(value - Math.round(value)) < 0.01 ? String(Math.round(value)) : value.toFixed(2);
  function qn(value) {
    const id = Math.round(num(value) || 0);
    return QUALITY_LABELS[id] ? `qn ${id} (${QUALITY_LABELS[id]})` : `qn ${id}`;
  }
  function iso(ms, seconds = false) {
    const at = num(ms);
    if (at === null || Math.abs(at) > 8.64e15) return "n/a";
    const out = new Date(at).toISOString();
    return seconds ? out.replace(/\.\d{3}Z$/, "Z") : out;
  }
  // T+s.mmm on the top document's clock; the T column of the events holds the bare number.
  const seconds = (ms) => (Math.abs(ms) < 0.5 ? 0 : ms / 1000).toFixed(3);
  const stamp = (ms) => ms === null || ms === undefined ? "n/a" : `T${ms < 0 ? "-" : "+"}${seconds(Math.abs(ms))}`;

  // A short token from the data, such as a state, a mode or a codec.
  const word = (value, fallback = "n/a") => translate(text(value)).replace(/[^\w .:/+,()#-]/g, "").trim().slice(0, 60) || fallback;
  // Free text from the data, on one line, cut with "..." when it is too long for its place.
  function sentence(value, limit = 160) {
    const out = translate(value).replace(/\s+/g, " ").trim();
    return out.length > limit ? `${out.slice(0, limit - 3).trimEnd()}...` : out;
  }
  // A CDN host name, and nothing that could follow it in an address.
  const hostName = (value) => text(value).toLowerCase().replace(/^[a-z][\w+.-]*:\/\//, "").split(/[/?#\s]/)[0].replace(/[^a-z0-9.:[\]-]/g, "").slice(0, 64);
  // Numbers somebody printed with all their digits; not the ones inside a codec or a version
  // (avc1.640033). No lookbehind: the userscript bundle has to parse in older Safari too.
  const tidyNumbers = (value) => value.replace(/(^|[^\w.])(-?\d+\.\d{4,})(?![\w.])/g, (_match, before, number) => `${before}${Number(number).toFixed(3)}`);

  // An event's detail, which is mostly a string but may be a number, a flag or a small record.
  function detailText(value, depth = 0) {
    if (value === null || value === undefined || value === "") return "";
    if (typeof value === "number") return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "";
    if (typeof value === "boolean") return value ? "yes" : "no";
    if (depth > 1) return "";
    if (Array.isArray(value)) return value.slice(0, 8).map((item) => detailText(item, depth + 1)).filter(Boolean).join(", ");
    if (typeof value === "object") {
      if ("code" in value || "message" in value) return mediaError(value);
      return Object.entries(value).slice(0, 8).map(([key, item]) => `${word(key, "")} ${detailText(item, depth + 1)}`.trim()).filter(Boolean).join(", ");
    }
    return tidyNumbers(sentence(value, 200));
  }
  function mediaError(error) {
    const code = Math.round(num(error?.code) || 0);
    const message = sentence(error?.message);
    return `${code}${MEDIA_ERRORS[code] ? ` ${MEDIA_ERRORS[code]}` : ""}${message ? `: ${message}` : ""}`;
  }
  const codecsOf = (type) => (/codecs\s*=\s*"?([^";]+)"?/i.exec(text(type)) || [])[1]?.replace(/[^\w.,+-]/g, "").slice(0, 40) || "";
  const rangesOf = (value) => Array.isArray(value)
    ? value.slice(0, 8).map((range) => list(range).map(num)).filter(([start, end]) => start !== null && end !== null && end >= start)
    : null;

  // ---- the privacy pass ----

  // Signed media addresses carry their signature and expiry in the query, and a cookie string
  // that ended up in some message would carry the session. Every line goes through this, the
  // fixed text included, so nothing depends on each source having cleaned its own text.
  const URL_QUERY = /((?:https?:)?\/\/[^\s"'<>?#]+|\b[a-z0-9.-]+\.[a-z]{2,}\/[^\s"'<>?#]*)[?#][^\s"'<>]*/gi;
  const COOKIE_STRING = /(?:[\w.-]+=[^;\s]*;\s*){2,}[\w.-]+=[^;\s]*/g;
  const SECRET_NAMES = /\b(?:SESSDATA|bili_jct|DedeUserID(?:__ckMd5)?|buvid[\w-]*|upsig|uparams)\b(?:\s*[=:]\s*[^\s;&,"']*)?/gi;
  const SECRET_FIELDS = /\b(?:deadline|access_key|auth_key|csrf|token|sign|w_rid|wts|mid|uid)=[^\s;&,"']*/gi;
  const scrub = (line) => line.replace(URL_QUERY, "$1").replace(COOKIE_STRING, "[cookies removed]").replace(SECRET_NAMES, "[removed]").replace(SECRET_FIELDS, "[removed]");

  // One finished line: on one line, private fields out, ASCII, no trailing space, cut to fit.
  function clean(line) {
    let out = scrub(String(line ?? "").replace(/\r\n?|\n|\t/g, " ")).replace(/[^\x20-\x7e]/g, "?").trimEnd();
    if (out.length > LINE_LIMIT) out = `${out.slice(0, LINE_LIMIT - 3).trimEnd()}...`;
    return out;
  }

  // ---- layout ----

  // Key/value lines, the keys padded to the section's longest key + 2.
  function pairs(rows) {
    const width = Math.max(0, ...rows.map(([key]) => key.length)) + 2;
    return rows.map(([key, value]) => `${key.padEnd(width)}${value === "" || value === null || value === undefined ? "n/a" : value}`);
  }
  // A table: text columns left-aligned, numbers right-aligned, two spaces between columns.
  function table(header, rows, align) {
    const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)));
    const line = (cells) => cells.map((cell, index) => align[index] === "r" ? cell.padStart(widths[index]) : cell.padEnd(widths[index])).join("  ").trimEnd();
    return [line(header), ...rows.map(line)];
  }
  const heading = (block) => `== ${block.title} ==${block.note ? `  ${block.note}` : ""}`;

  // ---- the facts every section shares ----

  function facts(snapshot) {
    const capturedAt = num(snapshot.capturedAt), now = num(snapshot.now), origin = num(snapshot.timeOrigin);
    const video = object(snapshot.video);
    // page-hook.js runs in the top document, but its report says where its own clock starts.
    const ownOrigin = num(video?.timeOrigin);
    const videoDelta = ownOrigin !== null && origin !== null && Math.abs(ownOrigin - origin) < 864e5 ? ownOrigin - origin : 0;
    const clock = {
      capturedAt, now, origin,
      // performance.now() of a realm whose clock starts `delta` ms after the top document's.
      perf: (ms, delta = 0) => num(ms) === null ? null : num(ms) + (num(delta) || 0),
      // Date.now(), counted back from the capture: a clock change since the page loaded (a
      // sleep, a time sync) then does not move it.
      epoch: (ms) => {
        const at = num(ms);
        if (at === null || at <= 0) return null;
        if (capturedAt !== null && now !== null) return at - capturedAt + now;
        return origin !== null ? at - origin : null;
      }
    };
    return {
      snapshot, clock, video, videoDelta,
      player: object(video?.player),
      playback: object(video?.playback),
      downloads: object(video?.downloads),
      // A page without a video (home, search) has no engine to speak of; reports from before
      // videoPage existed count as video pages.
      engine: video?.videoPage !== false && ["full", "compat", "native"].includes(video?.actualTakeover) ? video.actualTakeover : null,
      settings: object(snapshot.settings),
      stats: object(snapshot.stats),
      auto: object(snapshot.autoThreads),
      site: object(snapshot.site),
      btr: object(snapshot.btr),
      env: object(snapshot.env),
      live: list(snapshot.live).slice(0, LIVE_LIMIT).map((module, index) => ({ ...(object(module) || {}), index }))
    };
  }

  // One row per CDN host: the node list of the player (video and audio already merged by host,
  // page-hook.js) together with the hosts the downloads went to, which can include hosts only
  // the start used or that a previous player listed.
  const STATE_ORDER = ["banned", "blocked", "healthy", "untested", "unlisted"];
  function nodeRows(c) {
    if (c.nodeRows !== undefined) return c.nodeRows;
    if (!c.video || !(Array.isArray(c.video.nodes) || Array.isArray(c.video.bannedNodes) || object(c.downloads?.hosts))) return (c.nodeRows = null);
    const byHost = new Map();
    for (const raw of list(c.video.nodes)) {
      const node = object(raw), host = hostName(node?.host);
      if (!host) continue;
      const state = STATE_ORDER.includes(node.state) ? node.state : word(node.state, "unknown").toLowerCase().replace(/\s+/g, "-");
      const known = byHost.get(host);
      if (!known || rank(state) < rank(known.state)) byHost.set(host, { host, state, bps: num(node.bps), traffic: null });
    }
    for (const raw of list(c.video.bannedNodes)) {
      const host = hostName(raw);
      if (host && !byHost.has(host)) byHost.set(host, { host, state: "banned", bps: null, traffic: null });
    }
    for (const [raw, traffic] of Object.entries(object(c.downloads?.hosts) || {})) {
      const host = hostName(raw);
      if (!host) continue;
      const row = byHost.get(host) || { host, state: "unlisted", bps: null, traffic: null };
      row.traffic = object(traffic) || {};
      byHost.set(host, row);
    }
    return (c.nodeRows = [...byHost.values()].sort((a, b) => rank(a.state) - rank(b.state)
      || (a.state === "healthy" ? (b.bps || 0) - (a.bps || 0) : 0) || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0)));
  }
  const rank = (state) => { const index = STATE_ORDER.indexOf(state); return index < 0 ? STATE_ORDER.length : index; };

  function nodeCounts(rows) {
    if (!rows) return "n/a";
    if (!rows.length) return "none";
    const counts = new Map();
    for (const row of rows) counts.set(row.state, (counts.get(row.state) || 0) + 1);
    const order = ["healthy", "untested", "blocked", "banned", "unlisted"];
    return [...counts].sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)).map(([state, n]) => `${n} ${state}`).join(", ");
  }

  // Requests per kind since the page loaded, and their sum.
  function kindTotals(downloads) {
    const byKind = object(downloads?.byKind);
    if (!byKind) return null;
    const totals = { started: 0, ok: 0, failed: 0, cancelled: 0, bytes: 0 };
    for (const kind of Object.values(byKind)) for (const key of Object.keys(totals)) totals[key] += num(object(kind)?.[key]) || 0;
    return totals;
  }
  function failedHosts(c) {
    return Object.values(object(c.downloads?.hosts) || {}).filter((host) => (num(object(host)?.failed) || 0) > 0).length;
  }

  const sessionEvents = (c) => list(c.video?.page).map(object).filter((event) => event?.what === "Bilibili replaced the video source");

  // ---- sections ----

  function header(c) {
    const btr = c.btr;
    return [
      `BTR diagnostics (format ${FORMAT}) | BTR ${btr ? `${word(btr.version)} ${word(btr.channel)}` : "n/a"} | captured ${iso(c.clock.capturedAt)}`,
      `Clock: T = seconds since page load at ${iso(c.clock.origin)}; captured at ${c.clock.now === null ? "n/a" : stamp(c.clock.now)}`
    ];
  }

  function summary(c) {
    const { video, player, playback, settings } = c;
    const setting = word(settings?.takeover ?? object(video?.settings)?.takeover);
    const frame = object(playback?.lastPresentedFrame), frames = object(playback?.frames);
    const picture = playback && `${frame ? `last frame at ${stamp(c.clock.perf(frame.observedAtMs, c.videoDelta))} (media ${position(frame.mediaTime)} s)` : "last frame n/a"}, ${count(frames?.total)} total, ${count(frames?.dropped)} dropped`;
    const playing = c.engine === "full" ? num(player?.qualityId) : c.engine === "compat" ? num(player?.downloadedQualityId) || num(player?.qualityId) : null;
    const quality = video && `playing ${playing > 0 ? qn(playing) : "n/a"}, menu ${menuQuality(object(video.nativeQuality))}`;
    const totals = kindTotals(c.downloads), active = num(c.downloads?.active);
    const requests = totals && `${Math.round(totals.started)}: ${Math.round(totals.ok)} ok, ${Math.round(totals.failed)} failed, ${Math.round(totals.cancelled)} cancelled${active > 0 ? `, ${Math.round(active)} active` : ""}`;
    return pairs([
      ["state", video ? word(video.state) : "n/a"],
      ["engine", `${c.engine || "n/a"} (setting ${setting})`],
      ["position", playback ? `${position(playback.currentTime)} / ${position(playback.duration)} s` : "n/a"],
      ["paused", playback ? `page ${yesNo(bool(playback.paused))}, element ${yesNo(elementPaused(c))}` : "n/a"],
      ["picture", picture],
      ["quality", quality],
      ["video", track(c, "video")],
      ["audio", track(c, "audio")],
      ["buffer ahead", bufferAhead(c)],
      ["threads", threads(c)],
      ["requests", requests],
      ["nodes", nodeCounts(nodeRows(c))],
      ["last error", video ? (text(video.lastError) ? sentence(video.lastError) : "none") : "n/a"]
    ]);
  }
  // BTR's player patches video.paused (what the page sees); the element's own state is read
  // through HTMLMediaElement.prototype, and the two disagreeing is a finding of its own (#65).
  const elementPaused = (c) => bool(c.playback?.elementPaused) ?? bool(c.player?.elementPaused);
  function menuQuality(menu) {
    if (!menu) return "n/a";
    if (num(menu.newQ) > 0) return qn(menu.newQ);
    return `auto (shows ${num(menu.realQ) > 0 ? `qn ${Math.round(menu.realQ)}` : "n/a"})`;
  }
  function track(c, kind) {
    const player = c.player;
    if (!player || !Object.keys(player).length) return "n/a";
    const video = kind === "video";
    const parts = [codecsOf(video ? player.videoType : player.audioType) || (video ? word(player.codec, "") : "")];
    if (video && num(player.width) > 0 && num(player.height) > 0) parts.push(`${Math.round(player.width)}x${Math.round(player.height)}`);
    if (video && num(player.frameRate) > 0) parts.push(`${fps(num(player.frameRate))} fps`);
    const bandwidth = num(video ? player.videoBandwidth : player.audioBandwidth);
    if (bandwidth > 0) parts.push(mbit(bandwidth));
    return parts.filter(Boolean).join(" ") || "n/a";
  }
  // From the element's buffered ranges at the capture; the player's last published value only
  // when an older build sent no ranges.
  function bufferAhead(c) {
    const ranges = rangesOf(c.playback?.buffered), time = num(c.playback?.currentTime);
    if (ranges && time !== null) {
      const around = ranges.find(([start, end]) => start <= time + 0.1 && time <= end);
      return `${fixed(around ? Math.max(0, around[1] - time) : 0, 1)} s`;
    }
    return c.video ? secondsAmount(c.stats?.bufferedAhead) : "n/a";
  }
  function threads(c) {
    const settings = c.settings;
    if (!settings) return "n/a";
    if (settings.autoConcurrency === true) {
      const current = num(c.auto?.threads) || num(c.stats?.autoThreads);
      return `${current ? Math.round(current) : "n/a"} (auto)`;
    }
    return settings.autoConcurrency === false ? `${count(settings.concurrency)} (manual)` : "n/a";
  }

  // Findings that restate facts from the sections below, most severe first. No guesses: each
  // rule names one condition on the data. The id column fits the longest id in the catalog, so
  // it lines up the same whichever checks fire.
  const CHECK_IDS = ["takeover-failed", "player-error", "media-error", "node-banned", "address-banned", "range-failures", "quality-mismatch", "settings-not-loaded", "other-build", "site-international", "site-gave-up", "live-error", "redirects-blocked", "source-replaced", "engine-differs", "tab-hidden"];
  const CHECK_WIDTH = Math.max(...CHECK_IDS.map((id) => id.length)) + 2;
  function checks(c) {
    const found = [];
    const add = (level, id, message) => found.push({ level, id, message });
    const { video, playback, settings, site, btr } = c;
    const takeoverError = object(c.stats?.takeoverError) || object(video?.takeoverError);
    if (takeoverError) {
      const at = c.clock.epoch(takeoverError.at);
      add("ERROR", "takeover-failed", `${word(takeoverError.stage, "unknown")}: ${sentence(takeoverError.message) || "no message"} (attempt ${count(takeoverError.retryCount)}${at === null ? "" : `, at ${stamp(at)}`})`);
    }
    if (video?.state === "error" && !(takeoverError && text(takeoverError.message) === text(video.lastError))) add("ERROR", "player-error", `state error: ${sentence(video.lastError) || "no message"}`);
    const mediaFailure = object(playback?.mediaError);
    if (mediaFailure) add("ERROR", "media-error", mediaError(mediaFailure));
    const bans = list(video?.bans).map(object).filter(Boolean);
    for (const ban of bans.filter((item) => item.kind !== "address")) {
      add("WARN", "node-banned", `${hostName(ban.host) || "n/a"}: ${plural(ban.count, "failure")} with no data${text(ban.error) ? ` (${sentence(ban.error, 80)})` : ""}`);
    }
    if (!Array.isArray(video?.bans)) for (const host of list(video?.bannedNodes).map(hostName).filter(Boolean)) add("WARN", "node-banned", `${host}: banned for this video`);
    for (const ban of bans.filter((item) => item.kind === "address")) {
      add("WARN", "address-banned", `a download address refused by the nodes, ${plural(ban.count, "failure")}, last on ${hostName(ban.host) || "n/a"}${text(ban.error) ? ` (${sentence(ban.error, 80)})` : ""}`);
    }
    const totals = kindTotals(c.downloads);
    if (totals?.failed > 0) {
      const hosts = failedHosts(c);
      add("WARN", "range-failures", `${plural(totals.failed, "failed request")}${hosts ? ` on ${plural(hosts, "node")}` : ""}`);
    }
    const menu = object(video?.nativeQuality), wanted = num(menu?.newQ), offered = list(c.player?.qualities ?? video?.qualities).map(num);
    if (c.engine === "full" && wanted > 0 && offered.includes(wanted) && num(c.player?.qualityId) !== wanted) {
      add("WARN", "quality-mismatch", `menu ${qn(wanted)}, playing ${num(c.player?.qualityId) > 0 ? qn(c.player.qualityId) : "n/a"}`);
    }
    if (!settings) add("WARN", "settings-not-loaded", "the stored settings had not reached the page at capture");
    if (text(btr?.otherBuild)) add("WARN", "other-build", `the ${word(btr.otherBuild)} build is enabled too and is not running on this page`);
    if (site?.international === true && settings?.blockInternational === true) add("WARN", "site-international", "international page while block international is on");
    if (site?.gaveUp === true) add("WARN", "site-gave-up", "BTR stopped sending this tab back to the domestic site");
    for (const module of c.live) {
      const error = text(object(module.stats)?.lastError);
      if (error) add("WARN", "live-error", `${liveName(module)}: ${sentence(error)}`);
    }
    if (num(site?.redirectsBlocked) > 0) add("INFO", "redirects-blocked", `${plural(site.redirectsBlocked, "redirect")} to the international site blocked`);
    const replaced = sessionEvents(c);
    if (replaced.length) {
      const times = replaced.reduce((sum, event) => sum + Math.max(1, Math.round(num(event.count) || 1)), 0);
      const last = c.clock.perf(replaced.at(-1).at, c.videoDelta);
      add("INFO", "source-replaced", `Bilibili replaced the video source ${plural(times, "time")}${last === null ? "" : ` (last at ${stamp(last)})`}`);
    }
    const setting = settings?.takeover ?? object(video?.settings)?.takeover;
    if (c.engine && settings?.enabled !== false && ["full", "compat"].includes(setting) && c.engine !== setting) add("INFO", "engine-differs", `setting ${setting}, running ${c.engine}`);
    if (playback?.visibility === "hidden") add("INFO", "tab-hidden", "the tab was hidden at capture");
    const order = ["ERROR", "WARN", "INFO"];
    found.sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level) || CHECK_IDS.indexOf(a.id) - CHECK_IDS.indexOf(b.id));
    return found.length ? found.map((item) => `${item.level.padEnd(6)}${item.id.padEnd(CHECK_WIDTH)}${item.message}`) : ["none"];
  }

  const PAGE_ID = /^(https?:\/\/(?:space\.bilibili\.com\/(?:[a-z-]+\/)?|m\.bilibili\.com\/space\/|(?:www\.|m\.)?bilibili\.com\/(?:[a-z-]+\/)?(?:list\/(?:ml)?|medialist\/(?:play|detail)\/(?:ml)?)))\d+/i;
  function environment(c) {
    const { btr, env } = c;
    const other = word(btr?.otherBuild, "");
    const manager = sentence(btr?.scriptManager, 80);
    // One line each, so a long first one cannot cut off the rest.
    const errors = Array.isArray(c.snapshot.readErrors) ? c.snapshot.readErrors.map((item) => sentence(item, 160)).filter(Boolean) : null;
    const errorRows = errors === null ? [["read errors", "n/a"]] : errors.length ? errors.map((item) => ["read error", item]) : [["read errors", "none"]];
    const viewport = text(env?.viewport);
    return pairs([
      ["btr", btr ? `${word(btr.version)} ${word(btr.channel)} (${word(btr.host)})` : "n/a"],
      ["other build", btr ? other ? `${other} (enabled, not running)` : "none" : "n/a"],
      ["manager", btr ? manager || (btr.host === "desktop" ? "none" : "n/a") : "n/a"],
      ["browser", sentence(env?.userAgent, 400) || "n/a"],
      ["language", word(env?.language)],
      ["viewport", /^\d{1,5}x\d{1,5}$/.test(viewport) ? viewport : "n/a"],
      // Origin and path only. A space page's path is someone's account number, and a
      // favourites list's is the number of someone's folder: both are left out.
      ["page", sentence(env?.page, 400).replace(PAGE_ID, "$1{id}") || "n/a"],
      ["route", word(c.video?.route)],
      ...errorRows
    ]);
  }

  // Which site Bilibili shows and why (#68). Cookies only as what they mean, never their value
  // (lang is a language code); signed in is only yes or no.
  function site(c) {
    const s = c.site;
    const userSite = !s ? "n/a" : s.userSite === "CN" || s.userSite === "OVERSEAS" ? s.userSite : text(s.userSite) ? "other" : "none";
    const accounts = Array.isArray(s?.accountSites) && s.accountSites.length ? s.accountSites : null;
    const account = !accounts ? "n/a" : accounts.includes("CN") ? "domestic allowed" : accounts.every((item) => item === "OVERSEAS") ? "international only" : "other";
    const lang = !s ? "n/a" : !text(s.lang) ? "none" : /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/.test(s.lang) ? s.lang : "other";
    return pairs([
      ["site", typeof s?.international === "boolean" ? s.international ? "international" : "domestic" : "n/a"],
      ["signed in", yesNo(bool(s?.signedIn))],
      ["user_site", userSite],
      ["account", account],
      ["lang cookie", lang],
      ["guard", ["on", "off", "unsupported"].includes(s?.guard) ? s.guard : "n/a"],
      ["blocked", s && num(s.redirectsBlocked) !== null ? plural(s.redirectsBlocked, "redirect") : "n/a"],
      ["gave up", yesNo(bool(s?.gaveUp))]
    ]);
  }

  // Only settings that matter for a report. The theme, the floating button, the guide and the
  // fixed download constants (implied by the version) are left out on purpose.
  function settingsSection(c) {
    const s = c.settings;
    // A value the snapshot does not have is unknown, not changed.
    const same = (key) => s[key] === undefined || JSON.stringify(s[key]) === JSON.stringify(DEFAULTS[key]);
    const mark = (value, ...keys) => `${value}${s && !keys.every(same) ? " *" : ""}`;
    const flag = (key) => s ? mark(yesNo(bool(s[key])), key) : "n/a";
    const hosts = s && (Array.isArray(s.customHosts) ? s.customHosts.map(hostName).filter(Boolean) : []);
    return pairs([
      ["enabled", flag("enabled")],
      ["takeover", s ? mark(word(s.takeover), "takeover") : "n/a"],
      ["cdn", s ? mark(word(s.mode), "mode") : "n/a"],
      ["custom hosts", s ? mark(hosts.length ? hosts.join(", ") : "none", "customHosts") : "n/a"],
      ["threads", !s ? "n/a" : s.autoConcurrency === true ? mark("auto", "autoConcurrency") : s.autoConcurrency === false ? mark(count(s.concurrency), "autoConcurrency", "concurrency") : "n/a"],
      ["buffer ahead", s ? mark(num(s.bufferAheadSeconds) === null ? "n/a" : `${count(s.bufferAheadSeconds)} s`, "bufferAheadSeconds") : "n/a"],
      ["secondary buffer", flag("secondaryBuffer")],
      ["episodes", flag("episodeEnabled")],
      ["live", flag("liveEnabled")],
      ["block international", flag("blockInternational")]
    ]);
  }

  // Bilibili's quality menu as its player reports it (getQuality): the same words in every mode.
  const menuState = (value) => { const menu = object(value); return `menu ${menu ? `now ${count(menu.nowQ)} new ${count(menu.newQ)} real ${count(menu.realQ)}` : "n/a"}`; };

  function elementRows(c) {
    const playback = c.playback;
    const state = (value, names) => { const n = num(value); return n === null ? "n/a" : `${Math.round(n)}${names[Math.round(n)] ? ` ${names[Math.round(n)]}` : ""}`; };
    const ranges = rangesOf(playback?.buffered);
    return [
      ["ready state", state(playback?.readyState, READY_STATES)],
      ["network state", state(playback?.networkState, NETWORK_STATES)],
      ["buffered", !ranges ? "n/a" : ranges.length ? ranges.map(([start, end]) => `${fixed(start, 1)}-${fixed(end, 1)}`).join(", ") : "none"]
    ];
  }

  // The full takeover in detail; for the compatibility mode the transport's own counters; for
  // Bilibili's own playback only the element.
  function playback(c) {
    const { video, player, settings } = c;
    if (!video) return ["n/a"];
    const p = player || {};
    if (c.engine === "compat") {
      const downloaded = num(p.downloadedQualityId);
      return pairs([
        ["transport", `revision ${count(p.transportRevision)}, quality guard ${yesNo(bool(p.nativeQualityGuard))} (revision ${count(p.qualityGuardRevision)})`],
        ["ranges", `${count(p.acceleratedRanges)} served, ${count(p.failedRanges)} failed, ${count(p.activeRequests)} active`],
        ["switch requests", count(p.nativeSwitchRequests)],
        ["switch pending", yesNo(bool(p.nativeSwitchPending))],
        ["quality pick", `downloaded ${downloaded > 0 ? qn(downloaded) : "n/a"}, ${menuState(video.nativeQuality)}, core now/target/rendered ${word(p.nativeQuality)}`],
        ...elementRows(c)
      ]);
    }
    if (c.engine !== "full") return pairs(elementRows(c));
    const session = list(video.timeline).map(object).filter((event) => event?.what === "session").at(-1);
    const sessionAt = session ? c.clock.perf(session.at, c.videoDelta) : null;
    const tracks = list(p.tracks).map(object).filter(Boolean);
    const segments = ["video", "audio"].map((kind) => tracks.find((item) => item.kind === kind)).filter(Boolean)
      .map((item) => `${item.kind} ${count(item.nextIndex)}/${count(item.segments)}`).join(", ");
    const menu = object(video.nativeQuality);
    const preferred = num(p.preferredQuality), auto = num(p.autoQuality);
    const qualities = p.qualities ?? video.qualities;
    const deadline = num(p.urlDeadline);
    const left = deadline > 0 && c.clock.capturedAt !== null ? deadline * 1000 - c.clock.capturedAt : null;
    const core = object(video.nativeCore), reserve = object(p.reserve);
    const lastSeek = num(p.lastSeekMs);
    return pairs([
      ["session", `started at ${position(p.sessionStartTime)} s${sessionAt === null ? "" : ` (${stamp(sessionAt)})`}`],
      ["media source", word(p.mediaSourceState)],
      ["activated", yesNo(bool(p.playbackActivated))],
      ["play wanted", yesNo(bool(p.resumeWanted))],
      ...elementRows(c),
      ["startup buffer", secondsAmount(p.startupBufferSeconds)],
      ["rebuffers", count(p.underflowRebuffers)],
      ["seek reloads", count(p.seekReloads)],
      ["last seek", lastSeek === null ? "n/a" : lastSeek > 0 ? `${duration(lastSeek)} to settle, ${plural(p.stallsAfterSeek, "stall")} after` : "none"],
      ["quality pick", `preferred ${preferred > 0 ? qn(preferred) : preferred === 0 ? "auto" : "n/a"}, auto ${auto > 0 ? qn(auto) : "n/a"}, ${menuState(menu)}`],
      ["qualities", !Array.isArray(qualities) ? "n/a" : qualities.map(num).filter((id) => id !== null).map(Math.round).join(", ") || "none"],
      ["codec pick", text(p.preferredCodec) ? word(p.preferredCodec) : "default"],
      ["segments", segments || "none"],
      ["urls expire", deadline > 0 ? `${iso(deadline * 1000, true)}${left === null ? "" : left >= 0 ? ` (in ${duration(left)})` : ` (expired ${duration(-left)} ago)`}` : "n/a"],
      ["native core", `${plural(core?.buffersLocked, "buffer")} locked, ${plural(core?.mediaRequests, "media request")}, ${plural(p.nativeLeftoversSuppressed, "hidden console error")}, ${plural(p.codecFailuresBlocked, "codec-failure write")} blocked`],
      ["second buffer", !settings ? "n/a" : settings.secondaryBuffer !== true ? "off" : reserve ? `on, ${secondsAmount(reserve.seconds)} held, ${size(reserve.bytes)} of ${size(reserve.limitBytes)}` : "on"]
    ]);
  }

  function downloads(c) {
    const d = c.downloads, byKind = object(d?.byKind), auto = c.auto, now = c.clock.now;
    const kind = (name) => {
      if (!d) return "n/a";
      const item = object(byKind?.[name]) || {};
      const n = (key) => Math.round(num(item[key]) || 0);
      return `${n("started")} started, ${n("ok")} ok, ${n("failed")} failed, ${n("cancelled")} cancelled, ${size(num(item.bytes) || 0)}`;
    };
    // Cancel reasons as the error they were thrown with, in English, as one token each.
    const reasons = new Map();
    for (const [reason, n] of Object.entries(object(d?.cancelReasons) || {})) {
      if (!(num(n) > 0)) continue;
      const token = scrub(translate(reason)).toLowerCase().replace(/\[removed\]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "unknown";
      reasons.set(token, (reasons.get(token) || 0) + num(n));
    }
    const sorted = [...reasons].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const cancelled = !d ? "n/a" : sorted.length ? [...sorted.slice(0, 8).map(([reason, n]) => `${Math.round(n)} ${reason}`), ...(sorted.length > 8 ? [`${sorted.length - 8} more`] : [])].join(", ") : "none";
    const lastBytes = num(d?.lastBytesAt);
    const at = (ms) => now === null || num(ms) === null ? "n/a" : stamp(now + num(ms));
    let threadsLine = "n/a";
    if (c.settings?.autoConcurrency === false) threadsLine = `off (manual ${count(c.settings.concurrency)})`;
    else if (auto) {
      const steps = num(auto.steps) || 0;
      threadsLine = `${count(auto.threads)}, level ${count(auto.level)}, ${plural(steps, "step")}${steps > 0 ? `, last change ${stamp(c.clock.perf(auto.changedAt))} (${sentence(auto.reason, 80) || "n/a"})` : ""}`;
    }
    const trial = object(auto?.trial), startup = object(auto?.startup);
    const resting = list(auto?.resting).map(object).filter(Boolean)
      .map((rest) => `${count(rest.threads)} threads until ${at(rest.forMs)} (${rest.hard === true ? "server refused" : "no gain"})`).join(", ");
    return pairs([
      ["video", kind("video")],
      ["audio", kind("audio")],
      ["meta", kind("meta")],
      ["active", d ? count(d.active ?? 0) : "n/a"],
      ["cancelled", cancelled],
      ["throughput", auto && num(auto.throughputBps) !== null ? mbit(num(auto.throughputBps) * 8) : "n/a"],
      ["last data", !d ? "n/a" : lastBytes > 0 ? stamp(c.clock.perf(lastBytes, c.videoDelta)) : "none"],
      ["auto threads", threadsLine],
      ["trial", !auto ? "n/a" : trial ? `${count(trial.from)} -> ${count(trial.level)} threads since ${at(-(num(trial.ageMs) || 0))}, baseline ${mbit((num(trial.baselineBps) || 0) * 8)}${trial.stalled === true ? ", stalled meanwhile" : ""}` : "none"],
      ["resting", !auto ? "n/a" : resting || "none"],
      ["startup", !auto ? "n/a" : startup ? `back to ${count(startup.base)} threads by ${at(startup.forMs)}` : "none"]
    ]);
  }

  function nodes(c) {
    if (!c.video) return ["n/a"];
    const rows = nodeRows(c);
    const lines = [];
    if (!rows) lines.push("n/a");
    else if (!rows.length) lines.push("none");
    else {
      const cell = (traffic, key) => traffic ? count(traffic[key] ?? 0) : "-";
      const shown = rows.slice(0, NODE_LIMIT).map((row) => [
        row.host, row.state, row.bps > 0 ? (row.bps * 8 / 1e6).toFixed(2) : "-",
        cell(row.traffic, "ok"), cell(row.traffic, "failed"), cell(row.traffic, "cancelled"),
        row.traffic ? size(num(row.traffic.bytes) || 0) : "-",
        row.traffic && text(row.traffic.lastError) ? sentence(row.traffic.lastError, 60) || "-" : "-"
      ]);
      lines.push(...table(["HOST", "STATE", "Mbit/s", "OK", "FAIL", "CXL", "DATA", "LAST ERROR"], shown, ["l", "l", "r", "r", "r", "r", "r", "l"]));
      if (rows.length > NODE_LIMIT) lines.push(`${rows.length - NODE_LIMIT} more`);
    }
    const addressBans = list(c.video.bans).map(object).filter((ban) => ban?.kind === "address");
    if (!Array.isArray(c.video.bans)) lines.push("address bans  n/a");
    else if (!addressBans.length) lines.push("address bans  none");
    else for (const ban of addressBans.slice(0, 20)) {
      const at = c.clock.perf(ban.at, c.videoDelta);
      lines.push(`address ban   ${hostName(ban.host) || "n/a"}: ${plural(ban.count, "failure")}${text(ban.error) ? ` (${sentence(ban.error, 80)})` : ""}${at === null ? "" : ` at ${stamp(at)}`}`);
    }
    return lines;
  }

  const liveName = (module) => word(module.frame, "") || `module ${module.index + 1}`;
  // The live module in each frame that has one: its stats and stream, on the top clock.
  function liveBlocks(c) {
    return c.live.map((module) => {
      const stats = object(module.stats), context = object(module.context), delta = num(module.timeOriginDelta) || 0;
      const hosts = list(context?.hosts ?? stats?.cdnHosts).map(object).filter((node) => hostName(node?.host));
      const errorAt = c.clock.perf(stats?.lastErrorAt, delta);
      const counts = new Map();
      for (const node of hosts) counts.set(word(node.state, "unknown"), (counts.get(word(node.state, "unknown")) || 0) + 1);
      const lines = pairs([
        ["state", stats ? word(stats.playerState) : "n/a"],
        ["stream", context ? word(context.key, "none") : "none"],
        ["last segment", context ? count(context.lastNum) : "n/a"],
        ["cached", context ? plural(context.cached, "segment") : "n/a"],
        ["requests", stats ? `${count(stats.acceleratedRequests)}, ${size(stats.acceleratedBytes)}` : "n/a"],
        ["active", stats ? count(stats.activeThreads) : "n/a"],
        ["speed", stats && num(stats.totalSpeedBps) !== null ? mbit(num(stats.totalSpeedBps) * 8) : "n/a"],
        ["nodes", hosts.length ? [...counts].map(([state, n]) => `${n} ${state}`).join(", ") : "none"],
        ["last error", !stats ? "n/a" : text(stats.lastError) ? `${sentence(stats.lastError)}${errorAt === null || !num(stats.lastErrorAt) ? "" : ` at ${stamp(errorAt)}`}` : "none"]
      ]);
      if (hosts.length) {
        const sorted = hosts.slice().sort((a, b) => rank(a.state) - rank(b.state) || (num(b.bps) || 0) - (num(a.bps) || 0));
        lines.push(...table(["HOST", "STATE", "Mbit/s"], sorted.slice(0, LIVE_NODE_LIMIT).map((node) => [hostName(node.host), word(node.state, "unknown"), num(node.bps) > 0 ? (node.bps * 8 / 1e6).toFixed(2) : "-"]), ["l", "l", "r"]));
        if (hosts.length > LIVE_NODE_LIMIT) lines.push(`${hosts.length - LIVE_NODE_LIMIT} more`);
      }
      return { title: `Live (${liveName(module)})`, note: "", lines };
    });
  }

  // ---- events ----

  const SOURCES = ["page", "player", "prev", "media", "live"];
  const LEVELS = Object.freeze({ debug: "DEBUG", info: "INFO", success: "INFO", warn: "WARN", warning: "WARN", error: "ERROR" });
  // Levels for records that carry none: older builds, the players' timelines and the element.
  const PAGE_LEVELS = Object.freeze({ "native buffer locked": "DEBUG", "native scheduler stopped": "DEBUG", "playback failed": "ERROR" });
  const PLAYER_LEVELS = Object.freeze({
    "headers requested": "DEBUG", "pause taken as the switch's": "DEBUG", "native future replacement resumed": "DEBUG",
    "native stopped scheduler resumed": "DEBUG", "native already-rendered quality confirmed": "DEBUG", "native range delivered": "DEBUG",
    "rebuffer before underflow": "WARN", "buffer quota hit": "WARN", "native range failed": "WARN",
    "native quality guard unavailable": "WARN", "native core transition: acceleration suspended": "WARN",
    "index parsed": "DEBUG", "seek inside buffer": "DEBUG", "autoplay refused": "WARN", "end of stream failed": "ERROR"
  });
  const MEDIA_LEVELS = Object.freeze({ error: "ERROR", stalled: "WARN", seeking: "DEBUG", seeked: "DEBUG", loadedmetadata: "DEBUG", canplay: "DEBUG" });
  const levelOf = (value) => LEVELS[text(value).toLowerCase()] || null;

  // Every record on one clock, in time order: page-hook's page events, the current and the
  // previous player's timelines, the element's events and the live modules' events.
  function collectEvents(c) {
    const events = [];
    const push = (source, entry, at, level, what, pos) => {
      const detail = detailText(entry.detail);
      events.push({ source, order: events.length, at, level, message: what ? detail ? `${what}: ${detail}` : what : detail || "-", pos: num(pos), count: Math.max(1, Math.round(num(entry.count) || 1)), until: null });
    };
    const records = (source, entries, levels, delta, prefix = "") => {
      for (const raw of list(entries)) {
        const entry = object(raw);
        if (!entry) continue;
        const what = sentence(entry.what ?? entry.name, 120);
        push(source, entry, c.clock.perf(entry.at, delta), levelOf(entry.level) || levels[text(entry.what ?? entry.name)] || "INFO", `${prefix}${what}`, entry.time);
      }
    };
    records("page", c.video?.page, PAGE_LEVELS, c.videoDelta);
    records("player", c.video?.timeline, PLAYER_LEVELS, c.videoDelta);
    records("prev", object(c.video?.previousPlayer)?.timeline, PLAYER_LEVELS, c.videoDelta);
    records("media", c.snapshot.media, MEDIA_LEVELS, 0);
    for (const module of c.live) records("live", module.events, {}, num(module.timeOriginDelta) || 0, c.live.length > 1 ? `[${liveName(module)}] ` : "");
    // Records without a time go last, in the order they came.
    return events.sort((a, b) => (a.at === null) - (b.at === null) || (a.at ?? 0) - (b.at ?? 0)
      || SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source) || a.order - b.order);
  }

  // Adjacent repeats of one record within 10 s of its first become one line with a count.
  function fold(events) {
    const folded = [];
    for (const event of events) {
      const last = folded.at(-1);
      if (last && last.source === event.source && last.message === event.message && last.level === event.level
        && last.at !== null && event.at !== null && event.at - last.at <= FOLD_MS) {
        last.count += event.count;
        last.until = event.at;
        continue;
      }
      folded.push({ ...event });
    }
    return folded;
  }

  function eventsBlock(c, budget) {
    const events = fold(collectEvents(c));
    if (!events.length) return { title: "Events", note: "0 shown, 0 omitted", lines: ["none"] };
    const timeWidth = Math.max(8, ...events.map((event) => event.at === null ? 1 : seconds(event.at).length));
    const posWidth = Math.max(5, ...events.map((event) => event.pos === null ? 1 : fixed(event.pos, 1).length));
    // A long message is cut before its repeat count, which always stays readable.
    const lineOf = (event) => {
      const tail = event.count > 1 ? event.until !== null && event.until !== event.at ? ` (x${event.count} until ${stamp(event.until)})` : ` (x${event.count})` : "";
      const line = clean(`${(event.at === null ? "-" : seconds(event.at)).padStart(timeWidth)}  ${event.level.padEnd(5)}  ${event.source.padEnd(6)}  ${(event.pos === null ? "-" : fixed(event.pos, 1)).padStart(posWidth)}  ${event.message}`);
      return line.length + tail.length <= LINE_LIMIT ? line + tail : `${line.slice(0, LINE_LIMIT - tail.length - 3).trimEnd()}...${tail}`;
    };
    const keep = events.map(() => true);
    // Over 400 lines: the oldest DEBUG lines go first, then the oldest INFO; WARN and ERROR stay.
    let excess = events.length - EVENT_LIMIT;
    for (const level of ["DEBUG", "INFO"]) {
      for (let index = 0; index < events.length && excess > 0; index += 1) if (keep[index] && events[index].level === level) { keep[index] = false; excess -= 1; }
    }
    const lines = events.map(lineOf);
    const header = `${"T".padStart(timeWidth)}  LEVEL  SOURCE  ${"POS".padEnd(posWidth)}  EVENT`;
    let used = header.length + 1 + lines.reduce((sum, line, index) => sum + (keep[index] ? line.length + 1 : 0), 0);
    // A paste over GitHub's limit is lost whole, so the character budget wins in the end: only
    // then do WARN and, last of all, ERROR lines go, again oldest first.
    for (const level of ["DEBUG", "INFO", "WARN", "ERROR"]) {
      for (let index = 0; index < events.length && used > budget; index += 1) if (keep[index] && events[index].level === level) { keep[index] = false; used -= lines[index].length + 1; }
    }
    const shown = lines.filter((_line, index) => keep[index]);
    return { title: "Events", note: `${shown.length} shown, ${events.length - shown.length} omitted`, lines: shown.length ? [header, ...shown] : ["none"] };
  }

  // ---- the whole report ----

  // The last line counts the lines and characters of the whole text, itself included, so a cut
  // paste shows.
  function finish(lines) {
    const body = [...lines.map(clean), ""];
    const base = body.join("\n").length + 1;
    let end = "";
    for (let pass = 0; pass < 4; pass += 1) {
      const next = `== End ==  ${body.length + 1} lines, ${base + end.length} chars`;
      if (next === end) break;
      end = next;
    }
    return `${body.join("\n")}\n${end}`;
  }

  function compose(snapshot) {
    const c = facts(snapshot);
    const blocks = [];
    const section = (title, note, build) => {
      let lines;
      try { lines = build(c); } catch (error) { lines = [`n/a (formatter failed: ${sentence(error, 120) || "unknown error"})`]; }
      blocks.push({ title, note, lines });
    };
    section("Summary", "", summary);
    section("Checks", "", checks);
    section("Environment", "", environment);
    section("Site", "", site);
    section("Settings", "(* = changed from default)", settingsSection);
    section("Playback", "", playback);
    section("Downloads", "(since page load)", downloads);
    section("CDN nodes", "", nodes);
    try { blocks.push(...liveBlocks(c)); } catch (error) { blocks.push({ title: "Live", note: "", lines: [`n/a (formatter failed: ${sentence(error, 120) || "unknown error"})`] }); }
    const fixedLines = [...header(c), ...blocks.flatMap((block) => ["", heading(block), ...block.lines])].map(clean);
    const used = fixedLines.reduce((sum, line) => sum + line.length + 1, 0);
    let events;
    // What follows the events: their heading, the blank line and the End line.
    try { events = eventsBlock(c, CHAR_LIMIT - used - 200); } catch (error) { events = { title: "Events", note: "", lines: [`n/a (formatter failed: ${sentence(error, 120) || "unknown error"})`] }; }
    return finish([...fixedLines, "", heading(events), ...events.lines]);
  }

  // Never throws: a report that says the formatter failed is still worth pasting.
  function render(snapshot) {
    try { return compose(object(snapshot) || {}); } catch (error) {
      try { return finish([`BTR diagnostics (format ${FORMAT}) | formatter failed: ${sentence(error, 120) || "unknown error"}`]); } catch (_error) {
        return `BTR diagnostics (format ${FORMAT}) | formatter failed`;
      }
    }
  }

  root.__BTR_DIAGNOSTIC_REPORT__ = Object.freeze({ FORMAT, DEFAULTS, render, translate });
})(globalThis);

/* src/settings-panel.js */
// The settings panel. It runs in the bilibili page and opens from the button in the page's
// corner, the userscript manager's menu, or "自定义" in the player's gear menu. Settings are
// read and saved through bridge.js; storage-shim.js keeps them in the script manager's
// storage.
(function installSettingsPanel(root) {
  "use strict";

  if (root.__BTR_SETTINGS_PANEL__) return;
  const core = root.__BILI_RANGE_CORE__;
  const cdn = root.__BILI_CDN_RESOLVER_FACTORY__;
  if (!core || !cdn) return;
  // The desktop app opens this same panel. It names what the client has no use for and adds
  // its own block (its src/panel-bridge.js); the userscript sets none of this.
  const hostApp = root.__BTR_PANEL_HOST__;

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  // Which script this is: the released one, or the Canary built from main.
  const SCRIPT_CHANNEL = "stable" === "canary" ? "canary" : "stable";
  const CHANNEL_NAMES = { stable: "正式版", canary: "Canary" };
  // Set by the other of the two scripts when both are switched on (see loader.js).
  const otherScript = () => document.documentElement?.getAttribute("data-btr-also-running") || "";
  const HOST_ID = "__bilibili_thread_ripper_settings__";
  const DIALOG_ID = "__bilibili_thread_ripper_settings_dialog__";
  const LAUNCHER_ID = "__bilibili_thread_ripper_launcher__";
  const GUIDE_ID = "__bilibili_thread_ripper_guide__";
  const THREAD_OPTIONS = [4, 8, 16, 32, 64, 128];
  const BUFFER_OPTIONS = [30, 45, 90, 180];
  const MAX_CUSTOM_HOSTS = 32;
  const HOST_GROUPS = [["大陆节点", cdn.MAINLAND_HOSTS], ["海外节点", cdn.OVERSEAS_HOSTS]];
  const PROJECT_URL = "https://github.com/MrTangLuyao/Bilibili-thread-ripper";
  // GitHub's mark.
  const GITHUB_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>`;
  // The script's own icon, icons/icon-128.png (dev/userscript-test.js checks the two stay the same).
  const ICON_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAACXBIWXMAAAsTAAALEwEAmpwYAAAHzklEQVR4nO2d248VNRjA58HLuySi0UcV/xoDMZHoEw8Gjcil3WVFjUIUb1FcNhC23x7kohFwTbyh4opGAVHuKBBhXcALBCTrgnAWzp6208909pAYg7LrtNPOnO+XfG9sOPN9v2k7baeTJARBEARBEARBEARBEAThEuxceZtm8JDi0CM5DCguhiSD85KDVBywHUNykDYHWS6ynECP5r0P2lxVwj6cs2KKZDBPcdgbOtmlCyb2SC7m2hwmZQO7+u5UTCyXHC4HT2TJQzIxqjh0I+u9I4kdnA03Sg7zJYd66MRVLaS9mRgswbk9NycxMjZ/1TTF4fvQiap+iINjvO+eJCYUg/vprofiWgMmLinWNyOJgSbvmyUZqPB3RnuF5ELLBeLRoMWXDB4JnYh2D8nF3IDNvtChE9DuIcdrML3Q4jdY7S7J4WLoi6eAlgRQH+NwbyHFx8X9N9FoH+KTj8EB+xjuXQDJYVHwi6XAa3cH0Om1+HY2qjUzRUXgcXYFuABu9yaAnd4NfZEUcL2uYJm/hR2a28fYBbQttJcFpNaqXvALpIAJdAVijnMBaEkXyiTfbqfFtwMLyYWJ4MIo+IRaAIPzalOdCdDayUPJ5+XJgeZipjMB7Fal0BdEAZPNQbczAVr71agIvDw5kEx86kwAxeFE6AuigEnmQAw5E0ByMUIFgFJJKBkMuxOAiWboC6KAyQnAYcyZAJR8KKWAJEAERVAkQPhEtGskVesCCqfRRLwyhubcBTQnzqI5MITpZ/tQv7kV9dINwfNBAoTmz1E0ewdRrxlA9cQbwQtOLUBIGk1Mtx9G/dKm4IW/GtQFhCA1mO4ZRPX82yRA6ccAeWgqTD/ejaqjj1qAthSghfnxV1RPraUuoF0FsJhTw6ieXkdjgHYVwGJ+PYdqUbFPCjQIjAxz4DgJ0K4twFX0W19QC9DOAuCfo4V1BeG6gIU1TLfsRXNmBPF8fUJh/639G/u3lRYAEdP3dlZbgPSzvRMu/D/D/q0vAa7727tWo3pmPeqX30G9biumXxxE8/sFdI1dW1AdFRZgMnf+tVqCYALwa4de/n62GOQS/eq7JEBZBFA2OgDTT3YjGif1H58lrGoLUNougE/g2gb2ORHAfH+iugLEOgh0ktiFNTRnR/ILcPZ8hQXwFFEIwAHT93fm/i1Yb5AAZRVAv9KfXwClSYCyCqCeXJNfgKYiAUorwFNr3cwIeu4yaQwQcRdgTg+TAGVtAdIPvs39W9JdR0mAUgqw0M1jYNq/jQQoowCpi4kgY1A993aFxgD/Y+KndBNBHe6mgs3gae/FL1SAPFO/ZZgK1j1uF4P0us+rJUCeOz+qxaCu1aieXY/6FX/LwdnewAKWgkmAGDEG9YoPCyk+dQERkn6+v7DiFypAWQaBITHHTqHqrFVUgIKirJiTZ7P1g6LzRQJEgDl0MkjxSYDQ6BTTzbsKG/GTABFhBk9nC0ahu0zqAkIJcGoY9YavUHWGezWcBIgAc+4CaviEBHBldFkxdgfwM+upBWhXASxm5FLh5weFGwNEui08OPUrqLvfq74Asb4YEgVXxlC/uKnaAsT6bmAsGPtyaAHnBpEAEWP2/VRdAagLmAAGUa/8sJoCxDoInPDv71qNaslb2WyeXr8V022HnGwEvebpYR1VFMBT5CXv/69XfpQt67pEr9pMApRFAHV1c+i727N3+1xg9g+RAKUSgLdag3Vbsy1e+X+U9vZEQF2ARwGUHex+edBNN+BpvYAE8CyAsi+J1hu5BbAvm5AAJesC1NVWYMeR3L/LHP2NBCirALq2Jb8A/zH7SV1A7AIs3RDtWQE0BihAALXojWiPiyEBihDgSQfHxZAAE0t2lF3ACxvzCzDq58QwagHKMgj84yIJUNYWIP3mSLTnBVALUJaJoB1H4hYgls/H5yXWqeB009dxfz5ecjESuvixCaDXDGQfiXSBj49MSgbDzgRQDI6HLn5ll4PP+JkFVFwMORNAchgIXfyqbghJP/jWS64kE586E0Bx6GkrAbqK2RKGUvn8oGS3MwE0732wCgLERvrlQW+50gv6HnAmAM6rTZVcGBLAIfUr3nYC2VrZmiUuUUzsIQHcYZ8i/OVTfJe4RnIxlwRwQ7rjsNeuUjJ4zLkAOGfFFMnEKI0B8mGO/PKf7z7kL74YtbVKfGBHliRAzq1f9gnD492vOLyW+AJZ7x0hW4Eyk9rvA3i881t3/yXsXHlb4hPJxBMkwCRoNDHd+FUhN4hk0JH4BmfDjYrBAWoBroNBND+cLOS7AK3Yb2uTFEGD1e6SHC5SF/AvhR88lR0xX1R+JIf62PxV05IiUaxvhuRCFylB1NQb2bq+PWq+yJy0anBfEgLZIWa3rQCpyV7vtusE2Ru+Ac4EtDN+TQ4PJyFp8r5ZkoGqnACNZnaejz3dy/z8O5rDP2fFTvu3jx/sEOj837/f+ZLBI0kMKA7T7SNIyIS0U8jx8VeYZv/fGFvYe3eop4M2i/12EJ7ECC5efIPkMJ9aA/Bx119WDJbg4v6bktjBBXC7YuL10GsHVQhpc8hgmfcZPh+MLyDB44rBrhj2E5QlZJYr8Z3kYg6y2i1JFcCOVbdqLmbaBSXJYYvicMzuNo5ly7kKUWgmmq0d18daOem2ObK5Cl0vgiAIgiAIgiAIgiAIomL8Bc0CR4+jT4wjAAAAAElFTkSuQmCC";
  // The theme button shows the choice in use: a sun for 浅色, a moon for 深色, and for 自动 a
  // half sun, half moon with a small A in the corner.
  const THEME_ICONS = `<svg class="icon-light" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"></path></svg>`
    + `<svg class="icon-dark" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20.5 13.8A8.5 8.5 0 1 1 10.2 3.5a6.6 6.6 0 0 0 10.3 10.3z"></path></svg>`
    + `<svg class="icon-auto" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="4"></circle><path d="M10 6a4 4 0 0 1 0 8z" fill="currentColor" stroke="none"></path><path d="M10 1.7v1.8M10 16.5v1.8M1.7 10h1.8M16.5 10h1.8M4.1 4.1l1.3 1.3M15.9 4.1l-1.3 1.3M4.1 15.9l1.3-1.3"></path><path d="M14.6 22.8l4.1-9 4.1 9M16 19.6h5.4"></path></svg>`;
  const THEME_LABELS = { auto: "自动（跟随系统）", light: "浅色", dark: "深色" };
  const CHEVRON_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>`;
  const KNOWN_HOSTS = HOST_GROUPS.flatMap(([, hosts]) => hosts);

  // The ripple on everything that can be pressed, the same one as on louie1.com: a circle that
  // grows from where the press landed and fades out. A timer removes each circle after its run,
  // not only animationend: an animation does not run while its element is hidden (a page or
  // tab of the panel not shown, the floating button taken off the page while the panel is
  // open), so animationend would never come, and the leftover circle would play again as
  // soon as the element showed up.
  const RIPPLE_MS = 600;
  const RIPPLE_CSS = `
    .btr-ripple-host { overflow: hidden; }
    .btr-ripple { position: absolute; display: block; border-radius: 50%; transform: scale(0); background: var(--ripple, rgba(255, 255, 255, .15)); pointer-events: none; animation: btr-ripple ${RIPPLE_MS}ms linear forwards; }
    @keyframes btr-ripple { to { transform: scale(4); opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .btr-ripple { display: none; } }
  `;

  function ripple(surface, event) {
    if (!surface) return;
    if (root.getComputedStyle(surface).position === "static") surface.style.position = "relative";
    surface.classList.add("btr-ripple-host");
    clearRipples(surface);
    const box = surface.getBoundingClientRect();
    const size = Math.max(surface.clientWidth, surface.clientHeight);
    // Its own element rather than a span, which the panel's span rules (the switches, the
    // choices) would restyle.
    const circle = document.createElement("btr-ripple");
    circle.className = "btr-ripple";
    circle.style.width = circle.style.height = `${size}px`;
    circle.style.left = `${event.clientX - box.left - size / 2}px`;
    circle.style.top = `${event.clientY - box.top - size / 2}px`;
    surface.append(circle);
    const timer = setTimeout(() => circle.remove(), RIPPLE_MS + 50);
    circle.addEventListener("animationend", () => {
      clearTimeout(timer);
      circle.remove();
    }, { once: true });
  }

  function clearRipples(scope) {
    for (const circle of scope?.querySelectorAll(".btr-ripple") || []) circle.remove();
  }

  // 运行状态's speed: KB/s, MB/s from one megabyte a second up.
  function formatSpeed(bps) {
    const value = Math.max(0, Number(bps) || 0);
    if (value >= 1048576) return `${(value / 1048576).toFixed(value >= 10 * 1048576 ? 0 : 1)} MB/s`;
    return `${Math.round(value / 1024)} KB/s`;
  }

  const PANEL_HTML = `
    <main>
      <header>
        <img class="logo" src="${ICON_URI}" alt="" width="42" height="42">
        <div class="title">
          <div class="name">
            <h1>线程撕裂者</h1>
            <span class="version">v2026.11.13.1${SCRIPT_CHANNEL === "canary" ? '<b class="canary">Canary</b>' : ""}</span>
          </div>
          <a id="github-link" class="github-link" href="${PROJECT_URL}" target="_blank" rel="noopener noreferrer" title="在 GitHub 上查看项目" aria-label="在 GitHub 上查看项目">${GITHUB_ICON}</a>
          <button id="theme" class="theme-toggle" type="button" data-value="auto">${THEME_ICONS}</button>
        </div>
        <label class="switch" title="启用或停用">
          <input id="enabled" type="checkbox">
          <span></span>
        </label>
      </header>
      <p id="also-running" class="also-running" role="alert" hidden></p>
      <p id="disabled-note" class="disabled-note" role="status" hidden>线程撕裂者已关闭，打开右上角的开关即可启用。</p>

      <div class="view-main">
        <div class="block" data-needs-enabled>
          <h2 class="block-title">接管方式</h2>
          <section class="takeover-select" aria-label="接管方式">
            <label><input type="radio" name="takeover" value="full"><span>全接管</span></label>
            <label><input type="radio" name="takeover" value="compat"><span>兼容模式</span></label>
          </section>
          <p class="takeover-note"><span class="safari-note" hidden>Safari 用户建议使用兼容模式。<br><br></span>全接管：速度最快，几乎不兼容所有的第三方插件。<br>安装第三方增强插件，或遇到任何的问题，请使用兼容模式。</p>
        </div>
        <div class="block" data-needs-enabled>
          <h2 class="block-title">运行状态</h2>
          <section class="run-state" aria-label="运行状态">
            <span><b id="active-count">0</b> 条线程</span>
            <b class="run-speed">0 KB/s</b>
          </section>
        </div>
      </div>

      <details id="advanced" class="advanced">
        <summary>
          <span class="advanced-title">高级设置${CHEVRON_ICON}</span>
          <small>默认设置在绝大多数场景就是表现最优的。如果你遇到了问题，修改这里的一些设置可能有帮助。</small>
        </summary>
        <div class="advanced-page">
          <div class="page-bar">
            <button id="advanced-back" class="page-back" type="button" aria-label="返回">${CHEVRON_ICON}</button>
            <span class="page-title">高级设置</span>
          </div>
          <div class="tabs" role="tablist" aria-label="高级设置">
            <button id="tab-network" type="button" role="tab" data-tab="network" aria-controls="panel-network" aria-selected="true">网络</button>
            <button id="tab-buffer" type="button" role="tab" data-tab="buffer" aria-controls="panel-buffer" aria-selected="false" tabindex="-1">缓冲</button>
            <button id="tab-features" type="button" role="tab" data-tab="features" aria-controls="panel-features" aria-selected="false" tabindex="-1">功能</button>
            <button id="tab-interface" type="button" role="tab" data-tab="interface" aria-controls="panel-interface" aria-selected="false" tabindex="-1">界面</button>
          </div>
          <div id="panel-network" class="tab-panel" role="tabpanel" aria-labelledby="tab-network" data-tab-panel="network">
            <div class="block" data-needs-enabled>
              <h2 class="block-title">CDN 模式</h2>
              <section class="mode-select" aria-label="CDN 模式">
                <label><input type="radio" name="mode" value="mainland"><span>大陆</span></label>
                <label><input type="radio" name="mode" value="overseas"><span>海外</span></label>
                <label><input type="radio" name="mode" value="custom"><span>自定义</span></label>
              </section>
              <section id="custom-hosts" class="custom-hosts" aria-label="自定义服务器" hidden>
                <div class="custom-head"><span>自定义服务器</span><b id="custom-count">0</b></div>
                <p id="custom-empty" class="custom-note">还没选服务器，暂时按大陆 CDN 下载。</p>
                <div id="known-hosts"></div>
                <fieldset class="host-group">
                  <legend>手动添加</legend>
                  <div id="manual-hosts" class="manual-hosts"></div>
                  <form id="host-form" class="host-form">
                    <input id="host-input" type="text" placeholder="例如 upos-sz-mirrorali.bilivideo.com" spellcheck="false" autocomplete="off" aria-label="服务器地址">
                    <button type="submit">添加</button>
                  </form>
                  <p id="host-error" class="host-error" role="alert"></p>
                </fieldset>
                <p class="custom-note">只能填 B 站的视频服务器（bilivideo.com、akamaized.net 等），视频的下载地址不会发给别的网站。</p>
              </section>
            </div>
            <div class="block" data-needs-enabled>
              <h2 class="block-title">线程</h2>
              <section class="controls">
                <div class="control-title">
                  <label for="concurrency">线程加载数</label>
                  <output id="thread-value" for="concurrency">8</output>
                </div>
                <label class="auto-row" for="auto-concurrency"><span class="row-text">自动线程数（推荐）<small>BTR将智能选择需要的线程数。</small></span><span class="switch"><input id="auto-concurrency" type="checkbox" aria-label="自动线程数"><span></span></span></label>
                <div class="slider">
                  <div id="slider-fill" class="slider-fill" aria-hidden="true"></div>
                  <input id="concurrency" type="range" min="0" max="5" step="1" value="1" aria-label="线程加载数" aria-valuetext="8">
                </div>
                <div class="scale" aria-hidden="true">
                  <span>4</span><span>8</span><span>16</span><span>32</span><span>64</span><span>128</span>
                </div>
              </section>
            </div>
          </div>
          <div id="panel-buffer" class="tab-panel" role="tabpanel" aria-labelledby="tab-buffer" data-tab-panel="buffer" hidden>
            <div class="block" data-needs-enabled>
              <section class="controls buffer-controls" aria-label="缓冲">
                <div class="control-title">
                  <label for="buffer-ahead" class="row-text">全接管预缓冲时长<small>可能受到浏览器150MiB限制</small></label>
                  <output id="buffer-value" for="buffer-ahead">45s</output>
                </div>
                <div class="slider">
                  <div id="buffer-fill" class="slider-fill" aria-hidden="true"></div>
                  <input id="buffer-ahead" type="range" min="0" max="3" step="1" value="1" aria-label="全接管预缓冲时长" aria-valuetext="45 秒">
                </div>
                <div class="scale" aria-hidden="true">
                  <span>30s</span><span>45s</span><span>90s</span><span>180s</span>
                </div>
                <label class="auto-row" for="secondary-buffer"><span class="row-text">开启二级缓冲（实验性）<small>尝试绕过浏览器视频缓冲容量限制</small></span><span class="switch"><input id="secondary-buffer" type="checkbox" aria-label="开启二级缓冲（实验性）"><span></span></span></label>
              </section>
            </div>
          </div>
          <div id="panel-features" class="tab-panel" role="tabpanel" aria-labelledby="tab-features" data-tab-panel="features" hidden>
            <div class="block" data-needs-enabled>
              <h2 class="block-title">加速范围</h2>
              <section class="accel-controls" aria-label="加速范围">
                <label class="accel-row" for="episode-enabled"><span class="row-text">剧集加速<small>加速番剧、电影、纪录片等剧集，使用兼容模式。</small></span><span class="switch"><input id="episode-enabled" type="checkbox" aria-label="剧集加速"><span></span></span></label>
                <label class="accel-row" for="live-enabled"><span class="row-text">直播加速（实验性）</span><span class="switch"><input id="live-enabled" type="checkbox" aria-label="直播加速（实验性）"><span></span></span></label>
              </section>
            </div>
            <div class="block" data-needs-enabled>
              <h2 class="block-title">网页版本</h2>
              <section class="site-controls" aria-label="网页版本">
                <label class="accel-row" for="block-international"><span class="row-text">阻止使用国际版<small>重定向B站到国内版网页</small></span><span class="switch"><input id="block-international" type="checkbox" aria-label="阻止使用国际版"><span></span></span></label>
              </section>
            </div>
            <div class="block">
              <h2 class="block-title">调试</h2>
              <section class="notice-controls" aria-label="调试">
                <div class="debug-copy">
                  <button id="debug-copy" type="button">复制诊断信息</button>
                  <span id="debug-copy-status" class="debug-copy-status" role="status"></span>
                </div>
                <p class="debug-copy-note">反馈问题时点一下，把复制下来的内容贴到 issue 里。里面没有 Cookie、账号信息和视频的下载地址。</p>
                <textarea id="debug-copy-text" class="debug-copy-text" readonly hidden aria-label="诊断信息"></textarea>
              </section>
            </div>
          </div>
          <div id="panel-interface" class="tab-panel" role="tabpanel" aria-labelledby="tab-interface" data-tab-panel="interface" hidden>
            <div class="block">
              <section class="interface-controls" aria-label="界面">
                <label class="notice-row" for="floating-button"><span class="row-text">悬浮按钮</span><span class="switch"><input id="floating-button" type="checkbox" aria-label="悬浮按钮"><span></span></span></label>
              </section>
            </div>
          </div>
        </div>
      </details>
    </main>
    <footer class="btr-footer">
      <button id="reset-settings" class="reset-settings" type="button">恢复默认设置</button>
    </footer>`;

  const PANEL_CSS = `
    .btr-popup {
      --scheme: dark; --bg: #17191f; --surface: #20232a; --hover: #292d35;
      --divider: #343943; --control-border: #444b57;
      --text: #f5f7fb; --label: #c9ced9; --button-text: #d9dee8;
      --muted: #949baa; --subtle: #8a93a6; --switch: #313a4c; --track: #3a3e47;
      --error: #f28b85; --success: #9fd9a8; --focus: #fff; --tab: #343943;
      --shadow: 0 24px 60px rgba(0, 0, 0, .5), 0 2px 10px rgba(0, 0, 0, .3);
    }
    .btr-popup[data-theme="light"] {
      --scheme: light; --bg: #fff; --surface: #f4f5f8; --hover: #e8ebf0;
      --divider: #d6dae2; --control-border: #aeb6c4;
      --text: #202532; --label: #363f50; --button-text: #363f50;
      --muted: #596579; --subtle: #596579; --switch: #758197; --track: #d6dae2;
      --error: #b42318; --success: #227536; --focus: #244e9b; --tab: #fff;
      --shadow: 0 24px 60px rgba(15, 23, 42, .18), 0 2px 10px rgba(15, 23, 42, .08);
    }
    * { box-sizing: border-box; }
    .btr-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .35); }
    .btr-popup { position: fixed; top: 72px; right: 24px; width: 360px; max-width: calc(100vw - 32px); max-height: calc(100vh - 96px); overflow: auto; border: 0; border-radius: 16px; box-shadow: var(--shadow); color-scheme: var(--scheme); font-family: Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; background: var(--bg); color: var(--text); font-size: 14px; line-height: normal; text-align: left; user-select: none; -webkit-user-select: none; }
    input, textarea { user-select: text; -webkit-user-select: text; }
    /* The panel takes the focus when it opens, for the keyboard; it is no control to outline. */
    .btr-popup:focus { outline: none; }
    main { padding: 18px 18px 14px; }
    header { display: grid; grid-template-columns: 42px 1fr auto; align-items: center; gap: 11px; margin-bottom: 18px; }
    .logo { display: block; width: 42px; height: 42px; }
    h1 { margin: 0; font-size: 17px; letter-spacing: .2px; }
    .name { display: grid; gap: 2px; min-width: 0; }
    .version { color: var(--muted); font-size: 11px; line-height: 1.2; font-variant-numeric: tabular-nums; }
    .version .canary { margin-left: 6px; padding: 0 5px; border-radius: 4px; background: #f5b301; color: #1d1d1f; font-size: 10px; font-weight: 700; }
    /* With the master switch off the panel says so, and what only works with BTR on fades out
       and cannot be used: not 调试 (the diagnostic copy) or the floating button,
       which still apply. */
    .disabled-note { margin: -10px 0 14px; padding: 8px 10px; border-radius: 8px; background: rgba(251, 114, 153, .16); color: var(--text); font-size: 12px; line-height: 1.55; }
    [data-needs-enabled] { transition: opacity .2s ease, filter .2s ease; }
    main.is-off [data-needs-enabled] { opacity: .38; filter: grayscale(1); pointer-events: none; user-select: none; }
    .also-running { margin: -10px 0 14px; padding: 8px 10px; border-radius: 8px; background: rgba(245, 179, 1, .16); color: var(--text); font-size: 12px; line-height: 1.55; }
    .title { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .github-link, .theme-toggle { display: grid; flex: none; place-items: center; width: 26px; height: 26px; border-radius: 6px; color: var(--muted); transition: color 160ms ease, background 160ms ease; }
    .github-link:hover, .theme-toggle:hover { color: var(--text); background: var(--hover); }
    .github-link:focus-visible, .theme-toggle:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .github-link svg, .theme-toggle svg { width: 18px; height: 18px; }
    .theme-toggle { margin-left: -6px; padding: 0; border: 0; background: transparent; cursor: pointer; }
    .theme-toggle svg { display: none; }
    .theme-toggle[data-value="auto"] .icon-auto, .theme-toggle[data-value="light"] .icon-light, .theme-toggle[data-value="dark"] .icon-dark { display: block; }
    .switch { position: relative; display: block; width: 42px; height: 24px; }
    .switch input { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
    .switch span { position: absolute; inset: 0; border-radius: 999px; background: var(--switch); cursor: pointer; transition: 160ms ease; }
    .switch span::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: 160ms ease; }
    .switch input:checked + span { background: #fb7299; }
    .switch input:checked + span::after { transform: translateX(18px); }
    .switch input:focus-visible + span { outline: 2px solid var(--focus); outline-offset: 3px; }
    .mode-select { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; padding: 3px; border-radius: 10px; background: var(--surface); }
    .mode-select label { position: relative; }
    .mode-select input { position: absolute; opacity: 0; }
    .mode-select span { display: block; padding: 8px 6px; border-radius: 7px; color: var(--muted); background: transparent; font-size: 12px; text-align: center; cursor: pointer; transition: background 180ms ease, color 180ms ease; }
    .mode-select input:not(:checked) + span:hover { color: var(--text); }
    .mode-select input:checked + span { color: #fff; background: #fb7299; }
    .mode-select input:focus-visible + span { outline: 2px solid var(--focus); outline-offset: -3px; }
    .takeover-select { display: grid; grid-template-columns: repeat(2, 1fr); gap: 3px; margin-bottom: 8px; padding: 3px; border-radius: 10px; background: var(--surface); }
    .takeover-select label { position: relative; }
    .takeover-select input { position: absolute; opacity: 0; }
    .takeover-select span { display: block; padding: 8px 6px; border-radius: 7px; color: var(--muted); background: transparent; font-size: 12px; text-align: center; cursor: pointer; transition: background 180ms ease, color 180ms ease; }
    .takeover-select input:not(:checked) + span:hover { color: var(--text); }
    .takeover-select input:checked + span { color: #fff; background: #fb7299; }
    .takeover-select input:focus-visible + span { outline: 2px solid var(--focus); outline-offset: -3px; }
    .takeover-note { margin: 0; padding: 0 2px; color: var(--subtle); font-size: 11px; line-height: 1.6; }
    .custom-hosts { margin-top: 8px; padding: 14px 16px; border-radius: 12px; background: var(--surface); }
    .custom-hosts[hidden] { display: none; }
    .custom-head { display: flex; align-items: center; justify-content: space-between; color: var(--label); font-size: 13px; }
    .custom-head b { min-width: 28px; padding: 2px 8px; border-radius: 5px; background: #fb7299; color: #fff; font-size: 12px; text-align: center; }
    .custom-note { margin: 8px 0 0; color: var(--subtle); font-size: 11px; line-height: 1.6; }
    .custom-note[hidden] { display: none; }
    .host-group { min-width: 0; margin: 12px 0 0; padding: 10px 0 0; border: 0; border-top: 1px solid var(--divider); }
    .host-group legend { padding: 0 0 4px; color: var(--label); font-size: 12px; }
    .host-option { display: flex; align-items: center; gap: 7px; margin-top: 7px; color: var(--label); font-size: 11px; overflow-wrap: anywhere; cursor: pointer; }
    .host-option input { flex: none; width: 14px; height: 14px; margin: 0; accent-color: #fb7299; cursor: pointer; }
    .manual-host { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 7px; color: var(--label); font-size: 11px; overflow-wrap: anywhere; }
    .manual-host button { flex: none; width: 22px; height: 22px; padding: 0; border: 1px solid var(--control-border); border-radius: 4px; background: var(--hover); color: var(--button-text); font: inherit; line-height: 20px; cursor: pointer; }
    .host-form { display: flex; gap: 6px; margin-top: 10px; }
    .host-form input { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid var(--control-border); border-radius: 5px; background: var(--bg); color: var(--text); font: inherit; font-size: 12px; }
    .host-form button { flex: none; padding: 6px 10px; border: 0; border-radius: 5px; background: #fb7299; color: #fff; font: inherit; font-size: 12px; cursor: pointer; }
    .host-error { min-height: 0; margin: 6px 0 0; color: var(--error); font-size: 11px; }
    .host-error:empty { display: none; }
    .host-form input:focus-visible, .host-form button:focus-visible, .manual-host button:focus-visible, .host-option input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .controls { padding: 12px 16px; border-radius: 12px; background: var(--surface); }
    .control-title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 7px; }
    .control-title label { color: var(--label); font-size: 13px; }
    /* A switch row is pressed as a whole: it reaches to near the edge of its block, and its
       padding stands in for the space the rows used to keep between them. */
    .auto-row, .accel-row, .notice-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 -10px; padding: 6px 10px; border-radius: 6px; color: var(--label); font-size: 13px; cursor: pointer; transition: background 160ms ease; }
    .auto-row:hover, .accel-row:hover, .notice-row:hover { background: var(--hover); }
    .auto-row { margin-bottom: 7px; }
    .auto-row .switch, .accel-row .switch, .notice-row .switch { flex: none; }
    .row-text { display: flex; flex-direction: column; gap: 2px; }
    .auto-row small, .accel-row small { color: var(--subtle); font-size: 11px; }
    .controls.auto .slider, .controls.auto .scale { opacity: 0.4; pointer-events: none; }
    output { min-width: 42px; padding: 4px 8px; border-radius: 5px; color: #fff; background: #fb7299; font-size: 13px; font-weight: 700; text-align: center; }
    .slider { position: relative; width: 100%; height: 18px; border-radius: 9px; background: var(--track); }
    .slider-fill { position: absolute; top: 0; bottom: 0; left: 0; width: 60%; border-radius: 9px; background: #fb7299; pointer-events: none; }
    input[type="range"] { position: absolute; inset: 0; width: 100%; height: 18px; margin: 0; appearance: none; -webkit-appearance: none; border: 0; outline: 0; background: transparent; cursor: pointer; }
    input[type="range"]::-webkit-slider-runnable-track { height: 18px; background: transparent; }
    input[type="range"]::-webkit-slider-thumb { width: 24px; height: 24px; margin-top: -3px; appearance: none; -webkit-appearance: none; border: 2px solid #fff; border-radius: 50%; background: #fff; }
    input[type="range"]:focus-visible::-webkit-slider-thumb { border-color: #fb7299; }
    .scale { display: flex; justify-content: space-between; margin-top: 5px; color: var(--subtle); font-size: 10px; }
    .scale span { width: 24px; text-align: center; }
    .scale span:first-child { text-align: left; }
    .scale span:last-child { text-align: right; }
    .accel-controls, .site-controls, .notice-controls, .interface-controls { padding: 5px 16px; border-radius: 12px; background: var(--surface); }
    .manual-host button:hover { border-color: #fb7299; }
    .debug-copy { display: flex; align-items: center; gap: 10px; margin-top: 9px; }
    .debug-copy button { padding: 6px 12px; border: 1px solid #fb7299; border-radius: 6px; background: var(--hover); color: var(--text); font: inherit; font-size: 12px; cursor: pointer; }
    .debug-copy button:hover { background: #fb7299; }
    .debug-copy button:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
    .debug-copy-status { color: var(--success); font-size: 12px; }
    .debug-copy-status.failed { color: var(--error); }
    .debug-copy-note { margin: 8px 0 9px; color: var(--muted); font-size: 11px; line-height: 1.5; }
    .reset-settings { width: 100%; padding: 11px 16px; border: 0; border-radius: 12px; background: var(--surface); color: var(--label); font: inherit; font-size: 13px; text-align: left; cursor: pointer; transition: background 160ms ease, color 160ms ease; }
    .reset-settings:hover { background: var(--hover); }
    .reset-settings[data-asking] { color: var(--error); font-weight: 600; }
    .reset-settings:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .debug-copy-text { width: 100%; height: 120px; margin-top: 8px; padding: 6px; border: 1px solid var(--control-border); border-radius: 6px; background: var(--surface); color: var(--button-text); font: 11px/1.4 Consolas, monospace; resize: vertical; }
    .debug-copy-text[hidden] { display: none; }
    .run-state { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 12px 16px; border-radius: 12px; background: var(--surface); color: var(--label); font-size: 13px; }
    .run-state b { color: var(--text); font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }
    /* 恢复默认设置 and 关闭 stay at the bottom of every page of the panel, solid for the content
       scrolling under them. */
    .btr-footer { position: sticky; bottom: 0; display: grid; gap: 14px; padding: 8px 18px 16px; background: var(--bg); box-shadow: 0 -10px 12px var(--bg); }
    .btr-close { display: block; width: 100%; margin: 0; padding: 8px; border: 0; border-radius: 6px; background: #4a515e; color: #fff; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
    .btr-close:hover { background: #565e6c; }
    .btr-popup[data-theme="light"] .btr-close { background: #dde1e8; color: #1f2329; }
    .btr-popup[data-theme="light"] .btr-close:hover { background: #d0d5de; }
    .btr-close:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .advanced > summary { display: block; padding: 14px 16px; border-radius: 12px; background: var(--surface); list-style: none; cursor: pointer; transition: background 160ms ease; }
    .advanced > summary::-webkit-details-marker { display: none; }
    .advanced > summary:hover { background: var(--hover); }
    .advanced > summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .advanced-title { display: flex; align-items: center; justify-content: space-between; color: var(--label); font-size: 13px; }
    .advanced-title svg { flex: none; width: 16px; height: 16px; color: var(--muted); }
    .advanced > summary small { display: block; margin-top: 6px; color: var(--subtle); font-size: 11px; line-height: 1.6; }
    .view-main, .tab-panel { display: grid; gap: 14px; align-content: start; min-width: 0; }
    .view-main { margin-bottom: 14px; }
    .tab-panel[hidden], [data-host-hidden] { display: none !important; }
    .block { min-width: 0; }
    .block-title { margin: 0 0 6px 2px; color: var(--subtle); font-size: 11px; font-weight: 600; line-height: 1.4; }
    .control-title small { display: block; margin-top: 2px; color: var(--subtle); font-size: 11px; }
    .buffer-controls .scale span { width: auto; }
    .buffer-controls .auto-row { margin: 10px -10px 0; }
    /* 高级设置 is a page of its own: its entry leads in, its bar back, and its tabs keep each
       part short enough for one screen. */
    main.is-advanced .view-main, main.is-advanced .advanced > summary { display: none; }
    .advanced > summary .advanced-title svg { transform: rotate(-90deg); }
    .page-bar { display: flex; align-items: center; gap: 4px; margin: -4px 0 12px -6px; }
    .page-back { display: grid; flex: none; place-items: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--muted); cursor: pointer; transition: background 160ms ease, color 160ms ease; }
    .page-back:hover { background: var(--hover); color: var(--text); }
    .page-back:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .page-back svg { width: 18px; height: 18px; transform: rotate(90deg); }
    .page-title { color: var(--text); font-size: 15px; font-weight: 600; }
    /* Further from what is under it than the blocks are from each other, so the tabs do not
       read as one more block of the page they switch. */
    .tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; margin-bottom: 24px; padding: 3px; border-radius: 10px; background: var(--surface); }
    .tabs button { padding: 7px 4px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; transition: background 180ms ease, color 180ms ease; }
    .tabs button:hover { color: var(--text); }
    .tabs button[aria-selected="true"] { background: var(--tab); color: var(--text); font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, .12); }
    .tabs button:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
    .host-option { border-radius: 4px; }
    .btr-popup { --ripple: rgba(251, 114, 153, .35); }
    .btr-popup[data-theme="light"] { --ripple: rgba(251, 114, 153, .3); }
    .mode-select input:checked + span, .takeover-select input:checked + span, .switch input:checked + span, .host-form button, .debug-copy button:hover { --ripple: rgba(255, 255, 255, .35); }
    ${RIPPLE_CSS}
  `;

  const LAUNCHER_CSS = `
    .btr-launcher { position: fixed; right: 76px; bottom: 116px; display: grid; place-items: center; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%; background: #fb7299; color: #fff; font: 700 13px/1 Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; letter-spacing: .3px; cursor: grab; opacity: .6; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; box-shadow: 0 4px 14px rgba(0, 0, 0, .25); transition: opacity 160ms ease, transform 160ms ease, left 180ms ease, right 180ms ease; }
    .btr-launcher:hover, .btr-launcher:focus-visible { opacity: 1; transform: scale(1.06); }
    .btr-launcher:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .btr-launcher.dragging { cursor: grabbing; opacity: 1; transform: scale(1.1); transition: opacity 160ms ease, transform 160ms ease; }
    @media (max-width: 700px) { .btr-launcher { width: 40px; height: 40px; font-size: 12px; } }
    .btr-launcher { --ripple: rgba(255, 255, 255, .35); }
    .btr-launcher.guiding { opacity: 1; animation: btr-guide-pulse 1.6s ease-in-out infinite; }
    @keyframes btr-guide-pulse { 50% { transform: scale(1.14); } }
    @media (prefers-reduced-motion: reduce) { .btr-launcher.guiding { animation: none; } }
    ${RIPPLE_CSS}
  `;
  const GUIDE_CSS = `
    .btr-guide { position: fixed; inset: 0; background: rgba(0, 0, 0, .72); cursor: pointer; font: 16px/1.5 Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
    .btr-guide p { position: absolute; left: 50%; top: 42%; margin: 0; color: #fff; font-size: 22px; white-space: nowrap; transform: translate(-50%, -50%); }
    .btr-guide b { color: #fb7299; font-weight: 700; }
    .btr-guide svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
    .btr-guide path { fill: none; stroke: #fff; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
    @media (max-width: 480px) { .btr-guide p { font-size: 17px; } }
  `;
  // The guide used to come back on every Bilibili subdomain: its record was in that site's
  // localStorage (#26). It is now in the stored settings (the script manager's, shared by all
  // subdomains), with a cookie on .bilibili.com for when those fall back to localStorage. Both
  // reach every subdomain, so 恢复默认设置 can take the record back everywhere.
  // The desktop client is one site, and it brings its cookies back by itself each time it
  // starts: there a cookie has nothing to do and could not be cleared.
  const GUIDE_COOKIE = "BTR.guideDone";
  function writeGuideCookie(value, seconds) {
    if (hostApp) return;
    try { document.cookie = `${GUIDE_COOKIE}=${value}; domain=.bilibili.com; path=/; max-age=${seconds}; SameSite=Lax; Secure`; } catch (_error) {}
  }
  function guideMarked() {
    if (hostApp) return false;
    try { return document.cookie.split("; ").includes(`${GUIDE_COOKIE}=1`); } catch (_error) { return false; }
  }
  const markGuide = () => writeGuideCookie("1", 315360000);
  const forgetGuide = () => writeGuideCookie("", 0);

  let current = null;
  // bridge.js sends the stored settings when they load or change, and the page its stats.
  let latestSettings = null;
  let latestStats = null;

  // Everything needed to look into a report, as English text to paste into an issue. This only
  // gathers the facts; diagnostic-report.js lays them out (and translates what is left in
  // Chinese, such as BTR's own error messages). The facts carry no cookie values, no account
  // and no download address: only the derived site choices, whether someone is signed in, and
  // node names. A source that cannot be read leaves its part empty and says why in readErrors.
  function diagnostics() {
    const readErrors = [];
    const errorText = (error) => String(error?.message || error?.name || error || "unknown error").slice(0, 160);
    const read = (name, fact, fallback = null) => {
      try { return fact(); } catch (error) {
        readErrors.push(`${name}: ${errorText(error)}`);
        return fallback;
      }
    };
    const cookie = (name) => {
      const value = (new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(document.cookie) || [])[1];
      if (value === undefined) return undefined;
      try { return decodeURIComponent(value); } catch (_error) { return value; }
    };
    const snapshot = {
      capturedAt: Date.now(),
      timeOrigin: performance.timeOrigin,
      now: performance.now(),
      btr: read("btr", () => ({
        version: "2026.11.13.1",
        channel: SCRIPT_CHANNEL,
        otherBuild: ["stable", "canary"].includes(otherScript()) ? otherScript() : "",
        scriptManager: document.documentElement?.getAttribute("data-btr-userscript-manager") || "",
        host: hostApp ? "desktop" : "userscript"
      })),
      env: read("env", () => ({ userAgent: navigator.userAgent, language: navigator.language, viewport: `${root.innerWidth}x${root.innerHeight}`, page: `${location.origin}${location.pathname}` })),
      settings: latestSettings ? { ...latestSettings } : null,
      // Which site Bilibili shows and why (#68). The site cookies only as the choices they
      // stand for; signed in or not, never who.
      site: read("site", () => {
        const marks = document.documentElement?.dataset || {};
        const userSite = String(cookie("user_site") ?? "").toUpperCase();
        let accountSites = null;
        try {
          const sites = JSON.parse(cookie("default_sites") ?? "null");
          if (Array.isArray(sites)) accountSites = sites.map((item) => (["CN", "OVERSEAS"].includes(String(item).toUpperCase()) ? String(item).toUpperCase() : "other"));
        } catch (_error) {}
        const lang = cookie("lang") ?? "";
        return {
          international: Boolean(root.__BTR_BILIBILI_SITE__?.domesticAddress(location.href)),
          signedIn: /(?:^|;\s*)DedeUserID=/.test(document.cookie),
          userSite: ["", "CN", "OVERSEAS"].includes(userSite) ? userSite : "other",
          accountSites,
          lang: /^[A-Za-z]{1,8}(?:[-_][A-Za-z0-9]{1,8}){0,3}$/.test(lang) || !lang ? lang : "other",
          // bridge.js marks the page once it watches for the trips to the international site.
          guard: marks.btrSiteGuard === "on" ? "on" : typeof root.navigation?.addEventListener === "function" ? "off" : "unsupported",
          redirectsBlocked: Number(marks.btrSiteRedirectsBlocked) || 0,
          gaveUp: marks.btrSiteGaveUp === "true"
        };
      }),
      // The video takeover runs on the www and m pages only (page-hook.js).
      video: read("video", () => {
        const api = root.__biliThreadRipperDebug;
        return typeof api?.report === "function" ? JSON.parse(api.report()) : null;
      }),
      stats: read("stats", () => root.__biliThreadRipperDebug?.getStats?.() ?? null),
      autoThreads: read("autoThreads", () => root.__BILI_IDM_DOWNLOADER_FACTORY__?.autoConcurrency?.status?.() ?? null),
      media: read("media", () => root.__BTR_RUNTIME_NOTICES__?.history?.() ?? [], []),
      live: read("live", () => {
        // The live player often sits in a live.bilibili.com iframe, where its module runs with
        // its own clock. Another site's frame cannot be read, and is no module of ours.
        const modules = [];
        const views = [root];
        for (const frame of document.querySelectorAll("iframe")) {
          try { if (frame.contentWindow) views.push(frame.contentWindow); } catch (_error) {}
        }
        let frames = 0;
        for (const view of views) {
          let api = null;
          try { api = view.__biliThreadRipperLiveDebug; } catch (_error) {}
          if (!api || typeof api.getStats !== "function") continue;
          const frame = view === root ? "top" : `iframe ${++frames}`;
          read(`live ${frame}`, () => modules.push({
            frame,
            timeOriginDelta: Math.round((Number(view.performance?.timeOrigin) || performance.timeOrigin) - performance.timeOrigin),
            stats: api.getStats(),
            context: api.getContext?.() ?? null,
            events: api.getEvents?.() ?? []
          }));
        }
        return modules;
      }, []),
      readErrors
    };
    try {
      const formatter = root.__BTR_DIAGNOSTIC_REPORT__;
      if (typeof formatter?.render !== "function") throw new Error("the formatter is not loaded");
      return String(formatter.render(snapshot));
    } catch (error) {
      // The facts as they are, still without any address's query or text in Chinese.
      const text = `BTR diagnostics: formatter failed: ${errorText(error)}\n${JSON.stringify(snapshot, null, 1)}`;
      return text.replace(/((?:https?:)?\/\/[^\s"'?#]+)[?#][^\s"']*/gi, "$1").replace(/[^\x00-\x7f]/g, "?");
    }
  }
  const post = (type, payload) => root.postMessage({ channel: CHANNEL, type, payload }, "*");

  function open(options = {}) {
    if (current) return;
    // A modal <dialog> sits in the browser's top layer and is the only interactive part of
    // the page while it is open. A plain fixed layer can end up under the page's own
    // top-layer elements, or inside a part of the page made inert, and then clicks on it
    // land on whatever is beneath (issue #8).
    const dialog = document.createElement("dialog");
    dialog.id = DIALOG_ID;
    dialog.style.cssText = "all:initial!important;display:block!important;position:fixed!important;inset:0!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:visible!important;z-index:2147483646!important;";
    const dialogStyle = document.createElement("style");
    dialogStyle.textContent = `#${DIALOG_ID}::backdrop{background:transparent}`;
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;";
    dialog.append(dialogStyle, host);
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS + (hostApp?.css || "");
    const backdrop = document.createElement("div");
    backdrop.className = "btr-backdrop";
    const panel = document.createElement("div");
    panel.className = "btr-popup";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "线程撕裂者设置");
    panel.tabIndex = -1;
    panel.innerHTML = PANEL_HTML;
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "btr-close";
    closeButton.textContent = "关闭";
    panel.querySelector(".btr-footer").append(closeButton);
    shadow.append(style, backdrop, panel);
    // The line for Safari users only where it applies: Safari, and every browser on iOS
    // (all of them WebKit underneath).
    panel.querySelector(".safari-note").hidden = !/apple/i.test(navigator.vendor || "");

    const $ = (id) => shadow.getElementById(id);
    // The released script and the Canary are both switched on: only this one runs.
    const other = otherScript();
    if (other) {
      const alsoRunning = $("also-running");
      alsoRunning.textContent = `正式版和 Canary 同时启用了。现在生效的是${CHANNEL_NAMES[SCRIPT_CHANNEL]}，${CHANNEL_NAMES[other] || other}没有运行。请在脚本管理器里只启用一个。`;
      alsoRunning.hidden = false;
    }
    for (const selector of hostApp?.hide || []) {
      for (const node of panel.querySelectorAll(selector)) (node.closest(".block") || node).dataset.hostHidden = "";
    }
    if (hostApp?.projectUrl) $("github-link").href = hostApp.projectUrl;
    hostApp?.mount?.(panel);
    const advanced = $("advanced");
    const panelMain = panel.querySelector("main");
    const tabs = [...panel.querySelectorAll('[role="tab"]:not([data-host-hidden])')];
    const tabPanels = [...panel.querySelectorAll("[data-tab-panel]")];
    const still = () => root.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const EASE = "cubic-bezier(.2, .8, .2, 1)";
    // The panel's height glides to what it shows next instead of jumping there.
    const resize = (change) => {
      const from = panel.offsetHeight;
      change();
      const to = panel.offsetHeight;
      if (still() || Math.abs(to - from) < 2) return;
      panel.style.overflow = "hidden";
      panel.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 240, easing: EASE }).finished
        .finally(() => { panel.style.overflow = ""; }).catch(() => {});
    };
    const enter = (node, from) => {
      if (node && !still()) node.animate([{ opacity: 0, transform: from }, { opacity: 1, transform: "none" }], { duration: 240, easing: EASE });
    };
    let advancedTab = "network";
    const selectTab = (name) => {
      advancedTab = name;
      for (const tab of tabs) {
        tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
        tab.tabIndex = tab.dataset.tab === name ? 0 : -1;
      }
      for (const part of tabPanels) part.hidden = part.dataset.tabPanel !== name;
    };
    const showAdvanced = (show, animate = true) => {
      const change = () => {
        advanced.open = show;
        panelMain.classList.toggle("is-advanced", show);
      };
      if (!animate) return change();
      clearRipples(panel);
      resize(change);
      enter(panel.querySelector(show ? ".advanced-page" : ".view-main"), show ? "translateX(18px)" : "translateX(-18px)");
    };
    // The panel always opens on its first page; "自定义" in the gear menu opens it on the
    // custom servers, under 网络.
    selectTab("network");
    showAdvanced(options.advanced === true, false);
    advanced.querySelector("summary").addEventListener("click", (event) => {
      event.preventDefault();
      showAdvanced(true);
      // From the keyboard, the focus follows to the page's way back.
      if (event.detail === 0) $("advanced-back").focus();
    });
    $("advanced-back").addEventListener("click", (event) => {
      showAdvanced(false);
      if (event.detail === 0) advanced.querySelector("summary").focus();
    });
    for (const tab of tabs) {
      tab.addEventListener("click", () => {
        if (tab.dataset.tab === advancedTab) return;
        resize(() => selectTab(tab.dataset.tab));
        enter(tabPanels.find((part) => !part.hidden), "translateY(6px)");
      });
    }
    // The arrow keys go from tab to tab, as in any tab list.
    panel.querySelector(".tabs").addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = tabs[(tabs.findIndex((tab) => tab.dataset.tab === advancedTab) + step + tabs.length) % tabs.length];
      next.focus();
      next.click();
    });
    // A press ripples over a whole switch row, the colored part of any other switch or of a
    // choice, otherwise over the control itself.
    panel.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const target = event.target.closest(".auto-row, .accel-row, .notice-row")
        || event.target.closest("button, a[href], summary, .switch, .mode-select label, .takeover-select label, .host-option");
      if (!target || target.matches(":disabled")) return;
      ripple(target.matches(".switch, .mode-select label, .takeover-select label") ? target.querySelector("span") : target, event);
    });
    const enabled = $("enabled");
    const disabledNote = $("disabled-note");
    const needsEnabled = [...panel.querySelectorAll("[data-needs-enabled]")];
    const concurrency = $("concurrency");
    const autoConcurrency = $("auto-concurrency");
    const theme = $("theme");
    const systemTheme = root.matchMedia("(prefers-color-scheme: dark)");
    const systemColors = () => (systemTheme.matches ? "dark" : "light");
    const applyTheme = () => {
      panel.dataset.theme = theme.dataset.value === "auto" ? systemColors() : theme.dataset.value;
    };
    const showTheme = (value) => {
      theme.dataset.value = value;
      theme.title = `面板主题：${THEME_LABELS[value]}。点击切换`;
      theme.setAttribute("aria-label", theme.title);
      applyTheme();
    };
    systemTheme.addEventListener("change", applyTheme);
    const threadValue = $("thread-value");
    const sliderFill = $("slider-fill");
    const bufferAhead = $("buffer-ahead");
    const bufferValue = $("buffer-value");
    const bufferFill = $("buffer-fill");
    const secondaryBuffer = $("secondary-buffer");
    const liveEnabled = $("live-enabled");
    const episodeEnabled = $("episode-enabled");
    const blockInternational = $("block-international");
    const floatingButton = $("floating-button");
    const resetSettings = $("reset-settings");
    const customSection = $("custom-hosts");
    const hostInput = $("host-input");
    const hostError = $("host-error");
    const activeCount = $("active-count");
    const totalSpeed = panel.querySelector(".run-speed");
    let customHosts = [];

    const save = (update) => post("settings-update", update);

    function setSlider(threads) {
      const index = THREAD_OPTIONS.indexOf(Number(threads));
      const safe = index < 0 ? 1 : index;
      concurrency.value = String(safe);
      // In the automatic mode the badge says so; the slider keeps the viewer's own count.
      threadValue.value = autoConcurrency.checked ? "自动" : String(THREAD_OPTIONS[safe]);
      concurrency.setAttribute("aria-valuetext", String(THREAD_OPTIONS[safe]));
      sliderFill.style.width = `${safe / (THREAD_OPTIONS.length - 1) * 100}%`;
    }

    function setBufferSlider(seconds) {
      const index = BUFFER_OPTIONS.indexOf(Number(seconds));
      const safe = index < 0 ? 1 : index;
      bufferAhead.value = String(safe);
      bufferValue.value = `${BUFFER_OPTIONS[safe]}s`;
      bufferAhead.setAttribute("aria-valuetext", `${BUFFER_OPTIONS[safe]} 秒`);
      bufferFill.style.width = `${safe / (BUFFER_OPTIONS.length - 1) * 100}%`;
    }

    function setMode(mode) {
      for (const radio of shadow.querySelectorAll('input[name="mode"]')) radio.checked = radio.value === mode;
      customSection.hidden = mode !== "custom";
    }

    function renderHosts() {
      $("custom-count").textContent = String(customHosts.length);
      $("custom-empty").hidden = customHosts.length > 0;
      const known = $("known-hosts");
      known.replaceChildren(...HOST_GROUPS.map(([title, hosts]) => {
        const group = document.createElement("fieldset");
        group.className = "host-group";
        const legend = document.createElement("legend");
        legend.textContent = title;
        group.append(legend, ...hosts.map((value) => {
          const label = document.createElement("label");
          label.className = "host-option";
          const input = document.createElement("input");
          input.type = "checkbox";
          input.value = value;
          input.checked = customHosts.includes(value);
          const text = document.createElement("span");
          text.textContent = value;
          label.append(input, text);
          return label;
        }));
        return group;
      }));
      $("manual-hosts").replaceChildren(...customHosts.filter((value) => !KNOWN_HOSTS.includes(value)).map((value) => {
        const row = document.createElement("div");
        row.className = "manual-host";
        const text = document.createElement("span");
        text.textContent = value;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.dataset.remove = value;
        remove.textContent = "×";
        remove.setAttribute("aria-label", `删除 ${value}`);
        row.append(text, remove);
        return row;
      }));
    }

    function setCustomHosts(next) {
      customHosts = next;
      renderHosts();
      save({ customHosts });
    }

    function render(settings) {
      showTheme(settings.theme);
      enabled.checked = settings.enabled;
      disabledNote.hidden = settings.enabled !== false;
      panelMain.classList.toggle("is-off", settings.enabled === false);
      for (const node of needsEnabled) node.inert = settings.enabled === false;
      for (const radio of shadow.querySelectorAll('input[name="takeover"]')) radio.checked = radio.value === settings.takeover;
      autoConcurrency.checked = settings.autoConcurrency === true;
      setSlider(settings.concurrency);
      setBufferSlider(settings.bufferAheadSeconds);
      secondaryBuffer.checked = settings.secondaryBuffer === true;
      concurrency.disabled = autoConcurrency.checked;
      concurrency.closest(".controls").classList.toggle("auto", autoConcurrency.checked);
      setMode(settings.mode);
      customHosts = settings.customHosts;
      renderHosts();
      liveEnabled.checked = settings.liveEnabled === true;
      episodeEnabled.checked = settings.episodeEnabled !== false;
      blockInternational.checked = settings.blockInternational === true;
      floatingButton.checked = settings.floatingButton !== false;
    }

    enabled.addEventListener("change", () => save({ enabled: enabled.checked }));
    // Each click goes on to the next choice: from 自动 to the colors the system is not showing,
    // then to the ones it is (now kept by hand), then back to 自动.
    theme.addEventListener("click", () => {
      const system = systemColors();
      const other = system === "dark" ? "light" : "dark";
      const current = theme.dataset.value;
      const next = current === "auto" ? other : current === other ? system : "auto";
      showTheme(next);
      save({ theme: next });
    });
    liveEnabled.addEventListener("change", () => save({ liveEnabled: liveEnabled.checked }));
    episodeEnabled.addEventListener("change", () => save({ episodeEnabled: episodeEnabled.checked }));
    blockInternational.addEventListener("change", () => save({ blockInternational: blockInternational.checked }));
    floatingButton.addEventListener("change", () => save({ floatingButton: floatingButton.checked }));
    concurrency.addEventListener("input", () => {
      const threads = THREAD_OPTIONS[Number(concurrency.value)];
      setSlider(threads);
      save({ concurrency: threads });
    });
    autoConcurrency.addEventListener("change", () => save({ autoConcurrency: autoConcurrency.checked }));
    bufferAhead.addEventListener("input", () => {
      const seconds = BUFFER_OPTIONS[Number(bufferAhead.value)];
      setBufferSlider(seconds);
      save({ bufferAheadSeconds: seconds });
    });
    secondaryBuffer.addEventListener("change", () => save({ secondaryBuffer: secondaryBuffer.checked }));
    for (const radio of shadow.querySelectorAll('input[name="mode"]')) {
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        setMode(radio.value);
        save({ mode: radio.value });
      });
    }
    for (const radio of shadow.querySelectorAll('input[name="takeover"]')) {
      radio.addEventListener("change", () => { if (radio.checked) save({ takeover: radio.value }); });
    }
    $("known-hosts").addEventListener("change", (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || !KNOWN_HOSTS.includes(input.value)) return;
      if (input.checked && customHosts.length >= MAX_CUSTOM_HOSTS) {
        input.checked = false;
        hostError.textContent = `最多选 ${MAX_CUSTOM_HOSTS} 个服务器。`;
        return;
      }
      hostError.textContent = "";
      setCustomHosts(input.checked ? [...customHosts.filter((value) => value !== input.value), input.value] : customHosts.filter((value) => value !== input.value));
    });
    $("manual-hosts").addEventListener("click", (event) => {
      const value = event.target instanceof HTMLElement ? event.target.dataset.remove : "";
      if (value) setCustomHosts(customHosts.filter((item) => item !== value));
    });
    $("host-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const value = core.normalizeCdnHost(hostInput.value);
      if (!value) hostError.textContent = "这不是 B 站的视频服务器地址。";
      else if (customHosts.includes(value)) hostError.textContent = "这个服务器已经在列表里了。";
      else if (customHosts.length >= MAX_CUSTOM_HOSTS) hostError.textContent = `最多选 ${MAX_CUSTOM_HOSTS} 个服务器。`;
      else {
        hostError.textContent = "";
        hostInput.value = "";
        setCustomHosts([...customHosts, value]);
      }
    });
    // It asks in place: the second click is the answer, and going elsewhere takes the question back.
    let resetAsked = 0;
    const stopAsking = () => {
      root.clearTimeout(resetAsked);
      delete resetSettings.dataset.asking;
      resetSettings.textContent = "恢复默认设置";
    };
    resetSettings.addEventListener("click", () => {
      if (resetSettings.dataset.asking) {
        stopAsking();
        // Back to first use: the guide comes up again as soon as the panel is out of the way.
        forgetGuide();
        post("settings-reset");
        current?.close();
        return;
      }
      resetSettings.dataset.asking = "true";
      resetSettings.textContent = "确认？";
      resetAsked = root.setTimeout(stopAsking, 4000);
    });
    resetSettings.addEventListener("blur", stopAsking);
    const copyStatus = $("debug-copy-status");
    const copyText = $("debug-copy-text");
    const copyButton = $("debug-copy");
    let copyDoneTimer = 0;
    copyButton.addEventListener("click", async () => {
      const text = diagnostics();
      let copied = false;
      try { await navigator.clipboard.writeText(text); copied = true; } catch (_error) {}
      if (!copied) {
        // Without the clipboard API (or its permission): select the text for the viewer.
        copyText.hidden = false;
        copyText.value = text;
        copyText.focus();
        copyText.select();
        try { copied = document.execCommand("copy"); } catch (_error) {}
      }
      // Done, the button says so in place for a moment, keeping its width; otherwise the note
      // next to it points to the text to copy by hand.
      root.clearTimeout(copyDoneTimer);
      copyStatus.classList.toggle("failed", !copied);
      copyStatus.textContent = copied ? "" : "没能自动复制，请手动复制下面的内容";
      if (!copied) return;
      if (!copyButton.style.minWidth) copyButton.style.minWidth = `${copyButton.offsetWidth}px`;
      copyButton.textContent = "已复制";
      copyDoneTimer = root.setTimeout(() => { copyButton.textContent = "复制诊断信息"; }, 2500);
    });

    // Keys typed into the panel belong to it. The shadow root hides the input from the page,
    // so the player's shortcuts (space, F, arrows) would otherwise react to them.
    const keepKeys = (event) => { if (event.key !== "Escape") event.stopPropagation(); };
    for (const type of ["keydown", "keyup", "keypress"]) panel.addEventListener(type, keepKeys);

    // The threads and the speed now: asking for stats makes the page send fresh ones. The
    // numbers run to their new values instead of jumping there.
    const shown = { threads: 0, speed: 0 };
    let rollFrame = 0;
    const showRunState = (threads, speed) => {
      activeCount.textContent = String(Math.round(threads));
      totalSpeed.textContent = formatSpeed(speed);
    };
    const refresh = () => {
      const from = { ...shown };
      shown.threads = Math.max(0, Math.trunc(Number(latestStats?.activeThreads) || 0));
      shown.speed = Math.max(0, Number(latestStats?.totalSpeedBps) || 0);
      root.cancelAnimationFrame(rollFrame);
      if (still() || (from.threads === shown.threads && from.speed === shown.speed)) showRunState(shown.threads, shown.speed);
      else {
        const startedAt = performance.now();
        const roll = (now) => {
          if (current?.host !== host) return;
          const progress = Math.min(1, (now - startedAt) / 360);
          const eased = 1 - (1 - progress) ** 3;
          showRunState(from.threads + (shown.threads - from.threads) * eased, from.speed + (shown.speed - from.speed) * eased);
          if (progress < 1) rollFrame = root.requestAnimationFrame(roll);
        };
        rollFrame = root.requestAnimationFrame(roll);
      }
      post("get-stats");
    };
    const timer = setInterval(refresh, 400);
    const onKey = (event) => { if (event.key === "Escape") close(); };
    // However the panel was found, the viewer has found it.
    launcher?.finishGuide();
    const close = () => {
      if (current?.host !== host) return;
      current = null;
      clearInterval(timer);
      root.cancelAnimationFrame(rollFrame);
      systemTheme.removeEventListener("change", applyTheme);
      launcher?.apply();
      document.removeEventListener("keydown", onKey, true);
      clearRipples(panel);
      dialog.remove();
    };
    // Changes made elsewhere (the gear menu, another tab) arrive as new settings.
    current = { host, close, render };
    launcher?.apply();
    backdrop.addEventListener("click", close);
    closeButton.addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);
    // Esc on a modal dialog closes it natively; clean up the same way as the button.
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    (document.body || document.documentElement).append(dialog);
    try { dialog.showModal(); }
    catch (_error) { dialog.setAttribute("open", ""); }
    // Until bridge.js sends the stored settings, its defaults: 自动线程数 is on there, while
    // normalizeSettings on its own leaves it off.
    render(latestSettings || core.normalizeSettings({ autoConcurrency: true }));
    post("get-settings");
    refresh();
    panel.focus();
  }

  const toggle = () => (current ? current.close() : open());

  // The button in the corner of every bilibili page. The userscript manager's menu is not
  // obvious (and on the home page people do not find it at all), so the panel needs a way in
  // that is always visible.
  // It hides while the video is fullscreen, while the panel itself is open, and when 悬浮按钮
  // is switched off.
  const launcher = (() => {
    if (root.top !== root) return null;
    const MARGIN = 12;
    // How far a press has to travel before it counts as dragging rather than a click.
    const DRAG_SLOP = 4;
    // Let go this close to the left or right edge and it snaps flush to it; let go anywhere
    // else and it simply stays where it was put.
    const SNAP_PX = 72;
    let host = null;
    let button = null;
    let wanted = true;
    // Where the viewer left it, as shares of the window: 0 means stuck to the left edge, 1 to
    // the right edge, anything between is a free spot. null: never moved.
    let leftRatio = null;
    let topRatio = null;
    let dragging = null;
    // The first-run guide waits for the stored settings: before they arrive nobody knows
    // whether it was answered already.
    let guide = null;
    let guideAnswered = null;

    function finishGuide() {
      if (guideAnswered === true && !guide) return;
      guideAnswered = true;
      markGuide();
      post("settings-update", { guideDone: true });
      hideGuide();
    }

    function hideGuide() {
      if (!guide) return;
      root.cancelAnimationFrame(guide.frame);
      guide.host.remove();
      guide = null;
      button?.classList.remove("guiding");
    }

    // The arrow is drawn again on every frame, so it stays on the button however the button
    // or the window moves: from the edge of the text, curving, to just short of the button.
    function drawGuide() {
      if (!guide || !button?.isConnected) return;
      guide.frame = root.requestAnimationFrame(drawGuide);
      const target = button.getBoundingClientRect(), text = guide.text.getBoundingClientRect();
      const toX = target.left + target.width / 2, toY = target.top + target.height / 2;
      const fromX = text.left + text.width / 2, fromY = text.top + text.height / 2;
      const distance = Math.hypot(toX - fromX, toY - fromY) || 1;
      const unitX = (toX - fromX) / distance, unitY = (toY - fromY) / distance;
      // Where the line from the text's middle leaves its box.
      const leave = Math.min(unitX ? (text.width / 2 + 14) / Math.abs(unitX) : Infinity, unitY ? (text.height / 2 + 14) / Math.abs(unitY) : Infinity);
      const stop = target.width / 2 + 16;
      if (distance - leave - stop < 24) { guide.arrow.setAttribute("d", ""); return; }
      const startX = fromX + unitX * leave, startY = fromY + unitY * leave;
      const endX = toX - unitX * stop, endY = toY - unitY * stop;
      const bend = (distance - leave - stop) * .18;
      const bendX = (startX + endX) / 2 - unitY * bend, bendY = (startY + endY) / 2 + unitX * bend;
      const angle = Math.atan2(endY - bendY, endX - bendX);
      const barb = (side) => `${(endX - 15 * Math.cos(angle + side)).toFixed(1)} ${(endY - 15 * Math.sin(angle + side)).toFixed(1)}`;
      guide.arrow.setAttribute("d", `M${startX.toFixed(1)} ${startY.toFixed(1)} Q${bendX.toFixed(1)} ${bendY.toFixed(1)} ${endX.toFixed(1)} ${endY.toFixed(1)} M${barb(.5)} L${endX.toFixed(1)} ${endY.toFixed(1)} L${barb(-.5)}`);
    }

    function showGuide() {
      const guideHost = document.createElement("div");
      guideHost.id = GUIDE_ID;
      guideHost.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483644!important;";
      const shadow = guideHost.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = GUIDE_CSS;
      const cover = document.createElement("div");
      cover.className = "btr-guide";
      cover.innerHTML = '<p>点这里打开全新 <b>线程撕裂者</b> 设置</p><svg aria-hidden="true"><path></path></svg>';
      // A click anywhere on it counts: it is the only thing on the screen that can be clicked.
      cover.addEventListener("click", () => open());
      shadow.append(style, cover);
      (document.body || document.documentElement).append(guideHost);
      guide = { host: guideHost, text: cover.querySelector("p"), arrow: cover.querySelector("path"), frame: 0 };
      button.classList.add("guiding");
      drawGuide();
    }

    // Bilibili fills the screen in two ways: the browser fullscreen API, and its own 网页全屏,
    // which only resizes the player inside the page. Rather than follow Bilibili class names,
    // this asks the picture itself: a video that covers the window is a video being watched
    // full screen, whichever way it got there.
    const fullscreen = () => {
      if (document.fullscreenElement || document.webkitFullscreenElement || document.webkitIsFullScreen) return true;
      const width = root.innerWidth, height = root.innerHeight;
      if (!width || !height) return false;
      for (const video of document.querySelectorAll("video")) {
        const box = video.getBoundingClientRect();
        if (box.width >= width * 0.92 && box.height >= height * 0.92) return true;
      }
      return false;
    };

    const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

    // Puts it back where it was left. Without a saved spot it sits where it always did: to the
    // left of Bilibili's own column of round buttons, near the bottom.
    function place() {
      if (!button) return;
      const size = button.offsetHeight || 44;
      const width = root.innerWidth || 0, height = root.innerHeight || 0;
      if (leftRatio === null || topRatio === null) {
        button.style.top = `${Math.round(Math.max(MARGIN, height - size - 116))}px`;
        button.style.right = "76px";
        button.style.left = "auto";
        button.style.bottom = "auto";
        return;
      }
      button.style.top = `${Math.round(clamp(topRatio * height, MARGIN, Math.max(MARGIN, height - size - MARGIN)))}px`;
      button.style.bottom = "auto";
      if (leftRatio >= 1) {
        button.style.right = `${MARGIN}px`;
        button.style.left = "auto";
        return;
      }
      button.style.left = `${Math.round(clamp(leftRatio * width, MARGIN, Math.max(MARGIN, width - size - MARGIN)))}px`;
      button.style.right = "auto";
    }

    function startDrag(event) {
      if (event.button !== undefined && event.button !== 0) return;
      const box = button.getBoundingClientRect();
      dragging = {
        pointerId: event.pointerId,
        grabX: event.clientX - box.left,
        grabY: event.clientY - box.top,
        fromX: event.clientX,
        fromY: event.clientY,
        moved: false
      };
      try { button.setPointerCapture(event.pointerId); } catch (_error) {}
    }

    function moveDrag(event) {
      if (!dragging || event.pointerId !== dragging.pointerId) return;
      if (!dragging.moved && Math.hypot(event.clientX - dragging.fromX, event.clientY - dragging.fromY) < DRAG_SLOP) return;
      dragging.moved = true;
      button.classList.add("dragging");
      const size = button.offsetHeight || 44;
      const width = root.innerWidth, height = root.innerHeight;
      // Kept as numbers: where it lands is decided from these, not from a fresh layout
      // read, which the browser is free to postpone until the pointer is already up.
      dragging.left = Math.round(clamp(event.clientX - dragging.grabX, MARGIN, width - size - MARGIN));
      dragging.top = Math.round(clamp(event.clientY - dragging.grabY, MARGIN, height - size - MARGIN));
      dragging.size = size;
      button.style.left = `${dragging.left}px`;
      button.style.top = `${dragging.top}px`;
      button.style.right = "auto";
      event.preventDefault();
    }

    function endDrag(event) {
      if (!dragging || event.pointerId !== dragging.pointerId) return;
      const { moved, left = 0, top = 0, size = 44 } = dragging;
      try { button.releasePointerCapture(dragging.pointerId); } catch (_error) {}
      dragging = null;
      button.classList.remove("dragging");
      if (!moved) return;
      // Dropped within reach of the left or right edge: snap flush to it, and remember the
      // edge rather than the pixel, so it stays there whatever the window size. Dropped
      // anywhere else: it stays exactly where it was put.
      const width = root.innerWidth || 1;
      if (left <= SNAP_PX) leftRatio = 0;
      else if (left + size >= width - SNAP_PX) leftRatio = 1;
      else leftRatio = clamp(left / width, 0, 1);
      topRatio = clamp(top / (root.innerHeight || 1), 0, 1);
      place();
      post("settings-update", { floatingButtonLeft: leftRatio, floatingButtonTop: topRatio });
    }

    function mount() {
      if (host?.isConnected) return;
      host = document.createElement("div");
      host.id = LAUNCHER_ID;
      host.style.cssText = "all:initial!important;position:fixed!important;right:0!important;bottom:0!important;width:0!important;height:0!important;z-index:2147483645!important;";
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = LAUNCHER_CSS;
      button = document.createElement("button");
      button.type = "button";
      button.className = "btr-launcher";
      button.title = "线程撕裂者设置（可以拖动）";
      button.setAttribute("aria-label", "线程撕裂者设置");
      button.textContent = "BTR";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        // A drag that ended on the button itself must not also open the panel.
        if (button.dataset.dragged === "true") {
          button.dataset.dragged = "";
          return;
        }
        toggle();
      });
      button.addEventListener("pointerdown", (event) => {
        if (event.button === 0) ripple(button, event);
        startDrag(event);
      });
      button.addEventListener("pointermove", moveDrag);
      for (const type of ["pointerup", "pointercancel"]) {
        button.addEventListener(type, (event) => {
          const moved = Boolean(dragging?.moved);
          endDrag(event);
          if (moved) button.dataset.dragged = "true";
        });
      }
      shadow.append(style, button);
      (document.body || document.documentElement).append(host);
      place();
    }

    function apply() {
      const show = wanted && !fullscreen() && !current;
      if (!show) {
        hideGuide();
        host?.remove();
        return;
      }
      // Bilibili replaces large parts of the page when you navigate; mount puts it back if it went.
      mount();
      if (!dragging) place();
      if (guide && !(guide.host.isConnected && button.isConnected)) hideGuide();
      if (guideAnswered === false && !guide) showGuide();
    }

    const update = (settings) => {
      wanted = settings?.floatingButton !== false;
      // null (never dragged) must stay null: Number(null) is 0, which would pin it to a corner.
      const ratio = (value) => (value != null && Number(value) >= 0 && Number(value) <= 1 ? Number(value) : null);
      leftRatio = ratio(settings?.floatingButtonLeft);
      topRatio = ratio(settings?.floatingButtonTop);
      if (settings?.guideDone === true) {
        guideAnswered = true;
        markGuide();
        hideGuide();
      } else if (guideMarked()) {
        // Answered on another subdomain or before the stored settings could take it.
        guideAnswered = false;
        finishGuide();
      } else guideAnswered = false;
      apply();
    };
    for (const type of ["fullscreenchange", "webkitfullscreenchange"]) document.addEventListener(type, apply, true);
    root.addEventListener("resize", apply);
    // A page that swaps its body (the SPA navigations) drops the button with it.
    setInterval(apply, 2000);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once: true });
    // The button is on by default, so it is there before the stored settings arrive.
    apply();
    return { update, apply, finishGuide };
  })();

  root.addEventListener("message", (event) => {
    if (event.source !== root || event.data?.channel !== CHANNEL) return;
    if (event.data.type === "settings") {
      latestSettings = core.normalizeSettings(event.data.payload);
      launcher?.update(latestSettings);
      current?.render(latestSettings);
    } else if (event.data.type === "stats") {
      latestStats = event.data.payload;
    } else if (event.data.type === "open-settings" && root.top === root) {
      // "自定义" in the gear menu: the custom servers are under 高级设置.
      open({ advanced: true });
    }
  });
  // The userscript manager's menu entry.
  document.addEventListener("btr-userscript-open-settings", () => { if (root.top === root) toggle(); });

  // Settings sent before this file ran went unheard.
  post("get-settings");

  root.__BTR_SETTINGS_PANEL__ = Object.freeze({ open, close: () => current?.close(), toggle, isOpen: () => Boolean(current) });
})(globalThis);

/* src/page-hook.js */
(function installPageHook(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const INSTALL_FLAG = "__biliThreadRipper0901Installed";
  const BILIBILI_API_ORIGIN = "https://api.bilibili.com";
  const THREAD_OPTIONS = Object.freeze([4, 8, 16, 32, 64, 128]);
  const SETTINGS_ID = "__bilibili_thread_ripper_native_settings__";
  const SETTINGS_STYLE_ID = "__bilibili_thread_ripper_native_settings_style__";
  if (root[INSTALL_FLAG]) return;
  // The userscript runs on every bilibili.com page. The video takeover belongs to the video
  // pages only: the live site has its own module (live-hook.js), and elsewhere only the
  // settings panel is wanted.
  const pageHost = root.location?.hostname || "";
  if (/(^|\.)bilibili\.com$/i.test(pageHost) && !/^(www|m)\.bilibili\.com$/i.test(pageHost)) return;

  const core = root.__BILI_RANGE_CORE__;
  const playerFactory = root.__BILI_NATIVE_MSE_PLAYER_FACTORY__;
  const notices = root.__BTR_RUNTIME_NOTICES__;
  if (!core || !playerFactory || typeof root.fetch !== "function") return;
  Object.defineProperty(root, INSTALL_FLAG, { value: true });

  const nativeFetch = root.fetch.bind(root);
  let settings = core.normalizeSettings({});
  let settingsLoaded = false;
  let player = null;
  let playerRoute = "";

  // What happened to the takeover on this page: each player keeps its own timeline, which is
  // gone once it is replaced, and that is exactly when a report is needed (a video that went
  // black and came back at another position). Positions, states and failures only, in
  // English: the diagnostic copy prints them as they are (diagnostic-report.js translates the
  // error messages).
  // level is debug, info, warn or error. One kind of event cannot crowd out the others: each
  // keeps its newest 30, and a full list gives up its oldest debug and info entries first. A
  // repeat within two seconds only counts up.
  const pageEvents = [];
  const PAGE_EVENT_LIMIT = 200;
  const PAGE_EVENTS_PER_KIND = 30;
  function remember(what, detail = "", level = "info") {
    const video = player?.video || document.querySelector("#bilibili-player video, .bpx-player-container video");
    const at = Math.round(performance.now());
    detail = withoutQuery(detail).slice(0, 200);
    const last = pageEvents.at(-1);
    if (last && last.what === what && last.detail === detail && at - last.at < 2000) {
      last.count = (last.count || 1) + 1;
      return;
    }
    pageEvents.push({ at, time: Math.round((Number(video?.currentTime) || 0) * 10) / 10, what, detail, level });
    const sameKind = pageEvents.filter((event) => event.what === what);
    if (sameKind.length > PAGE_EVENTS_PER_KIND) pageEvents.splice(pageEvents.indexOf(sameKind[0]), 1);
    if (pageEvents.length > PAGE_EVENT_LIMIT) {
      const index = ["debug", "info"].map((minor) => pageEvents.findIndex((event) => event.level === minor)).find((found) => found >= 0);
      pageEvents.splice(index ?? 0, 1);
    }
  }
  // An error as the text it was thrown with, less any address's query.
  function errorText(error) {
    return withoutQuery(error?.message || error?.name || error || "").slice(0, 180);
  }
  // An address keeps its host and path: its query holds the signature and the expiry.
  function withoutQuery(text) {
    return String(text ?? "").replace(/((?:https?:)?\/\/[^\s"'?#]+)[?#][^\s"']*/gi, "$1");
  }

  // A CDN node that twice sends nothing, and a download address the nodes keep refusing, is
  // skipped until the page moves to another video.
  // Restarting the takeover for the same video keeps the list.
  let cdnBanRoute = "";
  // The bans of this video, for the diagnostic copy; they go with the list when it resets.
  let bans = [];
  const cdnBans = root.__BILI_CDN_RESOLVER_FACTORY__?.createBanList({
    onBan(host, count, error, kind) {
      const address = kind === "address";
      bans.push({ at: Math.round(performance.now()), kind: address ? "address" : "node", host: String(host || ""), count: Number(count) || 0, error: errorText(error) });
      if (bans.length > 40) bans.shift();
      // The ban is decided while the failed range is still being reported: its event comes
      // after that range's, which is the one that caused it.
      const record = (what, detail) => queueMicrotask(() => remember(what, detail, "warn"));
      if (address) record("address banned", "refused by the nodes");
      else record("node banned", `${host}, ${Number(count) || 0} failures with no data`);
    }
  }) || null;
  let playerContainer = null;
  let playerLifecycle = 0;
  let qualityPlayer = null;
  let syncedQuality = 0;
  let syncedAutoQuality = 0;
  let codecPlayer = null;
  let syncedCodec = "";
  let infoPanel = null;
  let infoPanelObserver = null;
  const lastHostByKind = { video: "", audio: "" };
  const recentBytes = [];
  // Every video byte downloaded, for the speed 自动 chooses by (measureAutoSpeed).
  let videoBytesIn = 0;
  // The video bytes of requests that are over, and those of them in pieces that were
  // completed and used (a second copy that loses its race is cancelled).
  let videoBytesEnded = 0;
  let videoBytesUsed = 0;
  let failedRoute = "";
  let startingRoute = "";
  let routeGeneration = 0;
  let routeRequestController = null;
  let restartTimer = null;
  let nativeCoreWait = null;
  let publishTimer = null;
  let menuSyncTimer = null;
  let pendingPodSwitch = null;
  let trustedPodVideoKey = "";
  let takeoverFailureRoute = "";
  let takeoverFailureCount = 0;
  let takeoverFailureStartedAt = 0;
  // The next try of a playlist request that failed, per route (see startPlayer).
  let playinfoRetry = { route: "", at: 0, count: 0 };
  let autoRetakeTimer = null;
  let autoRetakeRoute = "";
  let autoRetakeCount = 0;
  let autoRetakeAt = 0;
  let transferSequence = 1;
  const transfers = new Map();
  // Every download since the page loaded, for the diagnostic copy: per kind, why the cancelled
  // ones were cancelled (the message they were cancelled with), and per node.
  const downloads = {
    byKind: Object.fromEntries(["video", "audio", "meta"].map((kind) => [kind, { started: 0, ok: 0, failed: 0, cancelled: 0, bytes: 0 }])),
    cancelReasons: {},
    hosts: {},
    lastBytesAt: null
  };
  function downloadHost(host) {
    const key = host || "unknown";
    if (!downloads.hosts[key] && Object.keys(downloads.hosts).length >= 64) return null;
    downloads.hosts[key] ||= { ok: 0, failed: 0, cancelled: 0, bytes: 0, lastError: "", lastErrorAt: null };
    return downloads.hosts[key];
  }
  // 自动线程数 lives in the downloader; its steps are reported here.
  const autoThreads = root.__BILI_IDM_DOWNLOADER_FACTORY__?.autoConcurrency || null;
  autoThreads?.subscribe(({ threads, previous, reason }) => {
    if (!settings.autoConcurrency) return;
    stats.autoThreads = threads;
    remember("threads changed", `${previous} -> ${threads} (${reason})`);
    schedulePublish();
  });

  const FULL_ARCHITECTURE = "bilibili-native-ui-progressive-mse-0.8-core";
  const stats = {
    version: "2026.11.13.1",
    architecture: FULL_ARCHITECTURE,
    mode: settings.mode,
    playerState: "waiting",
    quality: "",
    bufferedAhead: 0,
    acceleratedRequests: 0,
    acceleratedBytes: 0,
    parallelSubrequests: 0,
    activeThreads: 0,
    autoThreads: 0,
    totalSpeedBps: 0,
    threadSpeeds: [],
    discoveredCdns: 0,
    healthyCdns: 0,
    blockedCdns: 0,
    cdnHosts: [],
    lastHost: "",
    lastError: "",
    takeoverError: null
  };

  // The tab going to the background and coming back, which Bilibili's player reacts to (#66):
  // one entry when it comes back, while BTR plays a video.
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { hiddenAt = performance.now(); return; }
    if (hiddenAt && player) remember("page was in the background", `${((performance.now() - hiddenAt) / 1000).toFixed(1)} s`);
    hiddenAt = 0;
  });
  // The timeline of the player stopped last: when Bilibili's player put its own source in
  // place, the report only had the one that took over again (#65).
  let previousTimeline = null;

  // A media clock alone cannot show a stale picture (#45). Keep the most recently presented
  // frame's timestamp for the diagnostic copy; no canvas/readback involved.
  let frameWatch = null;
  function stopFrameWatch() {
    const previous = frameWatch;
    frameWatch = null;
    if (previous?.id != null) previous.video.cancelVideoFrameCallback?.(previous.id);
  }
  function syncFrameWatch(video = player?.video) {
    if (!settings.enabled || typeof video?.requestVideoFrameCallback !== "function") {
      stopFrameWatch();
      return;
    }
    if (frameWatch?.video === video) return;
    stopFrameWatch();
    const watch = frameWatch = { video, id: null, last: null };
    const sample = (_now, metadata) => {
      if (frameWatch !== watch) return;
      watch.last = { mediaTime: metadata.mediaTime, mediaClock: video.currentTime,
        observedAtMs: performance.now(), expectedDisplayTimeMs: metadata.expectedDisplayTime,
        presentedFrames: metadata.presentedFrames };
      watch.id = video.requestVideoFrameCallback(sample);
    };
    watch.id = video.requestVideoFrameCallback(sample);
  }

  // The element as the browser has it, for the diagnostic copy. BTR's full takeover answers
  // video.paused for the page (native-mse-player.js), so the real state is read from the
  // prototype; the buffered ranges are the ones the page sees.
  const realPaused = Object.getOwnPropertyDescriptor(root.HTMLMediaElement?.prototype || {}, "paused")?.get;
  function elementState(video) {
    const read = (value, fallback = null) => { try { return value(); } catch (_error) { return fallback; } };
    const tenths = (value) => Math.round((Number(value) || 0) * 10) / 10;
    return {
      elementPaused: read(() => (realPaused ? realPaused.call(video) : video.paused)),
      networkState: read(() => video.networkState),
      mediaError: read(() => (video.error ? { code: Number(video.error.code) || 0, message: String(video.error.message || "") } : null)),
      buffered: read(() => {
        const ranges = video.buffered;
        return Array.from({ length: Math.min(8, Number(ranges?.length) || 0) }, (_item, index) => [tenths(ranges.start(index)), tenths(ranges.end(index))]);
      }, [])
    };
  }

  function clearTakeoverFailure() {
    takeoverFailureRoute = "";
    takeoverFailureCount = 0;
    takeoverFailureStartedAt = 0;
    playinfoRetry = { route: "", at: 0, count: 0 };
    stats.takeoverError = null;
  }

  function recordTakeoverFailure(route, stage, error, fatal = false) {
    const message = String(error?.message || error || "未知接管错误").slice(0, 180);
    remember("takeover failed", `${["playinfo", "mse", "create", "playinfo-update", "quality"].includes(stage) ? stage : "takeover"}: ${errorText(error) || "unknown error"}`, "error");
    const now = Date.now();
    if (takeoverFailureRoute !== route) {
      takeoverFailureRoute = route;
      takeoverFailureCount = 0;
      takeoverFailureStartedAt = now;
      stats.takeoverError = null;
    }
    takeoverFailureCount += 1;
    stats.lastError = message;
    const statusMatch = /HTTP\s+(\d{3})/i.exec(message);
    const status = Number(statusMatch?.[1]) || 0;
    const permanentClientError = status >= 400 && status < 500 && ![408, 425, 429].includes(status);
    const shouldExpose = fatal || permanentClientError || takeoverFailureCount >= 2 || now - takeoverFailureStartedAt >= 8000;
    if (shouldExpose || stats.takeoverError?.route === route) {
      stats.playerState = "error";
      stats.takeoverError = {
        at: now,
        route,
        stage: String(stage || "unknown").slice(0, 32),
        message,
        retryCount: takeoverFailureCount
      };
    }
    publish();
  }

  // A failed download used to leave the video on Bilibili's own connection until the page
  // changed. Most such failures are one slow CDN reply, so the takeover is tried again a few
  // times with a growing pause.
  function scheduleAutoRetake(route) {
    const now = Date.now();
    if (autoRetakeRoute !== route || now - autoRetakeAt > 120000) {
      autoRetakeRoute = route;
      autoRetakeCount = 0;
    }
    if (autoRetakeCount >= 3) return;
    autoRetakeCount += 1;
    autoRetakeAt = now;
    const attempt = autoRetakeCount;
    clearTimeout(autoRetakeTimer);
    autoRetakeTimer = setTimeout(() => {
      autoRetakeTimer = null;
      if (!settings.enabled || player || failedRoute !== route || routeIdentity()?.key !== route) return;
      remember("retake", `attempt ${attempt}`, "warn");
      failedRoute = "";
      restartPlayer(true);
    }, 4000 * (2 ** (attempt - 1)));
  }

  function transferSpeed(item, now) {
    if (item.state !== "active" || !item.lastByteAt || now - item.lastByteAt > 1800) return 0;
    return item.bps || 0;
  }

  function updateTransferStats() {
    const now = Date.now();
    for (const [id, item] of transfers) {
      if (item.state !== "active" && item.expiresAt <= now) transfers.delete(id);
    }
    const all = Array.from(transfers.values());
    const active = all.filter((item) => item.state === "active");
    const recent = all.filter((item) => item.state !== "active").sort((a, b) => b.id - a.id).slice(0, 24);
    stats.activeThreads = active.length;
    stats.totalSpeedBps = Math.round(active.reduce((sum, item) => sum + transferSpeed(item, now), 0));
    stats.threadSpeeds = active.concat(recent).sort((a, b) => a.id - b.id).slice(-512).map((item) => ({
      id: item.id,
      label: `${item.kind === "video" ? "V" : item.kind === "audio" ? "A" : "M"}${String(item.id).padStart(2, "0")}`,
      kind: item.kind,
      loaded: item.loaded,
      totalBytes: item.totalBytes,
      bps: Math.round(transferSpeed(item, now) || item.finalBps || 0),
      state: item.state,
      host: item.host
    }));
  }

  function publish() {
    clearTimeout(publishTimer);
    publishTimer = null;
    updateTransferStats();
    root.postMessage({ channel: CHANNEL, type: "stats", payload: { ...stats } }, "*");
  }

  function schedulePublish() {
    if (publishTimer) return;
    publishTimer = setTimeout(publish, 120);
  }

  // A transfer that ended, or brought data, in the counters of the diagnostic copy.
  function countTransfer(item, event) {
    const now = Math.round(performance.now());
    if (event.phase === "progress") {
      if (Number(event.bytes) > 0) downloads.lastBytesAt = now;
      return;
    }
    const kind = downloads.byKind[item.kind] || downloads.byKind.video;
    const host = downloadHost(item.host);
    if (event.phase === "done") {
      kind.ok += 1;
      kind.bytes += item.loaded;
      if (host) { host.ok += 1; host.bytes += item.loaded; }
    } else if (event.phase === "cancel") {
      kind.cancelled += 1;
      if (host) host.cancelled += 1;
      const reasons = downloads.cancelReasons;
      let reason = errorText(event.error) || "unknown";
      if (!(reason in reasons) && Object.keys(reasons).length >= 20) reason = "other";
      reasons[reason] = (reasons[reason] || 0) + 1;
    } else if (event.phase === "error") {
      kind.failed += 1;
      const message = errorText(event.error);
      if (host) { host.failed += 1; host.lastError = message; host.lastErrorAt = now; }
      remember("range failed", `${item.kind} ${item.host || "unknown"} after ${Math.round(item.loaded / 1024)} KiB: ${message}`, "warn");
    }
  }

  function onTransfer(event) {
    if (event?.phase === "start") {
      const id = transferSequence++;
      const now = Date.now();
      let host = "";
      try { host = new URL(event.url).hostname; } catch (_error) {}
      const kind = ["video", "audio", "meta"].includes(event.kind) ? event.kind : "video";
      downloads.byKind[kind].started += 1;
      transfers.set(id, {
        id,
        kind,
        host,
        loaded: 0,
        totalBytes: Math.max(0, Number(event.totalBytes) || 0),
        startedAt: now,
        sampleAt: now,
        sampleBytes: 0,
        lastByteAt: 0,
        bps: 0,
        finalBps: 0,
        state: "active",
        expiresAt: Infinity
      });
      stats.lastHost = host;
      if (host) lastHostByKind[event.kind === "audio" ? "audio" : "video"] = host;
      trackBusy(kind, now);
      // One segment starts and ends dozens of transfers within the same moment. Publishing
      // each of them at once posted the whole thread list every time.
      schedulePublish();
      return id;
    }
    const item = transfers.get(Number(event?.id));
    if (!item || item.state !== "active") return event?.id;
    const now = Date.now();
    countTransfer(item, event);
    if (event.phase === "progress") {
      const bytes = Math.max(0, Number(event.bytes) || 0);
      recentBytes.push({ at: now, bytes });
      while (recentBytes.length && now - recentBytes[0].at > 1000) recentBytes.shift();
      speedMeters[item.kind]?.samples.push({ at: now, bytes });
      if (item.kind === "video") videoBytesIn += bytes;
      item.loaded += bytes;
      item.sampleBytes += bytes;
      item.lastByteAt = now;
      const elapsed = Math.max(1, now - item.sampleAt);
      if (elapsed >= 200) {
        item.bps = item.sampleBytes * 1000 / elapsed;
        item.sampleAt = now;
        item.sampleBytes = 0;
      } else {
        item.bps = item.loaded * 1000 / Math.max(1, now - item.startedAt);
      }
      schedulePublish();
    } else {
      if (item.kind === "video") videoBytesEnded += item.loaded;
      if (event.phase === "cancel") {
        transfers.delete(item.id);
        trackBusy(item.kind, now);
        schedulePublish();
        return event.id;
      }
      item.state = event.phase === "done" ? "done" : "error";
      if (event.phase === "done" && item.kind === "video") videoBytesUsed += item.loaded;
      item.finalBps = event.phase === "done" ? item.loaded * 1000 / Math.max(1, now - item.startedAt) : 0;
      item.expiresAt = now + 3500;
      trackBusy(item.kind, now);
      schedulePublish();
    }
    return event.id;
  }

  function extractJsonObject(text, marker) {
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) return null;
    const start = text.indexOf("{", markerIndex + marker.length);
    if (start < 0) return null;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        try { return JSON.parse(text.slice(start, index + 1)); }
        catch (_error) { return null; }
      }
    }
    return null;
  }

  function activePodBvid() {
    const activeItems = Array.from(document.querySelectorAll(".video-pod__item[data-key]")).filter((candidate) =>
      candidate.matches(".active") || Boolean(candidate.querySelector(".simple-base-item.active"))
    );
    const visibleItems = activeItems.filter((candidate) =>
      !(candidate instanceof HTMLElement) || candidate.offsetParent !== null || candidate.getClientRects().length > 0
    );
    const candidates = visibleItems.length ? visibleItems : activeItems;
    const preferredVideoKey = pendingPodSwitch?.targetVideoKey || trustedPodVideoKey;
    const preferred = preferredVideoKey
      ? candidates.find((candidate) => String(candidate.getAttribute("data-key") || "").toLowerCase() === preferredVideoKey)
      : null;
    const item = preferred || candidates.at(-1);
    const value = String(item?.getAttribute("data-key") || "").trim();
    return /^BV[0-9A-Za-z]+$/i.test(value) ? value : "";
  }

  function urlPathId() {
    // The international site puts the language first (/zh-Hans/bangumi/play/…, see
    // bilibili-site.js); without it the address is the same page.
    const path = root.__BTR_BILIBILI_SITE__?.withoutLanguage(location.pathname) ?? location.pathname;
    const match = /\/video\/(BV[0-9A-Za-z]+|av\d+)/i.exec(path);
    // An av address is the same video as its BV address (another script may turn one into
    // the other while it plays), so it is read as the BV number.
    if (match) return /^av/i.test(match[1]) ? root.__BTR_BILIBILI_SITE__?.avToBv(match[1].slice(2)) || match[1] : match[1];

    const episode = /^\/bangumi\/play\/(ep\d+|ss\d+)/i.exec(path);
    if (episode) return episode[1];

    if (/^\/list\//i.test(path)) {
      const bvid = new URLSearchParams(location.search).get("bvid") || "";
      if (/^BV[0-9A-Za-z]+$/i.test(bvid)) return bvid;
    }

    return "";
  }

  function routeIdentity() {
    const pathId = urlPathId();
    if (!pathId) return null;
    if (/^(ep|ss)/i.test(pathId)) {
      // A season address plays the episode its embedded playinfo names.
      const embedded = normalizePlayinfo(root.__playinfo__);
      const epId = /^ep/i.test(pathId) ? Number(pathId.slice(2)) || 0
        : embedded?.season === Number(pathId.slice(2)) ? embedded.episode : 0;
      if (!epId) return null;
      return { aid: 0, bvid: "", epId, part: 1, key: `ep${epId}:p1`, videoKey: `ep${epId}` };
    }
    const podBvid = activePodBvid();
    const pathVideoKey = /^BV/i.test(pathId) ? pathId.toLowerCase() : `av${Number(pathId.slice(2)) || 0}`;
    const podVideoKey = podBvid ? podBvid.toLowerCase() : "";
    // During an ordinary SPA navigation the previous collection DOM may stay
    // mounted for a moment. Only let a collection item override the URL when
    // it is the item captured from the current click transaction, or the one
    // the last collection switch took over (trustedPodVideoKey).
    const usePodBvid = Boolean(podBvid && (
      podVideoKey === pathVideoKey
      || (pendingPodSwitch?.targetVideoKey && podVideoKey === pendingPodSwitch.targetVideoKey)
      || (trustedPodVideoKey && podVideoKey === trustedPodVideoKey)
    ));
    const rawId = usePodBvid ? podBvid : pathId;
    const bvid = /^BV/i.test(rawId) ? rawId : "";
    const aid = /^av/i.test(rawId) ? Number(rawId.slice(2)) || 0 : 0;
    const part = usePodBvid && podVideoKey !== pathVideoKey
      ? 1
      : Math.max(1, Number(new URLSearchParams(location.search).get("p")) || 1);
    const videoKey = bvid ? bvid.toLowerCase() : `av${aid}`;
    const node = interactiveNode(videoKey, part);
    return { aid, bvid, part, key: nodeRouteKey(videoKey, part, node), videoKey, cid: node };
  }

  // An interactive video (互动视频) plays its branches as separate CIDs under the same BVID
  // and address; the player itself knows which branch is on. The first branch keeps the
  // ordinary route key, so the takeover does not start over when the player reports it.
  // The first branch's CID, or 0 when this is not an interactive video.
  function interactiveFirstCid(videoKey, part) {
    try {
      const state = root.__INITIAL_STATE__;
      if (stateIdentity(state)?.videoKey !== videoKey || Number(state.videoData?.rights?.is_stein_gate) !== 1) return 0;
      return Number(state.videoData.pages?.[part - 1]?.cid || state.videoData.cid) || 0;
    } catch (_error) {
      return 0;
    }
  }

  // The CID of the branch playing now when it is not the first one, otherwise 0.
  function interactiveNode(videoKey, part) {
    const first = interactiveFirstCid(videoKey, part);
    if (!first) return 0;
    try {
      const manifest = root.player?.getManifest?.();
      if (String(manifest?.bvid || "").toLowerCase() !== videoKey && `av${Number(manifest?.aid) || 0}` !== videoKey) return 0;
      const cid = Number(manifest.cid) || 0;
      return cid && cid !== first ? cid : 0;
    } catch (_error) {
      return 0;
    }
  }

  function nodeRouteKey(videoKey, part, node) {
    return node ? `${videoKey}:p${part}:n${node}` : `${videoKey}:p${part}`;
  }

  function stateIdentity(state) {
    const videoData = state?.videoData || state?.videoInfo || {};
    const bvid = String(videoData.bvid || "");
    const aid = Number(videoData.aid || videoData.id) || 0;
    if (!bvid && !aid) return null;
    return { aid, bvid, videoKey: bvid ? bvid.toLowerCase() : `av${aid}` };
  }

  function isDashPlayinfo(playinfo) {
    return Boolean((playinfo?.data || playinfo)?.dash);
  }

  const PLAYURL_PATTERN = /\/x\/player\/(?:wbi\/)?playurl/i;
  const EPISODE_PLAYURL_PATTERN = /\/ogv\/player\/playview|\/pgc\/player\/web\/(?:v2\/)?playurl/i;
  const isPlayurl = (url) => PLAYURL_PATTERN.test(String(url)) || EPISODE_PLAYURL_PATTERN.test(String(url));

  // Bangumi answers put the stream in video_info, next to the episode's arc (aid, cid, bvid)
  // and, in the playinfo embedded in the page, the episode and season it belongs to.
  function normalizePlayinfo(payload) {
    const body = payload?.data || payload?.result;
    if (!body?.video_info) return payload;
    return {
      code: payload.code,
      data: body.video_info,
      arc: body.arc || null,
      episode: Number(body.supplement?.ogv_episode_info?.episode_id) || 0,
      season: Number(body.supplement?.ogv_season_info?.season_id) || 0
    };
  }

  function unsupportedEpisode(playinfo) {
    if (playinfo?.data?.is_drm) return "DRM protected";
    if (playinfo?.data?.is_preview) return "preview only";
    return "";
  }

  const routePlayinfo = new Map();
  const routeCids = new Map();
  const bootRouteKey = routeIdentity()?.key || "";

  // Every file a playinfo names, with the time its signed address expires (seconds since the
  // epoch, 0 if unknown).
  function playinfoAddresses(playinfo) {
    const dash = (playinfo?.data || playinfo)?.dash;
    return [...(dash?.video || []), ...(dash?.audio || []), ...[].concat(dash?.dolby?.audio || [], dash?.flac?.audio || [])].map((item) => {
      try {
        const url = new URL(item.baseUrl || item.base_url);
        return { key: `${item.id}|${item.codecid ?? item.codecs ?? ""}|${url.pathname}`, deadline: Number(url.searchParams.get("deadline")) || 0 };
      } catch (_error) { return null; }
    }).filter(Boolean);
  }

  // Whether a playinfo names, for any file the cached one knows, an address that expires sooner.
  function namesOlderAddresses(playinfo, cached) {
    const known = new Map(playinfoAddresses(cached).map((item) => [item.key, item.deadline]));
    return playinfoAddresses(playinfo).some((item) => item.deadline > 0 && item.deadline < (known.get(item.key) || 0));
  }

  function cachePlayinfo(identity, playinfo, cid = 0) {
    if (!identity || !isDashPlayinfo(playinfo)) return false;
    // A late answer must not replace addresses that are good for longer: the cached playinfo
    // is what the next takeover of this video starts from.
    const cached = routePlayinfo.get(identity.key);
    if (cached && cached !== playinfo && namesOlderAddresses(playinfo, cached)) return true;
    routePlayinfo.delete(identity.key);
    routePlayinfo.set(identity.key, playinfo);
    if (Number(cid) > 0) routeCids.set(identity.key, Number(cid));
    // An interactive video's player asks for the next branches ahead of time, several at once.
    while (routePlayinfo.size > 16) {
      const oldest = routePlayinfo.keys().next().value;
      routePlayinfo.delete(oldest);
      routeCids.delete(oldest);
    }
    return true;
  }

  function currentPlayinfo(identity) {
    const cached = routePlayinfo.get(identity?.key);
    if (isDashPlayinfo(cached)) return cached;
    if (identity?.epId) {
      const embedded = normalizePlayinfo(root.__playinfo__);
      const playinfo = embedded?.episode === identity.epId ? embedded : null;
      if (unsupportedEpisode(playinfo)) return playinfo;
      return cachePlayinfo(identity, playinfo, playinfo?.arc?.cid) ? playinfo : null;
    }
    try {
      const initialIdentity = stateIdentity(root.__INITIAL_STATE__);
      if (identity?.key === bootRouteKey && initialIdentity?.videoKey === identity?.videoKey && isDashPlayinfo(root.__playinfo__)) {
        const initialCid = Number(root.__INITIAL_STATE__?.videoData?.pages?.[identity.part - 1]?.cid
          || root.__INITIAL_STATE__?.videoData?.cid) || 0;
        cachePlayinfo(identity, root.__playinfo__, initialCid);
        return root.__playinfo__;
      }
    } catch (_error) {}
    if (identity?.key !== bootRouteKey) return null;
    const scripts = Array.from(document.scripts || []).reverse();
    for (const script of scripts) {
      const text = script.textContent || "";
      if (!text.includes("__playinfo__") || !text.includes("__INITIAL_STATE__")) continue;
      const embeddedIdentity = stateIdentity(extractJsonObject(text, "__INITIAL_STATE__"));
      if (embeddedIdentity?.videoKey !== identity?.videoKey) continue;
      const parsed = extractJsonObject(text, "__playinfo__");
      if (cachePlayinfo(identity, parsed)) return parsed;
    }
    return null;
  }

  // Bilibili's own player names the video by its BV number (and its av number). A request
  // with only the av number comes from another script, such as Bilibili Evolved's download
  // panel asking for another quality or dub, and says nothing about what is playing.
  function requestedVideoKey(url) {
    try {
      return String(new URL(String(url), location.href).searchParams.get("bvid") || "").toLowerCase();
    } catch (_error) {
      return "";
    }
  }

  function requestedCid(url) {
    try { return Number(new URL(String(url), location.href).searchParams.get("cid")) || 0; }
    catch (_error) { return 0; }
  }

  // playview names the episode in its JSON body, the older playurl in its query.
  function requestedEpisode(url, body) {
    try {
      const fromQuery = Number(new URL(String(url), location.href).searchParams.get("ep_id")) || 0;
      if (fromQuery) return fromQuery;
      return typeof body === "string" ? Number(JSON.parse(body)?.video_index?.ogv_episode_id) || 0 : 0;
    } catch (_error) {
      return 0;
    }
  }

  function capturePlayinfoRequest(url, body) {
    if (EPISODE_PLAYURL_PATTERN.test(String(url))) {
      const identity = routeIdentity();
      const epId = requestedEpisode(url, body);
      if (!identity?.epId || epId !== identity.epId) return null;
      return { routeKey: identity.key, videoKey: identity.videoKey, epId, cid: 0 };
    }
    if (!PLAYURL_PATTERN.test(String(url))) return null;
    const identity = routeIdentity();
    const videoKey = requestedVideoKey(url);
    const cid = requestedCid(url);
    if (!identity || !videoKey || videoKey !== identity.videoKey || !cid) return null;
    // In an interactive video the request names its branch.
    const first = interactiveFirstCid(identity.videoKey, identity.part);
    const routeKey = first ? nodeRouteKey(identity.videoKey, identity.part, cid === first ? 0 : cid) : identity.key;
    return { routeKey, videoKey, cid };
  }

  function observePlayinfo(url, payload, requestContext = null) {
    if (!isPlayurl(url)) return;
    payload = normalizePlayinfo(payload);
    if (!isDashPlayinfo(payload)) return;
    const context = requestContext || capturePlayinfoRequest(url);
    const identity = routeIdentity();
    if (!context || !identity || context.videoKey !== identity.videoKey) return;
    // A branch the interactive player fetched ahead of time: kept for when it plays.
    if (context.routeKey !== identity.key && interactiveFirstCid(identity.videoKey, identity.part)) {
      cachePlayinfo({ key: context.routeKey }, payload, context.cid);
      return;
    }
    if (context.routeKey !== identity.key) return;
    // The episode ID in the route already tells episodes apart, so no CID check is needed.
    if (identity.epId) {
      if (unsupportedEpisode(payload)) return;
      cachePlayinfo(identity, payload, payload.arc?.cid);
      usePlayinfo(identity, payload);
      return;
    }
    const cid = Number(context.cid) || 0;
    const expectedCid = routeCids.get(identity.key) || 0;
    // The same BVID can contain many parts. A late response from the previous
    // part must never be cached under, or hot-swapped into, the current part.
    // The first response for a new route is allowed to establish its CID only
    // because its route identity was captured when the request was started.
    if (!cid || (expectedCid && cid !== expectedCid)) return;
    if (!expectedCid) routeCids.set(identity.key, cid);
    cachePlayinfo(identity, payload, cid);
    usePlayinfo(identity, payload);
  }

  function usePlayinfo(identity, payload) {
    if (player && playerRoute === identity.key) {
      const observedLifecycle = playerLifecycle;
      player.updatePlayinfo?.(payload).catch((error) => {
        if (observedLifecycle === playerLifecycle && playerRoute === identity.key && routeIdentity()?.key === identity.key) {
          recordTakeoverFailure(identity.key, "playinfo-update", error, true);
        }
      });
    } else {
      // Bilibili's own request answered first, so ours for the same video is no longer needed.
      // Waiting for it delayed the takeover by two more round trips to the API.
      if (startingRoute === identity.key) {
        routeRequestController?.abort();
        routeRequestController = null;
        startingRoute = "";
      }
      clearTimeout(restartTimer);
      restartTimer = setTimeout(startPlayer, 0);
    }
  }

  function observeFetchResponse(url, response, requestContext) {
    if (!isPlayurl(url)) return;
    response.clone().json().then((payload) => observePlayinfo(url, payload, requestContext)).catch(() => {});
  }

  // Requests for this video's own files that reach the network while the takeover plays
  // can only come from Bilibili's own core, which lockNativeBuffers keeps from downloading
  // (#49). They are let through and only counted for the diagnostic report: holding them
  // back instead made its core cancel and retry them every few seconds, and soon reload the
  // video. BTR's own downloads use the fetch saved at start-up and never pass through here.
  const nativeMedia = { requests: 0 };
  function countNativeMedia(url) {
    try {
      if (player && !player.nativeTransport && playerContainer?.dataset.btrMseActive === "true"
        && typeof player.ownsMediaUrl === "function" && player.ownsMediaUrl(url)) nativeMedia.requests += 1;
    } catch (_error) {}
  }

  root.fetch = function (...args) {
    const url = typeof args[0] === "string" || args[0] instanceof URL ? String(args[0]) : String(args[0]?.url || "");
    countNativeMedia(url);
    const requestContext = capturePlayinfoRequest(url, args[1]?.body);
    const pending = nativeFetch(...args);
    pending.then((response) => observeFetchResponse(response.url || url, response, requestContext)).catch(() => {});
    return pending;
  };

  const xhrPrototype = root.XMLHttpRequest?.prototype;
  if (xhrPrototype) {
    const nativeXhrOpen = xhrPrototype.open;
    const nativeXhrSend = xhrPrototype.send;
    const xhrUrls = new WeakMap();
    const xhrContexts = new WeakMap();
    xhrPrototype.open = function (method, url, ...args) {
      const value = String(url || "");
      xhrUrls.set(this, value);
      xhrContexts.set(this, capturePlayinfoRequest(value));
      return nativeXhrOpen.call(this, method, url, ...args);
    };
    xhrPrototype.send = function (...args) {
      const url = xhrUrls.get(this) || "";
      countNativeMedia(url);
      if (isPlayurl(url)) {
        const requestContext = xhrContexts.get(this) || capturePlayinfoRequest(url, args[0]);
        this.addEventListener("load", () => {
          try {
            const payload = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
            observePlayinfo(this.responseURL || url, payload, requestContext);
          } catch (_error) {}
        }, { once: true });
      }
      return nativeXhrSend.apply(this, args);
    };
  }

  // Bilibili's signed download addresses expire (their deadline parameter). A long pause
  // used to run into that: every node answers 403 at once, a ban round starts and the video
  // stalls. New addresses are requested shortly before the old ones expire instead.
  // One request at a time, given up after fifteen seconds and dropped when the video changes.
  // A failed attempt, or an answer whose addresses expire no later, waits longer each time.
  let deadlineRefresh = { route: "", at: 0, failures: 0, controller: null };
  function cancelDeadlineRefresh() {
    deadlineRefresh.controller?.abort(new DOMException("视频已经换了", "AbortError"));
    deadlineRefresh = { route: "", at: 0, failures: 0, controller: null };
  }
  async function refreshExpiringPlayinfo() {
    if (!player || !playerRoute || typeof player.urlDeadlineSeconds !== "function") return;
    const identity = routeIdentity();
    if (!identity || identity.key !== playerRoute) return;
    if (deadlineRefresh.route !== playerRoute) {
      cancelDeadlineRefresh();
      deadlineRefresh.route = playerRoute;
    }
    if (deadlineRefresh.controller) return;
    const deadline = player.urlDeadlineSeconds() || 0;
    if (!deadline || Date.now() / 1000 < deadline - 120) return;
    const now = Date.now();
    if (now - deadlineRefresh.at < Math.min(300000, 45000 * (2 ** Math.min(deadlineRefresh.failures, 3)))) return;
    const state = deadlineRefresh;
    const route = playerRoute;
    const lifecycle = playerLifecycle;
    const current = player;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("B 站 15 秒内没有回应", "TimeoutError")), 15000);
    state.at = now;
    state.controller = controller;
    const stale = () => state !== deadlineRefresh || lifecycle !== playerLifecycle || player !== current || playerRoute !== route || routeIdentity()?.key !== route;
    remember("playinfo refresh");
    try {
      const playinfo = await fetchRoutePlayinfo(identity, controller.signal, true);
      if (stale()) return;
      await current.updatePlayinfo?.(playinfo);
      if (stale()) return;
      // The same deadline again would otherwise be asked for every 45 seconds.
      state.failures = (current.urlDeadlineSeconds() || 0) > deadline ? 0 : state.failures + 1;
    } catch (error) {
      if (stale()) return;
      state.failures += 1;
      remember("playinfo refresh failed", errorText(error), "warn");
    } finally {
      clearTimeout(timer);
      if (state.controller === controller) state.controller = null;
    }
  }

  // refresh: new addresses for the video that is already playing. Its CID is known by then,
  // so the video information is not asked for again, and it is not recorded as "playinfo fetched".
  async function fetchRoutePlayinfo(identity, signal, refresh = false) {
    if (identity.epId) return fetchEpisodePlayinfo(identity, signal, refresh);
    // A branch of an interactive video carries its own CID; the video information only
    // names the first branch.
    let cid = Number(identity.cid) || (refresh ? Number(routeCids.get(identity.key)) || 0 : 0);
    let canonicalBvid = String(identity.bvid || "");
    let canonicalAid = Number(identity.aid) || 0;
    if (!cid) {
      const query = identity.bvid
        ? `bvid=${encodeURIComponent(identity.bvid)}`
        : `aid=${encodeURIComponent(identity.aid)}`;
      const viewResponse = await nativeFetch(`${BILIBILI_API_ORIGIN}/x/web-interface/view?${query}`, { credentials: "include", signal });
      if (!viewResponse.ok) throw new Error(`读取视频信息失败（HTTP ${viewResponse.status}）`);
      const viewPayload = await viewResponse.json();
      if (Number(viewPayload?.code) !== 0 || !viewPayload?.data) throw new Error(viewPayload?.message || "读取视频信息失败");
      const pages = Array.isArray(viewPayload.data.pages) ? viewPayload.data.pages : [];
      const page = pages[identity.part - 1] || pages[0];
      cid = Number(page?.cid || viewPayload.data.cid) || 0;
      if (!cid) throw new Error("新视频缺少 CID");
      if (signal?.aborted) throw signal.reason || new DOMException("播放清单请求已取消", "AbortError");
      routeCids.set(identity.key, cid);
      canonicalBvid = String(viewPayload.data.bvid || identity.bvid || "");
      canonicalAid = Number(viewPayload.data.aid || identity.aid) || 0;
    }
    const playQuery = canonicalBvid
      ? `bvid=${encodeURIComponent(canonicalBvid)}`
      : `avid=${encodeURIComponent(canonicalAid)}`;
    const playResponse = await nativeFetch(`${BILIBILI_API_ORIGIN}/x/player/playurl?${playQuery}&cid=${cid}&qn=127&fnval=4048&fnver=0&fourk=1`, {
      credentials: "include",
      signal
    });
    if (!playResponse.ok) throw new Error(`读取播放清单失败（HTTP ${playResponse.status}）`);
    const playinfo = await playResponse.json();
    if (Number(playinfo?.code) !== 0 || !isDashPlayinfo(playinfo)) throw new Error(playinfo?.message || "新视频没有 DASH 播放清单");
    if (signal?.aborted) throw signal.reason || new DOMException("播放清单请求已取消", "AbortError");
    cachePlayinfo(identity, playinfo, cid);
    if (!refresh) remember("playinfo fetched", "", "debug");
    return playinfo;
  }

  async function fetchEpisodePlayinfo(identity, signal, refresh) {
    const response = await nativeFetch(`${BILIBILI_API_ORIGIN}/pgc/player/web/v2/playurl?ep_id=${identity.epId}&qn=127&fnval=4048&fnver=0&fourk=1`, {
      credentials: "include",
      signal
    });
    if (!response.ok) throw new Error(`读取播放清单失败（HTTP ${response.status}）`);
    const payload = await response.json();
    const playinfo = normalizePlayinfo(payload);
    if (Number(payload?.code) !== 0 || !playinfo?.data) throw new Error(payload?.message || "读取播放清单失败");
    if (signal?.aborted) throw signal.reason || new DOMException("播放清单请求已取消", "AbortError");
    if (unsupportedEpisode(playinfo)) return playinfo;
    if (!isDashPlayinfo(playinfo)) throw new Error("这一集没有 DASH 播放清单");
    cachePlayinfo(identity, playinfo);
    if (!refresh) remember("playinfo fetched", "", "debug");
    return playinfo;
  }

  function findContainer() {
    const candidates = [
      document.querySelector("#bilibili-player .bpx-player-container"),
      document.querySelector(".bpx-player-container"),
      document.querySelector("#bilibili-player"),
      document.querySelector(".bilibili-player")
    ].filter(Boolean);
    return candidates.find((node) => node.querySelector("video") && node.clientWidth > 200) || null;
  }

  // The first request to a node otherwise pays for its TLS handshake, which takes over a second
  // on the distant ones. The downloads are sent without cookies and the browser only reuses a
  // connection opened the same way, hence crossOrigin. Asked again for every video, because
  // idle connections are closed after a while.
  let preconnectKey = "";
  function preconnectCdnNodes(route) {
    const factory = root.__BILI_CDN_RESOLVER_FACTORY__;
    const custom = settings.mode === "custom" ? settings.customHosts : [];
    const hosts = custom.length ? custom : settings.mode === "overseas" ? factory?.OVERSEAS_HOSTS : factory?.MAINLAND_HOSTS;
    const key = `${settings.mode}:${custom.join(",")}:${route}`;
    if (preconnectKey === key) return;
    const parent = document.head || document.documentElement;
    if (!Array.isArray(hosts) || !parent) return;
    preconnectKey = key;
    for (const link of document.querySelectorAll("link[data-btr-preconnect]")) link.remove();
    for (const host of hosts) {
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = `https://${host}`;
      link.crossOrigin = "anonymous";
      link.dataset.btrPreconnect = "";
      parent.append(link);
    }
  }

  function settingGroup(title, name, values, selected) {
    const group = document.createElement("div");
    group.className = "btr-native-setting-group";
    const heading = document.createElement("div");
    heading.className = "btr-native-setting-title";
    heading.textContent = title;
    const content = document.createElement("div");
    content.className = "btr-native-setting-content bui bui-radio bui-dark";
    const area = document.createElement("div");
    area.className = "bui-area";
    const wrap = document.createElement("div");
    wrap.className = "bui-radio-wrap bui-radio-button";
    const radioGroup = document.createElement("div");
    radioGroup.className = "bui-radio-group";
    for (const option of values) {
      const label = document.createElement("label");
      label.className = "bui-radio-item";
      const input = document.createElement("input");
      input.type = "radio";
      input.className = "bui-radio-input";
      input.name = name;
      input.value = String(option.value);
      input.checked = String(option.value) === String(selected);
      const labelBody = document.createElement("span");
      labelBody.className = "bui-radio-label";
      const text = document.createElement("span");
      text.className = "bui-radio-text";
      text.textContent = option.label;
      labelBody.append(text);
      label.append(input, labelBody);
      radioGroup.append(label);
    }
    wrap.append(radioGroup);
    area.append(wrap);
    content.append(area);
    group.append(heading, content);
    return group;
  }

  function installSettingsStyle() {
    if (document.getElementById(SETTINGS_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = SETTINGS_STYLE_ID;
    style.textContent = `
      #${SETTINGS_ID}{margin:0 0 20px;color:#fff;font-size:12px;user-select:none;-webkit-user-select:none}
      #${SETTINGS_ID} .btr-native-setting-group{margin:0 0 16px}
      #${SETTINGS_ID} .btr-native-setting-title{margin:0 0 8px;color:#fff}
      #${SETTINGS_ID} .bui-radio-group{display:flex!important;flex-wrap:wrap!important;gap:8px!important;margin:0!important}
      #${SETTINGS_ID} .bui-radio-item{margin:0!important}
    `;
    (document.head || document.documentElement).append(style);
  }

  function syncSettingsMenu() {
    const mount = document.querySelector(".bpx-player-ctrl-setting-menu-right");
    if (!mount || !settings.enabled) {
      document.getElementById(SETTINGS_ID)?.remove();
      return;
    }
    installSettingsStyle();
    let panel = document.getElementById(SETTINGS_ID);
    if (!panel || panel.parentElement !== mount) {
      panel?.remove();
      panel = document.createElement("div");
      panel.id = SETTINGS_ID;
      panel.dataset.btrStrategy = "native-ui-progressive-mse-0.8-core";
      panel.append(
        settingGroup("线程撕裂者 CDN", "btr-native-mode", [
          { label: "大陆 CDN", value: "mainland" },
          { label: "海外 CDN", value: "overseas" },
          { label: "自定义", value: "custom" }
        ], settings.mode),
        settingGroup("并发线程", "btr-native-concurrency", [{ label: "自动", value: "auto" }, ...THREAD_OPTIONS.map((value) => ({ label: String(value), value }))], settings.autoConcurrency ? "auto" : settings.concurrency)
      );
      panel.addEventListener("change", (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || !input.checked) return;
        if (input.name === "btr-native-mode" && ["mainland", "overseas", "custom"].includes(input.value)) {
          root.postMessage({ channel: CHANNEL, type: "settings-update", payload: { mode: input.value } }, "*");
        } else if (input.name === "btr-native-concurrency") {
          if (input.value === "auto") {
            root.postMessage({ channel: CHANNEL, type: "settings-update", payload: { autoConcurrency: true } }, "*");
          } else {
            const concurrency = Number(input.value);
            if (THREAD_OPTIONS.includes(concurrency)) root.postMessage({ channel: CHANNEL, type: "settings-update", payload: { autoConcurrency: false, concurrency } }, "*");
          }
        }
      });
      // The servers of the custom mode are picked in the settings panel, so "自定义" opens it,
      // also when it is already chosen.
      panel.addEventListener("click", (event) => {
        const input = event.target;
        if (input instanceof HTMLInputElement && input.name === "btr-native-mode" && input.value === "custom") {
          root.postMessage({ channel: CHANNEL, type: "open-settings" }, "*");
        }
      });
      const before = mount.querySelector(".bpx-player-ctrl-setting-others");
      mount.insertBefore(panel, before || mount.firstChild);
    }
    for (const input of panel.querySelectorAll('input[name="btr-native-mode"]')) input.checked = input.value === settings.mode;
    for (const input of panel.querySelectorAll('input[name="btr-native-concurrency"]')) {
      input.checked = settings.autoConcurrency ? input.value === "auto" : Number(input.value) === settings.concurrency;
    }
  }

  function scheduleSettingsMenuSync() {
    if (menuSyncTimer) return;
    menuSyncTimer = setTimeout(() => {
      menuSyncTimer = null;
      syncSettingsMenu();
    }, 120);
  }

  // Stopping our player pauses the video. When the next takeover follows (another video in
  // the page, a retake), it goes on playing only if it was playing here (issue #13). After a
  // failed download the video goes back to Bilibili, which may leave it paused on its own
  // error; the automatic retake that follows, up to 16 seconds later, then goes on playing too.
  let resumeHint = null;
  function takeResumeHint(afterFailure) {
    const hint = resumeHint;
    resumeHint = null;
    if (!hint?.playing) return false;
    return hint.handedBack ? afterFailure && Date.now() - hint.at < 45000 : Date.now() - hint.at < 15000;
  }

  // Stopping the full takeover without handing the video back takes our MediaSource off the
  // element, which then reads zero. A full takeover of the same video right after (重新接管,
  // a switch to the compatibility mode where Bilibili's core is missing) started it over
  // from there. It goes on
  // where the viewer was instead, on the same element, playing or paused as before. The same
  // when Bilibili's player put a new source for the same video in place: that source reads
  // zero and paused too, and taking it over from there played a paused video from its start
  // (#54). Not on another video.
  let retakePosition = null;
  function takeRetakePosition(route, video) {
    const kept = retakePosition;
    retakePosition = null;
    if (!kept || kept.route !== route || kept.video !== video) return undefined;
    // A native reload may fail while offline. Keep our position until it restores one;
    // a loaded native video (including a replay at zero) owns its position again.
    if (kept.handedBack && (video.currentTime > 0 || video.readyState >= 2)) return undefined;
    return kept.time;
  }

  // The player's own "自动开播" switch. Unknown counts as on, as before.
  function nativeAutoplay() {
    try { return JSON.parse(root.localStorage.getItem("bpx_player_profile") || "{}")?.media?.autoplay !== false; }
    catch (_error) { return true; }
  }

  // Bilibili's player takes the video back through its own source switch, at the viewer's
  // position, playing or paused. Putting its old source back instead only came back through
  // its error recovery: at once the first time on a page, then after eleven seconds and more
  // (its retry interval grows with every retry), and from the fifth time on it gives up and
  // shows its error screen.
  function switchNativeSource(video, time, play) {
    try {
      const core = root.player?.__core?.();
      if (typeof core?.switchSource !== "function" || !core.state?.mpd || core.getCorePlayer?.()?.getVideoElement?.() !== video) return false;
      Promise.resolve(core.switchSource(core.state.mpd, undefined, undefined, { playAt: time, autoPlay: play })).catch(() => {});
      return true;
    } catch (_error) {
      return false;
    }
  }

  function stopPlayer(resumeNative = true) {
    nativeCoreWait = null;
    stopFrameWatch();
    const current = player;
    if (current) remember(resumeNative ? "handed back to Bilibili" : "player stopped", stats.playerState);
    if (current) previousTimeline = { route: playerRoute, timeline: (current.getDebug?.()?.timeline || []).slice(-60) };
    // While a session loads or has failed the element is paused whatever the viewer wants;
    // the player knows the intent.
    if (current) resumeHint = { playing: Boolean(current.wantsToPlay ? current.wantsToPlay() : current.video && !current.video.paused), at: Date.now(), handedBack: resumeNative };
    // The compatibility mode leaves the element as it is.
    if (current) retakePosition = current.nativeTransport ? null : {
      route: playerRoute,
      video: current.video,
      handedBack: resumeNative,
      time: current.playbackPosition ? current.playbackPosition() : Number(current.video?.currentTime) || 0
    };
    notices?.detach();
    playerLifecycle += 1;
    cancelDeadlineRefresh();
    player = null;
    playerRoute = "";
    playerContainer = null;
    current?.destroy({ resumeNative, handBack: switchNativeSource });
    // Bilibili's core may download again: for its next source, or for the video it plays.
    unlockNativeBuffers();
    // The suppressed native schedulers must run again once Bilibili owns playback.
    if (resumeNative && current && !current.nativeTransport) resumeNativeSchedulers();
    // Bilibili plays the video itself now, so its error panel may show again.
    if (resumeNative) uncoverNativeErrors();
    if (settings.enabled) stats.playerState = "waiting";
    else stats.playerState = "disabled";
    publish();
  }

  function preparePodSwitch(event) {
    if (!settings.enabled || !(event.target instanceof Element)) return;
    const item = event.target.closest(".video-pod__item[data-key]");
    if (!item || item.matches(".active") || item.querySelector(".active")) return;
    const itemKey = String(item.getAttribute("data-key") || "").trim();
    const targetVideoKey = /^BV[0-9A-Za-z]+$/i.test(itemKey) ? itemKey.toLowerCase() : "";
    const identity = routeIdentity();
    const nativeVideo = player?.video || findContainer()?.querySelector("video");
    const resume = player
      ? !player.video.paused
      : pendingPodSwitch?.resume ?? (nativeVideo ? !nativeVideo.paused : true);
    pendingPodSwitch = {
      fromRoute: identity?.key || playerRoute || pendingPodSwitch?.fromRoute || "",
      targetVideoKey,
      resume,
      readyAt: Date.now() + 650,
      expiresAt: Date.now() + 4000
    };
    clearTakeoverFailure();
    stats.lastError = "";
    routeGeneration += 1;
    routeRequestController?.abort();
    routeRequestController = null;
    startingRoute = "";
    failedRoute = "";
    clearTimeout(restartTimer);
    // Capture phase runs before Bilibili's click handler. Tear down only our
    // MediaSource; the click handler owns installing the next native source.
    if (player) stopPlayer(false);
    restartTimer = setTimeout(startPlayer, 650);
  }

  // When Bilibili reloads the video after an error of its own core, its error panel can
  // come up in the moment before BTR takes the video over again, where the takeover no
  // longer hides it. The panel stays hidden across that gap, five seconds at most: a
  // takeover that does not come back leaves the panel to Bilibili.
  let retakingCover = null;
  function uncoverNativeErrors() {
    if (!retakingCover) return;
    clearTimeout(retakingCover.timer);
    delete retakingCover.container.dataset.btrRetaking;
    retakingCover = null;
  }
  function coverNativeErrorsWhileRetaking(container) {
    uncoverNativeErrors();
    if (!container?.isConnected) return;
    container.dataset.btrRetaking = "true";
    const cover = { container, timer: setTimeout(() => { if (retakingCover === cover) uncoverNativeErrors(); }, 5000) };
    retakingCover = cover;
  }

  function handleNativeSourceChange(route, lifecycle) {
    setTimeout(() => {
      if (lifecycle !== playerLifecycle || !player || playerRoute !== route) return;
      const position = Number(player.playbackPosition?.()) || 0;
      remember("Bilibili replaced the video source", `viewer at ${position.toFixed(1)}, ${player.wantsToPlay?.() ? "playing" : "paused"}`);
      routeGeneration += 1;
      routeRequestController?.abort();
      routeRequestController = null;
      startingRoute = "";
      failedRoute = "";
      clearTimeout(restartTimer);
      const container = playerContainer;
      // The native player already installed its next source. Do not restore or
      // overwrite it; wait briefly for the transition to settle, then retake it.
      stopPlayer(false);
      coverNativeErrorsWhileRetaking(container);
      restartTimer = setTimeout(startPlayer, 650);
    }, 0);
  }

  // Bilibili's quality menu can switch between qualities already in the playinfo without a
  // new playurl request, so read what was chosen from the native player. 0 means "auto".
  function nativeQuality() {
    try { return Math.max(0, Math.trunc(Number(root.player?.getQuality?.()?.newQ)) || 0); }
    catch (_error) { return 0; }
  }

  // In 自动 the menu shows the quality Bilibili's player picked itself (its realQ), and that
  // is what BTR plays: the playinfo only names the one the player asked for, often 720P, which
  // it soon leaves for 1080P (#69). 0 when a quality is chosen by hand or none is known yet.
  function nativeAutoQuality() {
    try {
      const quality = root.player?.getQuality?.();
      if (Number(quality?.newQ) > 0) return 0;
      const real = Math.trunc(Number(quality?.realQ));
      return real > 0 ? real : 0;
    } catch (_error) { return 0; }
  }

  function syncNativeQuality() {
    // In the compatibility mode Bilibili's own player owns quality and codec.
    if (player?.nativeTransport) return;
    const wanted = nativeQuality();
    if (!player?.setQuality) return;
    const current = player, route = playerRoute, lifecycle = playerLifecycle;
    const settle = (work) => work.then(() => {
      if (lifecycle === playerLifecycle && player === current) resolveNativeQualitySwitch();
    }).catch((error) => {
      if (lifecycle === playerLifecycle && player === current) recordTakeoverFailure(route, "quality", error, true);
    });
    // What 自动 shows in the menu is what plays, with no exception. Bilibili's player keeps
    // its pick where it is while BTR plays (the pick only moves when that player downloads),
    // so right after a quality picked by hand the pick is that quality: the menu then reads
    // "1080P 60帧 自动" and 1080P 60帧 goes on playing. Leaving it for the pick 自动 had
    // before, or for the video's default quality, played less than the menu showed (#69).
    const auto = wanted ? 0 : nativeAutoQuality();
    if (qualityPlayer !== current || syncedQuality !== wanted) {
      // A pick that cannot be read just now: the quality being left for 自动 is still it.
      const left = qualityPlayer === current ? syncedQuality : 0;
      qualityPlayer = current;
      syncedQuality = wanted;
      // Back in 自动 after a quality picked by hand: BTR may choose at once (driveAutoQuality).
      if (left && !wanted) { autoDrive.picked = false; autoDrive.changedAt = 0; }
      const target = wanted ? 0 : auto || left || syncedAutoQuality;
      if (target) syncedAutoQuality = target;
      remember("quality follow", `menu ${wanted || "auto"}, playing ${wanted || target || "default"}`);
      // The quality for 自动 first, so that going back to 自动 restarts at most once.
      settle((async () => {
        if (target) await current.setAutoQuality?.(target);
        await current.setQuality(wanted);
      })());
      return;
    }
    // While BTR plays, Bilibili's own player downloads nothing, so its pick only changes now
    // and then: once it is known after a very early takeover, or after it is reloaded.
    if (!auto || auto === syncedAutoQuality || typeof current.setAutoQuality !== "function") return;
    syncedAutoQuality = auto;
    remember("auto quality follow", String(auto));
    settle(current.setAutoQuality(auto));
  }

  // 自动 in the full takeover (#69). Bilibili's player starts 自动 at a quality taken from the
  // viewer's history and then moves it by the speed of its own downloads. While BTR plays,
  // that player downloads nothing, so its pick never moved again and the whole video stayed
  // at the first quality.
  //
  // BTR therefore makes the choice itself, from the speed of its own downloads, inside the
  // range Bilibili allows 自动 on this account and device (its core keeps both ends), and
  // sets it on Bilibili's core: the menu shows it at once ("4K 超高清 自动"), and
  // syncNativeQuality plays it like any other pick of 自动.
  //
  // A change of quality restarts BTR's playback at the same position, a pause of a few
  // seconds, so the choice is made early and seldom:
  //   - The first one of a video as soon as a speed is known, up or down: with the speed kept
  //     from the last videos that is while the video is still loading.
  //   - Up later when the connection carries a higher quality with room to spare.
  //   - Down when video has been downloading without a break for some seconds, still brings
  //     less than the quality needs, and little is left ahead: the pause of the restart then
  //     replaces the stall that was coming.
  //   - Down one quality when little is left ahead and it has not grown for ten seconds of
  //     downloading without a break, or when the video ran out of data twice within two
  //     minutes and the speed does not say the connection is fine.
  //
  // Only the bytes that end up in the video count. A piece that takes long gets a second
  // copy on another server, and the one that loses the race is thrown away: on a connection
  // with little bandwidth that was nearly half of everything downloaded (measured), and a
  // speed that counted it tried a quality the connection could not keep up.
  //
  // A quality's stated bandwidth is an average over the whole video, and a busy stretch
  // needs far more (measured: 8 Mbit/s where 2.9 was stated). The index of the video being
  // played says what the next half minute really needs, and the other qualities are taken
  // to need more in the same proportion; a calm stretch is not counted as needing less.
  //
  // Two speeds are told apart, both measured against a throttled connection. While the
  // buffer is full the downloads come in short bursts, and what a second of them brings is
  // only a lower bound of what the connection can do: it may raise the quality, never lower
  // it. While little is buffered and video downloads all the time, the speed is what the
  // connection can do, and it alone lowers the quality and the speed kept for the next
  // videos. (Choosing from one speed for both climbed in two or three steps on a fast
  // connection, and on a slow one tried 4K from a speed kept on a faster day, over and over.)
  //
  // A quality that was too much is not tried again until the speed is clearly beyond the one
  // it failed at; a limit that only ran out with time went up and came down again every few
  // minutes on a connection that carries the quality almost, but not quite.
  const AUTO_SPEED_HEADROOM = 1.5;
  // Below this share of the playing quality's bitrate the connection cannot keep it up.
  const AUTO_SUSTAIN = 1.1;
  const AUTO_SETTLE_MS = 10000;
  const AUTO_STALL_WINDOW_MS = 120000;
  // A burst overrides a speed measured while downloading flat out only when it is this many
  // times beyond it: a second of downloads is not what a connection keeps up.
  const AUTO_BURST_BEYOND = 2;
  const AUTO_REFUSED_MS = 5000;
  const AUTO_PEAK_WINDOW_MS = 30000;
  // Seconds of video downloading without a break, with less than AUTO_STARVED_SECONDS
  // buffered, before the speed counts as what the connection can do.
  const AUTO_SATURATED_TICKS = 4;
  const AUTO_STARVED_SECONDS = 15;
  const AUTO_LOW_BUFFER_SECONDS = 10;
  // Seconds of downloading without a break after which a buffer that has not grown shows
  // that the quality is too much.
  const AUTO_DRAINED_TICKS = 10;
  // Bilibili's core gives a switch twenty seconds to appear and then goes back to the quality
  // it rendered last, which under the takeover is a stale one (360P, seen live). BTR is the
  // one playing, and decides itself when a quality is too much.
  const AUTO_SWITCH_TIMEOUT_SECONDS = 600;
  const AUTO_SPEED_KEY = "BTR_AutoQualitySpeed";
  const AUTO_SPEED_VALID_MS = 7 * 24 * 3600 * 1000;
  const AUTO_SPEED_REFRESH_MS = 24 * 3600 * 1000;
  function freshAutoDrive(route) {
    // proven: the last speed measured while downloading flat out. tooMuch: the quality
    // that had to be left, and the speed it was left at.
    // usedIn, usedOf: the bytes used and the bytes of finished requests lately, fading over
    // half a minute.
    return { route, picked: false, proven: 0, tooMuch: null, stalls: [], session: 0, rebuffers: 0, changedAt: 0, refusedUntil: 0, samples: [], saturated: 0,
      usedIn: 0, usedOf: 0, seenEnded: videoBytesEnded, seenUsed: videoBytesUsed };
  }
  let autoDrive = freshAutoDrive("");

  // { kbps, at }: the video download speed known from the last videos, in this site's
  // localStorage, so that the next video and the other tabs start from it. Zeros when none.
  function keptAutoSpeed(now) {
    try {
      const [kbps, at] = String(root.localStorage.getItem(AUTO_SPEED_KEY) || "").split(":").map(Number);
      if (kbps > 0 && at > 0 && now - at < AUTO_SPEED_VALID_MS) return { kbps, at };
    } catch (_error) {}
    return { kbps: 0, at: 0 };
  }
  function keepAutoSpeed(kbps, now) {
    try { root.localStorage.setItem(AUTO_SPEED_KEY, `${Math.max(1, Math.round(kbps))}:${now}`); } catch (_error) {}
  }

  // The two speeds in kbit/s, from the video bytes counted at every tick (a second apart).
  // peak: the best second of the last half minute. sustained: the average while video has
  // been downloading without a break and little is buffered, 0 otherwise.
  function measureAutoSpeed(drive, now, starved) {
    const busy = [...transfers.values()].some((item) => item.kind === "video" && item.state === "active");
    drive.saturated = busy && starved ? drive.saturated + 1 : 0;
    drive.samples.push({ at: now, bytes: videoBytesIn, ahead: Number(stats.bufferedAhead) || 0 });
    while (drive.samples.length > 2 && now - drive.samples[0].at > AUTO_PEAK_WINDOW_MS) drive.samples.shift();
    let peak = 0;
    for (let index = 1; index < drive.samples.length; index += 1) {
      const ms = drive.samples[index].at - drive.samples[index - 1].at;
      // A tick that came late (a tab in the background) says nothing about one second.
      if (ms >= 500 && ms <= 2500) peak = Math.max(peak, (drive.samples[index].bytes - drive.samples[index - 1].bytes) * 8 / ms);
    }
    let sustained = 0;
    if (drive.saturated >= AUTO_SATURATED_TICKS) {
      // Without the first of those seconds: it holds the wait for the first bytes.
      const from = drive.samples[Math.max(0, drive.samples.length - Math.min(drive.saturated, 10))];
      if (now > from.at) sustained = (videoBytesIn - from.bytes) * 8 / (now - from.at);
      // What the connection does now, whatever it did half a minute ago.
      drive.samples = drive.samples.slice(-Math.min(drive.saturated, 10));
    }
    // The share of the downloaded bytes that was used, once enough has come in to tell.
    drive.usedOf = drive.usedOf * 0.97 + videoBytesEnded - drive.seenEnded;
    drive.usedIn = drive.usedIn * 0.97 + videoBytesUsed - drive.seenUsed;
    drive.seenEnded = videoBytesEnded;
    drive.seenUsed = videoBytesUsed;
    const used = drive.usedOf > 2000000 ? Math.max(0.5, Math.min(1, drive.usedIn / drive.usedOf)) : 1;
    return { peak: Math.round(peak * used), sustained: Math.round(sustained * used), used };
  }

  // What Bilibili's core allows 自动: its qualities in its own order, lowest first, cut to
  // the lowest and the top it was given. null when 自动 is off or the core does not say.
  function nativeAutoRange() {
    try {
      const core = root.player?.__core?.();
      const state = core?.state;
      if (!state?.isAutoSwitch?.video || typeof core.setQualityFor !== "function") return null;
      // Between two videos the core still holds the last one's range while the new stream
      // is not there yet.
      if (state.initialized !== true || state.appendingSourceState) return null;
      const list = (core.getQualityList?.("video") || []).map((item) => Math.trunc(Number(item?.id)) || 0);
      const top = state.autoSwitchTopQualityMap?.video, lowest = state.autoSwitchLowestQualityMap?.video;
      if (!Number.isInteger(top) || top < 0 || top >= list.length) return null;
      return { core, list, qualities: list.slice(Number.isInteger(lowest) && lowest > 0 && lowest <= top ? lowest : 0, top + 1).filter(Boolean) };
    } catch (_error) { return null; }
  }

  // The best of these qualities (lowest first) that the speed carries with room to spare;
  // the lowest of them when it carries none.
  function fitAutoQuality(qualities, kbpsOf, speedKbps) {
    let best = 0;
    for (let index = 1; index < qualities.length; index += 1) {
      if (kbpsOf(qualities[index]) * AUTO_SPEED_HEADROOM <= speedKbps) best = index;
    }
    return qualities[best] || 0;
  }

  // Sets the quality 自动 shows on Bilibili's core, with a timeout BTR never reaches.
  // The core refuses the quality it believes is on screen ("equal current quality"), and
  // under the takeover that is the one it rendered itself, long ago: it is first told which
  // quality BTR has been playing, the one its menu shows.
  function setNativeAutoQuality(range, quality, shown, refused) {
    try {
      const { core, list } = range;
      const index = list.indexOf(quality), shownIndex = list.indexOf(shown);
      if (index < 0) return false;
      if (core.state?.currentQualityIndex?.video === index && shownIndex >= 0 && shownIndex !== index
        && typeof core.fire === "function" && typeof core.getQualityChangedData === "function") {
        const rendered = { type: "qualityChangeRendered", mediaType: "video", oldQuality: index, newQuality: shownIndex, isMediaSegment: true, requestType: "MediaSegment" };
        core.fire("qualityChangeRendered", core.getQualityChangedData(rendered));
      }
      Promise.resolve(core.setQualityFor("video", quality, AUTO_SWITCH_TIMEOUT_SECONDS)).catch(refused);
      return true;
    } catch (error) { refused(error); return false; }
  }

  function driveAutoQuality() {
    if (!player || player.nativeTransport || typeof player.playableQualities !== "function") return;
    if (autoDrive.route !== playerRoute) autoDrive = freshAutoDrive(playerRoute);
    // A quality picked by hand: nothing to choose, and going back to 自动 chooses at once.
    if (nativeQuality()) { autoDrive.picked = false; autoDrive.stalls = []; autoDrive.saturated = 0; return; }
    const range = nativeAutoRange();
    if (!range) return;
    const now = Date.now();
    const debug = player.getDebug?.() || {};
    const playable = new Map(player.playableQualities().map((item) => [Number(item.id), Number(item.bandwidth) || 0]));
    // What the stretch ahead needs, against what the quality being played states.
    const stated = (playable.get(Number(debug.qualityId)) || 0) / 1000;
    const busier = stated > 0 && debug.videoKbpsAhead > stated ? Math.min(4, debug.videoKbpsAhead / stated) : 1;
    const kbpsOf = (quality) => (playable.get(quality) || 0) / 1000 * busier;
    const allowed = range.qualities.filter((quality) => playable.has(quality));
    if (!allowed.length) return;
    const shown = nativeAutoQuality();
    const current = allowed.indexOf(shown);
    const ahead = Number(stats.bufferedAhead) || 0;
    // A new quality or a new start is measured from its own first seconds.
    const session = Number(debug.sessionStarts) || 0, rebuffers = Number(debug.underflowRebuffers) || 0;
    if (session !== autoDrive.session) { autoDrive.session = session; autoDrive.saturated = 0; }
    else if (rebuffers > autoDrive.rebuffers) autoDrive.stalls.push(now);
    autoDrive.rebuffers = rebuffers;
    autoDrive.stalls = autoDrive.stalls.filter((at) => now - at < AUTO_STALL_WINDOW_MS);

    const starved = ahead < AUTO_STARVED_SECONDS;
    const speed = measureAutoSpeed(autoDrive, now, starved);
    const kept = keptAutoSpeed(now);
    // The speed to choose by. A burst only counts once the buffer is well filled: before
    // that it is the first few segments, which say little.
    let known = kept.kbps;
    if (speed.sustained) known = autoDrive.proven = speed.sustained;
    else if (!starved && speed.peak > known && !(speed.peak < autoDrive.proven * AUTO_BURST_BEYOND)) known = speed.peak;
    if (known && (Math.abs(known - kept.kbps) > kept.kbps * 0.1 || now - kept.at > AUTO_SPEED_REFRESH_MS)) keepAutoSpeed(known, now);

    const failed = autoDrive.tooMuch && known < autoDrive.tooMuch.kbps * AUTO_SPEED_HEADROOM ? allowed.indexOf(autoDrive.tooMuch.quality) : -1;
    const reachable = failed > 0 ? allowed.slice(0, failed) : allowed;
    const fit = known ? fitAutoQuality(reachable, kbpsOf, known) : 0;
    let target = 0, lowered = false, why = "";
    if (current < 0 || !autoDrive.picked) {
      // The first choice of a video (or of a return to 自动), and a pick of the core's that
      // 自动 may not use here.
      target = fit;
      why = current < 0 ? "outside the range" : "first choice";
    } else if (speed.sustained && current > 0 && speed.sustained < kbpsOf(shown) * AUTO_SUSTAIN
      && (stats.playerState !== "ready" || ahead < AUTO_LOW_BUFFER_SECONDS)) {
      target = fitAutoQuality(allowed.slice(0, current), kbpsOf, speed.sustained);
      lowered = true;
      why = "cannot keep up";
    } else if (current > 0 && stats.playerState === "ready" && ahead < AUTO_LOW_BUFFER_SECONDS && autoDrive.saturated >= AUTO_DRAINED_TICKS
      && ahead <= autoDrive.samples.at(-AUTO_DRAINED_TICKS)?.ahead) {
      target = fitAutoQuality(allowed.slice(0, current), kbpsOf, known);
      lowered = true;
      why = "the buffer does not grow";
    } else if (autoDrive.stalls.length >= 2) {
      autoDrive.stalls = [];
      if (current > 0 && speed.peak < kbpsOf(shown) * AUTO_SPEED_HEADROOM) {
        target = allowed[current - 1];
        lowered = true;
        why = "ran out of data twice";
      }
    } else if (fit && reachable.indexOf(fit) > current && stats.playerState === "ready"
      && now - autoDrive.changedAt >= AUTO_SETTLE_MS && document.visibilityState !== "hidden") {
      // Not in a tab nobody is looking at: the pause would only be heard.
      target = fit;
      why = "room to spare";
    }
    if (known) autoDrive.picked = true;
    if (!target || target === shown || now < autoDrive.refusedUntil) return;
    autoDrive.changedAt = now;
    if (lowered) autoDrive.tooMuch = { quality: shown, kbps: Math.max(1, known || speed.peak) };
    remember(lowered ? "auto quality lowered" : "auto quality picked",
      `${target}, ${known ? `${(known / 1000).toFixed(1)} Mbit/s${speed.sustained ? " sustained" : ""}` : "no speed"}${speed.used < 0.95 ? ` (${Math.round(speed.used * 100)}% of the bytes used)` : ""}, ${why}, allowed ${allowed[0]} to ${allowed.at(-1)}`);
    const drive = autoDrive;
    const refused = (error) => {
      drive.refusedUntil = Date.now() + AUTO_REFUSED_MS;
      remember("auto quality refused", String(error?.msg || error?.message || error || "").slice(0, 80), "warn");
    };
    if (!setNativeAutoQuality(range, target, shown, refused)) return;
    // The core's pick moved with that call; play it now instead of at the next tick.
    syncNativeQuality();
  }

  // While BTR plays the video, Bilibili's core never receives its "new quality rendered"
  // confirmation, and after about twenty seconds it shows 切换失败 and rolls the menu back,
  // although the stream switched long ago. Once the takeover really plays the requested
  // quality, the pending switch is resolved for it (its qnSwitchingInfo carries the
  // resolver; verified against the live player, where resolve() settles the switch
  // without disturbing getQuality()).
  //
  // The confirmation must also come quickly: while the switch is pending, the core's own
  // leftover pipeline keeps running against its long-detached MediaSource, and can crash
  // on a null SourceBuffer (reading 'updating'), which it reports as an immediate 切换失败.
  // A pending switch therefore arms a short fast loop instead of waiting for the next
  // one-second tick.
  let resolvedSwitchToken = null;
  let fastResolveToken = null;
  let fastResolveTimer = null;
  let fastResolveUntil = 0;
  function resolveNativeQualitySwitch() {
    if (!player || player.nativeTransport) return;
    try {
      const wrapper = root.player?.__core?.();
      const pending = wrapper?.qnSwitchingInfo?.video;
      if (!pending?.switching || typeof pending.resolve !== "function" || resolvedSwitchToken === pending) return;
      armFastResolve(pending);
      if (stats.playerState !== "ready") return;
      // In 自动 a switch can be pending as well: the pick BTR made itself (driveAutoQuality),
      // which the menu already shows. It is confirmed once that quality plays; confirmed for
      // the quality still playing, the core's timeout stayed armed and set the menu back.
      const target = nativeQuality() || nativeAutoQuality();
      const playingId = Number(player.getDebug?.()?.qualityId) || 0;
      if (target && playingId !== target) return;
      resolvedSwitchToken = pending;
      if (!confirmRenderedQuality(wrapper, pending, target || playingId)) {
        pending.resolve({ type: "qualityChangeRendered", mediaType: "video", oldQuality: pending.oQn, newQuality: target || playingId, isMediaSegment: true, requestType: "MediaSegment" });
      }
      remember("quality switched");
    } catch (_error) {}
  }

  // resolve() alone settles the request but leaves the core believing the old quality is
  // still on screen: its currentQualityIndex only moves when the core sees
  // qualityChangeRendered, and the switch's twenty-second timeout stays armed. Switching
  // back to the previous quality (杜比视界 → 4K → 杜比视界) was then refused as "Set quality
  // equal current quality" (20004) and shown at once as 切换失败, and the leftover timeout
  // later set the core back to the old rendition. Where the core offers them, the rendered
  // notification is delivered the way its own pipeline delivers it, as the compatibility
  // mode already does: fired on the wrapper, which records the new index, and passed to the
  // switch's listener, which clears the timeout and resolves the request. The listener
  // compares indexes (pending.qn), not quality ids, and refuses a rendition other than the
  // one requested, so it is used only when that index is the quality being played.
  function confirmRenderedQuality(wrapper, pending, qualityId) {
    const index = pending.qn;
    if (!qualityId || !Number.isInteger(index) || typeof pending.listener !== "function"
      || typeof wrapper.fire !== "function" || typeof wrapper.getQualityChangedData !== "function") return false;
    const previous = wrapper.state?.currentQualityIndex?.video;
    const rendered = { type: "qualityChangeRendered", mediaType: "video", oldQuality: Number.isInteger(previous) ? previous : index,
      newQuality: index, isMediaSegment: true, requestType: "MediaSegment" };
    const data = wrapper.getQualityChangedData(rendered);
    if (Number(data?.newQualityNumber) !== qualityId || (Number(pending.oQn) !== qualityId && pending.oQn !== index)) return false;
    // A core that throws here still gets resolve(), as before.
    try {
      wrapper.fire("qualityChangeRendered", data);
      pending.listener(rendered);
      return true;
    } catch (_error) { return false; }
  }

  function armFastResolve(pending) {
    if (fastResolveToken !== pending) {
      fastResolveToken = pending;
      fastResolveUntil = Date.now() + 15000;
    }
    if (fastResolveTimer || Date.now() > fastResolveUntil) return;
    fastResolveTimer = setInterval(() => {
      resolveNativeQualitySwitch();
      suppressNativeSchedulers();
      let pending = null;
      try { pending = root.player?.__core?.()?.qnSwitchingInfo?.video; } catch (_error) {}
      if (Date.now() > fastResolveUntil || !pending?.switching || resolvedSwitchToken === pending) {
        clearInterval(fastResolveTimer);
        fastResolveTimer = null;
      }
    }, 150);
  }

  // Bilibili's player has a background mode: 20 seconds after the tab is hidden it drops its
  // video buffer and plays the sound alone, and when the tab comes back it builds a new video
  // element with its own source and swaps it in. With the full takeover that swap is a new
  // source like any other, taken over again from scratch: the sound stopped for about two
  // seconds whenever the viewer came back to the tab (#66). The buffer it drops is not the one
  // BTR plays from, so the mode saved nothing then. The player reads whether the mode is on
  // from its stored config once, when it starts; on a video page BTR takes over in full it
  // reads "off". An episode plays in Bilibili's own player (the compatibility mode), and before
  // BTR's settings are in nothing is known yet: those keep the mode. A takeover mode changed
  // later on the page reaches it with the next reload. The stored config itself is left as it
  // is. (installCodecFailureGuard in native-mse-player.js patches Storage too, its setItem.)
  const KV_CONFIG_KEY = "bilibili_player_kv_config";
  let kvOutcome = "";
  function withoutBackgroundAudio(text) {
    let config = null;
    try { config = JSON.parse(text || "{}"); } catch (_error) { return text; }
    if (!config || typeof config !== "object" || Array.isArray(config)) return text;
    const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
    // Missing parts are added; parts in a shape the player does not read are left alone.
    if (config.dash_config != null && !plain(config.dash_config)) return text;
    const dash = config.dash_config || {};
    if (dash.audio_only_config != null && !plain(dash.audio_only_config)) return text;
    const audioOnly = dash.audio_only_config || {};
    return JSON.stringify({ ...config, dash_config: { ...dash, audio_only_config: { ...audioOnly, enabled: false } } });
  }
  try {
    const storage = root.Storage?.prototype;
    const getItem = storage?.getItem;
    if (typeof getItem === "function") {
      storage.getItem = function (key) {
        const value = getItem.apply(this, arguments);
        if (key !== KV_CONFIG_KEY) return value;
        try { if (this !== root.localStorage) return value; } catch (_error) { return value; }
        const pathId = urlPathId();
        if (!pathId || /^(ep|ss)/i.test(pathId) || !settings.enabled || settings.takeover === "compat") return value;
        const changed = settingsLoaded ? withoutBackgroundAudio(value) : value;
        // Once per outcome: the player reads it at every start.
        const outcome = !settingsLoaded ? "Bilibili's background mode left on, settings not loaded yet" : changed !== value ? "Bilibili's background mode read as off" : "Bilibili's background mode config left as it is";
        if (outcome !== kvOutcome) remember(outcome);
        kvOutcome = outcome;
        return changed;
      };
    }
  } catch (_error) {}

  // While BTR plays the video, Bilibili's dash core keeps its schedule controllers running:
  // seeking and quality switches wake them, they download the same segments in parallel with
  // ours (an 8K stream doubles the bandwidth bill), and their appends then crash forever on
  // the long-detached SourceBuffers — the endless "reading 'updating' of null" TypeErrors.
  // While the takeover is active the controllers are stopped: when it starts, every second,
  // and every 150 ms during a quality switch. Handing the video back to Bilibili starts them
  // again.
  function nativeStreamProcessors() {
    try { return root.player?.__core?.()?.getCorePlayer?.()?.getActiveStream?.()?.getProcessors?.() || []; }
    catch (_error) { return []; }
  }

  const stoppedSchedulers = new WeakSet();

  // Stopping the controllers once a second still let them download: every seek or play woke
  // them before the next stop, each time for several megabytes at 4K toward their own
  // ten-second buffer. Those downloads failed often enough for the core to show 错误码 6006
  // and reload the video (#49), and in a background tab the stop came only once a minute.
  // Bilibili's dash core asks one question before it downloads anything: its schedule
  // controller refuses to start, and stops scheduling, once the buffer controller says
  // buffering is completed. While BTR plays the video, every native buffer controller says
  // so, and the core asks its nodes for nothing; the original answer comes back with the
  // video. A core without this method still gets the stop in suppressNativeSchedulers below.
  const lockedBuffers = new Map();
  function lockNativeBuffers() {
    for (const processor of nativeStreamProcessors()) {
      try {
        const buffer = processor?.getBufferController?.();
        if (!buffer || lockedBuffers.has(buffer) || typeof buffer.getIsBufferingCompleted !== "function") continue;
        lockedBuffers.set(buffer, buffer.getIsBufferingCompleted);
        buffer.getIsBufferingCompleted = function () { return true; };
        // Its own wake-ups are refused from now on, so it is started again with the video.
        const scheduler = processor.getScheduleController?.();
        if (scheduler) stoppedSchedulers.add(scheduler);
        remember("native buffer locked", String(processor.getType?.() || ""), "debug");
      } catch (_error) {}
    }
  }
  function unlockNativeBuffers() {
    for (const [buffer, original] of lockedBuffers) {
      try { buffer.getIsBufferingCompleted = original; } catch (_error) {}
    }
    lockedBuffers.clear();
  }

  function suppressNativeSchedulers() {
    if (!player || player.nativeTransport || playerContainer?.dataset.btrMseActive !== "true") return;
    lockNativeBuffers();
    for (const processor of nativeStreamProcessors()) {
      try {
        const scheduler = processor?.getScheduleController?.();
        if (scheduler?.isStarted?.() && typeof scheduler.stop === "function") {
          scheduler.stop();
          stoppedSchedulers.add(scheduler);
          remember("native scheduler stopped", String(processor.getType?.() || ""), "debug");
        }
      } catch (_error) {}
    }
  }

  function resumeNativeSchedulers() {
    for (const processor of nativeStreamProcessors()) {
      try {
        const scheduler = processor?.getScheduleController?.();
        if (scheduler && stoppedSchedulers.has(scheduler) && scheduler.isStarted?.() === false && typeof scheduler.start === "function") {
          scheduler.start();
          stoppedSchedulers.delete(scheduler);
        }
      } catch (_error) {}
    }
  }

  // The codec picked in the player's 播放策略 menu. Bilibili stores it as
  // bilibili_player_codec_prefer_type: "1" HEVC, "2" AVC, "3" AV1, "0" for "默认".
  function nativeCodec() {
    try { return { 1: "hevc", 2: "avc", 3: "av1" }[root.localStorage.getItem("bilibili_player_codec_prefer_type")] || ""; }
    catch (_error) { return ""; }
  }

  // The audio picked with the player's Hi-Res / 杜比全景声 buttons: 0 the ordinary track,
  // 1 杜比全景声, 2 Hi-Res (newA of getQuality()). Bilibili reloads its source when it
  // changes, and the takeover that follows reads it again.
  function nativeAudio() {
    try {
      const audio = Math.trunc(Number(root.player?.getQuality?.()?.newA)) || 0;
      return audio === 1 || audio === 2 ? audio : 0;
    } catch (_error) { return 0; }
  }

  function syncNativeCodec() {
    if (player?.nativeTransport) return;
    const wanted = nativeCodec();
    if (!player?.setCodec || (codecPlayer === player && syncedCodec === wanted)) return;
    const current = player, route = playerRoute, lifecycle = playerLifecycle;
    codecPlayer = current;
    syncedCodec = wanted;
    remember("codec follow", wanted || "default");
    current.setCodec(wanted).catch((error) => {
      if (lifecycle === playerLifecycle && player === current) recordTakeoverFailure(route, "quality", error, true);
    });
  }

  function watchQualityMenu(event) {
    if (!(event.target instanceof Element)) return;
    const sync = event.target.closest(".bpx-player-ctrl-quality-menu-item") ? syncNativeQuality
      : event.target.closest(".bpx-player-ctrl-setting-codec") ? syncNativeCodec : null;
    if (!sync) return;
    // Capture phase runs before Bilibili's own handler; read the choice once it has run.
    // The click also starts the core's pending switch, so the fast confirmation loop arms
    // right away instead of waiting for the next one-second tick.
    setTimeout(sync, 0);
    setTimeout(resolveNativeQualitySwitch, 50);
    setTimeout(sync, 300);
  }

  // Video Speed and Audio Speed in the native panel are how fast the latest data came in
  // while it was being downloaded, and they keep that value between segments. Here it is
  // all threads of a kind together over the last few seconds; the pauses between segments
  // do not count, and the value stays until new data arrives.
  const SPEED_WINDOW_MS = 3000;
  const speedMeters = { video: { busySince: 0, spans: [], samples: [], shown: 0 }, audio: { busySince: 0, spans: [], samples: [], shown: 0 } };

  // Measured while data comes in and once more when the downloads stop; the value then stays
  // as it was instead of fading while the window slides past the last data.
  function updateSpeed(meter, now) {
    const from = now - SPEED_WINDOW_MS;
    meter.spans = meter.spans.filter(([, end]) => end > from);
    meter.samples = meter.samples.filter((sample) => sample.at > from);
    const busyMs = meter.spans.reduce((sum, [start, end]) => sum + end - Math.max(start, from), 0)
      + (meter.busySince ? now - Math.max(meter.busySince, from) : 0);
    const bytes = meter.samples.reduce((sum, sample) => sum + sample.bytes, 0);
    // Bytes per millisecond times 8 is kilobits per second.
    if (bytes > 0 && busyMs >= 250) meter.shown = Math.round(bytes * 8 / busyMs);
  }

  function trackBusy(kind, now) {
    const meter = speedMeters[kind];
    if (!meter) return;
    const busy = [...transfers.values()].some((item) => item.kind === kind && item.state === "active");
    if (busy && !meter.busySince) meter.busySince = now;
    else if (!busy && meter.busySince) {
      meter.spans.push([meter.busySince, now]);
      meter.busySince = 0;
      updateSpeed(meter, now);
    }
  }

  function measuredSpeed(kind, now) {
    const meter = speedMeters[kind];
    if (meter.busySince) updateSpeed(meter, now);
    return meter.shown;
  }

  // Bilibili's "视频统计信息" panel reads its own player core, which downloads nothing while
  // BTR plays the video, so its hosts, speeds and segment counts would be stale. The same
  // rows show what BTR plays and downloads instead.
  function nativeInfoValues() {
    const info = player?.getDebug?.();
    // In the compatibility mode the native core knows the codec, resolution and segments;
    // only the download rows belong to BTR.
    if (player?.nativeTransport) {
      if (!player.transportActive) return null;
      const now = Date.now();
      while (recentBytes.length && now - recentBytes[0].at > 1000) recentBytes.shift();
      return {
        "Player Type": "BTR Native (兼容模式)",
        "Video Host": lastHostByKind.video || undefined,
        "Audio Host": lastHostByKind.audio || undefined,
        "Video Speed": `${measuredSpeed("video", now)} Kbps`,
        "Audio Speed": `${measuredSpeed("audio", now)} Kbps`,
        "Network Activity": `${Math.round(recentBytes.reduce((sum, item) => sum + item.bytes, 0) / 1024)} KB`
      };
    }
    if (!info?.videoType || playerContainer?.dataset.btrMseActive !== "true") return null;
    const now = Date.now();
    while (recentBytes.length && now - recentBytes[0].at > 1000) recentBytes.shift();
    const track = info.tracks?.find((item) => item.kind === "video");
    const frames = player.video?.getVideoPlaybackQuality?.();
    return {
      "Mime Type": `${info.videoType}, ${info.audioType}`,
      "Player Type": "BTR Native",
      "Resolution": info.width && info.height ? `${info.width} x ${info.height}@${Number((Number(info.frameRate) || 0).toFixed(3))}` : undefined,
      "Video DataRate": `${Math.round(info.videoBandwidth / 1000)} Kbps [${String(info.codec).toUpperCase()}]`,
      "Audio DataRate": `${Math.round(info.audioBandwidth / 1000)} Kbps`,
      "Segments": track ? `${track.nextIndex} / ${track.segments}${info.lastSeekMs ? `，跳转恢复 ${(info.lastSeekMs / 1000).toFixed(1)} 秒，之后卡顿 ${info.stallsAfterSeek} 次` : ""}` : undefined,
      "Dropped Frames": frames ? `${frames.droppedVideoFrames} / ${frames.totalVideoFrames}` : undefined,
      "Video Host": lastHostByKind.video || undefined,
      "Audio Host": lastHostByKind.audio || undefined,
      "Video Speed": `${measuredSpeed("video", now)} Kbps`,
      "Audio Speed": `${measuredSpeed("audio", now)} Kbps`,
      "Network Activity": `${Math.round(recentBytes.reduce((sum, item) => sum + item.bytes, 0) / 1024)} KB`
    };
  }

  function updateNativeInfoPanel() {
    const panel = playerContainer?.querySelector(".bpx-player-info-panel") || null;
    if (panel !== infoPanel) {
      infoPanelObserver?.disconnect();
      infoPanel = panel;
      infoPanelObserver = panel ? new MutationObserver(updateNativeInfoPanel) : null;
      infoPanelObserver?.observe(panel, { childList: true, subtree: true, characterData: true });
    }
    const values = panel && nativeInfoValues();
    if (!values) return;
    for (const line of panel.querySelectorAll(".info-line")) {
      const title = String(line.querySelector(".info-title")?.textContent || "").replace(/:\s*$/, "").trim();
      const data = line.querySelector(".info-data");
      if (data && values[title] !== undefined && data.textContent !== values[title]) data.textContent = values[title];
    }
    // Our own writes are not new native updates.
    infoPanelObserver?.takeRecords();
  }

  async function startPlayer() {
    clearTimeout(restartTimer);
    restartTimer = null;
    if (!settingsLoaded) {
      restartTimer = setTimeout(startPlayer, 100);
      return;
    }
    const identity = routeIdentity();
    // 剧集加速 switched off leaves episode pages to Bilibili, like the master switch does.
    if (!settings.enabled || !identity || (identity.epId && settings.episodeEnabled === false)) {
      pendingPodSwitch = null;
      clearTakeoverFailure();
      stats.lastError = "";
      if (player) stopPlayer(true);
      return;
    }
    if (pendingPodSwitch) {
      if (Date.now() >= pendingPodSwitch.expiresAt) pendingPodSwitch = null;
      else if ((pendingPodSwitch.fromRoute && identity.key === pendingPodSwitch.fromRoute) || Date.now() < pendingPodSwitch.readyAt) {
        stats.playerState = "waiting";
        schedulePublish();
        restartTimer = setTimeout(startPlayer, 100);
        return;
      }
    }
    const route = identity.key;
    preconnectCdnNodes(route);
    if (takeoverFailureRoute && takeoverFailureRoute !== route) {
      clearTakeoverFailure();
      stats.lastError = "";
    }
    if (!player && failedRoute === route) return;
    if (player && playerRoute === route && playerContainer?.isConnected && player.video?.isConnected) return;
    if (startingRoute === route) return;
    const container = findContainer();
    // Bilibili's playback core appears a moment after its player. The compatibility mode
    // needs it, so each video waits briefly for it instead of falling back at once.
    // Episodes are only ever sped up in the compatibility mode: Bilibili's own player keeps
    // playing them, whatever the takeover setting says.
    const compat = settings.takeover === "compat" || Boolean(identity.epId);
    const rangeTransport = compat ? root.__BILI_NATIVE_RANGE_PLAYER_FACTORY__ : null;
    if (container && rangeTransport && !rangeTransport.supports(container)) {
      if (nativeCoreWait?.route !== route) nativeCoreWait = { route, at: Date.now() };
      if (Date.now() - nativeCoreWait.at < 3000) {
        restartTimer = setTimeout(startPlayer, 250);
        return;
      }
    } else {
      nativeCoreWait = null;
    }
    if (!container) {
      stats.playerState = stats.takeoverError?.route === route ? "error" : "waiting";
      schedulePublish();
      restartTimer = setTimeout(startPlayer, 350);
      return;
    }
    // Where the compatibility mode cannot hold Bilibili's core, an episode is left to
    // Bilibili rather than taken over in full.
    if (identity.epId && !rangeTransport?.supports(container)) {
      failedRoute = route;
      remember("episode not taken over", "episodes use the compat mode, which cannot reach Bilibili's player here");
      if (player) stopPlayer(true);
      stats.playerState = "native-fallback";
      publish();
      return;
    }
    const generation = routeGeneration;
    let playinfo = currentPlayinfo(identity);
    if (!playinfo) {
      // A request that keeps failing (an episode Bilibili will not serve here, its risk
      // control) is asked again after a growing pause, up to a minute. The loop that calls
      // startPlayer every second would otherwise ask once a second for as long as the page
      // stays open.
      if (playinfoRetry.route === route && Date.now() < playinfoRetry.at) return;
      startingRoute = route;
      routeRequestController?.abort();
      const controller = new AbortController();
      routeRequestController = controller;
      stats.playerState = "waiting";
      schedulePublish();
      try {
        playinfo = await fetchRoutePlayinfo(identity, controller.signal);
        playinfoRetry = { route: "", at: 0, count: 0 };
      } catch (error) {
        if (error?.name !== "AbortError" && generation === routeGeneration && routeIdentity()?.key === route) {
          recordTakeoverFailure(route, "playinfo", error);
          const count = playinfoRetry.route === route ? playinfoRetry.count + 1 : 1;
          const delay = Math.min(60000, 700 * (2 ** (count - 1)));
          playinfoRetry = { route, at: Date.now() + delay, count };
          restartTimer = setTimeout(startPlayer, delay);
        }
        return;
      } finally {
        if (startingRoute === route) startingRoute = "";
        if (routeRequestController === controller) routeRequestController = null;
      }
      if (generation !== routeGeneration || routeIdentity()?.key !== route) return;
    }
    const unsupported = identity.epId ? unsupportedEpisode(playinfo) : "";
    if (unsupported) {
      failedRoute = route;
      remember("episode not taken over", unsupported);
      if (player) stopPlayer(true);
      stats.playerState = "native-fallback";
      publish();
      return;
    }
    if (player) stopPlayer(false);
    stats.playerState = "loading";
    stats.lastError = "";
    stats.mode = settings.mode;
    publish();
    const isPodSwitch = Boolean(pendingPodSwitch && identity.key !== pendingPodSwitch.fromRoute);
    const lifecycle = ++playerLifecycle;
    if (cdnBanRoute !== route) {
      cdnBans?.reset();
      bans = [];
      cdnBanRoute = route;
    }
    const preferredQuality = nativeQuality();
    const preferredCodec = nativeCodec();
    const preferredAudio = nativeAudio();
    const retakeTime = takeRetakePosition(route, container.querySelector("video"));
    const resumeAfterStop = takeResumeHint(retakeTime !== undefined || (autoRetakeRoute === route && autoRetakeCount > 0));
    for (const meter of Object.values(speedMeters)) meter.shown = 0;
    try {
      // The compatibility mode needs Bilibili's own playback core; without it an ordinary
      // video is taken over as usual (an episode never gets this far without it).
      const factory = rangeTransport?.supports(container) ? rangeTransport : playerFactory;
      const nextPlayer = factory.createNativePlayer({
        container,
        identity,
        preferredQuality,
        autoQuality: preferredQuality ? 0 : nativeAutoQuality(),
        preferredCodec,
        preferredAudio,
        // A collection item is a different video. Its native <video> element
        // can still expose the previous item's currentTime until new metadata
        // arrives, so carrying that value across would clamp short videos to
        // their final frame and make the switch look frozen.
        initialTime: isPodSwitch ? 0 : retakeTime,
        // The emptied element reads zero, which counts as a video that has not started yet:
        // a paused one would then start by itself.
        initialResume: isPodSwitch ? pendingPodSwitch.resume : resumeAfterStop ? true : retakeTime !== undefined ? false : undefined,
        autoplay: nativeAutoplay(),
        getSettings: () => settings,
        isNativeUiReady: () => Boolean(container.querySelector(".bpx-player-ctrl-btn")),
        nativeFetch,
        poster: String(root.__INITIAL_STATE__?.videoData?.pic || ""),
        onTransfer,
        cdnBans,
        onNativeSourceChange() {
          if (lifecycle !== playerLifecycle) return;
          notices?.detach();
          handleNativeSourceChange(route, lifecycle);
        },
        onSegment(event) {
          if (lifecycle !== playerLifecycle) return;
          if (takeoverFailureRoute === route || stats.takeoverError?.route === route) {
            clearTakeoverFailure();
            stats.lastError = "";
          }
          stats.acceleratedRequests += 1;
          stats.acceleratedBytes += Number(event.bytes) || 0;
          stats.parallelSubrequests += Number(event.pieces) || 0;
          publish();
        },
        onState(next) {
          if (lifecycle !== playerLifecycle) return;
          stats.mode = next.mode || settings.mode;
          stats.playerState = next.playerState || stats.playerState;
          if (next.playerState === "ready" && (takeoverFailureRoute === route || stats.takeoverError?.route === route)) {
            clearTakeoverFailure();
            stats.lastError = "";
          }
          // The compatibility mode names a quality it does not know "native" (Bilibili's own).
          stats.quality = next.quality || stats.quality;
          stats.bufferedAhead = Number(next.bufferedAhead) || 0;
          if (typeof next.lastError === "string") stats.lastError = next.lastError.slice(0, 180);
          const byHost = new Map();
          for (const item of next.cdnHosts || []) {
            const current = byHost.get(item.host);
            if (!current || current.state === "untested" || ["blocked", "banned"].includes(item.state)) byHost.set(item.host, item);
          }
          stats.cdnHosts = Array.from(byHost.values()).slice(0, 32);
          stats.discoveredCdns = stats.cdnHosts.length;
          stats.healthyCdns = stats.cdnHosts.filter((item) => item.state === "healthy").length;
          stats.blockedCdns = stats.cdnHosts.filter((item) => ["blocked", "banned"].includes(item.state)).length;
          schedulePublish();
        },
        onFatal(error) {
          if (lifecycle !== playerLifecycle) return;
          remember("playback failed", error?.message || error, "error");
          failedRoute = route;
          recordTakeoverFailure(route, "mse", error, true);
          setTimeout(() => {
            if (lifecycle === playerLifecycle && player && playerRoute === route && stats.playerState === "error") {
              stopPlayer(true);
              stats.playerState = "native-fallback";
              publish();
              scheduleAutoRetake(route);
            }
          }, 3500);
        },
        playinfo
      });
      if (lifecycle !== playerLifecycle) {
        nextPlayer?.destroy?.({ resumeNative: false });
        return;
      }
      player = nextPlayer;
      remember("took over", `${route}${nextPlayer.nativeTransport ? " (compat)" : ""}`);
      stats.architecture = nextPlayer.nativeTransport ? "native-player-range-transport" : FULL_ARCHITECTURE;
      playerRoute = route;
      playerContainer = container;
      suppressNativeSchedulers();
      qualityPlayer = nextPlayer;
      syncedQuality = preferredQuality;
      syncedAutoQuality = preferredQuality ? 0 : Number(nextPlayer.getDebug?.()?.autoQuality) || 0;
      codecPlayer = nextPlayer;
      syncedCodec = preferredCodec;
      notices?.attach(nextPlayer.video, route, lifecycle, () => lifecycle === playerLifecycle && player === nextPlayer && playerRoute === routeIdentity()?.key && playerContainer?.isConnected && !["error", "native-fallback", "disabled"].includes(stats.playerState));
      syncFrameWatch(nextPlayer.video);
      if (isPodSwitch) {
        trustedPodVideoKey = identity.videoKey;
        pendingPodSwitch = null;
      }
    } catch (error) {
      if (lifecycle !== playerLifecycle) return;
      recordTakeoverFailure(route, "create", error, true);
      restartTimer = setTimeout(startPlayer, 2000);
    }
  }

  function restartPlayer(force = false) {
    clearTimeout(restartTimer);
    const identity = routeIdentity();
    if (!force && player && identity?.key === playerRoute && playerContainer?.isConnected && player.video?.isConnected) return;
    routeGeneration += 1;
    routeRequestController?.abort();
    routeRequestController = null;
    startingRoute = "";
    failedRoute = "";
    if (player) stopPlayer(false);
    restartTimer = setTimeout(startPlayer, 50);
  }

  root.addEventListener("message", (event) => {
    if (event.source !== root || event.data?.channel !== CHANNEL) return;
    if (event.data.type === "settings") {
      const previous = settings;
      const hadLoadedSettings = settingsLoaded;
      settings = core.normalizeSettings(event.data.payload);
      settingsLoaded = true;
      notices?.configure(settings);
      syncFrameWatch();
      const serversChanged = settings.mode === "custom" && previous.customHosts.join(",") !== settings.customHosts.join(",");
      if (!hadLoadedSettings || previous.enabled !== settings.enabled || previous.takeover !== settings.takeover || previous.mode !== settings.mode || previous.concurrency !== settings.concurrency || previous.autoConcurrency !== settings.autoConcurrency || serversChanged) {
        remember("settings applied", `${settings.takeover === "compat" ? "compat" : "full"}, ${settings.mode === "overseas" ? "overseas" : settings.mode === "custom" ? `custom ${settings.customHosts?.length || 0}` : "mainland"}, threads ${settings.autoConcurrency ? "auto" : settings.concurrency}`);
      }
      stats.autoThreads = settings.autoConcurrency ? autoThreads?.threads() || 0 : 0;
      stats.mode = settings.mode;
      syncSettingsMenu();
      // 剧集加速 only matters on an episode page; elsewhere the video playing is left alone.
      const episodeSwitched = previous.episodeEnabled !== settings.episodeEnabled && Boolean(routeIdentity()?.epId);
      if (!settings.enabled || (episodeSwitched && settings.episodeEnabled === false)) {
        clearTakeoverFailure();
        stats.lastError = "";
        stopPlayer(true);
      }
      else if (!previous.enabled || previous.takeover !== settings.takeover || episodeSwitched) {
        // The compatibility mode speeds up Bilibili's own player, so when it can take that
        // player over now, the full takeover hands the video back to it first. Stopped without
        // that, it left the element empty: the video went black at zero until the page was
        // reloaded. Without Bilibili's core the video is taken over in full again, from where
        // it was.
        if (settings.takeover === "compat" && player && !player.nativeTransport
          && root.__BILI_NATIVE_RANGE_PLAYER_FACTORY__?.supports(playerContainer)) stopPlayer(true);
        restartPlayer(true);
      }
      else {
        // Everything else applies in place: the download lists read the CDN mode and servers
        // for every request, the downloads the thread count for every range, and the full
        // takeover its buffer settings whenever it tops the buffer up (applySettings does that
        // at once). Restarting the player used to send the video back to its start.
        if (hadLoadedSettings && (previous.mode !== settings.mode || serversChanged) && playerRoute) preconnectCdnNodes(playerRoute);
        player?.applySettings?.(settings);
        startPlayer();
      }
    } else if (event.data.type === "get-stats") {
      publish();
    } else if (event.data.type === "retry-takeover") {
      clearTimeout(autoRetakeTimer);
      autoRetakeCount = 0;
      clearTakeoverFailure();
      stats.lastError = "";
      failedRoute = "";
      restartPlayer(true);
    }
  });

  const nativePushState = history.pushState.bind(history);
  const nativeReplaceState = history.replaceState.bind(history);
  const pathVideoKey = () => urlPathId().toLowerCase();
  history.pushState = function (...args) {
    const previousPathVideoKey = pathVideoKey();
    const result = nativePushState(...args);
    if (!pendingPodSwitch && pathVideoKey() !== previousPathVideoKey) trustedPodVideoKey = "";
    restartPlayer(false);
    return result;
  };
  history.replaceState = function (...args) {
    const previousPathVideoKey = pathVideoKey();
    const result = nativeReplaceState(...args);
    if (!pendingPodSwitch && pathVideoKey() !== previousPathVideoKey) trustedPodVideoKey = "";
    restartPlayer(false);
    return result;
  };
  root.addEventListener("popstate", () => {
    trustedPodVideoKey = "";
    restartPlayer(false);
  });
  document.addEventListener("click", preparePodSwitch, true);
  document.addEventListener("click", watchQualityMenu, true);
  const settingsObserver = new MutationObserver(scheduleSettingsMenuSync);
  const startSettingsObserver = () => {
    if (!document.documentElement) {
      document.addEventListener("readystatechange", startSettingsObserver, { once: true });
      return;
    }
    settingsObserver.observe(document.documentElement, { childList: true, subtree: true });
    syncSettingsMenu();
  };
  startSettingsObserver();
  setInterval(() => {
    const identity = routeIdentity();
    if (settingsLoaded && settings.enabled && (!player || playerRoute !== identity?.key || !playerContainer?.isConnected || !player.video?.isConnected)) startPlayer();
    else {
      syncNativeQuality();
      driveAutoQuality();
      syncNativeCodec();
      resolveNativeQualitySwitch();
      suppressNativeSchedulers();
      refreshExpiringPlayinfo();
    }
    updateNativeInfoPanel();
    syncSettingsMenu();
  }, 1000);

  Object.defineProperty(root, "__biliThreadRipperDebug", {
    configurable: false,
    value: Object.freeze({
      getPlayer: () => player,
      getSettings: () => ({ ...settings }),
      getStats: () => ({ ...stats, takeoverError: stats.takeoverError ? { ...stats.takeoverError } : null, threadSpeeds: stats.threadSpeeds.map((item) => ({ ...item })) }),
      restart: () => restartPlayer(true),
      // Everything needed to see where the time went: run copy(__biliThreadRipperDebug.report())
      // in the console and paste the result.
      report: () => {
        const debug = player?.getDebug?.() || {};
        const { timeline = [], ...rest } = debug;
        const video = player?.video || findContainer()?.querySelector("video");
        syncFrameWatch(video);
        const frame = frameWatch && frameWatch.video === video ? frameWatch.last : null;
        let frames = null;
        try {
          const quality = video?.getVideoPlaybackQuality?.();
          if (quality) frames = { total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames };
        } catch (_error) {}
        // Playback state and node names only: no download address or account data.
        return JSON.stringify({
          version: stats.version, channel: "stable" === "canary" ? "canary" : "stable", scriptManager: document.documentElement?.getAttribute("data-btr-userscript-manager") || "", at: Math.round(performance.now()), settings: { takeover: settings.takeover, mode: settings.mode, customHosts: settings.customHosts.slice(), concurrency: settings.concurrency, codec: nativeCodec() || "default" },
          actualTakeover: !player ? "native" : player.nativeTransport ? "compat" : "full",
          // Whether this address is a video at all (the home page and search are not).
          videoPage: (() => { try { return Boolean(routeIdentity()); } catch (_error) { return true; } })(),
          // The native menu's quality: newQ chosen (0 for 自动), realQ what 自动 shows (#69).
          nativeQuality: (() => { try { const quality = root.player?.getQuality?.(); return quality ? { nowQ: quality.nowQ, newQ: quality.newQ, realQ: quality.realQ } : null; } catch (_error) { return null; } })(),
          nativeCore: { buffersLocked: lockedBuffers.size, mediaRequests: nativeMedia.requests },
          playback: video ? { currentTime: video.currentTime, duration: video.duration, ended: video.ended,
            paused: video.paused, seeking: video.seeking, readyState: video.readyState, playbackRate: video.playbackRate,
            width: video.videoWidth, height: video.videoHeight, visibility: document.visibilityState, frames,
            lastPresentedFrame: frame ? { ...frame, ageMs: Math.max(0, performance.now() - frame.observedAtMs) } : null,
            ...elementState(video) } : null,
          state: stats.playerState, lastError: stats.lastError, player: rest, nodes: stats.cdnHosts.map((item) => ({ ...item })), bannedNodes: cdnBans?.hosts?.() || [], page: pageEvents.map((event) => ({ ...event })), timeline, previousPlayer: previousTimeline,
          timeOrigin: performance.timeOrigin,
          route: playerRoute,
          downloads: {
            byKind: Object.fromEntries(Object.entries(downloads.byKind).map(([kind, counts]) => [kind, { ...counts }])),
            cancelReasons: { ...downloads.cancelReasons },
            hosts: Object.fromEntries(Object.entries(downloads.hosts).map(([host, counts]) => [host, { ...counts }])),
            active: [...transfers.values()].filter((item) => item.state === "active").length,
            lastBytesAt: downloads.lastBytesAt
          },
          bans: bans.map((ban) => ({ ...ban }))
        }, null, 1);
      },
      version: "2026.11.13.1"
    })
  });
  publish();
})(globalThis);

/* src/live-core.js */
(function installLiveCore(root) {
  "use strict";

  // The parts of the live module that carry logic: playlist parsing, P2P/proxy URL handling
  // and the host pool, plus a room playinfo parser that only the tests use. No DOM and no
  // timers, so dev tests can run all of it in Node.

  // fMP4 HLS nodes that accept each other's signatures, verified by probing real streams
  // (2026-09): a segment signed for one of them downloads from all of them with HTTP 206,
  // while FLV-line (ov-gotcha07) and TS-line (gotcha105) nodes answer 403. The live module
  // probes each candidate before trusting it, again with later playlists until it passes or
  // is banned.
  const KNOWN_FMP4_HOSTS = Object.freeze([
    "d1--cn-gotcha204.bilivideo.com",
    "d1--cn-gotcha208.bilivideo.com",
    "d1--ov-gotcha208.bilivideo.com",
    "d1--ov-gotcha208b.bilivideo.com"
  ]);

  const LIVE_HOST_RE = /(?:^|\.)bilivideo\.(?:com|cn|net)$/i;
  const P2P_HOST_RE = /(?:^|\.)(?:mcdn\.bilivideo\.(?:com|cn|net)|szbdyd\.com|nexusedgeio\.com|ahdohpiechei\.com)$/i;
  // A stream URL wrapped in a commercial relay: https://xxx.smtcdns.net/d1--yy.bilivideo.com/...
  const PROXY_WRAP_RE = /^(https?:)\/\/[\w.-]+\.smtcdns\.(?:net|com)\/([\w-]+\.bilivideo\.(?:com|cn|net))(\/.*)$/i;

  function hostnameOf(value) {
    try { return new URL(value).hostname.toLowerCase(); }
    catch (_error) { return ""; }
  }

  function isLiveSegmentUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && LIVE_HOST_RE.test(url.hostname) && /\/live-bvc\//.test(url.pathname) && /\.m4s$/i.test(url.pathname);
    } catch (_error) { return false; }
  }

  function isLivePlaylistUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && LIVE_HOST_RE.test(url.hostname) && /\.m3u8$/i.test(url.pathname);
    } catch (_error) { return false; }
  }

  function isP2pUrl(value) {
    const host = hostnameOf(value);
    if (!host) return false;
    return P2P_HOST_RE.test(host) || host.split(".")[0].includes("302");
  }

  // A smtcdns-wrapped URL unwraps to the official node it relays for; anything else
  // returns "" and stays untouched.
  function unwrapProxyUrl(value) {
    const match = PROXY_WRAP_RE.exec(String(value || ""));
    return match ? `${match[1]}//${match[2]}${match[3]}` : "";
  }

  // The playurl of getRoomPlayInfo, flattened to one entry per protocol/format/codec.
  function parseRoomPlayInfo(payload) {
    const playurl = payload?.data?.playurl_info?.playurl
      || payload?.result?.playurl_info?.playurl
      || payload?.playurl_info?.playurl;
    const out = [];
    for (const stream of playurl?.stream || []) {
      for (const format of stream.format || []) {
        for (const codec of format.codec || []) {
          const urls = (codec.url_info || [])
            .map((info) => ({ host: String(info?.host || ""), extra: String(info?.extra || "") }))
            .filter((info) => info.host && !isP2pUrl(info.host));
          if (!urls.length || !codec.base_url) continue;
          out.push({
            protocol: String(stream.protocol_name || ""),
            format: String(format.format_name || ""),
            codec: String(codec.codec_name || ""),
            qn: Number(codec.current_qn) || 0,
            acceptQn: Array.isArray(codec.accept_qn) ? codec.accept_qn.map(Number) : [],
            baseUrl: String(codec.base_url),
            urls
          });
        }
      }
    }
    return out;
  }

  function segmentNumber(name) {
    const match = /(\d+)\.m4s$/i.exec(String(name || ""));
    return match ? Number(match[1]) : 0;
  }

  // A live media playlist. Segment URLs resolve against the playlist URL, so a playlist
  // fetched from any node names segments on that same node.
  function parseM3u8(text, playlistUrl) {
    const lines = String(text || "").split(/\r?\n/);
    const segments = [];
    let mapUrl = "";
    let duration = 0;
    for (const line of lines) {
      if (line.startsWith("#EXT-X-MAP")) {
        const uri = /URI="([^"]+)"/.exec(line)?.[1];
        if (uri) try { mapUrl = new URL(uri, playlistUrl).href; } catch (_error) {}
        continue;
      }
      if (line.startsWith("#EXTINF")) {
        duration = Number(/#EXTINF:([\d.]+)/.exec(line)?.[1]) || 0;
        continue;
      }
      if (!line || line.startsWith("#")) continue;
      try {
        segments.push({ name: line.trim(), url: new URL(line.trim(), playlistUrl).href, num: segmentNumber(line), duration });
      } catch (_error) {}
      duration = 0;
    }
    return { mapUrl, segments, lastNum: segments.at(-1)?.num || 0 };
  }

  // Node health for one live stream. Live pieces are one second long, so the pool acts
  // fast: it ranks by first-byte time, blocks a failing node briefly, and bans one that
  // twice sent nothing. Proven nodes rank first; unproven candidates follow them until a
  // probe or a download proves them.
  function createHostPool(options = {}) {
    const health = new Map(); // host -> {fbMs, bps, failures, blockedUntil, proven, emptyReplies, banned}
    const now = () => (options.now ? options.now() : Date.now());

    function entry(host) {
      if (!health.has(host)) health.set(host, { fbMs: 0, bps: 0, failures: 0, blockedUntil: 0, proven: false, emptyReplies: 0, banned: false });
      return health.get(host);
    }

    return Object.freeze({
      add(host, proven = false) {
        const item = entry(String(host || "").toLowerCase());
        if (proven) item.proven = true;
      },
      success(host, fbMs, bps) {
        const item = entry(host);
        item.proven = true;
        item.banned = false;
        item.emptyReplies = 0;
        item.failures = 0;
        item.blockedUntil = 0;
        if (Number(fbMs) > 0) item.fbMs = item.fbMs ? item.fbMs * 0.6 + fbMs * 0.4 : fbMs;
        if (Number(bps) > 0) item.bps = item.bps ? item.bps * 0.6 + bps * 0.4 : bps;
      },
      failure(host, receivedBytes = 0) {
        const item = entry(host);
        item.failures += 1;
        item.blockedUntil = now() + Math.min(20000, 1500 * (2 ** Math.min(item.failures, 3)));
        if (Number(receivedBytes) <= 0) {
          item.emptyReplies += 1;
          if (item.emptyReplies >= 2 && !item.banned) {
            item.banned = true;
            try { options.onBan?.(host); } catch (_error) {}
          }
        }
      },
      // Ranked hosts: proven ones by first-byte speed, then unproven candidates. Blocked
      // and banned hosts drop out unless nothing else is left.
      pick(count = 3) {
        const time = now();
        const all = [...health.entries()];
        const open = all.filter(([, item]) => !item.banned && item.blockedUntil <= time);
        const unbanned = all.filter(([, item]) => !item.banned);
        const pool = open.length ? open : unbanned.length ? unbanned : all;
        const ranked = pool.sort(([, a], [, b]) =>
          Number(b.proven) - Number(a.proven)
          || (a.fbMs || 9e9) - (b.fbMs || 9e9)
          || (b.bps || 0) - (a.bps || 0));
        return ranked.slice(0, Math.max(1, count)).map(([host]) => host);
      },
      unproven() {
        return [...health.entries()].filter(([, item]) => !item.proven && !item.banned).map(([host]) => host);
      },
      status() {
        const time = now();
        return [...health.entries()].map(([host, item]) => ({
          host,
          state: item.banned ? "banned" : item.blockedUntil > time ? "blocked" : item.proven ? "healthy" : "untested",
          bps: Math.round(item.bps || 0)
        }));
      }
    });
  }

  root.__BILI_LIVE_CORE__ = Object.freeze({
    KNOWN_FMP4_HOSTS,
    createHostPool,
    isLivePlaylistUrl,
    isLiveSegmentUrl,
    isP2pUrl,
    parseM3u8,
    parseRoomPlayInfo,
    segmentNumber,
    unwrapProxyUrl
  });
})(globalThis);

/* src/live-hook.js */
(function installLiveHook(root) {
  "use strict";

  // The live module: only the live site, and the userscript build loads every file on
  // every bilibili page, so the hostname decides. The dev fixtures run on 127.0.0.1 and
  // opt in explicitly.
  if (!/^live\.bilibili\.com$/i.test(root.location?.hostname || "") && root.__BTR_TEST_ALLOW_LIVE__ !== true) return;

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const INSTALL_FLAG = "__biliThreadRipperLiveInstalled";
  const core = root.__BILI_LIVE_CORE__;
  const rangeCore = root.__BILI_RANGE_CORE__;
  if (!core || !rangeCore || typeof root.fetch !== "function" || root[INSTALL_FLAG]) return;
  Object.defineProperty(root, INSTALL_FLAG, { value: true });

  const nativeFetch = root.fetch.bind(root);
  const HEDGE_MS = 400;
  // A piece the player is actively waiting for hedges sooner: pieces are one second long
  // and its own buffer is shallow.
  const URGENT_HEDGE_MS = 150;
  const FIRST_BYTE_TIMEOUT_MS = 2500;
  const SEGMENT_TIMEOUT_MS = 8000;
  const CACHE_LIMIT = 32;
  const CACHE_TTL_MS = 45000;

  let settings = rangeCore.normalizeSettings({});
  let settingsLoaded = false;
  // Off until the saved settings have arrived, and then only if the viewer switched it on
  // (liveEnabled is off by default).
  const liveOn = () => settingsLoaded && settings.enabled && settings.liveEnabled;

  // Bilibili's web player loads P2P SDKs that pull pieces from other viewers over WebRTC.
  // Overseas there are few viewers nearby, so P2P only adds stalls; the mocks keep the
  // player on the HTTP path. (Approach proven by Make-Bilibili-Great-Than-Ever-Before.)
  // The page's own SDK is kept and handed out whenever the module is off.
  class MockPcdn { on() {} off() {} emit() {} destroy() {} }
  for (const name of ["PCDNLoader", "BPP2PSDK", "SeederSDK"]) {
    let real = root[name];
    try {
      Object.defineProperty(root, name, {
        configurable: true,
        get() { return liveOn() ? MockPcdn : real; },
        set(value) { real = value; }
      });
    } catch (_error) {}
  }

  // ---- stats for the settings panel ----
  const stats = {
    version: "2026.11.13.1",
    architecture: "live-segment-ripper",
    mode: "live",
    playerState: "waiting",
    quality: "直播",
    bufferedAhead: 0,
    acceleratedRequests: 0,
    acceleratedBytes: 0,
    parallelSubrequests: 0,
    activeThreads: 0,
    totalSpeedBps: 0,
    threadSpeeds: [],
    discoveredCdns: 0,
    healthyCdns: 0,
    blockedCdns: 0,
    cdnHosts: [],
    lastHost: "",
    lastError: "",
    lastErrorAt: null,
    takeoverError: null
  };
  // What the module did, in English for the diagnostic copy (diagnostic-report.js); error
  // messages go in as they were thrown.
  const events = [];
  function remember(level, what, detail = "") {
    events.push({ at: Math.round(performance.now()), level, what, detail: String(detail).slice(0, 200) });
    if (events.length > 60) events.shift();
  }
  const activeTransfers = new Map();
  let transferSequence = 1;
  let publishTimer = null;
  function publish() {
    clearTimeout(publishTimer);
    publishTimer = null;
    const now = Date.now();
    stats.activeThreads = activeTransfers.size;
    stats.totalSpeedBps = Math.round([...activeTransfers.values()].reduce((sum, item) => now - item.at < 2000 ? sum + item.bps : sum, 0));
    if (context) {
      stats.cdnHosts = context.pool.status();
      stats.discoveredCdns = stats.cdnHosts.length;
      stats.healthyCdns = stats.cdnHosts.filter((item) => item.state === "healthy").length;
      stats.blockedCdns = stats.cdnHosts.filter((item) => ["blocked", "banned"].includes(item.state)).length;
    }
    root.postMessage({ channel: CHANNEL, type: "stats", payload: { ...stats } }, "*");
  }
  function schedulePublish() {
    if (!publishTimer) publishTimer = setTimeout(publish, 250);
  }

  // ---- one live stream: the playlist currently being played ----
  // context: { key, pool, cache: Map(url -> {promise, at, hit}), lastNum, mapUrl, probing,
  //   speculativeMisses, prefetchQueue, inflightPrefetch, urgentInflight, abort }
  let context = null;
  // The stream the player asked for most recently. A playlist answer that arrives late,
  // after the player moved on to another stream, must not bring the old one back.
  let latestPlaylistKey = "";

  const swapHost = (url, host) => { const u = new URL(url); u.hostname = host; u.port = ""; return u.href; };
  // Everything of a stream stops with it: queued prefetches, running downloads, probes.
  function dropContext() {
    if (!context) return;
    context.prefetchQueue.length = 0;
    context.abort.abort(new DOMException("直播已切换或加速已关闭", "AbortError"));
    context = null;
  }
  const directoryOf = (url) => { try { const u = new URL(url); return u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1); } catch (_error) { return ""; } };

  function contextFor(playlistUrl) {
    const key = directoryOf(playlistUrl);
    if (context?.key === key) return context;
    dropContext();
    const pool = core.createHostPool({
      onBan(host) {
        remember("warn", "node banned", `${host}, 2 failures with no data`);
      }
    });
    let origin = "";
    try { origin = new URL(playlistUrl).hostname; } catch (_error) {}
    // The node Bilibili handed out is trusted unless it is a P2P relay. In the custom CDN
    // mode only the servers the viewer picked join it; otherwise the known fMP4 group does.
    if (origin && !core.isP2pUrl(playlistUrl)) pool.add(origin, true);
    const extra = settings.mode === "custom" ? settings.customHosts : core.KNOWN_FMP4_HOSTS;
    for (const host of extra) if (host !== origin) pool.add(host, false);
    context = { key, pool, cache: new Map(), lastNum: 0, mapUrl: "", probing: false, speculativeMisses: 0, prefetchQueue: [], inflightPrefetch: 0, urgentInflight: 0, abort: new AbortController() };
    stats.playerState = "ready";
    remember("info", "took over", origin ? `stream from ${origin}` : "");
    schedulePublish();
    return context;
  }

  // Candidates are probed so that ranking can trust them: the signature is shared within the
  // fMP4 node group, but a node may still lack the stream. Until proven they rank behind the
  // proven nodes and can still get a hedge copy.
  function probeCandidates(ctx, sampleUrl) {
    if (ctx.probing) return;
    const unproven = ctx.pool.unproven();
    if (!unproven.length) return;
    ctx.probing = true;
    Promise.allSettled(unproven.map(async (host) => {
      const startedAt = performance.now();
      try {
        const probe = new AbortController();
        const probeTimer = setTimeout(() => probe.abort(new DOMException("直播节点探测超时", "TimeoutError")), 4000);
        const dropProbe = () => probe.abort(ctx.abort.signal.reason);
        ctx.abort.signal.addEventListener("abort", dropProbe, { once: true });
        let response;
        let body;
        try {
          response = await nativeFetch(swapHost(sampleUrl, host), {
            headers: { Range: "bytes=0-2047" },
            credentials: "omit",
            cache: "no-store",
            signal: probe.signal
          });
          body = new Uint8Array(await response.arrayBuffer());
        } finally {
          clearTimeout(probeTimer);
          ctx.abort.signal.removeEventListener("abort", dropProbe);
        }
        if ((response.status === 206 || response.status === 200) && body.byteLength > 0) {
          ctx.pool.success(host, performance.now() - startedAt, 0);
        } else {
          ctx.pool.failure(host, body.byteLength);
        }
      } catch (_error) {
        ctx.pool.failure(host, 0);
      }
    })).then(() => {
      ctx.probing = false;
      schedulePublish();
    });
  }

  async function attemptSegment(ctx, url, host, signal) {
    const startedAt = performance.now();
    const transferId = transferSequence++;
    activeTransfers.set(transferId, { at: Date.now(), bps: 0 });
    schedulePublish();
    let received = 0;
    try {
      const response = await nativeFetch(swapHost(url, host), {
        credentials: "omit",
        cache: "no-store",
        signal
      });
      if (response.status !== 200 && response.status !== 206) {
        throw Object.assign(new Error(`直播分片响应异常：HTTP ${response.status}`), { status: response.status });
      }
      // Nothing here asks for a range, so a 206 is only acceptable when it covers the file.
      const contentRange = rangeCore.parseContentRange(response.headers.get("content-range"));
      if (response.status === 206 && (!contentRange || contentRange.start !== 0 || contentRange.total === null || contentRange.end !== contentRange.total - 1)) {
        throw new Error("直播分片只返回了一部分");
      }
      const reader = response.body?.getReader?.();
      const chunks = [];
      let firstByteMs = 0;
      if (reader) {
        const firstByteTimer = setTimeout(() => reader.cancel(new DOMException("直播分片首字节超时", "TimeoutError")).catch(() => {}), FIRST_BYTE_TIMEOUT_MS);
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!firstByteMs) {
            firstByteMs = performance.now() - startedAt;
            clearTimeout(firstByteTimer);
          }
          chunks.push(value);
          received += value.byteLength;
          const item = activeTransfers.get(transferId);
          if (item) {
            item.bps = received * 1000 / Math.max(1, performance.now() - startedAt);
            item.at = Date.now();
          }
        }
        clearTimeout(firstByteTimer);
      } else {
        const body = new Uint8Array(await response.arrayBuffer());
        firstByteMs = performance.now() - startedAt;
        chunks.push(body);
        received = body.byteLength;
      }
      if (signal?.aborted) throw new DOMException("已取消", "AbortError");
      if (received <= 0) throw new Error("直播分片为空");
      const declared = response.status === 206 ? contentRange.total : Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > 0 && received !== declared) throw new Error(`直播分片长度不对：收到 ${received}，应为 ${declared}`);
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const elapsed = Math.max(1, performance.now() - startedAt);
      ctx.pool.success(host, firstByteMs || elapsed, received * 1000 / elapsed);
      stats.lastHost = host;
      return { bytes, contentType: response.headers.get("content-type") || "video/iso.segment", host };
    } catch (error) {
      if (error?.name !== "AbortError" && Number(error?.status) !== 404) ctx.pool.failure(host, received);
      throw error;
    } finally {
      activeTransfers.delete(transferId);
      schedulePublish();
    }
  }

  // One segment: the best node first, a hedge copy on the second-best if the first has not
  // finished after a short delay (shorter when the player is waiting, longer for a
  // speculative fetch) or fails. A 404 is never counted against a node: for a speculative
  // fetch it means the segment is not born yet.
  async function downloadSegment(ctx, url, { speculative = false, urgent = false } = {}) {
    const hosts = ctx.pool.pick(2);
    if (!hosts.length) throw new Error("没有可用直播节点");
    const controllers = hosts.map(() => new AbortController());
    const dropped = () => controllers.forEach((c) => { if (!c.signal.aborted) c.abort(ctx.abort.signal.reason); });
    if (ctx.abort.signal.aborted) dropped();
    else ctx.abort.signal.addEventListener("abort", dropped, { once: true });
    const overall = setTimeout(() => controllers.forEach((c) => c.abort(new DOMException("直播分片总超时", "TimeoutError"))), SEGMENT_TIMEOUT_MS);
    let primaryFailed = () => {};
    const primaryFailure = new Promise((resolve) => { primaryFailed = resolve; });
    try {
      const attempts = hosts.map((host, index) => (async () => {
        if (index) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, speculative ? HEDGE_MS * 3 : urgent ? URGENT_HEDGE_MS : HEDGE_MS);
            primaryFailure.then(() => { clearTimeout(timer); resolve(); });
          });
          if (controllers[index].signal.aborted) throw new DOMException("已取消", "AbortError");
        }
        try {
          return await attemptSegment(ctx, url, host, controllers[index].signal);
        } catch (error) {
          if (!index) primaryFailed();
          throw error;
        }
      })());
      const winner = await Promise.any(attempts);
      controllers.forEach((controller) => { if (!controller.signal.aborted) controller.abort(new DOMException("并发副本已取消", "AbortError")); });
      return winner;
    } catch (aggregate) {
      throw aggregate?.errors?.at?.(-1) || aggregate;
    } finally {
      clearTimeout(overall);
      ctx.abort.signal.removeEventListener("abort", dropped);
    }
  }

  function pruneCache(ctx) {
    const now = Date.now();
    for (const [key, item] of ctx.cache) {
      if (key === ctx.mapUrl) continue;
      if (now - item.at > CACHE_TTL_MS) ctx.cache.delete(key);
    }
    while (ctx.cache.size > CACHE_LIMIT) {
      const oldest = [...ctx.cache.keys()].find((key) => key !== ctx.mapUrl);
      if (!oldest) break;
      ctx.cache.delete(oldest);
    }
  }

  function cacheSegment(ctx, url, options = {}) {
    let item = ctx.cache.get(url);
    if (item) return item;
    item = { at: Date.now(), hit: false, promise: downloadSegment(ctx, url, options) };
    item.promise.catch(() => { if (ctx.cache.get(url) === item) ctx.cache.delete(url); });
    ctx.cache.set(url, item);
    pruneCache(ctx);
    return item;
  }

  // Prefetch runs through a small queue instead of all at once: the first playlist would
  // otherwise burst eight segments that compete for bandwidth with the very segment the
  // player is waiting for, which is exactly when its shallow buffer runs dry. While the
  // player waits for a segment (urgent), the queue nearly stops.
  function pumpPrefetch(ctx) {
    while (ctx.inflightPrefetch < (ctx.urgentInflight > 0 ? 1 : 3) && ctx.prefetchQueue.length) {
      const next = ctx.prefetchQueue.shift();
      if (ctx.cache.has(next.url)) continue;
      ctx.inflightPrefetch += 1;
      const item = cacheSegment(ctx, next.url, next.options);
      const done = (ok) => {
        try { next.options.onSettled?.(ok); } catch (_error) {}
        ctx.inflightPrefetch = Math.max(0, ctx.inflightPrefetch - 1);
        pumpPrefetch(ctx);
      };
      item.promise.then(() => done(true), () => done(false));
    }
  }

  function enqueuePrefetch(ctx, url, options = {}) {
    if (ctx.cache.has(url) || ctx.prefetchQueue.some((entry) => entry.url === url)) return;
    ctx.prefetchQueue.push({ url, options });
    if (ctx.prefetchQueue.length > 16) ctx.prefetchQueue.shift();
    pumpPrefetch(ctx);
  }

  // What a new playlist drives: the init map, every announced segment not yet cached, and —
  // once all announced segments are cached or downloading — one speculative future segment,
  // whose 404 only means the encoder has not produced it yet.
  function onPlaylist(playlistUrl, text, requestedKey) {
    if (!liveOn() || requestedKey !== latestPlaylistKey) return;
    // Only fMP4 media playlists: a master playlist or a TS stream is not the module's business.
    if (/#EXT-X-STREAM-INF/.test(text) || !/#EXT-X-MAP/.test(text)) return;
    const parsed = core.parseM3u8(text, playlistUrl);
    if (!parsed.segments.length || !parsed.segments.every((segment) => /\.m4s$/i.test(segment.name))) return;
    const ctx = contextFor(playlistUrl);
    ctx.lastNum = Math.max(ctx.lastNum, parsed.lastNum);
    if (parsed.mapUrl) {
      ctx.mapUrl = parsed.mapUrl;
      // The init segment is tiny and everything needs it: fetched at once, outside the queue.
      if (!ctx.cache.has(parsed.mapUrl)) cacheSegment(ctx, parsed.mapUrl);
    }
    probeCandidates(ctx, parsed.segments[0].url);
    // The whole announced window, not just the newest pieces: the player usually plays a
    // few seconds behind the live edge, and a piece it is about to ask for must already
    // be in hand — a cache miss there costs a fresh download against its shallow buffer.
    // Oldest first: that is the order the player will consume them in.
    let pending = 0;
    for (const segment of parsed.segments) {
      if (!ctx.cache.has(segment.url)) {
        enqueuePrefetch(ctx, segment.url);
        pending += 1;
      }
    }
    if (!pending && parsed.lastNum > 0 && ctx.speculativeMisses < 6) {
      const last = parsed.segments.at(-1);
      const nextUrl = last.url.replace(`${last.num}.m4s`, `${last.num + 1}.m4s`);
      if (!ctx.cache.has(nextUrl)) {
        enqueuePrefetch(ctx, nextUrl, {
          speculative: true,
          onSettled: (ok) => { ctx.speculativeMisses = ok ? 0 : ctx.speculativeMisses + 1; }
        });
      }
    }
    stats.bufferedAhead = parsed.segments.filter((segment) => ctx.cache.get(segment.url)).length;
    schedulePublish();
  }

  async function serveSegment(url, input, init) {
    const ctx = context;
    const signal = init?.signal || (input instanceof Request ? input.signal : null);
    if (signal?.aborted) throw signal.reason || new DOMException("已取消", "AbortError");
    const cached = ctx?.cache.get(url);
    const item = cached || (ctx && directoryOf(url) === ctx.key ? cacheSegment(ctx, url, { urgent: true }) : null);
    if (!item) return nativeFetch(input, init);
    // While the player waits here, the prefetch queue slows to a trickle so the waited-for
    // segment gets the bandwidth.
    if (!cached && ctx) ctx.urgentInflight += 1;
    let stopWaiting = () => {};
    try {
      // The download goes on for the cache; only this caller stops waiting.
      const result = await (signal ? Promise.race([item.promise, new Promise((_resolve, reject) => {
        stopWaiting = () => reject(signal.reason || new DOMException("已取消", "AbortError"));
        signal.addEventListener("abort", stopWaiting, { once: true });
      })]) : item.promise);
      if (!item.hit) {
        item.hit = true;
        stats.acceleratedRequests += 1;
        stats.acceleratedBytes += result.bytes.byteLength;
        schedulePublish();
      }
      const response = new Response(result.bytes.slice(), {
        status: 200,
        headers: { "Content-Type": result.contentType, "Content-Length": String(result.bytes.byteLength) }
      });
      try { Object.defineProperty(response, "url", { value: url }); } catch (_error) {}
      return response;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      stats.lastError = String(error?.message || error).slice(0, 160);
      stats.lastErrorAt = Math.round(performance.now());
      remember("warn", "segment failed", stats.lastError);
      schedulePublish();
      return nativeFetch(input, init);
    } finally {
      signal?.removeEventListener("abort", stopWaiting);
      if (!cached && ctx) {
        ctx.urgentInflight = Math.max(0, ctx.urgentInflight - 1);
        pumpPrefetch(ctx);
      }
    }
  }

  // A request whose URL was rewritten keeps everything else the player gave it: headers,
  // credentials, signal, cache mode.
  function withUrl(input, url) {
    if (!(input instanceof Request)) return url;
    try { return new Request(url, input); } catch (_error) { return url; }
  }

  // An smtcdns wrapper unwraps to the official node it fronts. A P2P segment (.m4s) URL moves
  // to the best official node once a stream's pool exists; other P2P URLs pass through.
  function rewriteUrl(url) {
    const unwrapped = core.unwrapProxyUrl(url) || url;
    if (!core.isP2pUrl(unwrapped)) return unwrapped;
    if (context && (core.isLiveSegmentUrl(unwrapped) || /\.m4s(?:\?|$)/i.test(unwrapped))) {
      const best = context.pool.pick(1)[0];
      if (best) try { return swapHost(unwrapped, best); } catch (_error) {}
    }
    return unwrapped;
  }

  root.fetch = function (input, init) {
    let url = "";
    try { url = input instanceof Request ? input.url : String(input); } catch (_error) {}
    if (!liveOn() || !url) return nativeFetch(input, init);
    const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET") return nativeFetch(input, init);
    const rewritten = rewriteUrl(url);
    if (core.isLivePlaylistUrl(rewritten)) {
      const requestedKey = directoryOf(rewritten);
      latestPlaylistKey = requestedKey;
      const pending = nativeFetch(rewritten === url ? input : withUrl(input, rewritten), init);
      pending.then((response) => {
        response.clone().text().then((text) => onPlaylist(response.url || rewritten, text, requestedKey)).catch(() => {});
      }).catch(() => {});
      return pending;
    }
    let ranged = false;
    try { ranged = Boolean((init?.headers && new Headers(init.headers).get("range")) || (input instanceof Request && input.headers.get("range"))); } catch (_error) {}
    if (core.isLiveSegmentUrl(rewritten) && !ranged) {
      return serveSegment(rewritten, rewritten === url ? input : withUrl(input, rewritten), init);
    }
    if (rewritten !== url) return nativeFetch(withUrl(input, rewritten), init);
    return nativeFetch(input, init);
  };

  // A player that loads media over XMLHttpRequest gets only the URL rewrite: relay
  // unwrapping, P2P segments moved to the best node, and segments of a banned node moved to
  // the best one; synthesizing full XHR responses is not worth the risk here.
  const xhrPrototype = root.XMLHttpRequest?.prototype;
  if (xhrPrototype) {
    const nativeOpen = xhrPrototype.open;
    xhrPrototype.open = function (method, url, ...rest) {
      let target = url;
      try {
        if (liveOn() && String(method).toUpperCase() === "GET") {
          const value = String(url || "");
          const rewritten = rewriteUrl(value);
          if (rewritten !== value) target = rewritten;
          else if (core.isLiveSegmentUrl(value) && context) {
            const best = context.pool.pick(1)[0];
            const origin = new URL(value).hostname;
            if (best && best !== origin && context.pool.status().find((item) => item.host === origin)?.state === "banned") {
              target = swapHost(value, best);
            }
          }
        }
      } catch (_error) { target = url; }
      return nativeOpen.call(this, method, target, ...rest);
    };
  }

  root.addEventListener("message", (event) => {
    if (event.source !== root || event.data?.channel !== CHANNEL) return;
    if (event.data.type === "settings") {
      const previous = settings;
      settings = rangeCore.normalizeSettings(event.data.payload);
      if (!settingsLoaded || previous.enabled !== settings.enabled || previous.liveEnabled !== settings.liveEnabled) {
        settingsLoaded = true;
        remember("info", "settings applied", liveOn() ? "on" : "off");
      }
      if (!liveOn()) {
        dropContext();
        stats.playerState = "disabled";
      } else if (previous.mode !== settings.mode || previous.customHosts.join() !== settings.customHosts.join()) {
        // A new CDN choice means a new node pool; the next playlist builds it.
        dropContext();
      }
      publish();
    } else if (event.data.type === "get-stats") {
      publish();
    }
  });

  Object.defineProperty(root, "__biliThreadRipperLiveDebug", {
    value: Object.freeze({
      getContext: () => context && {
        key: context.key,
        lastNum: context.lastNum,
        cached: context.cache.size,
        hosts: context.pool.status()
      },
      getStats: () => ({ ...stats }),
      getEvents: () => events.map((event) => ({ ...event })),
      version: "2026.11.13.1"
    })
  });
  publish();
})(globalThis);

/* src/bridge.js */
(function installBridge() {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const THREAD_OPTIONS = Object.freeze([4, 8, 16, 32, 64, 128]);
  const DEFAULTS = { enabled: true, liveEnabled: false, episodeEnabled: true, blockInternational: false, bufferAheadSeconds: 45, secondaryBuffer: false, theme: "auto", concurrency: 8, autoConcurrency: true, takeover: "full", mode: "mainland", customHosts: [], floatingButton: true, floatingButtonLeft: null, floatingButtonTop: null, guideDone: false };
  // Settings of the old ArtPlayer version, of the compatibility modes removed before today's
  // 兼容模式 (that one is `takeover`), the flag of the first-run guide that 0.9.4.2 removed, and
  // 显示错误, the Debug message filters and Debug 模式 itself, now that BTR shows no messages
  // on the page.
  const RETIRED_KEYS = ["statusNotice", "compatibilityMode", "volume", "danmaku", "danmakuFontSize", "subtitleLanguage", "subtitleLastLanguage", "btrOnboardingRevision", "errorNotices", "debugCategories", "debugNotices"];
  let latestSettings = { ...DEFAULTS };
  let loaded = false;

  // The page checks each custom server again with the full rules before using it; here it
  // only has to look like a host name.
  function normalizeStoredSettings(input) {
    const threads = Math.trunc(Number(input?.concurrency));
    return {
      enabled: input?.enabled !== false,
      liveEnabled: input?.liveEnabled === true,
      episodeEnabled: input?.episodeEnabled !== false,
      blockInternational: input?.blockInternational === true,
      bufferAheadSeconds: [30, 45, 90, 180].includes(Number(input?.bufferAheadSeconds)) ? Number(input.bufferAheadSeconds) : 45,
      secondaryBuffer: input?.secondaryBuffer === true,
      theme: ["light", "dark"].includes(input?.theme) ? input.theme : "auto",
      concurrency: THREAD_OPTIONS.includes(threads) ? threads : 8,
      autoConcurrency: input?.autoConcurrency !== false,
      takeover: input?.takeover === "compat" ? "compat" : "full",
      mode: ["overseas", "custom"].includes(input?.mode) ? input.mode : "mainland",
      customHosts: (Array.isArray(input?.customHosts) ? input.customHosts : [])
        .map((host) => String(host).trim().toLowerCase())
        .filter((host, index, all) => /^[a-z\d](?:[a-z\d.-]{0,251}[a-z\d])?$/.test(host) && all.indexOf(host) === index)
        .slice(0, 32),
      floatingButton: input?.floatingButton !== false,
      floatingButtonLeft: input?.floatingButtonLeft != null && Number(input.floatingButtonLeft) >= 0 && Number(input.floatingButtonLeft) <= 1 ? Number(input.floatingButtonLeft) : null,
      floatingButtonTop: input?.floatingButtonTop != null && Number(input.floatingButtonTop) >= 0 && Number(input.floatingButtonTop) <= 1 ? Number(input.floatingButtonTop) : null,
      guideDone: input?.guideDone === true
    };
  }

  function postSettings() {
    window.postMessage({ channel: CHANNEL, type: "settings", payload: latestSettings }, "*");
  }

  // 阻止使用国际版 (bilibili-site.js), in the page's own frame: keeps the domestic site and
  // takes an international address to the same page on it. Turned off, Bilibili chooses again.
  const site = globalThis.__BTR_BILIBILI_SITE__;
  let keepingDomestic = false;
  function applySiteChoice() {
    if (!site || window.top !== window) return;
    if (!latestSettings.enabled || !latestSettings.blockInternational) {
      if (keepingDomestic) site.stopKeepingDomestic();
      keepingDomestic = false;
      return;
    }
    keepingDomestic = true;
    site.keepDomestic();
    const target = site.domesticAddress(location.href);
    if (!target) return;
    if (site.mayRedirect()) location.replace(target);
    else {
      document.documentElement.dataset.btrSiteGaveUp = "true";
      console.warn("BTR：B 站一直把这个标签页送回国际版（可能是账号只能用国际版），这个标签页先不再跳转。");
    }
  }

  // Once Bilibili's page code knows who is signed in, it may send a domestic page on to the
  // same page on the international site. For a signed-in viewer it decides by the account (its
  // default_sites cookie) and not by user_site, so the page went back and forth until the
  // trips back stopped, and stayed international (#68). With 阻止使用国际版 on, that one
  // navigation is cancelled where the browser lets a page do so (the Navigation API); nothing
  // of Bilibili's is changed. It is registered before Bilibili's code runs; until the settings
  // are in, this site's copy of them decides.
  function blockingInternational() {
    if (loaded) return latestSettings.enabled !== false && latestSettings.blockInternational === true;
    try {
      const copy = JSON.parse(localStorage.getItem("BTR_Userscript.sync") || "{}");
      return copy?.enabled !== false && copy?.blockInternational === true;
    } catch (_error) { return false; }
  }
  if (site?.isSiteRedirect && window.top === window && typeof globalThis.navigation?.addEventListener === "function") {
    let blocked = 0;
    globalThis.navigation.addEventListener("navigate", (event) => {
      if (!event.cancelable || event.navigationType === "traverse" || event.hashChange || event.downloadRequest) return;
      if (!blockingInternational() || !site.isSiteRedirect(event.destination?.url, location.href)) return;
      event.preventDefault();
      site.keepDomestic();
      blocked += 1;
      document.documentElement.dataset.btrSiteRedirectsBlocked = String(blocked);
    });
    // For the diagnostic copy (settings-panel.js): the guard is in place on this page.
    if (document.documentElement) document.documentElement.dataset.btrSiteGuard = "on";
  }

  chrome.storage.sync.get(null, (stored) => {
    latestSettings = normalizeStoredSettings({ ...DEFAULTS, ...stored });
    const retired = RETIRED_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(stored, key));
    if (retired.length) chrome.storage.sync.remove(retired);
    const changed = Object.keys(DEFAULTS).filter((key) => JSON.stringify(stored[key]) !== JSON.stringify(latestSettings[key]));
    if (changed.length) chrome.storage.sync.set(Object.fromEntries(changed.map((key) => [key, latestSettings[key]])));
    loaded = true;
    postSettings();
    applySiteChoice();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    for (const key of Object.keys(DEFAULTS)) {
      if (changes[key]) latestSettings[key] = changes[key].newValue;
    }
    latestSettings = normalizeStoredSettings(latestSettings);
    loaded = true;
    postSettings();
    applySiteChoice();
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.channel !== CHANNEL) return;
    // The settings panel and the player's gear menu save through here.
    if (event.data.type === "get-settings") {
      if (loaded) postSettings();
      return;
    }
    if (event.data.type === "settings-update") {
      const input = event.data.payload;
      if (!input || typeof input !== "object") return;
      const keys = Object.keys(DEFAULTS).filter((key) => Object.prototype.hasOwnProperty.call(input, key));
      if (!keys.length) return;
      const next = normalizeStoredSettings({ ...latestSettings, ...Object.fromEntries(keys.map((key) => [key, input[key]])) });
      chrome.storage.sync.set(Object.fromEntries(keys.map((key) => [key, next[key]])));
      return;
    }
    if (event.data.type === "settings-reset") chrome.storage.sync.set(DEFAULTS);
  });
})();
}

/* user_scripts/adapter/loader.js */
// Runs wherever the userscript manager puts the script. The accelerator itself has to run in
// the bilibili page, so pageCode is started there. The manager's menu only sends a page
// event that opens the settings panel.
//
// pageCode is called directly only when this script already runs as a page script (window
// is the page's own). Otherwise it is injected as a script element: with any @grant,
// Tampermonkey and Violentmonkey both wrap window in a sandbox that keeps globals to the
// script, and in Violentmonkey's "content" mode (the one the header asks for) even
// unsafeWindow is the content script's global rather than the page's.
const LOADED = "data-btr-userscript";
const pageWindow = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;
// Which of the two scripts this is: the released one, or the Canary built from main.
const CHANNEL = "stable" === "canary" ? "canary" : "stable";
// Left on the page by the one of the two that found the other already running.
const ALSO_RUNNING = "data-btr-also-running";

// Which manager runs the script, its version and injection mode, for the diagnostic report
// (Tampermonkey and Violentmonkey both describe themselves in GM_info).
const MANAGER_MARK = "data-btr-userscript-manager";
function describeManager() {
  try {
    const info = typeof GM_info === "object" && GM_info ? GM_info : null;
    return info ? [info.scriptHandler, info.version, info.injectInto].filter(Boolean).map(String).join(" ").slice(0, 80) : "";
  } catch (_error) { return ""; }
}

// The settings live in the manager's storage, which every bilibili subdomain shares; this
// site's localStorage is separate on each one, so a setting changed on space.bilibili.com
// never reached the video pages. Only this side of the script can use the manager's storage:
// the page code (storage-shim.js) asks for it with events carrying JSON text. An empty
// manager starts with defaults; localStorage is only a fallback, never a migration source.
const STORAGE_MARK = "data-btr-userscript-storage";
const manager = typeof GM !== "undefined" && typeof GM?.getValue === "function" && typeof GM?.setValue === "function" ? GM : null;
const managerReportsChanges = typeof GM_addValueChangeListener === "function";

function answerPage(type, message) {
  document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(message) }));
}

function serveStorage() {
  const read = async (area) => {
    const stored = await manager.getValue(area);
    return typeof stored === "string" ? stored : "{}";
  };
  // One request at a time: a change reads what is stored and writes it back.
  let queue = Promise.resolve();
  document.addEventListener("btr-userscript-storage-request", (event) => {
    let request = null;
    try { request = JSON.parse(event.detail); } catch (_error) { return; }
    if (!request || !["sync", "local"].includes(request.area)) return;
    queue = queue.then(async () => {
      let value = {};
      try { value = JSON.parse(await read(request.area)) || {}; } catch (_error) {}
      if (request.op === "set") Object.assign(value, request.items);
      else if (request.op === "remove") for (const key of [].concat(request.keys)) delete value[key];
      if (request.op === "set" || request.op === "remove") await manager.setValue(request.area, JSON.stringify(value));
      answerPage("btr-userscript-storage-reply", { id: request.id, value });
    }).catch((error) => answerPage("btr-userscript-storage-reply", { id: request.id, error: String(error?.message || error) }));
  });
  if (managerReportsChanges) {
    for (const area of ["sync", "local"]) {
      GM_addValueChangeListener(area, (_name, _oldValue, value, remote) => {
        if (remote) answerPage("btr-userscript-storage-change", { area, value: typeof value === "string" ? value : "{}" });
      });
    }
  }
}

function injected() {
  return document.documentElement?.hasAttribute(LOADED) === true;
}

function inject() {
  const source = `(${pageCode})();`;
  // Prefer the manager's own injection, which also works on pages with a strict CSP.
  if (typeof GM_addElement === "function") {
    try { GM_addElement(document.documentElement, "script", { textContent: source })?.remove?.(); }
    catch (_error) {}
  }
  if (injected()) return;
  const script = document.createElement("script");
  script.textContent = source;
  document.documentElement.append(script);
  script.remove();
  if (!injected()) console.error("BTR: 无法在页面里启动线程撕裂者");
}

function start() {
  // The released script and the Canary may both be installed and switched on. Only the one
  // that starts first runs: two would answer every settings request from two different
  // stores. The other leaves its mark for the settings page, which asks for one to go.
  if (injected()) {
    document.documentElement.setAttribute(ALSO_RUNNING, CHANNEL);
    return;
  }
  if (manager) serveStorage();
  // The page code reads this mark once, when it starts, to know whether its settings go
  // through the manager ("live": the manager also reports other tabs' changes).
  if (manager) document.documentElement.setAttribute(STORAGE_MARK, managerReportsChanges ? "manager live" : "manager");
  const described = describeManager();
  if (described) document.documentElement.setAttribute(MANAGER_MARK, described);
  if (pageWindow === window) pageCode();
  else inject();
}

if (document.documentElement) start();
else {
  const observer = new MutationObserver(() => {
    if (!document.documentElement) return;
    observer.disconnect();
    start();
  });
  observer.observe(document, { childList: true });
}

// The script runs in bilibili's iframes too; the manager menu entry stays one per tab.
let topLevelFrame = true;
try { topLevelFrame = window.self === window.top; } catch (_error) {}
if (typeof GM_registerMenuCommand === "function" && topLevelFrame) {
  GM_registerMenuCommand(CHANNEL === "canary" ? "线程撕裂者 Canary 设置" : "线程撕裂者设置", () => document.dispatchEvent(new CustomEvent("btr-userscript-open-settings")));
}
})();
