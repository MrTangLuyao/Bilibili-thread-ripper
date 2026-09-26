// ==UserScript==
// @name         Bilibili 线程撕裂者
// @namespace    https://github.com/MrTangLuyao/Bilibili-thread-ripper
// @version      2026.9.27.1
// @description  保留哔哩哔哩原生播放器，通过多 CDN、多 Range 并发下载改善视频缓冲速度。
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
if (window.top !== window && !/^live\.bilibili\.com$/i.test(location.hostname)) return;
if (document.documentElement?.hasAttribute("data-btr-userscript")) return;
document.documentElement?.setAttribute("data-btr-userscript", "");

/* user_scripts/adapter/storage-shim.js */
// This small stand-in keeps the parts of the chrome.* API that bridge.js uses: storage,
// and runtime.lastError for its callbacks.
//
// The settings live in the script manager's storage, which every bilibili subdomain shares.
// Only the manager's side of the script (loader.js) can reach it, so this page code asks it
// with events. loader.js marks the page when it answers them; without that mark, or when it
// does not answer, the settings stay in this site's localStorage as before, which is kept per
// subdomain. Changes made in another tab arrive from the manager, or, where the manager does
// not report them, are read again when this tab comes back into view.
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
  // A manager that marked the page but never answers must not keep the settings from loading.
  const load = (area) => {
    loads[area] ||= (backend === managerBackend
      ? Promise.race([backend.load(area), new Promise((_resolve, reject) => setTimeout(() => reject(new Error("no answer")), 3000))])
        .catch(() => { backend = localBackend; return backend.load(area); })
      : backend.load(area)).then((value) => { cache[area] = value; return value; });
    return loads[area];
  };
  // What the storage now holds after a change, from this tab or from another one.
  const settle = (area, value) => {
    const before = cache[area] || {};
    cache[area] = value;
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
      // The live module on live.bilibili.com; the master switch above still rules.
      liveEnabled: source.liveEnabled !== false,
      // "full" replaces Bilibili's playback core; "compat" leaves it in charge and only
      // downloads its media requests.
      takeover: source.takeover === "compat" ? "compat" : "full",
      mode: ["overseas", "custom"].includes(source.mode) ? source.mode : "mainland",
      customHosts: (Array.isArray(source.customHosts) ? source.customHosts : [])
        .map(normalizeCdnHost)
        .filter((host, index, all) => host && all.indexOf(host) === index)
        .slice(0, 32),
      // The round button in the page corner that opens the settings panel, and where the
      // viewer dragged it: which side, and how far down as a share of the window height.
      floatingButton: source.floatingButton !== false,
      // Where the viewer dragged it, as shares of the window (0 = flush left, 1 = flush
      // right); null when it was never moved.
      floatingButtonLeft: source.floatingButtonLeft != null && Number(source.floatingButtonLeft) >= 0 && Number(source.floatingButtonLeft) <= 1 ? Number(source.floatingButtonLeft) : null,
      floatingButtonTop: source.floatingButtonTop != null && Number(source.floatingButtonTop) >= 0 && Number(source.floatingButtonTop) <= 1 ? Number(source.floatingButtonTop) : null,
      debugNotices: source.debugNotices === true,
      errorNotices: source.errorNotices === true,
      debugCategories: Object.fromEntries(["takeover", "playback", "download", "buffer", "settings", "other"].map(key => [key, source.debugCategories?.[key] !== false])),
      concurrency: allowed.includes(requested) ? requested : 8,
      // 自动线程数: the downloader picks the thread count itself, between 8 and 32, and
      // `concurrency` above is only what the viewer set by hand. Off unless asked for.
      autoConcurrency: source.autoConcurrency === true,
      minChunkBytes: 64 * 1024,
      firstByteTimeoutMs: 5500,
      stallTimeoutMs: 4000,
      attemptTimeoutMs: 15000,
      hedgeDelayMs: 900,
      bufferAheadSeconds: 45
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
    "upos-sz-mirrorcos.bilivideo.com"
  ]);

  const OVERSEAS_HOSTS = Object.freeze([
    "upos-sz-mirrorcosov.bilivideo.com",
    "upos-sz-mirroraliov.bilivideo.com",
    "cn-hk-eq-01-01.bilivideo.com",
    "cn-hk-eq-01-03.bilivideo.com"
  ]);

  const GLOBAL_HOSTS = Object.freeze([
    ...OVERSEAS_HOSTS,
    ...MAINLAND_HOSTS
  ]);

  function isAkamaiUrl(value) {
    try { return new URL(value).hostname.toLowerCase().endsWith(".akamaized.net"); }
    catch (_error) { return false; }
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
      // Assigning url.host alone keeps a non-standard port, such as a peer CDN's :4483.
      url.hostname = host;
      url.port = "";
      return url.href;
    } catch (_error) {
      return null;
    }
  }

  // The custom mode uses only the servers picked in the settings. Without any, it works like
  // the mainland mode.
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
    const donor = originals.find((url) => !isAkamaiUrl(url));
    // Some overseas accounts are given nothing but akamaized.net addresses. That used to leave
    // no node at all in mainland mode and a single one in overseas mode. The nodes accept
    // those signatures too, so only in that case the akamaized.net addresses are the donors.
    // Bilibili may hand out an address that every node refuses (HTTP 403) next to one that
    // works, so each of them is tried; the ban list drops the refused one. Node-major order
    // keeps the first requests spread over several nodes.
    const synthetic = (donor
      ? hosts.map((host) => swapOrdinaryHost(donor, host))
      : hosts.flatMap((host) => originals.map((url) => swapOrdinaryHost(url, host, true))))
      .map(safeMediaUrl)
      .filter(Boolean);
    const allowedOriginals = custom.length
      ? originals.filter((url) => custom.includes(hostOf(url)))
      : mode === "overseas"
        ? originals.filter((url) => !MAINLAND_HOSTS.includes(hostOf(url)))
        : originals.filter((url) => MAINLAND_HOSTS.includes(hostOf(url)));
    return [...allowedOriginals, ...synthetic].filter((value, index, all) => all.indexOf(value) === index);
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

    // Banned nodes are left out. If every node is banned, keep using them rather
    // than leaving the video with no download address at all.
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
    GLOBAL_HOSTS,
    MAINLAND_HOSTS,
    OVERSEAS_HOSTS,
    createBanList,
    createResolver,
    isAkamaiUrl,
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
        this.onChange?.(this.active, this.limit, this.queue.length);
      });
    }
  }

  // 自动线程数. One controller for the whole page: the thread count starts at 8 and climbs a
  // ladder towards 32 on every sign that the download is not keeping up with playback
  // (the player stalls; a low buffer stops growing while bytes keep arriving; a
  // connection waits too long for its first byte while every slot is busy). Every step up
  // is a trial: ten seconds later the bytes per second must have grown, otherwise the
  // step is taken back to where it started and that level rests for a while — more
  // connections that bring nothing only add risk. A server refusing the load (412, 429)
  // steps it back too, and nothing climbs past a refused level until it has rested. The
  // level is kept across videos on the same page; a new page starts at 8 again.
  const AUTO_LADDER = Object.freeze([8, 12, 16, 24, 32]);
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
      aheadSamples: [], pressureSince: 0
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
      return true;
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
      // A new playback session: what the buffer did before means nothing now.
      newSession() {
        state.aheadSamples.length = 0;
        state.pressureSince = 0;
        state.trial = null;
        state.buckets.length = 0;
        state.saturatedSpans.length = 0;
        if (state.saturated) state.saturatedSince = now();
      },
      status() {
        const at = now();
        return {
          threads: threads(), level: state.level, reason: state.reason, steps: state.steps, changedAt: state.changedAt,
          throughputBps: Math.round(throughput(at)), saturation: Math.round(saturation(at) * 100) / 100,
          buckets: state.buckets.length, activityAgeMs: Math.round(at - state.lastActivityAt),
          resting: [...state.resting.entries()].filter(([, rest]) => rest.until > at).map(([level, rest]) => ({ threads: AUTO_LADDER[level], hard: rest.hard, forMs: Math.round(rest.until - at) })),
          trial: state.trial ? { from: AUTO_LADDER[state.trial.from], level: AUTO_LADDER[state.trial.level], ageMs: Math.round(at - state.trial.at), baselineBps: Math.round(state.trial.baseline), stalled: state.trial.stalled } : null
        };
      },
      reset() {
        state.level = 0; state.changedAt = 0; state.reason = "起步"; state.steps = 0; state.trial = null;
        state.resting.clear(); state.buckets.length = 0; state.lastActivityAt = -Infinity;
        state.saturated = false; state.saturatedSince = 0; state.saturatedSpans.length = 0;
        state.aheadSamples.length = 0; state.pressureSince = 0;
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
    // The page replaces its settings object when something changes, so the reference
    // tells whether the previous normalization is still valid.
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
    // - The copy's node known to be clearly faster: copy.
    // - Slower than connections usually are: copy.
    // - On pace: a copy on a node known to be no faster only takes the next piece's connection
    //   and bandwidth; one on a node not measured yet is tried, as the chance of a faster one.
    //   A piece that will miss its deadline even so may spend one of the range's rescue slots
    //   on that node anyway: its measurement can be stale (a node that was slow a minute ago
    //   may have recovered), and waiting for the request to time out costs far more.
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
    // budget is for pieces that will miss their deadline while their copy's node is measured
    // as no faster: that measurement can be stale, and a bounded number of such copies per
    // range is far cheaper than waiting for a timeout.
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
          await pause(Math.min(2000, 500 * (2 ** (round - 1))), signal);
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
            // two consecutive deficit samples may spend the same one-per-range budget.
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
              // keeps main's delay from the moment the piece asked, queue time included.
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
          await pause(Math.min(2000, 500 * (2 ** (round - 1))), options.signal);
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
      const ordered = new Array(pieces.length);
      let nextOrderedIndex = 0;
      let flushOperation = Promise.resolve();
      const flushOrdered = () => {
        flushOperation = flushOperation.then(async () => {
          while (ordered[nextOrderedIndex]) {
            const item = ordered[nextOrderedIndex];
            ordered[nextOrderedIndex] = null;
            await options.onOrderedChunk(item.bytes, pieces[nextOrderedIndex], item.total);
            nextOrderedIndex += 1;
          }
        });
        return flushOperation;
      };
      // The probe measured at least its own winner, so the pieces spread over the nodes by
      // speed at once; the proven address stays each piece's first fallback. Only addresses
      // that have delivered carry the first segment: a node whose probe never finished would
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
        ordered[orderedIndex] = result;
        await flushOrdered();
        return result;
      });
      options.onStartupScheduled?.();
      const results = await Promise.all(pendingPieces);
      await flushOperation;
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
      const ordered = new Array(pieces.length);
      let nextOrderedIndex = 0;
      let flushOperation = Promise.resolve();
      const flushOrdered = () => {
        flushOperation = flushOperation.then(async () => {
          while (ordered[nextOrderedIndex]) {
            const item = ordered[nextOrderedIndex];
            ordered[nextOrderedIndex] = null;
            await options.onOrderedChunk(item.bytes, pieces[nextOrderedIndex], item.total);
            nextOrderedIndex += 1;
          }
        });
        return flushOperation;
      };
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
        if (progressive) {
          ordered[piece.index] = result;
          await flushOrdered();
        }
        return result;
      }));
      if (progressive) await flushOperation;
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
  const STARTUP_PROTECTION_MS = 20000;
  // When the browser's buffer quota is hit: the forward buffer is never brought below the
  // floor, and a full buffer with less than this ahead is a failure, not something to wait out.
  const QUOTA_AHEAD_FLOOR_SECONDS = 8;
  const QUOTA_FATAL_AHEAD_SECONDS = 10;
  // A video whose buffer stays full through this many waits is given up after all.
  const QUOTA_MAX_WAITS = 8;

  function playbackDeadlineAt(segmentStart, currentTime, playbackRate, now = performance.now()) {
    const rate = Math.max(0.25, Math.abs(Number(playbackRate) || 1));
    return now + Math.max(0, (Number(segmentStart) - Number(currentTime)) * 1000 / rate);
  }

  // Bilibili's core keeps the position it saved when it last reloaded its own source (a
  // quality switch, or the retry it makes once BTR replaced the source) and seeks back to
  // it every time the element reports new metadata, until the video ends or the page
  // moves on. Every BTR session starts with new metadata, so after one such reload every
  // drag of the progress bar and every quality switch ended up back at that old position.
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

  function dashData(playinfo) {
    return dashBody(playinfo)?.dash || null;
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

  // preferredQuality is the quality chosen in the native menu; 0 is "auto" and keeps the
  // quality the playinfo itself asks for. preferredCodec is the codec chosen there, "" for
  // "默认". preferredAudio is the audio chosen there (see normalizeAudio).
  function selectRepresentations(playinfo, preferredQuality = 0, preferredCodec = "", preferredAudio = 0) {
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
    const preferred = [Number(preferredQuality) || 0, requestedQuality]
      .map((quality) => quality && videos.find((item) => Number(item.id) === quality))
      .find(Boolean)
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
  const codecFailures = { blocked: 0, last: "" };
  let codecFailureGuardInstalled = false;
  function installCodecFailureGuard() {
    const storage = root.Storage?.prototype;
    if (codecFailureGuardInstalled || typeof storage?.setItem !== "function") return;
    codecFailureGuardInstalled = true;
    const setItem = storage.setItem;
    storage.setItem = function (key, value) {
      if (CODEC_FAILURE_KEYS.has(String(key)) && document.querySelector('[data-btr-mse-active="true"]')) {
        codecFailures.blocked += 1;
        codecFailures.last = String(key);
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
    let selection = selectRepresentations(currentPlayinfo, preferredQuality, preferredCodec, preferredAudio);
    let selectedVideo = selection.preferred;
    // The two representation objects the running session downloads from. Its resolvers keep
    // reading them, so fresh addresses always go into these two and never into a newer
    // selection's copies.
    let selectedAudio = selection.audio;
    let sessionStarts = 0;
    let sessionRequests = 0;
    let session = null;
    let destroyed = false;
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
    // The initialization segment and the index of a representation never change, and a seek
    // outside the buffer starts a new session for the same one. Asking for them again cost
    // every such seek a round trip to the CDN before any media could be requested.
    const trackHeaders = new Map();
    const timeline = [];
    function note(what, detail = "") {
      timeline.push({ at: Math.round(performance.now()), time: Math.round((Number(video.currentTime) || 0) * 10) / 10, what, detail: String(detail) });
      if (timeline.length > 120) timeline.shift();
    }
    const eventController = new AbortController();
    const sourceObserver = new MutationObserver(() => {
      const candidate = session;
      if (destroyed || !candidate || candidate.disposed || video.src === candidate.objectUrl) return;
      if (candidate.externalSourceDetected) return;
      candidate.externalSourceDetected = true;
      rememberNativeRestore(restoreKey, video.currentTime);
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
          // Chromium), which a 4K video reaches within the 45 second window. Freeing
          // played data and asking for less ahead keeps the video playing; failing the
          // append here would hand the whole video back to Bilibili.
          if (error?.name !== "QuotaExceededError") throw error;
          const current = Number(video.currentTime) || 0;
          const ahead = Math.max(0, bufferedEndAt(track.sourceBuffer, current) - current);
          candidate.bufferAheadLimit = Math.max(QUOTA_AHEAD_FLOOR_SECONDS, Math.min(candidate.bufferAheadLimit || Infinity, ahead * 0.75));
          note("buffer quota hit", `${track.kind} keeps ${candidate.bufferAheadLimit.toFixed(0)}s ahead`);
          options.onLog?.("浏览器缓冲区满了", `已释放播放过的数据，这个视频接下来最多提前缓冲 ${candidate.bufferAheadLimit.toFixed(0)} 秒。`, "info", "buffer");
          const behindEnd = Math.max(0, current - 5);
          if (behindEnd > 0 && bufferedStart(track.sourceBuffer, behindEnd) < behindEnd) {
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

    function removeRange(candidate, track, start, end) {
      if (end <= start || candidate.mediaSource.readyState !== "open") return Promise.resolve();
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
        options.onLog?.("已经确认数据的下载位置", `找到了 ${parsed.segments.length} 段${kind === "audio" ? "声音" : "画面"}数据。`, "success", "download");
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
      const deadlineAt = Number.isFinite(Number(downloadOptions.deadlineAt))
        ? Number(downloadOptions.deadlineAt)
        : () => playbackDeadlineAt(segment.startTime, Number(video.currentTime) || candidate.startTime, video.playbackRate);
      return downloader.downloadRange(segment, track.resolver, {
        signal: generationSignal(candidate),
        parallel: true,
        kind: track.kind,
        priority: downloadOptions.priority,
        hurry: downloadOptions.hurry === true,
        deadlineAt,
        startup: downloadOptions.startup === true,
        onStartupScheduled: downloadOptions.onStartupScheduled,
        onOrderedChunk: downloadOptions.onOrderedChunk || null
      }).then(
        (result) => ({ index, result }),
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
          priority: 70,
          hurry: true
        }));
      }
      ensureBuffer(candidate);
    }

    // How far ahead this session may buffer: the setting, brought down each time the
    // browser's own buffer quota was hit.
    function aheadTarget(candidate) {
      return Math.min(core.normalizeSettings(getSettings()).bufferAheadSeconds, candidate.bufferAheadLimit || Infinity);
    }

    // The buffer a start or a recovery waits for must be one the tracks can still reach: with
    // the limit brought down to eight seconds, waiting for ten would never end.
    function reachableSeconds(candidate, seconds) {
      return Math.min(seconds, Math.max(0.5, aheadTarget(candidate) - 2));
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
          if (track.nextIndex >= track.sidx.segments.length) {
            track.complete = true;
            break;
          }
          if (bufferedEndAt(track.sourceBuffer, current) - current >= aheadTarget(candidate)) break;
          // A sliding window: the next segment starts as soon as one has been appended. Waiting
          // for a whole batch left the connections idle until its slowest segment arrived.
          const windowSize = track.started ? (track.kind === "video" ? 3 : 4) : 1;
          let projectedEnd = bufferedEndAt(track.sourceBuffer, current);
          for (let offset = 0; offset < windowSize; offset += 1) {
            const index = track.nextIndex + offset;
            const segment = track.sidx.segments[index];
            if (!segment || projectedEnd - current >= aheadTarget(candidate)) break;
            projectedEnd = segment.endTime;
            if (track.prefetches.has(index) || track.held?.index === index) continue;
            const startup = !track.startupComplete && index === track.startupIndex;
            track.prefetches.set(index, segmentDownload(candidate, track, segment, index, {
              priority: startup ? 120 : Math.max(30, 55 - offset * 5),
              // With under ten seconds buffered a late segment is a stall, so the downloader
              // spreads its pieces and copies a slow one sooner.
              hurry: segment.startTime - current < 10,
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
          if (!track.held) track.prefetches.delete(settled.index);
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
          if (candidate.endAttempts === 40) options.onLog?.("视频结尾没能正常收尾", `结束媒体流一直失败，播放器可能停在结尾。\n原因：${String(error?.message || error).slice(0, 160)}`, "error", "playback");
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
    // said goes to the Debug log instead of being lost.
    let reportedNativeError = "";
    function clearNativeErrorOverlay() {
      for (const node of options.container.querySelectorAll(".bpx-player-error-wrap,.bpx-player-error-panel")) {
        const text = String(node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
        if (!text || text === reportedNativeError) continue;
        reportedNativeError = text;
        options.onLog?.("B 站原生播放器报错", `线程撕裂者接管时，B 站自己的播放内核不再下载视频，这类报错通常可以忽略。\n原文：${text}`, "info", "playback");
      }
    }

    function attemptAutoplay(candidate) {
      if (candidate.playAttempted || !candidate.resumeWanted || !sessionIsCurrent(candidate)) return;
      candidate.playAttempted = true;
      video.play().then(clearNativeErrorOverlay).catch(() => {});
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
      if (seekStartedAt) {
        lastSeekMs = performance.now() - seekStartedAt;
        seekStartedAt = 0;
        seekSettledAt = performance.now();
        stallsAfterSeek = 0;
        options.onLog?.("跳转后的数据准备好了", `从点击进度条到可以继续播放用了 ${Math.round(lastSeekMs)} 毫秒。`, "success", "buffer");
      }
      options.onLog?.("开播需要的缓冲已经够了", `从 ${target.toFixed(2)} 秒开始播放，这次需要先缓冲 ${required.toFixed(1)} 秒。`, "success", "buffer");
      candidate.playbackActivatedAt = performance.now();
      if (target - (Number(video.currentTime) || 0) > 0.05) setCurrentTimeInternal(candidate, target);
      video.volume = candidate.volume;
      video.muted = candidate.muted;
      video.playbackRate = candidate.playbackRate;
      clearNativeErrorOverlay();
      attemptAutoplay(candidate);
    }

    function ensureBuffer(candidate = session) {
      if (!candidate || !sessionIsCurrent(candidate) || candidate.fatal || !candidate.tracks.length) return;
      for (const track of candidate.tracks) fillTrack(candidate, track);
      activateWhenReady(candidate);
      const current = Number(video.currentTime) || candidate.startTime;
      const ready = candidate.tracks.every((track) => isBufferedAt(track.sourceBuffer, current));
      const ahead = ready ? Math.max(0, Math.min(...candidate.tracks.map((track) => bufferedEndAt(track.sourceBuffer, current))) - current) : 0;
      if (candidate.recovering && ready) {
        const remaining = Math.max(0.5, (Number(candidate.mediaSource.duration) || current + candidate.recoveryTargetSeconds) - current);
        if (ahead >= Math.min(reachableSeconds(candidate, candidate.recoveryTargetSeconds), remaining)) {
          candidate.recovering = false;
          // A seek inside the session waits here instead of in activateWhenReady, so this is
          // where the panel's "how long did the jump take" is measured.
          if (candidate.seekPending) {
            candidate.seekPending = false;
            if (seekStartedAt) {
              lastSeekMs = performance.now() - seekStartedAt;
              seekStartedAt = 0;
              seekSettledAt = performance.now();
              stallsAfterSeek = 0;
              options.onLog?.("跳转后的数据准备好了", `从点击进度条到可以继续播放用了 ${Math.round(lastSeekMs)} 毫秒。`, "success", "buffer");
            }
          }
          options.onLog?.("缓冲补好了，可以继续播放", `已经备好接下来 ${ahead.toFixed(1)} 秒的数据。`, "success", "buffer");
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
      if (detach && video.src === candidate.objectUrl) {
        video.pause();
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
      options.onLog?.("正在准备播放器", `使用 ${qualityLabel(representation)} 清晰度，从 ${Number(playbackState.time || 0).toFixed(2)} 秒开始。`, "info", "takeover");
      const previous = session;
      // Read once: selection can be replaced by a new playinfo while this session starts.
      const audio = selection.audio;
      selectedVideo = representation;
      selectedAudio = audio;
      sessionStarts += 1;
      note("session", `${qualityLabel(representation)} ${codecFamily(representation)} from ${Number(playbackState.time || 0).toFixed(1)}`);
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
        progressiveAppends: 0,
        startupTargetSeconds: 6, startupThroughputBps: 0, mediaBytesPerSecond: 0,
        startupWaitingEvents: 0, resumeWanted: playbackState.resume,
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
      video.pause();
      video.src = objectUrl;
      video.load();
      video.volume = candidate.volume;
      video.muted = candidate.muted;
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
      for (const track of candidate.tracks) {
        // Queued, so it runs after whatever write is in progress and before the new
        // position's first one: the parser forgets any half-written segment.
        queuedSourceOperation(candidate, track, async () => {
          if (candidate.mediaSource.readyState === "open") track.sourceBuffer.abort();
        }).catch(() => {});
        track.prefetches.clear();
        track.held = null;
        track.complete = false;
        track.started = false;
        track.nextIndex = track.startupIndex = sidxTools.segmentIndexAt(track.sidx.segments, target);
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
        video.pause();
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
        options.onLog?.("你跳到的位置已经有缓冲", `可以直接从 ${target.toFixed(2)} 秒继续播放。`, "success", "buffer");
        ensureBuffer(candidate);
        return;
      }
      seekReloads += 1;
      seekStartedAt = seekRequestedAt || performance.now();
      note("seek outside the buffer", target.toFixed(1));
      options.onLog?.("你跳到的位置还需要加载", `正在为 ${target.toFixed(2)} 秒的位置重新准备数据。`, "info", "buffer");
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
        options.onLog?.("挡住了 B 站播放器的回跳", `B 站的播放内核想跳回 ${target.toFixed(1)} 秒，保持在你选的 ${candidate.startTime.toFixed(1)} 秒。`, "info", "buffer");
        setCurrentTimeInternal(candidate, candidate.startTime);
        // Its restore also plays or pauses as things were back then; the viewer's intent wins.
        if (!candidate.resumeWanted && !video.paused) video.pause();
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
        downloaderFactory.autoConcurrency?.buffer(ahead, !video.paused && !video.seeking);
      }
    }, { signal: eventController.signal });
    video.addEventListener("waiting", () => {
      const candidate = session;
      note("waiting", candidate?.playbackActivated ? "after start" : "before start");
      if (candidate && sessionIsCurrent(candidate) && candidate.playbackActivated) {
        candidate.startupWaitingEvents += 1;
        if (!video.seeking && !video.paused && core.normalizeSettings(getSettings()).autoConcurrency) downloaderFactory.autoConcurrency?.stall("播放卡了一下");
        if (seekSettledAt && performance.now() - seekSettledAt < 15000 && !video.seeking) stallsAfterSeek += 1;
        if (performance.now() - candidate.playbackActivatedAt <= STARTUP_PROTECTION_MS && !candidate.recovering && !video.seeking) {
          candidate.recovering = true;
          candidate.resumeWanted = true;
          candidate.playAttempted = false;
          candidate.recoveryTargetSeconds = Math.min(STARTUP_BUFFER_MAX_SECONDS, Math.max(STARTUP_RECOVERY_SECONDS, candidate.startupTargetSeconds + 2));
          video.pause();
        }
        ensureBuffer(candidate);
      }
    }, { signal: eventController.signal });
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
      if (candidate && sessionIsCurrent(candidate) && (!candidate.playbackActivated || candidate.recovering)) return Boolean(candidate.resumeWanted);
      return !video.paused;
    }

    function playbackState() {
      return {
        time: Number(video.currentTime) || 0,
        resume: wantsToPlay() || Number(video.currentTime) < 1,
        volume: video.volume,
        muted: video.muted,
        playbackRate: video.playbackRate || 1
      };
    }

    // A refreshed playinfo names the same files with fresh signatures. The resolvers of a
    // running session keep reading their representation objects, so those objects receive
    // the new addresses; nothing else about the session changes.
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

    async function updatePlayinfo(playinfo) {
      if (destroyed) return;
      const next = selectRepresentations(playinfo, preferredQuality, preferredCodec, preferredAudio);
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

    // The same for the codec picked in the 播放策略 menu.
    async function setCodec(codec) {
      const wanted = normalizeCodec(codec);
      if (destroyed || wanted === preferredCodec) return;
      preferredCodec = wanted;
      await updatePlayinfo(currentPlayinfo);
    }

    function destroy({ resumeNative = true } = {}) {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(seekTimer);
      eventController.abort();
      sourceObserver.disconnect();
      const state = playbackState();
      if (session) disposeSession(session, true);
      delete video.dataset.btrMediaEngine;
      delete options.container.dataset.btrMseActive;
      if (resumeNative && original.src) {
        // Bilibili's core reloads from here and remembers this position (see nativeRestore).
        rememberNativeRestore(restoreKey, state.time || original.currentTime);
        video.src = original.src;
        video.volume = original.volume;
        video.muted = original.muted;
        video.playbackRate = original.playbackRate;
        video.load();
        try { video.currentTime = state.time || original.currentTime; } catch (_error) {}
        if (!state.resume && original.wasPaused) return;
        video.play().catch(() => {});
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
        [data-btr-mse-active="true"] .bpx-player-error-panel{display:none!important}
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
      destroy,
      setCodec,
      setQuality,
      updatePlayinfo,
      urlDeadlineSeconds,
      video,
      getDebug: () => ({
        version: "2026.9.27.1",
        architecture: "bilibili-native-ui-progressive-mse-0.8-core",
        quality: qualityLabel(selectedVideo),
        qualityId: Number(selectedVideo?.id) || 0,
        preferredQuality,
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
        audioBandwidth: Number(selection.audio?.bandwidth) || 0,
        currentTime: Number(video.currentTime) || 0,
        mediaSourceState: session?.mediaSource?.readyState || "closed",
        playbackActivated: Boolean(session?.playbackActivated),
        resumeWanted: Boolean(session?.resumeWanted),
        sessionStartTime: session?.startTime || 0,
        startupBufferSeconds: session?.startupTargetSeconds || 0,
        startupWaitingEvents: session?.startupWaitingEvents || 0,
        bufferAheadLimit: session?.bufferAheadLimit || 0,
        urlDeadline: urlDeadlineSeconds(),
        // Errors from Bilibili's idle core that were kept out of the page's console.
        nativeLeftoversSuppressed: nativeLeftovers.suppressed,
        lastNativeLeftover: nativeLeftovers.last,
        progressiveAppends: session?.progressiveAppends || 0,
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
    let received = 0, total = null;
    const chunks = [];
    try {
      const result = await owner.downloader.downloadRange(range, owner.resolver(plan.url, track), {
        signal: controller.signal, parallel: true, startup: true, kind: track.kind,
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
      owner.delivered(track, result);
      return { bytes, headers: new Headers({
        "Content-Type": track.representation.mimeType || track.representation.mime_type || `${track.kind}/mp4`,
        "Content-Length": String(range.length), "Content-Range": `bytes ${range.start}-${range.end}/${total}`,
        "Accept-Ranges": "bytes"
      }) };
    } catch (error) {
      if (!controller.signal.aborted && !owner.disposed) owner.failed(error);
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      controller.abort();
      signal?.removeEventListener("abort", cancel);
      owner.jobs.delete(controller);
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
    const note = (what, detail = "") => {
      timeline.push({ at: Math.round(performance.now()), time: Number(video.currentTime) || 0, what, detail });
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
    function unavailable(error) {
      if (owner.disposed) return;
      owner.destroy();
      lastError = `原生播放器接口发生变化，已停止加速：${error?.message || error}`;
      note("native quality guard unavailable", lastError);
      options.onLog?.("已交回 B 站原生播放", lastError, "error", "playback");
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
      const rendered = tracks.find(track => track.kind === "video" && Number(track.representation.id) === Number(qualityState.split("/")[0]))?.representation;
      options.onState?.({ playerState: video.error ? "error" : video.ended ? "ended" : video.readyState >= 3 ? "ready" : "buffering",
        lastError: video.error ? video.error.message || `媒体错误 ${video.error.code}` : lastError,
        mode: settings().mode, quality: rendered ? root.__BILI_NATIVE_MSE_PLAYER_FACTORY__?.qualityLabel?.(rendered) || String(rendered.id) : "原生画质",
        bufferedAhead: bufferedAhead(), cdnHosts: [...cache.values()].flatMap(resolver => resolver.status()) });
    };
    function bufferedAhead() {
      const time = Number(video.currentTime) || 0;
      for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= time && video.buffered.end(i) > time) return video.buffered.end(i) - time;
      return 0;
    }
    const owner = {
      disposed: false, jobs, settings, sampleQuality,
      track: url => tracks.find(track => urls(track.representation).some(candidate => pathOf(candidate) === pathOf(url))) || null,
      resolver(url, track) {
        const parsed = new URL(url), key = parsed.pathname + parsed.search;
        if (!cache.has(key)) {
          if (cache.size >= 64) cache.delete(cache.keys().next().value);
          cache.set(key, resolvers.createResolver({ ...track.representation, baseUrl: url, base_url: url }, () => settings().mode, options.cdnBans, () => settings().customHosts));
        }
        return cache.get(key);
      },
      delivered(track, result) {
        if (owner.disposed) return;
        if (track.kind === "video") lastVideo = track.representation;
        else lastAudio = track.representation;
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
      failed(error) {
        failures++;
        lastError = String(error?.message || error);
        note("native range failed", lastError);
        options.onLog?.("媒体分段下载失败", lastError, "error", "download");
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
    owner.downloader = downloaders.createDownloader({ getSettings: settings, nativeFetch, onTransfer: options.onTransfer });
    const events = new AbortController();
    for (const name of ["playing", "waiting", "stalled", "seeking", "seeked", "ended", "loadedmetadata", "error", "progress", "timeupdate"]) video.addEventListener(name, () => {
      if (name !== "timeupdate" && name !== "progress") note(`media ${name}`, `buffer ${bufferedAhead().toFixed(2)}s`);
      if (name === "error") options.onLog?.("B 站播放器出错了", video.error?.message || `媒体错误 ${video.error?.code}`, "error", "playback");
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
        acceleratedRanges: delivered, failedRanges: failures, nativeSwitchRequests,
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

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const EVENT_NAMES = ["playing", "pause", "waiting", "stalled", "seeking", "seeked", "ended", "error", "emptied", "loadedmetadata", "canplay", "ratechange"];
  const EVENT_LABELS = { playing: "视频开始播放了", pause: "视频已暂停", waiting: "正在缓冲，请稍等", stalled: "暂时没收到视频数据，还在等待", seeking: "正在跳到你选择的位置", seeked: "已经跳到你选择的位置", ended: "视频播放完了", error: "视频播放出错了", emptied: "旧视频已清空，准备加载新视频", loadedmetadata: "已经读到视频信息", canplay: "视频已经可以播放了", ratechange: "播放速度已改变" };
  let settings = {};
  let attachment = null;
  let controller = null;
  let heartbeat = null;
  let flushTimer = null;
  let sequence = 0;
  let lastTime = 0;
  let lastProgress = -Infinity;
  let lastReportedPlaying = null;
  const pending = new Map();

  function post(type, payload) {
    root.postMessage({ channel: CHANNEL, type, payload }, "*");
  }

  // Signed media URLs and tokens are not useful in an on-screen log.
  function clean(value) {
    return String(value ?? "").replace(/https?:\/\/[^\s]+/gi, (url) => {
      try { return new URL(url).hostname; } catch (_error) { return "[URL]"; }
    }).replace(/[\u00b7\u2022\u2027\u2219\u22c5]+/g, "，").slice(0, 320);
  }

  function flush() {
    flushTimer = null;
    const entries = Array.from(pending.values()).filter(entry => allowed(entry.level, entry.category));
    if (entries.length) post("debug-notices", entries);
    pending.clear();
  }

  function allowed(level, category = "other") {
    return settings.enabled && (level === "error" ? settings.errorNotices : settings.debugNotices && settings.debugCategories?.[category] !== false);
  }

  function log(title, detail = "", level = "info", group = "", route = attachment?.route || "", category = "other") {
    category = ["takeover", "playback", "download", "buffer", "settings", "other"].includes(category) ? category : "other";
    if (!allowed(level, category)) return;
    // Coalesce high-frequency events before publishing a snapshot. The view
    // always creates a new bubble and never edits an already visible message.
    const key = group ? `${route}:${category}:${group}` : `event-${++sequence}`;
    const previous = pending.get(key);
    const entry = { key, title: clean(title), detail: clean(detail), route: clean(route), category, level: ["success", "error"].includes(level) ? level : "info", at: Date.now(), count: (previous?.count || 0) + 1 };
    pending.delete(key);
    pending.set(key, entry);
    if (pending.size > 48) {
      const ordinary = [...pending].find(([, item]) => item.level !== "error");
      pending.delete(ordinary ? ordinary[0] : pending.keys().next().value);
    }
    if (!flushTimer) flushTimer = setTimeout(flush, 180);
  }

  function current() {
    return attachment && attachment.video?.isConnected && attachment.isCurrent();
  }

  function sample(force = false) {
    if (!allowed("info", "playback")) return;
    const video = attachment?.video;
    const valid = Boolean(current());
    const now = performance.now();
    const time = Number(video?.currentTime) || 0;
    if (valid && !video.paused && !video.seeking && !video.ended && time > lastTime + 0.001) lastProgress = now;
    lastTime = time;
    const playing = valid && !video.paused && !video.ended && !video.seeking && !video.error && video.readyState >= 2 && now - lastProgress < 1800;
    if (force || playing !== lastReportedPlaying) {
      if (valid && playing !== lastReportedPlaying) log(playing ? "画面正在正常播放" : "加速已接管，正在等视频播放", `当前播放到 ${time.toFixed(2)} 秒。`, playing ? "success" : "info", "", attachment?.route || "", "playback");
      lastReportedPlaying = playing;
    }
    // Heartbeats let the isolated UI expire status if the page hook disappears.
    post("playback-notice", { attached: valid, playing, route: valid ? attachment.route : "", session: attachment?.session || 0 });
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
    if (!settings.enabled || !(settings.debugNotices || settings.errorNotices) || !attachment) return;
    const captured = attachment;
    const video = captured.video;
    controller = new AbortController();
    lastTime = Number(video.currentTime) || 0;
    for (const name of EVENT_NAMES) {
      const category = ["waiting", "stalled", "seeking", "seeked"].includes(name) ? "buffer" : "playback";
      if (!allowed(name === "error" ? "error" : "info", category)) continue;
      video.addEventListener(name, () => {
        if (attachment !== captured || !current()) return;
        if (name === "playing") lastProgress = performance.now();
        else if (["pause", "waiting", "stalled", "seeking", "ended", "error", "emptied"].includes(name)) {
          lastProgress = -Infinity;
          lastTime = Number(video.currentTime) || 0;
        }
        const errorReason = { 1: "视频加载被中断了", 2: "视频数据没能下载下来", 3: "浏览器没能解码这个视频", 4: "浏览器不支持这个视频格式" }[video.error?.code] || "播放器没有给出具体原因";
        const detail = `当前播放到 ${Number(video.currentTime).toFixed(2)} 秒。${name === "error" ? `\n${errorReason}。\n${video.error?.message || ""}` : ""}`;
        const level = name === "error" ? "error" : ["playing", "seeked", "ended", "loadedmetadata", "canplay"].includes(name) ? "success" : "info";
        log(EVENT_LABELS[name], detail, level, "", captured.route, category);
        sample(true);
      }, { signal: controller.signal });
    }
    if (allowed("info", "playback")) {
      video.addEventListener("timeupdate", () => sample(), { signal: controller.signal });
      heartbeat = setInterval(sample, 500);
      sample(true);
    }
  }

  root.__BTR_RUNTIME_NOTICES__ = Object.freeze({
    log,
    configure(next) {
      const changed = settings.enabled !== next.enabled || settings.debugNotices !== next.debugNotices || settings.errorNotices !== (next.errorNotices === true)
        || ["playback", "buffer"].some(category => (settings.debugCategories?.[category] !== false) !== (next.debugCategories?.[category] !== false));
      const wasDebug = settings.enabled && settings.debugNotices;
      settings = { enabled: next.enabled !== false, debugNotices: next.debugNotices === true, errorNotices: next.errorNotices === true, debugCategories: { ...next.debugCategories } };
      for (const [key, entry] of pending) if (!allowed(entry.level, entry.category)) pending.delete(key);
      if (!pending.size) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!wasDebug && settings.enabled && settings.debugNotices) log("调试提示已打开", "接下来会显示你勾选的运行消息。", "success", "", "", "settings");
      if (changed) watch();
    },
    attach(video, route, session, isCurrent) {
      attachment = { video, route, session, isCurrent };
      log("视频已接管", "继续使用 B 站播放器，由多线程下载加速。", "success", "", route, "takeover");
      watch();
    },
    detach(reason = "已停止接管这个视频") {
      if (attachment) log(reason, "", "info", "", attachment.route, "takeover");
      stopWatch();
      attachment = null;
      if (settings.debugNotices) post("playback-notice", { attached: false, playing: false, route: "", session: 0 });
    }
  });
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

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const HOST_ID = "__bilibili_thread_ripper_settings__";
  const DIALOG_ID = "__bilibili_thread_ripper_settings_dialog__";
  const LAUNCHER_ID = "__bilibili_thread_ripper_launcher__";
  const THREAD_OPTIONS = [4, 8, 16, 32, 64, 128];
  const MAX_CUSTOM_HOSTS = 32;
  const HOST_GROUPS = [["大陆节点", cdn.MAINLAND_HOSTS], ["海外节点", cdn.OVERSEAS_HOSTS]];
  const KNOWN_HOSTS = HOST_GROUPS.flatMap(([, hosts]) => hosts);

  const PANEL_HTML = `
    <main>
      <header>
        <div class="logo" aria-hidden="true">B</div>
        <h1>线程撕裂者</h1>
        <label class="switch" title="启用或停用">
          <input id="enabled" type="checkbox">
          <span></span>
        </label>
      </header>

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

      <section class="takeover-select" aria-label="接管方式">
        <label><input type="radio" name="takeover" value="full"><span>全接管</span></label>
        <label><input type="radio" name="takeover" value="compat"><span>兼容模式</span></label>
      </section>
      <p class="takeover-note">Safari 用户建议使用兼容模式。<br>全接管：视频由插件自己来放，下载和缓冲都由插件安排，速度最快。<br>兼容模式：当遇到播放问题或设置不生效时，尝试使用兼容模式。</p>

      <section class="controls">
        <div class="control-title">
          <label for="concurrency">线程加载数</label>
          <output id="thread-value" for="concurrency">8</output>
        </div>
        <div class="auto-row">
          <label for="auto-concurrency">自动线程数<small>BTR将智能选择需要的线程数。</small></label>
          <label class="switch"><input id="auto-concurrency" type="checkbox" aria-label="自动线程数"><span></span></label>
        </div>
        <div class="slider">
          <div id="slider-fill" class="slider-fill" aria-hidden="true"></div>
          <input id="concurrency" type="range" min="0" max="5" step="1" value="1" aria-label="线程加载数" aria-valuetext="8">
        </div>
        <div class="scale" aria-hidden="true">
          <span>4</span><span>8</span><span>16</span><span>32</span><span>64</span><span>128</span>
        </div>
      </section>

      <section class="notice-controls" aria-label="提示设置">
        <div class="notice-row"><label for="live-enabled">直播加速（实验性）</label><label class="switch"><input id="live-enabled" type="checkbox" aria-label="直播加速（实验性）"><span></span></label></div>
        <div class="notice-row"><label for="error-notices">显示错误</label><label class="switch"><input id="error-notices" type="checkbox" aria-label="显示错误"><span></span></label></div>
        <div class="notice-row"><label for="debug-notices">Debug 模式</label><label class="switch"><input id="debug-notices" type="checkbox" aria-label="Debug 模式"><span></span></label></div>
        <div class="notice-row"><label for="floating-button">悬浮按钮</label><label class="switch"><input id="floating-button" type="checkbox" aria-label="悬浮按钮"><span></span></label></div>
        <fieldset id="debug-filters" class="debug-filters" hidden>
          <legend>显示哪些 Debug 消息</legend>
          <div class="debug-filter-actions"><button id="debug-select-all" type="button">全选</button><button id="debug-select-none" type="button">全不选</button></div>
          <div class="debug-filter-options">
            <label><input type="checkbox" data-debug-category="takeover">接管与切换</label>
            <label><input type="checkbox" data-debug-category="playback">播放与暂停</label>
            <label><input type="checkbox" data-debug-category="download">下载线程</label>
            <label><input type="checkbox" data-debug-category="buffer">缓冲与跳转</label>
            <label><input type="checkbox" data-debug-category="settings">设置变化</label>
            <label><input type="checkbox" data-debug-category="other">其他日志</label>
          </div>
        </fieldset>
      </section>

      <section class="current-threads" aria-live="polite">
        <span>目前总线程</span>
        <b id="active-count">0</b>
      </section>
    </main>`;

  const PANEL_CSS = `
    * { box-sizing: border-box; }
    .btr-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .35); }
    .btr-popup { position: fixed; top: 72px; right: 24px; width: 320px; max-width: calc(100vw - 32px); max-height: calc(100vh - 96px); overflow: auto; border: 1px solid #30343d; border-radius: 12px; box-shadow: 0 12px 40px rgba(0, 0, 0, .45); color-scheme: dark; font-family: Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; background: #17191f; color: #f5f7fb; font-size: 14px; line-height: normal; text-align: left; }
    main { padding: 18px 16px; }
    header { display: grid; grid-template-columns: 42px 1fr auto; align-items: center; gap: 11px; margin-bottom: 22px; }
    .logo { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 8px; color: #fff; font-size: 23px; font-weight: 800; background: #fb7299; }
    h1 { margin: 0; font-size: 17px; letter-spacing: .2px; }
    .switch { position: relative; width: 42px; height: 24px; }
    .switch input { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
    .switch span { position: absolute; inset: 0; border-radius: 999px; background: #313a4c; cursor: pointer; transition: 160ms ease; }
    .switch span::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: 160ms ease; }
    .switch input:checked + span { background: #fb7299; }
    .switch input:checked + span::after { transform: translateX(18px); }
    .switch input:focus-visible + span { outline: 2px solid #fff; outline-offset: 3px; }
    .mode-select { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; margin-bottom: 12px; overflow: hidden; border: 1px solid #30343d; border-radius: 8px; background: #30343d; }
    .mode-select label { position: relative; }
    .mode-select input { position: absolute; opacity: 0; }
    .mode-select span { display: block; padding: 10px 6px; color: #949baa; background: #20232a; font-size: 12px; text-align: center; cursor: pointer; }
    .mode-select input:checked + span { color: #fff; background: #fb7299; }
    .mode-select input:focus-visible + span { outline: 2px solid #fff; outline-offset: -3px; }
    .takeover-select { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1px; margin-bottom: 8px; overflow: hidden; border: 1px solid #30343d; border-radius: 8px; background: #30343d; }
    .takeover-select label { position: relative; }
    .takeover-select input { position: absolute; opacity: 0; }
    .takeover-select span { display: block; padding: 10px 6px; color: #949baa; background: #20232a; font-size: 12px; text-align: center; cursor: pointer; }
    .takeover-select input:checked + span { color: #fff; background: #fb7299; }
    .takeover-select input:focus-visible + span { outline: 2px solid #fff; outline-offset: -3px; }
    .takeover-note { margin: 0 0 12px; padding: 0 2px; color: #7f8797; font-size: 11px; line-height: 1.6; }
    .custom-hosts { margin-bottom: 12px; padding: 14px 16px; border: 1px solid #30343d; border-radius: 8px; background: #20232a; }
    .custom-hosts[hidden] { display: none; }
    .custom-head { display: flex; align-items: center; justify-content: space-between; color: #c9ced9; font-size: 13px; }
    .custom-head b { min-width: 28px; padding: 2px 8px; border-radius: 5px; background: #fb7299; color: #fff; font-size: 12px; text-align: center; }
    .custom-note { margin: 8px 0 0; color: #7f8797; font-size: 11px; line-height: 1.6; }
    .custom-note[hidden] { display: none; }
    .host-group { min-width: 0; margin: 12px 0 0; padding: 10px 0 0; border: 0; border-top: 1px solid #343943; }
    .host-group legend { padding: 0 0 4px; color: #c9ced9; font-size: 12px; }
    .host-option { display: flex; align-items: center; gap: 7px; margin-top: 7px; color: #c9ced9; font-size: 11px; overflow-wrap: anywhere; cursor: pointer; }
    .host-option input { flex: none; width: 14px; height: 14px; margin: 0; accent-color: #fb7299; cursor: pointer; }
    .manual-host { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 7px; color: #c9ced9; font-size: 11px; overflow-wrap: anywhere; }
    .manual-host button { flex: none; width: 22px; height: 22px; padding: 0; border: 1px solid #444b57; border-radius: 4px; background: #292d35; color: #d9dee8; font: inherit; line-height: 20px; cursor: pointer; }
    .host-form { display: flex; gap: 6px; margin-top: 10px; }
    .host-form input { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid #444b57; border-radius: 5px; background: #17191f; color: #f5f7fb; font: inherit; font-size: 12px; }
    .host-form button { flex: none; padding: 6px 10px; border: 0; border-radius: 5px; background: #fb7299; color: #fff; font: inherit; font-size: 12px; cursor: pointer; }
    .host-error { min-height: 0; margin: 6px 0 0; color: #f28b85; font-size: 11px; }
    .host-error:empty { display: none; }
    .host-form input:focus-visible, .host-form button:focus-visible, .manual-host button:focus-visible, .host-option input:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .controls { padding: 16px; border: 1px solid #30343d; border-radius: 8px; background: #20232a; }
    .control-title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
    .control-title label { color: #c9ced9; font-size: 13px; }
    .auto-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .auto-row > label:first-child { display: flex; flex-direction: column; gap: 2px; color: #c9ced9; font-size: 13px; }
    .auto-row small { color: #8a93a6; font-size: 11px; }
    .controls.auto .slider, .controls.auto .scale { opacity: 0.4; pointer-events: none; }
    output { min-width: 42px; padding: 4px 8px; border-radius: 5px; color: #fff; background: #fb7299; font-size: 13px; font-weight: 700; text-align: center; }
    .slider { position: relative; width: 100%; height: 18px; border-radius: 9px; background: #3a3e47; }
    .slider-fill { position: absolute; top: 0; bottom: 0; left: 0; width: 60%; border-radius: 9px; background: #fb7299; pointer-events: none; }
    input[type="range"] { position: absolute; inset: 0; width: 100%; height: 18px; margin: 0; appearance: none; -webkit-appearance: none; border: 0; outline: 0; background: transparent; cursor: pointer; }
    input[type="range"]::-webkit-slider-runnable-track { height: 18px; background: transparent; }
    input[type="range"]::-webkit-slider-thumb { width: 24px; height: 24px; margin-top: -3px; appearance: none; -webkit-appearance: none; border: 2px solid #fff; border-radius: 50%; background: #fff; }
    input[type="range"]:focus-visible::-webkit-slider-thumb { border-color: #fb7299; }
    .scale { display: flex; justify-content: space-between; margin-top: 5px; color: #7f8797; font-size: 10px; }
    .scale span { width: 24px; text-align: center; }
    .scale span:first-child { text-align: left; }
    .scale span:last-child { text-align: right; }
    .notice-controls { margin-top: 12px; padding: 14px 16px; border: 1px solid #30343d; border-radius: 8px; background: #20232a; }
    .notice-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: #c9ced9; font-size: 13px; }
    .notice-row .switch { flex: none; }
    .notice-row + .notice-row { margin-top: 14px; }
    .debug-filters { min-width: 0; margin: 16px 0 0; padding: 12px 0 0; border: 0; border-top: 1px solid #343943; }
    .debug-filters[hidden] { display: none; }
    .debug-filters legend { padding: 0 0 4px; color: #c9ced9; font-size: 12px; }
    .debug-filter-actions { display: flex; gap: 8px; margin-bottom: 12px; }
    .debug-filter-actions button { padding: 4px 8px; border: 1px solid #444b57; border-radius: 4px; background: #292d35; color: #d9dee8; font: inherit; font-size: 11px; cursor: pointer; }
    .debug-filter-actions button:hover, .manual-host button:hover { border-color: #fb7299; }
    .debug-filter-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 8px; }
    .debug-filter-options label { display: flex; align-items: center; gap: 7px; color: #c9ced9; font-size: 12px; cursor: pointer; }
    .debug-filter-options input { flex: none; width: 15px; height: 15px; margin: 0; accent-color: #fb7299; cursor: pointer; }
    .debug-filter-actions button:focus-visible, .debug-filter-options input:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
    .current-threads { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; padding: 16px; border: 1px solid #30343d; border-radius: 8px; background: #20232a; color: #c9ced9; font-size: 13px; }
    .current-threads b { color: #fff; font-size: 20px; font-variant-numeric: tabular-nums; }
    .btr-close { position: sticky; bottom: 12px; display: block; width: calc(100% - 32px); margin: 0 16px 16px; padding: 8px; border: 1px solid #444b57; border-radius: 6px; background: #292d35; color: #d9dee8; font: inherit; font-size: 13px; cursor: pointer; box-shadow: 0 -6px 12px #17191f; }
    .btr-close:hover { border-color: #fb7299; }
    .btr-close:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  `;

  const LAUNCHER_CSS = `
    .btr-launcher { position: fixed; right: 76px; bottom: 116px; display: grid; place-items: center; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%; background: #fb7299; color: #fff; font: 700 13px/1 Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; letter-spacing: .3px; cursor: grab; opacity: .35; touch-action: none; box-shadow: 0 4px 14px rgba(0, 0, 0, .25); transition: opacity 160ms ease, transform 160ms ease, left 180ms ease, right 180ms ease; }
    .btr-launcher:hover, .btr-launcher:focus-visible { opacity: 1; transform: scale(1.06); }
    .btr-launcher:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .btr-launcher.dragging { cursor: grabbing; opacity: 1; transform: scale(1.1); transition: opacity 160ms ease, transform 160ms ease; }
    @media (max-width: 700px) { .btr-launcher { width: 40px; height: 40px; font-size: 12px; } }
  `;

  let current = null;
  // bridge.js sends the stored settings when they load or change, and the page its stats.
  let latestSettings = null;
  let latestStats = null;
  const post = (type, payload) => root.postMessage({ channel: CHANNEL, type, payload }, "*");

  function open() {
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
    style.textContent = PANEL_CSS;
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
    panel.append(closeButton);
    shadow.append(style, backdrop, panel);

    const $ = (id) => shadow.getElementById(id);
    const enabled = $("enabled");
    const concurrency = $("concurrency");
    const autoConcurrency = $("auto-concurrency");
    const threadValue = $("thread-value");
    const sliderFill = $("slider-fill");
    const errorNotices = $("error-notices");
    const debugNotices = $("debug-notices");
    const liveEnabled = $("live-enabled");
    const floatingButton = $("floating-button");
    const debugFilters = $("debug-filters");
    const debugCategoryInputs = [...shadow.querySelectorAll("[data-debug-category]")];
    const customSection = $("custom-hosts");
    const hostInput = $("host-input");
    const hostError = $("host-error");
    const activeCount = $("active-count");
    let customHosts = [];

    const save = (update) => post("settings-update", update);

    function setSlider(threads) {
      const index = THREAD_OPTIONS.indexOf(Number(threads));
      const safe = index < 0 ? 1 : index;
      concurrency.value = String(safe);
      threadValue.value = String(THREAD_OPTIONS[safe]);
      concurrency.setAttribute("aria-valuetext", String(THREAD_OPTIONS[safe]));
      sliderFill.style.width = `${safe / (THREAD_OPTIONS.length - 1) * 100}%`;
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
      enabled.checked = settings.enabled;
      for (const radio of shadow.querySelectorAll('input[name="takeover"]')) radio.checked = radio.value === settings.takeover;
      setSlider(settings.concurrency);
      autoConcurrency.checked = settings.autoConcurrency === true;
      concurrency.disabled = autoConcurrency.checked;
      concurrency.closest(".controls").classList.toggle("auto", autoConcurrency.checked);
      setMode(settings.mode);
      customHosts = settings.customHosts;
      renderHosts();
      liveEnabled.checked = settings.liveEnabled !== false;
      floatingButton.checked = settings.floatingButton !== false;
      errorNotices.checked = settings.errorNotices;
      debugNotices.checked = settings.debugNotices;
      debugFilters.hidden = !settings.debugNotices;
      for (const input of debugCategoryInputs) input.checked = settings.debugCategories[input.dataset.debugCategory] !== false;
    }

    const saveDebugCategories = () => save({ debugCategories: Object.fromEntries(debugCategoryInputs.map((input) => [input.dataset.debugCategory, input.checked])) });
    enabled.addEventListener("change", () => save({ enabled: enabled.checked }));
    liveEnabled.addEventListener("change", () => save({ liveEnabled: liveEnabled.checked }));
    floatingButton.addEventListener("change", () => save({ floatingButton: floatingButton.checked }));
    concurrency.addEventListener("input", () => {
      const threads = THREAD_OPTIONS[Number(concurrency.value)];
      setSlider(threads);
      save({ concurrency: threads });
    });
    autoConcurrency.addEventListener("change", () => save({ autoConcurrency: autoConcurrency.checked }));
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
    errorNotices.addEventListener("change", () => save({ errorNotices: errorNotices.checked }));
    debugNotices.addEventListener("change", () => {
      debugFilters.hidden = !debugNotices.checked;
      save({ debugNotices: debugNotices.checked });
    });
    for (const input of debugCategoryInputs) input.addEventListener("change", saveDebugCategories);
    $("debug-select-all").addEventListener("click", () => { for (const input of debugCategoryInputs) input.checked = true; saveDebugCategories(); });
    $("debug-select-none").addEventListener("click", () => { for (const input of debugCategoryInputs) input.checked = false; saveDebugCategories(); });

    // Keys typed into the panel belong to it. The shadow root hides the input from the page,
    // so the player's shortcuts (space, F, arrows) would otherwise react to them.
    const keepKeys = (event) => { if (event.key !== "Escape") event.stopPropagation(); };
    for (const type of ["keydown", "keyup", "keypress"]) panel.addEventListener(type, keepKeys);

    // The live thread count: asking for stats makes the page send fresh ones.
    const refresh = () => {
      activeCount.textContent = String(Math.max(0, Math.trunc(Number(latestStats?.activeThreads) || 0)));
      post("get-stats");
    };
    const timer = setInterval(refresh, 400);
    const onKey = (event) => { if (event.key === "Escape") close(); };
    const close = () => {
      if (current?.host !== host) return;
      current = null;
      clearInterval(timer);
      launcher?.apply();
      document.removeEventListener("keydown", onKey, true);
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
    render(latestSettings || core.normalizeSettings({}));
    post("get-settings");
    refresh();
    panel.focus();
  }

  const toggle = () => (current ? current.close() : open());

  // The button in the corner of every bilibili page. The userscript manager's menu is not
  // obvious (and on the home page people do not find it at all), so the panel needs a way in
  // that is always visible.
  // It hides while the video is fullscreen and while the panel itself is open.
  const launcher = (() => {
    if (root.top !== root) return null;
    const MARGIN = 12;
    // How far a press has to travel before it counts as dragging rather than a click.
    const DRAG_SLOP = 4;
    // Let go this close to the left or right edge and it snaps flush to it; let go anywhere
    // else and it simply stays where it was put.
    const SNAP_MS = 72;
    let host = null;
    let button = null;
    let wanted = true;
    // Where the viewer left it, as shares of the window: 0 means stuck to the left edge, 1 to
    // the right edge, anything between is a free spot. null: never moved.
    let leftRatio = null;
    let topRatio = null;
    let dragging = null;

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
      if (left <= SNAP_MS) leftRatio = 0;
      else if (left + size >= width - SNAP_MS) leftRatio = 1;
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
      button.addEventListener("pointerdown", startDrag);
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
        host?.remove();
        return;
      }
      mount();
      // Bilibili replaces large parts of the page when you navigate; put it back if it went.
      if (!host.isConnected) (document.body || document.documentElement).append(host);
      if (!dragging) place();
    }

    const update = (settings) => {
      wanted = settings?.floatingButton !== false;
      // null (never dragged) must stay null: Number(null) is 0, which would pin it to a corner.
      const ratio = (value) => (value != null && Number(value) >= 0 && Number(value) <= 1 ? Number(value) : null);
      leftRatio = ratio(settings?.floatingButtonLeft);
      topRatio = ratio(settings?.floatingButtonTop);
      apply();
    };
    for (const type of ["fullscreenchange", "webkitfullscreenchange"]) document.addEventListener(type, apply, true);
    root.addEventListener("resize", apply);
    // A page that swaps its body (the SPA navigations) drops the button with it.
    setInterval(apply, 2000);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once: true });
    // The button is on by default, so it is there before the stored settings arrive.
    apply();
    return { update, apply };
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
      // "自定义" in the gear menu.
      open();
    }
  });
  // The userscript manager's menu entry.
  document.addEventListener("btr-userscript-open-settings", () => { if (root.top === root) toggle(); });

  root.__BTR_SETTINGS_PANEL__ = Object.freeze({ open, close: () => current?.close(), toggle, isOpen: () => Boolean(current) });
})(globalThis);

/* src/page-hook.js */
(function installPageHook(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const INSTALL_FLAG = "__biliThreadRipper0901Installed";
  const BILIBILI_API_ORIGIN = "https://api.bilibili.com";
  const THREAD_OPTIONS = Object.freeze([4, 8, 16, 32, 64, 128]);
  const STATE_LABELS = Object.freeze({ waiting: "正在等视频信息", loading: "正在准备播放", ready: "视频已经准备好了", buffering: "正在补充缓冲", ended: "视频播放完了", error: "播放器出错了", "native-fallback": "已经改回 B 站原来的连接", disabled: "加速已关闭" });
  const KIND_LABELS = Object.freeze({ video: "画面", audio: "声音", meta: "视频信息" });
  const SETTINGS_ID = "__bilibili_thread_ripper_native_settings__";
  const SETTINGS_STYLE_ID = "__bilibili_thread_ripper_native_settings_style__";
  if (root[INSTALL_FLAG]) return;
  // The userscript runs on every bilibili.com page. The video takeover belongs to the video
  // pages only: the live site has its
  // own module (live-hook.js), and elsewhere only the settings panel is wanted.
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
  // A CDN node that twice sends nothing is skipped until the page moves to another video.
  // Restarting the takeover for the same video keeps the list.
  let cdnBanRoute = "";
  const cdnBans = root.__BILI_CDN_RESOLVER_FACTORY__?.createBanList({
    onBan(host, _count, _error, kind) {
      if (kind === "address") notices?.log("已停用一个下载地址", "B 站给的一个下载地址一直被服务器拒绝，这个视频接下来改用其他地址。", "info", "", cdnBanRoute, "download");
      else notices?.log("已停用这个 CDN 节点", `${host} 两次没有返回任何数据，这个视频接下来不再使用它。`, "error", "", cdnBanRoute, "download");
    }
  }) || null;
  let playerContainer = null;
  let playerLifecycle = 0;
  let qualityPlayer = null;
  let syncedQuality = 0;
  let codecPlayer = null;
  let syncedCodec = "";
  let infoPanel = null;
  let infoPanelObserver = null;
  const lastHostByKind = { video: "", audio: "" };
  const recentBytes = [];
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
  let takeoverErrorSequence = 1;
  let autoRetakeTimer = null;
  let autoRetakeRoute = "";
  let autoRetakeCount = 0;
  let autoRetakeAt = 0;
  let transferSequence = 1;
  const transfers = new Map();
  // 自动线程数 lives in the downloader; its steps are reported here.
  const autoThreads = root.__BILI_IDM_DOWNLOADER_FACTORY__?.autoConcurrency || null;
  autoThreads?.subscribe(({ threads, previous, reason }) => {
    if (!settings.autoConcurrency) return;
    stats.autoThreads = threads;
    notices?.log(threads > previous ? "线程数加到 " + threads : "线程数退回 " + threads, `${previous} → ${threads}：${reason}。`, "info", "", undefined, "download");
    schedulePublish();
  });

  const stats = {
    version: "2026.9.27.1",
    architecture: "bilibili-native-ui-progressive-mse-0.8-core",
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

  // What happened to the takeover on this page: each player keeps its own timeline, which is
  // gone once it is replaced, and that is exactly when a report is needed (a video that went
  // black and came back at another position). Positions and states only.
  const pageEvents = [];
  function remember(what, detail = "") {
    const video = player?.video || document.querySelector("#bilibili-player video, .bpx-player-container video");
    pageEvents.push({ at: Math.round(performance.now()), time: Math.round((Number(video?.currentTime) || 0) * 10) / 10, what, detail: String(detail).slice(0, 120) });
    if (pageEvents.length > 60) pageEvents.shift();
  }

  function clearTakeoverFailure() {
    takeoverFailureRoute = "";
    takeoverFailureCount = 0;
    takeoverFailureStartedAt = 0;
    stats.takeoverError = null;
  }

  function recordTakeoverFailure(route, stage, error, fatal = false) {
    const message = String(error?.message || error || "未知接管错误").slice(0, 180);
    const stageLabel = { playinfo: "读取视频信息", mse: "播放视频", create: "启动播放器", "playinfo-update": "更新播放信息", quality: "切换清晰度" }[stage] || "接管视频";
    notices?.log("没能接管这个视频", `${stageLabel}时出了问题。\n${message}`, "error", "", route, "takeover");
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
      const previous = stats.takeoverError;
      stats.playerState = "error";
      stats.takeoverError = {
        id: previous?.route === route && previous?.stage === stage && previous?.message === message
          ? previous.id
          : takeoverErrorSequence++,
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
      notices?.log("正在自动重新接管", `刚才的下载出了问题，现在重新接管这个视频（第 ${attempt} 次）。`, "info", "", route, "takeover");
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

  function onTransfer(event) {
    if (event?.phase === "start") {
      const id = transferSequence++;
      const now = Date.now();
      let host = "";
      try { host = new URL(event.url).hostname; } catch (_error) {}
      if (settings.debugNotices && settings.debugCategories?.download !== false) notices?.log("开始下载一小段数据", `第 ${id} 条线程正在下载${KIND_LABELS[event.kind] || "画面"}。\n下载节点：${host}`, "info", `range-start-${event.kind}`, undefined, "download");
      const kind = ["video", "audio", "meta"].includes(event.kind) ? event.kind : "video";
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
    if ((settings.debugNotices && settings.debugCategories?.download !== false) || (settings.errorNotices === true && event.phase === "error")) {
      const transferLabel = { progress: "正在接收视频数据", done: "这一小段下载好了", cancel: "这次下载已取消", error: "这一小段没能下载下来" }[event.phase] || "下载状态发生变化";
      const detail = `第 ${item.id} 条线程已收到 ${Math.round((item.loaded + (Number(event.bytes) || 0)) / 1024)} KiB ${KIND_LABELS[item.kind] || "视频"}数据。\n下载节点：${item.host}${event.error ? `\n原因：${event.error.message || event.error}` : ""}`;
      notices?.log(transferLabel, detail, event.phase === "error" ? "error" : event.phase === "done" ? "success" : "info", `range-${event.phase}-${item.kind}`, undefined, "download");
    }
    if (event.phase === "progress") {
      const bytes = Math.max(0, Number(event.bytes) || 0);
      recentBytes.push({ at: now, bytes });
      while (recentBytes.length && now - recentBytes[0].at > 1000) recentBytes.shift();
      speedMeters[item.kind]?.samples.push({ at: now, bytes });
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
      if (event.phase === "cancel") {
        transfers.delete(item.id);
        trackBusy(item.kind, now);
        schedulePublish();
        return event.id;
      }
      item.state = event.phase === "done" ? "done" : "error";
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
    const match = /\/video\/(BV[0-9A-Za-z]+|av\d+)/i.exec(location.pathname);
    if (match) return match[1];

    if (/^\/list\//i.test(location.pathname)) {
      const bvid = new URLSearchParams(location.search).get("bvid") || "";
      if (/^BV[0-9A-Za-z]+$/i.test(bvid)) return bvid;
    }

    return "";
  }

  function routeIdentity() {
    const pathId = urlPathId();
    if (!pathId) return null;
    const podBvid = activePodBvid();
    const pathVideoKey = /^BV/i.test(pathId) ? pathId.toLowerCase() : `av${Number(pathId.slice(2)) || 0}`;
    const podVideoKey = podBvid ? podBvid.toLowerCase() : "";
    // During an ordinary SPA navigation the previous collection DOM may stay
    // mounted for a moment. Only let a collection item override the URL when
    // it is the item captured from the current click transaction.
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
    return { aid, bvid, part, key: `${videoKey}:p${part}`, videoKey };
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
    while (routePlayinfo.size > 8) {
      const oldest = routePlayinfo.keys().next().value;
      routePlayinfo.delete(oldest);
      routeCids.delete(oldest);
    }
    return true;
  }

  function currentPlayinfo(identity) {
    const cached = routePlayinfo.get(identity?.key);
    if (isDashPlayinfo(cached)) return cached;
    try {
      const initialIdentity = stateIdentity(root.__INITIAL_STATE__);
      if (identity?.key === bootRouteKey && initialIdentity?.videoKey === identity?.videoKey && isDashPlayinfo(root.__playinfo__)) {
        const initialCid = Number(root.__INITIAL_STATE__?.videoData?.pages?.[identity.part - 1]?.cid
          || root.__INITIAL_STATE__?.videoData?.cid) || 0;
        cachePlayinfo(identity, root.__playinfo__, initialCid);
        return root.__playinfo__;
      }
    } catch (_error) {}
    const scripts = Array.from(document.scripts || []).reverse();
    if (identity?.key !== bootRouteKey) return null;
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

  function requestedVideoKey(url) {
    try {
      const parsed = new URL(String(url), location.href);
      const bvid = String(parsed.searchParams.get("bvid") || "");
      const aid = Number(parsed.searchParams.get("avid") || parsed.searchParams.get("aid")) || 0;
      return bvid ? bvid.toLowerCase() : aid ? `av${aid}` : "";
    } catch (_error) {
      return "";
    }
  }

  function requestedCid(url) {
    try { return Number(new URL(String(url), location.href).searchParams.get("cid")) || 0; }
    catch (_error) { return 0; }
  }

  function capturePlayinfoRequest(url) {
    if (!/\/x\/player\/(?:wbi\/)?playurl/i.test(String(url))) return null;
    const identity = routeIdentity();
    const videoKey = requestedVideoKey(url);
    const cid = requestedCid(url);
    if (!identity || !videoKey || videoKey !== identity.videoKey || !cid) return null;
    return { routeKey: identity.key, videoKey, cid };
  }

  function observePlayinfo(url, payload, requestContext = null) {
    if (!/\/x\/player\/(?:wbi\/)?playurl/i.test(String(url)) || !isDashPlayinfo(payload)) return;
    const context = requestContext || capturePlayinfoRequest(url);
    const identity = routeIdentity();
    if (!context || !identity || context.routeKey !== identity.key || context.videoKey !== identity.videoKey) return;
    const cid = Number(context.cid) || 0;
    const expectedCid = routeCids.get(identity.key) || 0;
    // The same BVID can contain many parts. A late response from the previous
    // part must never be cached under, or hot-swapped into, the current part.
    // The first response for a new route is allowed to establish its CID only
    // because its route identity was captured when the request was started.
    if (!cid || (expectedCid && cid !== expectedCid)) return;
    if (!expectedCid) routeCids.set(identity.key, cid);
    cachePlayinfo(identity, payload, cid);
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
    if (!/\/x\/player\/(?:wbi\/)?playurl/i.test(String(url))) return;
    response.clone().json().then((payload) => observePlayinfo(url, payload, requestContext)).catch(() => {});
  }

  root.fetch = function (...args) {
    const url = typeof args[0] === "string" || args[0] instanceof URL ? String(args[0]) : String(args[0]?.url || "");
    const requestContext = capturePlayinfoRequest(url);
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
      if (/\/x\/player\/(?:wbi\/)?playurl/i.test(url)) {
        this.addEventListener("load", () => {
          try {
            const payload = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
            observePlayinfo(this.responseURL || url, payload, xhrContexts.get(this));
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
    notices?.log("下载地址快要过期了", "正在向 B 站请求新的下载地址，播放不受影响。", "info", "", route, "download");
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
      notices?.log("没能提前换新下载地址", `${String(error?.message || error).slice(0, 120)}\n播放继续使用现在的地址，稍后再试。`, "info", "", route, "download");
    } finally {
      clearTimeout(timer);
      if (state.controller === controller) state.controller = null;
    }
  }

  // refresh: new addresses for the video that is already playing. Its CID is known by then,
  // so the video information is not asked for again, and the takeover notices stay quiet.
  async function fetchRoutePlayinfo(identity, signal, refresh = false) {
    let cid = refresh ? Number(routeCids.get(identity.key)) || 0 : 0;
    let canonicalBvid = String(identity.bvid || "");
    let canonicalAid = Number(identity.aid) || 0;
    if (!cid) {
      if (!refresh) notices?.log("正在读取视频信息", "确认你要看的视频和分 P。", "info", "", identity.key, "takeover");
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
    if (!refresh) notices?.log("已经拿到视频下载地址", "接下来开始准备多线程下载。", "success", "", identity.key, "takeover");
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
      #${SETTINGS_ID}{margin:0 0 20px;color:#fff;font-size:12px}
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

  // The player's own "自动开播" switch. Unknown counts as on, as before.
  function nativeAutoplay() {
    try { return JSON.parse(root.localStorage.getItem("bpx_player_profile") || "{}")?.media?.autoplay !== false; }
    catch (_error) { return true; }
  }

  function stopPlayer(resumeNative = true) {
    nativeCoreWait = null;
    const current = player;
    if (current) remember(resumeNative ? "handed back to Bilibili" : "player stopped", stats.playerState);
    // While a session loads or has failed the element is paused whatever the viewer wants;
    // the player knows the intent.
    if (current) resumeHint = { playing: Boolean(current.wantsToPlay ? current.wantsToPlay() : current.video && !current.video.paused), at: Date.now(), handedBack: resumeNative };
    notices?.detach(resumeNative ? "已停止加速，交回 B 站原来的连接" : "已停止接管上一个视频");
    playerLifecycle += 1;
    cancelDeadlineRefresh();
    player = null;
    playerRoute = "";
    playerContainer = null;
    current?.destroy({ resumeNative });
    // The suppressed native schedulers must run again once Bilibili owns playback.
    if (resumeNative && current && !current.nativeTransport) resumeNativeSchedulers();
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
      itemKey,
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

  function handleNativeSourceChange(route, lifecycle) {
    setTimeout(() => {
      if (lifecycle !== playerLifecycle || !player || playerRoute !== route) return;
      remember("Bilibili replaced the video source");
      routeGeneration += 1;
      routeRequestController?.abort();
      routeRequestController = null;
      startingRoute = "";
      failedRoute = "";
      clearTimeout(restartTimer);
      // The native player already installed its next source. Do not restore or
      // overwrite it; wait briefly for the transition to settle, then retake it.
      stopPlayer(false);
      restartTimer = setTimeout(startPlayer, 650);
    }, 0);
  }

  // Bilibili's quality menu can switch between qualities already in the playinfo without a
  // new playurl request, so read what was chosen from the native player. 0 means "auto".
  function nativeQuality() {
    try { return Math.max(0, Math.trunc(Number(root.player?.getQuality?.()?.newQ)) || 0); }
    catch (_error) { return 0; }
  }

  function syncNativeQuality() {
    // In the compatibility mode Bilibili's own player owns quality and codec.
    if (player?.nativeTransport) return;
    const wanted = nativeQuality();
    if (!player?.setQuality || (qualityPlayer === player && syncedQuality === wanted)) return;
    const current = player, route = playerRoute, lifecycle = playerLifecycle;
    qualityPlayer = current;
    syncedQuality = wanted;
    notices?.log("跟随播放器切换清晰度", wanted ? `正在换成播放器选的清晰度（${wanted}）。` : "播放器改回了自动，使用这个视频默认的清晰度。", "info", "", route, "playback");
    current.setQuality(wanted).then(() => {
      if (lifecycle === playerLifecycle && player === current) resolveNativeQualitySwitch();
    }).catch((error) => {
      if (lifecycle === playerLifecycle && player === current) recordTakeoverFailure(route, "quality", error, true);
    });
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
      const pending = root.player?.__core?.()?.qnSwitchingInfo?.video;
      if (!pending?.switching || typeof pending.resolve !== "function" || resolvedSwitchToken === pending) return;
      armFastResolve(pending);
      if (stats.playerState !== "ready") return;
      const target = nativeQuality();
      const playingId = Number(player.getDebug?.()?.qualityId) || 0;
      if (target && playingId !== target) return;
      resolvedSwitchToken = pending;
      pending.resolve({ type: "qualityChangeRendered", mediaType: "video", oldQuality: pending.oQn, newQuality: target || playingId, isMediaSegment: true, requestType: "MediaSegment" });
      notices?.log("清晰度切换完成", "新清晰度已经在播放，已通知 B 站播放器。", "success", "", playerRoute, "playback");
    } catch (_error) {}
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

  // While BTR plays the video, Bilibili's dash core keeps its schedule controllers running:
  // seeking and quality switches wake them, they download the same segments in parallel with
  // ours (an 8K stream doubles the bandwidth bill), and their appends then crash forever on
  // the long-detached SourceBuffers — the endless "reading 'updating' of null" TypeErrors.
  // While the takeover is active the controllers are stopped, and stopped again on every
  // native wake-up; handing the video back to Bilibili starts them again.
  function nativeStreamProcessors() {
    try { return root.player?.__core?.()?.getCorePlayer?.()?.getActiveStream?.()?.getProcessors?.() || []; }
    catch (_error) { return []; }
  }

  const stoppedSchedulers = new WeakSet();
  function suppressNativeSchedulers() {
    if (!player || player.nativeTransport || playerContainer?.dataset.btrMseActive !== "true") return;
    for (const processor of nativeStreamProcessors()) {
      try {
        const scheduler = processor?.getScheduleController?.();
        if (scheduler?.isStarted?.() && typeof scheduler.stop === "function") {
          scheduler.stop();
          stoppedSchedulers.add(scheduler);
          remember("native scheduler stopped", String(processor.getType?.() || ""));
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
    notices?.log("跟随播放器切换编码", wanted ? `正在换成播放策略里选的 ${wanted.toUpperCase()}。` : "播放策略改回了默认，按 AV1、HEVC、AVC 的顺序选。", "info", "", route, "playback");
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
    if (!settings.enabled || !identity) {
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
    const rangeTransport = settings.takeover === "compat" ? root.__BILI_NATIVE_RANGE_PLAYER_FACTORY__ : null;
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
    const generation = routeGeneration;
    let playinfo = currentPlayinfo(identity);
    notices?.log("准备接管这个视频", playinfo ? "已经有下载地址，可以继续准备播放。" : "还没有下载地址，正在向 B 站请求。", "info", "", route, "takeover");
    if (!playinfo) {
      startingRoute = route;
      routeRequestController?.abort();
      const controller = new AbortController();
      routeRequestController = controller;
      stats.playerState = "waiting";
      schedulePublish();
      try {
        playinfo = await fetchRoutePlayinfo(identity, controller.signal);
      } catch (error) {
        if (error?.name !== "AbortError" && generation === routeGeneration && routeIdentity()?.key === route) {
          recordTakeoverFailure(route, "playinfo", error);
          restartTimer = setTimeout(startPlayer, stats.takeoverError?.route === route ? 2500 : 700);
        }
        return;
      } finally {
        if (startingRoute === route) startingRoute = "";
        if (routeRequestController === controller) routeRequestController = null;
      }
      if (generation !== routeGeneration || routeIdentity()?.key !== route) return;
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
      cdnBanRoute = route;
    }
    const preferredQuality = nativeQuality();
    const preferredCodec = nativeCodec();
    const preferredAudio = nativeAudio();
    const resumeAfterStop = takeResumeHint(autoRetakeRoute === route && autoRetakeCount > 0);
    for (const meter of Object.values(speedMeters)) meter.shown = 0;
    try {
      // The compatibility mode needs Bilibili's own playback core; without it the video is
      // taken over as usual.
      const transport = settings.takeover === "compat" ? root.__BILI_NATIVE_RANGE_PLAYER_FACTORY__ : null;
      const factory = transport?.supports(container) ? transport : playerFactory;
      const nextPlayer = factory.createNativePlayer({
        container,
        identity,
        preferredQuality,
        preferredCodec,
        preferredAudio,
        // A collection item is a different video. Its native <video> element
        // can still expose the previous item's currentTime until new metadata
        // arrives, so carrying that value across would clamp short videos to
        // their final frame and make the switch look frozen.
        initialTime: isPodSwitch ? 0 : undefined,
        initialResume: isPodSwitch ? pendingPodSwitch.resume : resumeAfterStop ? true : undefined,
        autoplay: nativeAutoplay(),
        getSettings: () => settings,
        nativeFetch,
        poster: String(root.__INITIAL_STATE__?.videoData?.pic || ""),
        onTransfer,
        cdnBans,
        onLog(title, detail, level = "info", category = "other") {
          if (lifecycle !== playerLifecycle) return;
          notices?.log(title, detail, level, "", route, category);
        },
        onNativeSourceChange() {
          if (lifecycle !== playerLifecycle) return;
          notices?.detach("B 站正在切换视频，准备重新接管");
          handleNativeSourceChange(route, lifecycle);
        },
        onSegment(event) {
          if (lifecycle !== playerLifecycle) return;
          notices?.log("下载好的数据已经交给播放器", `这段${KIND_LABELS[event.kind] || "视频"}数据有 ${Math.round(event.bytes / 1024)} KiB，由 ${event.pieces} 路下载完成。`, "success", `segment-${event.kind}`, route, "buffer");
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
          if (next.playerState !== stats.playerState || next.quality !== stats.quality) notices?.log(STATE_LABELS[next.playerState] || "播放状态发生变化", `当前清晰度是 ${next.quality || "默认清晰度"}，已经缓冲 ${(Number(next.bufferedAhead) || 0).toFixed(1)} 秒。`, next.playerState === "error" ? "error" : ["ready", "ended"].includes(next.playerState) ? "success" : "info", "", route, "playback");
          stats.mode = next.mode || settings.mode;
          stats.playerState = next.playerState || stats.playerState;
          if (next.playerState === "ready" && (takeoverFailureRoute === route || stats.takeoverError?.route === route)) {
            clearTakeoverFailure();
            stats.lastError = "";
          }
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
          remember("playback failed", error?.message || error);
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
      remember("took over", `${route}${nextPlayer.nativeTransport ? " (兼容模式)" : ""}`);
      stats.architecture = nextPlayer.nativeTransport ? "native-player-range-transport" : "bilibili-native-ui-progressive-mse-0.8-core";
      playerRoute = route;
      playerContainer = container;
      suppressNativeSchedulers();
      qualityPlayer = nextPlayer;
      syncedQuality = preferredQuality;
      codecPlayer = nextPlayer;
      syncedCodec = preferredCodec;
      notices?.attach(nextPlayer.video, route, lifecycle, () => lifecycle === playerLifecycle && player === nextPlayer && playerRoute === routeIdentity()?.key && playerContainer?.isConnected && !["error", "native-fallback", "disabled"].includes(stats.playerState));
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
      const serversChanged = settings.mode === "custom" && previous.customHosts.join(",") !== settings.customHosts.join(",");
      if (!hadLoadedSettings || previous.enabled !== settings.enabled || previous.takeover !== settings.takeover || previous.mode !== settings.mode || previous.concurrency !== settings.concurrency || previous.autoConcurrency !== settings.autoConcurrency || serversChanged) {
        const cdn = settings.mode === "overseas" ? "海外 CDN"
          : settings.mode !== "custom" ? "大陆 CDN"
            : settings.customHosts.length ? `自定义的 ${settings.customHosts.length} 个服务器` : "大陆 CDN（自定义里还没选服务器）";
        const threads = settings.autoConcurrency ? `线程数自动调整（当前 ${autoThreads?.threads() || 8}，8 到 32）` : `开启 ${settings.concurrency} 条下载线程`;
        notices?.log("设置已经生效", `${settings.takeover === "compat" ? "兼容模式" : "全接管"}，使用${cdn}，${threads}。`, "success", "", undefined, "settings");
      }
      stats.autoThreads = settings.autoConcurrency ? autoThreads?.threads() || 0 : 0;
      stats.mode = settings.mode;
      syncSettingsMenu();
      if (!settings.enabled) {
        clearTakeoverFailure();
        stats.lastError = "";
        stopPlayer(true);
      }
      else if (!previous.enabled || previous.takeover !== settings.takeover) {
        restartPlayer(true);
      }
      else {
        // The download lists read the CDN mode and servers for every request, so a new choice
        // applies to the next downloads. Restarting the player used to send the video back to
        // its start.
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
        // Node names and states only: no download address or account data.
        return JSON.stringify({
          version: stats.version, at: Math.round(performance.now()), settings: { takeover: settings.takeover, mode: settings.mode, customHosts: settings.customHosts.slice(), concurrency: settings.concurrency, codec: nativeCodec() || "default" },
          state: stats.playerState, lastError: stats.lastError, player: rest, nodes: stats.cdnHosts.map((item) => ({ ...item })), bannedNodes: cdnBans?.hosts?.() || [], page: pageEvents.slice(), timeline
        }, null, 1);
      },
      version: "2026.9.27.1"
    })
  });
  publish();
})(globalThis);

/* src/live-core.js */
(function installLiveCore(root) {
  "use strict";

  // The parts of the live module that carry logic: playinfo parsing, playlist parsing,
  // P2P/proxy URL handling and the host pool. No DOM and no timers, so dev tests can run
  // all of it in Node.

  // fMP4 HLS nodes that accept each other's signatures, verified by probing real streams
  // (2026-09): a segment signed for one of them downloads from all of them with HTTP 206,
  // while FLV-line (ov-gotcha07) and TS-line (gotcha105) nodes answer 403. The pool probes
  // each candidate once per stream before trusting it.
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
  // twice sent nothing. An unproven candidate must pass a probe before it enters ranking.
  function createHostPool(options = {}) {
    const health = new Map(); // host -> {fbMs, bps, failures, blockedUntil, lastSuccessAt, proven}
    const now = () => (options.now ? options.now() : Date.now());

    function entry(host) {
      if (!health.has(host)) health.set(host, { fbMs: 0, bps: 0, failures: 0, blockedUntil: 0, lastSuccessAt: 0, proven: false, emptyReplies: 0, banned: false });
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
        item.lastSuccessAt = now();
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
        const pool = (open.length ? open : all.filter(([, item]) => !item.banned)).length
          ? (open.length ? open : all.filter(([, item]) => !item.banned))
          : all;
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
  const notices = root.__BTR_RUNTIME_NOTICES__;
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
  // Off until the saved settings have arrived: a viewer who switched the module off must
  // not be taken over during the first second of the page.
  const liveOn = () => settingsLoaded && settings.enabled && settings.liveEnabled !== false;

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
    version: "2026.9.27.1",
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
    takeoverError: null
  };
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
  // context: { key, playlistUrl, pool, cache: Map(url -> {promise, at, hit}), lastNum, mapUrl, probing }
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
    if (context?.key === key) {
      context.playlistUrl = playlistUrl;
      return context;
    }
    dropContext();
    const pool = core.createHostPool({
      onBan(host) { notices?.log("已停用一个直播节点", `${host} 两次没有返回数据，这个直播接下来不再使用它。`, "error", "", "live", "download"); }
    });
    let origin = "";
    try { origin = new URL(playlistUrl).hostname; } catch (_error) {}
    // The node Bilibili handed out is trusted unless it is a P2P relay. In the custom CDN
    // mode only the servers the viewer picked join it; otherwise the known fMP4 group does.
    if (origin && !core.isP2pUrl(playlistUrl)) pool.add(origin, true);
    const extra = settings.mode === "custom" ? settings.customHosts : core.KNOWN_FMP4_HOSTS;
    for (const host of extra) if (host !== origin) pool.add(host, false);
    context = { key, playlistUrl, pool, cache: new Map(), lastNum: 0, mapUrl: "", probing: false, speculativeMisses: 0, prefetchQueue: [], inflightPrefetch: 0, urgentInflight: 0, abort: new AbortController() };
    stats.playerState = "ready";
    notices?.log("已接管这个直播", "直播分片改为多节点竞速下载，并提前缓存即将播放的分片。", "success", "", "live", "takeover");
    schedulePublish();
    return context;
  }

  // Candidate nodes must prove they serve this stream before ranking uses them: the
  // signature is shared within the fMP4 node group, but a node may still lack the stream.
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
          if (item) item.bps = received * 1000 / Math.max(1, performance.now() - startedAt);
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

  // One segment: the best node first, a hedge copy on the second-best when the first is
  // slow to produce bytes. 404 means "not born yet" for a speculative fetch and is not a
  // node failure.
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

  // What a new playlist drives: prefetch the announced-but-uncached tail, the init map,
  // and — once everything announced is in hand — one speculative future segment, whose
  // 404 only means the encoder has not produced it yet.
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
      notices?.log("直播分片下载失败", `${stats.lastError}\n这一片交回给 B 站原来的连接。`, "error", "seg-fallback", "live", "download");
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

  // P2P and relay-wrapped URLs route back to the best official node; without a pool yet,
  // an smtcdns wrapper at least unwraps to the node it fronts.
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

  // A player that loads media over XMLHttpRequest gets the URL rewrite (P2P removal and
  // best-node routing); synthesizing full XHR responses is not worth the risk here.
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
      notices?.configure(settings);
      if (!settingsLoaded || previous.enabled !== settings.enabled || previous.liveEnabled !== settings.liveEnabled) {
        settingsLoaded = true;
        notices?.log("直播加速设置已生效", liveOn() ? "直播分片使用多节点竞速下载。" : "直播加速已关闭，使用 B 站原来的连接。", "success", "", "live", "settings");
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
      version: "2026.9.27.1"
    })
  });
  publish();
})(globalThis);

/* src/notification-view.js */
(function installNotificationView(root) {
  "use strict";

  const ID = "__btr_notification_stack__";
  const MAX_CARDS = 6;
  const MAX_ERROR_CARDS = 3;
  const LIFETIME = 6500;
  const ERROR_LIFETIME = 20000;
  const ENTER_MS = 600;
  const MOVE_MS = 560;
  const EXIT_MS = 480;
  const EASING = "cubic-bezier(.2,.75,.25,1)";
  const reducedMotion = root.matchMedia("(prefers-reduced-motion: reduce)");
  const cards = new Set();
  const leaving = new Set();
  let settings = {};
  let host = null;
  let stack = null;
  let normalLayer = null;
  let errorLayer = null;
  let idleCard = null;
  let playback = null;
  let receivedAt = 0;
  let lastMode = "";
  let sequence = 0;
  let timer = null;

  function plainText(value, limit = 320) {
    return String(value ?? "").replace(/[\u00b7\u2022\u2027\u2219\u22c5]+/g, "，").slice(0, limit);
  }

  function categoryOf(entry) {
    return ["takeover", "playback", "download", "buffer", "settings", "other"].includes(entry?.category) ? entry.category : "other";
  }

  function allCards() {
    return [...cards, ...leaving].sort((a, b) => b.id - a.id);
  }

  function moveUp(card, target) {
    if (Number.isFinite(card.y) && target >= card.y - .5) return;
    const current = Number.isFinite(card.y) ? card.wrapper.getBoundingClientRect().top - stack.getBoundingClientRect().top : target;
    // Never reverse an interrupted animation, even when a newer layout request
    // arrives before the previous upward movement has finished.
    target = Math.min(target, current);
    card.motion?.cancel();
    card.y = target;
    card.wrapper.style.transform = `translateY(${target}px)`;
    if (!reducedMotion.matches && current - target > .5) {
      card.motion = card.wrapper.animate([{ transform: `translateY(${current}px)` }, { transform: `translateY(${target}px)` }], { duration: MOVE_MS, easing: EASING });
    }
  }

  function packUpwards() {
    if (!stack) return;
    const ordered = allCards();
    for (const card of ordered) card.height = card.wrapper.offsetHeight;
    const errors = ordered.filter(card => card.isError).reverse();
    // Red messages occupy a protected lane at the top of the notification
    // column. Ordinary traffic cannot evict them or push them offscreen.
    let top = Math.max(2, stack.clientHeight - 560);
    for (const card of errors) {
      moveUp(card, Math.min(card.y, top));
      top = card.y + card.height + 8;
    }
    const boundary = errors.length ? top : 0;
    normalLayer.style.clipPath = `inset(${Math.max(0, boundary)}px 0 0 0)`;
    let bottom = stack.clientHeight - 2;
    for (const card of ordered.filter(card => !card.isError)) {
      moveUp(card, Math.min(card.y, bottom - card.height));
      bottom = card.y - 8;
      if (card.y < boundary) {
        // Once clipped out, do not reveal an old message again when an error
        // expires and the protected area becomes smaller.
        retire(card);
        card.wrapper.style.visibility = "hidden";
      }
    }
  }

  function positionStack() {
    if (!host) return;
    const errorNotice = document.getElementById("__bilibili_thread_ripper_error_notice__");
    const fullscreen = document.fullscreenElement;
    const errorVisible = errorNotice?.getClientRects().length && (!fullscreen || fullscreen.contains(errorNotice));
    const bottom = errorVisible ? Math.max(14, innerHeight - errorNotice.getBoundingClientRect().top + 8) : 14;
    const height = `${Math.max(0, innerHeight - bottom - 14)}px`;
    if (host.style.height === height) return;
    host.style.setProperty("height", height, "important");
    // A cleared error or taller viewport may offer more space below. Existing
    // messages keep their positions; only newly created messages use that space.
    trimErrors();
    packUpwards();
  }

  function mount() {
    if (!host) {
      host = document.createElement("div");
      host.id = ID;
      host.style.cssText = "all:initial!important;position:fixed!important;left:14px!important;top:14px!important;width:min(280px,calc(100vw - 28px))!important;z-index:2147483647!important;pointer-events:none!important;";
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        :host{color-scheme:dark}
        .stack{position:absolute;inset:0;overflow:hidden}
        .layer{position:absolute;inset:0}
        .errors{z-index:1}
        .entry{position:absolute;top:0;left:2px;right:2px;min-width:0}
        .bubble{--edge:#a5913a;--accent:#f0d66b;box-sizing:border-box;display:block;width:100%;margin:0;padding:7px 9px;border:1px solid var(--edge);border-radius:5px;background:rgba(8,8,10,.78);box-shadow:inset 0 1px 0 #ffffff12,1px 1px 2px #0007;color:#f2f2ee;font:700 13px/1.35 Tahoma,"Microsoft YaHei",sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;text-align:left;text-shadow:1px 1px 0 #0009}
        .bubble[data-level="success"]{--edge:#518346;--accent:#a2d983}
        .bubble[data-level="error"]{--edge:#a44949;--accent:#f28b85}
        .debug{cursor:pointer;pointer-events:auto;appearance:none}
        .debug:focus-visible{outline:2px solid #fff;outline-offset:-3px}
        .leaving{pointer-events:none}
        .heading{display:block;font-weight:700;color:var(--accent)}
        .detail{display:block;margin-top:3px}
        .meta{display:block;margin-top:5px;font-size:10px;line-height:1.3;color:#c4c4bc;font-weight:400}
      `;
      stack = document.createElement("div");
      stack.className = "stack";
      normalLayer = document.createElement("div");
      normalLayer.className = "layer normal";
      errorLayer = document.createElement("div");
      errorLayer.className = "layer errors";
      stack.append(normalLayer, errorLayer);
      shadow.append(style, stack);
    }
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && fullscreen.tagName !== "VIDEO" ? fullscreen : document.documentElement;
    if (parent && host.parentNode !== parent) parent.append(host);
    positionStack();
    if (!timer) timer = setInterval(tick, 250);
  }

  function createCard(entry, kind) {
    const id = ++sequence;
    const wrapper = document.createElement("div");
    wrapper.className = "entry";
    wrapper.dataset.id = String(id);
    const node = document.createElement(kind === "debug" ? "button" : "div");
    node.className = `bubble ${kind}`;
    node.dataset.level = ["success", "error"].includes(entry.level) ? entry.level : "info";
    if (kind === "debug") {
      node.type = "button";
      node.setAttribute("aria-label", "关闭这条 Debug 提示");
    } else node.setAttribute("role", "status");
    const heading = document.createElement("span");
    heading.className = "heading";
    heading.textContent = entry.level === "error" && !settings.debugNotices ? "BTR 提示" : "BTR Debug";
    const detail = document.createElement("span");
    detail.className = "detail";
    detail.textContent = [plainText(entry.title, 80), plainText(entry.detail)].filter(Boolean).join("\n");
    node.append(heading, detail);
    if (kind === "debug") {
      const meta = document.createElement("span");
      meta.className = "meta";
      const route = plainText(entry.route, 100);
      const part = /^(.*):p(\d+)$/.exec(route);
      const videoLabel = part ? `视频 ${part[1]}，第 ${part[2]} P` : route;
      const count = Math.max(1, Math.min(10000, Number(entry.count) || 1));
      meta.textContent = [`时间 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`, videoLabel, count > 1 ? `本条包含 ${count} 条同类记录` : ""].filter(Boolean).join("\n");
      node.append(meta);
    }
    wrapper.append(node);
    const isError = entry.level === "error";
    const card = { id, kind, isError, category: kind === "mode" && !entry.category ? "mode" : categoryOf(entry), wrapper, node, y: Infinity, height: 0, expires: Date.now() + (isError ? ERROR_LIFETIME : LIFETIME), fade: null, motion: null };
    if (kind === "debug") node.addEventListener("click", () => retire(card));
    return card;
  }

  function appendCards(entries, kind = "debug") {
    mount();
    if (idleCard) { idleCard.expires = Date.now() + LIFETIME; idleCard = null; }
    const added = entries.map(entry => createCard(entry, kind));
    for (const card of added) {
      cards.add(card);
      (card.isError ? errorLayer : normalLayer).append(card.wrapper);
    }
    trimErrors();
    packUpwards();
    for (const card of added) if (cards.has(card) && !reducedMotion.matches) {
      card.fade = card.node.animate([{ opacity: 0, transform: "translateX(-32px)" }, { opacity: 1, transform: "translateX(0)" }], { duration: ENTER_MS, easing: EASING });
    }
    const ordinary = [...cards].filter(card => !card.isError);
    while (ordinary.length > MAX_CARDS) retire(ordinary.shift());
    return added.at(-1);
  }

  function trimErrors() {
    if (!stack) return;
    const errors = allCards().filter(card => card.isError).reverse();
    const available = Math.min(560, stack.clientHeight) - 4;
    let occupied = errors.reduce((sum, card) => sum + card.wrapper.offsetHeight + 8, 0);
    // Bounded even for a burst of large errors or a very short viewport.
    // Keep the most recent errors when the protected lane is full.
    while (errors.length > MAX_ERROR_CARDS || (errors.length > 1 && occupied > available)) {
      const card = errors.shift();
      occupied -= card.wrapper.offsetHeight + 8;
      retire(card);
      finishLeaving(card);
    }
  }

  function finishLeaving(card) {
    if (!leaving.delete(card)) return;
    clearTimeout(card.exitTimer);
    card.fade?.cancel();
    card.motion?.cancel();
    card.wrapper.remove();
    // Absolute positions intentionally leave a gap. Removing a bubble must not
    // pull older bubbles down to refill a bottom-aligned flex layout.
  }

  function retire(card) {
    if (!cards.delete(card)) return;
    if (idleCard === card) idleCard = null;
    const opacity = getComputedStyle(card.node).opacity;
    const transform = getComputedStyle(card.node).transform;
    card.fade?.cancel();
    card.node.classList.add("leaving");
    card.node.disabled = true;
    leaving.add(card);
    if (reducedMotion.matches) { finishLeaving(card); return; }
    card.fade = card.node.animate([{ opacity, transform }, { opacity: 0, transform: "translateX(-28px)" }], { duration: EXIT_MS, easing: "ease-in", fill: "forwards" });
    card.fade.finished.then(() => finishLeaving(card), () => {});
    // Hidden/background tabs may suspend animation completion callbacks.
    card.exitTimer = setTimeout(() => finishLeaving(card), EXIT_MS + 80);
    const sameLevel = [...leaving].filter(item => item.isError === card.isError);
    while (sameLevel.length > (card.isError ? MAX_ERROR_CARDS : MAX_CARDS)) finishLeaving(sameLevel.shift());
  }

  function reset() {
    for (const card of allCards()) { clearTimeout(card.exitTimer); card.fade?.cancel(); card.motion?.cancel(); }
    cards.clear();
    leaving.clear();
    host?.remove();
    host = stack = normalLayer = errorLayer = idleCard = playback = null;
    lastMode = "";
    clearInterval(timer);
    timer = null;
  }

  function syncMode() {
    if (!settings.debugNotices) {
      if (!cards.size && !leaving.size) reset();
      return;
    }
    mount();
    const fresh = settings.debugCategories?.playback !== false && playback?.attached && Date.now() - receivedAt < 2500;
    const detail = !settings.enabled ? "视频加速目前已关闭。" : fresh ? (playback.playing ? "加速已接管，视频正在播放。" : "加速已接管，视频还没播放。\n如果视频正在播放，请刷新网页。") : "有新的运行消息时，会显示在这里。";
    const signature = `${fresh ? `${playback.route}:${playback.session}` : ""}\n${detail}`;
    if (signature === lastMode && (cards.size || leaving.size)) return;
    lastMode = signature;
    // Status changes create a new immutable snapshot too. When the stack is
    // empty, create a fresh idle card; never bring an old card back down.
    idleCard = appendCards([{ title: "Debug 模式已开启", detail, category: fresh ? "playback" : undefined, level: settings.enabled && (!fresh || playback.playing) ? "success" : "info" }], "mode");
    idleCard.expires = Infinity;
  }

  function tick() {
    positionStack();
    for (const card of cards) if (card.expires <= Date.now()) retire(card);
    packUpwards();
    syncMode();
  }

  root.__BTR_NOTIFICATION_VIEW__ = Object.freeze({
    configure(next) {
      if (settings.enabled !== next.enabled || settings.debugNotices !== next.debugNotices) playback = null;
      settings = { enabled: next.enabled !== false, debugNotices: next.debugNotices === true, errorNotices: next.errorNotices === true, debugCategories: { ...next.debugCategories } };
      if (!settings.debugNotices) lastMode = "";
      for (const card of cards) {
        const debugAllowed = settings.debugNotices && settings.debugCategories[card.category] !== false;
        const keep = card.kind === "mode" ? debugAllowed : settings.enabled && (card.isError ? settings.errorNotices : debugAllowed);
        if (!keep) retire(card);
      }
      syncMode();
    },
    playback(next) {
      if (!settings.enabled || !settings.debugNotices || settings.debugCategories.playback === false) return;
      playback = { attached: next?.attached === true, playing: next?.playing === true, route: String(next?.route || "").slice(0, 100), session: Number(next?.session) || 0 };
      receivedAt = Date.now();
      syncMode();
    },
    logs(entries) {
      if (!settings.enabled || !Array.isArray(entries)) return;
      const allowed = entries.filter(entry => entry && typeof entry === "object" && (entry.level === "error" ? settings.errorNotices : settings.debugNotices && settings.debugCategories[categoryOf(entry)] !== false));
      const selected = new Set([
        ...allowed.filter(entry => entry.level === "error").slice(-MAX_ERROR_CARDS),
        ...allowed.filter(entry => entry.level !== "error").slice(-MAX_CARDS)
      ]);
      const snapshots = allowed.filter(entry => selected.has(entry));
      if (snapshots.length) appendCards(snapshots);
    }
  });
  document.addEventListener("DOMContentLoaded", () => { if (settings.debugNotices) syncMode(); }, { once: true });
  document.addEventListener("fullscreenchange", () => { if (host) mount(); });
  root.addEventListener("resize", () => { positionStack(); packUpwards(); });
  reducedMotion.addEventListener("change", () => {
    if (!reducedMotion.matches) return;
    for (const card of allCards()) { card.fade?.cancel(); card.motion?.cancel(); }
    for (const card of [...leaving]) finishLeaving(card);
  });
})(globalThis);

/* src/bridge.js */
(function installBridge() {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const VERSION = "2026.9.27.1";
  const notices = globalThis.__BTR_NOTIFICATION_VIEW__;
  const ERROR_NOTICE_ID = "__bilibili_thread_ripper_error_notice__";
  const ERROR_NOTICE_STYLE_ID = "__bilibili_thread_ripper_error_notice_style__";
  const THREAD_OPTIONS = Object.freeze([4, 8, 16, 32, 64, 128]);
  const DEFAULTS = { enabled: true, liveEnabled: true, concurrency: 8, autoConcurrency: true, takeover: "full", mode: "mainland", customHosts: [], floatingButton: true, floatingButtonLeft: null, floatingButtonTop: null, debugNotices: false, errorNotices: false, debugCategories: {} };
  // Settings of the old ArtPlayer version, of the removed compatibility modes, and the flag
  // of the first-run guide that 0.9.4.2 removed.
  const RETIRED_KEYS = ["statusNotice", "compatibilityMode", "volume", "danmaku", "danmakuFontSize", "subtitleLanguage", "subtitleLastLanguage", "btrOnboardingRevision"];
  let latestSettings = { ...DEFAULTS };
  let latestStats = null;
  let loaded = false;
  let errorNoticeMotion = null;

  // The page checks each custom server again with the full rules before using it; here it
  // only has to look like a host name.
  function normalizeStoredSettings(input) {
    const threads = Math.trunc(Number(input?.concurrency));
    return {
      enabled: input?.enabled !== false,
      liveEnabled: input?.liveEnabled !== false,
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
      debugNotices: input?.debugNotices === true,
      errorNotices: input?.errorNotices === true,
      debugCategories: Object.fromEntries(["takeover", "playback", "download", "buffer", "settings", "other"].map(key => [key, input?.debugCategories?.[key] !== false]))
    };
  }

  function postSettings() {
    window.postMessage({ channel: CHANNEL, type: "settings", payload: latestSettings }, "*");
  }

  function normalizeTakeoverError(input) {
    if (!input || typeof input !== "object") return null;
    const at = Math.max(0, Number(input.at) || 0);
    const retryCount = Math.max(0, Math.min(999, Math.trunc(Number(input.retryCount) || 0)));
    const message = String(input.message || "接管失败").replace(/[\u00b7\u2022\u2027\u2219\u22c5]+/g, "，").slice(0, 500);
    return {
      id: String(input.id || `${at}:${message}`).slice(0, 160),
      at,
      route: String(input.route || "").slice(0, 180),
      stage: String(input.stage || "unknown").slice(0, 80),
      message,
      retryCount
    };
  }

  function removeTakeoverErrorNotice() {
    const notice = document.getElementById(ERROR_NOTICE_ID);
    if (!notice) { document.getElementById(ERROR_NOTICE_STYLE_ID)?.remove(); return; }
    if (notice.dataset.leaving === "true") return;
    const finish = () => {
      notice.remove();
      document.getElementById(ERROR_NOTICE_STYLE_ID)?.remove();
      errorNoticeMotion = null;
    };
    const opacity = getComputedStyle(notice).opacity;
    const transform = getComputedStyle(notice).transform;
    errorNoticeMotion?.cancel();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || latestSettings.enabled === false) { finish(); return; }
    notice.dataset.leaving = "true";
    notice.style.setProperty("pointer-events", "none", "important");
    errorNoticeMotion = notice.animate([{ opacity, transform }, { opacity: 0, transform: "translateX(-28px)" }], { duration: 480, easing: "ease-in", fill: "forwards" });
    errorNoticeMotion.finished.then(finish, () => {});
  }

  function formatErrorTime(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "未知";
    try {
      return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
    } catch (_error) {
      return new Date(timestamp).toISOString();
    }
  }

  function syncTakeoverErrorNotice() {
    const error = latestStats?.takeoverError;
    if (!loaded || latestSettings.enabled === false || latestSettings.errorNotices !== true || !error || ["ready", "disabled"].includes(latestStats?.playerState)) {
      removeTakeoverErrorNotice();
      return;
    }
    if (window.top !== window) return;
    const mount = document.body || document.documentElement;
    if (!mount) {
      document.addEventListener("DOMContentLoaded", syncTakeoverErrorNotice, { once: true });
      return;
    }

    if (!document.getElementById(ERROR_NOTICE_STYLE_ID)) {
      const style = document.createElement("style");
      style.id = ERROR_NOTICE_STYLE_ID;
      style.textContent = `
        #${ERROR_NOTICE_ID}{position:fixed!important;left:14px!important;bottom:14px!important;z-index:2147483646!important;width:min(280px,calc(100vw - 28px))!important;max-height:65vh!important;overflow:auto!important;box-sizing:border-box!important;border:1px solid #a44949!important;border-radius:5px!important;background:rgba(8,8,10,.78)!important;color:#f2f2ee!important;font-family:Tahoma,"Microsoft YaHei",sans-serif!important;text-shadow:1px 1px 0 #0009!important;box-shadow:inset 0 1px 0 #ffffff12,1px 1px 2px #0007!important}
        #${ERROR_NOTICE_ID} *{box-sizing:border-box!important}
        #${ERROR_NOTICE_ID} .btr-error-summary{padding:7px 9px!important}
        #${ERROR_NOTICE_ID} .btr-error-title{margin:0!important;color:#f28b85!important;font-size:13px!important;font-weight:700!important;line-height:18px!important}
        #${ERROR_NOTICE_ID} .btr-error-description{margin:3px 0 0!important;font-size:13px!important;line-height:18px!important;font-weight:700!important}
        #${ERROR_NOTICE_ID} .btr-error-toggle{display:inline-block!important;margin:3px 0 0!important;padding:0!important;border:0!important;background:transparent!important;color:#f28b85!important;font:400 12px/18px Tahoma,"Microsoft YaHei",sans-serif!important;text-align:left!important;cursor:pointer!important}
        #${ERROR_NOTICE_ID} .btr-error-toggle:hover{text-decoration:underline!important}
        #${ERROR_NOTICE_ID} .btr-error-toggle:focus-visible,#${ERROR_NOTICE_ID} .btr-error-retry:focus-visible{outline:2px solid #00aeec!important;outline-offset:2px!important}
        #${ERROR_NOTICE_ID} .btr-error-details{display:none!important;padding:0 15px 14px!important;border-top:1px solid #2f3136!important}
        #${ERROR_NOTICE_ID}[data-expanded="true"] .btr-error-details{display:block!important}
        #${ERROR_NOTICE_ID} .btr-error-log{margin:11px 0 12px!important;padding:10px!important;border:0!important;border-radius:4px!important;background:#222328!important;color:#c9ccd0!important;font:12px/1.6 Consolas,"Microsoft YaHei",monospace!important;white-space:pre-wrap!important;overflow-wrap:anywhere!important;user-select:text!important}
        #${ERROR_NOTICE_ID} .btr-error-retry{height:30px!important;margin:0!important;padding:0 13px!important;border:1px solid #a44949!important;border-radius:3px!important;background:#713b3b!important;color:#fff!important;font:700 12px/28px Tahoma,"Microsoft YaHei",sans-serif!important;cursor:pointer!important}
        #${ERROR_NOTICE_ID} .btr-error-retry:hover{background:#8a4545!important}
        #${ERROR_NOTICE_ID} .btr-error-retry:disabled{background:#6b4b55!important;color:#d8c5cb!important;cursor:default!important}
      `;
      (document.head || document.documentElement).append(style);
    }

    let notice = document.getElementById(ERROR_NOTICE_ID);
    if (!notice) {
      notice = document.createElement("section");
      notice.id = ERROR_NOTICE_ID;
      notice.dataset.expanded = "false";
      notice.setAttribute("role", "alert");
      notice.setAttribute("aria-live", "assertive");
      notice.setAttribute("aria-atomic", "true");

      const summary = document.createElement("div");
      summary.className = "btr-error-summary";
      const title = document.createElement("p");
      title.className = "btr-error-title";
      title.textContent = "BTR 提示";
      const description = document.createElement("p");
      description.className = "btr-error-description";
      description.textContent = "没能接管这个视频。";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "btr-error-toggle";
      toggle.textContent = "检查错误日志";
      toggle.setAttribute("aria-expanded", "false");
      summary.append(title, description, toggle);

      const details = document.createElement("div");
      details.className = "btr-error-details";
      const log = document.createElement("pre");
      log.className = "btr-error-log";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btr-error-retry";
      retry.textContent = "重新接管";
      details.append(log, retry);
      notice.append(summary, details);

      toggle.addEventListener("click", () => {
        const expanded = notice.dataset.expanded !== "true";
        notice.dataset.expanded = String(expanded);
        toggle.setAttribute("aria-expanded", String(expanded));
      });
      retry.addEventListener("click", () => {
        retry.disabled = true;
        retry.textContent = "正在重新接管…";
        window.postMessage({ channel: CHANNEL, type: "retry-takeover" }, "*");
        setTimeout(() => {
          if (!retry.isConnected) return;
          retry.disabled = false;
          retry.textContent = "重新接管";
        }, 1800);
      });
      mount.append(notice);
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches) errorNoticeMotion = notice.animate([{ opacity: 0, transform: "translateX(-32px)" }, { opacity: 1, transform: "translateX(0)" }], { duration: 600, easing: "cubic-bezier(.2,.75,.25,1)" });
    }

    if (notice.dataset.leaving === "true") {
      errorNoticeMotion?.cancel();
      errorNoticeMotion = null;
      delete notice.dataset.leaving;
      notice.style.removeProperty("pointer-events");
    }
    notice.dataset.errorId = error.id;
    const log = notice.querySelector(".btr-error-log");
    if (log) {
      log.textContent = [
        `当前 URL：${String(location.href).slice(0, 2048)}`,
        `时间：${formatErrorTime(error.at)}`,
        `阶段：${error.stage || "unknown"}`,
        `路由：${error.route || "未知"}`,
        `错误：${error.message}`,
        `重试次数：${error.retryCount}`
      ].join("\n");
    }
  }

  chrome.storage.sync.get(null, (stored) => {
    latestSettings = normalizeStoredSettings({ ...DEFAULTS, ...stored });
    const retired = RETIRED_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(stored, key));
    if (retired.length) chrome.storage.sync.remove(retired);
    const changed = Object.keys(DEFAULTS).filter((key) => JSON.stringify(stored[key]) !== JSON.stringify(latestSettings[key]));
    if (changed.length) chrome.storage.sync.set(Object.fromEntries(changed.map((key) => [key, latestSettings[key]])));
    loaded = true;
    notices?.configure(latestSettings);
    syncTakeoverErrorNotice();
    postSettings();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    for (const key of Object.keys(DEFAULTS)) {
      if (changes[key]) latestSettings[key] = changes[key].newValue;
    }
    latestSettings = normalizeStoredSettings(latestSettings);
    loaded = true;
    notices?.configure(latestSettings);
    syncTakeoverErrorNotice();
    postSettings();
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.channel !== CHANNEL) return;
    if (event.data.type === "playback-notice") {
      notices?.playback(event.data.payload);
      return;
    }
    if (event.data.type === "debug-notices") {
      notices?.logs(event.data.payload);
      return;
    }
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
    if (event.data.type !== "stats") return;
    const input = event.data.payload;
    if (!input || typeof input !== "object") return;
    latestStats = {
      version: String(input.version || ""),
      architecture: String(input.architecture || ""),
      mode: ["overseas", "custom"].includes(input.mode) ? input.mode : "mainland",
      playerState: String(input.playerState || "waiting").slice(0, 32),
      quality: String(input.quality || "").slice(0, 24),
      bufferedAhead: Math.max(0, Number(input.bufferedAhead) || 0),
      acceleratedRequests: Math.max(0, Number(input.acceleratedRequests) || 0),
      acceleratedBytes: Math.max(0, Number(input.acceleratedBytes) || 0),
      parallelSubrequests: Math.max(0, Number(input.parallelSubrequests) || 0),
      activeThreads: Math.max(0, Number(input.activeThreads) || 0),
      totalSpeedBps: Math.max(0, Number(input.totalSpeedBps) || 0),
      discoveredCdns: Math.max(0, Number(input.discoveredCdns) || 0),
      healthyCdns: Math.max(0, Number(input.healthyCdns) || 0),
      blockedCdns: Math.max(0, Number(input.blockedCdns) || 0),
      lastHost: String(input.lastHost || "").slice(0, 120),
      lastError: String(input.lastError || "").replace(/[·•‧∙⋅]+/g, "，").slice(0, 180),
      takeoverError: normalizeTakeoverError(input.takeoverError),
      cdnHosts: Array.isArray(input.cdnHosts) ? input.cdnHosts.slice(0, 32).map((item) => ({
        host: String(item?.host || "").slice(0, 120),
        state: ["healthy", "blocked", "banned", "untested"].includes(item?.state) ? item.state : "untested"
      })) : [],
      threadSpeeds: Array.isArray(input.threadSpeeds) ? input.threadSpeeds.slice(0, 512).map((item) => ({
        id: Number(item?.id) || 0,
        label: String(item?.label || "").slice(0, 12),
        kind: ["video", "audio", "meta"].includes(item?.kind) ? item.kind : "video",
        loaded: Math.max(0, Number(item?.loaded) || 0),
        totalBytes: Math.max(0, Number(item?.totalBytes) || 0),
        bps: Math.max(0, Number(item?.bps) || 0),
        state: ["active", "done", "error"].includes(item?.state) ? item.state : "active",
        host: String(item?.host || "").slice(0, 120)
      })) : []
    };
    syncTakeoverErrorNotice();
  });
})();
}

/* user_scripts/adapter/loader.js */
// Runs wherever the userscript manager puts the script. The accelerator itself has to run in
// the bilibili page, so pageCode is started there. The manager's menu only sends a page
// event that opens the settings panel.
const LOADED = "data-btr-userscript";
const pageWindow = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;

// The settings live in the manager's storage, which every bilibili subdomain shares; this
// site's localStorage is separate on each one, so a setting changed on space.bilibili.com
// never reached the video pages. Only this side of the script can use the manager's storage:
// the page code (storage-shim.js) asks for it with events carrying JSON text. The first time,
// what this subdomain's localStorage held is taken over; it stays there too.
const STORAGE_MARK = "data-btr-userscript-storage";
const manager = typeof GM !== "undefined" && typeof GM?.getValue === "function" && typeof GM?.setValue === "function" ? GM : null;
const managerReportsChanges = typeof GM_addValueChangeListener === "function";

function answerPage(type, message) {
  document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(message) }));
}

function serveStorage() {
  const read = async (area) => {
    const stored = await manager.getValue(area);
    if (typeof stored === "string") return stored;
    let earlier = null;
    try { earlier = localStorage.getItem(`BTR_Userscript.${area}`); } catch (_error) {}
    if (earlier) await manager.setValue(area, earlier);
    return earlier || "{}";
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
if (manager) serveStorage();

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

// The page code reads this mark once, when it starts, to know whether its settings go
// through the manager ("live": the manager also reports other tabs' changes).
function start() {
  if (manager) document.documentElement.setAttribute(STORAGE_MARK, managerReportsChanges ? "manager live" : "manager");
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

// The script now runs in live-site iframes too; the manager menu entry stays one per tab.
let topLevelFrame = true;
try { topLevelFrame = window.self === window.top; } catch (_error) {}
if (typeof GM_registerMenuCommand === "function" && topLevelFrame) {
  GM_registerMenuCommand("线程撕裂者设置", () => document.dispatchEvent(new CustomEvent("btr-userscript-open-settings")));
}
})();
