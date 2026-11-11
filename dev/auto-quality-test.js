(function installAutoQualityTest(root) {
  "use strict";

  // 自动 in the full takeover (#69). Bilibili's player starts 自动 at a quality from the
  // viewer's history and raises it by the speed of its own downloads; while BTR plays it
  // downloads nothing, so the page hook makes the choice from BTR's own download speed, inside
  // the range Bilibili's core allows 自动, and sets it on that core, whose menu then shows it.
  // The core here behaves like the live one: setQualityFor moves its pick at once, keeps the
  // switch pending until it is told the quality is on screen, and rejects when it gives up.
  // ?kept=5000 starts with a speed kept from an earlier video (kbps) and a player that takes
  // a while to load.
  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const BVID = "BV1autoQual01";
  const SPEED_KEY = "BTR_AutoQualitySpeed";
  const kept = Number(new URLSearchParams(location.search).get("kept")) || 0;
  if (kept) localStorage.setItem(SPEED_KEY, `${kept}:${Date.now()}`);
  const QUALITIES = [16, 32, 64, 80, 116, 120];
  const BITRATE = { 16: 300000, 32: 600000, 64: 1200000, 80: 2000000, 116: 4000000, 120: 12000000 };

  // The menu's choice (0 is 自动) and the core's own pick, which 自动 shows.
  let nativeQuality = 0;
  let realQuality = 64;
  const coreCalls = [];
  // 自动 may go from 720P (index 2) to 4K (index 5).
  const state = { initialized: true, appendingSourceState: false, isAutoSwitch: { video: true }, autoSwitchTopQualityMap: { video: 5 }, autoSwitchLowestQualityMap: { video: 2 }, currentQualityIndex: { video: 2 } };
  let pendingSwitch = {};
  // The next setQualityFor gives up like the core's twenty-second timeout: the pick goes back.
  let giveUpNext = false;
  const core = {
    state,
    get qnSwitchingInfo() { return { video: pendingSwitch }; },
    getQualityList: () => QUALITIES.map((id) => ({ id })),
    getQualityChangedData: (event) => ({ ...event, newQualityNumber: QUALITIES[event.newQuality], oldQualityNumber: QUALITIES[event.oldQuality] }),
    fire(name, data) { if (name === "qualityChangeRendered") state.currentQualityIndex[data.mediaType] = data.newQuality; },
    setQualityFor(_type, quality) {
      coreCalls.push(quality);
      return new Promise((resolve, reject) => {
        const before = realQuality;
        realQuality = quality;
        if (giveUpNext) {
          giveUpNext = false;
          setTimeout(() => { realQuality = before; reject({ msg: "Call setQualityFor timeout" }); }, 400);
          return;
        }
        // As in the real core: oQn is the quality asked for, qn its index.
        pendingSwitch = { switching: true, oQn: quality, qn: QUALITIES.indexOf(quality), resolve, reject,
          listener(event) { pendingSwitch = {}; resolve(core.getQualityChangedData(event)); } };
      });
    }
  };
  history.replaceState(null, "", `/video/${BVID}`);
  root.__INITIAL_STATE__ = { videoData: { bvid: BVID, cid: 101 } };
  root.__playinfo__ = { data: { quality: 64, dash: { duration: 100, video: [], audio: [] } } };
  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      return { enabled: value?.enabled !== false, mode: value?.mode || "mainland", concurrency: 32, customHosts: [] };
    }
  };
  root.player = { getQuality: () => ({ nowQ: 0, newQ: nativeQuality, realQ: realQuality }), __core: () => core };
  for (const item of document.querySelectorAll(".bpx-player-ctrl-quality-menu-item")) {
    item.addEventListener("click", () => {
      nativeQuality = Number(item.dataset.value);
      // A quality picked by hand becomes the core's pick at once and turns its 自动 off.
      if (nativeQuality) realQuality = nativeQuality;
      state.isAutoSwitch.video = !nativeQuality;
    });
  }

  // BTR's player: what it plays, how often it started again, how often it ran out of data.
  let playing = 0, sessions = 0, rebuffers = 0, options = null;
  const calls = [];
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = {
    createNativePlayer(given) {
      options = given;
      playing = given.preferredQuality || given.autoQuality || 64;
      sessions = 1;
      setTimeout(() => given.onState?.({ playerState: kept ? "loading" : "ready", quality: "720P", bufferedAhead: 10, cdnHosts: [] }), 0);
      if (kept) setTimeout(() => given.onState?.({ playerState: "ready", quality: "720P", bufferedAhead: 10, cdnHosts: [] }), 2500);
      const play = (quality) => { if (quality && quality !== playing) { playing = quality; sessions += 1; rebuffers = 0; } };
      return {
        applySettings() {},
        async setQuality(quality) { calls.push(`quality ${quality}`); play(quality); },
        async setAutoQuality(quality) { calls.push(`auto ${quality}`); play(quality); },
        async updatePlayinfo() {},
        destroy() {},
        playableQualities: () => QUALITIES.map((id) => ({ id, bandwidth: BITRATE[id] })),
        getDebug: () => ({ qualityId: playing, autoQuality: given.autoQuality, sessionStarts: sessions, underflowRebuffers: rebuffers }),
        video: { isConnected: true, paused: false }
      };
    }
  };
  root.fetch = async function fakeFetch(input) {
    throw new Error(`unexpected request: ${input}`);
  };

  const result = document.getElementById("auto-quality-result");
  const click = (value) => document.querySelector(`.bpx-player-ctrl-quality-menu-item[data-value="${value}"] span`)
    .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // One video download through BTR: bytes in ms is the speed the page measures.
  const download = async (bytes, ms) => {
    const id = options.onTransfer({ phase: "start", kind: "video", url: "https://upos-sz-mirrorali.bilivideo.com/video.m4s", totalBytes: bytes });
    await wait(ms);
    options.onTransfer({ phase: "progress", id, bytes });
    options.onTransfer({ phase: "done", id });
  };
  const events = () => { try { return JSON.parse(root.__biliThreadRipperDebug.report()).page.map((event) => event.what); } catch (_error) { return []; } };
  const output = { coreCalls, calls, steps: {} };
  const finish = () => {
    output.pass = Object.values(output.steps).length > 0 && Object.values(output.steps).every(Boolean)
      && root.__biliThreadRipperDebug?.version === "__BTR_VERSION__";
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  };

  document.addEventListener("DOMContentLoaded", () => {
    root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 32 } }, "*");
  }, { once: true });

  (async () => {
    const startedAt = performance.now();
    while (!options && performance.now() - startedAt < 5000) await wait(25);

    if (kept) {
      // A speed kept from an earlier video: 5 Mbit/s carries 1080P (2 Mbit/s with room to
      // spare) and not 1080P 60帧 (4). The pick comes while the video is still loading, so
      // that the restart costs nothing, and is confirmed to the core only once it plays.
      await wait(1500);
      output.steps.keptSpeedPicksWhileLoading = coreCalls.length === 1 && coreCalls[0] === 80 && calls.includes("auto 80");
      output.steps.notConfirmedBeforeItPlays = pendingSwitch.switching === true && state.currentQualityIndex.video === 2;
      await wait(2500);
      output.steps.confirmedOncePlaying = !pendingSwitch.switching && state.currentQualityIndex.video === 3;

      // The core gives up on a quality (it did not start within its twenty seconds) and
      // goes back: BTR follows it back, stays there for the rest of the video however fast
      // the downloads look, and forgets the speed that promised too much.
      await download(2000000, 300);
      giveUpNext = true;
      click(64);
      await wait(300);
      click(0);
      await wait(1500);
      output.steps.triedTheTop = coreCalls.at(-1) === 120;
      const after = coreCalls.length;
      await download(2000000, 300);
      await wait(2500);
      output.steps.givenUpStaysBelow = coreCalls.length === after && playing === 64 && realQuality === 64 && events().includes("auto quality given up");
      finish();
      return;
    }

    // No speed is known yet: nothing is picked.
    await wait(1500);
    output.steps.noPickWithoutSpeed = coreCalls.length === 0 && playing === 64;

    // Between two videos the core is not ready for a quality: nothing is asked of it.
    state.initialized = false;
    await download(1000000, 300);
    await wait(1300);
    output.steps.noPickWhileCoreNotReady = coreCalls.length === 0;
    state.initialized = true;

    // First use, nothing kept: 720P came in more than twenty times faster than it plays, so
    // the top of the range is tried at once instead of climbing one quality at a time. The
    // menu shows it (the core's pick), BTR plays it, the core is told it is on screen, and
    // the speed is kept for the next video.
    await wait(1300);
    output.steps.firstUseGoesToTop = coreCalls.length === 1 && coreCalls[0] === 120 && realQuality === 120 && playing === 120 && calls.at(-1) === "auto 120";
    output.steps.switchConfirmed = !pendingSwitch.switching && state.currentQualityIndex.video === 5;
    output.steps.speedKept = Number(String(localStorage.getItem(SPEED_KEY)).split(":")[0]) > 20000;

    // A quality picked by hand: BTR does not choose.
    click(32);
    await wait(1300);
    output.steps.manualIsLeftAlone = coreCalls.length === 1 && playing === 32 && calls.at(-1) === "quality 32";

    // Back to 自动 after the dip: it stays for a moment (no restart), then BTR picks again
    // from the speed it knows, 4K at once, where it used to stay at 480P for good.
    const before = calls.length;
    click(0);
    await wait(1500);
    output.steps.backToAutoClimbs = JSON.stringify(calls.slice(before)) === JSON.stringify(["auto 32", "quality 0", "auto 120"])
      && coreCalls.length === 2 && coreCalls[1] === 120 && playing === 120 && !pendingSwitch.switching;

    // The video runs out of data twice within two minutes: one quality down, and that is
    // the limit for the rest of the video, whatever the speed says afterwards. The speed
    // kept from before promised too much: what is measured now replaces it.
    await wait(1200);
    rebuffers = 1;
    await wait(1200);
    output.steps.oneStallChangesNothing = coreCalls.length === 2;
    await download(100000, 400);
    rebuffers = 2;
    await wait(1500);
    output.steps.twoStallsLower = coreCalls.length === 3 && coreCalls[2] === 116 && playing === 116 && events().includes("auto quality lowered");
    output.steps.speedForgottenOnStall = Number(String(localStorage.getItem(SPEED_KEY)).split(":")[0]) < 5000;
    await download(4000000, 300);
    await wait(11500);
    output.steps.limitHolds = coreCalls.length === 3 && playing === 116;

    // A measured speed alone never lowers it.
    await download(100000, 400);
    await wait(1500);
    output.steps.slowSampleDoesNotLower = coreCalls.length === 3 && playing === 116;
    finish();
  })();
})(globalThis);
