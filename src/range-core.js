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

  // The bytes the compatibility mode delivered, kept in memory (native-range-transport.js).
  // Bilibili's player empties its whole buffer when it seeks to a place it has not buffered,
  // what lies after the old position included, and then asks for the same bytes again.
  //
  // Each file (the key) keeps byte ranges that never overlap: new bytes only fill the gaps,
  // so 1-4 and then 2-5 are held once. A request is answered only when the ranges hold every
  // byte of it; otherwise it is downloaded as before. Past the limit, the ranges used least
  // recently go first. Bytes go in and come out as copies: the caller keeps its own buffer.
  function createRangeCache(limitBytes) {
    const limit = Math.max(0, Number(limitBytes) || 0);
    const files = new Map();
    let size = 0, clock = 0;
    function drop(key) {
      const file = files.get(key);
      if (!file) return;
      for (const piece of file.pieces) size -= piece.bytes.byteLength;
      files.delete(key);
    }
    function evict() {
      while (size > limit) {
        let oldest = null, owner = null;
        for (const [key, file] of files) {
          for (const piece of file.pieces) if (!oldest || piece.used < oldest.used) { oldest = piece; owner = key; }
        }
        if (!oldest) return;
        const file = files.get(owner);
        file.pieces.splice(file.pieces.indexOf(oldest), 1);
        size -= oldest.bytes.byteLength;
        if (!file.pieces.length) files.delete(owner);
      }
    }
    return {
      // The bytes from start to end (both included) and the file's length, or null.
      get(key, start, end) {
        const file = files.get(key);
        if (!file || !(end >= start) || end >= file.total) return null;
        const output = new Uint8Array(end - start + 1), used = [];
        let at = start;
        for (const piece of file.pieces) {
          if (piece.end < at) continue;
          if (piece.start > at) return null;
          const to = Math.min(piece.end, end);
          output.set(piece.bytes.subarray(at - piece.start, to - piece.start + 1), at - start);
          used.push(piece);
          at = to + 1;
          if (at > end) break;
        }
        if (at <= end) return null;
        clock += 1;
        for (const piece of used) piece.used = clock;
        return { bytes: output, total: file.total };
      },
      put(key, start, bytes, total) {
        const end = start + bytes.byteLength - 1;
        if (!bytes.byteLength || bytes.byteLength > limit || !Number.isSafeInteger(total) || end >= total) return;
        let file = files.get(key);
        // Another length is another file: what was kept of the old one is no use.
        if (file && file.total !== total) { drop(key); file = null; }
        if (!file) { file = { total, pieces: [] }; files.set(key, file); }
        clock += 1;
        const gaps = [];
        let at = start;
        for (const piece of file.pieces) {
          if (piece.end < at) continue;
          if (piece.start > end) break;
          if (piece.start > at) gaps.push([at, piece.start - 1]);
          at = Math.max(at, piece.end + 1);
          if (at > end) break;
        }
        if (at <= end) gaps.push([at, end]);
        for (const [from, to] of gaps) {
          file.pieces.push({ start: from, end: to, bytes: bytes.slice(from - start, to - start + 1), used: clock });
          size += to - from + 1;
        }
        file.pieces.sort((a, b) => a.start - b.start);
        evict();
      },
      clear() { files.clear(); size = 0; },
      get size() { return size; }
    };
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
      secondaryBuffer: source.secondaryBuffer === true,
      // 音频加速: switched off, only the video is sped up. The full takeover then fetches the
      // audio as one piece over one connection; the compatibility mode leaves it to Bilibili.
      audioAcceleration: source.audioAcceleration !== false,
      // 自动清晰度的最高档: the best quality 自动 may choose in the full takeover; 0 for no limit.
      autoQualityMax: [32, 64, 80, 116, 120].includes(Number(source.autoQualityMax)) ? Number(source.autoQualityMax) : 0
    };
  }

  // A speed in bytes a second, as the panels write it: KB/s, MB/s from one megabyte up.
  function formatSpeed(bps) {
    const value = Math.max(0, Number(bps) || 0);
    if (value >= 1048576) return `${(value / 1048576).toFixed(value >= 10 * 1048576 ? 0 : 1)} MB/s`;
    return `${Math.round(value / 1024)} KB/s`;
  }

  root.__BILI_RANGE_CORE__ = Object.freeze({
    concatChunks,
    createRangeCache,
    formatSpeed,
    isBilibiliMediaUrl,
    normalizeCdnHost,
    normalizeSettings,
    parseByteRange,
    parseContentRange,
    parseRangeHeader,
    splitRange
  });
})(globalThis);
