(function installNativePlayerAccelerator(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const INSTALL_FLAG = "__biliThreadRipperNative090Installed";
  const VERSION = "0.9.0";
  const THREAD_OPTIONS = Object.freeze([4, 8, 16, 32, 64, 128]);
  const SETTINGS_ID = "__bilibili_thread_ripper_native_settings__";
  const SETTINGS_STYLE_ID = "__bilibili_thread_ripper_native_settings_style__";
  const SLOW_START_NOTICE_ID = "__bilibili_thread_ripper_slow_start_notice__";
  const SLOW_START_STYLE_ID = "__bilibili_thread_ripper_slow_start_style__";
  const SLOW_START_DELAY_MS = 3000;
  const PREFETCH_GRACE_MS = 160;
  // 原生播放器本来就会把 DASH 切成较小的 Range。再次把音频或小 Range
  // 拆成几十片只会增加尾延迟，尤其会让普通 1080P 也发生等待。
  const PARALLEL_RANGE_MIN_BYTES = 8 * 1024 * 1024;
  const PREFETCH_SEGMENT_MIN_BYTES = 8 * 1024 * 1024;
  // 大 Range 先给 B 站原始线路一个很短的领先时间，同时准备多线程路径。
  // 快线路通常由原始请求直接获胜；受单连接限制的线路则由并发请求获胜。
  const PARALLEL_RACE_DELAY_MS = 180;
  const DELIVERY_POLICY_RECHECK_USES = 12;
  if (root[INSTALL_FLAG]) return;

  const core = root.__BILI_RANGE_CORE__;
  const resolverFactory = root.__BILI_CDN_RESOLVER_FACTORY__;
  const sidxTools = root.__BILI_SIDX__;
  const downloaderFactory = root.__BILI_IDM_DOWNLOADER_FACTORY__;
  if (!core || !resolverFactory || !sidxTools || !downloaderFactory || typeof root.fetch !== "function" || !root.XMLHttpRequest) return;
  Object.defineProperty(root, INSTALL_FLAG, { value: true });

  const nativeFetch = root.fetch.bind(root);
  const NativeXMLHttpRequest = root.XMLHttpRequest;
  let settings = core.normalizeSettings({});
  let publishTimer = null;
  let menuSyncTimer = null;
  let slowStartTimer = null;
  let slowStartRoute = "";
  let slowStartTracked = false;
  let slowStartFinished = false;
  let slowStartStartedAt = 0;
  let seekNoticeTimer = null;
  let seekNoticeRoute = "";
  let seekNoticeStartedAt = 0;
  let transferSequence = 1;
  let resolverSequence = 1;
  const transfers = new Map();
  const resolverCache = new Map();
  const representationByUrl = new Map();
  const representationByKey = new Map();
  const mediaStates = new Map();
  const stats = {
    version: VERSION,
    architecture: "bilibili-native-player-idm-sidx-prefetch",
    mode: settings.mode,
    playerState: "waiting",
    quality: "",
    bufferedAhead: 0,
    acceleratedRequests: 0,
    acceleratedBytes: 0,
    parallelSubrequests: 0,
    nativeRangeRequests: 0,
    nativeRangeBytes: 0,
    nativeRangeSamples: [],
    prefetchedSegments: 0,
    prefetchHits: 0,
    prefetchMisses: 0,
    nativePassThroughs: 0,
    nativeRaceWins: 0,
    parallelRaceWins: 0,
    deliveryPolicy: "probe",
    cachedBytes: 0,
    activeThreads: 0,
    peakActiveThreads: 0,
    totalSpeedBps: 0,
    threadSpeeds: [],
    discoveredCdns: 0,
    healthyCdns: 0,
    blockedCdns: 0,
    cdnHosts: [],
    lastHost: "",
    lastError: ""
  };

  function currentRouteKey() {
    const query = new URLSearchParams(root.location.search);
    return `${root.location.pathname}?p=${query.get("p") || "1"}`;
  }

  function removeSlowStartNotice() {
    document.getElementById(SLOW_START_NOTICE_ID)?.remove();
  }

  function finishSeekNotice() {
    clearTimeout(seekNoticeTimer);
    seekNoticeTimer = null;
    seekNoticeStartedAt = 0;
    const notice = document.getElementById(SLOW_START_NOTICE_ID);
    if (notice?.dataset.kind === "seek") notice.remove();
  }

  function resetSlowStartTracking() {
    clearTimeout(slowStartTimer);
    slowStartTimer = null;
    slowStartRoute = currentRouteKey();
    slowStartTracked = false;
    slowStartFinished = false;
    slowStartStartedAt = 0;
    finishSeekNotice();
    seekNoticeRoute = slowStartRoute;
    removeSlowStartNotice();
  }

  function finishSlowStartTracking() {
    if (!slowStartTracked || slowStartFinished) return;
    slowStartFinished = true;
    clearTimeout(slowStartTimer);
    slowStartTimer = null;
    removeSlowStartNotice();
  }

  function installSlowStartStyle() {
    if (document.getElementById(SLOW_START_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = SLOW_START_STYLE_ID;
    style.textContent = `
      #${SLOW_START_NOTICE_ID}{position:absolute!important;left:50%!important;top:50%!important;z-index:2147483000!important;max-width:min(520px,calc(100% - 40px))!important;transform:translate(-50%,-50%)!important;padding:10px 15px!important;border-radius:6px!important;background:rgba(20,20,20,.86)!important;color:#fff!important;box-shadow:none!important;font:400 14px/1.55 "Microsoft YaHei","PingFang SC",Arial,sans-serif!important;text-align:center!important;pointer-events:none!important;white-space:normal!important}
    `;
    (document.head || document.documentElement).append(style);
  }

  function showSlowStartNotice() {
    if (slowStartFinished || currentRouteKey() !== slowStartRoute) return;
    const video = document.querySelector("#bilibili-player video, .bpx-player-container video");
    if (!video) {
      if (Date.now() - slowStartStartedAt < 15000) slowStartTimer = setTimeout(showSlowStartNotice, 250);
      else finishSlowStartTracking();
      return;
    }
    if (video.currentTime > 0.15 || video.readyState >= 3 || video.ended) {
      finishSlowStartTracking();
      return;
    }
    const mount = document.querySelector("#bilibili-player .bpx-player-container, #bilibili-player, .bpx-player-container");
    if (!mount) {
      if (Date.now() - slowStartStartedAt < 15000) slowStartTimer = setTimeout(showSlowStartNotice, 250);
      return;
    }
    mountPlaybackNotice(mount, "首次", "线程撕裂者提示：本次加载稍慢，正在为后续流畅播放准备连续缓存。");
  }

  function mountPlaybackNotice(mount, kind, text) {
    installSlowStartStyle();
    removeSlowStartNotice();
    const notice = document.createElement("div");
    notice.id = SLOW_START_NOTICE_ID;
    notice.dataset.kind = kind;
    notice.setAttribute("role", "status");
    notice.textContent = text;
    mount.append(notice);
  }

  function showSeekNotice() {
    if (!seekNoticeTimer && !seekNoticeStartedAt) return;
    if (currentRouteKey() !== seekNoticeRoute) {
      finishSeekNotice();
      return;
    }
    const video = document.querySelector("#bilibili-player video, .bpx-player-container video");
    if (!video) {
      if (Date.now() - seekNoticeStartedAt < 15000) seekNoticeTimer = setTimeout(showSeekNotice, 250);
      else finishSeekNotice();
      return;
    }
    if (!video.seeking && video.readyState >= 3) {
      finishSeekNotice();
      return;
    }
    const mount = document.querySelector("#bilibili-player .bpx-player-container, #bilibili-player, .bpx-player-container");
    if (!mount) {
      if (Date.now() - seekNoticeStartedAt < 15000) seekNoticeTimer = setTimeout(showSeekNotice, 250);
      return;
    }
    seekNoticeTimer = null;
    mountPlaybackNotice(mount, "seek", "线程撕裂者提示：正在重新建立跳转位置的连续缓存，请稍候，完成后会继续播放。");
  }

  function trackSeekNotice() {
    clearTimeout(seekNoticeTimer);
    const currentNotice = document.getElementById(SLOW_START_NOTICE_ID);
    if (currentNotice?.dataset.kind === "seek") currentNotice.remove();
    seekNoticeRoute = currentRouteKey();
    seekNoticeStartedAt = Date.now();
    seekNoticeTimer = setTimeout(showSeekNotice, SLOW_START_DELAY_MS);
  }

  function trackSlowStart() {
    const route = currentRouteKey();
    if (route !== slowStartRoute) resetSlowStartTracking();
    if (slowStartTracked || slowStartFinished) return;
    slowStartTracked = true;
    slowStartStartedAt = Date.now();
    slowStartTimer = setTimeout(() => {
      slowStartTimer = null;
      showSlowStartNotice();
    }, SLOW_START_DELAY_MS);
  }

  document.addEventListener("playing", (event) => {
    if (event.target instanceof HTMLVideoElement) {
      finishSlowStartTracking();
      finishSeekNotice();
    }
  }, true);
  document.addEventListener("canplay", (event) => {
    if (event.target instanceof HTMLVideoElement && !event.target.seeking) finishSeekNotice();
  }, true);
  document.addEventListener("seeking", (event) => {
    if (event.target instanceof HTMLVideoElement) trackSeekNotice();
  }, true);
  // waiting 既可能由首次缓冲、码率切换，也可能由网络抖动触发，不能当成
  // 用户拖动进度条。跳转提示只由真正的 seeking 事件启动。
  document.addEventListener("timeupdate", (event) => {
    if (event.target instanceof HTMLVideoElement && event.target.currentTime > 0.15) {
      finishSlowStartTracking();
      if (!event.target.seeking && event.target.readyState >= 3) finishSeekNotice();
    }
  }, true);

  function transferSpeed(item, now) {
    if (item.state !== "active" || !item.lastByteAt || now - item.lastByteAt > 1800) return 0;
    return item.bps || 0;
  }

  function updateNativeState() {
    const video = document.querySelector("#bilibili-player video, .bpx-player-container video");
    const quality = document.querySelector(".bpx-player-ctrl-quality-result")?.textContent?.trim();
    if (quality) stats.quality = quality.slice(0, 24);
    if (!settings.enabled) stats.playerState = "disabled";
    else if (video) stats.playerState = "ready";
    else stats.playerState = "waiting";
    if (video && video.buffered?.length) {
      const current = Number(video.currentTime) || 0;
      let end = current;
      for (let index = 0; index < video.buffered.length; index += 1) {
        if (video.buffered.start(index) <= current + 0.1 && video.buffered.end(index) >= current) {
          end = video.buffered.end(index);
          break;
        }
      }
      stats.bufferedAhead = Math.max(0, end - current);
    } else {
      stats.bufferedAhead = 0;
    }
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
      label: `${item.kind === "audio" ? "A" : "V"}${String(item.id).padStart(2, "0")}`,
      kind: item.kind,
      loaded: item.loaded,
      totalBytes: item.totalBytes,
      bps: Math.round(transferSpeed(item, now) || item.finalBps || 0),
      state: item.state,
      host: item.host
    }));
    const health = Array.from(resolverCache.values()).flatMap((entry) => entry.resolver.status());
    const byHost = new Map();
    for (const item of health) {
      const current = byHost.get(item.host);
      if (!current || current.state === "untested" || item.state === "blocked") byHost.set(item.host, item);
    }
    stats.cdnHosts = Array.from(byHost.values()).slice(0, 32);
    stats.discoveredCdns = stats.cdnHosts.length;
    stats.healthyCdns = stats.cdnHosts.filter((item) => item.state === "healthy").length;
    stats.blockedCdns = stats.cdnHosts.filter((item) => item.state === "blocked").length;
    updateNativeState();
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
      transfers.set(id, {
        id,
        kind: event.kind === "audio" ? "audio" : "video",
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
      stats.peakActiveThreads = Math.max(stats.peakActiveThreads, Array.from(transfers.values()).filter((item) => item.state === "active").length);
      stats.lastHost = host;
      publish();
      return id;
    }
    const item = transfers.get(Number(event?.id));
    if (!item || item.state !== "active") return event?.id;
    const now = Date.now();
    if (event.phase === "progress") {
      const bytes = Math.max(0, Number(event.bytes) || 0);
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
    } else if (event.phase === "cancel") {
      transfers.delete(item.id);
      publish();
    } else {
      item.state = event.phase === "done" ? "done" : "error";
      item.finalBps = event.phase === "done" ? item.loaded * 1000 / Math.max(1, now - item.startedAt) : 0;
      item.expiresAt = now + 3500;
      publish();
    }
    return event.id;
  }

  const downloader = downloaderFactory.createDownloader({
    getSettings: () => settings,
    nativeFetch,
    onTransfer
  });

  function playinfoDash(payload) {
    const body = payload?.data?.dash ? payload.data : payload?.result?.dash ? payload.result : payload;
    return body?.dash || null;
  }

  function representationUrls(representation) {
    const primary = representation?.baseUrl || representation?.base_url;
    const backup = representation?.backupUrl || representation?.backup_url || representation?.backup_url_list || [];
    return [primary, ...(Array.isArray(backup) ? backup : [])].map((value) => {
      try { return new URL(String(value)).href; }
      catch (_error) { return ""; }
    }).filter(Boolean);
  }

  function registerPlayinfo(payload) {
    const dash = playinfoDash(payload);
    if (!dash) return;
    for (const representation of [...(Array.isArray(dash.video) ? dash.video : []), ...(Array.isArray(dash.audio) ? dash.audio : [])]) {
      for (const url of representationUrls(representation)) {
        representationByUrl.set(url, representation);
        try { representationByKey.set(resolverKey(url), representation); } catch (_error) {}
      }
    }
    while (representationByUrl.size > 256) representationByUrl.delete(representationByUrl.keys().next().value);
    while (representationByKey.size > 128) representationByKey.delete(representationByKey.keys().next().value);
  }

  function registerCurrentPlayinfo() {
    try { registerPlayinfo(root.__playinfo__); } catch (_error) {}
  }

  function isPlayurlApi(value) {
    try { return /\/x\/player\/(?:wbi\/)?playurl/i.test(new URL(value, root.location.href).pathname); }
    catch (_error) { return false; }
  }

  function kindForUrl(value) {
    try {
      const filename = new URL(value).pathname.split("/").at(-1) || "";
      const id = Number(/-(\d+)\.m4s$/i.exec(filename)?.[1]);
      return id >= 30000 && id < 40000 ? "audio" : "video";
    } catch (_error) {
      return "video";
    }
  }

  function resolverKey(value) {
    const url = new URL(value);
    return `${url.pathname}?${url.searchParams.toString()}`;
  }

  function resolverFor(value) {
    registerCurrentPlayinfo();
    const key = resolverKey(value);
    const cached = resolverCache.get(key);
    if (cached) {
      cached.usedAt = ++resolverSequence;
      return cached.resolver;
    }
    let normalized = value;
    try { normalized = new URL(value).href; } catch (_error) {}
    const representation = representationByUrl.get(normalized) || representationByKey.get(key) || { baseUrl: value, backupUrl: [] };
    const resolver = resolverFactory.createResolver(representation, () => settings.mode);
    resolverCache.set(key, { resolver, usedAt: ++resolverSequence });
    if (resolverCache.size > 24) {
      const oldest = Array.from(resolverCache.entries()).sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
      if (oldest) resolverCache.delete(oldest[0]);
    }
    return resolver;
  }

  function hasAcceleratedRoute(value) {
    try { return resolverFor(value).urls().length > 0; }
    catch (_error) { return false; }
  }

  function representationFor(value) {
    try {
      const normalized = new URL(value).href;
      return representationByUrl.get(normalized) || representationByKey.get(resolverKey(normalized)) || null;
    } catch (_error) {
      return null;
    }
  }

  function indexRangeFor(representation) {
    const base = representation?.segment_base || representation?.segmentBase || representation?.SegmentBase || {};
    return core.parseByteRange(base.index_range || base.indexRange || base.IndexRange || "");
  }

  function schedulerAbort(reason = "预取窗口已更新") {
    return new DOMException(reason, "AbortError");
  }

  function clearStateEntries(state, reason) {
    for (const entry of state.entries.values()) {
      if (!entry.controller.signal.aborted) entry.controller.abort(schedulerAbort(reason));
    }
    state.entries.clear();
  }

  function resetMediaStates(reason = "设置已更新") {
    for (const state of mediaStates.values()) clearStateEntries(state, reason);
    mediaStates.clear();
    stats.cachedBytes = 0;
  }

  function updateCachedBytes() {
    let total = 0;
    for (const state of mediaStates.values()) {
      for (const entry of state.entries.values()) total += entry.result?.bytes?.byteLength || 0;
    }
    stats.cachedBytes = total;
  }

  function mediaStateFor(value) {
    registerCurrentPlayinfo();
    const representation = representationFor(value);
    if (!representation || !indexRangeFor(representation)) return null;
    const canonicalUrl = representationUrls(representation)[0] || value;
    const key = resolverKey(canonicalUrl);
    let state = mediaStates.get(key);
    if (state) {
      state.usedAt = ++resolverSequence;
      return state;
    }
    state = {
      key,
      kind: kindForUrl(value),
      representation,
      resolver: resolverFor(canonicalUrl),
      sidx: null,
      entries: new Map(),
      cursor: -1,
      deliveryPolicy: "probe",
      policyUses: 0,
      usedAt: ++resolverSequence
    };
    mediaStates.set(key, state);
    while (mediaStates.size > 12) {
      const oldest = Array.from(mediaStates.values()).sort((a, b) => a.usedAt - b.usedAt)[0];
      if (!oldest) break;
      clearStateEntries(oldest, "媒体轨道已淘汰");
      mediaStates.delete(oldest.key);
    }
    return state;
  }

  function waitForShared(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason || schedulerAbort("请求已取消"));
    return new Promise((resolve, reject) => {
      const canceled = () => reject(signal.reason || schedulerAbort("请求已取消"));
      signal.addEventListener("abort", canceled, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", canceled));
    });
  }

  function segmentIndexForRange(segments, range) {
    let low = 0;
    let high = segments.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const segment = segments[middle];
      if (range.end < segment.start) high = middle - 1;
      else if (range.start > segment.end) low = middle + 1;
      else return range.start >= segment.start && range.end <= segment.end ? middle : -1;
    }
    return -1;
  }

  function firstSegmentIndexForRange(segments, range) {
    let low = 0;
    let high = segments.length - 1;
    let match = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (segments[middle].end >= range.start) {
        match = middle;
        high = middle - 1;
      } else low = middle + 1;
    }
    return match >= 0 && segments[match].start <= range.end ? match : -1;
  }

  function sliceSegmentResult(result, segment, range) {
    const offset = range.start - segment.start;
    const bytes = result.bytes.slice(offset, offset + range.length);
    if (bytes.byteLength !== range.length) throw new Error("预取分段长度不足");
    return { ...result, bytes, byteLength: bytes.byteLength };
  }

  async function downloadMediaRange(state, range, signal, priority, prefetched = false, demandFirst = false) {
    const orderedChunks = [];
    let result = await downloader.downloadRange(range, state.resolver, {
      signal,
      parallel: true,
      kind: state.kind,
      priority,
      maxConcurrency: prefetched ? Math.max(1, Math.floor(settings.concurrency / 4)) : settings.concurrency,
      startup: demandFirst,
      onOrderedChunk: demandFirst ? async (bytes) => { orderedChunks.push(bytes); } : undefined
    });
    if (demandFirst && result.streamed) {
      result = {
        ...result,
        bytes: core.concatChunks(orderedChunks, range.length),
        byteLength: range.length,
        streamed: false
      };
    }
    stats.acceleratedRequests += 1;
    stats.acceleratedBytes += result.byteLength;
    stats.parallelSubrequests += result.pieceCount;
    if (prefetched) stats.prefetchedSegments += 1;
    stats.lastError = "";
    stats.playerState = "ready";
    schedulePublish();
    return { ...result, kind: state.kind };
  }

  function startSegmentPrefetch(state, index, priority = 70) {
    if (!state.sidx || state.deliveryPolicy === "native" || state.entries.has(index)) return state.entries.get(index) || null;
    const segment = state.sidx.segments[index];
    if (!segment) return null;
    if (segment.length < PREFETCH_SEGMENT_MIN_BYTES) return null;
    const controller = new AbortController();
    const entry = { controller, index, result: null, promise: null };
    entry.promise = downloadMediaRange(state, segment, controller.signal, priority, true, false).then((result) => {
      if (state.entries.get(index) === entry) {
        entry.result = result;
        updateCachedBytes();
      }
      return result;
    }).catch((error) => {
      if (state.entries.get(index) === entry) state.entries.delete(index);
      updateCachedBytes();
      throw error;
    });
    entry.promise.catch(() => {});
    state.entries.set(index, entry);
    return entry;
  }

  function scheduleSegmentWindow(state, index, includeCurrent = false) {
    if (!state.sidx || index < 0) return;
    if (state.deliveryPolicy === "native") {
      clearStateEntries(state, "原生线路已证实更快");
      updateCachedBytes();
      return;
    }
    // 每条音/视频轨只预取下一段，最多使用总线程的四分之一。
    // 这样 32 线程时后台最多占约 16 路，始终给当前播放请求留出容量。
    const width = 1;
    if (state.cursor >= 0 && Math.abs(index - state.cursor) > width + 2) {
      clearStateEntries(state, "播放位置已跳转");
    }
    state.cursor = index;
    state.usedAt = ++resolverSequence;
    const start = includeCurrent ? index : index + 1;
    const end = Math.min(state.sidx.segments.length - 1, start + width - 1);
    for (const [entryIndex, entry] of state.entries) {
      if (entryIndex >= index - 1 && entryIndex <= end + 1) continue;
      if (!entry.controller.signal.aborted) entry.controller.abort(schedulerAbort("分段已离开预取窗口"));
      state.entries.delete(entryIndex);
    }
    for (let next = start; next <= end; next += 1) {
      startSegmentPrefetch(state, next, includeCurrent && next === index ? 110 : 35);
    }
    updateCachedBytes();
  }

  function observeSidx(state, range, result) {
    if (!state || state.sidx || !result?.bytes?.byteLength) return;
    const expected = indexRangeFor(state.representation);
    if (expected && (range.end < expected.start || range.start > expected.end)) return;
    const parsed = sidxTools.parseSidx(result.bytes, range.start);
    if (!parsed?.segments?.length) return;
    state.sidx = parsed;
    const video = document.querySelector("#bilibili-player video, .bpx-player-container video");
    state.cursor = sidxTools.segmentIndexAt(parsed.segments, Number(video?.currentTime) || 0);
  }

  function observeNativeFetch(url, range, responsePromise) {
    const state = mediaStateFor(url);
    const expected = indexRangeFor(state?.representation);
    if (!state || !expected || range.end < expected.start || range.start > expected.end) return;
    responsePromise.then(async (response) => {
      if (response.status !== 206) return;
      const bytes = new Uint8Array(await response.clone().arrayBuffer());
      observeSidx(state, range, { bytes });
    }).catch(() => {});
  }

  function headerBag(input, init) {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    return headers;
  }

  function fetchDetails(input, init) {
    let url = "";
    try { url = new URL(input instanceof Request ? input.url : String(input), root.location.href).href; }
    catch (_error) { return null; }
    const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = headerBag(input, init);
    const range = core.parseRangeHeader(headers.get("range"));
    const signal = init?.signal || (input instanceof Request ? input.signal : undefined);
    if (!settings.enabled || method !== "GET" || !core.isBilibiliMediaUrl(url) || !range || !hasAcceleratedRoute(url)) return null;
    return { headers, range, signal, url, accelerate: shouldParallelize(url, range) };
  }

  function shouldParallelize(url, range) {
    if (!range || range.length < PARALLEL_RANGE_MIN_BYTES) return false;
    // 音频体积小且对连续性敏感，保留 B 站原生加载最稳妥。
    if (kindForUrl(url) === "audio") return false;
    const state = mediaStateFor(url);
    if (state?.deliveryPolicy === "native") {
      if (state.policyUses < DELIVERY_POLICY_RECHECK_USES) {
        state.policyUses += 1;
        stats.deliveryPolicy = "native";
        return false;
      }
      state.deliveryPolicy = "probe";
      state.policyUses = 0;
    }
    return true;
  }

  function cancelPrefetchFor(url, reason = "原生请求优先") {
    const state = mediaStateFor(url);
    if (!state) return;
    clearStateEntries(state, reason);
    updateCachedBytes();
  }

  function delayed(ms, signal) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      const canceled = () => {
        clearTimeout(timer);
        reject(signal?.reason || schedulerAbort("请求已取消"));
      };
      if (signal?.aborted) canceled();
      else signal?.addEventListener("abort", canceled, { once: true });
    });
  }

  async function downloadOriginalRange(url, range, signal, kind) {
    const response = await nativeFetch(url, {
      method: "GET",
      headers: { Range: `bytes=${range.start}-${range.end}` },
      credentials: "omit",
      cache: "no-store",
      mode: "cors",
      referrer: root.location.href,
      referrerPolicy: "strict-origin-when-cross-origin",
      signal
    });
    const contentRange = core.parseContentRange(response.headers.get("content-range"));
    if (response.status !== 206 || !contentRange || contentRange.start !== range.start || contentRange.end !== range.end) {
      throw new Error(`原始 Range 校验失败：HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== range.length) throw new Error(`原始 Range 长度不符：${bytes.byteLength}/${range.length}`);
    return {
      bytes,
      byteLength: bytes.byteLength,
      pieceCount: 1,
      total: contentRange.total || null,
      hosts: [new URL(response.url || url).hostname],
      kind,
      racePath: "native"
    };
  }

  async function raceMediaRange(url, state, range, signal, priority) {
    const directController = new AbortController();
    const parallelController = new AbortController();
    const cancelAll = () => {
      if (!directController.signal.aborted) directController.abort(signal?.reason || schedulerAbort("竞速已结束"));
      if (!parallelController.signal.aborted) parallelController.abort(signal?.reason || schedulerAbort("竞速已结束"));
    };
    if (signal?.aborted) cancelAll();
    else signal?.addEventListener("abort", cancelAll, { once: true });
    const direct = downloadOriginalRange(url, range, directController.signal, state.kind);
    const parallel = delayed(PARALLEL_RACE_DELAY_MS, parallelController.signal)
      .then(() => downloadMediaRange(state, range, parallelController.signal, priority, false, true))
      .then((result) => ({ ...result, racePath: "parallel" }));
    try {
      const result = await Promise.any([direct, parallel]);
      state.deliveryPolicy = result.racePath === "native" ? "native" : "parallel";
      state.policyUses = 0;
      stats.deliveryPolicy = state.deliveryPolicy;
      if (result.racePath === "native") stats.nativeRaceWins += 1;
      else stats.parallelRaceWins += 1;
      if (!directController.signal.aborted) directController.abort(schedulerAbort("多线程路径已获胜"));
      if (!parallelController.signal.aborted) parallelController.abort(schedulerAbort("原始路径已获胜"));
      schedulePublish();
      return result;
    } catch (aggregate) {
      if (signal?.aborted) throw signal.reason || schedulerAbort("请求已取消");
      throw aggregate?.errors?.at?.(-1) || aggregate;
    } finally {
      signal?.removeEventListener("abort", cancelAll);
    }
  }

  async function downloadAdaptiveMediaRange(url, state, range, signal, priority) {
    if (state.deliveryPolicy === "native" && state.policyUses < DELIVERY_POLICY_RECHECK_USES) {
      state.policyUses += 1;
      stats.deliveryPolicy = "native";
      try {
        return await downloadOriginalRange(url, range, signal, state.kind);
      } catch (error) {
        if (signal?.aborted) throw error;
        state.deliveryPolicy = "probe";
        state.policyUses = 0;
      }
    } else if (state.deliveryPolicy === "parallel" && state.policyUses < DELIVERY_POLICY_RECHECK_USES) {
      state.policyUses += 1;
      stats.deliveryPolicy = "parallel";
      try {
        return await downloadMediaRange(state, range, signal, priority, false, true);
      } catch (error) {
        if (signal?.aborted) throw error;
        state.deliveryPolicy = "probe";
        state.policyUses = 0;
      }
    } else if (state.deliveryPolicy !== "probe") {
      state.deliveryPolicy = "probe";
      state.policyUses = 0;
    }
    stats.deliveryPolicy = "probe";
    return raceMediaRange(url, state, range, signal, priority);
  }

  async function accelerate(url, range, signal) {
    const kind = kindForUrl(url);
    trackSlowStart();
    stats.nativeRangeRequests += 1;
    stats.nativeRangeBytes += range.length;
    stats.nativeRangeSamples.push({
      kind,
      start: range.start,
      end: range.end,
      length: range.length,
      at: Math.round(performance.now())
    });
    if (stats.nativeRangeSamples.length > 80) stats.nativeRangeSamples.splice(0, stats.nativeRangeSamples.length - 80);
    const state = mediaStateFor(url) || {
      kind,
      resolver: resolverFor(url),
      representation: null,
      sidx: null,
      entries: new Map(),
      cursor: -1,
      deliveryPolicy: "probe",
      policyUses: 0,
      usedAt: ++resolverSequence
    };
    if (state.sidx) {
      const index = segmentIndexForRange(state.sidx.segments, range);
      if (index >= 0) {
        const existing = state.entries.get(index);
        if (existing?.result) {
          stats.prefetchHits += 1;
          const response = sliceSegmentResult(existing.result, state.sidx.segments[index], range);
          state.entries.delete(index);
          updateCachedBytes();
          scheduleSegmentWindow(state, index, false);
          return response;
        }
        if (existing) {
          try {
            const prefetched = await Promise.race([
              waitForShared(existing.promise, signal),
              new Promise((resolve) => setTimeout(() => resolve(null), PREFETCH_GRACE_MS))
            ]);
            if (!prefetched) throw new DOMException("提升为当前播放请求", "TimeoutError");
            stats.prefetchHits += 1;
            const response = sliceSegmentResult(prefetched, state.sidx.segments[index], range);
            state.entries.delete(index);
            updateCachedBytes();
            scheduleSegmentWindow(state, index, false);
            return response;
          } catch (error) {
            if (signal?.aborted) throw error;
            if (state.entries.get(index) === existing) {
              if (!existing.controller.signal.aborted) existing.controller.abort(schedulerAbort("当前播放请求接管"));
              state.entries.delete(index);
              updateCachedBytes();
            }
          }
        }
        stats.prefetchMisses += 1;
        const result = await downloadAdaptiveMediaRange(url, state, range, signal, 220);
        scheduleSegmentWindow(state, index, false);
        return result;
      }
      const windowIndex = firstSegmentIndexForRange(state.sidx.segments, range);
      if (windowIndex >= 0) {
        // B 站在大幅跳转时可能一次请求跨越多个 SIDX 分段。旧逻辑会把这种
        // Range 当普通后台任务，容易被预取占满线程；现在先释放预取并按当前
        // 播放请求的最快节点探测路径直接下载。
        clearStateEntries(state, "大幅跳转由当前播放请求接管");
        updateCachedBytes();
        state.cursor = windowIndex;
        stats.prefetchMisses += 1;
        const result = await downloadAdaptiveMediaRange(url, state, range, signal, 220);
        scheduleSegmentWindow(state, windowIndex, false);
        return result;
      }
    }
    const result = await downloadAdaptiveMediaRange(url, state, range, signal, 220);
    observeSidx(state, range, result);
    if (state.sidx) {
      const index = segmentIndexForRange(state.sidx.segments, range);
      if (index >= 0) scheduleSegmentWindow(state, index, false);
    }
    return result;
  }

  function responseHeaders(range, result) {
    return new Headers({
      "accept-ranges": "bytes",
      "content-length": String(result.byteLength),
      "content-range": `bytes ${range.start}-${range.end}/${Number.isSafeInteger(result.total) ? result.total : "*"}`,
      "content-type": result.kind === "audio" ? "audio/mp4" : "video/mp4"
    });
  }

  function recordFallback(error) {
    if (error?.name === "AbortError") return;
    stats.lastError = `并发请求失败，已回退原始线路：${String(error?.message || error).slice(0, 130)}`;
    schedulePublish();
  }

  root.fetch = function acceleratedFetch(input, init) {
    const details = fetchDetails(input, init);
    if (!details) {
      const responsePromise = nativeFetch(input, init);
      let requestUrl = "";
      try { requestUrl = input instanceof Request ? input.url : String(input); } catch (_error) {}
      if (isPlayurlApi(requestUrl)) {
        responsePromise.then((response) => response.clone().json()).then(registerPlayinfo).catch(() => {});
      }
      return responsePromise;
    }
    if (!details.accelerate) {
      stats.nativePassThroughs += 1;
      cancelPrefetchFor(details.url, "小 Range 交还 B 站原生播放器");
      schedulePublish();
      const responsePromise = nativeFetch(input, init);
      observeNativeFetch(details.url, details.range, responsePromise);
      return responsePromise;
    }
    return accelerate(details.url, details.range, details.signal).then((result) => new Response(result.bytes, {
      status: 206,
      statusText: "Partial Content",
      headers: responseHeaders(details.range, result)
    })).catch((error) => {
      recordFallback(error);
      return nativeFetch(input, init);
    });
  };

  function nativeGetter(instance, name) {
    let prototype = NativeXMLHttpRequest.prototype;
    while (prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (descriptor?.get) return descriptor.get.call(instance);
      prototype = Object.getPrototypeOf(prototype);
    }
    return undefined;
  }

  function dispatchProgress(xhr, type, loaded = 0, total = 0) {
    xhr.dispatchEvent(new ProgressEvent(type, {
      lengthComputable: total > 0,
      loaded,
      total
    }));
  }

  function createAcceleratedXHR() {
    const xhr = new NativeXMLHttpRequest();
    const nativeOpen = xhr.open.bind(xhr);
    const nativeSend = xhr.send.bind(xhr);
    const nativeAbort = xhr.abort.bind(xhr);
    const nativeSetRequestHeader = xhr.setRequestHeader.bind(xhr);
    const nativeGetResponseHeader = xhr.getResponseHeader.bind(xhr);
    const nativeGetAllResponseHeaders = xhr.getAllResponseHeaders.bind(xhr);
    let candidateUrl = "";
    let candidateMethod = "GET";
    let candidateAsync = true;
    let requestHeaders = new Headers();
    let requestBody = null;
    let accelerating = false;
    let synthetic = false;
    let aborted = false;
    let controller = null;
    let timeoutTimer = null;
    let syntheticHeaders = new Headers();
    const state = {
      readyState: 0,
      response: null,
      responseText: "",
      responseURL: "",
      responseXML: null,
      status: 0,
      statusText: ""
    };

    let shadowable = true;
    for (const property of Object.keys(state)) {
      try {
        Object.defineProperty(xhr, property, {
          configurable: true,
          enumerable: true,
          get() { return synthetic ? state[property] : nativeGetter(xhr, property); }
        });
      } catch (_error) {
        shadowable = false;
        break;
      }
    }

    xhr.open = function open(method, url, async = true, user, password) {
      candidateMethod = String(method || "GET").toUpperCase();
      candidateAsync = async !== false;
      requestHeaders = new Headers();
      requestBody = null;
      accelerating = false;
      synthetic = false;
      aborted = false;
      controller = null;
      clearTimeout(timeoutTimer);
      try { candidateUrl = new URL(String(url), root.location.href).href; }
      catch (_error) { candidateUrl = ""; }
      return nativeOpen(method, url, async, user, password);
    };

    xhr.setRequestHeader = function setRequestHeader(name, value) {
      requestHeaders.append(String(name), String(value));
      return nativeSetRequestHeader(name, value);
    };

    xhr.getResponseHeader = function getResponseHeader(name) {
      return synthetic ? syntheticHeaders.get(String(name)) : nativeGetResponseHeader(name);
    };

    xhr.getAllResponseHeaders = function getAllResponseHeaders() {
      if (!synthetic) return nativeGetAllResponseHeaders();
      return Array.from(syntheticHeaders.entries()).map(([name, value]) => `${name}: ${value}\r\n`).join("");
    };

    xhr.abort = function abort() {
      aborted = true;
      clearTimeout(timeoutTimer);
      if (accelerating) {
        accelerating = false;
        controller?.abort(new DOMException("请求已取消", "AbortError"));
        nativeAbort();
        dispatchProgress(xhr, "abort");
        dispatchProgress(xhr, "loadend");
        return;
      }
      return nativeAbort();
    };

    xhr.send = function send(body = null) {
      requestBody = body;
      const range = core.parseRangeHeader(requestHeaders.get("range"));
      const canAccelerate = shadowable
        && settings.enabled
        && candidateAsync
        && candidateMethod === "GET"
        && core.isBilibiliMediaUrl(candidateUrl)
        && range
        && shouldParallelize(candidateUrl, range)
        && hasAcceleratedRoute(candidateUrl);
      if (!canAccelerate) {
        if (settings.enabled && range && core.isBilibiliMediaUrl(candidateUrl)) {
          stats.nativePassThroughs += 1;
          cancelPrefetchFor(candidateUrl, "小 Range 交还 B 站原生播放器");
          const mediaTrack = mediaStateFor(candidateUrl);
          const expected = indexRangeFor(mediaTrack?.representation);
          if (mediaTrack && expected && range.end >= expected.start && range.start <= expected.end) {
            xhr.addEventListener("load", () => {
              try {
                if (nativeGetter(xhr, "status") !== 206) return;
                const response = nativeGetter(xhr, "response");
                const bytes = response instanceof ArrayBuffer
                  ? new Uint8Array(response)
                  : ArrayBuffer.isView(response)
                    ? new Uint8Array(response.buffer, response.byteOffset, response.byteLength)
                    : null;
                if (bytes) observeSidx(mediaTrack, range, { bytes });
              } catch (_error) {}
            }, { once: true });
          }
          schedulePublish();
        }
        if (isPlayurlApi(candidateUrl)) {
          xhr.addEventListener("load", () => {
            try {
              const payload = xhr.responseType === "json" ? xhr.response : JSON.parse(xhr.responseText);
              registerPlayinfo(payload);
            } catch (_error) {}
          }, { once: true });
        }
        return nativeSend(body);
      }

      accelerating = true;
      controller = new AbortController();
      const timeout = Math.max(0, Number(xhr.timeout) || 0);
      if (timeout > 0) {
        timeoutTimer = setTimeout(() => {
          if (!accelerating || aborted) return;
          accelerating = false;
          aborted = true;
          controller.abort(new DOMException("请求超时", "TimeoutError"));
          nativeAbort();
          dispatchProgress(xhr, "timeout");
          dispatchProgress(xhr, "loadend");
        }, timeout);
      }
      accelerate(candidateUrl, range, controller.signal).then((result) => {
        if (aborted) return;
        accelerating = false;
        clearTimeout(timeoutTimer);
        synthetic = true;
        syntheticHeaders = responseHeaders(range, result);
        const bytes = result.bytes;
        const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const responseType = String(xhr.responseType || "");
        state.response = responseType === "blob"
          ? new Blob([bytes], { type: syntheticHeaders.get("content-type") || "application/octet-stream" })
          : responseType === "" || responseType === "text"
            ? new TextDecoder().decode(bytes)
            : arrayBuffer;
        state.responseText = responseType === "" || responseType === "text" ? String(state.response) : "";
        state.responseURL = candidateUrl;
        state.status = 206;
        state.statusText = "Partial Content";
        state.readyState = 1;
        dispatchProgress(xhr, "loadstart");
        state.readyState = 2;
        xhr.dispatchEvent(new Event("readystatechange"));
        state.readyState = 3;
        xhr.dispatchEvent(new Event("readystatechange"));
        dispatchProgress(xhr, "progress", bytes.byteLength, bytes.byteLength);
        state.readyState = 4;
        xhr.dispatchEvent(new Event("readystatechange"));
        dispatchProgress(xhr, "load", bytes.byteLength, bytes.byteLength);
        dispatchProgress(xhr, "loadend", bytes.byteLength, bytes.byteLength);
      }).catch((error) => {
        if (aborted) return;
        accelerating = false;
        clearTimeout(timeoutTimer);
        recordFallback(error);
        try { nativeSend(requestBody); }
        catch (fallbackError) {
          stats.lastError = String(fallbackError?.message || fallbackError).slice(0, 180);
          schedulePublish();
          dispatchProgress(xhr, "error");
          dispatchProgress(xhr, "loadend");
        }
      });
      return undefined;
    };
    return xhr;
  }

  function AcceleratedXMLHttpRequest() {
    return createAcceleratedXHR();
  }
  AcceleratedXMLHttpRequest.prototype = NativeXMLHttpRequest.prototype;
  Object.setPrototypeOf(AcceleratedXMLHttpRequest, NativeXMLHttpRequest);
  for (const name of ["UNSENT", "OPENED", "HEADERS_RECEIVED", "LOADING", "DONE"]) {
    Object.defineProperty(AcceleratedXMLHttpRequest, name, { value: NativeXMLHttpRequest[name], enumerable: true });
  }
  root.XMLHttpRequest = AcceleratedXMLHttpRequest;

  function settingGroup(title, name, options, selected) {
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
    for (const option of options) {
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
      panel.dataset.btrStrategy = "adaptive-native-race-v2";
      const mode = settingGroup("线程撕裂者 CDN", "btr-native-mode", [
        { label: "大陆 CDN", value: "mainland" },
        { label: "海外 CDN", value: "overseas" }
      ], settings.mode);
      const concurrency = settingGroup("并发线程", "btr-native-concurrency", THREAD_OPTIONS.map((value) => ({ label: String(value), value })), settings.concurrency);
      panel.append(mode, concurrency);
      panel.addEventListener("change", (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || !input.checked) return;
        if (input.name === "btr-native-mode") {
          root.postMessage({ channel: CHANNEL, type: "settings-update", payload: { mode: input.value } }, "*");
        } else if (input.name === "btr-native-concurrency") {
          const concurrencyValue = Number(input.value);
          if (THREAD_OPTIONS.includes(concurrencyValue)) {
            root.postMessage({ channel: CHANNEL, type: "settings-update", payload: { concurrency: concurrencyValue } }, "*");
          }
        }
      });
      const before = mount.querySelector(".bpx-player-ctrl-setting-others");
      mount.insertBefore(panel, before || mount.firstChild);
    }
    for (const input of panel.querySelectorAll('input[name="btr-native-mode"]')) input.checked = input.value === settings.mode;
    for (const input of panel.querySelectorAll('input[name="btr-native-concurrency"]')) input.checked = Number(input.value) === settings.concurrency;
  }

  function scheduleSettingsMenuSync() {
    if (menuSyncTimer) return;
    menuSyncTimer = setTimeout(() => {
      menuSyncTimer = null;
      syncSettingsMenu();
    }, 120);
  }

  const settingsObserver = new MutationObserver(scheduleSettingsMenuSync);
  function startSettingsObserver() {
    if (!document.documentElement) {
      document.addEventListener("readystatechange", startSettingsObserver, { once: true });
      return;
    }
    settingsObserver.observe(document.documentElement, { childList: true, subtree: true });
    syncSettingsMenu();
  }
  startSettingsObserver();
  setInterval(() => {
    if (currentRouteKey() !== slowStartRoute) resetSlowStartTracking();
    syncSettingsMenu();
    schedulePublish();
  }, 1000);

  root.addEventListener("message", (event) => {
    if (event.source !== root || event.data?.channel !== CHANNEL) return;
    if (event.data.type === "settings") {
      const nextSettings = core.normalizeSettings(event.data.payload);
      if (settings.mode !== nextSettings.mode || settings.concurrency !== nextSettings.concurrency || settings.enabled !== nextSettings.enabled) {
        resetMediaStates("加速设置已更新");
      }
      settings = nextSettings;
      stats.mode = settings.mode;
      stats.lastError = "";
      syncSettingsMenu();
      publish();
    } else if (event.data.type === "get-stats") {
      publish();
    }
  });

  Object.defineProperty(root, "__biliThreadRipperDebug", {
    configurable: false,
    value: Object.freeze({
      getSettings: () => ({ ...settings }),
      getStats: () => ({ ...stats, threadSpeeds: stats.threadSpeeds.map((item) => ({ ...item })) }),
      nativeFetch,
      version: VERSION
    })
  });
  publish();
})(globalThis);
