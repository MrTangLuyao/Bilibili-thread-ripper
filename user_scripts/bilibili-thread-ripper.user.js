// ==UserScript==
// @name         Bilibili 线程撕裂者
// @namespace    https://github.com/MrTangLuyao/Bilibili-thread-ripper
// @version      0.9.1.4
// @description  保留哔哩哔哩原生播放器，通过多 CDN、多 Range 并发下载改善视频缓冲速度。
// @author       MrTangLuyao
// @license      MIT
// @homepageURL  https://github.com/MrTangLuyao/Bilibili-thread-ripper
// @supportURL   https://github.com/MrTangLuyao/Bilibili-thread-ripper/issues
// @updateURL    https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper/main/user_scripts/bilibili-thread-ripper.user.js
// @downloadURL  https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper/main/user_scripts/bilibili-thread-ripper.user.js
// @match        https://www.bilibili.com/*
// @match        https://m.bilibili.com/*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_addElement
// @grant        unsafeWindow
// @sandbox      JavaScript
// @inject-into  content
// @noframes
// ==/UserScript==

// 这个文件由 scripts/build-userscript.ps1 生成，不要直接修改。
(function () {
"use strict";

function pageCode() {
"use strict";
if (document.documentElement?.hasAttribute("data-btr-userscript")) return;
document.documentElement?.setAttribute("data-btr-userscript", "");

/* user_scripts/adapter/storage-shim.js */
// Userscripts have no extension storage. This small stand-in keeps the parts of the
// chrome.* API that bridge.js uses and saves settings in this site's localStorage.
// Changes made in another bilibili tab arrive through the storage event.
const chrome = (() => {
  const PREFIX = "BTR_Userscript.";
  const listeners = new Set();
  const parse = (text) => {
    try {
      const value = JSON.parse(text || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (_error) {
      return {};
    }
  };
  const read = (area) => {
    try { return parse(localStorage.getItem(PREFIX + area)); }
    catch (_error) { return {}; }
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
  const messageListeners = new Set();
  const runtime = {
    lastError: null,
    sendMessage: () => Promise.resolve(),
    onMessage: { addListener: (listener) => messageListeners.add(listener) },
    // The settings page asks bridge.js for live status, as the sidebar does in the extension.
    dispatch(message) {
      return new Promise((resolve) => {
        let answered = false;
        const sendResponse = (response) => { if (!answered) { answered = true; resolve(response); } };
        for (const listener of messageListeners) listener(message, {}, sendResponse);
        if (!answered) resolve(undefined);
      });
    }
  };
  // Callers either pass a callback and read runtime.lastError, or await the promise.
  const finish = (value, callback, error = null) => {
    if (typeof callback !== "function") return error ? Promise.reject(error) : Promise.resolve(value);
    queueMicrotask(() => {
      runtime.lastError = error ? { message: String(error.message || error) } : null;
      try { callback(value); }
      finally { runtime.lastError = null; }
    });
    return Promise.resolve(value);
  };
  const write = (area, next) => {
    const before = read(area);
    try { localStorage.setItem(PREFIX + area, JSON.stringify(next)); }
    catch (error) { return error; }
    queueMicrotask(() => notify(diff(before, next), area));
    return null;
  };
  const storageArea = (area) => ({
    get(keys, callback) {
      const stored = read(area);
      let value;
      if (keys === null || keys === undefined) value = { ...stored };
      else if (typeof keys === "string") value = keys in stored ? { [keys]: stored[keys] } : {};
      else if (Array.isArray(keys)) value = Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]]));
      else value = Object.fromEntries(Object.keys(keys).map((key) => [key, key in stored ? stored[key] : keys[key]]));
      return finish(value, callback);
    },
    set(items, callback) {
      return finish(undefined, callback, write(area, { ...read(area), ...items }));
    },
    remove(keys, callback) {
      const next = read(area);
      for (const key of [].concat(keys)) delete next[key];
      return finish(undefined, callback, write(area, next));
    }
  });
  addEventListener("storage", (event) => {
    if (!event.key?.startsWith(PREFIX)) return;
    notify(diff(parse(event.oldValue), parse(event.newValue)), event.key.slice(PREFIX.length));
  });
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

  function normalizeSettings(input) {
    const source = input && typeof input === "object" ? input : {};
    const allowed = [4, 8, 16, 32, 64, 128];
    const requested = Math.trunc(Number(source.concurrency));
    const danmakuSource = source.danmaku && typeof source.danmaku === "object" ? source.danmaku : {};
    const allowedAreas = ["quarter", "half", "threeQuarter", "full"];
    const allowedSpeeds = [1, 2.5, 5, 7.5, 10];
    const requestedSpeed = Number(danmakuSource.speed);
    const requestedModes = Array.isArray(danmakuSource.modes)
      ? [...new Set(danmakuSource.modes.map(Number).filter((value) => [0, 1, 2].includes(value)))]
      : [0, 1, 2];
    const requestedColor = String(danmakuSource.color || "").toUpperCase();
    const danmaku = {
      visible: danmakuSource.visible !== false,
      opacity: Math.max(0, Math.min(1, Number.isFinite(Number(danmakuSource.opacity)) ? Number(danmakuSource.opacity) : 0.9)),
      area: allowedAreas.includes(danmakuSource.area) ? danmakuSource.area : "threeQuarter",
      fontSize: Math.max(12, Math.min(64, Math.round(Number(danmakuSource.fontSize ?? source.danmakuFontSize) || 25))),
      speed: allowedSpeeds.includes(requestedSpeed) ? requestedSpeed : 5,
      modes: requestedModes,
      antiOverlap: danmakuSource.antiOverlap !== false,
      synchronousPlayback: danmakuSource.synchronousPlayback !== false,
      mode: [0, 1, 2].includes(Number(danmakuSource.mode)) ? Number(danmakuSource.mode) : 0,
      color: /^#[0-9A-F]{6}$/.test(requestedColor) ? requestedColor : "#FFFFFF"
    };
    const mode = source.mode === "overseas" ? "overseas" : "mainland";
    const compatibilityMode = ["a", "b"].includes(String(source.compatibilityMode || "").toLowerCase())
      ? String(source.compatibilityMode).toLowerCase()
      : "off";
    const requestedVolume = Number(source.volume);
    return {
      enabled: source.enabled !== false,
      mode,
      compatibilityMode,
      debugNotices: source.debugNotices === true,
      errorNotices: source.errorNotices === true,
      debugCategories: Object.fromEntries(["takeover", "playback", "download", "buffer", "settings", "other"].map(key => [key, source.debugCategories?.[key] !== false])),
      concurrency: allowed.includes(requested) ? requested : 8,
      volume: Number.isFinite(requestedVolume) ? Math.max(0, Math.min(1, requestedVolume)) : 0.7,
      subtitleLanguage: /^[\w-]+$/i.test(String(source.subtitleLanguage || "off"))
        ? String(source.subtitleLanguage).slice(0, 48)
        : "off",
      subtitleLastLanguage: /^[\w-]+$/i.test(String(source.subtitleLastLanguage || ""))
        && String(source.subtitleLastLanguage).toLowerCase() !== "off"
        ? String(source.subtitleLastLanguage).slice(0, 48)
        : "",
      danmaku,
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
    if (!GLOBAL_HOSTS.includes(host)) return null;
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

  function representationUrls(representation, mode) {
    const primary = representation?.baseUrl || representation?.base_url;
    const backup = representation?.backupUrl || representation?.backup_url || representation?.backup_url_list || [];
    const originals = [primary, ...(Array.isArray(backup) ? backup : [])]
      .map(safeMediaUrl)
      .filter(Boolean)
      .filter((value, index, all) => all.indexOf(value) === index);
    const hosts = mode === "mainland" ? MAINLAND_HOSTS : OVERSEAS_HOSTS;
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
    const allowedOriginals = mode === "mainland"
      ? originals.filter((url) => MAINLAND_HOSTS.includes(new URL(url).hostname.toLowerCase()))
      : originals.filter((url) => !MAINLAND_HOSTS.includes(new URL(url).hostname.toLowerCase()));
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
  // A node that delivers one address and refuses another that other nodes do serve loses only
  // that address: banning the node took away the fastest one of an Akamai-only account.
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
      delivered: (url) => goodAddresses.has(addressOf(url)),
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

  // What the downloads have measured about each node: how long the first byte takes and how
  // fast one connection runs. The owner shares one of these between every resolver on the
  // page, so the audio track, another quality and the session after a seek start from what is
  // already known instead of trying every node again.
  function createNodeStats() {
    const nodes = new Map();
    const blend = (old, value) => (old ? old * 0.7 + value * 0.3 : value);

    function node(url) {
      const host = hostOf(url);
      let item = nodes.get(host);
      if (!item) {
        item = { inflight: 0, receiving: 0, ttfbMs: 0, bps: 0, load: 0, limit: Infinity };
        nodes.set(host, item);
      }
      return item;
    }

    // The speed of one connection was measured while the node carried `load` of them. Beyond
    // that the node is assumed to share the same total; if it keeps its speed instead, the
    // next measurements raise `load` and the estimate follows. A node is taken to carry at
    // least four connections at full speed, which is the reason to split a download at all.
    function expectedMs(url, pieceBytes) {
      const item = node(url);
      if (!item.bps) return null;
      const width = Math.max(4, item.load);
      const bps = item.bps * width / Math.max(width, item.inflight + 1);
      return item.ttfbMs + pieceBytes / bps * 1000;
    }

    return Object.freeze({
      begin(url) { node(url).inflight += 1; },
      firstByte(url, ttfbMs) {
        const item = node(url);
        item.receiving += 1;
        item.ttfbMs = blend(item.ttfbMs, Math.max(1, ttfbMs));
      },
      end(url, receiving) {
        const item = node(url);
        item.inflight = Math.max(0, item.inflight - 1);
        if (receiving) item.receiving = Math.max(0, item.receiving - 1);
      },
      body(url, bytes, milliseconds) {
        // An index of a few KB arrives within one packet and says nothing about speed.
        if (bytes < 32 * 1024) return;
        const item = node(url);
        item.bps = blend(item.bps, bytes / Math.max(0.02, milliseconds / 1000));
        item.load = blend(item.load, item.inflight);
      },
      silent(url, waitedMs) {
        const item = node(url);
        // No first byte although the node was sending other pieces: the request was waiting
        // in the browser, which opens six connections to an HTTP/1.1 node. What the node was
        // carrying at that moment is all it is given from now on.
        if (item.receiving > 0) item.limit = Math.min(item.limit, item.receiving);
        else item.ttfbMs = blend(item.ttfbMs, waitedMs);
      },
      // The other copy of the piece won before this node had sent anything. How long it had
      // been waiting is the least its first byte would have taken.
      outrun(url, waitedMs) {
        const item = node(url);
        if (waitedMs > item.ttfbMs) item.ttfbMs = blend(item.ttfbMs, waitedMs);
      },
      // The other copy won while this node was still sending. A transfer that is outrun never
      // reaches body(), so a node that answers at once and then trickles would keep the speed
      // it showed on a part of the file it had ready, and keep getting most of the pieces.
      crawl(url, bytes, milliseconds) {
        const item = node(url);
        const bps = bytes / Math.max(0.02, milliseconds / 1000);
        if (milliseconds >= 300 && bps < item.bps) item.bps = blend(item.bps, bps);
      },
      full: (url) => node(url).inflight >= node(url).limit,
      // A node that is sending other pieces is alive, whatever happened to this one.
      busy: (url) => node(url).receiving > 0,
      known: (url) => node(url).bps > 0,
      inflight: (url) => node(url).inflight,
      ttfbMs: (url) => node(url).ttfbMs,
      expectedMs,
      bps: (url) => node(url).bps,
      dump: () => Object.fromEntries([...nodes].map(([host, item]) => [host, {
        ttfbMs: Math.round(item.ttfbMs), kbps: Math.round(item.bps / 1024), load: Math.round(item.load * 10) / 10,
        limit: Number.isFinite(item.limit) ? item.limit : null, inflight: item.inflight
      }]))
    });
  }

  function createResolver(representation, getMode, bans = null, nodeStats = createNodeStats()) {
    const health = new Map();
    let cursor = 0;
    let mediaRangeCount = 0;
    let rangeCursor = 0;

    function allUrls() {
      return representationUrls(representation, getMode?.() === "overseas" ? "overseas" : "mainland");
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
        .sort((a, b) => {
          const ah = health.get(a) || {};
          const bh = health.get(b) || {};
          return Number(Boolean(bh.lastSuccessAt)) - Number(Boolean(ah.lastSuccessAt)) ||
            (bh.bps || 0) - (ah.bps || 0);
        });
      if (!pool.length) return urls();
      const firstRange = mediaRangeCount === 0;
      const width = Math.min(firstRange ? pool.length : 3, pool.length);
      let selected;
      const warmupRanges = getMode?.() === "mainland" ? 1 : 4;
      if (mediaRangeCount < warmupRanges) {
        selected = pool.slice(0, width);
        rangeCursor = width % pool.length;
      } else {
        const offset = rangeCursor % pool.length;
        const rotated = pool.slice(offset).concat(pool.slice(0, offset));
        selected = rotated.slice(0, width);
        rangeCursor = (rangeCursor + width) % pool.length;
      }
      mediaRangeCount += 1;
      return selected;
    }

    function startupCandidates() {
      const now = Date.now();
      const primary = representation?.baseUrl || representation?.base_url;
      const backup = representation?.backupUrl || representation?.backup_url || representation?.backup_url_list || [];
      const originals = [primary, ...(Array.isArray(backup) ? backup : [])]
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
        .sort((a, b) => {
          const ah = health.get(a) || {};
          const bh = health.get(b) || {};
          return Number(Boolean(bh.lastSuccessAt)) - Number(Boolean(ah.lastSuccessAt)) ||
            (bh.bps || 0) - (ah.bps || 0);
        });
    }

    function success(url, bps) {
      bans?.success?.(url);
      const old = health.get(url) || {};
      health.set(url, {
        failures: 0,
        blockedUntil: 0,
        lastSuccessAt: Date.now(),
        bps: old.bps ? old.bps * 0.65 + bps * 0.35 : bps
      });
    }

    // The address expected to deliver a piece of this size first, counting what each node is
    // already carrying. A node nothing is known about is tried with one piece at a time.
    //
    // `hurry` is set while the player has next to nothing buffered. One measurement must not
    // decide where a whole segment goes then: a node that answered the first request of a
    // video at once may need seconds for a part of the file it has not served lately. So the
    // pieces are spread, unknown nodes take their share, and no node gets more than half.
    function pick(candidates, tried, pieceBytes, hurry = false) {
      const now = Date.now();
      const untried = candidates.filter((url) => !tried.has(url));
      const open = untried.filter((url) => allows(url));
      const ready = (open.length ? open : untried).filter((url) => (health.get(url)?.blockedUntil || 0) <= now);
      const pool = ready.length ? ready : open.length ? open : untried;
      const known = pool.map((url) => nodeStats.expectedMs(url, pieceBytes)).filter((value) => value !== null);
      const best = known.length ? Math.min(...known) : 0;
      const hosts = new Set(pool.map(hostOf));
      const carried = [...hosts].reduce((sum, host) => sum + nodeStats.inflight(`https://${host}/`), 0);
      let chosen = null;
      let chosenCost = Infinity;
      for (const url of pool) {
        const inflight = nodeStats.inflight(url);
        const expected = nodeStats.expectedMs(url, pieceBytes);
        let cost = expected;
        if (expected === null) cost = !known.length ? inflight : hurry ? best * 2 * (inflight + 1) : !inflight ? best * 0.9 : best * 4 + inflight;
        if (hurry && hosts.size > 2 && inflight >= 2 && inflight * 2 > carried) cost += 1e5;
        // The addresses of one node cost the same; the one that has delivered goes first.
        if (bans?.delivered && !bans.delivered(url)) cost += 1;
        if (nodeStats.full(url)) cost += 1e6;
        if (cost < chosenCost) {
          chosen = url;
          chosenCost = cost;
        }
      }
      return chosen;
    }

    // Small pieces cost a round trip each, and from far away that is most of their time: 64 KiB
    // from a node 300 ms away that sends 3 MB/s is 300 ms of waiting for 20 ms of data, which
    // made the nearest node look best however slow it was. A piece is sized to keep the
    // fastest usable node sending for about 150 ms.
    function pieceBytes(minimum) {
      const fastest = Math.max(0, ...urls().map((url) => nodeStats.bps(url)));
      return Math.max(minimum, Math.min(512 * 1024, Math.round(fastest * 0.15)));
    }

    // `busy` is a first byte that never came from a node that was sending other pieces at the
    // time. The request was waiting in the browser (six connections per node over HTTP/1.1),
    // so it says nothing against the node.
    function failure(url, error, receivedBytes = 0, busy = false) {
      if (error?.name === "AbortError" || busy) return;
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
          state: nodeBanned ? "banned" : (item.blockedUntil || 0) > now ? "blocked" : item.lastSuccessAt ? "healthy" : "untested",
          bps: item.bps || 0
        };
      });
    }

    const allows = (url) => !bans || bans.allows(url);
    return Object.freeze({ allows, failure, nodes: nodeStats, ordered, pick, pieceBytes, rangeCandidates, rescueCandidates, startupCandidates, status, success, urls });
  }

  root.__BILI_CDN_RESOLVER_FACTORY__ = Object.freeze({
    GLOBAL_HOSTS,
    MAINLAND_HOSTS,
    OVERSEAS_HOSTS,
    createBanList,
    createNodeStats,
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
  const DUPLICATE_CANCELED = "并发副本已取消";
  const NO_ADDRESS = "没有可用 CDN";

  function abortError(reason) {
    if (reason instanceof Error || reason instanceof DOMException) return reason;
    return new DOMException("播放器任务已取消", "AbortError");
  }

  class Semaphore {
    constructor(limit) {
      this.limit = limit;
      this.active = 0;
      this.queue = [];
    }

    setLimit(limit) {
      this.limit = Math.max(1, Math.min(512, Math.trunc(limit) || 1));
      this.drain();
    }

    // A priority can be a function: the second copy of a piece only becomes urgent once that
    // piece is what the player is waiting for, which can happen while it is still queued.
    drain() {
      while (this.active < this.limit && this.queue.length) {
        let best = 0;
        for (let index = 1; index < this.queue.length; index += 1) {
          if (this.queue[index].priority() > this.queue[best].priority()) best = index;
        }
        const entry = this.queue.splice(best, 1)[0];
        entry.signal?.removeEventListener("abort", entry.canceled);
        this.active += 1;
        entry.resolve(() => {
          if (entry.released) return;
          entry.released = true;
          this.active = Math.max(0, this.active - 1);
          this.drain();
        });
      }
    }

    acquire(signal, priority = 0) {
      if (signal?.aborted) return Promise.reject(abortError(signal.reason));
      return new Promise((resolve, reject) => {
        const entry = {
          reject,
          resolve,
          signal,
          released: false,
          priority: typeof priority === "function" ? priority : () => Number(priority) || 0,
          canceled: () => {
            const at = this.queue.indexOf(entry);
            if (at >= 0) this.queue.splice(at, 1);
            reject(abortError(signal.reason));
          }
        };
        signal?.addEventListener("abort", entry.canceled, { once: true });
        this.queue.push(entry);
        this.drain();
      });
    }
  }

  function createDownloader(options) {
    const nativeFetch = options.nativeFetch || root.fetch.bind(root);
    const getSettings = options.getSettings;
    const onTransfer = typeof options.onTransfer === "function" ? options.onTransfer : () => null;
    const semaphore = new Semaphore(core.normalizeSettings(getSettings()).concurrency);
    // duplicateBytes is what arrived on a second copy of a piece before the other copy won.
    const counters = { requests: 0, copies: 0, bytes: 0, duplicateBytes: 0 };
    // The last requests, for the diagnostic report: when, which node, how long until the first
    // byte and until the end, and how it ended.
    const recent = [];
    function remember(entry) {
      recent.push(entry);
      if (recent.length > 400) recent.shift();
    }

    async function readBody(response, controller, transferId, settings, received) {
      if (!response.body?.getReader) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        received.bytes += bytes.byteLength;
        onTransfer({ phase: "progress", id: transferId, bytes: bytes.byteLength });
        return bytes;
      }
      const reader = response.body.getReader();
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
          if (done) break;
          armStall();
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          chunks.push(chunk);
          total += chunk.byteLength;
          received.bytes += chunk.byteLength;
          received.lastByteAt = performance.now();
          onTransfer({ phase: "progress", id: transferId, bytes: chunk.byteLength });
        }
      } finally {
        clearTimeout(stallTimer);
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

    // `choose` names the address only once a thread is free. More is known about the nodes by
    // then than when the piece joined the queue, and a fast node ends up with more pieces.
    async function attempt(piece, choose, signal, kind, resolver, priority = 0, watch = null) {
      const settings = core.normalizeSettings(getSettings());
      const release = await semaphore.acquire(signal, priority);
      const url = choose();
      if (!url) {
        release();
        throw new Error(NO_ADDRESS);
      }
      const nodes = resolver.nodes || null;
      let receiving = false;
      nodes?.begin(url);
      counters.requests += 1;
      const controller = new AbortController();
      const cancel = () => controller.abort(abortError(signal?.reason));
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
      const firstByteTimer = setTimeout(() => controller.abort(new DOMException("CDN 首字节超时", "TimeoutError")), settings.firstByteTimeoutMs);
      const totalTimer = setTimeout(() => controller.abort(new DOMException("CDN 子块总耗时超限", "TimeoutError")), settings.attemptTimeoutMs);
      const transferId = onTransfer({ phase: "start", kind, totalBytes: piece.length, url });
      const startedAt = performance.now();
      const received = watch || { bytes: 0 };
      received.url = url;
      received.startedAt = startedAt;
      try {
        const response = await nativeFetch(url, {
          method: "GET",
          headers: { Range: `bytes=${piece.start}-${piece.end}` },
          credentials: "omit",
          cache: "no-store",
          mode: "cors",
          referrer: root.location?.href,
          referrerPolicy: "strict-origin-when-cross-origin",
          signal: controller.signal
        });
        clearTimeout(firstByteTimer);
        const firstByteAt = performance.now();
        receiving = true;
        received.firstByteAt = received.lastByteAt = firstByteAt;
        nodes?.firstByte(url, firstByteAt - startedAt);
        const contentRange = core.parseContentRange(response.headers.get("content-range"));
        if (response.status !== 206 || !contentRange || contentRange.start !== piece.start || contentRange.end !== piece.end) {
          // The status tells a refused signed address (4xx) apart from a node that is down.
          throw Object.assign(new Error(`Range 校验失败：HTTP ${response.status}`), { status: response.status });
        }
        const bytes = await readBody(response, controller, transferId, settings, received);
        if (bytes.byteLength !== piece.length) throw new Error(`子块长度不符：${bytes.byteLength}/${piece.length}`);
        const seconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
        nodes?.body(url, bytes.byteLength, performance.now() - firstByteAt);
        resolver.success(url, bytes.byteLength / seconds);
        counters.bytes += bytes.byteLength;
        remember({ at: Math.round(startedAt), kind, node: new URL(url).hostname, bytes: piece.length, firstByteMs: Math.round(firstByteAt - startedAt), ms: Math.round(performance.now() - startedAt), end: "ok" });
        onTransfer({ phase: "done", id: transferId });
        return { bytes, total: contentRange.total, url };
      } catch (error) {
        const outrun = controller.signal.reason?.message === DUPLICATE_CANCELED;
        const silent = !receiving && error?.name === "TimeoutError";
        const busy = silent && Boolean(nodes?.busy(url));
        if (silent) nodes?.silent(url, performance.now() - startedAt);
        if (outrun) counters.duplicateBytes += received.bytes;
        if (outrun && !receiving) nodes?.outrun?.(url, performance.now() - startedAt);
        if (outrun && receiving) nodes?.crawl?.(url, received.bytes, performance.now() - received.firstByteAt);
        remember({ at: Math.round(startedAt), kind, node: new URL(url).hostname, bytes: piece.length, firstByteMs: received.firstByteAt ? Math.round(received.firstByteAt - startedAt) : null, ms: Math.round(performance.now() - startedAt), end: outrun ? "other copy won" : String(error?.message || error).slice(0, 60) });
        // Received bytes tell a dead node (0 KiB) apart from a transfer that stalled midway.
        resolver.failure(url, error, received.bytes, busy);
        const canceled = error?.name === "AbortError";
        onTransfer({ phase: canceled ? "cancel" : "error", id: transferId, error });
        received.failed = true;
        received.wake?.();
        throw error;
      } finally {
        clearTimeout(firstByteTimer);
        clearTimeout(totalTimer);
        signal?.removeEventListener("abort", cancel);
        nodes?.end(url, receiving);
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
      const preferredOffset = preferred.length ? (piece.index + round) % preferred.length : 0;
      const rotatedPreferred = preferred.slice(preferredOffset).concat(preferred.slice(0, preferredOffset));
      const rescue = (typeof resolver.rescueCandidates === "function" ? resolver.rescueCandidates() : resolver.ordered(piece.index))
        .filter((url) => !rotatedPreferred.includes(url));
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

    // Settles once a second copy of the piece is worth its bandwidth: the first byte is
    // taking far longer than this node usually needs, the transfer has stopped, or it is
    // heading for several times the expected duration. A fixed delay copied every piece
    // that was merely not finished yet, and the copies took the bandwidth it was short of.
    function overdue(watch, piece, resolver, settings, startup, signal) {
      return new Promise((resolve) => {
        const nodes = resolver.nodes || null;
        let timer = setTimeout(check, 150);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        function check() {
          timer = setTimeout(check, 150);
          if (!watch.startedAt) return;
          const now = performance.now();
          const elapsed = now - watch.startedAt;
          if (!watch.firstByteAt) {
            const usual = nodes?.ttfbMs(watch.url) || 0;
            // With next to nothing buffered a second copy costs less than the wait: a node can
            // take seconds over a part of the file it has not served lately.
            const budget = startup
              ? (usual ? Math.min(600, Math.max(250, usual * 2)) : 250)
              : usual ? Math.min(3000, Math.max(600, usual * 3)) : settings.hedgeDelayMs;
            if (elapsed >= budget) done();
            return;
          }
          if (now - watch.lastByteAt >= (startup ? 1000 : 1500)) return done();
          const expected = nodes?.expectedMs(watch.url, piece.length) || settings.hedgeDelayMs;
          const allowed = startup ? Math.max(400, expected * 2) : Math.max(settings.hedgeDelayMs, expected * 3);
          if (elapsed >= allowed && watch.bytes < piece.length * 0.75) done();
        }
        watch.wake = done;
        if (signal.aborted) done();
        else signal.addEventListener("abort", done, { once: true });
      });
    }

    // `urgent` tells whether the player is waiting for this very piece. Only then may its
    // second copy go ahead of pieces that have not been asked for at all.
    async function downloadPiece(piece, resolver, signal, kind, preferredUrls, startupMode = false, priority = 0, urgent = null) {
      const settings = core.normalizeSettings(getSettings());
      const allowed = (url) => typeof resolver.allows !== "function" || resolver.allows(url);
      const startup = startupMode === true || startupMode === "probe";
      const startedAt = performance.now();
      let lastError = null;

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
        const tried = new Set();
        // A node banned while this piece was waiting is skipped, unless only banned nodes are left.
        const choose = () => {
          if (tried.size >= limit) return null;
          const untried = candidates.filter((url) => !tried.has(url));
          const url = typeof resolver.pick === "function"
            ? resolver.pick(candidates, tried, piece.length, startup)
            : untried.find(allowed) || untried[0];
          if (url) tried.add(url);
          return url || null;
        };
        // With nothing known about any node yet, the first piece of a video is asked of all
        // of them at once: the fastest answer starts playback and every node gets measured.
        const race = startupMode === "probe" && !candidates.some((url) => resolver.nodes?.known(url));
        while (tried.size < limit) {
          if (signal?.aborted) throw abortError(signal.reason);
          const before = tried.size;
          const controllers = Array.from({ length: race ? limit : startup ? 3 : 2 }, () => new AbortController());
          const cancelAll = () => controllers.forEach((controller) => controller.abort(abortError(signal?.reason)));
          if (signal?.aborted) cancelAll();
          else signal?.addEventListener("abort", cancelAll, { once: true });
          // Each copy is watched by the next one: with little buffered, a second copy that
          // trickles like the first gets a third.
          const watches = controllers.map(() => ({ bytes: 0 }));
          const attempts = controllers.map((controller, copy) => (async () => {
            if (copy && !race) {
              await overdue(watches[copy - 1], piece, resolver, settings, startup, controller.signal);
              if (controller.signal.aborted) throw abortError(controller.signal.reason);
              if (!watches[copy - 1].failed) counters.copies += 1;
            }
            const copyPriority = copy && !race ? () => (startup || !urgent || urgent() ? priority + 20 : priority - 100) : priority;
            return attempt(piece, choose, controller.signal, kind, resolver, copyPriority, race ? null : watches[copy]);
          })());
          const cancelCopies = () => {
            signal?.removeEventListener("abort", cancelAll);
            controllers.forEach((controller) => {
              if (!controller.signal.aborted) controller.abort(new DOMException(DUPLICATE_CANCELED, "AbortError"));
            });
          };
          try {
            const winner = await Promise.any(attempts);
            // The other nodes of that first race get a moment to finish their 64 KiB, so that
            // each of them has been measured once. Nodes are not raced again on this page.
            if (race) setTimeout(cancelCopies, 1500);
            else cancelCopies();
            return winner;
          } catch (aggregate) {
            const errors = aggregate?.errors || [aggregate];
            lastError = errors.find((error) => error?.message !== NO_ADDRESS) || errors.at(-1);
            signal?.removeEventListener("abort", cancelAll);
            if (signal?.aborted) throw abortError(signal.reason);
          }
          if (tried.size === before) break;
        }
      }
      throw lastError || new Error(NO_ADDRESS);
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
      return attempt(piece, () => url, controller.signal, kind, resolver, priority);
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
          // The copies used to follow after 120 and 300 ms whatever the node. A node that
          // usually needs longer than that for its first byte got all three every time.
          const step = Math.min(600, Math.max(120, (resolver.nodes?.ttfbMs(candidates[0]) || 0) * 1.5));
          winner = await Promise.any(candidates.map((url, index) => delayedAttempt(
            piece,
            url,
            index === 0 ? 0 : index === 1 ? step : step * 2.5,
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

    async function downloadStartupRange(range, resolver, options) {
      semaphore.setLimit(core.normalizeSettings(getSettings()).concurrency);
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
          .filter((url, index, all) => all.indexOf(url) === index);
        if (typeof resolver.pick === "function") {
          const chosen = new Set();
          while (chosen.size < 3) {
            const url = resolver.pick(candidates, chosen, piece.length);
            if (!url) break;
            chosen.add(url);
          }
          candidates = [...chosen];
        } else candidates = candidates.slice(0, 3);
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

    // The second copy of a piece is urgent when that piece is the one holding up the append,
    // or one of the last few its range is waiting for.
    function trackPieces(count) {
      const finished = new Array(count).fill(false);
      let first = 0;
      let left = count;
      return {
        finish(index) {
          if (finished[index]) return;
          finished[index] = true;
          left -= 1;
          while (finished[first]) first += 1;
        },
        urgent: (index) => index <= first || left <= Math.max(2, count >> 3)
      };
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
      // The head goes first and alone so that every node is raced once. With the nodes known
      // already it is only one more round trip before the rest may start, so it is left out.
      const warm = candidateUrls.some((url) => resolver.nodes?.known(url));
      const headResult = warm ? null : await downloadPiece(
        head,
        resolver,
        options.signal,
        options.kind || "media",
        candidateUrls,
        "probe",
        220
      );
      if (headResult) await options.onOrderedChunk(headResult.bytes, head);
      if (headResult && head.end >= range.end) {
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
        headResult ? head.end + 1 : range.start,
        range.end,
        pieceBudget,
        settings.minChunkBytes
      ).map((piece, index) => ({ ...piece, index: index + (headResult ? 1 : 0) }));
      const ordered = new Array(pieces.length);
      const progress = trackPieces(pieces.length);
      let nextOrderedIndex = 0;
      let flushOperation = Promise.resolve();
      const flushOrdered = () => {
        flushOperation = flushOperation.then(async () => {
          while (ordered[nextOrderedIndex]) {
            const item = ordered[nextOrderedIndex];
            ordered[nextOrderedIndex] = null;
            await options.onOrderedChunk(item.bytes, pieces[nextOrderedIndex]);
            nextOrderedIndex += 1;
          }
        });
        return flushOperation;
      };
      const pendingPieces = pieces.map(async (piece, orderedIndex) => {
        const result = await downloadPiece(
          piece,
          resolver,
          options.signal,
          options.kind || "media",
          headResult ? [headResult.url] : candidateUrls,
          true,
          120 - Math.min(30, piece.index),
          () => progress.urgent(orderedIndex)
        );
        progress.finish(orderedIndex);
        ordered[orderedIndex] = result;
        await flushOrdered();
        return result;
      });
      options.onStartupScheduled?.();
      const results = await Promise.all(pendingPieces);
      await flushOperation;
      const parts = [headResult, ...results].filter(Boolean);
      const totals = parts.map((item) => item.total).filter(Number.isSafeInteger);
      if (totals.length && totals.some((value) => value !== totals[0])) throw new Error("不同 CDN 返回的文件总长度不一致");
      return {
        bytes: null,
        byteLength: range.length,
        pieceCount: parts.length,
        streamed: true,
        total: totals[0] || null,
        hosts: [...new Set(parts.map((item) => new URL(item.url).hostname))]
      };
    }

    async function downloadRange(range, resolver, options = {}) {
      const settings = core.normalizeSettings(getSettings());
      if (options.kind === "meta") return downloadStartupRange(range, resolver, options);
      const parallel = options.parallel !== false;
      if (options.startup === true && parallel && typeof options.onOrderedChunk === "function") {
        return downloadStartupMediaRange(range, resolver, options, settings);
      }
      const preferredUrls = parallel && typeof resolver.rangeCandidates === "function"
        ? resolver.rangeCandidates()
        : resolver.urls();
      const globalConcurrency = parallel ? settings.concurrency : 1;
      const requestedConcurrency = Number.isFinite(Number(options.maxConcurrency))
        ? Math.max(1, Math.trunc(Number(options.maxConcurrency)))
        : globalConcurrency;
      const effectiveConcurrency = parallel ? Math.min(globalConcurrency, requestedConcurrency) : 1;
      // 后台预取可以限制自己的子块数，但不能降低全局信号量上限；
      // 否则一个低优先级预取会把后续播放器的紧急请求也锁在低并发上。
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
        // Right after a seek every node is slow over a part of the file it has not served
        // lately, each in its own way: one takes a second or more for the first byte, another
        // answers at once and then trickles. Many small requests get through that best. Once a
        // few segments are buffered, larger pieces save round trips and requests.
        !parallel ? Number.MAX_SAFE_INTEGER
          : options.hurry === true ? settings.minChunkBytes
            : resolver.pieceBytes?.(settings.minChunkBytes) || settings.minChunkBytes
      );
      const progressive = typeof options.onOrderedChunk === "function";
      const progress = trackPieces(pieces.length);
      const ordered = new Array(pieces.length);
      let nextOrderedIndex = 0;
      let flushOperation = Promise.resolve();
      const flushOrdered = () => {
        flushOperation = flushOperation.then(async () => {
          while (ordered[nextOrderedIndex]) {
            const item = ordered[nextOrderedIndex];
            ordered[nextOrderedIndex] = null;
            await options.onOrderedChunk(item.bytes, pieces[nextOrderedIndex]);
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
          preferredUrls,
          options.startup === true || options.hurry === true,
          basePriority - Math.min(20, piece.index),
          () => progress.urgent(piece.index)
        );
        progress.finish(piece.index);
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

    return Object.freeze({ downloadRange, stats: () => ({ ...counters }), recent: () => recent.slice() });
  }

  root.__BILI_IDM_DOWNLOADER_FACTORY__ = Object.freeze({ createDownloader });
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

  function codecPriority(representation) {
    return { av1: 3, hevc: 2, avc: 1, other: 0 }[codecFamily(representation)] || 0;
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
  // quality the playinfo itself asks for.
  function selectRepresentations(playinfo, preferredQuality = 0) {
    const body = dashBody(playinfo);
    const dash = body?.dash;
    if (!dash) throw new Error("页面没有 DASH 播放清单");
    const byQuality = new Map();
    for (const representation of (dash.video || []).filter((item) => supported(item, "video"))) {
      const key = Number(representation.id) || `${Number(representation.height) || 0}-${Math.round(frameRate(representation))}`;
      const existing = byQuality.get(key);
      if (!existing || codecPriority(representation) > codecPriority(existing) ||
          (codecPriority(representation) === codecPriority(existing) && (Number(representation.bandwidth) || 0) > (Number(existing.bandwidth) || 0))) {
        byQuality.set(key, representation);
      }
    }
    const videos = Array.from(byQuality.values()).sort((a, b) =>
      (Number(b.height) || 0) - (Number(a.height) || 0) || frameRate(b) - frameRate(a) ||
      (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0));
    const audio = (dash.audio || []).filter((item) => supported(item, "audio"))
      .sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0))[0];
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

  function createNativePlayer(options) {
    const getSettings = options.getSettings;
    const video = options.container.querySelector("video");
    if (!video) throw new Error("没有找到 B 站原生 video 元素");
    let currentPlayinfo = options.playinfo;
    let preferredQuality = Math.max(0, Math.trunc(Number(options.preferredQuality)) || 0);
    let selection = selectRepresentations(currentPlayinfo, preferredQuality);
    let selectedVideo = selection.preferred;
    let sessionStarts = 0;
    let session = null;
    let destroyed = false;
    let generationSequence = 0;
    let seekTimer = null;
    let seekReloads = 0;
    let seekRequestedAt = 0;
    let seekStartedAt = 0;
    let seekSettledAt = 0;
    let lastSeekMs = 0;
    let stallsAfterSeek = 0;
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
        track.sourceBuffer.appendBuffer(bytes);
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
        filling: false,
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

    function segmentDownload(candidate, track, segment, index, downloadOptions = {}) {
      return downloader.downloadRange(segment, track.resolver, {
        signal: candidate.controller.signal,
        parallel: true,
        kind: track.kind,
        priority: downloadOptions.priority,
        hurry: downloadOptions.hurry === true,
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
        if (segment) track.prefetches.set(index, segmentDownload(candidate, track, segment, index, { priority: 70, hurry: true }));
      }
      ensureBuffer(candidate);
    }

    async function fillTrack(candidate, track) {
      if (track.filling || track.complete || !sessionIsCurrent(candidate) || candidate.fatal) return;
      track.filling = true;
      const generation = candidate.generation;
      const signal = candidate.controller.signal;
      try {
        while (sessionIsCurrent(candidate) && generation === candidate.generation && !signal.aborted) {
          const current = Number(video.currentTime) || candidate.startTime;
          if (track.nextIndex >= track.sidx.segments.length) {
            track.complete = true;
            break;
          }
          if (bufferedEndAt(track.sourceBuffer, current) - current >= core.normalizeSettings(getSettings()).bufferAheadSeconds) break;
          // A sliding window: the next segment starts as soon as one has been appended. Waiting
          // for a whole batch left the connections idle until its slowest segment arrived.
          const windowSize = track.started ? (track.kind === "video" ? 3 : 4) : 1;
          let projectedEnd = bufferedEndAt(track.sourceBuffer, current);
          for (let offset = 0; offset < windowSize; offset += 1) {
            const index = track.nextIndex + offset;
            const segment = track.sidx.segments[index];
            if (!segment || projectedEnd - current >= core.normalizeSettings(getSettings()).bufferAheadSeconds) break;
            projectedEnd = segment.endTime;
            if (track.prefetches.has(index)) continue;
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
              onOrderedChunk: startup ? async (bytes) => {
                if (!sessionIsCurrent(candidate) || generation !== candidate.generation || signal.aborted) return;
                candidate.progressiveAppends += 1;
                await append(candidate, track, bytes, generation);
                ensureBuffer(candidate);
              } : null
            }));
          }
          const pending = track.prefetches.get(track.nextIndex);
          if (!pending) break;
          const settled = await pending;
          track.prefetches.delete(settled.index);
          if (settled.error) throw settled.error;
          if (!sessionIsCurrent(candidate) || generation !== candidate.generation || signal.aborted) break;
          if (!settled.result.streamed) await append(candidate, track, settled.result.bytes, generation);
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
        track.filling = false;
        maybeEndStream(candidate);
      }
    }

    function maybeEndStream(candidate = session) {
      if (!candidate || !sessionIsCurrent(candidate) || candidate.fatal || candidate.streamEnded || candidate.ending) return;
      if (!candidate.tracks.length || !candidate.tracks.every((track) => track.complete)) return;
      candidate.ending = true;
      Promise.all(candidate.tracks.map((track) => track.operation.catch(() => {}))).then(() => {
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
      const required = updateStartupProfile(candidate);
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
        if (ahead >= Math.min(candidate.recoveryTargetSeconds, remaining)) {
          candidate.recovering = false;
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
      if (destroyed) return;
      options.onLog?.("正在准备播放器", `使用 ${qualityLabel(representation)} 清晰度，从 ${Number(playbackState.time || 0).toFixed(2)} 秒开始。`, "info", "takeover");
      const previous = session;
      selectedVideo = representation;
      sessionStarts += 1;
      note("session", `${qualityLabel(representation)} ${codecFamily(representation)} from ${Number(playbackState.time || 0).toFixed(1)}`);
      const mediaSource = new MediaSource();
      const objectUrl = URL.createObjectURL(mediaSource);
      const candidate = {
        disposed: false, fatal: false, externalSourceDetected: false, generation: ++generationSequence,
        controller: new AbortController(), mediaSource, objectUrl,
        timer: null, endRetryTimer: null, tracks: [], ending: false, streamEnded: false,
        playAttempted: false, playbackActivated: false, playbackActivatedAt: 0,
        recovering: false, recoveryTargetSeconds: STARTUP_RECOVERY_SECONDS,
        startupCompletedBytes: 0, startupPrefetchLaunched: false, startupStartedAt: performance.now(),
        progressiveAppends: 0,
        startupTargetSeconds: 6, startupThroughputBps: 0, mediaBytesPerSecond: 0,
        startupWaitingEvents: 0, resumeWanted: playbackState.resume,
        volume: playbackState.volume, muted: playbackState.muted, playbackRate: playbackState.playbackRate,
        startTime: Math.max(0, Number(playbackState.time) || 0),
        forceStartTime: Boolean(playbackState.forceTime),
        internalSeekTarget: null,
        // One ban list per video, shared by every quality and by the audio track. What has been
        // measured about the nodes is kept for the whole page, so a seek does not start over.
        videoResolver: resolverFactory.createResolver(representation, () => core.normalizeSettings(getSettings()).mode, options.cdnBans, options.nodeStats || undefined),
        audioResolver: resolverFactory.createResolver(selection.audio, () => core.normalizeSettings(getSettings()).mode, options.cdnBans, options.nodeStats || undefined)
      };
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
        const audioBuffer = mediaSource.addSourceBuffer(mimeFor(selection.audio, "audio"));
        const [videoTrack, audioTrack] = await Promise.all([
          loadTrack(candidate, "video", representation, candidate.videoResolver, videoBuffer, candidate.startTime),
          loadTrack(candidate, "audio", selection.audio, candidate.audioResolver, audioBuffer, candidate.startTime)
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
      await startSession(selectedVideo, {
        time: target,
        resume: !video.paused,
        volume: video.volume,
        muted: video.muted,
        playbackRate: video.playbackRate
      });
    }

    function scheduleSeek() {
      seekRequestedAt = performance.now();
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => {
        seekTimer = null;
        seek().catch((error) => { if (session && sessionIsCurrent(session)) fatal(session, error); });
      }, 140);
    }

    video.addEventListener("seeking", scheduleSeek, { signal: eventController.signal });
    video.addEventListener("timeupdate", () => ensureBuffer(), { signal: eventController.signal });
    video.addEventListener("waiting", () => {
      const candidate = session;
      note("waiting", candidate?.playbackActivated ? "after start" : "before start");
      if (candidate && sessionIsCurrent(candidate) && candidate.playbackActivated) {
        candidate.startupWaitingEvents += 1;
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
    video.addEventListener("ended", () => publishState({ playerState: "ended", bufferedAhead: 0 }), { signal: eventController.signal });

    function playbackState() {
      return {
        time: Number(video.currentTime) || 0,
        resume: !video.paused || Number(video.currentTime) < 1,
        volume: video.volume,
        muted: video.muted,
        playbackRate: video.playbackRate || 1
      };
    }

    async function updatePlayinfo(playinfo) {
      if (destroyed) return;
      const next = selectRepresentations(playinfo, preferredQuality);
      currentPlayinfo = playinfo;
      const nextVideo = next.preferred;
      const audioChanged = !sameRepresentation(selection.audio, next.audio);
      selection = next;
      if (!audioChanged && sameRepresentation(selectedVideo, nextVideo)) return;
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
    const initialResume = options.initialResume !== undefined
      ? Boolean(options.initialResume)
      : !original.wasPaused || original.currentTime < 1;
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
      destroy,
      setQuality,
      updatePlayinfo,
      video,
      getDebug: () => ({
        version: "0.9.1.4",
        architecture: "bilibili-native-ui-progressive-mse-0.8-core",
        quality: qualityLabel(selectedVideo),
        qualityId: Number(selectedVideo?.id) || 0,
        preferredQuality,
        sessionStarts,
        codec: codecFamily(selectedVideo),
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
        progressiveAppends: session?.progressiveAppends || 0,
        seekReloads,
        lastSeekMs: Math.round(lastSeekMs),
        stallsAfterSeek,
        download: downloader.stats?.() || null,
        timeline: timeline.slice(),
        requests: downloader.recent?.() || [],
        tracks: (session?.tracks || []).map((track) => ({ kind: track.kind, nextIndex: track.nextIndex, segments: track.sidx.segments.length }))
      })
    });
  }

  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = Object.freeze({ createNativePlayer, qualityLabel, selectRepresentations });
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

/* src/page-hook.js */
(function installPageHook(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const INSTALL_FLAG = "__biliThreadRipper0901Installed";
  const BILIBILI_API_ORIGIN = "https://api.bilibili.com";
  const COMPATIBILITY_RELOAD_KEY = "__btrCompatibilityReloadV1";
  const COMPATIBILITY_DOCUMENT_ID = root.crypto?.randomUUID?.()
    || `${Number(root.performance?.timeOrigin || Date.now()).toString(36)}-${Number(root.performance?.now?.() || 0).toString(36)}-${Math.random().toString(36).slice(2)}`;
  const THREAD_OPTIONS = Object.freeze([4, 8, 16, 32, 64, 128]);
  const STATE_LABELS = Object.freeze({ waiting: "正在等视频信息", loading: "正在准备播放", ready: "视频已经准备好了", buffering: "正在补充缓冲", ended: "视频播放完了", error: "播放器出错了", "native-fallback": "已经改回 B 站原来的连接", disabled: "加速已关闭" });
  const KIND_LABELS = Object.freeze({ video: "画面", audio: "声音", meta: "视频信息" });
  const SETTINGS_ID = "__bilibili_thread_ripper_native_settings__";
  const SETTINGS_STYLE_ID = "__bilibili_thread_ripper_native_settings_style__";
  if (root[INSTALL_FLAG]) return;

  const core = root.__BILI_RANGE_CORE__;
  const playerFactory = root.__BILI_NATIVE_MSE_PLAYER_FACTORY__;
  const earlyMask = root.__BILI_THREAD_RIPPER_EARLY_MASK__;
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
  const nodeStats = root.__BILI_CDN_RESOLVER_FACTORY__?.createNodeStats?.() || null;
  let playerContainer = null;
  let playerLifecycle = 0;
  let qualityPlayer = null;
  let syncedQuality = 0;
  let infoPanel = null;
  let infoPanelObserver = null;
  const lastHostByKind = { video: "", audio: "" };
  const recentBytes = [];
  let failedRoute = "";
  let startingRoute = "";
  let routeGeneration = 0;
  let routeRequestController = null;
  let restartTimer = null;
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
  let compatibilityReloadTimer = null;
  let compatibilityReloadRoute = "";
  let compatibilityReloadTicket = 0;
  let compatibilityObservedRoute = null;
  let transferSequence = 1;
  const transfers = new Map();
  const stats = {
    version: "0.9.1.4",
    architecture: "bilibili-native-ui-progressive-mse-0.8-core",
    mode: settings.mode,
    playerState: "waiting",
    quality: "",
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
    scheduleCompatibilityFailureReload(route);
  }

  // A failed download used to leave the video on Bilibili's own connection until the page
  // changed. Most such failures are one slow CDN reply, so the takeover is tried again a few
  // times with a growing pause. The compatibility modes reload the page instead.
  function scheduleAutoRetake(route) {
    if (settings.compatibilityMode !== "off") return;
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

  function readCompatibilityReloadState() {
    try {
      const parsed = JSON.parse(root.sessionStorage.getItem(COMPATIBILITY_RELOAD_KEY) || "null");
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  function writeCompatibilityReloadState(value) {
    try { root.sessionStorage.setItem(COMPATIBILITY_RELOAD_KEY, JSON.stringify(value)); }
    catch (_error) {}
  }

  function clearCompatibilityReloadState() {
    try { root.sessionStorage.removeItem(COMPATIBILITY_RELOAD_KEY); }
    catch (_error) {}
  }

  function cancelCompatibilityReload(clearState = false) {
    compatibilityReloadTicket += 1;
    clearTimeout(compatibilityReloadTimer);
    compatibilityReloadTimer = null;
    compatibilityReloadRoute = "";
    if (clearState) clearCompatibilityReloadState();
  }

  function observeCompatibilityRoute(identity) {
    const route = identity?.key || "";
    if (compatibilityObservedRoute === null) {
      compatibilityObservedRoute = route;
      return;
    }
    if (compatibilityObservedRoute === route) return;
    compatibilityObservedRoute = route;
    cancelCompatibilityReload(true);
  }

  function compatibilityTargetUrl(identity) {
    const target = new URL(location.href);
    const pathMatch = /\/video\/(BV[0-9A-Za-z]+|av\d+)/i.exec(target.pathname);
    const pathId = String(pathMatch?.[1] || "");
    const targetId = identity.bvid || (identity.aid ? `av${identity.aid}` : "");
    if (targetId && pathId.toLowerCase() !== targetId.toLowerCase()) {
      target.pathname = `/video/${targetId}`;
      target.searchParams.delete("p");
    }
    if (identity.part > 1) target.searchParams.set("p", String(identity.part));
    return target.href;
  }

  function performCompatibilityReload(identity, route) {
    if (routeIdentity()?.key !== route) return;
    const target = compatibilityTargetUrl(identity);
    if (target !== location.href) root.location.replace(target);
    else root.location.reload();
  }

  function scheduleCompatibilityReload(identity, reason) {
    const compatibilityMode = settings.compatibilityMode || "off";
    if (!identity || compatibilityMode === "off") return false;
    const route = identity.key;
    if (compatibilityReloadTimer && compatibilityReloadRoute === route) return true;
    cancelCompatibilityReload(false);
    const previous = readCompatibilityReloadState();
    const sameAttempt = previous?.mode === compatibilityMode && previous?.route === route;
    const failures = reason === "failure" ? (sameAttempt ? Number(previous.failures) || 0 : 0) + 1 : 0;
    writeCompatibilityReloadState({
      mode: compatibilityMode,
      route,
      preflightDone: reason === "failure" ? Boolean(previous?.preflightDone) : false,
      failures,
      reason,
      phase: `${reason}-scheduled`,
      documentId: COMPATIBILITY_DOCUMENT_ID,
      updatedAt: Date.now()
    });
    compatibilityReloadRoute = route;
    const ticket = ++compatibilityReloadTicket;
    const navigationGeneration = routeGeneration;
    const delay = reason === "preflight" ? 50 : Math.min(5000, 350 * (2 ** Math.min(4, Math.max(0, failures - 1))));
    notices?.log("兼容模式准备刷新网页", `已开启兼容模式 ${compatibilityMode.toUpperCase()}。${reason === "preflight" ? "播放前会先刷新一次。" : "这次加载失败了，准备刷新后重试。"}\n大约 ${(delay / 1000).toFixed(1)} 秒后刷新。`, "info", "", route, "settings");
    compatibilityReloadTimer = setTimeout(() => {
      if (ticket !== compatibilityReloadTicket) return;
      if (navigationGeneration !== routeGeneration || routeIdentity()?.key !== route) {
        compatibilityReloadTimer = null;
        compatibilityReloadRoute = "";
        const stale = readCompatibilityReloadState();
        if (stale?.documentId === COMPATIBILITY_DOCUMENT_ID && stale?.phase === `${reason}-scheduled`) clearCompatibilityReloadState();
        return;
      }
      const scheduled = readCompatibilityReloadState();
      if (scheduled?.mode !== compatibilityMode || scheduled?.route !== route || scheduled?.documentId !== COMPATIBILITY_DOCUMENT_ID || scheduled?.phase !== `${reason}-scheduled`) {
        compatibilityReloadTimer = null;
        compatibilityReloadRoute = "";
        return;
      }
      compatibilityReloadTimer = null;
      compatibilityReloadRoute = "";
      writeCompatibilityReloadState({
        ...scheduled,
        preflightDone: compatibilityMode === "b" ? true : Boolean(scheduled.preflightDone),
        phase: `${reason}-issued`,
        updatedAt: Date.now()
      });
      performCompatibilityReload(identity, route);
    }, delay);
    return true;
  }

  function ensureCompatibilityPreflight(identity) {
    const state = readCompatibilityReloadState();
    if (["a", "b"].includes(settings.compatibilityMode)
      && state?.mode === settings.compatibilityMode
      && state?.route === identity.key
      && state?.documentId === COMPATIBILITY_DOCUMENT_ID
      && state?.phase === "failure-issued") {
      if (Date.now() - (Number(state.updatedAt) || 0) < 1500) return true;
      return scheduleCompatibilityReload(identity, "failure");
    }
    if (settings.compatibilityMode !== "b") return false;
    if (state?.mode === "b" && state?.route === identity.key) {
      if (state.documentId === COMPATIBILITY_DOCUMENT_ID && state.phase === "preflight-scheduled") return true;
      if (state.documentId === COMPATIBILITY_DOCUMENT_ID && state.phase === "preflight-issued") {
        if (Date.now() - (Number(state.updatedAt) || 0) < 1500) return true;
        return scheduleCompatibilityReload(identity, "preflight");
      }
      if (state.documentId !== COMPATIBILITY_DOCUMENT_ID && state.phase === "preflight-issued") {
        writeCompatibilityReloadState({
          ...state,
          preflightDone: true,
          phase: "preflight-consumed",
          documentId: COMPATIBILITY_DOCUMENT_ID,
          updatedAt: Date.now()
        });
        return false;
      }
      if (state.documentId !== COMPATIBILITY_DOCUMENT_ID && state.phase === "failure-issued" && state.preflightDone === true) {
        writeCompatibilityReloadState({
          ...state,
          phase: "failure-consumed",
          documentId: COMPATIBILITY_DOCUMENT_ID,
          updatedAt: Date.now()
        });
        return false;
      }
      if (state.documentId === COMPATIBILITY_DOCUMENT_ID && state.preflightDone === true) return false;
    }
    return scheduleCompatibilityReload(identity, "preflight");
  }

  function scheduleCompatibilityFailureReload(route) {
    if (!settings || !["a", "b"].includes(settings.compatibilityMode)) return;
    const identity = routeIdentity();
    if (!identity || identity.key !== route) return;
    scheduleCompatibilityReload(identity, "failure");
  }

  function markCompatibilitySuccess(route) {
    if (compatibilityReloadRoute === route) cancelCompatibilityReload(false);
    const state = readCompatibilityReloadState();
    if (!state || state.route !== route || state.mode !== settings.compatibilityMode) return;
    writeCompatibilityReloadState({
      ...state,
      failures: 0,
      reason: "ready",
      phase: "ready",
      documentId: COMPATIBILITY_DOCUMENT_ID,
      updatedAt: Date.now()
    });
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
      transfers.set(id, {
        id,
        kind: ["video", "audio", "meta"].includes(event.kind) ? event.kind : "video",
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
      // One segment starts and ends dozens of transfers within the same moment. Publishing
      // each of them at once copied the whole thread list to the side panel every time.
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
        schedulePublish();
        return event.id;
      }
      item.state = event.phase === "done" ? "done" : "error";
      item.finalBps = event.phase === "done" ? item.loaded * 1000 / Math.max(1, now - item.startedAt) : 0;
      item.expiresAt = now + 3500;
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

  function routeIdentity() {
    const match = /\/video\/(BV[0-9A-Za-z]+|av\d+)/i.exec(location.pathname);
    if (!match) return null;
    const pathId = match[1];
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

  function cachePlayinfo(identity, playinfo, cid = 0) {
    if (!identity || !isDashPlayinfo(playinfo)) return false;
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

  async function fetchRoutePlayinfo(identity, signal) {
    notices?.log("正在读取视频信息", "确认你要看的视频和分 P。", "info", "", identity.key, "takeover");
    const query = identity.bvid
      ? `bvid=${encodeURIComponent(identity.bvid)}`
      : `aid=${encodeURIComponent(identity.aid)}`;
    const viewResponse = await nativeFetch(`${BILIBILI_API_ORIGIN}/x/web-interface/view?${query}`, { credentials: "include", signal });
    if (!viewResponse.ok) throw new Error(`读取视频信息失败（HTTP ${viewResponse.status}）`);
    const viewPayload = await viewResponse.json();
    if (Number(viewPayload?.code) !== 0 || !viewPayload?.data) throw new Error(viewPayload?.message || "读取视频信息失败");
    const pages = Array.isArray(viewPayload.data.pages) ? viewPayload.data.pages : [];
    const page = pages[identity.part - 1] || pages[0];
    const cid = Number(page?.cid || viewPayload.data.cid) || 0;
    if (!cid) throw new Error("新视频缺少 CID");
    if (signal?.aborted) throw signal.reason || new DOMException("播放清单请求已取消", "AbortError");
    routeCids.set(identity.key, cid);
    const canonicalBvid = String(viewPayload.data.bvid || identity.bvid || "");
    const canonicalAid = Number(viewPayload.data.aid || identity.aid) || 0;
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
    notices?.log("已经拿到视频下载地址", "接下来开始准备多线程下载。", "success", "", identity.key, "takeover");
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
    const key = `${settings.mode}:${route}`;
    if (preconnectKey === key) return;
    const factory = root.__BILI_CDN_RESOLVER_FACTORY__;
    const hosts = settings.mode === "overseas" ? factory?.OVERSEAS_HOSTS : factory?.MAINLAND_HOSTS;
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
          { label: "海外 CDN", value: "overseas" }
        ], settings.mode),
        settingGroup("并发线程", "btr-native-concurrency", THREAD_OPTIONS.map((value) => ({ label: String(value), value })), settings.concurrency),
        settingGroup("兼容模式", "btr-native-compatibility", [
          { label: "标准模式", value: "off" },
          { label: "兼容模式 A", value: "a" },
          { label: "兼容模式 B", value: "b" }
        ], settings.compatibilityMode)
      );
      panel.addEventListener("change", (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || !input.checked) return;
        if (input.name === "btr-native-mode") {
          root.postMessage({ channel: CHANNEL, type: "settings-update", payload: { mode: input.value } }, "*");
        } else if (input.name === "btr-native-concurrency") {
          const concurrency = Number(input.value);
          if (THREAD_OPTIONS.includes(concurrency)) root.postMessage({ channel: CHANNEL, type: "settings-update", payload: { concurrency } }, "*");
        } else if (input.name === "btr-native-compatibility" && ["off", "a", "b"].includes(input.value)) {
          root.postMessage({ channel: CHANNEL, type: "settings-update", payload: { compatibilityMode: input.value } }, "*");
        }
      });
      const before = mount.querySelector(".bpx-player-ctrl-setting-others");
      mount.insertBefore(panel, before || mount.firstChild);
    }
    for (const input of panel.querySelectorAll('input[name="btr-native-mode"]')) input.checked = input.value === settings.mode;
    for (const input of panel.querySelectorAll('input[name="btr-native-concurrency"]')) input.checked = Number(input.value) === settings.concurrency;
    for (const input of panel.querySelectorAll('input[name="btr-native-compatibility"]')) input.checked = input.value === settings.compatibilityMode;
  }

  function scheduleSettingsMenuSync() {
    if (menuSyncTimer) return;
    menuSyncTimer = setTimeout(() => {
      menuSyncTimer = null;
      syncSettingsMenu();
    }, 120);
  }

  function stopPlayer(resumeNative = true) {
    const current = player;
    notices?.detach(resumeNative ? "已停止加速，交回 B 站原来的连接" : "已停止接管上一个视频");
    playerLifecycle += 1;
    player = null;
    playerRoute = "";
    playerContainer = null;
    current?.destroy({ resumeNative });
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
    const wanted = nativeQuality();
    if (!player?.setQuality || (qualityPlayer === player && syncedQuality === wanted)) return;
    const current = player, route = playerRoute, lifecycle = playerLifecycle;
    qualityPlayer = current;
    syncedQuality = wanted;
    notices?.log("跟随播放器切换清晰度", wanted ? `正在换成播放器选的清晰度（${wanted}）。` : "播放器改回了自动，使用这个视频默认的清晰度。", "info", "", route, "playback");
    current.setQuality(wanted).catch((error) => {
      if (lifecycle === playerLifecycle && player === current) recordTakeoverFailure(route, "quality", error, true);
    });
  }

  function watchQualityMenu(event) {
    if (!(event.target instanceof Element) || !event.target.closest(".bpx-player-ctrl-quality-menu-item")) return;
    // Capture phase runs before Bilibili's own handler; read the choice once it has run.
    setTimeout(syncNativeQuality, 0);
    setTimeout(syncNativeQuality, 300);
  }

  // Bilibili's "视频统计信息" panel reads its own player core, which downloads nothing while
  // BTR plays the video, so its hosts, speeds and segment counts would be stale. The same
  // rows show what BTR plays and downloads instead.
  function nativeInfoValues() {
    const info = player?.getDebug?.();
    if (!info?.videoType || playerContainer?.dataset.btrMseActive !== "true") return null;
    const now = Date.now();
    while (recentBytes.length && now - recentBytes[0].at > 1000) recentBytes.shift();
    const speed = (kind) => Math.round([...transfers.values()]
      .filter((item) => item.kind === kind && item.state === "active")
      .reduce((sum, item) => sum + item.bps, 0) * 8 / 1000);
    const track = info.tracks?.find((item) => item.kind === "video");
    const frames = player.video?.getVideoPlaybackQuality?.();
    // Bytes that arrived on a second copy of a piece after the other copy had already won.
    const repeated = info.download?.bytes ? `，重复下载 ${(info.download.duplicateBytes / (info.download.bytes + info.download.duplicateBytes) * 100).toFixed(1)}%` : "";
    return {
      "Mime Type": `${info.videoType}, ${info.audioType}`,
      "Player Type": `线程撕裂者 ${stats.version} 接管`,
      "Video DataRate": `${Math.round(info.videoBandwidth / 1000)} Kbps [${String(info.codec).toUpperCase()}]`,
      "Audio DataRate": `${Math.round(info.audioBandwidth / 1000)} Kbps`,
      "Segments": track ? `${track.nextIndex} / ${track.segments}${info.lastSeekMs ? `，跳转恢复 ${(info.lastSeekMs / 1000).toFixed(1)} 秒，之后卡顿 ${info.stallsAfterSeek} 次` : ""}` : undefined,
      "Dropped Frames": frames ? `${frames.droppedVideoFrames} / ${frames.totalVideoFrames}` : undefined,
      "Video Host": lastHostByKind.video || undefined,
      "Audio Host": lastHostByKind.audio || undefined,
      "Video Speed": `${speed("video")} Kbps`,
      "Audio Speed": `${speed("audio")} Kbps`,
      "Network Activity": `${Math.round(recentBytes.reduce((sum, item) => sum + item.bytes, 0) / 1024)} KB${repeated}`
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
    observeCompatibilityRoute(identity);
    if (!settings.enabled || !identity) {
      pendingPodSwitch = null;
      clearTakeoverFailure();
      stats.lastError = "";
      if (player) stopPlayer(true);
      earlyMask?.release?.();
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
    if (ensureCompatibilityPreflight(identity)) {
      stats.playerState = "waiting";
      schedulePublish();
      earlyMask?.release?.();
      return;
    }
    if (!player && failedRoute === route) {
      earlyMask?.release?.();
      return;
    }
    if (player && playerRoute === route && playerContainer?.isConnected && player.video?.isConnected) {
      earlyMask?.release?.();
      return;
    }
    if (startingRoute === route) return;
    earlyMask?.arm?.();
    const container = findContainer();
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
    try {
      const nextPlayer = playerFactory.createNativePlayer({
        container,
        identity,
        preferredQuality,
        // A collection item is a different video. Its native <video> element
        // can still expose the previous item's currentTime until new metadata
        // arrives, so carrying that value across would clamp short videos to
        // their final frame and make the switch look frozen.
        initialTime: isPodSwitch ? 0 : undefined,
        initialResume: isPodSwitch ? pendingPodSwitch.resume : undefined,
        getSettings: () => settings,
        nativeFetch,
        poster: String(root.__INITIAL_STATE__?.videoData?.pic || ""),
        onTransfer,
        cdnBans,
        nodeStats,
        onLog(title, detail, level = "info", category = "other") {
          if (lifecycle !== playerLifecycle) return;
          notices?.log(title, detail, level, "", route, category);
        },
        onSettingsChange(next) {
          if (lifecycle !== playerLifecycle) return;
          root.postMessage({ channel: CHANNEL, type: "settings-update", payload: next }, "*");
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
          markCompatibilitySuccess(route);
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
          if (next.playerState === "ready") markCompatibilitySuccess(route);
          stats.quality = next.quality || stats.quality;
          stats.bufferedAhead = Number(next.bufferedAhead) || 0;
          stats.lastError = next.lastError ? String(next.lastError).slice(0, 180) : stats.lastError;
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
          failedRoute = route;
          recordTakeoverFailure(route, "mse", error, true);
          setTimeout(() => {
            if (lifecycle === playerLifecycle && player && playerRoute === route && stats.playerState === "error") {
              stopPlayer(true);
              earlyMask?.release?.();
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
      playerRoute = route;
      playerContainer = container;
      qualityPlayer = nextPlayer;
      syncedQuality = preferredQuality;
      notices?.attach(nextPlayer.video, route, lifecycle, () => lifecycle === playerLifecycle && player === nextPlayer && playerRoute === routeIdentity()?.key && playerContainer?.isConnected && !["error", "native-fallback", "disabled"].includes(stats.playerState));
      if (isPodSwitch) {
        trustedPodVideoKey = identity.videoKey;
        pendingPodSwitch = null;
      }
      earlyMask?.release?.();
    } catch (error) {
      if (lifecycle !== playerLifecycle) return;
      recordTakeoverFailure(route, "create", error, true);
      earlyMask?.release?.();
      restartTimer = setTimeout(startPlayer, 2000);
    }
  }

  function restartPlayer(force = false) {
    clearTimeout(restartTimer);
    if (force && compatibilityReloadTimer) cancelCompatibilityReload(true);
    const identity = routeIdentity();
    if (!force && player && identity?.key === playerRoute && playerContainer?.isConnected && player.video?.isConnected) {
      earlyMask?.release?.();
      return;
    }
    routeGeneration += 1;
    routeRequestController?.abort();
    routeRequestController = null;
    startingRoute = "";
    failedRoute = "";
    if (settings.enabled && identity) earlyMask?.arm?.();
    else earlyMask?.release?.();
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
      if (!hadLoadedSettings || previous.enabled !== settings.enabled || previous.mode !== settings.mode || previous.concurrency !== settings.concurrency || previous.compatibilityMode !== settings.compatibilityMode) notices?.log("设置已经生效", `使用${settings.mode === "overseas" ? "海外" : "大陆"} CDN，开启 ${settings.concurrency} 条下载线程。\n当前是${settings.compatibilityMode === "off" ? "标准模式" : `兼容模式 ${settings.compatibilityMode.toUpperCase()}`}。`, "success", "", undefined, "settings");
      stats.mode = settings.mode;
      syncSettingsMenu();
      if (settings.compatibilityMode === "off") {
        cancelCompatibilityReload(true);
      }
      if (!settings.enabled) {
        cancelCompatibilityReload(true);
        clearTakeoverFailure();
        stats.lastError = "";
        stopPlayer(true);
      }
      else if (!previous.enabled || previous.mode !== settings.mode || previous.compatibilityMode !== settings.compatibilityMode) {
        if (hadLoadedSettings && previous.compatibilityMode !== settings.compatibilityMode) cancelCompatibilityReload(true);
        restartPlayer(true);
      }
      else {
        player?.applySettings?.(settings);
        startPlayer();
      }
    } else if (event.data.type === "get-stats") {
      publish();
    } else if (event.data.type === "retry-takeover") {
      clearTimeout(autoRetakeTimer);
      autoRetakeCount = 0;
      cancelCompatibilityReload(false);
      clearTakeoverFailure();
      stats.lastError = "";
      failedRoute = "";
      restartPlayer(true);
    }
  });

  const nativePushState = history.pushState.bind(history);
  const nativeReplaceState = history.replaceState.bind(history);
  const pathVideoKey = () => {
    const match = /\/video\/(BV[0-9A-Za-z]+|av\d+)/i.exec(location.pathname);
    return String(match?.[1] || "").toLowerCase();
  };
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
    else syncNativeQuality();
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
        const { timeline = [], requests = [], ...rest } = debug;
        return JSON.stringify({
          version: stats.version, at: Math.round(performance.now()), settings: { mode: settings.mode, concurrency: settings.concurrency, compatibilityMode: settings.compatibilityMode },
          state: stats.playerState, player: rest, nodes: nodeStats?.dump?.() || null, bannedNodes: cdnBans?.hosts?.() || [], timeline,
          requests: requests.map((item) => [item.at, item.kind, item.node.split(".")[0], item.bytes, item.firstByteMs, item.ms, item.end].join(" "))
        }, null, 1);
      },
      version: "0.9.1.4"
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
  const VERSION = "0.9.1.4";
  const notices = globalThis.__BTR_NOTIFICATION_VIEW__;
  const ERROR_NOTICE_ID = "__bilibili_thread_ripper_error_notice__";
  const ERROR_NOTICE_STYLE_ID = "__bilibili_thread_ripper_error_notice_style__";
  const ONBOARDING_ID = "__bilibili_thread_ripper_onboarding__";
  const ONBOARDING_STYLE_ID = "__bilibili_thread_ripper_onboarding_style__";
  const ONBOARDING_STORAGE_KEY = "btrOnboardingRevision";
  const ONBOARDING_REVISION = "native-progressive-mse-v1";
  const THREAD_OPTIONS = Object.freeze([4, 8, 16, 32, 64, 128]);
  const DEFAULT_DANMAKU = Object.freeze({
    visible: true,
    opacity: 0.9,
    area: "threeQuarter",
    fontSize: 25,
    speed: 5,
    modes: [0, 1, 2],
    antiOverlap: true,
    synchronousPlayback: true,
    mode: 0,
    color: "#FFFFFF"
  });
  const DEFAULTS = { enabled: true, concurrency: 8, volume: 0.7, danmaku: DEFAULT_DANMAKU, mode: "mainland", compatibilityMode: "off", debugNotices: false, errorNotices: false, debugCategories: {}, subtitleLanguage: "off", subtitleLastLanguage: "" };
  let latestSettings = { ...DEFAULTS };
  let latestStats = null;
  let loaded = false;
  let lastBadge = null;
  let onboardingChecked = false;
  let errorNoticeMotion = null;

  function removeOnboarding() {
    document.getElementById(ONBOARDING_ID)?.remove();
    document.getElementById(ONBOARDING_STYLE_ID)?.remove();
  }

  function mountOnboarding() {
    if (document.getElementById(ONBOARDING_ID)) return;
    const mount = document.body || document.documentElement;
    if (!mount) {
      document.addEventListener("DOMContentLoaded", mountOnboarding, { once: true });
      return;
    }

    const style = document.createElement("style");
    style.id = ONBOARDING_STYLE_ID;
    style.textContent = `
      #${ONBOARDING_ID}{position:fixed!important;inset:0!important;z-index:2147483646!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:16px!important;box-sizing:border-box!important;background:rgba(0,0,0,.62)!important;font-family:"Microsoft YaHei","PingFang SC",Arial,sans-serif!important;color:#18191c!important}
      #${ONBOARDING_ID} *{box-sizing:border-box!important}
      #${ONBOARDING_ID} .btr-onboarding-panel{width:min(440px,calc(100vw - 32px))!important;max-height:calc(100vh - 32px)!important;overflow:auto!important;padding:28px!important;border:1px solid #e3e5e7!important;border-radius:12px!important;background:#fff!important;box-shadow:none!important}
      #${ONBOARDING_ID} .btr-onboarding-heading{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:16px!important;margin:0 0 6px!important}
      #${ONBOARDING_ID} h2{margin:0!important;font-size:22px!important;line-height:1.35!important;font-weight:700!important;color:#18191c!important}
      #${ONBOARDING_ID} .btr-onboarding-version{flex:none!important;padding:3px 8px!important;border-radius:5px!important;background:#f1f2f3!important;color:#61666d!important;font-size:12px!important;line-height:18px!important}
      #${ONBOARDING_ID} .btr-onboarding-lead{margin:0 0 24px!important;color:#61666d!important;font-size:13px!important;line-height:1.7!important}
      #${ONBOARDING_ID} fieldset{min-width:0!important;margin:0 0 22px!important;padding:0!important;border:0!important}
      #${ONBOARDING_ID} legend{display:block!important;width:100%!important;margin:0 0 10px!important;padding:0!important;color:#18191c!important;font-size:14px!important;line-height:20px!important;font-weight:600!important}
      #${ONBOARDING_ID} .btr-onboarding-mode-list{display:grid!important;grid-template-columns:1fr 1fr!important;gap:10px!important}
      #${ONBOARDING_ID} .btr-onboarding-mode{position:relative!important;display:block!important;cursor:pointer!important}
      #${ONBOARDING_ID} .btr-onboarding-mode input{position:absolute!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important}
      #${ONBOARDING_ID} .btr-onboarding-mode-body{display:block!important;min-height:78px!important;padding:13px!important;border:1px solid #dcdfe3!important;border-radius:8px!important;background:#fff!important;color:#18191c!important;transition:border-color .15s ease,background-color .15s ease!important}
      #${ONBOARDING_ID} .btr-onboarding-mode input:checked+.btr-onboarding-mode-body{border-color:#fb7299!important;background:#fff1f5!important}
      #${ONBOARDING_ID} .btr-onboarding-mode input:focus-visible+.btr-onboarding-mode-body{outline:2px solid #00aeec!important;outline-offset:2px!important}
      #${ONBOARDING_ID} .btr-onboarding-mode-name{display:block!important;margin:0 0 5px!important;font-size:14px!important;line-height:20px!important;font-weight:600!important}
      #${ONBOARDING_ID} .btr-onboarding-mode-note{display:block!important;color:#9499a0!important;font-size:12px!important;line-height:18px!important;font-weight:400!important}
      #${ONBOARDING_ID} .btr-onboarding-compat-list{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:8px!important}
      #${ONBOARDING_ID} .btr-onboarding-compat{position:relative!important;display:block!important;cursor:pointer!important}
      #${ONBOARDING_ID} .btr-onboarding-compat input{position:absolute!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important}
      #${ONBOARDING_ID} .btr-onboarding-compat-label{display:flex!important;align-items:center!important;justify-content:center!important;min-height:38px!important;padding:8px!important;border:1px solid #dcdfe3!important;border-radius:6px!important;background:#fff!important;color:#61666d!important;font-size:13px!important;line-height:20px!important;font-weight:500!important;text-align:center!important}
      #${ONBOARDING_ID} .btr-onboarding-compat input:checked+.btr-onboarding-compat-label{border-color:#fb7299!important;background:#fff1f5!important;color:#18191c!important}
      #${ONBOARDING_ID} .btr-onboarding-compat input:focus-visible+.btr-onboarding-compat-label{outline:2px solid #00aeec!important;outline-offset:2px!important}
      #${ONBOARDING_ID} .btr-onboarding-thread-head{display:flex!important;align-items:center!important;justify-content:space-between!important;margin:0 0 6px!important}
      #${ONBOARDING_ID} .btr-onboarding-thread-value{color:#fb7299!important;font-size:22px!important;line-height:28px!important;font-weight:700!important;font-variant-numeric:tabular-nums!important}
      #${ONBOARDING_ID} input[type="range"]{display:block!important;width:100%!important;height:24px!important;margin:0!important;accent-color:#fb7299!important;cursor:pointer!important}
      #${ONBOARDING_ID} .btr-onboarding-ticks{display:flex!important;justify-content:space-between!important;margin-top:2px!important;color:#9499a0!important;font-size:11px!important;line-height:16px!important}
      #${ONBOARDING_ID} .btr-onboarding-tip{margin:0 0 18px!important;padding:10px 12px!important;border-radius:7px!important;background:#f6f7f8!important;color:#61666d!important;font-size:12px!important;line-height:18px!important}
      #${ONBOARDING_ID} .btr-onboarding-save{display:block!important;width:100%!important;height:42px!important;margin:0!important;border:0!important;border-radius:8px!important;background:#fb7299!important;color:#fff!important;font:600 14px/42px "Microsoft YaHei","PingFang SC",Arial,sans-serif!important;text-align:center!important;cursor:pointer!important}
      #${ONBOARDING_ID} .btr-onboarding-save:hover{background:#fc8bab!important}
      #${ONBOARDING_ID} .btr-onboarding-save:focus-visible{outline:2px solid #00aeec!important;outline-offset:2px!important}
      #${ONBOARDING_ID} .btr-onboarding-save:disabled{background:#c9ccd0!important;cursor:default!important}
      #${ONBOARDING_ID} .btr-onboarding-status{min-height:18px!important;margin:8px 0 0!important;color:#f85a54!important;font-size:12px!important;line-height:18px!important;text-align:center!important}
      @media(max-width:520px){#${ONBOARDING_ID} .btr-onboarding-panel{padding:22px!important}#${ONBOARDING_ID} .btr-onboarding-mode-list{grid-template-columns:1fr!important}#${ONBOARDING_ID} .btr-onboarding-mode-body{min-height:0!important}}
    `;
    (document.head || document.documentElement).append(style);

    const overlay = document.createElement("div");
    overlay.id = ONBOARDING_ID;
    overlay.dataset.version = VERSION;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "btr-onboarding-title");

    const panel = document.createElement("section");
    panel.className = "btr-onboarding-panel";
    const heading = document.createElement("div");
    heading.className = "btr-onboarding-heading";
    const title = document.createElement("h2");
    title.id = "btr-onboarding-title";
    title.textContent = "Bilibili 线程撕裂者";
    const version = document.createElement("span");
    version.className = "btr-onboarding-version";
    version.textContent = `v${VERSION}`;
    heading.append(title, version);

    const lead = document.createElement("p");
    lead.className = "btr-onboarding-lead";
    lead.textContent = "首次使用请完成加速设置。播放器、弹幕和字幕仍由 B 站原生功能负责，线程撕裂者只优化视频传输。";

    const modeFieldset = document.createElement("fieldset");
    const modeLegend = document.createElement("legend");
    modeLegend.textContent = "CDN 模式";
    const modeList = document.createElement("div");
    modeList.className = "btr-onboarding-mode-list";
    for (const option of [
      { value: "mainland", name: "大陆 CDN（推荐）", note: "优先使用大陆 bilivideo 节点" },
      { value: "overseas", name: "海外 CDN", note: "优先使用海外及镜像节点" }
    ]) {
      const label = document.createElement("label");
      label.className = "btr-onboarding-mode";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "btr-onboarding-mode";
      input.value = option.value;
      input.checked = option.value === latestSettings.mode;
      const body = document.createElement("span");
      body.className = "btr-onboarding-mode-body";
      const name = document.createElement("span");
      name.className = "btr-onboarding-mode-name";
      name.textContent = option.name;
      const note = document.createElement("span");
      note.className = "btr-onboarding-mode-note";
      note.textContent = option.note;
      body.append(name, note);
      label.append(input, body);
      modeList.append(label);
    }
    modeFieldset.append(modeLegend, modeList);

    const compatibilityFieldset = document.createElement("fieldset");
    const compatibilityLegend = document.createElement("legend");
    compatibilityLegend.textContent = "兼容模式";
    const compatibilityList = document.createElement("div");
    compatibilityList.className = "btr-onboarding-compat-list";
    for (const option of [
      { value: "off", name: "标准模式" },
      { value: "a", name: "兼容模式 A" },
      { value: "b", name: "兼容模式 B" }
    ]) {
      const label = document.createElement("label");
      label.className = "btr-onboarding-compat";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "btr-onboarding-compatibility";
      input.value = option.value;
      input.checked = option.value === latestSettings.compatibilityMode;
      const text = document.createElement("span");
      text.className = "btr-onboarding-compat-label";
      text.textContent = option.name;
      label.append(input, text);
      compatibilityList.append(label);
    }
    compatibilityFieldset.append(compatibilityLegend, compatibilityList);

    const threadFieldset = document.createElement("fieldset");
    const threadHead = document.createElement("div");
    threadHead.className = "btr-onboarding-thread-head";
    const threadLegend = document.createElement("legend");
    threadLegend.textContent = "并发线程";
    const threadValue = document.createElement("output");
    threadValue.className = "btr-onboarding-thread-value";
    const initialThreadIndex = Math.max(0, THREAD_OPTIONS.indexOf(latestSettings.concurrency));
    threadValue.value = String(THREAD_OPTIONS[initialThreadIndex]);
    threadValue.textContent = String(THREAD_OPTIONS[initialThreadIndex]);
    threadHead.append(threadLegend, threadValue);
    const threadRange = document.createElement("input");
    threadRange.type = "range";
    threadRange.min = "0";
    threadRange.max = String(THREAD_OPTIONS.length - 1);
    threadRange.step = "1";
    threadRange.value = String(initialThreadIndex);
    threadRange.setAttribute("aria-label", "并发线程");
    threadRange.addEventListener("input", () => {
      const value = THREAD_OPTIONS[Number(threadRange.value)] || 8;
      threadValue.value = String(value);
      threadValue.textContent = String(value);
    });
    const ticks = document.createElement("div");
    ticks.className = "btr-onboarding-ticks";
    for (const value of THREAD_OPTIONS) {
      const tick = document.createElement("span");
      tick.textContent = String(value);
      ticks.append(tick);
    }
    threadFieldset.append(threadHead, threadRange, ticks);

    const tip = document.createElement("p");
    tip.className = "btr-onboarding-tip";
    tip.textContent = "推荐大陆 CDN，线程数推荐 8 到 32，可以先从 8 开始，不够流畅再往上加。以后可在 B 站播放器的 ⚙ 设置中随时修改。";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btr-onboarding-save";
    save.textContent = "保存并开始加速";
    const status = document.createElement("p");
    status.className = "btr-onboarding-status";
    status.setAttribute("aria-live", "polite");
    save.addEventListener("click", () => {
      const mode = panel.querySelector('input[name="btr-onboarding-mode"]:checked')?.value === "overseas" ? "overseas" : "mainland";
      const compatibilityValue = panel.querySelector('input[name="btr-onboarding-compatibility"]:checked')?.value;
      const compatibilityMode = ["a", "b"].includes(compatibilityValue) ? compatibilityValue : "off";
      const concurrency = THREAD_OPTIONS[Number(threadRange.value)] || 8;
      save.disabled = true;
      save.textContent = "正在保存…";
      latestSettings = normalizeStoredSettings({ ...latestSettings, enabled: true, mode, compatibilityMode, concurrency });
      chrome.storage.sync.set({ enabled: true, mode, compatibilityMode, concurrency }, () => {
        if (chrome.runtime.lastError) {
          status.textContent = `保存失败：${chrome.runtime.lastError.message}`;
          save.disabled = false;
          save.textContent = "重新保存";
          return;
        }
        chrome.storage.local.set({ [ONBOARDING_STORAGE_KEY]: ONBOARDING_REVISION }, () => {
          if (chrome.runtime.lastError) {
            status.textContent = `保存失败：${chrome.runtime.lastError.message}`;
            save.disabled = false;
            save.textContent = "重新保存";
            return;
          }
          loaded = true;
          postSettings();
          notices?.configure(latestSettings);
          updateBadge();
          removeOnboarding();
        });
      });
    });

    panel.append(heading, lead, modeFieldset, compatibilityFieldset, threadFieldset, tip, save, status);
    overlay.append(panel);
    mount.append(overlay);
    save.focus({ preventScroll: true });
  }

  function showOnboardingIfNeeded() {
    if (onboardingChecked || window.top !== window) return;
    onboardingChecked = true;
    chrome.storage.local.get({ [ONBOARDING_STORAGE_KEY]: "" }, (stored) => {
      if (stored?.[ONBOARDING_STORAGE_KEY] === ONBOARDING_REVISION) return;
      setTimeout(mountOnboarding, 350);
    });
  }

  function normalizeDanmaku(input, legacyFontSize) {
    const source = input && typeof input === "object" ? input : {};
    const allowedAreas = ["quarter", "half", "threeQuarter", "full"];
    const allowedSpeeds = [1, 2.5, 5, 7.5, 10];
    const requestedSpeed = Number(source.speed);
    const requestedModes = Array.isArray(source.modes)
      ? [...new Set(source.modes.map(Number).filter((value) => [0, 1, 2].includes(value)))]
      : [0, 1, 2];
    const requestedColor = String(source.color || "").toUpperCase();
    return {
      visible: source.visible !== false,
      opacity: Math.max(0, Math.min(1, Number.isFinite(Number(source.opacity)) ? Number(source.opacity) : 0.9)),
      area: allowedAreas.includes(source.area) ? source.area : "threeQuarter",
      fontSize: Math.max(12, Math.min(64, Math.round(Number(source.fontSize ?? legacyFontSize) || 25))),
      speed: allowedSpeeds.includes(requestedSpeed) ? requestedSpeed : 5,
      modes: requestedModes,
      antiOverlap: source.antiOverlap !== false,
      synchronousPlayback: source.synchronousPlayback !== false,
      mode: [0, 1, 2].includes(Number(source.mode)) ? Number(source.mode) : 0,
      color: /^#[0-9A-F]{6}$/.test(requestedColor) ? requestedColor : "#FFFFFF"
    };
  }

  function normalizeStoredSettings(input) {
    const allowedThreads = [4, 8, 16, 32, 64, 128];
    const requested = Math.trunc(Number(input?.concurrency));
    const requestedVolume = Number(input?.volume);
    return {
      enabled: input?.enabled !== false,
      concurrency: allowedThreads.includes(requested) ? requested : 8,
      volume: Number.isFinite(requestedVolume) ? Math.max(0, Math.min(1, requestedVolume)) : 0.7,
      danmaku: normalizeDanmaku(input?.danmaku, input?.danmakuFontSize),
      mode: input?.mode === "overseas" ? "overseas" : "mainland",
      compatibilityMode: ["a", "b"].includes(input?.compatibilityMode) ? input.compatibilityMode : "off",
      debugNotices: input?.debugNotices === true,
      errorNotices: input?.errorNotices === true,
      debugCategories: Object.fromEntries(["takeover", "playback", "download", "buffer", "settings", "other"].map(key => [key, input?.debugCategories?.[key] !== false])),
      subtitleLanguage: /^[\w-]+$/i.test(String(input?.subtitleLanguage || "off"))
        ? String(input.subtitleLanguage).slice(0, 48)
        : "off",
      subtitleLastLanguage: /^[\w-]+$/i.test(String(input?.subtitleLastLanguage || ""))
        && String(input.subtitleLastLanguage).toLowerCase() !== "off"
        ? String(input.subtitleLastLanguage).slice(0, 48)
        : ""
    };
  }

  function postSettings() {
    window.postMessage({ channel: CHANNEL, type: "settings", payload: latestSettings }, "*");
  }

  function updateBadge() {
    const count = Math.max(0, Math.min(512, Math.trunc(Number(latestStats?.activeThreads) || 0)));
    const text = loaded && latestSettings.enabled !== false ? String(count) : "";
    if (text === lastBadge) return;
    lastBadge = text;
    try {
      chrome.runtime.sendMessage({ type: "setThreadBadge", enabled: latestSettings.enabled !== false, activeThreads: count })?.catch?.(() => {});
    } catch (_error) {}
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
    const migrated = { ...DEFAULTS, ...stored };
    if (!stored.danmaku && stored.danmakuFontSize !== undefined) {
      migrated.danmaku = { ...DEFAULT_DANMAKU, fontSize: stored.danmakuFontSize };
    }
    latestSettings = normalizeStoredSettings(migrated);
    if (Object.prototype.hasOwnProperty.call(stored, "statusNotice")) chrome.storage.sync.remove("statusNotice");
    if (JSON.stringify(stored.debugCategories) !== JSON.stringify(latestSettings.debugCategories) || stored.errorNotices !== latestSettings.errorNotices || stored.debugNotices !== latestSettings.debugNotices || stored.mode !== latestSettings.mode || stored.compatibilityMode !== latestSettings.compatibilityMode || stored.concurrency !== latestSettings.concurrency || stored.volume !== latestSettings.volume || stored.subtitleLanguage !== latestSettings.subtitleLanguage || stored.subtitleLastLanguage !== latestSettings.subtitleLastLanguage || JSON.stringify(stored.danmaku) !== JSON.stringify(latestSettings.danmaku)) {
      chrome.storage.sync.set({
        mode: latestSettings.mode,
        compatibilityMode: latestSettings.compatibilityMode,
        debugNotices: latestSettings.debugNotices,
        errorNotices: latestSettings.errorNotices,
        debugCategories: latestSettings.debugCategories,
        concurrency: latestSettings.concurrency,
        volume: latestSettings.volume,
        subtitleLanguage: latestSettings.subtitleLanguage,
        subtitleLastLanguage: latestSettings.subtitleLastLanguage,
        danmaku: latestSettings.danmaku
      });
    }
    loaded = true;
    notices?.configure(latestSettings);
    syncTakeoverErrorNotice();
    updateBadge();
    postSettings();
    showOnboardingIfNeeded();
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
    updateBadge();
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
    if (event.data.type === "danmaku-request") {
      const requestId = String(event.data.requestId || "").slice(0, 100);
      const cid = Number(event.data.cid);
      if (!requestId || !Number.isSafeInteger(cid) || cid <= 0) return;
      chrome.runtime.sendMessage({ type: "fetchDanmakuXml", cid }).then(
        (payload) => window.postMessage({ channel: CHANNEL, type: "danmaku-response", requestId, payload }, "*"),
        (error) => window.postMessage({
          channel: CHANNEL,
          type: "danmaku-response",
          requestId,
          payload: { ok: false, error: String(error?.message || error).slice(0, 180) }
        }, "*")
      );
      return;
    }
    if (event.data.type === "subtitle-request") {
      const requestId = String(event.data.requestId || "").slice(0, 100);
      const url = String(event.data.url || "").slice(0, 4096);
      if (!requestId || !url) return;
      chrome.runtime.sendMessage({ type: "fetchSubtitleText", url }).then(
        (payload) => window.postMessage({ channel: CHANNEL, type: "subtitle-response", requestId, payload }, "*"),
        (error) => window.postMessage({
          channel: CHANNEL,
          type: "subtitle-response",
          requestId,
          payload: { ok: false, error: String(error?.message || error).slice(0, 180) }
        }, "*")
      );
      return;
    }
    if (event.data.type === "settings-update") {
      const input = event.data.payload;
      if (!input || typeof input !== "object") return;
      const update = {};
      if (input.mode === "mainland" || input.mode === "overseas") update.mode = input.mode;
      if (["off", "a", "b"].includes(input.compatibilityMode)) update.compatibilityMode = input.compatibilityMode;
      const concurrency = Math.trunc(Number(input.concurrency));
      if ([4, 8, 16, 32, 64, 128].includes(concurrency)) update.concurrency = concurrency;
      const volume = Number(input.volume);
      if (Number.isFinite(volume)) update.volume = Math.max(0, Math.min(1, volume));
      if (input.danmaku && typeof input.danmaku === "object") update.danmaku = normalizeDanmaku(input.danmaku);
      if (/^[\w-]+$/i.test(String(input.subtitleLanguage || ""))) update.subtitleLanguage = String(input.subtitleLanguage).slice(0, 48);
      if (input.subtitleLastLanguage === "") update.subtitleLastLanguage = "";
      else if (/^[\w-]+$/i.test(String(input.subtitleLastLanguage || "")) && String(input.subtitleLastLanguage).toLowerCase() !== "off") update.subtitleLastLanguage = String(input.subtitleLastLanguage).slice(0, 48);
      if (Object.keys(update).length) chrome.storage.sync.set(update);
      return;
    }
    if (event.data.type !== "stats") return;
    const input = event.data.payload;
    if (!input || typeof input !== "object") return;
    latestStats = {
      version: String(input.version || ""),
      architecture: String(input.architecture || ""),
      mode: input.mode === "overseas" ? "overseas" : "mainland",
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
      lastError: String(input.lastError || "").replace(/[\u00b7\u2022\u2027\u2219\u22c5]+/g, "，").slice(0, 180),
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
    updateBadge();
    syncTakeoverErrorNotice();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "getStatus") return false;
    window.postMessage({ channel: CHANNEL, type: "get-stats" }, "*");
    sendResponse({ settings: latestSettings, stats: latestStats });
    return false;
  });
})();

/* popup/popup.html, popup/popup.css */
const POPUP_HTML = "<main>\n      <header>\n        <div class=\"logo\" aria-hidden=\"true\">B</div>\n        <h1>线程撕裂者</h1>\n        <label class=\"switch\" title=\"启用或停用\">\n          <input id=\"enabled\" type=\"checkbox\">\n          <span></span>\n        </label>\n      </header>\n\n      <section class=\"mode-select\" aria-label=\"CDN 模式\">\n        <label><input type=\"radio\" name=\"mode\" value=\"mainland\"><span>大陆</span></label>\n        <label><input type=\"radio\" name=\"mode\" value=\"overseas\"><span>海外</span></label>\n      </section>\n\n      <section class=\"compatibility-select\" aria-label=\"兼容模式\">\n        <label><input type=\"radio\" name=\"compatibility-mode\" value=\"off\"><span>标准模式</span></label>\n        <label><input type=\"radio\" name=\"compatibility-mode\" value=\"a\"><span>兼容模式 A</span></label>\n        <label><input type=\"radio\" name=\"compatibility-mode\" value=\"b\"><span>兼容模式 B</span></label>\n      </section>\n\n      <section class=\"controls\">\n        <div class=\"control-title\">\n          <label for=\"concurrency\">线程加载数</label>\n          <output id=\"thread-value\" for=\"concurrency\">8</output>\n        </div>\n        <div class=\"slider\">\n          <div id=\"slider-fill\" class=\"slider-fill\" aria-hidden=\"true\"></div>\n          <input id=\"concurrency\" type=\"range\" min=\"0\" max=\"5\" step=\"1\" value=\"1\" aria-label=\"线程加载数\" aria-valuetext=\"8\">\n        </div>\n        <div class=\"scale\" aria-hidden=\"true\">\n          <span>4</span><span>8</span><span>16</span><span>32</span><span>64</span><span>128</span>\n        </div>\n      </section>\n\n      <section class=\"notice-controls\" aria-label=\"提示设置\">\n        <div class=\"notice-row\"><label for=\"error-notices\">显示错误</label><label class=\"switch\"><input id=\"error-notices\" type=\"checkbox\" aria-label=\"显示错误\"><span></span></label></div>\n        <div class=\"notice-row\"><label for=\"debug-notices\">Debug 模式</label><label class=\"switch\"><input id=\"debug-notices\" type=\"checkbox\" aria-label=\"Debug 模式\"><span></span></label></div>\n        <fieldset id=\"debug-filters\" class=\"debug-filters\" hidden>\n          <legend>显示哪些 Debug 消息</legend>\n          <div class=\"debug-filter-actions\"><button id=\"debug-select-all\" type=\"button\">全选</button><button id=\"debug-select-none\" type=\"button\">全不选</button></div>\n          <div class=\"debug-filter-options\">\n            <label><input type=\"checkbox\" data-debug-category=\"takeover\">接管与切换</label>\n            <label><input type=\"checkbox\" data-debug-category=\"playback\">播放与暂停</label>\n            <label><input type=\"checkbox\" data-debug-category=\"download\">下载线程</label>\n            <label><input type=\"checkbox\" data-debug-category=\"buffer\">缓冲与跳转</label>\n            <label><input type=\"checkbox\" data-debug-category=\"settings\">设置变化</label>\n            <label><input type=\"checkbox\" data-debug-category=\"other\">其他日志</label>\n          </div>\n        </fieldset>\n      </section>\n\n      <section class=\"current-threads\" aria-live=\"polite\">\n        <span>目前总线程</span>\n        <b id=\"active-count\">0</b>\n      </section>\n\n    </main>";
const POPUP_CSS = ":root {\n  color-scheme: dark;\n  font-family: Inter, \"PingFang SC\", \"Microsoft YaHei\", system-ui, sans-serif;\n  background: #17191f;\n  color: #f5f7fb;\n}\n\n* { box-sizing: border-box; }\n\nbody {\n  width: auto;\n  min-width: 280px;\n  margin: 0;\n  background: #17191f;\n}\n\nmain {\n  min-height: 100vh;\n  padding: 18px 16px;\n}\n\nheader {\n  display: grid;\n  grid-template-columns: 42px 1fr auto;\n  align-items: center;\n  gap: 11px;\n  margin-bottom: 22px;\n}\n\n.mode-select {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 1px;\n  margin-bottom: 12px;\n  overflow: hidden;\n  border: 1px solid #30343d;\n  border-radius: 8px;\n  background: #30343d;\n}\n\n.mode-select label { position: relative; }\n.mode-select input { position: absolute; opacity: 0; }\n.mode-select span {\n  display: block;\n  padding: 10px 6px;\n  color: #949baa;\n  background: #20232a;\n  font-size: 12px;\n  text-align: center;\n  cursor: pointer;\n}\n.mode-select input:checked + span { color: #fff; background: #fb7299; }\n.mode-select input:focus-visible + span { outline: 2px solid #fff; outline-offset: -3px; }\n\n.compatibility-select {\n  display: grid;\n  grid-template-columns: repeat(3, 1fr);\n  gap: 1px;\n  margin-bottom: 12px;\n  overflow: hidden;\n  border: 1px solid #30343d;\n  border-radius: 8px;\n  background: #30343d;\n}\n\n.compatibility-select label { position: relative; }\n.compatibility-select input { position: absolute; opacity: 0; }\n.compatibility-select span {\n  display: block;\n  padding: 10px 3px;\n  color: #949baa;\n  background: #20232a;\n  font-size: 11px;\n  text-align: center;\n  white-space: nowrap;\n  cursor: pointer;\n}\n.compatibility-select input:checked + span { color: #fff; background: #fb7299; }\n.compatibility-select input:focus-visible + span { outline: 2px solid #fff; outline-offset: -3px; }\n\n.logo {\n  display: grid;\n  place-items: center;\n  width: 42px;\n  height: 42px;\n  border-radius: 8px;\n  color: #fff;\n  font-size: 23px;\n  font-weight: 800;\n  background: #fb7299;\n}\n\nh1 { margin: 0; font-size: 17px; letter-spacing: 0.2px; }\n.switch { position: relative; width: 42px; height: 24px; }\n.switch input { position:absolute; inset:0; z-index:1; width:100%; height:100%; margin:0; opacity:0; cursor:pointer; }\n.switch span {\n  position: absolute;\n  inset: 0;\n  border-radius: 999px;\n  background: #313a4c;\n  cursor: pointer;\n  transition: 160ms ease;\n}\n.switch span::after {\n  content: \"\";\n  position: absolute;\n  top: 3px;\n  left: 3px;\n  width: 18px;\n  height: 18px;\n  border-radius: 50%;\n  background: #fff;\n  transition: 160ms ease;\n}\n.switch input:checked + span { background: #fb7299; }\n.switch input:checked + span::after { transform: translateX(18px); }\n.switch input:focus-visible + span { outline: 2px solid #fff; outline-offset: 3px; }\n.notice-controls { margin-top:12px; padding:14px 16px; border:1px solid #30343d; border-radius:8px; background:#20232a; }\n.notice-row { display:flex; align-items:center; justify-content:space-between; gap:12px; color:#c9ced9; font-size:13px; }\n.notice-row + .notice-row { margin-top:14px; }\n.debug-filters { min-width:0; margin:16px 0 0; padding:12px 0 0; border:0; border-top:1px solid #343943; }\n.debug-filters[hidden] { display:none; }\n.debug-filters legend { padding:0 0 4px; color:#c9ced9; font-size:12px; }\n.debug-filter-actions { display:flex; gap:8px; margin-bottom:12px; }\n.debug-filter-actions button { padding:4px 8px; border:1px solid #444b57; border-radius:4px; background:#292d35; color:#d9dee8; font:inherit; font-size:11px; cursor:pointer; }\n.debug-filter-actions button:hover { border-color:#fb7299; }\n.debug-filter-options { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px 8px; }\n.debug-filter-options label { display:flex; align-items:center; gap:7px; color:#c9ced9; font-size:12px; cursor:pointer; }\n.debug-filter-options input { flex:none; width:15px; height:15px; margin:0; accent-color:#fb7299; cursor:pointer; }\n.debug-filter-actions button:focus-visible,.debug-filter-options input:focus-visible { outline:2px solid #fff; outline-offset:3px; }\n\n.controls {\n  padding: 16px;\n  border: 1px solid #30343d;\n  border-radius: 8px;\n  background: #20232a;\n}\n\n.control-title {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  margin-bottom: 14px;\n}\n\n.control-title label {\n  color: #c9ced9;\n  font-size: 13px;\n}\n\noutput {\n  min-width: 42px;\n  padding: 4px 8px;\n  border-radius: 5px;\n  color: #fff;\n  background: #fb7299;\n  font-size: 13px;\n  font-weight: 700;\n  text-align: center;\n}\n\n.slider {\n  position: relative;\n  width: 100%;\n  height: 18px;\n  border-radius: 9px;\n  background: #3a3e47;\n}\n\n.slider-fill {\n  position: absolute;\n  top: 0;\n  bottom: 0;\n  left: 0;\n  width: 60%;\n  border-radius: 9px;\n  background: #fb7299;\n  pointer-events: none;\n}\n\ninput[type=\"range\"] {\n  position: absolute;\n  inset: 0;\n  width: 100%;\n  height: 18px;\n  margin: 0;\n  appearance: none;\n  -webkit-appearance: none;\n  border: 0;\n  outline: 0;\n  background: transparent;\n  cursor: pointer;\n}\n\ninput[type=\"range\"]::-webkit-slider-runnable-track {\n  height: 18px;\n  background: transparent;\n}\n\ninput[type=\"range\"]::-webkit-slider-thumb {\n  width: 24px;\n  height: 24px;\n  margin-top: -3px;\n  appearance: none;\n  -webkit-appearance: none;\n  border: 2px solid #ffffff;\n  border-radius: 50%;\n  background: #ffffff;\n}\n\ninput[type=\"range\"]:focus-visible::-webkit-slider-thumb {\n  border-color: #fb7299;\n}\n\n.scale {\n  display: flex;\n  justify-content: space-between;\n  margin-top: 5px;\n  color: #7f8797;\n  font-size: 10px;\n}\n\n.scale span {\n  width: 24px;\n  text-align: center;\n}\n\n.scale span:first-child { text-align: left; }\n.scale span:last-child { text-align: right; }\n\n.current-threads {\n  margin-top: 12px;\n  padding: 16px;\n  border: 1px solid #30343d;\n  border-radius: 8px;\n  background: #20232a;\n}\n\n.current-threads {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  color: #c9ced9;\n  font-size: 13px;\n}\n\n.current-threads b {\n  color: #ffffff;\n  font-size: 20px;\n  font-variant-numeric: tabular-nums;\n}";

/* popup/popup.js */
function runPopup(document, chrome, window) {
"use strict";

const THREAD_OPTIONS = [4, 8, 16, 32, 64, 128];
const enabled = document.getElementById("enabled");
const debugNotices = document.getElementById("debug-notices");
const errorNotices = document.getElementById("error-notices");
const debugFilters = document.getElementById("debug-filters");
const debugCategoryInputs = [...document.querySelectorAll("[data-debug-category]")];
const concurrency = document.getElementById("concurrency");
const threadValue = document.getElementById("thread-value");
const sliderFill = document.getElementById("slider-fill");
const activeCount = document.getElementById("active-count");
let timer = null;

async function refresh() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("没有活动标签页");
    const response = await chrome.tabs.sendMessage(tab.id, { type: "getStatus" });
    activeCount.textContent = String(Math.max(0, Number(response?.stats?.activeThreads) || 0));
  } catch (_error) {
    activeCount.textContent = "0";
  }
}

function setSlider(threads) {
  const index = THREAD_OPTIONS.indexOf(Number(threads));
  const safe = index < 0 ? 1 : index;
  concurrency.value = String(safe);
  threadValue.value = String(THREAD_OPTIONS[safe]);
  concurrency.setAttribute("aria-valuetext", String(THREAD_OPTIONS[safe]));
  sliderFill.style.width = `${safe / (THREAD_OPTIONS.length - 1) * 100}%`;
}

async function init() {
  const stored = await chrome.storage.sync.get({ enabled: true, concurrency: 8, mode: "mainland", compatibilityMode: "off", debugNotices: false, errorNotices: false, debugCategories: {} });
  enabled.checked = stored.enabled !== false;
  debugNotices.checked = stored.debugNotices === true;
  debugFilters.hidden = !debugNotices.checked;
  debugNotices.addEventListener("change", () => {
    debugFilters.hidden = !debugNotices.checked;
    chrome.storage.sync.set({ debugNotices: debugNotices.checked });
  });
  for (const input of debugCategoryInputs) input.checked = stored.debugCategories?.[input.dataset.debugCategory] !== false;
  const saveDebugCategories = () => chrome.storage.sync.set({ debugCategories: Object.fromEntries(debugCategoryInputs.map(input => [input.dataset.debugCategory, input.checked])) });
  for (const input of debugCategoryInputs) input.addEventListener("change", saveDebugCategories);
  document.getElementById("debug-select-all").addEventListener("click", () => { for (const input of debugCategoryInputs) input.checked = true; saveDebugCategories(); });
  document.getElementById("debug-select-none").addEventListener("click", () => { for (const input of debugCategoryInputs) input.checked = false; saveDebugCategories(); });
  errorNotices.checked = stored.errorNotices === true;
  errorNotices.addEventListener("change", () => chrome.storage.sync.set({ errorNotices: errorNotices.checked }));
  setSlider(stored.concurrency);
  const chosen = document.querySelector(`input[name="mode"][value="${stored.mode === "overseas" ? "overseas" : "mainland"}"]`);
  const compatibilityValue = ["off", "a", "b"].includes(stored.compatibilityMode) ? stored.compatibilityMode : "off";
  const compatibilityChosen = document.querySelector(`input[name="compatibility-mode"][value="${compatibilityValue}"]`);
  chosen.checked = true;
  compatibilityChosen.checked = true;
  await chrome.storage.sync.set({ enabled: enabled.checked, concurrency: THREAD_OPTIONS[Number(concurrency.value)], mode: chosen.value, compatibilityMode: compatibilityChosen.value });
  enabled.addEventListener("change", () => chrome.storage.sync.set({ enabled: enabled.checked }));
  concurrency.addEventListener("input", () => {
    const threads = THREAD_OPTIONS[Number(concurrency.value)];
    setSlider(threads);
    chrome.storage.sync.set({ concurrency: threads });
  });
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener("change", () => { if (radio.checked) chrome.storage.sync.set({ mode: radio.value }); });
  }
  for (const radio of document.querySelectorAll('input[name="compatibility-mode"]')) {
    radio.addEventListener("change", () => { if (radio.checked) chrome.storage.sync.set({ compatibilityMode: radio.value }); });
  }
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (changes.debugNotices) {
      debugNotices.checked = changes.debugNotices.newValue === true;
      debugFilters.hidden = !debugNotices.checked;
    }
    if (changes.debugCategories) for (const input of debugCategoryInputs) input.checked = changes.debugCategories.newValue?.[input.dataset.debugCategory] !== false;
    if (changes.errorNotices) errorNotices.checked = changes.errorNotices.newValue === true;
    if (changes.enabled) enabled.checked = changes.enabled.newValue !== false;
    if (changes.concurrency) setSlider(changes.concurrency.newValue);
    if (changes.mode) {
      const radio = document.querySelector(`input[name="mode"][value="${changes.mode.newValue === "overseas" ? "overseas" : "mainland"}"]`);
      if (radio) radio.checked = true;
    }
    if (changes.compatibilityMode) {
      const next = ["off", "a", "b"].includes(changes.compatibilityMode.newValue) ? changes.compatibilityMode.newValue : "off";
      const radio = document.querySelector(`input[name="compatibility-mode"][value="${next}"]`);
      if (radio) radio.checked = true;
    }
  });
  await refresh();
  timer = setInterval(refresh, 400);
}

init();
window.addEventListener("unload", () => clearInterval(timer));
}

/* user_scripts/adapter/settings-panel.js */
// The extension's sidebar page (popup/popup.html, popup.css, popup.js), shown inside the
// bilibili page. The userscript manager's menu opens it; POPUP_HTML, POPUP_CSS and
// runPopup are filled in from the popup folder when the userscript is built.
(function installSettingsPanel() {
  "use strict";

  const HOST_ID = "__bilibili_thread_ripper_userscript_settings__";
  const DIALOG_ID = "__bilibili_thread_ripper_userscript_dialog__";
  const PANEL_STYLE = `
    .btr-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .35); }
    .btr-popup { position: fixed; top: 72px; right: 24px; width: 320px; max-width: calc(100vw - 32px); max-height: calc(100vh - 96px); overflow: auto; border: 1px solid #30343d; border-radius: 12px; box-shadow: 0 12px 40px rgba(0, 0, 0, .45); }
    .btr-popup main { min-height: 0; }
    .btr-close { position: sticky; bottom: 12px; display: block; width: calc(100% - 32px); margin: 0 16px 16px; padding: 8px; border: 1px solid #444b57; border-radius: 6px; background: #292d35; color: #d9dee8; font: inherit; font-size: 13px; cursor: pointer; box-shadow: 0 -6px 12px #17191f; }
    .btr-close:hover { border-color: #fb7299; }
    .btr-close:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  `;
  let current = null;

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
    // The sidebar styles its whole page; here the same rules apply to the floating panel.
    style.textContent = POPUP_CSS.replace(/^:root\s*\{/m, ".btr-popup {").replace(/^body\s*\{/m, ".btr-popup {") + PANEL_STYLE;
    const backdrop = document.createElement("div");
    backdrop.className = "btr-backdrop";
    const panel = document.createElement("div");
    panel.className = "btr-popup";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "线程撕裂者设置");
    panel.tabIndex = -1;
    panel.innerHTML = POPUP_HTML;
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "btr-close";
    closeButton.textContent = "关闭";
    panel.append(closeButton);
    shadow.append(style, backdrop, panel);

    // popup.js runs unchanged: its document is this panel, its tab is this page.
    const storageListeners = [], unloadListeners = [];
    const pageChrome = {
      storage: {
        sync: chrome.storage.sync,
        onChanged: { addListener(listener) { storageListeners.push(listener); chrome.storage.onChanged.addListener(listener); } }
      },
      tabs: {
        query: () => Promise.resolve([{ id: 1 }]),
        sendMessage: (_tabId, message) => chrome.runtime.dispatch(message)
      }
    };
    const pageWindow = { addEventListener(type, listener) { if (type === "unload") unloadListeners.push(listener); } };
    const onKey = (event) => { if (event.key === "Escape") close(); };
    const close = () => {
      if (current?.host !== host) return;
      current = null;
      for (const listener of unloadListeners) listener();
      for (const listener of storageListeners) chrome.storage.onChanged.removeListener(listener);
      document.removeEventListener("keydown", onKey, true);
      dialog.remove();
    };
    current = { host, close };
    backdrop.addEventListener("click", close);
    closeButton.addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);
    // Esc on a modal dialog closes it natively; clean up the same way as the button.
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    (document.body || document.documentElement).append(dialog);
    try { dialog.showModal(); }
    catch (_error) { dialog.setAttribute("open", ""); }
    runPopup(shadow, pageChrome, pageWindow);
    panel.focus();
  }

  document.addEventListener("btr-userscript-open-settings", () => (current ? current.close() : open()));
})();
}

/* user_scripts/adapter/loader.js */
// Runs wherever the userscript manager puts the script. The accelerator itself has to run in
// the bilibili page, so pageCode is started there. The manager's menu only sends a page
// event that opens the settings panel.
const LOADED = "data-btr-userscript";
const pageWindow = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;

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

if (pageWindow === window) pageCode();
else if (document.documentElement) inject();
else {
  const observer = new MutationObserver(() => {
    if (!document.documentElement) return;
    observer.disconnect();
    inject();
  });
  observer.observe(document, { childList: true });
}

if (typeof GM_registerMenuCommand === "function") {
  GM_registerMenuCommand("线程撕裂者设置", () => document.dispatchEvent(new CustomEvent("btr-userscript-open-settings")));
}
})();
