// Play and pause pressed while a dragged-to position is still loading. The player pauses the
// element itself while it waits for data; what the viewer presses meanwhile has to count, and
// the player's own pause must not count as theirs. Seen on CI: pause, drag, press play while
// loading, drag again, and the video stayed paused for good.
(async function runSeekIntentTest(root) {
  "use strict";

  const video = document.querySelector("video");
  const errors = [], checks = [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  // Like a real element, play() and pause() fire their event later, and only when they change
  // something; a drag fires "seeking".
  let paused = true;
  const later = name => setTimeout(() => video.dispatchEvent(new Event(name)), 0);
  Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
  video.play = () => { if (paused) { paused = false; later("play"); } return Promise.resolve(); };
  video.pause = () => { if (!paused) { paused = true; later("pause"); } };
  const drag = time => { video.currentTime = time; video.dispatchEvent(new Event("seeking")); };

  // Media downloads can be held, so a position stays loading for as long as a scenario needs.
  const factory = root.__BILI_IDM_DOWNLOADER_FACTORY__;
  const createDownloader = factory.createDownloader;
  let hold = null;
  factory.createDownloader = (...args) => {
    const downloader = createDownloader(...args);
    return { ...downloader, async downloadRange(range, resolver, options) {
      while (hold && options.kind !== "meta") await hold.promise;
      return downloader.downloadRange(range, resolver, options);
    } };
  };
  const holdMedia = () => { let release; hold = { promise: new Promise(resolve => { release = resolve; }), release }; };
  const releaseMedia = () => { const held = hold; hold = null; held?.release(); };

  const representation = (id, codecs) => ({ id, codecs, height: 1080, width: 1920,
    mimeType: codecs.startsWith("mp4a") ? "audio/mp4" : "video/mp4", bandwidth: 2000000,
    baseUrl: `https://upos-sz-mirrorali.bilivideo.com/${id}-${codecs}.m4s`,
    segment_base: { initialization: "0-99", index_range: "100-999" } });
  const playinfo = { data: { dash: { duration: 160,
    video: [representation(80, "avc1.640028")], audio: [representation(30280, "mp4a.40.2")] } } };

  async function scenario(name, steps, shouldPlay) {
    paused = true;
    video.currentTime = 0;
    const player = root.__BILI_NATIVE_MSE_PLAYER_FACTORY__.createNativePlayer({
      container: document.querySelector(".bpx-player-container"), playinfo,
      initialTime: 0, initialResume: false, preferredQuality: 80, preferredCodec: "avc",
      getSettings: () => ({ enabled: true, mode: "mainland", concurrency: 8, autoConcurrency: false }),
      nativeFetch: () => Promise.reject(new Error("no network in this test")),
      onFatal: error => errors.push(String(error?.message || error))
    });
    try {
      const deadline = performance.now() + 4000;
      while (!player.getDebug().playbackActivated && performance.now() < deadline) await sleep(10);
      if (!player.getDebug().playbackActivated) throw new Error(`${name}: player did not become ready`);
      video.play();
      await sleep(50);
      holdMedia();
      // A drag is handled 140 ms after "seeking"; each step waits past that.
      await steps();
      const loading = { paused: video.paused, time: video.currentTime };
      releaseMedia();
      const settled = performance.now() + 3000;
      while (performance.now() < settled && (video.paused === shouldPlay || player.getDebug().seekReloads < 1)) await sleep(20);
      // Long enough for a wrong automatic play() to show.
      await sleep(300);
      checks.push({ name, loading, pausedAfter: video.paused, time: video.currentTime, wantsToPlay: player.wantsToPlay(),
        pass: video.paused === !shouldPlay && player.wantsToPlay() === shouldPlay && Math.abs(video.currentTime - loading.time) < 0.01 });
    } finally {
      releaseMedia();
      player.destroy({ resumeNative: false });
    }
  }

  try {
    await scenario("paused drag, play while loading, drag again: plays", async () => {
      video.pause();
      await sleep(20);
      drag(100);
      await sleep(300);
      video.play();
      await sleep(50);
      drag(140);
      await sleep(300);
    }, true);
    await scenario("drag while playing, play then pause while loading: stays paused", async () => {
      drag(100);
      await sleep(300);
      video.play();
      await sleep(50);
      video.pause();
      await sleep(50);
    }, false);
    await scenario("drag while playing: plays on by itself", async () => {
      drag(100);
      await sleep(300);
    }, true);
  } catch (error) { errors.push(String(error?.message || error)); }

  const result = document.getElementById("seek-intent-result");
  const pass = errors.length === 0 && checks.length === 3 && checks.every(check => check.pass);
  result.textContent = JSON.stringify({ checks, errors, pass });
  result.dataset.pass = String(pass);
})(globalThis);
