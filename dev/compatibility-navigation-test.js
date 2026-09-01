(function installCompatibilityNavigationTest(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const ROUTE_A = "BV1compatNavA";
  const ROUTE_B = "BV1compatNavB";
  const run = String(Date.now());
  const loadKey = `btr-compat-navigation:${run}`;
  const result = document.getElementById("compatibility-navigation-result");
  const calls = [];
  const fetchCalls = [];
  let normalizeCalls = 0;
  let failedFirstRequest = false;
  let switched = false;

  sessionStorage.setItem(loadKey, String(Number(sessionStorage.getItem(loadKey) || 0) + 1));
  history.replaceState(null, "", `/video/${ROUTE_A}?compat-nav=${run}`);

  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      normalizeCalls += 1;
      return {
        enabled: value?.enabled !== false,
        mode: value?.mode || "mainland",
        compatibilityMode: value?.compatibilityMode === "a" ? "a" : "off",
        concurrency: 32
      };
    }
  };
  root.__BILI_THREAD_RIPPER_EARLY_MASK__ = { arm() {}, release() {} };
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = {
    createNativePlayer(options) {
      calls.push(options.identity.key);
      const video = document.querySelector("video");
      setTimeout(() => options.onState?.({ playerState: "ready", quality: "test" }), 10);
      return { applySettings() {}, destroy() {}, video };
    }
  };

  root.fetch = async (input) => {
    const url = new URL(String(input), location.href);
    fetchCalls.push(url.href);
    if (url.origin !== "https://api.bilibili.com") return new Response("not found", { status: 404 });
    const bvid = String(url.searchParams.get("bvid") || ROUTE_A);
    if (url.pathname === "/x/web-interface/view" && bvid === ROUTE_A && !failedFirstRequest) {
      failedFirstRequest = true;
      return new Response("not found", { status: 404 });
    }
    const cid = bvid === ROUTE_B ? 202 : 101;
    if (url.pathname === "/x/web-interface/view") {
      return new Response(JSON.stringify({ code: 0, data: { aid: cid, bvid, cid, pages: [{ cid }] } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/x/player/playurl") {
      return new Response(JSON.stringify({ code: 0, data: { dash: { duration: 100, video: [], audio: [] }, marker: bvid } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const switchTimer = setInterval(() => {
    const error = root.__biliThreadRipperDebug?.getStats?.().takeoverError;
    if (switched || !error) return;
    switched = true;
    clearInterval(switchTimer);
    history.pushState(null, "", `/video/${ROUTE_B}?compat-nav=${run}`);
    setTimeout(() => history.pushState(null, "", `/video/${ROUTE_A}?compat-nav=${run}`), 80);
  }, 10);

  setInterval(() => {
    const stats = root.__biliThreadRipperDebug?.getStats?.() || {};
    const output = {
      loadCount: Number(sessionStorage.getItem(loadKey) || 0),
      failedFirstRequest,
      switched,
      normalizeCalls,
      fetchCalls,
      calls,
      route: location.pathname,
      playerState: stats.playerState || "",
      version: stats.version || ""
    };
    output.pass = output.version === "0.9.1.0"
      && output.loadCount === 1
      && output.failedFirstRequest
      && output.switched
      && output.calls.includes(`${ROUTE_B.toLowerCase()}:p1`)
      && output.calls.at(-1) === `${ROUTE_A.toLowerCase()}:p1`
      && output.route === `/video/${ROUTE_A}`
      && output.playerState === "ready";
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  }, 50);

  setTimeout(() => root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", compatibilityMode: "a", concurrency: 32 } }, "*"), 0);
})(globalThis);
