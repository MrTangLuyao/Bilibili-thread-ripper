(function installCompatibilityModeTest(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const sourceUrl = new URL(location.href);
  const mode = sourceUrl.searchParams.get("mode") === "a" ? "a" : "b";
  const run = String(sourceUrl.searchParams.get("run") || Date.now()).replace(/\D/g, "").slice(-10);
  const BVID = `BV1compat${run}`;
  const CID = 505;
  const prefix = `btr-compat-test:${mode}:${run}`;
  const loadCount = Number(sessionStorage.getItem(`${prefix}:loads`) || 0) + 1;
  sessionStorage.setItem(`${prefix}:loads`, String(loadCount));
  history.replaceState(null, "", `/video/${BVID}?mode=${mode}&run=${run}`);
  let createCalls = 0;

  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      return {
        enabled: value?.enabled !== false,
        mode: value?.mode || "mainland",
        compatibilityMode: ["a", "b"].includes(value?.compatibilityMode) ? value.compatibilityMode : "off",
        concurrency: 32
      };
    }
  };
  root.__BILI_THREAD_RIPPER_EARLY_MASK__ = { arm() {}, release() {} };
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = {
    createNativePlayer(options) {
      createCalls += 1;
      sessionStorage.setItem(`${prefix}:creates`, String(Number(sessionStorage.getItem(`${prefix}:creates`) || 0) + 1));
      const video = document.querySelector("video");
      setTimeout(() => options.onState?.({ playerState: "ready", quality: "test" }), 10);
      return { applySettings() {}, destroy() {}, video };
    }
  };

  if (mode === "b") {
    root.__INITIAL_STATE__ = { videoData: { bvid: BVID, cid: CID, pages: [{ cid: CID }] } };
    root.__playinfo__ = { data: { dash: { duration: 100, video: [], audio: [] }, marker: "compat-b" } };
  }

  root.fetch = async (input) => {
    const url = new URL(String(input), location.href);
    if (url.origin !== "https://api.bilibili.com") return new Response("not found", { status: 404 });
    if (mode === "a" && !sessionStorage.getItem(`${prefix}:failed-once`)) {
      sessionStorage.setItem(`${prefix}:failed-once`, "true");
      return new Response("not found", { status: 404 });
    }
    if (url.pathname === "/x/web-interface/view") {
      return new Response(JSON.stringify({ code: 0, data: { aid: 1, bvid: BVID, cid: CID, pages: [{ cid: CID }] } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/x/player/playurl") {
      return new Response(JSON.stringify({ code: 0, data: { dash: { duration: 100, video: [], audio: [] }, marker: `compat-${mode}` } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = document.getElementById("compatibility-result");
  setInterval(() => {
    const stats = root.__biliThreadRipperDebug?.getStats?.() || {};
    const reloadState = JSON.parse(sessionStorage.getItem("__btrCompatibilityReloadV1") || "null");
    const totalCreateCalls = Number(sessionStorage.getItem(`${prefix}:creates`) || 0);
    const output = { mode, loadCount, createCalls, totalCreateCalls, playerState: stats.playerState || "", reloadState, version: stats.version || "" };
    output.pass = output.version === "0.9.1.0"
      && output.loadCount === 2
      && output.createCalls === 1
      && output.totalCreateCalls === 1
      && output.playerState === "ready"
      && output.reloadState?.route === `${BVID.toLowerCase()}:p1`
      && (mode !== "b" || output.reloadState?.preflightDone === true)
      && (mode !== "a" || sessionStorage.getItem(`${prefix}:failed-once`) === "true");
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  }, 50);
  setTimeout(() => root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", compatibilityMode: mode, concurrency: 32 } }, "*"), 0);
})(globalThis);
