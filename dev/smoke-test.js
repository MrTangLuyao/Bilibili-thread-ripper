const { chromium } = require("playwright");

const chromePath = process.env.BTR_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const target = process.env.BTR_HARNESS_URL || "http://127.0.0.1:18763/";

(async () => {
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling"]
  });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    globalThis.__btrSmokeEvents = [];
    for (const name of ["playing", "waiting", "stalled", "pause", "error"]) {
      document.addEventListener(name, (event) => {
        if (event.target instanceof HTMLVideoElement) {
          globalThis.__btrSmokeEvents.push({ name, at: performance.now(), time: event.target.currentTime });
        }
      }, true);
    }
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error?.message || error)));
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => globalThis.__harnessPlayer?.getDebug?.().playbackActivated === true, null, { timeout: 60000 });
  await page.waitForFunction(() => globalThis.__btrSmokeEvents.some((event) => event.name === "playing"), null, { timeout: 15000 });
  const started = await page.evaluate(() => ({
    at: performance.now(),
    time: document.querySelector("#__bilibili_thread_ripper_player__ video")?.currentTime || 0
  }));
  await page.waitForTimeout(15000);
  let seekResult = null;
  let startupCutoff = Number.POSITIVE_INFINITY;
  if (process.env.BTR_TEST_SEEK === "1") {
    const seekStart = await page.evaluate(() => {
      const video = document.querySelector("#__bilibili_thread_ripper_player__ video");
      const debug = globalThis.__harnessPlayer?.getDebug?.();
      const target = Math.max(30, Math.min((video?.duration || 120) - 10, (video?.duration || 120) * 0.65));
      if (video) video.currentTime = target;
      return { at: performance.now(), beforeReloads: debug?.seekReloads || 0, target };
    });
    startupCutoff = seekStart.at;
    await page.waitForFunction(({ beforeReloads, target }) => {
      const debug = globalThis.__harnessPlayer?.getDebug?.();
      return debug?.seekReloads > beforeReloads && debug.playbackActivated === true && Math.abs(debug.currentTime - target) < 3;
    }, seekStart, { timeout: 60000 });
    const resumed = await page.evaluate((seekStartState) => {
      const video = document.querySelector("#__bilibili_thread_ripper_player__ video");
      const playingAt = globalThis.__btrSmokeEvents.find((event) => event.name === "playing" && event.at > seekStartState.at)?.at || performance.now();
      return { at: performance.now(), playingAt, time: video?.currentTime || 0, target: seekStartState.target };
    }, seekStart);
    await page.waitForTimeout(10000);
    seekResult = await page.evaluate((resumedState) => {
      const video = document.querySelector("#__bilibili_thread_ripper_player__ video");
      return {
        target: resumedState.target,
        advancedSeconds: (video?.currentTime || 0) - resumedState.time,
        events: globalThis.__btrSmokeEvents.filter((event) => event.at > resumedState.playingAt + 50),
        debug: globalThis.__harnessPlayer?.getDebug?.()
      };
    }, resumed);
  }
  const result = await page.evaluate(async ({ startedState, startupEndAt }) => {
    const video = document.querySelector("#__bilibili_thread_ripper_player__ video");
    const firstPlayingAt = globalThis.__btrSmokeEvents.find((event) => event.name === "playing")?.at || startedState.at;
    const events = globalThis.__btrSmokeEvents.filter((event) => event.at > firstPlayingAt + 50 && event.at < startupEndAt);
    const harness = JSON.parse(document.getElementById("debug")?.textContent || "{}");
    const playinfo = await fetch("/playinfo").then((response) => response.json());
    const rank = (item) => {
      const codec = String(item?.codecs || item?.codec || "").toLowerCase();
      const codecId = Number(item?.codecid || item?.codec_id);
      if (codec.startsWith("av01") || codecId === 13) return 3;
      if (codec.startsWith("hev1") || codec.startsWith("hvc1") || codecId === 12) return 2;
      if (codec.startsWith("avc1") || codecId === 7) return 1;
      return 0;
    };
    const qualityId = harness.debug?.qualityId;
    const candidates = (playinfo?.data?.dash?.video || []).filter((item) =>
      Number(item.id) === qualityId && MediaSource.isTypeSupported(`${item.mimeType || item.mime_type || "video/mp4"}; codecs="${item.codecs || item.codec}"`)
    );
    return {
      startupMilliseconds: firstPlayingAt,
      advancedSeconds: (video?.currentTime || 0) - startedState.time,
      currentTime: video?.currentTime || 0,
      events,
      codecCheck: {
        actual: harness.debug?.codecFamily,
        actualRank: rank(harness.debug),
        expectedRank: Math.max(0, ...candidates.map(rank)),
        supported: candidates.map((item) => item.codecs || item.codec)
      },
      harness
    };
  }, { startedState: started, startupEndAt: startupCutoff });
  result.seek = seekResult;
  result.pageErrors = pageErrors;
  console.log(JSON.stringify(result, null, 2));
  const startupWaits = result.events.filter((event) => event.name === "waiting" || event.name === "stalled");
  const seekWaits = result.seek?.events?.filter((event) => event.name === "waiting" || event.name === "stalled") || [];
  const seekFailed = result.seek && (result.seek.advancedSeconds < 8 || seekWaits.length > 0 || result.seek.debug?.playerState === "error");
  const failed = pageErrors.length > 0 || result.harness.debug?.playerState === "error" || result.harness.maxActive > 32 || result.advancedSeconds < 12 || startupWaits.length > 0 || result.codecCheck.actualRank !== result.codecCheck.expectedRank || seekFailed;
  await browser.close();
  process.exitCode = failed ? 1 : 0;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
