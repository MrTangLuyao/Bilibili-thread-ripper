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
    version: "__BTR_VERSION__",
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
      const target = nativeQuality();
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
          version: stats.version, channel: "__BTR_CHANNEL__" === "canary" ? "canary" : "stable", scriptManager: document.documentElement?.getAttribute("data-btr-userscript-manager") || "", at: Math.round(performance.now()), settings: { takeover: settings.takeover, mode: settings.mode, customHosts: settings.customHosts.slice(), concurrency: settings.concurrency, codec: nativeCodec() || "default" },
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
      version: "__BTR_VERSION__"
    })
  });
  publish();
})(globalThis);
