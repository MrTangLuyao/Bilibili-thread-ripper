(function installCompatCacheTest(root) {
  "use strict";

  // The compatibility mode with the real native-range-transport.js, cdn-resolver.js and
  // idm-downloader.js, against a fake video server. Bilibili's player empties its whole
  // buffer when it seeks to a place it has not buffered, and asks for those bytes again.
  // What is checked: bytes delivered once are answered from memory, through XHR (the
  // player's loader) and fetch, in well under the 25 ms below which dash.js takes a download
  // for a cache hit; a part, a whole made of two downloads, and the same file under another
  // path are answered too; a range with a gap is downloaded; a new player starts empty.
  const CID = "900000021";
  const DIR = `/upgcxcode/11/22/${CID}/`;
  const VIDEO = `https://upos-sz-mirrorali.bilivideo.com${DIR}${CID}-1-100026.m4s?sig=video`;
  const AUDIO = `https://upos-sz-mirrorali.bilivideo.com${DIR}${CID}-1-30280.m4s?sig=audio`;
  // The same audio file as the player gets it from a backup address, under another path.
  const AUDIO_BACKUP = `https://upos-sz-mirrorcos.bilivideo.com/v1/resource${DIR}${CID}-1-30280.m4s?sig=backup`;
  const FILE_BYTES = 8 * 1024 * 1024;

  const requests = [];
  const seed = (name) => [...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) & 0xffff, 7);
  const nameOf = (path) => path.slice(path.lastIndexOf("/") + 1);
  const byteAt = (path, offset) => (offset * 7 + seed(nameOf(path))) & 255;
  root.fetch = async function fakeServer(input, init = {}) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") || "");
    requests.push({ host: url.hostname, path: url.pathname });
    if (init.signal?.aborted) throw init.signal.reason;
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (!range) return new Response("range expected", { status: 400 });
    const from = Number(range[1]), to = Number(range[2]);
    const bytes = new Uint8Array(to - from + 1);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = byteAt(url.pathname, from + index);
    return new Response(bytes, { status: 206, headers: { "Content-Range": `bytes ${from}-${to}/${FILE_BYTES}`, "Content-Length": String(bytes.length) } });
  };

  const video = document.querySelector("video");
  const dash = { getVideoElement: () => video, on() {}, off() {}, getQualityFor: () => 0 };
  const wrapper = { getCorePlayer: () => dash, fire() {}, getQualityChangedData: (event) => event };
  root.player = { __core: () => wrapper, getQuality: () => ({ nowQ: 80, newQ: 80, realQ: 80 }) };

  const result = document.getElementById("compat-cache-result");
  const output = { steps: {} };
  const finish = () => {
    output.pass = Object.values(output.steps).length >= 11 && Object.values(output.steps).every(Boolean);
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  };
  const right = (bytes, path, from, to) => bytes.length === to - from + 1 && bytes.every((value, index) => value === byteAt(path, from + index));
  // As Bilibili's XHRLoader asks: an arraybuffer XHR with a Range header.
  const askXhr = (url, from, to) => new Promise((resolve) => {
    const before = requests.length, path = new URL(url).pathname, events = [];
    const xhr = new XMLHttpRequest();
    let sent = 0;
    for (const type of ["loadstart", "progress", "load", "error", "loadend"]) xhr.addEventListener(type, () => events.push(type));
    xhr.addEventListener("readystatechange", () => events.push(`state${xhr.readyState}`));
    xhr.addEventListener("loadend", () => {
      const bytes = xhr.response ? new Uint8Array(xhr.response) : new Uint8Array(0);
      resolve({ ms: performance.now() - sent, status: xhr.status, range: xhr.getResponseHeader("content-range"),
        right: right(bytes, path, from, to), requests: requests.length - before, events });
    });
    xhr.open("GET", url);
    xhr.responseType = "arraybuffer";
    xhr.setRequestHeader("Range", `bytes=${from}-${to}`);
    sent = performance.now();
    xhr.send();
  });
  const askFetch = async (url, from, to) => {
    const before = requests.length, path = new URL(url).pathname;
    const response = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, right: right(bytes, path, from, to), requests: requests.length - before };
  };
  const settings = { enabled: true, takeover: "compat", mode: "mainland", concurrency: 8, autoConcurrency: false };
  const newPlayer = () => root.__BILI_NATIVE_RANGE_PLAYER_FACTORY__.createNativePlayer({
    container: document.querySelector(".bpx-player-container"),
    getSettings: () => settings,
    cdnBans: root.__BILI_CDN_RESOLVER_FACTORY__.createBanList(),
    playinfo: { data: { dash: {
      video: [{ id: 80, baseUrl: VIDEO, backupUrl: [], mimeType: "video/mp4", codecs: "avc1.640032", bandwidth: 3000000 }],
      audio: [{ id: 30280, baseUrl: AUDIO, backupUrl: [AUDIO_BACKUP], mimeType: "audio/mp4", codecs: "mp4a.40.2", bandwidth: 128000 }]
    } } }
  });

  addEventListener("load", async () => {
    try {
      let player = newPlayer();
      const first = await askXhr(VIDEO, 1000000, 2999999);
      output.steps.firstIsDownloaded = first.status === 206 && first.right && first.requests > 1;

      // The player emptied its buffer and asks again: no request, the same bytes and headers,
      // the events of a finished XHR in their order, and in well under 25 ms.
      const again = await askXhr(VIDEO, 1000000, 2999999);
      output.steps.againFromMemory = again.status === 206 && again.right && again.requests === 0
        && again.range === `bytes 1000000-2999999/${FILE_BYTES}`;
      output.steps.xhrEventsInOrder = again.events.join(",") === "state1,loadstart,state2,state3,progress,state4,load,loadend";
      output.steps.answeredAtOnce = again.ms < 10;
      output.again = again;

      output.steps.fetchFromMemory = Object.values(await askFetch(VIDEO, 1000000, 2999999)).join() === "206,true,0";
      output.steps.partFromMemory = Object.values(await askFetch(VIDEO, 1500000, 1600000)).join() === "206,true,0";

      // A range that runs past what is kept is downloaded whole; then both are one.
      const past = await askXhr(VIDEO, 2000000, 3999999);
      output.steps.pastIsDownloaded = past.right && past.requests > 1;
      output.steps.wholeOfTwoFromMemory = Object.values(await askFetch(VIDEO, 1000000, 3999999)).join() === "206,true,0";
      // A gap in the middle: downloaded.
      await askXhr(VIDEO, 5000000, 5999999);
      const gap = await askXhr(VIDEO, 3500000, 5500000);
      output.steps.gapIsDownloaded = gap.right && gap.requests > 1;

      // The same audio file under its backup path.
      await askXhr(AUDIO, 0, 199999);
      const backup = await askXhr(AUDIO_BACKUP, 0, 199999);
      output.steps.otherPathFromMemory = backup.right && backup.requests === 0;

      const debug = player.getDebug();
      output.steps.diagnosticsSayIt = debug.memoryRanges === 5 && debug.memoryBytes > 0
        && debug.timeline.some((entry) => entry.what === "native range from memory");
      output.debug = { memoryRanges: debug.memoryRanges, memoryRangeBytes: debug.memoryRangeBytes, memoryBytes: debug.memoryBytes };

      // Another video: a new player, which starts empty.
      player.destroy();
      player = newPlayer();
      const fresh = await askXhr(VIDEO, 1000000, 2999999);
      output.steps.newPlayerStartsEmpty = fresh.right && fresh.requests > 1;
      player.destroy();
    } catch (error) { output.error = String(error?.stack || error); }
    finish();
  });
})(globalThis);
