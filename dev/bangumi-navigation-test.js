(function installBangumiNavigationTest(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const calls = [];
  const apiRequests = [];
  let drmSwitchedAt = 0;
  const dash = () => ({ duration: 100, video: [], audio: [] });
  const json = (body, delay = 0) => new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  })), delay));

  // A season address: the episode comes from the playinfo embedded in the page.
  history.replaceState(null, "", "/bangumi/play/ss9");
  root.__playinfo__ = {
    code: 0,
    result: {
      video_info: { dash: dash(), marker: "ep101" },
      arc: { cid: 1001 },
      supplement: { ogv_episode_info: { episode_id: 101 }, ogv_season_info: { season_id: 9 } }
    }
  };
  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      return { enabled: value?.enabled !== false, mode: value?.mode || "mainland", concurrency: 32 };
    }
  };
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = {
    createNativePlayer(options) {
      const record = { marker: options.playinfo?.data?.marker || "", identity: options.identity || null, destroyed: false };
      calls.push(record);
      return {
        applySettings() {},
        async updatePlayinfo(playinfo) { record.marker = playinfo?.data?.marker || record.marker; },
        destroy() { record.destroyed = true; },
        video: { isConnected: true, paused: false }
      };
    }
  };

  // The page asks playview for the next episode; the script's own requests go to the v2 playurl.
  root.fetch = async function fakeFetch(input, init) {
    const url = new URL(String(input), location.href);
    apiRequests.push(url.pathname + url.search);
    if (url.pathname === "/ogv/player/playview") {
      const epId = JSON.parse(init.body).video_index.ogv_episode_id;
      return json({ code: 0, data: { video_info: { dash: dash(), marker: `ep${epId}` }, arc: { cid: epId * 10 } } }, epId === 101 ? 600 : 200);
    }
    if (url.pathname === "/pgc/player/web/v2/playurl") {
      const epId = Number(url.searchParams.get("ep_id"));
      return json({ code: 0, result: { video_info: { dash: dash(), marker: `ep${epId}-own`, is_drm: epId === 303 } } }, epId === 303 ? 0 : 1500);
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const playview = (epId) => root.fetch(`https://api.bilibili.com/ogv/player/playview?csrf=test`, {
    method: "POST",
    credentials: "include",
    body: JSON.stringify({ video_index: { ogv_season_id: 1, ogv_episode_id: epId } })
  });

  const result = document.getElementById("bangumi-navigation-result");
  setInterval(() => {
    const stats = root.__biliThreadRipperDebug?.getStats() || {};
    const markers = calls.map((item) => item.marker);
    const ep202 = calls.filter((item) => item.marker.startsWith("ep202"));
    const output = {
      calls,
      apiRequests,
      playerState: stats.playerState,
      bootUsedEmbeddedPlayinfo: markers[0] === "ep101" && !apiRequests.some((url) => url.includes("ep_id=101")),
      staleEpisodeIgnored: markers.filter((marker) => marker.startsWith("ep101")).length === 1,
      switchedByPlayview: ep202.length === 1 && ep202[0].marker === "ep202" && ep202[0].identity?.epId === 202,
      previousReleased: calls.length > 1 && calls.slice(0, -1).every((item) => item.destroyed),
      drmLeftNative: drmSwitchedAt > 0 && Date.now() - drmSwitchedAt > 3000
        && !markers.some((marker) => marker.startsWith("ep303"))
        && apiRequests.filter((url) => url.includes("ep_id=303")).length === 1
        && stats.playerState === "native-fallback"
        && ep202[0]?.destroyed === true
    };
    output.pass = output.bootUsedEmbeddedPlayinfo
      && output.staleEpisodeIgnored
      && output.switchedByPlayview
      && output.previousReleased
      && output.drmLeftNative;
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  }, 50);
  document.addEventListener("DOMContentLoaded", () => {
    root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 32 } }, "*");
  }, { once: true });

  const steps = setInterval(() => {
    if (calls.length === 1 && calls[0].marker === "ep101" && location.pathname.endsWith("ss9")) {
      // A late answer for the episode being left must not come back as the new one.
      playview(101);
      history.pushState(null, "", "/bangumi/play/ep202");
      playview(202);
    } else if (calls.some((item) => item.marker === "ep202") && location.pathname.endsWith("ep202")) {
      clearInterval(steps);
      setTimeout(() => {
        history.pushState(null, "", "/bangumi/play/ep303");
        drmSwitchedAt = Date.now();
      }, 800);
    }
  }, 25);
})(globalThis);
