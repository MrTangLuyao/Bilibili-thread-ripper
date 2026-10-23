// Runs the real page-hook.js and native-mse-player.js against a fake MediaSource and a fake
// downloader. Taking the same video over again stops BTR's player first, which takes its
// MediaSource off the element; like a real one, this element then reads zero. The next
// takeover has to go on where the viewer was, playing or paused as before. The same when
// Bilibili's player puts a new source for the same video in place (#54). A move to another
// video keeps starting where it did.
(function installRetakePositionTest(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const BVID = "BV1retake0001";
  const OTHER_BVID = "BV1retake0002";
  const SEGMENT_SECONDS = 2;
  const SEGMENT_COUNT = 400;
  const video = document.querySelector("video");
  const timeOf = new WeakMap();
  const created = [];
  const apiRequests = [];
  let clock = 0;
  let paused = true;
  let playCalls = 0;
  let objectUrls = 0;
  let headerDelayMs = 10;
  // Runs right before the next player reads the element: Bilibili putting its position back.
  let beforeCreate = null;

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
          const hook = beforeCreate;
          beforeCreate = null;
          hook?.();
          created.push({ initialTime: options.initialTime, initialResume: options.initialResume, route: location.pathname });
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
  const playinfo = () => ({ code: 0, data: { dash: {
    duration: SEGMENT_COUNT * SEGMENT_SECONDS,
    video: [representation(80, "video/mp4", "avc1.640028", 2000000)],
    audio: [representation(30280, "audio/mp4", "mp4a.40.2", 128000)]
  } } });

  history.replaceState(null, "", `/video/${BVID}`);
  root.__INITIAL_STATE__ = { videoData: { bvid: BVID, aid: 1, cid: 101, pages: [{ cid: 101 }] } };
  root.__playinfo__ = playinfo();
  // Only the other video's information is asked for; the first one is in the page.
  root.fetch = async function fakeFetch(input) {
    const url = new URL(String(input), location.href);
    apiRequests.push(url.href);
    const bvid = url.searchParams.get("bvid") || "";
    const body = url.pathname === "/x/web-interface/view" ? { code: 0, data: { bvid, aid: 2, cid: 202, pages: [{ cid: 202 }] } }
      : url.pathname === "/x/player/playurl" ? playinfo()
        : null;
    if (!body) throw new Error(`unexpected request: ${url}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = document.getElementById("retake-position-result");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (condition, ms = 6000) => {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline && !condition()) await sleep(20);
    return Boolean(condition());
  };
  const debug = () => root.__biliThreadRipperDebug;
  const player = () => debug()?.getPlayer() || null;
  // The player that replaced `previous`, once it has what it needs to play.
  const nextPlayer = async (previous) => {
    await until(() => player() && player() !== previous && player().getDebug().playbackActivated);
    return player();
  };
  const near = (value, expected) => Math.abs(Number(value) - expected) < 0.01;
  const settings = (payload) => root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 8, ...payload } }, "*");
  document.addEventListener("DOMContentLoaded", () => settings({ takeover: "full" }), { once: true });

  (async () => {
    // The viewer watches with BTR, then drags the progress bar to 638.7 seconds.
    await until(() => player()?.getDebug().playbackActivated && !paused);
    const first = player();
    clock = 638.7;
    video.dispatchEvent(new Event("seeking"));
    await until(() => first.getDebug().lastSeekMs > 0 && !paused);
    const watched = { time: clock, paused };

    // The debug restart: the same video goes on from there, still playing.
    debug().restart();
    const second = await nextPlayer(first);
    const restart = { asked: created[1], start: second?.getDebug().sessionStartTime, time: clock, paused };

    // Switching the takeover mode takes the video over again too (without Bilibili's core in
    // this page the compatibility mode takes it over in full). Then a restart while that
    // takeover still starts, when the element is not back at the position yet.
    headerDelayMs = 500;
    settings({ takeover: "compat" });
    await until(() => player() && player() !== second);
    const starting = player();
    const startingTime = clock;
    const startingActivated = Boolean(starting?.getDebug().playbackActivated);
    debug().restart();
    headerDelayMs = 10;
    const third = await nextPlayer(starting);
    const modeSwitch = { asked: created[2], startingTime, startingActivated, restartAsked: created[3], start: third?.getDebug().sessionStartTime, time: clock, paused };

    // Paused, the viewer drags to 300 seconds and presses 重新接管: it stays paused there.
    video.pause();
    clock = 300;
    video.dispatchEvent(new Event("seeking"));
    await until(() => third.getDebug().lastSeekMs > 0);
    const playsBeforeRetry = playCalls;
    root.postMessage({ channel: CHANNEL, type: "retry-takeover" }, "*");
    const fourth = await nextPlayer(third);
    await sleep(300);
    const retry = { asked: created[4], start: fourth?.getDebug().sessionStartTime, time: clock, paused, plays: playCalls - playsBeforeRetry, resumeWanted: fourth?.getDebug().resumeWanted };

    // Still paused at 300 seconds, Bilibili's player puts a new source for the same video in
    // place. Like a real element, it then reads zero and is paused. On a real page it still
    // read zero when BTR took it over, and BTR played it from the start. The video has to
    // stay paused where the viewer was.
    const swap = async (previous, source, bilibiliTime) => {
      beforeCreate = () => { clock = bilibiliTime; };
      clock = 0;
      paused = true;
      video.setAttribute("src", `${location.origin}/${source}`);
      return nextPlayer(previous);
    };
    const playsBeforeSwap = playCalls;
    const fifth = await swap(fourth, "bilibili-next-source", 0);
    await sleep(300);
    const nativeSwitch = { asked: created[5], start: fifth?.getDebug().sessionStartTime, time: clock, paused, plays: playCalls - playsBeforeSwap };

    // Playing at 450 seconds, the same again, and this time Bilibili has put an older position
    // on its source by then: it goes on playing from where the viewer was.
    video.play();
    clock = 450;
    video.dispatchEvent(new Event("seeking"));
    await until(() => fifth.getDebug().lastSeekMs > 0 && !paused);
    const sixth = await swap(fifth, "bilibili-next-source-2", 200);
    await until(() => !paused, 3000);
    const nativeSwitchPlaying = { asked: created[6], start: sixth?.getDebug().sessionStartTime, time: clock, paused };

    // A restart, and the page moves to another video before it is taken over again: that
    // video starts where Bilibili has it, not at the position of the one before.
    debug().restart();
    history.pushState(null, "", `/video/${OTHER_BVID}`);
    const seventh = await nextPlayer(sixth);
    const otherVideo = { asked: created[7], start: seventh?.getDebug().sessionStartTime, fetched: apiRequests.some((url) => url.includes(OTHER_BVID)) };

    const output = {
      created, watched, restart, modeSwitch, retry, nativeSwitch, nativeSwitchPlaying, otherVideo,
      checks: {
        watchedAtPosition: near(watched.time, 638.7) && watched.paused === false,
        restartKeepsPosition: near(restart.asked?.initialTime, 638.7) && near(restart.start, 638.7) && near(restart.time, 638.7),
        restartKeepsPlaying: restart.asked?.initialResume === true && restart.paused === false,
        modeSwitchKeepsPosition: near(modeSwitch.asked?.initialTime, 638.7),
        startingReadsZero: modeSwitch.startingTime === 0 && modeSwitch.startingActivated === false,
        restartWhileStartingKeepsPosition: near(modeSwitch.restartAsked?.initialTime, 638.7) && near(modeSwitch.start, 638.7) && near(modeSwitch.time, 638.7),
        restartWhileStartingKeepsPlaying: modeSwitch.restartAsked?.initialResume === true && modeSwitch.paused === false,
        retryKeepsPosition: near(retry.asked?.initialTime, 300) && near(retry.start, 300) && near(retry.time, 300),
        retryStaysPaused: retry.asked?.initialResume === false && retry.paused === true && retry.plays === 0 && retry.resumeWanted === false,
        nativeSwitchKeepsPausedPosition: near(nativeSwitch.asked?.initialTime, 300) && near(nativeSwitch.start, 300) && near(nativeSwitch.time, 300),
        nativeSwitchStaysPaused: nativeSwitch.asked?.initialResume === false && nativeSwitch.paused === true && nativeSwitch.plays === 0,
        nativeSwitchKeepsPlayingPosition: near(nativeSwitchPlaying.asked?.initialTime, 450) && near(nativeSwitchPlaying.start, 450) && near(nativeSwitchPlaying.time, 450),
        nativeSwitchKeepsPlaying: nativeSwitchPlaying.asked?.initialResume === true && nativeSwitchPlaying.paused === false,
        otherVideoStartsOver: otherVideo.fetched && otherVideo.asked?.route === `/video/${OTHER_BVID}` && otherVideo.asked?.initialTime === undefined && otherVideo.start === 0
      }
    };
    output.pass = Object.values(output.checks).every(Boolean) && created.length === 8 && debug()?.version === "__BTR_VERSION__";
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  })().catch((error) => {
    result.textContent = JSON.stringify({ pass: false, error: String(error?.stack || error), created });
    result.dataset.pass = "false";
  });
})(globalThis);
