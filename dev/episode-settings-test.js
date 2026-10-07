(function installEpisodeSettingsTest(root) {
  "use strict";

  // 剧集加速: switched off, an episode page is left alone. Switched on, it is taken over in the
  // compatibility mode only: where that mode cannot hold Bilibili's core the episode stays with
  // Bilibili instead of being taken over in full. Switched off while an episode plays, the
  // episode is handed back.
  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const calls = [];
  let compatAvailable = false;
  const dash = () => ({ duration: 100, video: [], audio: [] });

  history.replaceState(null, "", "/bangumi/play/ep1");
  root.__playinfo__ = {
    code: 0,
    result: {
      video_info: { dash: dash(), marker: "ep1" },
      arc: { cid: 10 },
      supplement: { ogv_episode_info: { episode_id: 1 }, ogv_season_info: { season_id: 9 } }
    }
  };
  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      return { enabled: value?.enabled !== false, episodeEnabled: value?.episodeEnabled !== false, takeover: "full", mode: "mainland", customHosts: [], concurrency: 8 };
    }
  };
  const player = (kind) => (options) => {
    const record = { kind, marker: options.playinfo?.data?.marker || "", epId: options.identity?.epId || 0, destroyed: false, resumeNative: null };
    calls.push(record);
    return {
      nativeTransport: kind === "compat",
      applySettings() {},
      async updatePlayinfo() {},
      destroy(destroyOptions) { record.destroyed = true; record.resumeNative = destroyOptions?.resumeNative ?? null; },
      video: { isConnected: true, paused: false }
    };
  };
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = { createNativePlayer: player("full") };
  root.__BILI_NATIVE_RANGE_PLAYER_FACTORY__ = { supports: () => compatAvailable, createNativePlayer: player("compat") };

  root.fetch = async function fakeFetch(input) {
    const url = new URL(String(input), location.href);
    if (url.pathname === "/pgc/player/web/v2/playurl") {
      const epId = Number(url.searchParams.get("ep_id"));
      return new Response(JSON.stringify({ code: 0, result: { video_info: { dash: dash(), marker: `ep${epId}` } } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const settings = (payload) => root.postMessage({ channel: CHANNEL, type: "settings", payload }, "*");
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const until = async (check, milliseconds) => {
    for (const end = Date.now() + milliseconds; Date.now() < end && !check();) await wait(50);
    return check();
  };
  const state = () => root.__biliThreadRipperDebug?.getStats()?.playerState;
  const result = document.getElementById("episode-settings-result");

  (async () => {
    const output = {};
    if (document.readyState === "loading") await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
    settings({ enabled: true, episodeEnabled: false });
    await wait(1500);
    output.offLeavesEpisodeAlone = calls.length === 0;

    // On, but the compatibility mode cannot reach Bilibili's core: it waits three seconds,
    // then leaves the episode to Bilibili.
    settings({ enabled: true, episodeEnabled: true });
    output.noFullTakeoverFallback = await until(() => state() === "native-fallback", 5000) && calls.length === 0;

    compatAvailable = true;
    history.pushState(null, "", "/bangumi/play/ep2");
    output.compatOnNextEpisode = await until(() => calls.length > 0, 4000) && calls.length === 1 && calls[0].kind === "compat" && calls[0].epId === 2;

    settings({ enabled: true, episodeEnabled: false });
    output.switchedOffHandsBack = await until(() => calls[0]?.destroyed, 2000) && calls[0].resumeNative === true && calls.length === 1;

    output.pass = Object.values(output).every(Boolean);
    output.calls = calls;
    output.playerState = state();
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  })().catch((error) => {
    result.textContent = JSON.stringify({ pass: false, error: String(error?.stack || error), calls });
    result.dataset.pass = "false";
  });
})(globalThis);
