(function installPageHook(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const INSTALL_FLAG = "__biliThreadRipper0901Installed";
  const THREAD_OPTIONS = Object.freeze([4, 8, 16, 32, 64, 128]);
  const SETTINGS_ID = "__bilibili_thread_ripper_native_settings__";
  const SETTINGS_STYLE_ID = "__bilibili_thread_ripper_native_settings_style__";
  if (root[INSTALL_FLAG]) return;

  const core = root.__BILI_RANGE_CORE__;
  const playerFactory = root.__BILI_NATIVE_MSE_PLAYER_FACTORY__;
  const earlyMask = root.__BILI_THREAD_RIPPER_EARLY_MASK__;
  if (!core || !playerFactory || typeof root.fetch !== "function") return;
  Object.defineProperty(root, INSTALL_FLAG, { value: true });

  const nativeFetch = root.fetch.bind(root);
  let settings = core.normalizeSettings({});
  let player = null;
  let playerRoute = "";
  let playerContainer = null;
  let playerLifecycle = 0;
  let failedRoute = "";
  let startingRoute = "";
  let routeGeneration = 0;
  let routeRequestController = null;
  let restartTimer = null;
  let publishTimer = null;
  let menuSyncTimer = null;
  let pendingPodSwitch = null;
  let transferSequence = 1;
  const transfers = new Map();
  const stats = {
    version: "0.9.0.4",
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
    lastError: ""
  };

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
    } else {
      if (event.phase === "cancel") {
        transfers.delete(item.id);
        publish();
        return event.id;
      }
      item.state = event.phase === "done" ? "done" : "error";
      item.finalBps = event.phase === "done" ? item.loaded * 1000 / Math.max(1, now - item.startedAt) : 0;
      item.expiresAt = now + 3500;
      publish();
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
    const preferred = pendingPodSwitch?.targetVideoKey
      ? candidates.find((candidate) => String(candidate.getAttribute("data-key") || "").toLowerCase() === pendingPodSwitch.targetVideoKey)
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
    const rawId = podBvid || pathId;
    const bvid = /^BV/i.test(rawId) ? rawId : "";
    const aid = /^av/i.test(rawId) ? Number(rawId.slice(2)) || 0 : 0;
    const part = podBvid && podBvid.toLowerCase() !== pathId.toLowerCase()
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

  function observePlayinfo(url, payload) {
    if (!/\/x\/player\/(?:wbi\/)?playurl/i.test(String(url)) || !isDashPlayinfo(payload)) return;
    const identity = routeIdentity();
    if (!identity || requestedVideoKey(url) !== identity.videoKey) return;
    const cid = requestedCid(url);
    const expectedCid = routeCids.get(identity.key) || 0;
    // The same BVID can contain many parts. A late response from the previous
    // part must never be cached under, or hot-swapped into, the current part.
    if (!cid || !expectedCid || cid !== expectedCid) return;
    cachePlayinfo(identity, payload, cid);
    if (player && playerRoute === identity.key) {
      player.updatePlayinfo?.(payload).catch((error) => {
        stats.lastError = String(error?.message || error).slice(0, 180);
        publish();
      });
    } else {
      clearTimeout(restartTimer);
      restartTimer = setTimeout(startPlayer, 0);
    }
  }

  function observeFetchResponse(url, response) {
    if (!/\/x\/player\/(?:wbi\/)?playurl/i.test(String(url))) return;
    response.clone().json().then((payload) => observePlayinfo(url, payload)).catch(() => {});
  }

  root.fetch = function (...args) {
    const url = typeof args[0] === "string" || args[0] instanceof URL ? String(args[0]) : String(args[0]?.url || "");
    const pending = nativeFetch(...args);
    pending.then((response) => observeFetchResponse(response.url || url, response)).catch(() => {});
    return pending;
  };

  const xhrPrototype = root.XMLHttpRequest?.prototype;
  if (xhrPrototype) {
    const nativeXhrOpen = xhrPrototype.open;
    const nativeXhrSend = xhrPrototype.send;
    const xhrUrls = new WeakMap();
    xhrPrototype.open = function (method, url, ...args) {
      xhrUrls.set(this, String(url || ""));
      return nativeXhrOpen.call(this, method, url, ...args);
    };
    xhrPrototype.send = function (...args) {
      const url = xhrUrls.get(this) || "";
      if (/\/x\/player\/(?:wbi\/)?playurl/i.test(url)) {
        this.addEventListener("load", () => {
          try {
            const payload = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
            observePlayinfo(this.responseURL || url, payload);
          } catch (_error) {}
        }, { once: true });
      }
      return nativeXhrSend.apply(this, args);
    };
  }

  async function fetchRoutePlayinfo(identity, signal) {
    const query = identity.bvid
      ? `bvid=${encodeURIComponent(identity.bvid)}`
      : `aid=${encodeURIComponent(identity.aid)}`;
    const viewResponse = await nativeFetch(`/x/web-interface/view?${query}`, { credentials: "include", signal });
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
    const playResponse = await nativeFetch(`/x/player/playurl?${playQuery}&cid=${cid}&qn=127&fnval=4048&fnver=0&fourk=1`, {
      credentials: "include",
      signal
    });
    if (!playResponse.ok) throw new Error(`读取播放清单失败（HTTP ${playResponse.status}）`);
    const playinfo = await playResponse.json();
    if (Number(playinfo?.code) !== 0 || !isDashPlayinfo(playinfo)) throw new Error(playinfo?.message || "新视频没有 DASH 播放清单");
    if (signal?.aborted) throw signal.reason || new DOMException("播放清单请求已取消", "AbortError");
    cachePlayinfo(identity, playinfo, cid);
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
        settingGroup("并发线程", "btr-native-concurrency", THREAD_OPTIONS.map((value) => ({ label: String(value), value })), settings.concurrency)
      );
      panel.addEventListener("change", (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || !input.checked) return;
        if (input.name === "btr-native-mode") {
          root.postMessage({ channel: CHANNEL, type: "settings-update", payload: { mode: input.value } }, "*");
        } else if (input.name === "btr-native-concurrency") {
          const concurrency = Number(input.value);
          if (THREAD_OPTIONS.includes(concurrency)) root.postMessage({ channel: CHANNEL, type: "settings-update", payload: { concurrency } }, "*");
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

  function stopPlayer(resumeNative = true) {
    const current = player;
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

  async function startPlayer() {
    clearTimeout(restartTimer);
    restartTimer = null;
    const identity = routeIdentity();
    if (!settings.enabled || !identity) {
      pendingPodSwitch = null;
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
      stats.playerState = "waiting";
      schedulePublish();
      restartTimer = setTimeout(startPlayer, 350);
      return;
    }
    const generation = routeGeneration;
    let playinfo = currentPlayinfo(identity);
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
          stats.lastError = String(error?.message || error).slice(0, 180);
          restartTimer = setTimeout(startPlayer, 700);
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
    try {
      const nextPlayer = playerFactory.createNativePlayer({
        container,
        identity,
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
        onSettingsChange(next) {
          if (lifecycle !== playerLifecycle) return;
          root.postMessage({ channel: CHANNEL, type: "settings-update", payload: next }, "*");
        },
        onNativeSourceChange() {
          if (lifecycle !== playerLifecycle) return;
          handleNativeSourceChange(route, lifecycle);
        },
        onSegment(event) {
          if (lifecycle !== playerLifecycle) return;
          stats.acceleratedRequests += 1;
          stats.acceleratedBytes += Number(event.bytes) || 0;
          stats.parallelSubrequests += Number(event.pieces) || 0;
          publish();
        },
        onState(next) {
          if (lifecycle !== playerLifecycle) return;
          stats.mode = next.mode || settings.mode;
          stats.playerState = next.playerState || stats.playerState;
          stats.quality = next.quality || stats.quality;
          stats.bufferedAhead = Number(next.bufferedAhead) || 0;
          stats.lastError = next.lastError ? String(next.lastError).slice(0, 180) : stats.lastError;
          const byHost = new Map();
          for (const item of next.cdnHosts || []) {
            const current = byHost.get(item.host);
            if (!current || current.state === "untested" || item.state === "blocked") byHost.set(item.host, item);
          }
          stats.cdnHosts = Array.from(byHost.values()).slice(0, 32);
          stats.discoveredCdns = stats.cdnHosts.length;
          stats.healthyCdns = stats.cdnHosts.filter((item) => item.state === "healthy").length;
          stats.blockedCdns = stats.cdnHosts.filter((item) => item.state === "blocked").length;
          schedulePublish();
        },
        onFatal(error) {
          if (lifecycle !== playerLifecycle) return;
          failedRoute = route;
          stats.playerState = "error";
          stats.lastError = String(error?.message || error).slice(0, 180);
          publish();
          setTimeout(() => {
            if (lifecycle === playerLifecycle && player && playerRoute === route && stats.playerState === "error") {
              stopPlayer(true);
              earlyMask?.release?.();
              stats.playerState = "native-fallback";
              publish();
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
      if (isPodSwitch) pendingPodSwitch = null;
      earlyMask?.release?.();
    } catch (error) {
      if (lifecycle !== playerLifecycle) return;
      stats.playerState = "error";
      stats.lastError = String(error?.message || error).slice(0, 180);
      publish();
      earlyMask?.release?.();
      restartTimer = setTimeout(startPlayer, 2000);
    }
  }

  function restartPlayer(force = false) {
    clearTimeout(restartTimer);
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
      settings = core.normalizeSettings(event.data.payload);
      stats.mode = settings.mode;
      syncSettingsMenu();
      if (!settings.enabled) stopPlayer(true);
      else if (!previous.enabled || previous.mode !== settings.mode) restartPlayer(true);
      else {
        player?.applySettings?.(settings);
        startPlayer();
      }
    } else if (event.data.type === "get-stats") {
      publish();
    }
  });

  const nativePushState = history.pushState.bind(history);
  const nativeReplaceState = history.replaceState.bind(history);
  history.pushState = function (...args) { const result = nativePushState(...args); restartPlayer(false); return result; };
  history.replaceState = function (...args) { const result = nativeReplaceState(...args); restartPlayer(false); return result; };
  root.addEventListener("popstate", () => restartPlayer(false));
  document.addEventListener("click", preparePodSwitch, true);
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
    if (settings.enabled && (!player || playerRoute !== identity?.key || !playerContainer?.isConnected || !player.video?.isConnected)) startPlayer();
    syncSettingsMenu();
  }, 1000);

  Object.defineProperty(root, "__biliThreadRipperDebug", {
    configurable: false,
    value: Object.freeze({
      getPlayer: () => player,
      getSettings: () => ({ ...settings }),
      getStats: () => ({ ...stats, threadSpeeds: stats.threadSpeeds.map((item) => ({ ...item })) }),
      restart: () => restartPlayer(true),
      version: "0.9.0.4"
    })
  });
  publish();
})(globalThis);
