// An address can name the video by its av number: Bilibili Evolved's 网址AV号转换 rewrites the
// BV address while the video plays; bilibili-cleaner's BV号转AV号 and old links open it so
// (?direct). It is the same video:
// - rewritten while playing, the takeover goes on: no new player, nothing asked for again;
// - opened at the av address, the playinfo in the page is used;
// - Bilibili's own playurl answers (they name both numbers) are followed, a request with only
//   the av number (Evolved's download panel asking for another quality) is not.
(function installAvAddressTest(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const BVID = "BV17x411w7KC";
  const AID = 170001;
  const CID = 101;
  const ROUTE = `${BVID.toLowerCase()}:p1`;
  const direct = new URLSearchParams(location.search).has("direct");
  const calls = [];
  const apiRequests = [];
  const nativeVideo = document.querySelector("video");

  history.replaceState(null, "", direct ? `/video/av${AID}/` : `/video/${BVID}/`);
  root.__INITIAL_STATE__ = { aid: AID, bvid: BVID, videoData: { aid: AID, bvid: BVID, cid: CID, pages: [{ cid: CID }] } };
  root.__playinfo__ = { data: { dash: { duration: 100, video: [], audio: [] }, marker: "embedded" } };
  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      return { enabled: value?.enabled !== false, mode: value?.mode || "mainland", concurrency: 32 };
    }
  };
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = {
    createNativePlayer(options) {
      const record = { route: options.identity?.key, bvid: options.identity?.bvid, marker: options.playinfo?.data?.marker || "", updates: [], destroyed: false };
      calls.push(record);
      return {
        applySettings() {},
        async updatePlayinfo(playinfo) { record.updates.push(playinfo?.data?.marker || ""); },
        destroy() { record.destroyed = true; },
        video: nativeVideo
      };
    }
  };

  root.fetch = async function fakeFetch(input) {
    const url = new URL(String(input), location.href);
    if (url.pathname === "/x/web-interface/view") {
      apiRequests.push(url.href);
      return new Response(JSON.stringify({ code: 0, data: { aid: AID, bvid: BVID, cid: CID, pages: [{ cid: CID }] } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (/\/x\/player\/(?:wbi\/)?playurl/.test(url.pathname)) {
      apiRequests.push(url.href);
      const marker = url.searchParams.get("marker") || "btr";
      return new Response(JSON.stringify({ code: 0, data: { dash: { duration: 100, video: [], audio: [] }, marker } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  // BTR's own requests: the page's are sent below and carry a marker.
  const ownRequests = () => apiRequests.filter((url) => !new URL(url).searchParams.has("marker")).length;
  const player = () => calls[0];
  const steps = [];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (check, label, ms = 5000) => {
    const started = Date.now();
    while (!check() && Date.now() - started < ms) await sleep(25);
    steps.push({ label, ok: Boolean(check()), calls: calls.length, route: player()?.route, ownRequests: ownRequests(), updates: player()?.updates.slice() });
  };

  const result = document.getElementById("av-address-result");
  const report = (done) => {
    const output = { direct, steps, calls, apiRequests, href: location.href, done };
    output.pass = done && steps.length === (direct ? 3 : 4) && steps.every((step) => step.ok);
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  };
  const interval = setInterval(() => report(false), 50);

  document.addEventListener("DOMContentLoaded", () => root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 32 } }, "*"), { once: true });
  (async () => {
    await waitFor(() => calls.length === 1 && player().route === ROUTE && player().bvid === BVID && player().marker === "embedded" && ownRequests() === 0,
      direct ? "opened at the av address: the playinfo in the page" : "taken over from the playinfo in the page");
    if (!direct) {
      // Evolved keeps the history state and the query when it rewrites the address.
      history.replaceState(history.state, "", `/video/av${AID}/${location.search}`);
      await sleep(1500);
      await waitFor(() => calls.length === 1 && !player().destroyed && player().route === ROUTE && ownRequests() === 0,
        "rewritten to the av address: the same player goes on", 0);
    }
    await root.fetch(`https://api.bilibili.com/x/player/wbi/playurl?avid=${AID}&bvid=${BVID}&cid=${CID}&qn=0&fnval=4048&marker=bilibili`);
    await waitFor(() => player().updates.includes("bilibili"), "Bilibili's own answer is followed");
    await root.fetch(`https://api.bilibili.com/x/player/playurl?avid=${AID}&cid=${CID}&qn=16&fnval=4048&fourk=1&marker=download-panel`);
    await sleep(400);
    await waitFor(() => !player().updates.includes("download-panel") && calls.length === 1 && !player().destroyed,
      "a request with only the av number is left alone", 0);
    clearInterval(interval);
    report(true);
  })();
})(globalThis);
