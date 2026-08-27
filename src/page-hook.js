(function installPageHook(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const INSTALL_FLAG = "__biliThreadRipper085Installed";
  if (root[INSTALL_FLAG]) return;

  const core = root.__BILI_RANGE_CORE__;
  const playerFactory = root.__BILI_MSE_PLAYER_FACTORY__;
  const earlyMask = root.__BILI_THREAD_RIPPER_EARLY_MASK__;
  if (!core || !playerFactory || typeof root.fetch !== "function") return;
  Object.defineProperty(root, INSTALL_FLAG, { value: true });

  const nativeFetch = root.fetch.bind(root);
  let settings = core.normalizeSettings({});
  let player = null;
  let playerRoute = "";
  let failedRoute = "";
  let restartTimer = null;
  let publishTimer = null;
  let transferSequence = 1;
  const transfers = new Map();
  const stats = {
    version: "0.8.5",
    architecture: "artplayer-mse-idm-adaptive-startup-danmaku",
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

  function currentPlayinfo() {
    try {
      if ((root.__playinfo__?.data || root.__playinfo__)?.dash) return root.__playinfo__;
    } catch (_error) {}
    const scripts = Array.from(document.scripts || []).reverse();
    for (const script of scripts) {
      const text = script.textContent || "";
      if (!text.includes("__playinfo__")) continue;
      const parsed = extractJsonObject(text, "__playinfo__");
      if ((parsed?.data || parsed)?.dash) return parsed;
    }
    return null;
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

  function stopPlayer(resumeNative = true) {
    player?.destroy({ resumeNative });
    player = null;
    playerRoute = "";
    if (settings.enabled) stats.playerState = "waiting";
    else stats.playerState = "disabled";
    publish();
  }

  function startPlayer() {
    clearTimeout(restartTimer);
    restartTimer = null;
    if (!settings.enabled || !/\/video\//.test(location.pathname)) {
      if (player) stopPlayer(true);
      earlyMask?.release?.();
      return;
    }
    const route = `${location.pathname}${location.search}`;
    if (!player && failedRoute === route) {
      earlyMask?.release?.();
      return;
    }
    if (player && playerRoute === route) {
      earlyMask?.release?.();
      return;
    }
    earlyMask?.arm?.();
    const playinfo = currentPlayinfo();
    const container = findContainer();
    if (!playinfo || !container) {
      stats.playerState = "waiting";
      schedulePublish();
      restartTimer = setTimeout(startPlayer, 350);
      return;
    }
    if (player) stopPlayer(false);
    stats.playerState = "loading";
    stats.lastError = "";
    stats.mode = settings.mode;
    publish();
    try {
      player = playerFactory.createPlayer({
        container,
        getSettings: () => settings,
        nativeFetch,
        poster: String(root.__INITIAL_STATE__?.videoData?.pic || ""),
        onTransfer,
        onSettingsChange(next) {
          root.postMessage({ channel: CHANNEL, type: "settings-update", payload: next }, "*");
        },
        onSegment(event) {
          stats.acceleratedRequests += 1;
          stats.acceleratedBytes += Number(event.bytes) || 0;
          stats.parallelSubrequests += Number(event.pieces) || 0;
          publish();
        },
        onState(next) {
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
          failedRoute = route;
          stats.playerState = "error";
          stats.lastError = String(error?.message || error).slice(0, 180);
          publish();
          setTimeout(() => {
            if (player && stats.playerState === "error") {
              stopPlayer(true);
              earlyMask?.release?.();
              stats.playerState = "native-fallback";
              publish();
            }
          }, 3500);
        },
        playinfo
      });
      playerRoute = route;
      earlyMask?.release?.();
    } catch (error) {
      stats.playerState = "error";
      stats.lastError = String(error?.message || error).slice(0, 180);
      publish();
      earlyMask?.release?.();
      restartTimer = setTimeout(startPlayer, 2000);
    }
  }

  function restartPlayer() {
    clearTimeout(restartTimer);
    failedRoute = "";
    if (settings.enabled && /\/video\//.test(location.pathname)) earlyMask?.arm?.();
    else earlyMask?.release?.();
    if (player) stopPlayer(true);
    restartTimer = setTimeout(startPlayer, 100);
  }

  root.addEventListener("message", (event) => {
    if (event.source !== root || event.data?.channel !== CHANNEL) return;
    if (event.data.type === "settings") {
      const previous = settings;
      settings = core.normalizeSettings(event.data.payload);
      stats.mode = settings.mode;
      if (!settings.enabled) stopPlayer(true);
      else if (!previous.enabled || previous.mode !== settings.mode) restartPlayer();
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
  history.pushState = function (...args) { const result = nativePushState(...args); restartPlayer(); return result; };
  history.replaceState = function (...args) { const result = nativeReplaceState(...args); restartPlayer(); return result; };
  root.addEventListener("popstate", restartPlayer);
  setInterval(() => {
    if (settings.enabled && (!player || playerRoute !== `${location.pathname}${location.search}`)) startPlayer();
  }, 1000);

  Object.defineProperty(root, "__biliThreadRipperDebug", {
    configurable: false,
    value: Object.freeze({
      getPlayer: () => player,
      getSettings: () => ({ ...settings }),
      getStats: () => ({ ...stats, threadSpeeds: stats.threadSpeeds.map((item) => ({ ...item })) }),
      restart: restartPlayer,
      version: "0.8.5"
    })
  });
  publish();
})(globalThis);
