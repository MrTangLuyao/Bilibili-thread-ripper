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
  // The userscript runs on every bilibili.com page (the extension picks pages in its
  // manifest). The video takeover belongs to the video pages only: the live site has its
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
    version: "0.9.4.3",
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
      // each of them at once copied the whole thread list to the extension every time.
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
      version: "0.9.4.3"
    })
  });
  publish();
})(globalThis);
