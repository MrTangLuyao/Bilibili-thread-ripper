(function installBridge() {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const THREAD_OPTIONS = Object.freeze([4, 8, 16, 32, 64, 128]);
  const DEFAULTS = { enabled: true, liveEnabled: false, episodeEnabled: true, blockInternational: false, bufferAheadSeconds: 45, secondaryBuffer: false, theme: "auto", concurrency: 8, autoConcurrency: true, takeover: "full", mode: "mainland", customHosts: [], floatingButton: true, floatingButtonLeft: null, floatingButtonTop: null, guideDone: false };
  // Settings of the old ArtPlayer version, of the compatibility modes removed before today's
  // 兼容模式 (that one is `takeover`), the flag of the first-run guide that 0.9.4.2 removed, and
  // 显示错误, the Debug message filters and Debug 模式 itself, now that BTR shows no messages
  // on the page.
  const RETIRED_KEYS = ["statusNotice", "compatibilityMode", "volume", "danmaku", "danmakuFontSize", "subtitleLanguage", "subtitleLastLanguage", "btrOnboardingRevision", "errorNotices", "debugCategories", "debugNotices"];
  let latestSettings = { ...DEFAULTS };
  let loaded = false;

  // The page checks each custom server again with the full rules before using it; here it
  // only has to look like a host name.
  function normalizeStoredSettings(input) {
    const threads = Math.trunc(Number(input?.concurrency));
    return {
      enabled: input?.enabled !== false,
      liveEnabled: input?.liveEnabled === true,
      episodeEnabled: input?.episodeEnabled !== false,
      blockInternational: input?.blockInternational === true,
      bufferAheadSeconds: [30, 45, 90, 180].includes(Number(input?.bufferAheadSeconds)) ? Number(input.bufferAheadSeconds) : 45,
      secondaryBuffer: input?.secondaryBuffer === true,
      theme: ["light", "dark"].includes(input?.theme) ? input.theme : "auto",
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
      guideDone: input?.guideDone === true
    };
  }

  function postSettings() {
    window.postMessage({ channel: CHANNEL, type: "settings", payload: latestSettings }, "*");
  }

  // 阻止使用国际版 (bilibili-site.js), in the page's own frame: keeps the domestic site and
  // takes an international address to the same page on it. Turned off, Bilibili chooses again.
  const site = globalThis.__BTR_BILIBILI_SITE__;
  let keepingDomestic = false;
  function applySiteChoice() {
    if (!site || window.top !== window) return;
    if (!latestSettings.enabled || !latestSettings.blockInternational) {
      if (keepingDomestic) site.stopKeepingDomestic();
      keepingDomestic = false;
      return;
    }
    keepingDomestic = true;
    site.keepDomestic();
    const target = site.domesticAddress(location.href);
    if (!target) return;
    if (site.mayRedirect()) location.replace(target);
    else {
      document.documentElement.dataset.btrSiteGaveUp = "true";
      console.warn("BTR：B 站一直把这个标签页送回国际版（可能是账号只能用国际版），这个标签页先不再跳转。");
    }
  }

  // Once Bilibili's page code knows who is signed in, it may send a domestic page on to the
  // same page on the international site. For a signed-in viewer it decides by the account (its
  // default_sites cookie) and not by user_site, so the page went back and forth until the
  // trips back stopped, and stayed international (#68). With 阻止使用国际版 on, that one
  // navigation is cancelled where the browser lets a page do so (the Navigation API); nothing
  // of Bilibili's is changed. It is registered before Bilibili's code runs; until the settings
  // are in, this site's copy of them decides.
  function blockingInternational() {
    if (loaded) return latestSettings.enabled !== false && latestSettings.blockInternational === true;
    try {
      const copy = JSON.parse(localStorage.getItem("BTR_Userscript.sync") || "{}");
      return copy?.enabled !== false && copy?.blockInternational === true;
    } catch (_error) { return false; }
  }
  if (site?.isSiteRedirect && window.top === window && typeof globalThis.navigation?.addEventListener === "function") {
    let blocked = 0;
    globalThis.navigation.addEventListener("navigate", (event) => {
      if (!event.cancelable || event.navigationType === "traverse" || event.hashChange || event.downloadRequest) return;
      if (!blockingInternational() || !site.isSiteRedirect(event.destination?.url, location.href)) return;
      event.preventDefault();
      site.keepDomestic();
      blocked += 1;
      document.documentElement.dataset.btrSiteRedirectsBlocked = String(blocked);
    });
    // For the diagnostic copy (settings-panel.js): the guard is in place on this page.
    if (document.documentElement) document.documentElement.dataset.btrSiteGuard = "on";
  }

  chrome.storage.sync.get(null, (stored) => {
    latestSettings = normalizeStoredSettings({ ...DEFAULTS, ...stored });
    const retired = RETIRED_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(stored, key));
    if (retired.length) chrome.storage.sync.remove(retired);
    const changed = Object.keys(DEFAULTS).filter((key) => JSON.stringify(stored[key]) !== JSON.stringify(latestSettings[key]));
    if (changed.length) chrome.storage.sync.set(Object.fromEntries(changed.map((key) => [key, latestSettings[key]])));
    loaded = true;
    postSettings();
    applySiteChoice();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    for (const key of Object.keys(DEFAULTS)) {
      if (changes[key]) latestSettings[key] = changes[key].newValue;
    }
    latestSettings = normalizeStoredSettings(latestSettings);
    loaded = true;
    postSettings();
    applySiteChoice();
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.channel !== CHANNEL) return;
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
    if (event.data.type === "settings-reset") chrome.storage.sync.set(DEFAULTS);
  });
})();
