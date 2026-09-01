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
  root.__BILI_THREAD_RIPPER_EARLY_MASK__ = { arm() {}, release() {} };
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
  root.addEventListener("message", (event) => {
    if (event.source !== root || event.data?.channel !== CHANNEL || event.data.type !== "stats") return;
    const stats = event.data.payload || {};
    const output = {
      version: stats.version || "",
      playerState: stats.playerState || "",
      takeoverError: stats.takeoverError || null,
      requests
    };
    output.pass = output.version === "0.9.1.0"
      && output.playerState === "error"
      && output.takeoverError?.stage === "playinfo"
      && /HTTP 404/.test(output.takeoverError?.message || "")
      && requests.length > 0
      && requests.every((url) => new URL(url).origin === "https://api.bilibili.com");
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  });
  setTimeout(() => root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 32 } }, "*"), 0);
})(globalThis);
