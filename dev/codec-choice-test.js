(function installCodecChoiceTest(root) {
  "use strict";

  // The codec picked in the player's 播放策略 menu decides which representation plays; "默认"
  // keeps AV1 > HEVC > AVC. A quality without the picked codec falls back to that order.
  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const BVID = "BV1codecTest1";
  const select = root.__BILI_NATIVE_MSE_PLAYER_FACTORY__.selectRepresentations;
  const representation = (id, codecs, bandwidth) => ({
    id, codecs, bandwidth, width: id === 80 ? 1920 : 1280, height: id === 80 ? 1080 : 720, frameRate: "30", mimeType: "video/mp4",
    baseUrl: `https://upos-sz-mirrorali.bilivideo.com/upgcxcode/${id}-${codecs.slice(0, 4)}.m4s`, segment_base: { initialization: "0-999", index_range: "1000-1999" }
  });
  const playinfo = (quality) => ({ data: { quality, dash: { duration: 10, video: [
    representation(80, "avc1.640032", 3000000), representation(80, "hev1.1.6.L120.90", 2000000), representation(80, "av01.0.08M.08", 1500000),
    representation(64, "avc1.640028", 1500000), representation(64, "hev1.1.6.L120.90", 1000000)
  ], audio: [{ id: 30280, codecs: "mp4a.40.2", bandwidth: 200000, mimeType: "audio/mp4", baseUrl: "https://upos-sz-mirrorali.bilivideo.com/upgcxcode/a.m4s" }] } } });
  const picked = (quality, codec) => ({ av01: "av1", hev1: "hevc", avc1: "avc" })[String(select(playinfo(quality), quality, codec).preferred.codecs).slice(0, 4)];
  const selection = {
    defaultOrder: picked(80, "") === "av1" && picked(64, "") === "hevc",
    hevcPicked: picked(80, "hevc") === "hevc" && picked(64, "hevc") === "hevc",
    avcPicked: picked(80, "avc") === "avc" && picked(64, "avc") === "avc",
    av1FallsBack: picked(80, "av1") === "av1" && picked(64, "av1") === "hevc",
    unknownIsDefault: picked(80, "vp9") === "av1"
  };

  // The page reads the menu's choice when it takes over, and follows it when it changes.
  const created = [];
  const codecCalls = [];
  history.replaceState(null, "", `/video/${BVID}`);
  root.__INITIAL_STATE__ = { videoData: { bvid: BVID, cid: 101 } };
  root.__playinfo__ = { data: { dash: { duration: 100, video: [], audio: [] } } };
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = {
    createNativePlayer(options) {
      created.push(options.preferredCodec);
      return {
        applySettings() {},
        async setQuality() {},
        async setCodec(codec) { codecCalls.push(codec); },
        async updatePlayinfo() {},
        destroy() {},
        video: options.container.querySelector("video")
      };
    }
  };
  root.fetch = async function fakeFetch(input) {
    throw new Error(`unexpected request: ${input}`);
  };

  const result = document.getElementById("codec-choice-result");
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (test, timeout = 5000) => { const startedAt = performance.now(); while (!test() && performance.now() - startedAt < timeout) await wait(25); };
  document.addEventListener("DOMContentLoaded", () => {
    root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 8 } }, "*");
  }, { once: true });

  (async () => {
    await waitFor(() => created.length >= 1);
    localStorage.setItem("bilibili_player_codec_prefer_type", "1");
    document.querySelector(".bpx-player-ctrl-setting-codec").click();
    await waitFor(() => codecCalls.length >= 1);
    localStorage.setItem("bilibili_player_codec_prefer_type", "0");
    // Set by some other way than the menu: the once-a-second check picks it up.
    await waitFor(() => codecCalls.length >= 2);
    await wait(1200);
    const output = {
      created,
      codecCalls,
      checks: {
        ...selection,
        startsWithMenuChoice: created[0] === "avc" && created.length === 1,
        followsMenuClick: codecCalls[0] === "hevc",
        followsDefault: codecCalls[1] === "" && codecCalls.length === 2
      }
    };
    output.pass = Object.values(output.checks).every(Boolean) && root.__biliThreadRipperDebug?.version === "0.9.4.3";
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  })();
})(globalThis);
