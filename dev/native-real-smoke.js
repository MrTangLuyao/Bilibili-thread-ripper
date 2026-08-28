const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

(async () => {
  const extensionPath = path.resolve(__dirname, "..");
  const targetBvid = /^BV[0-9A-Za-z]{10}$/.test(String(process.env.BTR_TARGET_BVID || ""))
    ? String(process.env.BTR_TARGET_BVID)
    : "BV1actP6KEt3";
  const playbackMs = Math.max(8000, Number(process.env.BTR_PLAYBACK_MS) || 10000);
  const seekSeconds = Number(process.env.BTR_SEEK_SECONDS);
  const pageErrors = [];
  let browser;
  let context;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      args: ["--autoplay-policy=no-user-gesture-required"]
    });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const injectedSource = [
      "src/range-core.js",
      "src/cdn-resolver.js",
      "src/sidx.js",
      "src/idm-downloader.js",
      "src/native-player.js"
    ].map((file) => fs.readFileSync(path.join(extensionPath, file), "utf8")).join("\n;\n");
    await page.addInitScript({ content: injectedSource });
    page.on("pageerror", (error) => pageErrors.push(String(error?.message || error)));
    await page.goto(`https://www.bilibili.com/video/${targetBvid}/`, {
      waitUntil: "domcontentloaded",
      timeout: 90000
    });
    await page.waitForFunction(() => Boolean(window.__biliThreadRipperDebug), null, { timeout: 30000 });
    await page.waitForSelector("#bilibili-player video", { timeout: 30000 });
    await page.evaluate(() => {
      const video = document.querySelector("#bilibili-player video");
      window.__btrPlaybackProbe = { waiting: 0, stalled: 0, playing: 0, seeking: 0 };
      for (const type of Object.keys(window.__btrPlaybackProbe)) {
        video?.addEventListener(type, () => { window.__btrPlaybackProbe[type] += 1; });
      }
    });
    await page.waitForTimeout(6000);
    await page.evaluate(async () => {
      const video = document.querySelector("#bilibili-player video");
      if (video?.paused) await video.play().catch(() => {});
    });
    await page.waitForTimeout(8000);
    const qualitySwitch = await page.evaluate(() => {
      const before = document.querySelector(".bpx-player-ctrl-quality-result")?.textContent?.trim() || "";
      const target = [...document.querySelectorAll(".bpx-player-ctrl-quality-menu-item")]
        .find((item) => /360P/.test(item.textContent || "") && !item.classList.contains("bpx-state-active"));
      if (target) target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return { before, requested: target?.textContent?.trim() || "" };
    });
    if (Number.isFinite(seekSeconds) && seekSeconds >= 0) {
      await page.waitForTimeout(3000);
      await page.evaluate((seconds) => {
        const video = document.querySelector("#bilibili-player video");
        if (video) video.currentTime = Math.min(Math.max(0, seconds), Math.max(0, video.duration - 2));
      }, seekSeconds);
    }
    await page.waitForTimeout(playbackMs);
    await page.hover(".bpx-player-ctrl-setting").catch(() => {});
    await page.waitForTimeout(300);
    await page.locator(".bpx-player-ctrl-setting-more").click().catch(() => {});
    await page.waitForTimeout(300);
    const result = await page.evaluate(() => {
      const videos = [...document.querySelectorAll("#bilibili-player video")];
      const visibleVideos = videos.filter((video) => {
        const style = getComputedStyle(video);
        const rect = video.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      });
      const debug = window.__biliThreadRipperDebug?.getStats?.() || {};
      const mediaResources = performance.getEntriesByType("resource")
        .filter((entry) => /(?:bilivideo|akamaized)\.(?:com|net)|\.m4s(?:\?|$)/i.test(entry.name))
        .map((entry) => entry.name);
      const hosts = [...new Set(mediaResources.map((value) => {
        try { return new URL(value).hostname; } catch (_error) { return ""; }
      }).filter(Boolean))];
      const nativeSubtitle = document.querySelector(".bpx-player-subtitle-wrap");
      const settingsMenu = document.querySelector(".bpx-player-ctrl-setting-menu-right");
      const settingsPanel = document.getElementById("__bilibili_thread_ripper_native_settings__");
      return {
        architecture: debug.architecture || "",
        acceleratedRequests: Number(debug.acceleratedRequests) || 0,
        acceleratedBytes: Number(debug.acceleratedBytes) || 0,
        parallelSubrequests: Number(debug.parallelSubrequests) || 0,
        nativeRangeRequests: Number(debug.nativeRangeRequests) || 0,
        nativeRangeBytes: Number(debug.nativeRangeBytes) || 0,
        nativeRangeSamples: Array.isArray(debug.nativeRangeSamples) ? debug.nativeRangeSamples : [],
        prefetchedSegments: Number(debug.prefetchedSegments) || 0,
        prefetchHits: Number(debug.prefetchHits) || 0,
        prefetchMisses: Number(debug.prefetchMisses) || 0,
        cachedBytes: Number(debug.cachedBytes) || 0,
        peakActiveThreads: Number(debug.peakActiveThreads) || 0,
        activeThreads: Number(debug.activeThreads) || 0,
        lastError: debug.lastError || "",
        customPlayerCount: document.querySelectorAll("#__bilibili_thread_ripper_player__").length,
        nativeVideoCount: videos.length,
        visibleNativeVideos: visibleVideos.length,
        currentTime: Number(visibleVideos[0]?.currentTime) || 0,
        paused: visibleVideos[0]?.paused ?? true,
        quality: document.querySelector(".bpx-player-ctrl-quality-result")?.textContent?.trim() || "",
        nativeSubtitlePresent: Boolean(nativeSubtitle),
        nativeSubtitleDisplay: nativeSubtitle ? getComputedStyle(nativeSubtitle).display : "",
        settingsPanel: Boolean(settingsPanel),
        settingsLayout: settingsMenu ? {
          clientHeight: settingsMenu.clientHeight,
          scrollHeight: settingsMenu.scrollHeight,
          overflowY: getComputedStyle(settingsMenu).overflowY,
          panelHeight: settingsPanel?.getBoundingClientRect().height || 0
        } : null,
        modeOptions: document.querySelectorAll('#__bilibili_thread_ripper_native_settings__ input[name="btr-native-mode"]').length,
        concurrencyOptions: document.querySelectorAll('#__bilibili_thread_ripper_native_settings__ input[name="btr-native-concurrency"]').length,
        mediaHosts: hosts,
        playbackProbe: window.__btrPlaybackProbe || null
      };
    });
    result.pageErrors = pageErrors;
    result.qualitySwitch = qualitySwitch;
    result.pass = result.architecture === "bilibili-native-player-idm-sidx-prefetch"
      && result.customPlayerCount === 0
      && result.visibleNativeVideos === 1
      && result.currentTime > 3
      && (!qualitySwitch.requested || /360P/.test(result.quality))
      && result.nativeSubtitlePresent
      && result.nativeSubtitleDisplay !== "none"
      && result.settingsPanel
      && result.modeOptions === 2
      && result.concurrencyOptions === 6
      && result.acceleratedRequests > 0
      && result.parallelSubrequests > result.acceleratedRequests
      && result.pageErrors.length === 0;
    console.log(JSON.stringify(result, null, 2));
    if (!result.pass) process.exitCode = 1;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
