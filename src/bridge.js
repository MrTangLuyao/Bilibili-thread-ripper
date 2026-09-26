(function installBridge() {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const VERSION = "__BTR_VERSION__";
  const notices = globalThis.__BTR_NOTIFICATION_VIEW__;
  const ERROR_NOTICE_ID = "__bilibili_thread_ripper_error_notice__";
  const ERROR_NOTICE_STYLE_ID = "__bilibili_thread_ripper_error_notice_style__";
  const THREAD_OPTIONS = Object.freeze([4, 8, 16, 32, 64, 128]);
  const DEFAULTS = { enabled: true, liveEnabled: true, concurrency: 8, autoConcurrency: true, takeover: "full", mode: "mainland", customHosts: [], floatingButton: true, floatingButtonLeft: null, floatingButtonTop: null, debugNotices: false, errorNotices: false, debugCategories: {} };
  // Settings of the old ArtPlayer version, of the removed compatibility modes, and the flag
  // of the first-run guide that 0.9.4.2 removed.
  const RETIRED_KEYS = ["statusNotice", "compatibilityMode", "volume", "danmaku", "danmakuFontSize", "subtitleLanguage", "subtitleLastLanguage", "btrOnboardingRevision"];
  let latestSettings = { ...DEFAULTS };
  let latestStats = null;
  let loaded = false;
  let errorNoticeMotion = null;

  // The page checks each custom server again with the full rules before using it; here it
  // only has to look like a host name.
  function normalizeStoredSettings(input) {
    const threads = Math.trunc(Number(input?.concurrency));
    return {
      enabled: input?.enabled !== false,
      liveEnabled: input?.liveEnabled !== false,
      concurrency: THREAD_OPTIONS.includes(threads) ? threads : 8,
      autoConcurrency: input?.autoConcurrency !== false,
      takeover: input?.takeover === "compat" ? "compat" : "full",
      mode: ["overseas", "custom"].includes(input?.mode) ? input.mode : "mainland",
      customHosts: (Array.isArray(input?.customHosts) ? input.customHosts : [])
        .map((host) => String(host).trim().toLowerCase())
        .filter((host, index, all) => /^[a-z\d](?:[a-z\d.-]{0,251}[a-z\d])?$/.test(host) && all.indexOf(host) === index)
        .slice(0, 32),
      floatingButton: input?.floatingButton !== false,
      floatingButtonLeft: input?.floatingButtonLeft != null && Number(input.floatingButtonLeft) >= 0 && Number(input.floatingButtonLeft) <= 1 ? Number(input.floatingButtonLeft) : null,
      floatingButtonTop: input?.floatingButtonTop != null && Number(input.floatingButtonTop) >= 0 && Number(input.floatingButtonTop) <= 1 ? Number(input.floatingButtonTop) : null,
      debugNotices: input?.debugNotices === true,
      errorNotices: input?.errorNotices === true,
      debugCategories: Object.fromEntries(["takeover", "playback", "download", "buffer", "settings", "other"].map(key => [key, input?.debugCategories?.[key] !== false]))
    };
  }

  function postSettings() {
    window.postMessage({ channel: CHANNEL, type: "settings", payload: latestSettings }, "*");
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
    latestSettings = normalizeStoredSettings({ ...DEFAULTS, ...stored });
    const retired = RETIRED_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(stored, key));
    if (retired.length) chrome.storage.sync.remove(retired);
    const changed = Object.keys(DEFAULTS).filter((key) => JSON.stringify(stored[key]) !== JSON.stringify(latestSettings[key]));
    if (changed.length) chrome.storage.sync.set(Object.fromEntries(changed.map((key) => [key, latestSettings[key]])));
    loaded = true;
    notices?.configure(latestSettings);
    syncTakeoverErrorNotice();
    postSettings();
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
    // The settings panel and the player's gear menu save through here.
    if (event.data.type === "get-settings") {
      if (loaded) postSettings();
      return;
    }
    if (event.data.type === "settings-update") {
      const input = event.data.payload;
      if (!input || typeof input !== "object") return;
      const keys = Object.keys(DEFAULTS).filter((key) => Object.prototype.hasOwnProperty.call(input, key));
      if (!keys.length) return;
      const next = normalizeStoredSettings({ ...latestSettings, ...Object.fromEntries(keys.map((key) => [key, input[key]])) });
      chrome.storage.sync.set(Object.fromEntries(keys.map((key) => [key, next[key]])));
      return;
    }
    if (event.data.type !== "stats") return;
    const input = event.data.payload;
    if (!input || typeof input !== "object") return;
    latestStats = {
      version: String(input.version || ""),
      architecture: String(input.architecture || ""),
      mode: ["overseas", "custom"].includes(input.mode) ? input.mode : "mainland",
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
      lastError: String(input.lastError || "").replace(/[·•‧∙⋅]+/g, "，").slice(0, 180),
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
    syncTakeoverErrorNotice();
  });
})();
