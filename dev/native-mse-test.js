(async function runNativeMseTest(root) {
  "use strict";
  const resultNode = document.getElementById("native-mse-result");
  const video = document.querySelector("video");
  const handoffTime = 1.25;
  video.currentTime = handoffTime;
  const settings = { enabled: true, mode: "mainland", concurrency: 32, bufferAheadSeconds: 24 };
  const probe = { active: 0, maxActive: 0, transfers: 0, attemptErrors: [], errors: [], state: null, segments: 0 };
  const config = await fetch("/config").then((response) => response.json());
  const playinfo = await fetch("/playinfo").then((response) => response.json());
  const render = (extra = {}) => {
    if (resultNode.dataset.pass) return;
    const debug = root.__nativeMseTestPlayer?.getDebug?.() || null;
    resultNode.textContent = JSON.stringify({ ...probe, debug, ...extra });
  };
  const nativeFetch = (input, init) => {
    const value = String(input instanceof Request ? input.url : input);
    return /(?:bilivideo\.(?:com|cn|net)|akamaized\.net)/i.test(value)
      ? fetch(`/media?url=${encodeURIComponent(value)}`, init)
      : fetch(input, init);
  };
  root.__nativeMseTestPlayer = root.__BILI_NATIVE_MSE_PLAYER_FACTORY__.createNativePlayer({
    container: document.querySelector(".bpx-player-container"),
    identity: { bvid: config.bvid, part: 1 },
    playinfo,
    getSettings: () => settings,
    nativeFetch,
    onTransfer(event) {
      if (event.phase === "start") {
        probe.active += 1;
        probe.maxActive = Math.max(probe.maxActive, probe.active);
        probe.transfers += 1;
        return probe.transfers;
      }
      if (["done", "error", "cancel"].includes(event.phase)) probe.active = Math.max(0, probe.active - 1);
      if (event.phase === "error") probe.attemptErrors.push(String(event.error?.message || event.error));
      return event.id;
    },
    onSegment() { probe.segments += 1; },
    onState(state) { probe.state = state; render(); },
    onFatal(error) { probe.errors.push(String(error?.message || error)); render(); }
  });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20000) {
    const debug = root.__nativeMseTestPlayer.getDebug();
    if (debug.playbackActivated && debug.tracks.length === 2) break;
    if (probe.errors.length) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const beforeSeek = root.__nativeMseTestPlayer.getDebug();
  const startupHandoffTime = beforeSeek.sessionStartTime;
  let seekTarget = 0;
  if (!probe.errors.length && Number(video.duration) > 20) {
    seekTarget = Math.min(video.duration - 2, Math.max(10, video.duration * 0.45));
    video.currentTime = seekTarget;
    const seekStartedAt = Date.now();
    while (Date.now() - seekStartedAt < 20000) {
      const debug = root.__nativeMseTestPlayer.getDebug();
      if (debug.seekReloads >= 1 && debug.playbackActivated && Math.abs(debug.currentTime - seekTarget) < 2) break;
      if (probe.errors.length) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const debug = root.__nativeMseTestPlayer.getDebug();
  const output = {
    architecture: debug.architecture,
    version: debug.version,
    codec: debug.codec,
    originalUiCount: document.querySelectorAll(".bpx-player-controls").length,
    videoCount: document.querySelectorAll(".bpx-player-container > video").length,
    engine: video.dataset.btrMediaEngine || "",
    mediaSourceState: debug.mediaSourceState,
    playbackActivated: debug.playbackActivated,
    progressiveAppends: debug.progressiveAppends,
    tracks: debug.tracks,
    handoffTime,
    startupHandoffTime,
    seekTarget,
    seekReloads: debug.seekReloads,
    maxActive: probe.maxActive,
    transfers: probe.transfers,
    segments: probe.segments,
    errors: probe.errors
  };
  output.pass = output.version === "0.9.0.2"
    && output.architecture === "bilibili-native-ui-progressive-mse-0.8-core"
    && output.originalUiCount === 1
    && output.videoCount === 1
    && output.engine === "progressive-mse-0.8-core"
    && output.playbackActivated
    && Math.abs(output.startupHandoffTime - output.handoffTime) < 0.01
    && output.progressiveAppends >= 2
    && output.tracks.length === 2
    && output.seekReloads >= 1
    && output.maxActive <= 32
    && output.maxActive >= 2
    && output.errors.length === 0;
  resultNode.textContent = JSON.stringify(output);
  resultNode.dataset.pass = String(output.pass);
})(globalThis);
