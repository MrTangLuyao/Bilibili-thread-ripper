(function installBridge() {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const VERSION = "0.9.0.2";
  const WATERMARK_ID = "__bilibili_thread_ripper_watermark__";
  const ONBOARDING_ID = "__bilibili_thread_ripper_onboarding__";
  const ONBOARDING_STYLE_ID = "__bilibili_thread_ripper_onboarding_style__";
  const ONBOARDING_STORAGE_KEY = "btrOnboardingRevision";
  const ONBOARDING_REVISION = "native-progressive-mse-v1";
  const THREAD_OPTIONS = Object.freeze([4, 8, 16, 32, 64, 128]);
  const DEFAULT_DANMAKU = Object.freeze({
    visible: true,
    opacity: 0.9,
    area: "threeQuarter",
    fontSize: 25,
    speed: 5,
    modes: [0, 1, 2],
    antiOverlap: true,
    synchronousPlayback: true,
    mode: 0,
    color: "#FFFFFF"
  });
  const DEFAULTS = { enabled: true, concurrency: 32, volume: 0.7, danmaku: DEFAULT_DANMAKU, mode: "mainland", subtitleLanguage: "off", subtitleLastLanguage: "" };
  let latestSettings = { ...DEFAULTS };
  let latestStats = null;
  let loaded = false;
  let lastBadge = null;
  let onboardingChecked = false;

  function removeOnboarding() {
    document.getElementById(ONBOARDING_ID)?.remove();
    document.getElementById(ONBOARDING_STYLE_ID)?.remove();
  }

  function mountOnboarding() {
    if (document.getElementById(ONBOARDING_ID)) return;
    const mount = document.body || document.documentElement;
    if (!mount) {
      document.addEventListener("DOMContentLoaded", mountOnboarding, { once: true });
      return;
    }

    const style = document.createElement("style");
    style.id = ONBOARDING_STYLE_ID;
    style.textContent = `
      #${ONBOARDING_ID}{position:fixed!important;inset:0!important;z-index:2147483646!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:16px!important;box-sizing:border-box!important;background:rgba(0,0,0,.62)!important;font-family:"Microsoft YaHei","PingFang SC",Arial,sans-serif!important;color:#18191c!important}
      #${ONBOARDING_ID} *{box-sizing:border-box!important}
      #${ONBOARDING_ID} .btr-onboarding-panel{width:min(440px,calc(100vw - 32px))!important;max-height:calc(100vh - 32px)!important;overflow:auto!important;padding:28px!important;border:1px solid #e3e5e7!important;border-radius:12px!important;background:#fff!important;box-shadow:none!important}
      #${ONBOARDING_ID} .btr-onboarding-heading{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:16px!important;margin:0 0 6px!important}
      #${ONBOARDING_ID} h2{margin:0!important;font-size:22px!important;line-height:1.35!important;font-weight:700!important;color:#18191c!important}
      #${ONBOARDING_ID} .btr-onboarding-version{flex:none!important;padding:3px 8px!important;border-radius:5px!important;background:#f1f2f3!important;color:#61666d!important;font-size:12px!important;line-height:18px!important}
      #${ONBOARDING_ID} .btr-onboarding-lead{margin:0 0 24px!important;color:#61666d!important;font-size:13px!important;line-height:1.7!important}
      #${ONBOARDING_ID} fieldset{min-width:0!important;margin:0 0 22px!important;padding:0!important;border:0!important}
      #${ONBOARDING_ID} legend{display:block!important;width:100%!important;margin:0 0 10px!important;padding:0!important;color:#18191c!important;font-size:14px!important;line-height:20px!important;font-weight:600!important}
      #${ONBOARDING_ID} .btr-onboarding-mode-list{display:grid!important;grid-template-columns:1fr 1fr!important;gap:10px!important}
      #${ONBOARDING_ID} .btr-onboarding-mode{position:relative!important;display:block!important;cursor:pointer!important}
      #${ONBOARDING_ID} .btr-onboarding-mode input{position:absolute!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important}
      #${ONBOARDING_ID} .btr-onboarding-mode-body{display:block!important;min-height:78px!important;padding:13px!important;border:1px solid #dcdfe3!important;border-radius:8px!important;background:#fff!important;color:#18191c!important;transition:border-color .15s ease,background-color .15s ease!important}
      #${ONBOARDING_ID} .btr-onboarding-mode input:checked+.btr-onboarding-mode-body{border-color:#fb7299!important;background:#fff1f5!important}
      #${ONBOARDING_ID} .btr-onboarding-mode input:focus-visible+.btr-onboarding-mode-body{outline:2px solid #00aeec!important;outline-offset:2px!important}
      #${ONBOARDING_ID} .btr-onboarding-mode-name{display:block!important;margin:0 0 5px!important;font-size:14px!important;line-height:20px!important;font-weight:600!important}
      #${ONBOARDING_ID} .btr-onboarding-mode-note{display:block!important;color:#9499a0!important;font-size:12px!important;line-height:18px!important;font-weight:400!important}
      #${ONBOARDING_ID} .btr-onboarding-thread-head{display:flex!important;align-items:center!important;justify-content:space-between!important;margin:0 0 6px!important}
      #${ONBOARDING_ID} .btr-onboarding-thread-value{color:#fb7299!important;font-size:22px!important;line-height:28px!important;font-weight:700!important;font-variant-numeric:tabular-nums!important}
      #${ONBOARDING_ID} input[type="range"]{display:block!important;width:100%!important;height:24px!important;margin:0!important;accent-color:#fb7299!important;cursor:pointer!important}
      #${ONBOARDING_ID} .btr-onboarding-ticks{display:flex!important;justify-content:space-between!important;margin-top:2px!important;color:#9499a0!important;font-size:11px!important;line-height:16px!important}
      #${ONBOARDING_ID} .btr-onboarding-tip{margin:0 0 18px!important;padding:10px 12px!important;border-radius:7px!important;background:#f6f7f8!important;color:#61666d!important;font-size:12px!important;line-height:18px!important}
      #${ONBOARDING_ID} .btr-onboarding-save{display:block!important;width:100%!important;height:42px!important;margin:0!important;border:0!important;border-radius:8px!important;background:#fb7299!important;color:#fff!important;font:600 14px/42px "Microsoft YaHei","PingFang SC",Arial,sans-serif!important;text-align:center!important;cursor:pointer!important}
      #${ONBOARDING_ID} .btr-onboarding-save:hover{background:#fc8bab!important}
      #${ONBOARDING_ID} .btr-onboarding-save:focus-visible{outline:2px solid #00aeec!important;outline-offset:2px!important}
      #${ONBOARDING_ID} .btr-onboarding-save:disabled{background:#c9ccd0!important;cursor:default!important}
      #${ONBOARDING_ID} .btr-onboarding-status{min-height:18px!important;margin:8px 0 0!important;color:#f85a54!important;font-size:12px!important;line-height:18px!important;text-align:center!important}
      @media(max-width:520px){#${ONBOARDING_ID} .btr-onboarding-panel{padding:22px!important}#${ONBOARDING_ID} .btr-onboarding-mode-list{grid-template-columns:1fr!important}#${ONBOARDING_ID} .btr-onboarding-mode-body{min-height:0!important}}
    `;
    (document.head || document.documentElement).append(style);

    const overlay = document.createElement("div");
    overlay.id = ONBOARDING_ID;
    overlay.dataset.version = VERSION;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "btr-onboarding-title");

    const panel = document.createElement("section");
    panel.className = "btr-onboarding-panel";
    const heading = document.createElement("div");
    heading.className = "btr-onboarding-heading";
    const title = document.createElement("h2");
    title.id = "btr-onboarding-title";
    title.textContent = "Bilibili 线程撕裂者";
    const version = document.createElement("span");
    version.className = "btr-onboarding-version";
    version.textContent = `v${VERSION}`;
    heading.append(title, version);

    const lead = document.createElement("p");
    lead.className = "btr-onboarding-lead";
    lead.textContent = "首次使用请完成加速设置。播放器、弹幕和字幕仍由 B 站原生功能负责，线程撕裂者只优化视频传输。";

    const modeFieldset = document.createElement("fieldset");
    const modeLegend = document.createElement("legend");
    modeLegend.textContent = "CDN 模式";
    const modeList = document.createElement("div");
    modeList.className = "btr-onboarding-mode-list";
    for (const option of [
      { value: "mainland", name: "大陆 CDN（推荐）", note: "优先使用大陆 bilivideo 节点" },
      { value: "overseas", name: "海外 CDN", note: "优先使用海外及镜像节点" }
    ]) {
      const label = document.createElement("label");
      label.className = "btr-onboarding-mode";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "btr-onboarding-mode";
      input.value = option.value;
      input.checked = option.value === latestSettings.mode;
      const body = document.createElement("span");
      body.className = "btr-onboarding-mode-body";
      const name = document.createElement("span");
      name.className = "btr-onboarding-mode-name";
      name.textContent = option.name;
      const note = document.createElement("span");
      note.className = "btr-onboarding-mode-note";
      note.textContent = option.note;
      body.append(name, note);
      label.append(input, body);
      modeList.append(label);
    }
    modeFieldset.append(modeLegend, modeList);

    const threadFieldset = document.createElement("fieldset");
    const threadHead = document.createElement("div");
    threadHead.className = "btr-onboarding-thread-head";
    const threadLegend = document.createElement("legend");
    threadLegend.textContent = "并发线程";
    const threadValue = document.createElement("output");
    threadValue.className = "btr-onboarding-thread-value";
    const initialThreadIndex = Math.max(0, THREAD_OPTIONS.indexOf(latestSettings.concurrency));
    threadValue.value = String(THREAD_OPTIONS[initialThreadIndex]);
    threadValue.textContent = String(THREAD_OPTIONS[initialThreadIndex]);
    threadHead.append(threadLegend, threadValue);
    const threadRange = document.createElement("input");
    threadRange.type = "range";
    threadRange.min = "0";
    threadRange.max = String(THREAD_OPTIONS.length - 1);
    threadRange.step = "1";
    threadRange.value = String(initialThreadIndex);
    threadRange.setAttribute("aria-label", "并发线程");
    threadRange.addEventListener("input", () => {
      const value = THREAD_OPTIONS[Number(threadRange.value)] || 32;
      threadValue.value = String(value);
      threadValue.textContent = String(value);
    });
    const ticks = document.createElement("div");
    ticks.className = "btr-onboarding-ticks";
    for (const value of THREAD_OPTIONS) {
      const tick = document.createElement("span");
      tick.textContent = String(value);
      ticks.append(tick);
    }
    threadFieldset.append(threadHead, threadRange, ticks);

    const tip = document.createElement("p");
    tip.className = "btr-onboarding-tip";
    tip.textContent = "推荐先使用大陆 CDN 和 32 线程。以后可在 B 站播放器的 ⚙ 设置中随时修改。";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btr-onboarding-save";
    save.textContent = "保存并开始加速";
    const status = document.createElement("p");
    status.className = "btr-onboarding-status";
    status.setAttribute("aria-live", "polite");
    save.addEventListener("click", () => {
      const mode = panel.querySelector('input[name="btr-onboarding-mode"]:checked')?.value === "overseas" ? "overseas" : "mainland";
      const concurrency = THREAD_OPTIONS[Number(threadRange.value)] || 32;
      save.disabled = true;
      save.textContent = "正在保存…";
      latestSettings = normalizeStoredSettings({ ...latestSettings, enabled: true, mode, concurrency });
      chrome.storage.sync.set({ enabled: true, mode, concurrency }, () => {
        if (chrome.runtime.lastError) {
          status.textContent = `保存失败：${chrome.runtime.lastError.message}`;
          save.disabled = false;
          save.textContent = "重新保存";
          return;
        }
        chrome.storage.local.set({ [ONBOARDING_STORAGE_KEY]: ONBOARDING_REVISION }, () => {
          if (chrome.runtime.lastError) {
            status.textContent = `保存失败：${chrome.runtime.lastError.message}`;
            save.disabled = false;
            save.textContent = "重新保存";
            return;
          }
          loaded = true;
          postSettings();
          syncWatermark();
          updateBadge();
          removeOnboarding();
        });
      });
    });

    panel.append(heading, lead, modeFieldset, threadFieldset, tip, save, status);
    overlay.append(panel);
    mount.append(overlay);
    save.focus({ preventScroll: true });
  }

  function showOnboardingIfNeeded() {
    if (onboardingChecked || window.top !== window) return;
    onboardingChecked = true;
    chrome.storage.local.get({ [ONBOARDING_STORAGE_KEY]: "" }, (stored) => {
      if (stored?.[ONBOARDING_STORAGE_KEY] === ONBOARDING_REVISION) return;
      setTimeout(mountOnboarding, 350);
    });
  }

  function normalizeDanmaku(input, legacyFontSize) {
    const source = input && typeof input === "object" ? input : {};
    const allowedAreas = ["quarter", "half", "threeQuarter", "full"];
    const allowedSpeeds = [1, 2.5, 5, 7.5, 10];
    const requestedSpeed = Number(source.speed);
    const requestedModes = Array.isArray(source.modes)
      ? [...new Set(source.modes.map(Number).filter((value) => [0, 1, 2].includes(value)))]
      : [0, 1, 2];
    const requestedColor = String(source.color || "").toUpperCase();
    return {
      visible: source.visible !== false,
      opacity: Math.max(0, Math.min(1, Number.isFinite(Number(source.opacity)) ? Number(source.opacity) : 0.9)),
      area: allowedAreas.includes(source.area) ? source.area : "threeQuarter",
      fontSize: Math.max(12, Math.min(64, Math.round(Number(source.fontSize ?? legacyFontSize) || 25))),
      speed: allowedSpeeds.includes(requestedSpeed) ? requestedSpeed : 5,
      modes: requestedModes,
      antiOverlap: source.antiOverlap !== false,
      synchronousPlayback: source.synchronousPlayback !== false,
      mode: [0, 1, 2].includes(Number(source.mode)) ? Number(source.mode) : 0,
      color: /^#[0-9A-F]{6}$/.test(requestedColor) ? requestedColor : "#FFFFFF"
    };
  }

  function normalizeStoredSettings(input) {
    const allowedThreads = [4, 8, 16, 32, 64, 128];
    const requested = Math.trunc(Number(input?.concurrency));
    const requestedVolume = Number(input?.volume);
    return {
      enabled: input?.enabled !== false,
      concurrency: allowedThreads.includes(requested) ? requested : 32,
      volume: Number.isFinite(requestedVolume) ? Math.max(0, Math.min(1, requestedVolume)) : 0.7,
      danmaku: normalizeDanmaku(input?.danmaku, input?.danmakuFontSize),
      mode: input?.mode === "overseas" ? "overseas" : "mainland",
      subtitleLanguage: /^[\w-]+$/i.test(String(input?.subtitleLanguage || "off"))
        ? String(input.subtitleLanguage).slice(0, 48)
        : "off",
      subtitleLastLanguage: /^[\w-]+$/i.test(String(input?.subtitleLastLanguage || ""))
        && String(input.subtitleLastLanguage).toLowerCase() !== "off"
        ? String(input.subtitleLastLanguage).slice(0, 48)
        : ""
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

  chrome.storage.sync.get(null, (stored) => {
    const migrated = { ...DEFAULTS, ...stored };
    if (!stored.danmaku && stored.danmakuFontSize !== undefined) {
      migrated.danmaku = { ...DEFAULT_DANMAKU, fontSize: stored.danmakuFontSize };
    }
    latestSettings = normalizeStoredSettings(migrated);
    if (stored.mode !== latestSettings.mode || stored.concurrency !== latestSettings.concurrency || stored.volume !== latestSettings.volume || stored.subtitleLanguage !== latestSettings.subtitleLanguage || stored.subtitleLastLanguage !== latestSettings.subtitleLastLanguage || JSON.stringify(stored.danmaku) !== JSON.stringify(latestSettings.danmaku)) {
      chrome.storage.sync.set({
        mode: latestSettings.mode,
        concurrency: latestSettings.concurrency,
        volume: latestSettings.volume,
        subtitleLanguage: latestSettings.subtitleLanguage,
        subtitleLastLanguage: latestSettings.subtitleLastLanguage,
        danmaku: latestSettings.danmaku
      });
    }
    loaded = true;
    syncWatermark();
    updateBadge();
    postSettings();
    showOnboardingIfNeeded();
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
    if (event.data.type === "subtitle-request") {
      const requestId = String(event.data.requestId || "").slice(0, 100);
      const url = String(event.data.url || "").slice(0, 4096);
      if (!requestId || !url) return;
      chrome.runtime.sendMessage({ type: "fetchSubtitleText", url }).then(
        (payload) => window.postMessage({ channel: CHANNEL, type: "subtitle-response", requestId, payload }, "*"),
        (error) => window.postMessage({
          channel: CHANNEL,
          type: "subtitle-response",
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
      const volume = Number(input.volume);
      if (Number.isFinite(volume)) update.volume = Math.max(0, Math.min(1, volume));
      if (input.danmaku && typeof input.danmaku === "object") update.danmaku = normalizeDanmaku(input.danmaku);
      if (/^[\w-]+$/i.test(String(input.subtitleLanguage || ""))) update.subtitleLanguage = String(input.subtitleLanguage).slice(0, 48);
      if (input.subtitleLastLanguage === "") update.subtitleLastLanguage = "";
      else if (/^[\w-]+$/i.test(String(input.subtitleLastLanguage || "")) && String(input.subtitleLastLanguage).toLowerCase() !== "off") update.subtitleLastLanguage = String(input.subtitleLastLanguage).slice(0, 48);
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
