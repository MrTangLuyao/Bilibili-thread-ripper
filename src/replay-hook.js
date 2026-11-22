(function installReplayHook(root) {
  "use strict";

  // The replay module: the live clip pages (live.bilibili.com/web-cut/…) play finished
  // recordings of a stream through hls.js — a VOD playlist of segments that hls.js loads
  // one at a time over XMLHttpRequest with a 20-second buffer, and that the page's 下载
  // button loads five at a time with fetch, all from the one node Bilibili handed out.
  // Overseas each of those requests is slow on its own, so the page stalls and downloads
  // crawl. This module reads every replay playlist the page loads and, once the page asks
  // for a segment, downloads the ones after it in parallel (hedged across the nodes that
  // provably serve the same bytes) into memory; the page's own requests are then answered
  // from there. Requests it has nothing for go to the network as before.
  if (!(/^live\.bilibili\.com$/i.test(root.location?.hostname || "") && /^\/web-cut\//i.test(root.location?.pathname || ""))
    && root.__BTR_TEST_ALLOW_REPLAY__ !== true) return;

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const INSTALL_FLAG = "__biliThreadRipperReplayInstalled";
  const core = root.__BILI_LIVE_CORE__;
  const rangeCore = root.__BILI_RANGE_CORE__;
  if (!core || !rangeCore || typeof root.fetch !== "function" || root[INSTALL_FLAG]) return;
  Object.defineProperty(root, INSTALL_FLAG, { value: true });

  const nativeFetch = root.fetch.bind(root);
  // How far ahead of the segment the page last asked for: in seconds of video, and at most
  // this many segments.
  const AHEAD_SECONDS = 90;
  const AHEAD_LIMIT = 48;
  // Downloaded segments nobody has asked for yet stop the prefetch at this size.
  const CACHE_BYTES = 256 * 1024 * 1024;
  // A served segment is kept briefly, for a retry of the same request, then let go.
  const SERVED_KEEP_MS = 10000;
  // A prefetched segment nobody asked for is dropped after this; its signature may expire.
  const UNSERVED_KEEP_MS = 5 * 60 * 1000;
  // The second node starts on a segment when the first has sent nothing by then, or failed.
  const HEDGE_FIRST_BYTE_MS = 1500;
  const FIRST_BYTE_TIMEOUT_MS = 6000;
  const SEGMENT_TIMEOUT_MS = 45000;
  const PROBE_BYTES = 4096;
  const PROBE_TIMEOUT_MS = 5000;
  const PLAYLIST_LIMIT = 8;
  const BILIVIDEO_HOST_RE = /(?:^|\.)bilivideo\.(?:com|cn|net)$/i;

  let settings = rangeCore.normalizeSettings({});
  let settingsLoaded = false;
  // Rides on 直播加速: off until the saved settings have arrived, and then only if the viewer
  // switched that on.
  const replayOn = () => settingsLoaded && settings.enabled && settings.liveEnabled;
  const parallel = () => Math.min(16, Math.max(4, Math.trunc(Number(settings.concurrency)) || 8));

  // ---- stats for the settings panel, in the live module's shape ----
  const stats = {
    version: "__BTR_VERSION__",
    architecture: "replay-segment-ripper",
    mode: "live",
    playerState: "waiting",
    quality: "直播回放",
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
  const events = [];
  function remember(level, what, detail = "") {
    events.push({ at: Math.round(performance.now()), level, what, detail: String(detail).slice(0, 200) });
    if (events.length > 60) events.shift();
  }
  const activeTransfers = new Map();
  let transferSequence = 1;
  let publishTimer = null;

  // ---- state ----
  // playlist URL -> { url, segments: [{url, index, start, duration}], mapUrl, cursor }
  const playlists = new Map();
  // segment (or init map) URL -> { list, index }; index -1 is the init map
  const segmentIndex = new Map();
  // origin host -> { origin, pool, probing }
  const pools = new Map();
  // segment URL -> { promise, done, bytes, at, servedAt, waiters, stop }
  const cache = new Map();
  let queue = [];
  let inflight = 0;
  let urgent = 0;
  let activeList = null;

  const hostnameOf = (value) => { try { return new URL(value).hostname.toLowerCase(); } catch (_error) { return ""; } };
  const absolute = (value) => { try { return new URL(String(value), root.location?.href).href; } catch (_error) { return ""; } };
  const swapHost = (url, host) => { const u = new URL(url); u.hostname = host; u.port = ""; return u.href; };
  const isPlaylistUrl = (url) => /m3u8/i.test(String(url || ""));
  // An address without its query (signatures) for the event log.
  const addressOnly = (url) => { try { const u = new URL(url); return `${u.hostname}${u.pathname}`; } catch (_error) { return ""; } };
  // The first few media requests that matched no known segment, for the event log: what to
  // look at when nothing is accelerated.
  let unmatchedNoted = 0;
  function noteUnmatched(url) {
    if (unmatchedNoted >= 5 || !/\.(?:m4s|ts|mp4|m4v|m4a|aac)(?:[?#]|$)/i.test(url)) return;
    unmatchedNoted += 1;
    remember("info", "unmatched media request", addressOnly(url));
  }
  const looksLikePlaylist =(text) => typeof text === "string" && /^\s*#EXTM3U/.test(text.slice(0, 64));
  const abortError = () => new DOMException("已取消", "AbortError");

  function unservedBytes() {
    let total = 0;
    for (const item of cache.values()) if (item.done && !item.servedAt) total += item.bytes;
    return total;
  }

  function publish() {
    clearTimeout(publishTimer);
    publishTimer = null;
    const now = Date.now();
    stats.activeThreads = activeTransfers.size;
    stats.parallelSubrequests = activeTransfers.size;
    stats.threadSpeeds = [...activeTransfers.values()].filter((item) => now - item.at < 2000).map((item) => Math.round(item.bps));
    stats.totalSpeedBps = stats.threadSpeeds.reduce((sum, bps) => sum + bps, 0);
    stats.cdnHosts = [...pools.values()].flatMap((entry) => entry.pool.status());
    stats.discoveredCdns = stats.cdnHosts.length;
    stats.healthyCdns = stats.cdnHosts.filter((item) => item.state === "healthy").length;
    stats.blockedCdns = stats.cdnHosts.filter((item) => ["blocked", "banned"].includes(item.state)).length;
    // Seconds of video downloaded ahead of the segment last asked for.
    let ahead = 0;
    if (activeList && activeList.cursor >= 0) {
      for (let i = activeList.cursor + 1; i < activeList.segments.length; i += 1) {
        const item = cache.get(activeList.segments[i].url);
        if (!item?.done) break;
        ahead += activeList.segments[i].duration;
      }
    }
    stats.bufferedAhead = Math.round(ahead);
    root.postMessage({ channel: CHANNEL, type: "stats", payload: { ...stats } }, "*");
  }
  function schedulePublish() {
    if (!publishTimer) publishTimer = setTimeout(publish, 250);
  }

  // ---- playlists ----
  function forgetList(list) {
    for (const [url, ref] of segmentIndex) if (ref.list === list) segmentIndex.delete(url);
    if (activeList === list) activeList = null;
  }

  function registerPlaylist(playlistUrl, text) {
    if (!replayOn() || !playlistUrl) return;
    // A master playlist only names the media playlists, which hls.js loads next. Everything on
    // the clip pages is a recording, so a media playlist without an end marker is taken too.
    if (/#EXT-X-STREAM-INF/.test(text)) { remember("info", "master playlist", addressOnly(playlistUrl)); return; }
    const parsed = core.parseVodPlaylist(text, playlistUrl);
    if (!parsed.segments.length) { remember("info", "playlist ignored", `no segments: ${addressOnly(playlistUrl)}`); return; }
    const previous = playlists.get(playlistUrl);
    if (previous) { forgetList(previous); playlists.delete(playlistUrl); }
    const list = { url: playlistUrl, segments: parsed.segments, mapUrl: parsed.mapUrl, cursor: -1 };
    playlists.set(playlistUrl, list);
    for (const segment of parsed.segments) segmentIndex.set(segment.url, { list, index: segment.index });
    if (parsed.mapUrl) segmentIndex.set(parsed.mapUrl, { list, index: -1 });
    while (playlists.size > PLAYLIST_LIMIT) {
      const [oldestUrl, oldest] = playlists.entries().next().value;
      playlists.delete(oldestUrl);
      forgetList(oldest);
    }
    probeCandidates(poolFor(parsed.segments[0].url), parsed.segments[0].url);
    stats.playerState = "ready";
    remember("info", "replay playlist", `${parsed.segments.length} segments, ${Math.round(parsed.duration)} s${core.isVodPlaylist(text) ? "" : " (no end marker)"}: ${addressOnly(playlistUrl)} → ${addressOnly(parsed.segments[0].url)}`);
    schedulePublish();
  }

  // ---- nodes ----
  // The node Bilibili handed out is always in. Other nodes join only after a probe shows they
  // serve the very same bytes for a segment of this recording: in the custom CDN mode the
  // servers the viewer picked, otherwise, for a bilivideo origin, the fMP4 node group whose
  // signatures the live module found shared.
  function poolFor(url) {
    const origin = hostnameOf(url);
    let entry = pools.get(origin);
    if (entry) return entry;
    const pool = core.createHostPool({
      onBan(host) { remember("warn", "node banned", host); }
    });
    pool.add(origin, true);
    const extra = settings.mode === "custom" ? settings.customHosts : BILIVIDEO_HOST_RE.test(origin) ? core.KNOWN_FMP4_HOSTS : [];
    for (const host of extra) if (host !== origin) pool.add(host, false);
    entry = { origin, pool, probing: false };
    pools.set(origin, entry);
    probeCandidates(entry, url);
    return entry;
  }

  function withTimeout(task, ms, message) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException(message, "TimeoutError")), ms);
    return task(controller.signal).finally(() => clearTimeout(timer));
  }

  async function readHead(url, signal) {
    const response = await nativeFetch(url, { headers: { Range: `bytes=0-${PROBE_BYTES - 1}` }, credentials: "omit", cache: "no-store", signal });
    if (response.status !== 200 && response.status !== 206) {
      response.body?.cancel?.().catch?.(() => {});
      throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    }
    const reader = response.body?.getReader?.();
    if (!reader) return new Uint8Array(await response.arrayBuffer()).slice(0, PROBE_BYTES);
    const chunks = [];
    let size = 0;
    while (size < PROBE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
    reader.cancel().catch(() => {});
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes.slice(0, PROBE_BYTES);
  }

  function sameBytes(a, b) {
    if (!a.byteLength || a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
    return true;
  }

  async function probeCandidates(entry, sampleUrl) {
    if (entry.probing) return;
    const candidates = entry.pool.unproven();
    if (!candidates.length) return;
    entry.probing = true;
    try {
      const reference = await withTimeout((signal) => readHead(sampleUrl, signal), PROBE_TIMEOUT_MS, "回放节点探测超时");
      await Promise.allSettled(candidates.map(async (host) => {
        const startedAt = performance.now();
        try {
          const head = await withTimeout((signal) => readHead(swapHost(sampleUrl, host), signal), PROBE_TIMEOUT_MS, "回放节点探测超时");
          if (sameBytes(head, reference)) {
            entry.pool.success(host, performance.now() - startedAt, 0);
            remember("info", "node joined", host);
          } else {
            // Other bytes under the same name: never to be used. Two empty failures ban.
            entry.pool.failure(host, 0);
            entry.pool.failure(host, 0);
          }
        } catch (_error) {
          entry.pool.failure(host, 0);
        }
      }));
    } catch (error) {
      remember("warn", "probe reference failed", error?.message || error);
    } finally {
      entry.probing = false;
      schedulePublish();
    }
  }

  // ---- downloads ----
  async function attemptSegment(entry, url, host, signal, onFirstByte) {
    const startedAt = performance.now();
    const transferId = transferSequence++;
    activeTransfers.set(transferId, { at: Date.now(), bps: 0 });
    schedulePublish();
    let received = 0;
    try {
      const response = await nativeFetch(host === entry.origin ? url : swapHost(url, host), { credentials: "omit", cache: "no-store", signal });
      if (response.status !== 200 && response.status !== 206) {
        response.body?.cancel?.().catch?.(() => {});
        throw Object.assign(new Error(`回放分片响应异常：HTTP ${response.status}`), { status: response.status });
      }
      // Nothing here asks for a range, so a 206 is only acceptable when it covers the file.
      const contentRange = rangeCore.parseContentRange(response.headers.get("content-range"));
      if (response.status === 206 && (!contentRange || contentRange.start !== 0 || contentRange.total === null || contentRange.end !== contentRange.total - 1)) {
        throw new Error("回放分片只返回了一部分");
      }
      const reader = response.body?.getReader?.();
      const chunks = [];
      let firstByteMs = 0;
      if (reader) {
        const firstByteTimer = setTimeout(() => reader.cancel(new DOMException("回放分片首字节超时", "TimeoutError")).catch(() => {}), FIRST_BYTE_TIMEOUT_MS);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!firstByteMs) {
              firstByteMs = performance.now() - startedAt;
              clearTimeout(firstByteTimer);
              onFirstByte?.();
            }
            chunks.push(value);
            received += value.byteLength;
            const item = activeTransfers.get(transferId);
            if (item) {
              item.bps = received * 1000 / Math.max(1, performance.now() - startedAt);
              item.at = Date.now();
            }
          }
        } finally {
          clearTimeout(firstByteTimer);
        }
      } else {
        const body = new Uint8Array(await response.arrayBuffer());
        firstByteMs = performance.now() - startedAt;
        onFirstByte?.();
        chunks.push(body);
        received = body.byteLength;
      }
      if (signal?.aborted) throw abortError();
      if (received <= 0) throw new Error("回放分片为空");
      const declared = response.status === 206 ? contentRange.total : Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > 0 && received !== declared) throw new Error(`回放分片长度不对：收到 ${received}，应为 ${declared}`);
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const elapsed = Math.max(1, performance.now() - startedAt);
      entry.pool.success(host, firstByteMs || elapsed, received * 1000 / elapsed);
      stats.lastHost = host;
      return { bytes, contentType: response.headers.get("content-type") || "video/mp4" };
    } catch (error) {
      if (error?.name !== "AbortError" && Number(error?.status) !== 404) entry.pool.failure(host, received);
      throw error;
    } finally {
      activeTransfers.delete(transferId);
      schedulePublish();
    }
  }

  // One segment from the best node; the second-best starts on it too when the first has sent
  // nothing after a while, or fails. Whichever finishes first wins, the other is cancelled.
  async function downloadSegment(entry, url, outerSignal) {
    // Only the origin and nodes whose probe matched its bytes: a node still untested (or that
    // refused the probe) gets no segment, since replay signatures often hold on the origin only.
    const healthy = new Set(entry.pool.status().filter((item) => item.state === "healthy").map((item) => item.host));
    const hosts = entry.pool.pick(4).filter((host) => host === entry.origin || healthy.has(host)).slice(0, 2);
    if (!hosts.length) throw new Error("没有可用的回放节点");
    const controllers = hosts.map(() => new AbortController());
    const dropAll = (reason) => controllers.forEach((c) => { if (!c.signal.aborted) c.abort(reason); });
    const onOuterAbort = () => dropAll(outerSignal.reason || abortError());
    if (outerSignal?.aborted) onOuterAbort();
    else outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
    const overall = setTimeout(() => dropAll(new DOMException("回放分片总超时", "TimeoutError")), SEGMENT_TIMEOUT_MS);
    let startHedge = () => {};
    const hedgeGate = new Promise((resolve) => { startHedge = resolve; });
    const hedgeTimer = hosts.length > 1 ? setTimeout(startHedge, HEDGE_FIRST_BYTE_MS) : 0;
    try {
      const attempts = hosts.map((host, index) => (async () => {
        if (index) {
          await hedgeGate;
          if (controllers[index].signal.aborted) throw abortError();
        }
        try {
          return await attemptSegment(entry, url, host, controllers[index].signal, index ? null : () => clearTimeout(hedgeTimer));
        } catch (error) {
          if (!index) startHedge();
          throw error;
        }
      })());
      const winner = await Promise.any(attempts);
      dropAll(new DOMException("并发副本已取消", "AbortError"));
      return winner;
    } catch (aggregate) {
      throw aggregate?.errors?.find?.((error) => error?.name !== "AbortError") || aggregate?.errors?.at?.(-1) || aggregate;
    } finally {
      clearTimeout(overall);
      clearTimeout(hedgeTimer);
      startHedge();
      outerSignal?.removeEventListener("abort", onOuterAbort);
    }
  }

  function prune() {
    const now = Date.now();
    for (const [url, item] of cache) {
      if (!item.done) continue;
      if (item.servedAt ? now - item.servedAt > SERVED_KEEP_MS && segmentIndex.get(url)?.index !== -1 : now - item.at > UNSERVED_KEEP_MS) cache.delete(url);
    }
  }

  function fetchIntoCache(url) {
    let item = cache.get(url);
    if (item) return item;
    const stop = new AbortController();
    item = { done: false, bytes: 0, at: Date.now(), servedAt: 0, waiters: 0, stop, promise: null };
    const current = item;
    item.promise = downloadSegment(poolFor(url), url, stop.signal).then((result) => {
      current.done = true;
      current.bytes = result.bytes.byteLength;
      current.at = Date.now();
      return result;
    });
    item.promise.catch(() => { if (cache.get(url) === current) cache.delete(url); });
    cache.set(url, item);
    return item;
  }

  function pump() {
    const limit = urgent > 0 ? Math.max(2, parallel() >> 1) : parallel();
    while (inflight < limit && queue.length && unservedBytes() < CACHE_BYTES) {
      const next = queue.shift();
      if (cache.has(next.url) || segmentIndex.get(next.url)?.list !== next.list) continue;
      inflight += 1;
      const item = fetchIntoCache(next.url);
      const settled = () => {
        inflight = Math.max(0, inflight - 1);
        prune();
        pump();
        schedulePublish();
      };
      item.promise.then(settled, settled);
    }
  }

  // The page asked for segment `index` of `list`: the window ahead of it is what to fetch
  // next. Requests that only wander a little (the downloader's five workers finish out of
  // order) move the window forward; a jump (a seek, another clip) starts it afresh and
  // cancels downloads nobody waits for outside it.
  function schedule(list, index) {
    const jumped = activeList !== list || list.cursor < 0 || index < list.cursor - 8 || index > list.cursor + AHEAD_LIMIT;
    list.cursor = jumped ? index : Math.max(list.cursor, index);
    activeList = list;
    const ahead = core.segmentsAhead(list.segments, list.cursor, AHEAD_SECONDS, AHEAD_LIMIT);
    if (jumped) {
      const keep = new Set([list.segments[index]?.url, list.mapUrl, ...ahead.map((segment) => segment.url)]);
      for (const [url, item] of cache) {
        if (item.done || item.waiters > 0 || keep.has(url)) continue;
        item.stop.abort(new DOMException("回放位置已改变", "AbortError"));
        cache.delete(url);
      }
    }
    queue = ahead.filter((segment) => !cache.has(segment.url)).map((segment) => ({ url: segment.url, list }));
    pump();
  }

  // The bytes for one of the page's requests: from the cache, or downloaded now with the
  // prefetch slowed so this one gets the bandwidth. The download goes on for the cache when
  // the caller stops waiting.
  async function obtain(url, signal) {
    if (signal?.aborted) throw signal.reason || abortError();
    const ref = segmentIndex.get(url);
    const cached = cache.get(url);
    const item = cached || fetchIntoCache(url);
    const waiting = !item.done;
    if (waiting) urgent += 1;
    item.waiters += 1;
    if (ref && ref.index >= 0) schedule(ref.list, ref.index);
    let stopWaiting = () => {};
    try {
      const result = await (signal ? Promise.race([item.promise, new Promise((_resolve, reject) => {
        stopWaiting = () => reject(signal.reason || abortError());
        signal.addEventListener("abort", stopWaiting, { once: true });
      })]) : item.promise);
      if (!item.servedAt) {
        stats.acceleratedRequests += 1;
        stats.acceleratedBytes += result.bytes.byteLength;
      }
      item.servedAt = Date.now();
      setTimeout(prune, SERVED_KEEP_MS + 50);
      schedulePublish();
      return result;
    } finally {
      signal?.removeEventListener("abort", stopWaiting);
      item.waiters -= 1;
      if (waiting) urgent = Math.max(0, urgent - 1);
      pump();
    }
  }

  function noteFailure(error) {
    stats.lastError = String(error?.message || error).slice(0, 160);
    stats.lastErrorAt = Math.round(performance.now());
    remember("warn", "segment failed", stats.lastError);
    schedulePublish();
  }

  // ---- fetch: the page's downloader, and hls.js if it is ever set up with fetch ----
  root.fetch = function (input, init) {
    let url = "";
    try { url = absolute(input instanceof Request ? input.url : String(input)); } catch (_error) {}
    if (!replayOn() || !url) return nativeFetch(input, init);
    const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET") return nativeFetch(input, init);
    if (!segmentIndex.has(url)) {
      noteUnmatched(url);
      // A playlist is known by its address or its content type; its text decides.
      const pending = nativeFetch(input, init);
      pending.then((response) => {
        if (!response.ok) return;
        const type = response.headers.get("content-type") || "";
        const length = Number(response.headers.get("content-length"));
        const named = isPlaylistUrl(url) || isPlaylistUrl(response.url) || /mpegurl/i.test(type);
        // Otherwise only a small answer that is not obviously something else gets a look.
        const plausible = !/^(?:video|audio|image|font)\/|json|javascript|css|html|wasm/i.test(type)
          && (length > 0 ? length < 4 * 1024 * 1024 : /^(?:text\/|application\/octet-stream|$)/i.test(type));
        if (!named && !plausible) return;
        response.clone().text().then((text) => { if (looksLikePlaylist(text)) registerPlaylist(response.url || url, text); }).catch(() => {});
      }).catch(() => {});
      return pending;
    }
    let ranged = false;
    try { ranged = Boolean((init?.headers && new Headers(init.headers).get("range")) || (input instanceof Request && input.headers.get("range"))); } catch (_error) {}
    if (ranged) return nativeFetch(input, init);
    const signal = init?.signal || (input instanceof Request ? input.signal : null);
    return obtain(url, signal).then((result) => {
      const response = new Response(result.bytes.slice(), {
        status: 200,
        headers: { "Content-Type": result.contentType, "Content-Length": String(result.bytes.byteLength) }
      });
      try { Object.defineProperty(response, "url", { value: url }); } catch (_error) {}
      return response;
    }, (error) => {
      if (error?.name === "AbortError" || signal?.aborted) throw error;
      noteFailure(error);
      return nativeFetch(input, init);
    });
  };

  // ---- XMLHttpRequest: hls.js's default loader ----
  // A segment request is held at send() until its bytes are in hand, then sent for real to a
  // blob: address holding them, so the page still deals with a genuine XHR in every respect;
  // its responseURL still names the segment. If the download fails, the request goes out to
  // the original address exactly as the page made it.
  const xhrPrototype = root.XMLHttpRequest?.prototype;
  if (xhrPrototype) {
    const nativeOpen = xhrPrototype.open;
    const nativeSend = xhrPrototype.send;
    const nativeAbort = xhrPrototype.abort;
    const nativeSetRequestHeader = xhrPrototype.setRequestHeader;
    const xhrState = new WeakMap();

    xhrPrototype.open = function (method, url, async) {
      const state = { method: String(method).toUpperCase(), url: absolute(url), async: arguments.length < 3 || async !== false, headers: [], ranged: false, held: false, aborted: false, stop: null };
      xhrState.set(this, state);
      try { delete this.responseURL; } catch (_error) {}
      if (replayOn() && state.method === "GET" && !segmentIndex.has(state.url)) {
        // Any text answer may be a playlist: the replay's playlist address need not end in
        // .m3u8, so it is known by its content. Registered before the page's own handler so
        // that the playlist is known by the time hls.js, reacting to it, asks for the first
        // segment.
        const xhr = this;
        const onState = () => {
          if (xhr.readyState !== 4) return;
          xhr.removeEventListener("readystatechange", onState);
          if (xhrState.get(xhr) !== state || xhr.status < 200 || xhr.status >= 300) return;
          if (xhr.responseType !== "" && xhr.responseType !== "text") return;
          try {
            const text = xhr.responseText;
            if (looksLikePlaylist(text)) registerPlaylist(xhr.responseURL || state.url, text);
          } catch (_error) {}
        };
        this.addEventListener("readystatechange", onState);
      }
      return nativeOpen.apply(this, arguments);
    };

    xhrPrototype.setRequestHeader = function (name, value) {
      const state = xhrState.get(this);
      if (state) {
        state.headers.push([name, value]);
        if (String(name).toLowerCase() === "range") state.ranged = true;
      }
      return nativeSetRequestHeader.apply(this, arguments);
    };

    xhrPrototype.send = function () {
      const state = xhrState.get(this);
      if (!state || state.held || !replayOn() || state.method !== "GET" || !state.async || state.ranged || !segmentIndex.has(state.url)) {
        if (state && !state.held && replayOn() && state.method === "GET") noteUnmatched(state.url);
        return nativeSend.apply(this, arguments);
      }
      const xhr = this;
      state.held = true;
      state.stop = new AbortController();
      obtain(state.url, state.stop.signal).then((result) => {
        if (state.aborted || xhrState.get(xhr) !== state) return;
        const blobUrl = URL.createObjectURL(new Blob([result.bytes], { type: result.contentType }));
        xhr.addEventListener("loadend", () => setTimeout(() => URL.revokeObjectURL(blobUrl), 0), { once: true });
        try { Object.defineProperty(xhr, "responseURL", { configurable: true, get: () => state.url }); } catch (_error) {}
        nativeOpen.call(xhr, "GET", blobUrl, true);
        nativeSend.call(xhr);
      }, (error) => {
        if (state.aborted || xhrState.get(xhr) !== state) return;
        noteFailure(error);
        nativeOpen.call(xhr, "GET", state.url, true);
        for (const [name, value] of state.headers) nativeSetRequestHeader.call(xhr, name, value);
        nativeSend.call(xhr);
      });
    };

    xhrPrototype.abort = function () {
      const state = xhrState.get(this);
      if (state?.held && !state.aborted) {
        state.aborted = true;
        state.stop?.abort(abortError());
      }
      return nativeAbort.apply(this, arguments);
    };
  }

  function dropAll() {
    queue = [];
    for (const item of cache.values()) if (!item.done) item.stop.abort(new DOMException("回放加速已关闭", "AbortError"));
    cache.clear();
    playlists.clear();
    segmentIndex.clear();
    pools.clear();
    activeList = null;
  }

  root.addEventListener("message", (event) => {
    if (event.source !== root || event.data?.channel !== CHANNEL) return;
    if (event.data.type === "settings") {
      const previous = settings;
      settings = rangeCore.normalizeSettings(event.data.payload);
      if (!settingsLoaded || previous.enabled !== settings.enabled || previous.liveEnabled !== settings.liveEnabled) {
        settingsLoaded = true;
        remember("info", "settings applied", replayOn() ? "on" : "off");
      }
      if (!replayOn()) {
        dropAll();
        stats.playerState = "disabled";
      } else if (previous.mode !== settings.mode || previous.customHosts.join() !== settings.customHosts.join()) {
        // A new CDN choice means new node pools; the next segment builds them.
        pools.clear();
      }
      publish();
    } else if (event.data.type === "get-stats") {
      publish();
    }
  });

  Object.defineProperty(root, "__biliThreadRipperLiveDebug", {
    value: Object.freeze({
      getContext: () => ({
        key: activeList?.url ? new URL(activeList.url).pathname : "",
        lastNum: activeList?.cursor ?? -1,
        cached: cache.size,
        hosts: [...pools.values()].flatMap((entry) => entry.pool.status())
      }),
      getStats: () => ({ ...stats }),
      getEvents: () => events.map((event) => ({ ...event })),
      version: "__BTR_VERSION__"
    })
  });
  publish();
})(globalThis);
