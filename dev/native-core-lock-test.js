(function installNativeCoreLockTest(root) {
  "use strict";

  // #49: while BTR plays a video in full takeover, Bilibili's own core must not download it.
  // Its buffer controllers say buffering is completed, which its schedule controllers take as
  // "nothing to download"; handing the video back restores them and starts the core again.
  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const BVID = "BV1corelock01";
  const OWN_VIDEO = "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/00/01/1-1-100029.m4s?deadline=1&upsig=a";
  const OTHER_VIDEO = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/99/99/9-1-100029.m4s?deadline=1";
  const container = document.querySelector(".bpx-player-container");
  const video = container.querySelector("video");

  // A stand-in for Bilibili's dash core: the processors of its active stream. Like the real
  // one, a schedule controller refuses to start once its buffer controller says buffering is
  // completed, and asks the buffer controller through the object, at the moment it starts.
  const makeProcessor = (type) => {
    const buffer = { completed: false };
    buffer.getIsBufferingCompleted = function () { return buffer.completed; };
    let started = false;
    const scheduler = {
      isStarted: () => started,
      start() { if (!buffer.getIsBufferingCompleted()) started = true; },
      stop() { started = false; }
    };
    return { buffer, original: buffer.getIsBufferingCompleted, scheduler, getType: () => type, getBufferController: () => buffer, getScheduleController: () => scheduler };
  };
  const processors = [makeProcessor("video"), makeProcessor("audio")];
  root.player = {
    __core: () => ({ getCorePlayer: () => ({ getActiveStream: () => ({ getProcessors: () => processors }) }) }),
    getQuality: () => ({ nowQ: 0, newQ: 0 })
  };

  // Stand-in for the browser's own send, installed before page-hook.js wraps it: nothing in
  // this test reaches the network.
  const sent = [];
  const proto = XMLHttpRequest.prototype;
  const realOpen = proto.open;
  proto.open = function (_method, url) { this.testUrl = String(url); return realOpen.apply(this, arguments); };
  proto.send = function () { sent.push(this.testUrl); };
  root.fetch = async () => new Response("{}");

  history.replaceState(null, "", `/video/${BVID}`);
  root.__INITIAL_STATE__ = { videoData: { bvid: BVID, cid: 101 } };
  root.__playinfo__ = { data: { dash: { duration: 320, video: [], audio: [] } } };
  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      return { enabled: value?.enabled !== false, debugNotices: false, takeover: "full", mode: "mainland", customHosts: [], concurrency: 8 };
    }
  };
  // The full-takeover player marks its container like native-mse-player.js does; the
  // compatibility mode leaves Bilibili's player in charge and marks nothing.
  let compat = false, created = 0, lastOptions = null;
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = {
    createNativePlayer(options) {
      created += 1;
      lastOptions = options;
      const nativeTransport = compat;
      if (!nativeTransport) options.container.dataset.btrMseActive = "true";
      return {
        video, nativeTransport, applySettings() {}, getDebug: () => ({}),
        ownsMediaUrl: (url) => new URL(url).pathname.startsWith("/upgcxcode/00/01/"),
        destroy() { delete options.container.dataset.btrMseActive; }
      };
    }
  };

  const settings = (payload) => root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, ...payload } }, "*");
  document.addEventListener("DOMContentLoaded", () => settings({}), { once: true });
  const waitFor = async (test, limit = 5000) => {
    const deadline = performance.now() + limit;
    while (!test() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (!test()) throw new Error("timed out");
  };
  const report = () => JSON.parse(root.__biliThreadRipperDebug.report()).nativeCore;
  const locked = (processor) => processor.buffer.getIsBufferingCompleted() === true;
  const request = (url) => { const xhr = new XMLHttpRequest(); xhr.open("GET", url); xhr.send(); };

  (async () => {
    const checks = {};
    try {
      await waitFor(() => root.__biliThreadRipperDebug?.getPlayer() && container.dataset.btrMseActive === "true");
      await waitFor(() => processors.every(locked), 3000);
      checks.locksEveryBuffer = report().buffersLocked === 2;
      // The core's own wake-ups (a seek, a play) are refused while BTR plays.
      for (const processor of processors) processor.scheduler.start();
      checks.coreCannotStart = processors.every((processor) => !processor.scheduler.isStarted());

      // A stream the core builds later is locked too.
      processors.push(makeProcessor("video"));
      await waitFor(() => processors.every(locked), 3000);
      checks.locksLaterBuffers = report().buffersLocked === 3;

      // Requests that still reach the network go out as before; those for this video's own
      // files are counted for the diagnostic report.
      request(OWN_VIDEO);
      request(OTHER_VIDEO);
      checks.requestsGoOutAndAreCounted = sent.includes(OWN_VIDEO) && sent.includes(OTHER_VIDEO) && report().mediaRequests === 1;

      // Handing the video back to Bilibili: the original answers return and its core starts.
      settings({ enabled: false });
      await waitFor(() => !root.__biliThreadRipperDebug.getPlayer());
      checks.handBackRestores = processors.every((processor) => processor.buffer.getIsBufferingCompleted === processor.original && !locked(processor))
        && report().buffersLocked === 0;
      checks.handBackStartsCore = processors.every((processor) => processor.scheduler.isStarted());
      request(OWN_VIDEO);
      checks.notCountedWithoutTakeover = report().mediaRequests === 1;

      // Compatibility mode: Bilibili's own player plays and downloads, so nothing is locked.
      compat = true;
      settings({ enabled: true });
      await waitFor(() => root.__biliThreadRipperDebug.getPlayer());
      await new Promise((resolve) => setTimeout(resolve, 1500));
      checks.compatLeavesCoreAlone = processors.every((processor) => !locked(processor)) && report().buffersLocked === 0;

      // Bilibili replaces the video source: its error panel stays hidden while BTR takes the
      // video over again, and the cover ends by itself.
      compat = false;
      settings({ enabled: false });
      await waitFor(() => !root.__biliThreadRipperDebug.getPlayer());
      settings({ enabled: true });
      await waitFor(() => root.__biliThreadRipperDebug.getPlayer() && container.dataset.btrMseActive === "true");
      const before = created;
      lastOptions.onNativeSourceChange();
      await waitFor(() => container.dataset.btrRetaking === "true");
      await waitFor(() => created > before && container.dataset.btrMseActive === "true");
      checks.retakesUnderCover = container.dataset.btrRetaking === "true";
      await waitFor(() => !container.dataset.btrRetaking, 7000);
      checks.coverEnds = true;
    } catch (error) {
      checks.error = String(error?.message || error);
    }
    const pass = !checks.error && Object.values(checks).every((value) => value === true);
    const result = document.getElementById("native-core-lock-result");
    result.textContent = JSON.stringify({ checks, pass });
    result.dataset.pass = String(pass);
  })();
})(globalThis);
