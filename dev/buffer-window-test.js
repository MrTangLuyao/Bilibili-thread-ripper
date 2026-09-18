// Runs the real native-mse-player.js against a fake MediaSource and a fake downloader, so the
// order of segment downloads and buffer removals can be checked without real media.
(function installBufferWindowTest(root) {
  "use strict";

  const SEGMENT_SECONDS = 2;
  const SEGMENT_COUNT = 80;
  const video = document.querySelector("video");
  const timeOf = new WeakMap();
  const removals = { video: 0, audio: 0 };
  const started = {};
  const appended = {};
  let clock = 0;
  let objectUrls = 0;
  let headerDownloads = 0;

  Object.defineProperty(video, "currentTime", { configurable: true, get: () => clock, set(value) { clock = Number(value) || 0; } });
  URL.createObjectURL = () => `${location.origin}/fake-media-source-${++objectUrls}`;
  URL.revokeObjectURL = () => {};

  class FakeSourceBuffer extends EventTarget {
    constructor(kind) {
      super();
      this.kind = kind;
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
        if (this.kind === "video") appended[time.index] = performance.now();
        const last = this.ranges.at(-1);
        if (last && Math.abs(last[1] - time.startTime) < 0.01) last[1] = time.endTime;
        else this.ranges.push([time.startTime, time.endTime]);
      });
    }

    remove(start, end) {
      removals[this.kind] += 1;
      this.finish(() => {
        this.ranges = this.ranges
          .map(([from, to]) => (to <= end && from >= start ? null : [from < end && from >= start ? end : from, to]))
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

    addSourceBuffer(type) { return new FakeSourceBuffer(type.startsWith("audio") ? "audio" : "video"); }
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

  // Every third segment is slow, so a batch that waits for all of its segments leaves a gap
  // that a sliding window does not.
  root.__BILI_IDM_DOWNLOADER_FACTORY__ = {
    createDownloader: () => ({
      async downloadRange(range, _resolver, options) {
        const bytes = new Uint8Array(8);
        if (options.kind === "meta") {
          headerDownloads += 1;
          return { bytes, pieceCount: 1, total: null, hosts: [] };
        }
        if (options.kind === "video") started[range.index] = performance.now();
        options.onStartupScheduled?.();
        await new Promise((resolve) => setTimeout(resolve, [30, 60, 120][range.index % 3]));
        if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
        timeOf.set(bytes, range);
        return { bytes, byteLength: range.length, pieceCount: 1, streamed: false, total: null, hosts: [] };
      }
    })
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const representation = (id, mimeType, codecs, bandwidth) => ({
    id, mimeType, codecs, bandwidth, height: 1080,
    baseUrl: `https://upos-sz-mirrorali.bilivideo.com/${id}.m4s`,
    segment_base: { initialization: "0-99", index_range: "100-999" }
  });

  root.__runBufferWindowTest = async function runBufferWindowTest() {
    const result = document.getElementById("buffer-window-result");
    const errors = [];
    let state = null;
    const player = root.__BILI_NATIVE_MSE_PLAYER_FACTORY__.createNativePlayer({
      container: document.querySelector(".bpx-player-container"),
      playinfo: { data: { dash: { duration: SEGMENT_COUNT * SEGMENT_SECONDS, video: [representation(80, "video/mp4", "avc1.640028", 2000000)], audio: [representation(30280, "audio/mp4", "mp4a.40.2", 128000)] } } },
      initialTime: 0,
      initialResume: false,
      getSettings: () => ({ enabled: true, mode: "mainland", concurrency: 32 }),
      nativeFetch: () => Promise.reject(new Error("no network in this test")),
      onState(next) { state = next; },
      onFatal(error) { errors.push(String(error?.message || error)); }
    });

    // 45 seconds ahead of 0 is 23 segments.
    const deadline = performance.now() + 8000;
    while (performance.now() < deadline && !(state?.bufferedAhead >= 44)) await sleep(25);
    const filledAhead = state?.bufferedAhead || 0;

    // Steady state only: the first segments are the startup ones, the last ones are cut
    // short by the 45 second target.
    const lateStarts = [];
    for (let index = 3; index + 3 <= 15; index += 1) {
      if (!(started[index + 3] < appended[index + 1])) lateStarts.push(index + 3);
    }

    // Nothing is removed before 75 seconds, so the buffer first grows well past that point.
    clock = 40;
    video.dispatchEvent(new Event("timeupdate"));
    while (performance.now() < deadline && !(state?.bufferedAhead >= 44)) await sleep(25);
    clock = 80;
    await sleep(2600);
    const removalsAfterJump = { ...removals };
    clock = 85;
    await sleep(1700);
    const removalsAfterSmallStep = { ...removals };
    clock = 92;
    await sleep(1700);
    const removalsAfterLargeStep = { ...removals };

    // A seek outside the buffer starts a new session. The initialization segment and the
    // index of the same file are not asked for a second time.
    const headersBeforeSeek = headerDownloads;
    const firstAfterSeek = Math.floor(150 / SEGMENT_SECONDS);
    delete started[firstAfterSeek];
    clock = 150;
    video.dispatchEvent(new Event("seeking"));
    const seekDeadline = performance.now() + 4000;
    while (performance.now() < seekDeadline && !player.getDebug().lastSeekMs) await sleep(25);
    const seek = { headersBeforeSeek, headersAfterSeek: headerDownloads, sessions: player.getDebug().sessionStarts, lastSeekMs: player.getDebug().lastSeekMs, startedAtTarget: Boolean(started[firstAfterSeek]) };
    player.destroy({ resumeNative: false });

    const output = { errors, filledAhead, lateStarts, removalsAfterJump, removalsAfterSmallStep, removalsAfterLargeStep, seek };
    output.seekKeptHeaders = seek.headersBeforeSeek === 4 && seek.headersAfterSeek === 4 && seek.sessions === 2 && seek.lastSeekMs > 0 && seek.startedAtTarget;
    output.filled = filledAhead >= 44;
    output.keptWindowFull = lateStarts.length === 0;
    output.prunedOncePerStep = removalsAfterJump.video === 1 && removalsAfterJump.audio === 1
      && removalsAfterSmallStep.video === 1 && removalsAfterSmallStep.audio === 1
      && removalsAfterLargeStep.video === 2 && removalsAfterLargeStep.audio === 2;
    output.pass = !errors.length && output.filled && output.keptWindowFull && output.prunedOncePerStep && output.seekKeptHeaders;
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  };
})(globalThis);
