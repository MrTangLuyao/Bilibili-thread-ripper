(function installTakeoverErrorTest(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const BVID = "BV1errorRoute";
  const requests = [];
  history.replaceState(null, "", `/video/${BVID}`);
  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      return { enabled: value?.enabled !== false, mode: value?.mode || "mainland", concurrency: 32 };
    }
  };
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = { createNativePlayer() { throw new Error("不应创建播放器"); } };
  root.fetch = async (input) => {
    const url = new URL(String(input), location.href);
    requests.push(url.href);
    if (url.origin === "https://api.bilibili.com" && url.pathname === "/x/web-interface/view") {
      return new Response("not found", { status: 404 });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = document.getElementById("takeover-error-result");
  // A request that keeps failing is asked again after a growing pause (0.7, 1.4, 2.8, 5.6 s…),
  // not once a second: at most four requests in the first six and a half seconds.
  let requestsInWindow = null;
  let latest = {};
  const render = () => {
    const stats = latest;
    const output = {
      version: stats.version || "",
      playerState: stats.playerState || "",
      takeoverError: stats.takeoverError || null,
      requestsInWindow,
      requests
    };
    output.pass = output.version === "__BTR_VERSION__"
      && output.playerState === "error"
      && output.takeoverError?.stage === "playinfo"
      && /HTTP 404/.test(output.takeoverError?.message || "")
      && requests.length > 0
      && requests.every((url) => new URL(url).origin === "https://api.bilibili.com")
      && requestsInWindow !== null && requestsInWindow >= 2 && requestsInWindow <= 4;
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  };
  root.addEventListener("message", (event) => {
    if (event.source !== root || event.data?.channel !== CHANNEL || event.data.type !== "stats") return;
    latest = event.data.payload || {};
    if (requestsInWindow === null && requests.length === 1) setTimeout(() => { requestsInWindow = requests.length; render(); }, 6500);
    render();
  });
  // The fixture loads before page-hook.js. A zero-delay timer can fire while
  // that external script is still loading and lose the only settings message.
  document.addEventListener("DOMContentLoaded", () => root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 32 } }, "*"), { once: true });
})(globalThis);
