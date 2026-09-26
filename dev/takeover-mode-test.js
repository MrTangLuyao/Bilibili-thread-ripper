(function installTakeoverModeTest(root) {
  "use strict";

  // "全接管" replaces Bilibili's playback core; "兼容模式" leaves it in charge and only
  // downloads for it. The page picks the engine from the setting, waits briefly for the
  // native core in the compatibility mode, and falls back to full takeover without it.
  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const BVID = "BV1takeover01";
  const created = [];
  let nativeCoreReady = false;
  const fakePlayer = (engine, options) => {
    created.push({ engine, at: performance.now() });
    return {
      nativeTransport: engine === "compat",
      transportActive: engine === "compat",
      applySettings() {},
      async setQuality() {},
      async setCodec() {},
      async updatePlayinfo() {},
      destroy() {},
      getDebug: () => ({ architecture: engine }),
      video: options.container.querySelector("video")
    };
  };

  history.replaceState(null, "", `/video/${BVID}`);
  root.__INITIAL_STATE__ = { videoData: { bvid: BVID, cid: 101 } };
  root.__playinfo__ = { data: { dash: { duration: 100, video: [], audio: [] } } };
  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      return { enabled: value?.enabled !== false, takeover: value?.takeover === "compat" ? "compat" : "full", mode: "mainland", customHosts: [], concurrency: 8 };
    }
  };
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = { createNativePlayer: (options) => fakePlayer("full", options) };
  root.__BILI_NATIVE_RANGE_PLAYER_FACTORY__ = {
    supports: () => nativeCoreReady,
    createNativePlayer: (options) => fakePlayer("compat", options)
  };
  root.fetch = async function fakeFetch(input) {
    throw new Error(`unexpected request: ${input}`);
  };

  const result = document.getElementById("takeover-mode-result");
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (test, timeout = 6000) => { const startedAt = performance.now(); while (!test() && performance.now() - startedAt < timeout) await wait(25); };
  const settings = (payload) => root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 8, ...payload } }, "*");
  document.addEventListener("DOMContentLoaded", () => settings({ takeover: "full" }), { once: true });

  (async () => {
    await waitFor(() => created.length >= 1);
    const first = created[0];
    // Switching to the compatibility mode restarts the video with the other engine once
    // Bilibili's core is there.
    const switchedAt = performance.now();
    settings({ takeover: "compat" });
    await wait(700);
    const beforeCore = created.length;
    nativeCoreReady = true;
    await waitFor(() => created.length >= 2);
    const second = created[1];
    // Back to full takeover: the MSE engine again, at once.
    settings({ takeover: "full" });
    await waitFor(() => created.length >= 3);
    const third = created[2];
    // Without Bilibili's core the compatibility mode gives up after about 3 seconds and
    // takes the video over fully.
    nativeCoreReady = false;
    settings({ takeover: "compat" });
    const fallbackAskedAt = performance.now();
    await waitFor(() => created.length >= 4, 8000);
    const fourth = created[3];
    const output = {
      created: created.map((item) => item.engine),
      architecture: root.__biliThreadRipperDebug.getStats().architecture,
      checks: {
        startsFull: first?.engine === "full",
        waitsForNativeCore: beforeCore === 1,
        compatOnceCoreReady: second?.engine === "compat" && second.at > switchedAt,
        backToFull: third?.engine === "full",
        fallsBackWithoutCore: fourth?.engine === "full" && fourth.at - fallbackAskedAt >= 2500 && fourth.at - fallbackAskedAt < 7000,
        architectureFollowsEngine: root.__biliThreadRipperDebug.getStats().architecture === "bilibili-native-ui-progressive-mse-0.8-core"
      }
    };
    output.pass = Object.values(output.checks).every(Boolean) && root.__biliThreadRipperDebug?.version === "__BTR_VERSION__";
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  })();
})(globalThis);
