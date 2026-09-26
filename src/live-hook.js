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
    version: "__BTR_VERSION__",
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
      version: "__BTR_VERSION__"
    })
  });
  publish();
})(globalThis);
