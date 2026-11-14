(function installAutoQualityTest(root) {
  "use strict";

  // 自动 in the full takeover (#69). Bilibili's player starts 自动 at a quality from the
  // viewer's history and raises it by the speed of its own downloads; while BTR plays it
  // downloads nothing, so the page hook makes the choice from BTR's own download speed, inside
  // the range Bilibili's core allows 自动, and sets it on that core, whose menu then shows it.
  //
  // The core here behaves like the live one: setQualityFor moves its pick at once, refuses
  // the quality it believes is on screen, and keeps the switch pending until it is told the
  // quality is on screen. What this page cannot show is a real connection: the same rules
  // were measured with a real video against a throttled one.
  //
  //   (no parameter)  first use on a fast connection
  //   ?kept=5000      a speed kept from the last videos (kbit/s), a connection that gets
  //                   faster and then much slower
  //   ?kept=50000     a speed kept from a faster day, on a slow connection
  //   ?kept=3500      a video that runs out of data although nothing is downloading slowly
  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const BVID = "BV1autoQual01";
  const SPEED_KEY = "BTR_AutoQualitySpeed";
  const kept = Number(new URLSearchParams(location.search).get("kept")) || 0;
  // &limit=80: 自动清晰度的最高档 set to 1080P (高级设置).
  const limit = Number(new URLSearchParams(location.search).get("limit")) || 0;
  if (kept) localStorage.setItem(SPEED_KEY, `${kept}:${Date.now()}`);
  else localStorage.removeItem(SPEED_KEY);
  const QUALITIES = [16, 32, 64, 80, 116, 120];
  const BITRATE = { 16: 300000, 32: 600000, 64: 1200000, 80: 2000000, 116: 4000000, 120: 12000000 };

  // The menu's choice (0 is 自动) and the core's own pick, which 自动 shows.
  let nativeQuality = 0;
  let realQuality = 64;
  const coreCalls = [], coreTimeouts = [];
  // 自动 may go up to 4K (index 5), and down to 720P (index 2) or, with a speed kept, 480P.
  // The core rendered 720P itself before BTR took over, and still believes that is on screen.
  const state = { initialized: true, appendingSourceState: false, isAutoSwitch: { video: true }, autoSwitchTopQualityMap: { video: 5 }, autoSwitchLowestQualityMap: { video: kept ? 1 : 2 }, currentQualityIndex: { video: 2 } };
  let pendingSwitch = {};
  const core = {
    state,
    get qnSwitchingInfo() { return { video: pendingSwitch }; },
    getQualityList: () => QUALITIES.map((id) => ({ id })),
    getQualityChangedData: (event) => ({ ...event, newQualityNumber: QUALITIES[event.newQuality], oldQualityNumber: QUALITIES[event.oldQuality] }),
    fire(name, data) { if (name === "qualityChangeRendered") state.currentQualityIndex[data.mediaType] = data.newQuality; },
    setQualityFor(_type, quality, timeout) {
      coreCalls.push(quality);
      coreTimeouts.push(timeout);
      return new Promise((resolve, reject) => {
        const index = QUALITIES.indexOf(quality);
        if (index === state.currentQualityIndex.video) { reject({ msg: `Set quality equal current quality, quality: ${index}` }); return; }
        realQuality = quality;
        // As in the real core: oQn is the quality asked for, qn its index; a switch asked
        // for before is dropped without an answer.
        pendingSwitch = { switching: true, oQn: quality, qn: index, resolve, reject,
          listener(event) { pendingSwitch = {}; resolve(core.getQualityChangedData(event)); } };
      });
    }
  };
  history.replaceState(null, "", `/video/${BVID}`);
  root.__INITIAL_STATE__ = { videoData: { bvid: BVID, cid: 101 } };
  root.__playinfo__ = { data: { quality: 64, dash: { duration: 100, video: [], audio: [] } } };
  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      return { enabled: value?.enabled !== false, mode: value?.mode || "mainland", concurrency: 32, customHosts: [], autoQualityMax: Number(value?.autoQualityMax) || 0 };
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
  // What the player tells the page: its state and the seconds buffered ahead.
  const tell = (playerState, bufferedAhead) => options.onState?.({ playerState, bufferedAhead, quality: "720P", cdnHosts: [] });
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = {
    createNativePlayer(given) {
      options = given;
      playing = given.preferredQuality || given.autoQuality || 64;
      sessions = 1;
      // With a speed kept the video takes a while to load; without one it plays at once.
      setTimeout(() => tell(kept ? "loading" : "ready", kept ? 0 : 10), 0);
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
  const URL_VIDEO = "https://upos-sz-mirrorali.bilivideo.com/video.m4s";
  // A burst: one video download through BTR that is over within a moment.
  const burst = async (bytes, ms = 300) => {
    const id = options.onTransfer({ phase: "start", kind: "video", url: URL_VIDEO, totalBytes: bytes });
    await wait(ms);
    options.onTransfer({ phase: "progress", id, bytes });
    options.onTransfer({ phase: "done", id });
  };
  // Video downloading without a break at this speed, as on a connection that cannot do more.
  // One piece after the other, the next one started before the last one is over.
  const stream = async (kbps, ms) => {
    const piece = () => options.onTransfer({ phase: "start", kind: "video", url: URL_VIDEO, totalBytes: kbps * 200 / 8 });
    let id = piece();
    for (let passed = 0; passed < ms; passed += 200) {
      await wait(200);
      const next = piece();
      options.onTransfer({ phase: "progress", id, bytes: kbps * 200 / 8 });
      options.onTransfer({ phase: "done", id });
      id = next;
    }
    options.onTransfer({ phase: "cancel", id });
  };
  const keptSpeed = () => Number(String(localStorage.getItem(SPEED_KEY)).split(":")[0]) || 0;
  const events = () => { try { return JSON.parse(root.__biliThreadRipperDebug.report()).page.map((event) => event.what); } catch (_error) { return []; } };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const output = { variant: kept || "first use", coreCalls, coreTimeouts, calls, steps: {} };
  const finish = () => {
    // Every pick is confirmed by BTR, never by the core's own twenty-second timeout, and the
    // core never has to refuse one.
    output.steps.longTimeoutOnEveryPick = coreTimeouts.length > 0 && coreTimeouts.every((seconds) => seconds >= 300);
    output.steps.coreNeverRefused = !events().includes("auto quality refused");
    output.pass = Object.values(output.steps).length > 2 && Object.values(output.steps).every(Boolean)
      && root.__biliThreadRipperDebug?.version === "__BTR_VERSION__";
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  };

  document.addEventListener("DOMContentLoaded", () => {
    root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 32, autoQualityMax: limit } }, "*");
  }, { once: true });

  (async () => {
    const startedAt = performance.now();
    while (!options && performance.now() - startedAt < 5000) await wait(25);

    if (limit) {
      // The speed kept carries 4K, the limit says 1080P: 1080P is chosen while the video
      // loads, and a connection with room to spare does not take it any higher.
      await wait(1500);
      tell("ready", 30);
      output.steps.limitChoosesBelowWhatTheSpeedCarries = same(coreCalls, [limit]) && playing === limit;
      await wait(10500);
      await burst(4000000);
      await wait(2500);
      output.steps.staysAtTheLimit = coreCalls.length === 1 && playing === limit;
      finish();
      return;
    }

    if (kept === 3500) {
      // 3.5 Mbit/s carries 1080P (2 Mbit/s with room to spare). The video then runs out of
      // data twice within two minutes while nothing says the connection is fine: one
      // quality down, as before.
      await wait(1500);
      tell("ready", 30);
      output.steps.keptSpeedChooses = same(coreCalls, [80]) && playing === 80;
      // The new quality has been playing for a moment before it first runs out.
      await wait(1200);
      rebuffers = 1;
      await wait(1300);
      output.steps.oneStallChangesNothing = coreCalls.length === 1;
      rebuffers = 2;
      await wait(1500);
      output.steps.twoStallsLowerOneQuality = same(coreCalls, [80, 64]) && playing === 64 && events().includes("auto quality lowered");
      finish();
      return;
    }

    if (kept === 50000) {
      // The speed kept is from a faster day: 4K is chosen while the video loads. The
      // downloads then run without a break and bring 2.5 Mbit/s, far less than 4K needs,
      // so within seconds BTR goes to what that carries (720P; 1080P would need 3) instead
      // of waiting for Bilibili's core to give up. 720P is what the core believes is on
      // screen since before the takeover, and it would refuse it: it is told first.
      const slow = stream(2500, 7500);
      await wait(1500);
      output.steps.keptSpeedChoosesTheTop = same(coreCalls, [120]) && playing === 120;
      await slow;
      output.steps.tooMuchIsLeftWithinSeconds = same(coreCalls, [120, 64]) && playing === 64 && realQuality === 64 && events().includes("auto quality lowered");
      output.steps.speedCorrected = keptSpeed() > 1500 && keptSpeed() < 4000;
      tell("ready", 30);
      await wait(1300);
      output.steps.confirmedOncePlaying = !pendingSwitch.switching && state.currentQualityIndex.video === 2;
      // 4K is not tried again while the connection looks about the same: a burst of
      // 3.2 Mbit/s is not clearly beyond the 2.5 it failed at.
      await burst(400000);
      await wait(11500);
      output.steps.staysBelowWhatFailed = coreCalls.length === 2 && playing === 64;
      // The connection is back (a burst of 40 Mbit/s): up again.
      await burst(5000000);
      await wait(2500);
      output.steps.risesAgainOnceClearlyFaster = same(coreCalls, [120, 64, 120]) && playing === 120;
      finish();
      return;
    }

    if (kept) {
      // A speed kept from the last videos: 5 Mbit/s carries 1080P and not 1080P 60帧 (4
      // Mbit/s). The choice comes while the video is still loading, where a restart costs
      // nothing, and is confirmed to the core only once it plays.
      await wait(1500);
      output.steps.keptSpeedChoosesWhileLoading = same(coreCalls, [80]) && calls.includes("auto 80");
      output.steps.notConfirmedBeforeItPlays = pendingSwitch.switching === true && state.currentQualityIndex.video === 2;
      tell("ready", 30);
      await wait(1300);
      output.steps.confirmedOncePlaying = !pendingSwitch.switching && state.currentQualityIndex.video === 3;

      // The connection turns out faster (a burst of 40 Mbit/s with the buffer full). The
      // quality rises, but not within ten seconds of the last change.
      await burst(5000000);
      await wait(1500);
      output.steps.settlesBeforeRising = coreCalls.length === 1;
      await wait(9000);
      output.steps.risesWithRoomToSpare = same(coreCalls, [80, 120]) && playing === 120 && !pendingSwitch.switching;

      // Running out of data twice while the speed says the connection is fine (a seek to
      // the edge of the buffer, a server that hung): nothing changes.
      rebuffers = 1;
      await wait(1200);
      rebuffers = 2;
      await wait(1500);
      output.steps.stallsOnAFineConnectionChangeNothing = coreCalls.length === 2;

      // The connection gets much slower: little is left ahead, video downloads without a
      // break and brings 2.5 Mbit/s. 4K cannot be kept up: down to what that carries, at
      // once, and the speed kept for the next videos follows.
      tell("ready", 5);
      await stream(2500, 6500);
      output.steps.cannotKeepUpLowersToWhatFits = same(coreCalls, [80, 120, 64]) && playing === 64 && events().includes("auto quality lowered");
      output.steps.speedFollowsTheConnection = keptSpeed() > 1500 && keptSpeed() < 4000;
      finish();
      return;
    }

    // No speed is known yet: nothing is chosen.
    await wait(1500);
    output.steps.noPickWithoutSpeed = coreCalls.length === 0 && playing === 64;

    // The first segments come in fast, but little is buffered yet: a burst that short says
    // too little about the connection.
    await burst(5000000);
    await wait(1300);
    output.steps.burstWithLittleBufferedSaysNothing = coreCalls.length === 0;

    // Between two videos the core is not ready for a quality: nothing is asked of it.
    state.initialized = false;
    tell("ready", 30);
    await wait(1300);
    output.steps.noPickWhileCoreNotReady = coreCalls.length === 0;
    state.initialized = true;

    // The buffer is well filled and a second of downloads brought 40 Mbit/s: the first
    // choice goes straight to what that carries, the top. The menu shows it (the core's
    // pick), BTR plays it, the core is told it is on screen, and the speed is kept.
    await wait(1300);
    output.steps.firstChoiceGoesToWhatTheSpeedCarries = same(coreCalls, [120]) && realQuality === 120 && playing === 120 && calls.at(-1) === "auto 120";
    output.steps.switchConfirmed = !pendingSwitch.switching && state.currentQualityIndex.video === 5;
    output.steps.speedKept = keptSpeed() > 20000;

    // A quality picked by hand: BTR does not choose.
    click(32);
    await wait(1300);
    output.steps.manualIsLeftAlone = coreCalls.length === 1 && playing === 32 && calls.at(-1) === "quality 32";

    // Back to 自动 after the dip: it stays for a moment (no restart), then BTR chooses again
    // from the speed it knows, 4K at once, where it used to stay at 480P for good. The core
    // still believes 4K is on screen and would refuse it: it is told that 480P is.
    const before = calls.length;
    click(0);
    await wait(1500);
    output.steps.backToAutoChoosesAtOnce = same(calls.slice(before), ["auto 32", "quality 0", "auto 120"])
      && same(coreCalls, [120, 120]) && playing === 120 && !pendingSwitch.switching;
    finish();
  })();
})(globalThis);
