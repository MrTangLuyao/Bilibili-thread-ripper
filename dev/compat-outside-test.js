(function installCompatOutsideTest(root) {
  "use strict";

  // The compatibility mode with the real native-range-transport.js, cdn-resolver.js and
  // idm-downloader.js, against a fake video server (#71). Bilibili's player asks for its
  // files itself; BTR downloads those requests over several servers. It used to do so only
  // for the files listed in the playinfo it holds. Another script can hand the player a
  // playinfo of its own, with a quality BTR never saw: those requests were left alone, so
  // the video came in at the player's own pace while the audio next to it was sped up.
  //
  // What is checked: a file of the same video that the playinfo does not list is sped up
  // too; a file of another video is not BTR's business; and a file the other servers refuse
  // is left to Bilibili after the first failure instead of failing for good.
  const CID = "900000011";
  const DIR = `/upgcxcode/11/22/${CID}/`;
  const LISTED_VIDEO = `https://upos-sz-mirrorali.bilivideo.com${DIR}${CID}-1-100026.m4s?sig=listed`;
  const LISTED_AUDIO = `https://upos-sz-mirrorali.bilivideo.com${DIR}${CID}-1-30280.m4s?sig=listed`;
  // Handed to the player by someone else: the same video, a quality the playinfo lacks.
  const OUTSIDE_VIDEO = `https://upos-sz-mirrorcos.bilivideo.com${DIR}${CID}_x2-1-100029.m4s?sig=outside`;
  // The same, but only the server it names has it.
  const REFUSED_VIDEO = `https://upos-hz-mirrorakam.akamaized.net${DIR}${CID}-1-100030.m4s?sig=refused`;
  // The same again, asked for while no server can be reached.
  const OUTAGE_VIDEO = `https://upos-sz-mirrorcos.bilivideo.com${DIR}${CID}-1-100031.m4s?sig=outage`;
  let outage = false;
  // Another video on the page (a preview, an advertisement).
  const OTHER_VIDEO = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/33/44/900000099/900000099-1-100029.m4s?sig=other";
  const FILE_BYTES = 8 * 1024 * 1024;

  // The fake server: every Bilibili video server has every file, except the refused one,
  // which only its own server has. A byte's value follows from its place and its file.
  const requests = [];
  const seed = (path) => [...path].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) & 0xffff, 7);
  const byteAt = (path, offset) => (offset * 7 + seed(path)) & 255;
  root.fetch = async function fakeServer(input, init = {}) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") || "");
    requests.push({ host: url.hostname, path: url.pathname, from: range ? Number(range[1]) : 0, to: range ? Number(range[2]) : 0 });
    if (init.signal?.aborted) throw init.signal.reason;
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (!range) return new Response("range expected", { status: 400 });
    if (outage && url.pathname.includes("-1-100031.m4s")) throw new TypeError("Failed to fetch");
    if (url.pathname.includes("-1-100030.m4s") && url.hostname !== new URL(REFUSED_VIDEO).hostname) return new Response("", { status: 403 });
    const from = Number(range[1]), to = Number(range[2]);
    const bytes = new Uint8Array(to - from + 1);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = byteAt(url.pathname, from + index);
    return new Response(bytes, { status: 206, headers: { "Content-Range": `bytes ${from}-${to}/${FILE_BYTES}`, "Content-Length": String(bytes.length) } });
  };

  // Bilibili's player and its core, as far as the compatibility mode looks at them.
  const video = document.querySelector("video");
  const dash = { getVideoElement: () => video, on() {}, off() {}, getQualityFor: () => 0 };
  const wrapper = { getCorePlayer: () => dash, fire() {}, getQualityChangedData: (event) => event };
  root.player = { __core: () => wrapper, getQuality: () => ({ nowQ: 80, newQ: 80, realQ: 80 }) };

  const result = document.getElementById("compat-outside-result");
  const output = { steps: {} };
  const finish = () => {
    output.pass = Object.values(output.steps).length >= 6 && Object.values(output.steps).every(Boolean);
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  };
  // Asks as Bilibili's loader does, and says how the answer was put together.
  const ask = async (url, from, to) => {
    const before = requests.length;
    const path = new URL(url).pathname;
    let status = 0, right = false, failed = "";
    try {
      const response = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } });
      status = response.status;
      const bytes = new Uint8Array(await response.arrayBuffer());
      right = bytes.length === to - from + 1 && bytes.every((value, index) => value === byteAt(path, from + index));
    } catch (error) { failed = String(error?.message || error); }
    const made = requests.slice(before).filter((request) => request.path === path);
    return { status, right, failed, requests: made.length, hosts: [...new Set(made.map((request) => request.host))] };
  };

  addEventListener("load", async () => {
    try {
      const factory = root.__BILI_NATIVE_RANGE_PLAYER_FACTORY__;
      const settings = { enabled: true, takeover: "compat", mode: "mainland", concurrency: 8, autoConcurrency: false };
      const player = factory.createNativePlayer({
        container: document.querySelector(".bpx-player-container"),
        getSettings: () => settings,
        cdnBans: root.__BILI_CDN_RESOLVER_FACTORY__.createBanList(),
        playinfo: { data: { dash: {
          video: [{ id: 80, baseUrl: LISTED_VIDEO, backupUrl: [], mimeType: "video/mp4", codecs: "av01.0.08M.08", bandwidth: 2000000 }],
          audio: [{ id: 30280, baseUrl: LISTED_AUDIO, backupUrl: [], mimeType: "audio/mp4", codecs: "mp4a.40.2", bandwidth: 128000 }]
        } } }
      });

      // As before: a file the playinfo lists is downloaded in pieces.
      const listed = await ask(LISTED_VIDEO, 1000000, 2999999);
      output.steps.listedFileIsSpedUp = listed.status === 206 && listed.right && listed.requests > 1;

      // A file of the same video that the playinfo does not list: in pieces as well, over
      // the servers of the list, and the bytes are the right ones.
      const outside = await ask(OUTSIDE_VIDEO, 1000000, 2999999);
      output.steps.outsideFileIsSpedUp = outside.status === 206 && outside.right && outside.requests > 1
        && outside.hosts.some((host) => host !== new URL(OUTSIDE_VIDEO).hostname);
      output.outside = outside;
      // The range that follows it is an ordinary download, like for a listed file.
      const next = await ask(OUTSIDE_VIDEO, 3000000, 4999999);
      output.steps.outsideFileGoesOn = next.status === 206 && next.right && next.requests > 1;

      // Another video's file: one request, to the server it names, untouched.
      const other = await ask(OTHER_VIDEO, 1000000, 2999999);
      output.steps.otherVideoIsLeftAlone = other.status === 206 && other.right && other.requests === 1
        && other.hosts[0] === new URL(OTHER_VIDEO).hostname;

      // A file only its own server has: the first request fails (Bilibili's player asks
      // again), and from then on the file is left to Bilibili. The servers that refused it
      // go on serving the listed files.
      const refused = await ask(REFUSED_VIDEO, 1000000, 2999999);
      // And it fails after a handful of refusals, not after every server was asked for every piece.
      output.steps.refusedFileFailsOnce = Boolean(refused.failed) && refused.requests > 1 && refused.requests <= 40;
      const again = await ask(REFUSED_VIDEO, 1000000, 2999999);
      output.steps.refusedFileIsLeftToBilibili = again.status === 206 && again.right && again.requests === 1
        && again.hosts[0] === new URL(REFUSED_VIDEO).hostname;
      output.refused = { first: refused, again };
      const after = await ask(LISTED_VIDEO, 3000000, 4999999);
      output.steps.listedFileUnharmed = after.status === 206 && after.right && after.requests > 1;

      // A download that fails because the network is down is not a refusal: the next
      // request for the file is sped up again.
      outage = true;
      const down = await ask(OUTAGE_VIDEO, 1000000, 2999999);
      outage = false;
      const back = await ask(OUTAGE_VIDEO, 1000000, 2999999);
      output.steps.outsideFileSurvivesAnOutage = Boolean(down.failed) && back.status === 206 && back.right && back.requests > 1;
      output.outage = { down, back };

      // 音频加速 switched off: the audio is the player's own request again, one request to the
      // server it names, while the video is still fetched in pieces. Switched on, as before.
      settings.audioAcceleration = false;
      const plainAudio = await ask(LISTED_AUDIO, 0, 199999);
      const videoBeside = await ask(LISTED_VIDEO, 5000000, 6999999);
      output.steps.audioOffIsLeftToBilibili = plainAudio.status === 206 && plainAudio.right && plainAudio.requests === 1
        && plainAudio.hosts[0] === new URL(LISTED_AUDIO).hostname;
      output.steps.videoStillSpedUp = videoBeside.status === 206 && videoBeside.right && videoBeside.requests > 1;
      settings.audioAcceleration = true;
      const fastAudio = await ask(LISTED_AUDIO, 200000, 399999);
      output.steps.audioOnIsSpedUp = fastAudio.status === 206 && fastAudio.right && fastAudio.requests > 1;
      output.audio = { plainAudio, fastAudio };

      const debug = player.getDebug();
      output.steps.diagnosticsSayIt = debug.filesOutsidePlayinfo === 3
        && debug.timeline.some((entry) => entry.what === "file outside the playinfo")
        && debug.timeline.some((entry) => entry.what === "file outside the playinfo left to Bilibili");
      player.destroy();
    } catch (error) { output.error = String(error?.stack || error); }
    finish();
  });
})(globalThis);
