(function installRuntimeNotices(root) {
  "use strict";

  const EVENT_NAMES = ["playing", "pause", "waiting", "stalled", "seeking", "seeked", "ended", "error", "emptied", "loadedmetadata", "canplay", "ratechange"];
  let settings = {};
  let attachment = null;
  let controller = null;
  let heartbeat = null;
  let lastTime = 0;
  let lastProgress = -Infinity;
  let lastReportedPlaying = null;
  // The element's own events, in English, for the diagnostic copy (diagnostic-report.js).
  // Capped so a stuttering stream cannot crowd out everything else; a repeat of the same
  // event within a second only counts up.
  const media = [];
  const MEDIA_LIMIT = 150;
  function remember(name, detail = "") {
    const at = Math.round(performance.now());
    const last = media.at(-1);
    if (last && last.name === name && last.detail === detail && at - last.at < 1000) {
      last.count = (last.count || 1) + 1;
      return;
    }
    media.push({ at, name, time: Math.round((Number(attachment?.video?.currentTime) || 0) * 10) / 10, detail });
    if (media.length > MEDIA_LIMIT) media.shift();
  }

  function current() {
    return attachment && attachment.video?.isConnected && attachment.isCurrent();
  }

  function sample() {
    if (!settings.enabled) return;
    const video = attachment?.video;
    const valid = Boolean(current());
    const now = performance.now();
    const time = Number(video?.currentTime) || 0;
    if (valid && !video.paused && !video.seeking && !video.ended && time > lastTime + 0.001) lastProgress = now;
    lastTime = time;
    const playing = valid && !video.paused && !video.ended && !video.seeking && !video.error && video.readyState >= 2 && now - lastProgress < 1800;
    if (playing !== lastReportedPlaying) {
      // The first sample after attaching only says where the watch started.
      if (valid && lastReportedPlaying !== null) remember("progress", playing ? "advancing" : "not advancing");
      lastReportedPlaying = playing;
    }
  }

  function stopWatch() {
    controller?.abort();
    controller = null;
    clearInterval(heartbeat);
    heartbeat = null;
    lastReportedPlaying = null;
    lastProgress = -Infinity;
  }

  function watch() {
    stopWatch();
    if (!settings.enabled || !attachment) return;
    const captured = attachment;
    const video = captured.video;
    controller = new AbortController();
    lastTime = Number(video.currentTime) || 0;
    for (const name of EVENT_NAMES) {
      video.addEventListener(name, () => {
        if (attachment !== captured || !current()) return;
        if (name === "playing") lastProgress = performance.now();
        else if (["pause", "waiting", "stalled", "seeking", "ended", "error", "emptied"].includes(name)) {
          lastProgress = -Infinity;
          lastTime = Number(video.currentTime) || 0;
        }
        remember(name, name === "error" ? `code ${video.error?.code || 0}${video.error?.message ? `: ${video.error.message}` : ""}`
          : name === "ratechange" ? `${Math.round((Number(video.playbackRate) || 0) * 100) / 100}x` : "");
        sample();
      }, { signal: controller.signal });
    }
    video.addEventListener("timeupdate", () => sample(), { signal: controller.signal });
    // A stalled picture fires no timeupdate, so only this heartbeat records "not advancing".
    heartbeat = setInterval(sample, 500);
    sample();
  }

  root.__BTR_RUNTIME_NOTICES__ = Object.freeze({
    history: () => media.map((entry) => ({ ...entry })),
    configure(next) {
      const changed = settings.enabled !== (next.enabled !== false);
      settings = { enabled: next.enabled !== false };
      if (changed) watch();
    },
    // Callers, the desktop app included, pass a route and a session; neither is used here.
    attach(video, _route, _session, isCurrent) {
      attachment = { video, isCurrent };
      watch();
    },
    detach(_reason) {
      stopWatch();
      attachment = null;
    }
  });
})(globalThis);
