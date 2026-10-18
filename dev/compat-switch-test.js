// Runs the real page-hook.js and native-mse-player.js against a fake MediaSource, a fake
// downloader and a fake compatibility engine. The compatibility mode speeds up Bilibili's own
// player, so switching to it from the full takeover has to give the video back to Bilibili:
// its source, at the viewer's position, playing or paused as before. Stopping the takeover
// without that used to leave the element empty, a black video at zero. Bilibili's core puts
// a new source in place of the old one right after; the video only plays again once it can.
(function installCompatSwitchTest(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const BVID = "BV1compat0001";
  const SEGMENT_SECONDS = 2;
  const SEGMENT_COUNT = 400;
  const video = document.querySelector("video");
  const bilibiliSource = `${location.origin}/bilibili-source`;
  const timeOf = new WeakMap();
  const created = [];
  let clock = 0;
  let paused = true;
  let playCalls = 0;
  let objectUrls = 0;

  // The page as Bilibili left it: its own source on the element.
  video.setAttribute("src", bilibiliSource);
  Object.defineProperty(video, "currentTime", { configurable: true, get: () => clock, set(value) { clock = Number(value) || 0; } });
  Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
  video.pause = () => { paused = true; };
  video.play = () => { playCalls += 1; paused = false; return Promise.resolve(); };
  // A new source, or none at all, sends a real element back to zero.
  video.load = () => { clock = 0; };
  URL.createObjectURL = () => `${location.origin}/fake-media-source-${++objectUrls}`;
  URL.revokeObjectURL = () => {};

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

  // No CDN nodes to choose from or connect to ahead of time: nothing leaves the page.
  root.__BILI_CDN_RESOLVER_FACTORY__ = {
    createBanList: () => null,
    createResolver: (representation) => ({ status: () => [], urls: () => [representation.baseUrl] })
  };

  root.__BILI_IDM_DOWNLOADER_FACTORY__ = {
    createDownloader: () => ({
      async downloadRange(range, _resolver, options) {
        const bytes = new Uint8Array(8);
        if (options.kind === "meta") return { bytes, pieceCount: 1, total: null, hosts: [] };
        options.onStartupScheduled?.();
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
        timeOf.set(bytes, range);
        return { bytes, byteLength: range.length, pieceCount: 1, streamed: false, total: null, hosts: [] };
      }
    })
  };

  // The real player, with what each new one found on the element.
  let realFactory = null;
  Object.defineProperty(root, "__BILI_NATIVE_MSE_PLAYER_FACTORY__", {
    configurable: true,
    set(value) { realFactory = value; },
    get() {
      return realFactory && {
        ...realFactory,
        createNativePlayer(options) {
          created.push({ engine: "full", src: video.getAttribute("src"), time: clock });
          return realFactory.createNativePlayer(options);
        }
      };
    }
  });

  // Bilibili's core is there, so the compatibility mode is used. It only downloads for that
  // core and never touches the element.
  root.__BILI_NATIVE_RANGE_PLAYER_FACTORY__ = {
    supports: () => true,
    createNativePlayer(options) {
      created.push({ engine: "compat", src: video.getAttribute("src"), time: clock, paused, plays: playCalls });
      return {
        nativeTransport: true,
        transportActive: true,
        applySettings() {},
        async updatePlayinfo() {},
        destroy() {},
        getDebug: () => ({ architecture: "native-player-range-transport" }),
        video: options.container.querySelector("video")
      };
    }
  };

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
  root.fetch = async function fakeFetch(input) {
    throw new Error(`unexpected request: ${input}`);
  };

  const result = document.getElementById("compat-switch-result");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (condition, ms = 6000) => {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline && !condition()) await sleep(20);
    return Boolean(condition());
  };
  const debug = () => root.__biliThreadRipperDebug;
  const player = () => debug()?.getPlayer() || null;
  const near = (value, expected) => Math.abs(Number(value) - expected) < 0.01;
  const settings = (payload) => root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 8, ...payload } }, "*");
  // The viewer drags the progress bar while BTR plays the video.
  const seekTo = async (time) => {
    const current = player();
    clock = time;
    video.dispatchEvent(new Event("seeking"));
    await until(() => current.getDebug().lastSeekMs > 0);
  };
  const switchToCompat = async () => {
    const count = created.length;
    settings({ takeover: "compat" });
    await until(() => created.length > count && created.at(-1).engine === "compat");
    return created.at(-1);
  };
  document.addEventListener("DOMContentLoaded", () => settings({ takeover: "full" }), { once: true });

  (async () => {
    // Playing at 300 seconds, the viewer switches to the compatibility mode.
    await until(() => player()?.getDebug().playbackActivated && !paused);
    await seekTo(300);
    await until(() => !paused);
    const playsBefore = playCalls;
    const compat = await switchToCompat();
    const handedBack = { src: video.getAttribute("src"), time: clock, paused, playsBeforeReady: playCalls - playsBefore };
    // Bilibili's core has its new source ready.
    video.dispatchEvent(new Event("canplay"));
    const playsAfterReady = playCalls - playsBefore;
    video.dispatchEvent(new Event("canplay"));
    const playing = { compat, ...handedBack, playsAfterReady, playsAfterSecondReady: playCalls - playsBefore, paused };

    // Back to the full takeover: it starts where Bilibili's player is.
    settings({ takeover: "full" });
    await until(() => player() && !player().nativeTransport && player().getDebug().playbackActivated);
    const backToFull = { asked: created.at(-1), start: player()?.getDebug().sessionStartTime };

    // Paused at 200 seconds, the viewer switches again: the video stays paused there.
    video.pause();
    await seekTo(200);
    const pausedPlaysBefore = playCalls;
    const pausedCompat = await switchToCompat();
    const pausedHandedBack = { src: video.getAttribute("src"), time: clock };
    video.dispatchEvent(new Event("canplay"));
    await sleep(100);
    const pausedSwitch = { compat: pausedCompat, ...pausedHandedBack, paused, plays: playCalls - pausedPlaysBefore };

    const output = {
      created, playing, backToFull, pausedSwitch,
      checks: {
        handsBackBilibiliSource: playing.compat?.src === bilibiliSource && playing.src === bilibiliSource,
        keepsPosition: near(playing.compat?.time, 300) && near(playing.time, 300),
        waitsForBilibiliSource: playing.playsBeforeReady === 0,
        playsOnOnce: playing.playsAfterReady === 1 && playing.playsAfterSecondReady === 1 && playing.paused === false,
        backToFullKeepsPosition: backToFull.asked?.engine === "full" && near(backToFull.asked?.time, 300) && near(backToFull.start, 300),
        pausedHandsBack: pausedSwitch.compat?.src === bilibiliSource && near(pausedSwitch.compat?.time, 200) && near(pausedSwitch.time, 200),
        pausedStaysPaused: pausedSwitch.paused === true && pausedSwitch.plays === 0
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
