(async function runPlaybackStateTest(root) {
  "use strict";

  const video = document.querySelector("video");
  const errors = [], checks = [];
  const representation = (id, codecs, height) => ({ id, codecs, height,
    mimeType: "video/mp4", bandwidth: 2000000, width: height === 1080 ? 1920 : 1280,
    baseUrl: `https://upos-sz-mirrorali.bilivideo.com/${id}-${codecs}.m4s`,
    segment_base: { initialization: "0-99", index_range: "100-999" } });
  const playinfo = { data: { dash: { duration: 160,
    video: [representation(80, "avc1.640028", 1080), representation(80, "av01.0.08M.08", 1080),
      representation(64, "avc1.640028", 720), representation(64, "av01.0.08M.08", 720)],
    audio: [{ id: 30280, mimeType: "audio/mp4", codecs: "mp4a.40.2", bandwidth: 128000,
      baseUrl: "https://upos-sz-mirrorali.bilivideo.com/audio.m4s",
      segment_base: { initialization: "0-99", index_range: "100-999" } }] } } };
  const create = options => {
    video.currentTime = 0;
    video.pause();
    return root.__BILI_NATIVE_MSE_PLAYER_FACTORY__.createNativePlayer({
      container: document.querySelector(".bpx-player-container"), playinfo,
      initialTime: 0, initialResume: false, preferredQuality: 80, preferredCodec: "avc",
      getSettings: () => ({ enabled: true, mode: "mainland", concurrency: 8, autoConcurrency: false }),
      nativeFetch: () => Promise.reject(new Error("no network in this test")),
      onFatal: error => errors.push(String(error?.message || error)), ...options
    });
  };
  const ready = async player => {
    const deadline = performance.now() + 4000;
    while (!player.getDebug().playbackActivated && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    if (!player.getDebug().playbackActivated) throw new Error("player did not become ready");
  };
  async function switched(name, options, method, value, expectedTime, shouldPlay, duringStartup = false) {
    const player = create(options);
    try {
      if (!duringStartup) await ready(player);
      const pausedBefore = video.paused;
      await player[method](value);
      await ready(player);
      const debug = player.getDebug();
      checks.push({ name, pausedBefore, pausedAfter: video.paused, time: video.currentTime,
        resumeWanted: debug.resumeWanted, sessions: debug.sessionStarts, quality: debug.qualityId, codec: debug.codec,
        pass: video.paused === !shouldPlay && player.wantsToPlay() === shouldPlay
          && Math.abs(video.currentTime - expectedTime) < 0.01 && debug.sessionStarts === 2
          && (method === "setQuality" ? debug.qualityId === value : debug.codec === value) });
    } finally { player.destroy({ resumeNative: false }); }
  }

  try {
    await switched("paused at zero: quality", {}, "setQuality", 64, 0, false);
    await switched("paused in the first second: codec", { initialTime: 0.5 }, "setCodec", "av1", 0.5, false);
    await switched("autoplay disabled: quality", { initialResume: undefined, autoplay: false }, "setQuality", 64, 0, false);
    // The element is still paused at zero before sourceopen, but the pending session knows
    // the requested start position and whether it should play once data is available.
    await switched("pending start position: quality", { initialTime: 120, initialResume: true }, "setQuality", 64, 120, true, true);
    await switched("pending start position: codec", { initialTime: 120, initialResume: true }, "setCodec", "av1", 120, true, true);
    await switched("playing in the first second: quality", { initialTime: 0.5, initialResume: true }, "setQuality", 64, 0.5, true);
    const player = create({});
    let handedBack = null;
    try {
      await ready(player);
      player.destroy({ resumeNative: true, handBack(_video, time, play) { handedBack = { time, play }; return true; } });
      checks.push({ name: "paused at zero: native handoff", handedBack, pass: handedBack?.time === 0 && handedBack.play === false });
    } finally { player.destroy({ resumeNative: false }); }
  } catch (error) { errors.push(String(error?.message || error)); }

  const result = document.getElementById("playback-state-result");
  const pass = errors.length === 0 && checks.length === 7 && checks.every(check => check.pass);
  result.textContent = JSON.stringify({ checks, errors, pass });
  result.dataset.pass = String(pass);
})(globalThis);
