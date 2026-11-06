// Runs the real page-hook.js and native-mse-player.js against a fake MediaSource and a fake
// downloader, and plays Bilibili's player putting its own source in place while BTR plays.
// Its player pauses the element right before that, also while BTR's start still loads: the
// pause belongs to the switch and the retake goes on playing (#65). A pause the viewer pressed
// stays a pause, and a retake that keeps the video paused tells the page, which otherwise went
// on showing it playing. The player's background mode, which swaps in a new element when the
// tab comes back, reads as off on a video page BTR takes over in full (#66).
(function installSourceSwitchTest(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const BVID = "BV1switch0001";
  const KV_CONFIG = "bilibili_player_kv_config";
  const SEGMENT_SECONDS = 2;
  const SEGMENT_COUNT = 400;
  const video = document.querySelector("video");
  const timeOf = new WeakMap();
  const created = [];
  let clock = 0;
  let paused = true;
  let objectUrls = 0;
  let headerDelayMs = 10;
  // No click or key press unless a step says so.
  let activated = false;
  Object.defineProperty(navigator, "userActivation", { configurable: true, get: () => ({ isActive: activated, hasBeenActive: activated }) });

  Object.defineProperty(video, "currentTime", { configurable: true, get: () => clock, set(value) { clock = Number(value) || 0; } });
  Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
  video.pause = () => { paused = true; };
  video.play = () => { paused = false; return Promise.resolve(); };
  video.load = () => { clock = 0; };
  URL.createObjectURL = () => `${location.origin}/fake-media-source-${++objectUrls}`;
  URL.revokeObjectURL = () => {};

  // What Bilibili's player hears: its play button and danmaku follow these events.
  const heard = [];
  for (const type of ["play", "playing", "pause"]) video.addEventListener(type, () => heard.push(type));
  const lastHeard = () => heard.filter((type) => type !== "playing").at(-1) || "";

  class FakeSourceBuffer extends EventTarget {
    constructor() {
      super();
      this.updating = false;
      this.ranges = [];
    }

    get buffered() {
      const ranges = this.ranges;
      return { length: ranges.length, start: (index) => ranges[index][0], end: (index) => ranges[index][1] };
    }

    finish(change) {
      this.updating = true;
      setTimeout(() => {
        change();
        this.updating = false;
        this.dispatchEvent(new Event("updateend"));
      }, 1);
    }

    appendBuffer(bytes) {
      const time = timeOf.get(bytes);
      this.finish(() => {
        if (!time) return;
        const last = this.ranges.find(([, end]) => Math.abs(end - time.startTime) < 0.01);
        if (last) last[1] = time.endTime;
        else this.ranges.push([time.startTime, time.endTime]);
        this.ranges.sort((a, b) => a[0] - b[0]);
      });
    }

    abort() {}

    remove(start, end) {
      this.finish(() => {
        this.ranges = this.ranges
          .flatMap(([from, to]) => (to <= start || from >= end ? [[from, to]] : [from < start ? [from, start] : null, to > end ? [end, to] : null]))
          .filter(Boolean);
      });
    }
  }

  root.MediaSource = class FakeMediaSource extends EventTarget {
    static isTypeSupported() { return true; }

    constructor() {
      super();
      this.readyState = "closed";
      this.duration = NaN;
      setTimeout(() => {
        this.readyState = "open";
        this.dispatchEvent(new Event("sourceopen"));
      }, 0);
    }

    addSourceBuffer() { return new FakeSourceBuffer(); }
    endOfStream() { this.readyState = "ended"; }
  };

  root.__BILI_SIDX__ = {
    parseSidx: () => ({
      segments: Array.from({ length: SEGMENT_COUNT }, (_item, index) => ({
        index,
        start: 1000 + index * 1000,
        end: 1999 + index * 1000,
        length: 1000,
        startTime: index * SEGMENT_SECONDS,
        endTime: (index + 1) * SEGMENT_SECONDS,
        durationSeconds: SEGMENT_SECONDS
      }))
    }),
    segmentIndexAt: (segments, seconds) => Math.max(0, Math.min(segments.length - 1, Math.floor(seconds / SEGMENT_SECONDS)))
  };

  root.__BILI_CDN_RESOLVER_FACTORY__ = {
    createBanList: () => null,
    createResolver: (representation) => ({ status: () => [], urls: () => [representation.baseUrl] })
  };

  root.__BILI_IDM_DOWNLOADER_FACTORY__ = {
    createDownloader: () => ({
      async downloadRange(range, _resolver, options) {
        const bytes = new Uint8Array(8);
        if (options.kind === "meta") {
          await new Promise((resolve) => setTimeout(resolve, headerDelayMs));
          if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
          return { bytes, pieceCount: 1, total: null, hosts: [] };
        }
        options.onStartupScheduled?.();
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
        timeOf.set(bytes, range);
        return { bytes, byteLength: range.length, pieceCount: 1, streamed: false, total: null, hosts: [] };
      }
    })
  };

  // The real player, with what the page asked each new one for.
  let realFactory = null;
  Object.defineProperty(root, "__BILI_NATIVE_MSE_PLAYER_FACTORY__", {
    configurable: true,
    set(value) { realFactory = value; },
    get() {
      return realFactory && {
        ...realFactory,
        createNativePlayer(options) {
          created.push({ initialTime: options.initialTime, initialResume: options.initialResume });
          return realFactory.createNativePlayer(options);
        }
      };
    }
  });

  const representation = (id, mimeType, codecs, bandwidth) => ({
    id, mimeType, codecs, bandwidth, height: 1080,
    baseUrl: `https://upos-sz-mirrorali.bilivideo.com/${id}.m4s`,
    segment_base: { initialization: "0-99", index_range: "100-999" }
  });
  history.replaceState(null, "", `/video/${BVID}`);
  root.__INITIAL_STATE__ = { videoData: { bvid: BVID, aid: 1, cid: 101, pages: [{ cid: 101 }] } };
  root.__playinfo__ = { code: 0, data: { dash: {
    duration: SEGMENT_COUNT * SEGMENT_SECONDS,
    video: [representation(80, "video/mp4", "avc1.640028", 2000000)],
    audio: [representation(30280, "audio/mp4", "mp4a.40.2", 128000)]
  } } };
  root.fetch = async (input) => { throw new Error(`unexpected request: ${input}`); };

  // Stored before page-hook.js runs, for the read the page makes before BTR's settings are in.
  const stored = { dash_config: { enable_av1: "1", audio_only_config: { enabled: true, default_time: 20, gap_time: 2 } }, version: 3 };
  localStorage.setItem(KV_CONFIG, JSON.stringify(stored));

  const result = document.getElementById("source-switch-result");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (condition, ms = 6000) => {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline && !condition()) await sleep(10);
    return Boolean(condition());
  };
  const debug = () => root.__biliThreadRipperDebug;
  const player = () => debug()?.getPlayer() || null;
  const playing = (candidate) => Boolean(candidate?.getDebug().playbackActivated) && !paused;
  const nextPlayer = async (previous, ms = 6000) => {
    await until(() => player() && player() !== previous && player().getDebug().playbackActivated, ms);
    return player();
  };
  const replacedEvents = () => JSON.parse(debug().report()).page.filter((event) => event.what === "Bilibili replaced the video source").map((event) => event.detail);
  // Bilibili's player puts its own source in place: like a real element, it reads zero and paused.
  let sources = 0;
  const bilibiliSource = () => {
    clock = 0;
    paused = true;
    video.setAttribute("src", `${location.origin}/bilibili-own-source-${++sources}`);
  };
  const settings = (payload) => root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 8, ...payload } }, "*");
  document.addEventListener("DOMContentLoaded", () => settings({ takeover: "full" }), { once: true });

  (async () => {
    // 1. The start is still loading (it reads as playing to the page) when Bilibili's player
    // pauses the element and puts its own source in place, with no click or key press around.
    headerDelayMs = 700;
    await until(() => player());
    const first = player();
    await sleep(50);
    const firstStillLoading = !first.getDebug().playbackActivated && first.getDebug().resumeWanted === true;
    video.pause();
    bilibiliSource();
    // Its new source plays by itself before BTR takes it over again. The retake goes on
    // playing, so the page hears no pause from it.
    paused = false;
    video.dispatchEvent(new Event("play"));
    video.dispatchEvent(new Event("playing"));
    const heardBeforeRetake = heard.length;
    headerDelayMs = 10;
    const second = await nextPlayer(first);
    await until(() => playing(second), 3000);
    await sleep(300);
    const duringStart = { asked: created[1], replaced: replacedEvents()[0], paused, heardAfterOwnPlay: heard.slice(heardBeforeRetake) };

    // 2. Playing on at 120 seconds, where nothing is buffered yet, so BTR waits for data there:
    // Bilibili's player pauses the element and puts its own source in place at once.
    clock = 120;
    video.dispatchEvent(new Event("timeupdate"));
    await sleep(50);
    video.pause();
    bilibiliSource();
    const third = await nextPlayer(second);
    await until(() => playing(third), 3000);
    const whilePlaying = { asked: created[2], replaced: replacedEvents()[1], paused };

    // 3. The viewer pauses, and a moment later Bilibili's player puts its own source in place
    // for a reason of its own and plays it by itself before BTR takes it over: the video stays
    // paused, and the page hears that.
    clock = 200;
    activated = true;
    video.pause();
    video.dispatchEvent(new Event("pause"));
    activated = false;
    await sleep(100);
    bilibiliSource();
    paused = false;
    video.dispatchEvent(new Event("play"));
    video.dispatchEvent(new Event("playing"));
    const fourth = await nextPlayer(third);
    await sleep(300);
    const viewerPaused = { asked: created[3], replaced: replacedEvents()[2], paused, lastHeard: lastHeard(), resumeWanted: fourth?.getDebug().resumeWanted };

    // 4. Playing again and taken over anew (a restart), with a click on the page a moment ago
    // (as when an item of a collection was clicked): the start is loading when Bilibili's
    // player pauses the element and puts its own source in place. The click does not make
    // that pause the viewer's.
    activated = true;
    video.play();
    video.dispatchEvent(new Event("play"));
    activated = false;
    await until(() => !paused, 2000);
    headerDelayMs = 700;
    debug().restart();
    await until(() => player() && player() !== fourth);
    const restarted = player();
    await sleep(50);
    const restartStillLoading = !restarted.getDebug().playbackActivated && restarted.getDebug().resumeWanted === true;
    activated = true;
    video.pause();
    bilibiliSource();
    activated = false;
    headerDelayMs = 10;
    const sixth = await nextPlayer(restarted);
    await until(() => playing(sixth), 3000);
    const afterClick = { asked: created[5], replaced: replacedEvents()[3], paused };

    // 5. Bilibili's player reads whether its background mode is on from its stored config.
    const read = () => { try { return JSON.parse(localStorage.getItem(KV_CONFIG)); } catch (_error) { return null; } };
    const full = read();
    // A page BTR does not take over keeps the mode, and so does an episode, which plays in
    // Bilibili's own player; so did the read made before BTR's settings were in.
    history.replaceState(null, "", "/");
    const elsewhere = read();
    history.replaceState(null, "", "/bangumi/play/ep123");
    const episode = read();
    let beforeSettings = null;
    try { beforeSettings = JSON.parse(root.__kvReadBeforeSettings); } catch (_error) {}
    history.replaceState(null, "", `/video/${BVID}`);
    const untouched = localStorage[KV_CONFIG];
    localStorage.removeItem(KV_CONFIG);
    const fullWithout = read();
    localStorage.setItem(KV_CONFIG, "not json");
    const broken = localStorage.getItem(KV_CONFIG);
    localStorage.setItem("bpx_player_profile", JSON.stringify({ media: { autoplay: true } }));
    const otherKey = localStorage.getItem("bpx_player_profile");
    localStorage.setItem(KV_CONFIG, JSON.stringify(stored));
    settings({ takeover: "compat" });
    await until(() => debug().getSettings().takeover === "compat", 2000);
    const compat = read();
    settings({ takeover: "full", enabled: false });
    await until(() => debug().getSettings().enabled === false, 2000);
    const disabled = read();
    localStorage.removeItem(KV_CONFIG);
    const backgroundMode = { full, elsewhere, episode, beforeSettings, untouched, fullWithout, broken, otherKey, compat, disabled };

    const output = {
      created, duringStart, whilePlaying, viewerPaused, afterClick, backgroundMode,
      checks: {
        firstStillLoading,
        startPauseIsTheSwitchs: /playing$/.test(duringStart.replaced || "") && duringStart.asked?.initialResume === true,
        startRetakePlays: duringStart.paused === false && !duringStart.heardAfterOwnPlay.includes("pause"),
        playingPauseIsTheSwitchs: /playing$/.test(whilePlaying.replaced || "") && whilePlaying.asked?.initialResume === true,
        playingRetakePlays: whilePlaying.paused === false,
        restartStillLoading,
        clickedStartPauseIsTheSwitchs: /playing$/.test(afterClick.replaced || "") && afterClick.asked?.initialResume === true && afterClick.paused === false,
        viewersPauseStands: /paused$/.test(viewerPaused.replaced || "") && viewerPaused.asked?.initialResume === false && viewerPaused.paused === true && viewerPaused.resumeWanted === false,
        pageHearsThePause: viewerPaused.lastHeard === "pause",
        backgroundModeOff: full?.dash_config?.audio_only_config?.enabled === false && full.dash_config.audio_only_config.default_time === 20
          && full.dash_config.enable_av1 === "1" && full.version === 3,
        otherPagesKeepIt: elsewhere?.dash_config?.audio_only_config?.enabled === true && episode?.dash_config?.audio_only_config?.enabled === true,
        unknownSettingsKeepIt: beforeSettings?.dash_config?.audio_only_config?.enabled === true,
        storedConfigUntouched: untouched === JSON.stringify(stored),
        backgroundModeOffWithoutConfig: fullWithout?.dash_config?.audio_only_config?.enabled === false,
        brokenConfigLeftAlone: broken === "not json",
        otherKeysLeftAlone: otherKey === JSON.stringify({ media: { autoplay: true } }),
        compatLeavesItOn: compat?.dash_config?.audio_only_config?.enabled === true,
        disabledLeavesItOn: disabled?.dash_config?.audio_only_config?.enabled === true
      }
    };
    output.pass = Object.values(output.checks).every(Boolean) && debug()?.version === "__BTR_VERSION__";
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  })().catch((error) => {
    result.textContent = JSON.stringify({ pass: false, error: String(error?.stack || error), created });
    result.dataset.pass = "false";
  });
})(globalThis);
