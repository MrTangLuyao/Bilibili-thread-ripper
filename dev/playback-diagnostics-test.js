(function installPlaybackDiagnosticsTest(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const BVID = "BV1diagnose01";
  const video = document.querySelector("video");
  const callbacks = new Map();
  let nextId = 0;
  let clock = 260;
  Object.defineProperty(video, "currentTime", { configurable: true, get: () => clock });
  video.requestVideoFrameCallback = callback => { const id = nextId++; callbacks.set(id, callback); return id; };
  video.cancelVideoFrameCallback = id => callbacks.delete(id);
  video.getVideoPlaybackQuality = () => ({ totalVideoFrames: 120, droppedVideoFrames: 3 });

  history.replaceState(null, "", `/video/${BVID}`);
  root.__INITIAL_STATE__ = { videoData: { bvid: BVID, cid: 101 } };
  root.__playinfo__ = { data: { dash: { duration: 320, video: [], audio: [] } } };
  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      return { enabled: value?.enabled !== false, debugNotices: value?.debugNotices === true,
        takeover: "full", mode: "mainland", customHosts: [], concurrency: 8 };
    }
  };
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = {
    createNativePlayer: () => ({ video, applySettings() {}, destroy() {}, getDebug: () => ({}) })
  };
  root.fetch = async input => { throw new Error(`unexpected request: ${input}`); };
  const settings = payload => root.postMessage({ channel: CHANNEL, type: "settings",
    payload: { enabled: true, debugNotices: false, ...payload } }, "*");
  document.addEventListener("DOMContentLoaded", () => settings({}), { once: true });
  const waitFor = async test => {
    const deadline = performance.now() + 5000;
    while (!test() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (!test()) throw new Error("diagnostics test timed out");
  };
  const report = () => JSON.parse(root.__biliThreadRipperDebug.report());

  (async () => {
    await waitFor(() => root.__biliThreadRipperDebug?.getPlayer());
    const checks = { noWatchWithoutDebug: callbacks.size === 0 && report().playback.lastPresentedFrame === null };
    settings({ debugNotices: true });
    await waitFor(() => callbacks.size === 1);
    // Callback IDs may be zero; disabling Debug must still cancel the first callback.
    settings({ debugNotices: false });
    await waitFor(() => callbacks.size === 0);
    checks.cancelsZeroId = !callbacks.has(0);
    settings({ debugNotices: true });
    await waitFor(() => callbacks.size === 1);
    const [id, present] = callbacks.entries().next().value;
    callbacks.delete(id);
    present(performance.now(), { mediaTime: 175, expectedDisplayTime: performance.now(), presentedFrames: 100 });
    clock = 271;
    const snapshot = report();
    checks.separatesFrameAndClock = snapshot.playback.currentTime === 271
      && snapshot.playback.lastPresentedFrame.mediaTime === 175
      && snapshot.playback.lastPresentedFrame.mediaClock === 260
      && snapshot.playback.lastPresentedFrame.ageMs >= 0 && snapshot.playback.ended === false;
    checks.reportsQuality = snapshot.playback.frames.total === 120 && snapshot.playback.frames.dropped === 3
      && snapshot.playback.playbackRate === 1 && snapshot.actualTakeover === "full";
    checks.oneOutstandingCallback = callbacks.size === 1;
    video.getVideoPlaybackQuality = undefined;
    checks.noQualityApi = report().playback.frames === null;
    settings({ debugNotices: false });
    await waitFor(() => callbacks.size === 0);
    checks.releasesWatch = report().playback.lastPresentedFrame === null;
    video.requestVideoFrameCallback = undefined;
    settings({ debugNotices: true });
    await new Promise(resolve => setTimeout(resolve, 100));
    checks.noFrameApi = report().playback.lastPresentedFrame === null && callbacks.size === 0;
    settings({ enabled: false });
    await waitFor(() => !root.__biliThreadRipperDebug.getPlayer());
    document.querySelector(".bpx-player-container").remove();
    checks.noVideo = report().playback === null && report().actualTakeover === "native";
    const result = document.getElementById("playback-diagnostics-result");
    const pass = Object.values(checks).every(Boolean);
    result.textContent = JSON.stringify({ checks, pass });
    result.dataset.pass = String(pass);
  })();
})(globalThis);
