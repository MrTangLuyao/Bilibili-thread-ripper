// 二级缓冲 with a browser buffer that holds only 20 seconds of video and a 160 second video:
// ?case=on    the rest of the 180 seconds waits in memory, each segment is downloaded once, and
//             a drag ahead into it downloads nothing again;
// ?case=off   the downloads stop where the buffer does, as they always did;
// ?case=limit 20 MB segments: what waits in memory stays under the memory limit.
(async function runSecondaryBufferTest(root) {
  "use strict";

  const video = document.querySelector("video");
  const testCase = new URLSearchParams(location.search).get("case") || "on";
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const errors = [];

  // The fake buffer refuses a write once it holds 20 seconds of video, as Chromium does at 150 MB.
  const addSourceBuffer = root.MediaSource.prototype.addSourceBuffer;
  const buffers = [];
  root.MediaSource.prototype.addSourceBuffer = function (type) {
    const buffer = addSourceBuffer.call(this, type);
    buffers.push(buffer);
    const appendBuffer = buffer.appendBuffer.bind(buffer);
    buffer.appendBuffer = (bytes) => {
      const held = buffer.ranges.reduce((sum, [from, to]) => sum + (to - from), 0);
      if (buffer.kind === "video" && held >= 20) throw new DOMException("full", "QuotaExceededError");
      return appendBuffer(bytes);
    };
    return buffer;
  };
  if (testCase === "limit") {
    const parseSidx = root.__BILI_SIDX__.parseSidx;
    root.__BILI_SIDX__.parseSidx = (...args) => {
      const parsed = parseSidx(...args);
      for (const segment of parsed.segments) segment.length = 20 * 1024 * 1024;
      return parsed;
    };
  }
  const downloads = new Map();
  const factory = root.__BILI_IDM_DOWNLOADER_FACTORY__;
  const createDownloader = factory.createDownloader;
  factory.createDownloader = (...args) => {
    const downloader = createDownloader(...args);
    return { ...downloader, downloadRange(range, resolver, options) {
      if (options.kind === "video") downloads.set(range.index, (downloads.get(range.index) || 0) + 1);
      return downloader.downloadRange(range, resolver, options);
    } };
  };

  const representation = (id, codecs) => ({ id, codecs, height: 1080, width: 1920,
    mimeType: codecs.startsWith("mp4a") ? "audio/mp4" : "video/mp4", bandwidth: 2000000,
    baseUrl: `https://upos-sz-mirrorali.bilivideo.com/${id}-${codecs}.m4s`,
    segment_base: { initialization: "0-99", index_range: "100-999" } });
  const playinfo = { data: { dash: { duration: 160,
    video: [representation(80, "avc1.640028")], audio: [representation(30280, "mp4a.40.2")] } } };
  const player = root.__BILI_NATIVE_MSE_PLAYER_FACTORY__.createNativePlayer({
    container: document.querySelector(".bpx-player-container"), playinfo,
    initialTime: 0, initialResume: true, preferredQuality: 80, preferredCodec: "avc",
    getSettings: () => ({ enabled: true, mode: "mainland", concurrency: 8, autoConcurrency: false, bufferAheadSeconds: 180, secondaryBuffer: testCase !== "off" }),
    nativeFetch: () => Promise.reject(new Error("no network in this test")),
    onFatal: error => errors.push(String(error?.message || error))
  });
  const reserve = () => player.getDebug().reserve || { seconds: 0, bytes: 0, limitBytes: 0 };
  const twice = () => [...downloads].filter(([, count]) => count > 1).map(([index]) => index);
  // Playback, sped up: two seconds of video every 40 ms, with the checks the element would send.
  const play = async (seconds) => {
    for (let i = 0; i < seconds / 2; i += 1) {
      video.currentTime = Math.min(159.9, video.currentTime + 2);
      video.dispatchEvent(new Event("timeupdate"));
      await sleep(40);
    }
    await sleep(1500);
  };

  const checks = {};
  try {
    const deadline = performance.now() + 5000;
    while (!player.getDebug().playbackActivated && performance.now() < deadline) await sleep(20);
    await sleep(3000);
    const start = { reserveSeconds: reserve().seconds, downloaded: downloads.size, maxBytes: reserve().bytes, limitBytes: reserve().limitBytes };
    await play(50);
    const before = downloads.size;
    video.currentTime = 120;
    video.dispatchEvent(new Event("seeking"));
    await sleep(1500);
    const afterSeek = downloads.size;
    await play(40);
    Object.assign(checks, { start, before, afterSeek, end: downloads.size, twice: twice(), reserveAtEnd: reserve().seconds });
    if (testCase === "on") {
      checks.pass = start.reserveSeconds > 100 && afterSeek === before && checks.twice.length === 0 && checks.reserveAtEnd === 0;
    } else if (testCase === "off") {
      checks.pass = start.reserveSeconds < 10 && start.downloaded < 20 && checks.twice.length === 0;
    } else {
      checks.pass = start.maxBytes <= start.limitBytes && start.maxBytes > start.limitBytes / 2 && checks.twice.length === 0;
    }
  } catch (error) { errors.push(String(error?.message || error)); }

  const result = document.getElementById("secondary-buffer-result");
  const pass = errors.length === 0 && checks.pass === true;
  result.textContent = JSON.stringify({ testCase, checks, errors, pass });
  result.dataset.pass = String(pass);
})(globalThis);
