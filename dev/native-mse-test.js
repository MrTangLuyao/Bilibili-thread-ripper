(async function runNativeMseTest(root) {
  "use strict";
  const resultNode = document.getElementById("native-mse-result");
  const video = document.querySelector("video");
  const query = new URLSearchParams(location.search);
  const nativeAutoplay = query.get("nativeAutoplay") === "1";
  const handoffTime = nativeAutoplay ? 0 : 1.25;
  const initialTimeParam = query.get("initialTime");
  const initialTime = initialTimeParam === null ? undefined : Math.max(0, Number(initialTimeParam) || 0);
  const initialResume = initialTimeParam === null ? undefined : true;
  video.currentTime = handoffTime;
  const settings = { enabled: true, mode: "mainland", concurrency: 32, bufferAheadSeconds: 24 };
  const probe = { active: 0, maxActive: 0, transfers: 0, attemptErrors: [], errors: [], state: null, segments: 0, nativeSourceChanges: 0, nativeErrorLogs: [] };
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
    initialTime,
    initialResume,
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
    onLog(title, detail) { if (title === "B 站原生播放器报错") probe.nativeErrorLogs.push(String(detail)); },
    onState(state) { probe.state = state; render(); },
    onNativeSourceChange() { probe.nativeSourceChanges += 1; },
    onFatal(error) { probe.errors.push(String(error?.message || error)); render(); }
  });
  if (nativeAutoplay) video.play().catch(() => {});
  const startedAt = Date.now();
  let startupActivatedAt = 0;
  let startupPreviousTime = Number(video.currentTime) || 0;
  let startupMaxTime = startupPreviousTime;
  let startupBackwardJumps = 0;
  while (Date.now() - startedAt < 20000) {
    const debug = root.__nativeMseTestPlayer.getDebug();
    const current = Number(video.currentTime) || 0;
    if (startupPreviousTime > 0.2 && current + 0.12 < startupPreviousTime) startupBackwardJumps += 1;
    startupPreviousTime = current;
    startupMaxTime = Math.max(startupMaxTime, current);
    if (debug.playbackActivated && debug.tracks.length === 2) {
      if (!nativeAutoplay) break;
      if (!startupActivatedAt) startupActivatedAt = Date.now();
      if (Date.now() - startupActivatedAt >= 750) break;
    }
    if (probe.errors.length) break;
    await new Promise((resolve) => setTimeout(resolve, nativeAutoplay ? 20 : 200));
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
  // Play the last seconds: the stream has to end and the video has to fire "ended".
  let endTarget = 0;
  let endedFired = false;
  if (!probe.errors.length && Number(video.duration) > 20) {
    video.addEventListener("ended", () => { endedFired = true; }, { once: true });
    endTarget = Math.max(0, video.duration - 4);
    video.muted = true;
    video.currentTime = endTarget;
    video.play().catch(() => {});
    const endStartedAt = Date.now();
    while (Date.now() - endStartedAt < 30000 && !endedFired && !probe.errors.length) {
      if (video.paused && !video.ended && !video.seeking) video.play().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const endDebug = root.__nativeMseTestPlayer.getDebug();
  const endDuration = Number(video.duration) || 0;
  // Issue #17: the player's 单集循环 and its replay button only send the ended video back to
  // its start; it has to play again by itself. A seek while paused anywhere else must not.
  // This starts a new session, so the state of the ended one is read above.
  const loop = { ranAgain: false, stayedPaused: null };
  if (endedFired && !probe.errors.length) {
    video.currentTime = 0;
    const loopStartedAt = Date.now();
    while (Date.now() - loopStartedAt < 25000 && !probe.errors.length) {
      if (!video.paused && Number(video.currentTime) > 0.5) { loop.ranAgain = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    video.pause();
    await new Promise((resolve) => setTimeout(resolve, 400));
    video.currentTime = Math.max(0, endTarget - 30);
    const pausedStartedAt = Date.now();
    while (Date.now() - pausedStartedAt < 8000 && video.paused) await new Promise((resolve) => setTimeout(resolve, 200));
    loop.stayedPaused = video.paused;
  }
  // Two drags of the progress bar shortly after one another while the video plays. The
  // second one arrives while the first is still loading, when the element is paused whatever
  // the viewer wants; the video has to go on playing at the second position.
  const doubleSeek = { keptPlaying: false, position: 0 };
  if (endedFired && !probe.errors.length) {
    video.play().catch(() => {});
    const playStartedAt = Date.now();
    while (Date.now() - playStartedAt < 15000 && (video.paused || video.readyState < 3)) await new Promise((resolve) => setTimeout(resolve, 200));
    const first = Math.max(5, endTarget * 0.25), second = Math.max(10, endTarget * 0.6);
    video.currentTime = first;
    await new Promise((resolve) => setTimeout(resolve, 400));
    video.currentTime = second;
    const doubleStartedAt = Date.now();
    while (Date.now() - doubleStartedAt < 25000 && !probe.errors.length) {
      if (!video.paused && Number(video.currentTime) > second + 0.5 && Number(video.currentTime) < second + 20) { doubleSeek.keptPlaying = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    doubleSeek.position = Number(video.currentTime) || 0;
  }
  // Bilibili's own toasts stay visible; its error panel is hidden only while BTR plays and
  // what it said is in the log.
  const shown = (selector) => getComputedStyle(document.querySelector(selector)).display !== "none";
  const nativeLayers = { toastVisible: shown(".bpx-player-toast-wrap"), errorHiddenWhileActive: !shown(".bpx-player-error-wrap"), errorLogged: probe.nativeErrorLogs.some((detail) => detail.includes("B 站原生内核报错占位")) };
  video.src = "data:video/mp4;base64,";
  video.load();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const output = {
    architecture: debug.architecture,
    version: debug.version,
    codec: debug.codec,
    originalUiCount: document.querySelectorAll(".bpx-player-controls").length,
    videoCount: document.querySelectorAll(".bpx-player-container > video").length,
    engine: video.dataset.btrMediaEngine || "",
    mediaSourceState: debug.mediaSourceState,
    playbackActivated: debug.playbackActivated,
    resumeWanted: debug.resumeWanted,
    progressiveAppends: debug.progressiveAppends,
    tracks: debug.tracks,
    handoffTime,
    initialTimeOption: initialTime ?? null,
    startupHandoffTime,
    nativeAutoplay,
    startupMaxTime,
    startupBackwardJumps,
    seekTarget,
    seekReloads: debug.seekReloads,
    requestedCodec: query.get("codec") || "",
    endTarget,
    endedFired,
    loop,
    doubleSeek,
    endMediaSourceState: endDebug.mediaSourceState,
    endDuration,
    durationRefusals: root.__durationRefusals || 0,
    nativeLayers,
    maxActive: probe.maxActive,
    transfers: probe.transfers,
    segments: probe.segments,
    nativeSourceChanges: probe.nativeSourceChanges,
    errors: probe.errors
  };
  output.pass = output.version === "__BTR_VERSION__"
    && output.architecture === "bilibili-native-ui-progressive-mse-0.8-core"
    && output.originalUiCount === 1
    && output.videoCount === 1
    && output.engine === "progressive-mse-0.8-core"
    && output.playbackActivated
    && (initialResume === undefined || output.resumeWanted === initialResume)
    && (nativeAutoplay || Math.abs(output.startupHandoffTime - (initialTime ?? output.handoffTime)) < 0.01)
    && (!nativeAutoplay || (output.startupMaxTime >= 0.2 && output.startupBackwardJumps === 0))
    && output.progressiveAppends >= 2
    && output.tracks.length === 2
    && output.seekReloads >= 1
    && (!output.requestedCodec || output.codec === output.requestedCodec)
    && output.endedFired
    && output.loop.ranAgain
    && output.loop.stayedPaused === true
    && output.doubleSeek.keptPlaying
    && output.endMediaSourceState === "ended"
    && output.durationRefusals === 0
    && output.nativeLayers.toastVisible
    && output.nativeLayers.errorHiddenWhileActive
    && output.nativeLayers.errorLogged
    && output.maxActive <= 32
    && output.maxActive >= 2
    && output.nativeSourceChanges === 1
    && output.errors.length === 0;
  resultNode.textContent = JSON.stringify(output);
  resultNode.dataset.pass = String(output.pass);
})(globalThis);
