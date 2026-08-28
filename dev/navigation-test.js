(function installNavigationTest(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const OLD_BVID = "BV1oldRoute01";
  const NEW_BVID = "BV1newRoute02";
  const calls = [];
  const nativeVideo = document.querySelector("video");

  history.replaceState(null, "", `/video/${OLD_BVID}`);
  root.__INITIAL_STATE__ = { videoData: { bvid: OLD_BVID, cid: 101 } };
  root.__playinfo__ = { data: { dash: { duration: 100, video: [], audio: [] }, marker: OLD_BVID } };
  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      return { enabled: value?.enabled !== false, mode: value?.mode || "mainland", concurrency: 32 };
    }
  };
  root.__BILI_THREAD_RIPPER_EARLY_MASK__ = { arm() {}, release() {} };
  root.__BILI_MSE_PLAYER_FACTORY__ = {
    createPlayer(options) {
      const marker = options.playinfo?.data?.marker || "";
      const record = { destroyed: false, marker, resumeNative: null, route: location.pathname };
      calls.push(record);
      return {
        applySettings() {},
        destroy({ resumeNative }) {
          record.destroyed = true;
          record.resumeNative = resumeNative;
        },
        video: nativeVideo
      };
    }
  };

  root.fetch = async function fakeFetch(input) {
    const url = new URL(String(input), location.href);
    const bvid = url.searchParams.get("bvid") || "";
    if (url.pathname === "/x/web-interface/view") {
      return new Response(JSON.stringify({ code: 0, data: { aid: 202, bvid, cid: 202, pages: [{ cid: 202 }] } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.pathname === "/x/player/playurl") {
      return new Response(JSON.stringify({ code: 0, data: { dash: { duration: 200, video: [], audio: [] }, marker: bvid } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  root.__navigationTest = { calls, OLD_BVID, NEW_BVID };
  const result = document.getElementById("navigation-result");
  setInterval(() => {
    result.textContent = JSON.stringify({ calls, debugVersion: root.__biliThreadRipperDebug?.version || "", href: location.href });
  }, 50);
  setTimeout(() => {
    root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 32 } }, "*");
  }, 0);
  const switchTimer = setInterval(() => {
    if (!calls.some((item) => item.marker === OLD_BVID)) return;
    clearInterval(switchTimer);
    history.pushState(null, "", `/video/${NEW_BVID}`);
  }, 25);
})(globalThis);
