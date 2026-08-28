(function installBridge() {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const VERSION = "0.8.8";
  const WATERMARK_ID = "__bilibili_thread_ripper_watermark__";
  const DEFAULTS = { enabled: true, concurrency: 32, danmakuFontSize: 25, mode: "mainland" };
  let latestSettings = { ...DEFAULTS };
  let latestStats = null;
  let loaded = false;
  let lastBadge = null;

  function normalizeStoredSettings(input) {
    const allowedThreads = [4, 8, 16, 32, 64, 128];
    const requested = Math.trunc(Number(input?.concurrency));
    return {
      enabled: input?.enabled !== false,
      concurrency: allowedThreads.includes(requested) ? requested : 32,
      danmakuFontSize: Math.max(12, Math.min(64, Math.round(Number(input?.danmakuFontSize) || 25))),
      mode: input?.mode === "overseas" ? "overseas" : "mainland"
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

  function syncWatermark() {
    const existing = document.getElementById(WATERMARK_ID);
    if (!loaded || latestSettings.enabled === false) {
      existing?.remove();
      return;
    }
    if (existing) {
      existing.dataset.mode = latestSettings.mode;
      return;
    }
    const mount = document.body || document.documentElement;
    if (!mount) {
      document.addEventListener("DOMContentLoaded", syncWatermark, { once: true });
      return;
    }
    const watermark = document.createElement("div");
    watermark.id = WATERMARK_ID;
    watermark.textContent = "本网站由Bilibili线程撕裂者加速";
    watermark.dataset.version = VERSION;
    watermark.dataset.mode = latestSettings.mode;
    for (const [property, value] of Object.entries({
      position: "fixed",
      right: "12px",
      bottom: "10px",
      color: "#ffffff",
      opacity: "0.10",
      font: '500 11px/1.4 "Microsoft YaHei", sans-serif',
      "letter-spacing": "0.2px",
      "pointer-events": "none",
      "user-select": "none",
      "white-space": "nowrap",
      "z-index": "2147483647"
    })) watermark.style.setProperty(property, value, "important");
    mount.append(watermark);
  }

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    latestSettings = normalizeStoredSettings({ ...DEFAULTS, ...stored });
    if (stored.mode !== latestSettings.mode || stored.concurrency !== latestSettings.concurrency || stored.danmakuFontSize !== latestSettings.danmakuFontSize) {
      chrome.storage.sync.set({
        mode: latestSettings.mode,
        concurrency: latestSettings.concurrency,
        danmakuFontSize: latestSettings.danmakuFontSize
      });
    }
    loaded = true;
    syncWatermark();
    updateBadge();
    postSettings();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    for (const key of Object.keys(DEFAULTS)) {
      if (changes[key]) latestSettings[key] = changes[key].newValue;
    }
    latestSettings = normalizeStoredSettings(latestSettings);
    loaded = true;
    syncWatermark();
    updateBadge();
    postSettings();
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.channel !== CHANNEL) return;
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
    if (event.data.type === "settings-update") {
      const input = event.data.payload;
      if (!input || typeof input !== "object") return;
      const update = {};
      if (input.mode === "mainland" || input.mode === "overseas") update.mode = input.mode;
      const concurrency = Math.trunc(Number(input.concurrency));
      if ([4, 8, 16, 32, 64, 128].includes(concurrency)) update.concurrency = concurrency;
      const danmakuFontSize = Math.round(Number(input.danmakuFontSize));
      if (danmakuFontSize >= 12 && danmakuFontSize <= 64) update.danmakuFontSize = danmakuFontSize;
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
      lastError: String(input.lastError || "").slice(0, 180),
      cdnHosts: Array.isArray(input.cdnHosts) ? input.cdnHosts.slice(0, 32).map((item) => ({
        host: String(item?.host || "").slice(0, 120),
        state: ["healthy", "blocked", "untested"].includes(item?.state) ? item.state : "untested"
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
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "getStatus") return false;
    window.postMessage({ channel: CHANNEL, type: "get-stats" }, "*");
    sendResponse({ settings: latestSettings, stats: latestStats });
    return false;
  });
})();
