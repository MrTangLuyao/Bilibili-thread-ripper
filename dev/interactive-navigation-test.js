// Issue #34: an interactive video (互动视频) plays its branches as other CIDs under the same
// BVID and address. The player asks for the next branches ahead of time; when it switches,
// the takeover must follow it to the new branch instead of playing the first one again.
// ?av: the address names the video by its av number (bilibili-cleaner's BV号转AV号).
(function installInteractiveNavigationTest(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const avAddress = new URLSearchParams(location.search).has("av");
  const BVID = avAddress ? "BV17x411w7KC" : "BV1steinGate1";
  const AID = avAddress ? 170001 : 7;
  const FIRST = 101;
  const calls = [];
  const apiRequests = [];
  const nativeVideo = document.querySelector("video");
  let branch = FIRST;

  history.replaceState(null, "", avAddress ? `/video/av${AID}/` : `/video/${BVID}/`);
  root.__INITIAL_STATE__ = {
    videoData: { bvid: BVID, aid: AID, cid: FIRST, pages: [{ cid: FIRST }], rights: { is_stein_gate: 1 } }
  };
  root.__playinfo__ = { data: { dash: { duration: 6, video: [], audio: [] }, marker: `n${FIRST}` } };
  // Bilibili's player names the branch that is on.
  root.player = { getManifest: () => ({ bvid: BVID, aid: AID, cid: branch, p: 1 }) };
  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      return { enabled: value?.enabled !== false, mode: value?.mode || "mainland", concurrency: 32 };
    }
  };
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = {
    createNativePlayer(options) {
      const record = { route: options.identity.key, marker: options.playinfo?.data?.marker || "", updates: [], destroyed: false, options };
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
      return new Response(JSON.stringify({ code: 0, data: { aid: AID, bvid: BVID, cid: FIRST, pages: [{ cid: FIRST }] } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (/\/x\/player\/(?:wbi\/)?playurl/.test(url.pathname)) {
      apiRequests.push(url.href);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const cid = Number(url.searchParams.get("cid"));
      return new Response(JSON.stringify({ code: 0, data: { dash: { duration: cid / 10, video: [], audio: [] }, marker: `n${cid}` } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const requestsFor = (cid) => apiRequests.filter((url) => /playurl/.test(url) && new URL(url).searchParams.get("cid") === String(cid)).length;
  const latest = () => calls.at(-1);
  const base = `${BVID.toLowerCase()}:p1`;
  const steps = [];
  // Bilibili installing the next branch's source, as the player reports it.
  const switchTo = (cid) => {
    branch = cid;
    latest()?.options.onNativeSourceChange?.();
  };
  const waitFor = (check, label) => new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (!check() && Date.now() - started < 5000) return;
      clearInterval(timer);
      steps.push({ label, ok: Boolean(check()), route: latest()?.route, marker: latest()?.marker });
      resolve();
    }, 25);
  });

  const result = document.getElementById("interactive-navigation-result");
  const report = (done) => {
    const output = { steps, calls: calls.map(({ route, marker, updates }) => ({ route, marker, updates })), apiRequests, done };
    output.pass = done && steps.length === 5 && steps.every((step) => step.ok);
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  };
  const interval = setInterval(() => report(false), 50);

  document.addEventListener("DOMContentLoaded", () => root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 32 } }, "*"), { once: true });
  (async () => {
    await waitFor(() => latest()?.route === base && latest()?.marker === `n${FIRST}`, "first branch from the embedded playinfo");
    // The player fetches two of the next branches while the first one plays.
    await root.fetch(`https://api.bilibili.com/x/player/wbi/playurl?avid=${AID}&bvid=${BVID}&cid=202`);
    await root.fetch(`https://api.bilibili.com/x/player/wbi/playurl?avid=${AID}&bvid=${BVID}&cid=303`);
    await waitFor(() => latest()?.route === base && latest().updates.length === 0 && calls.length === 1, "branches fetched ahead are not swapped into the one playing");
    switchTo(202);
    await waitFor(() => latest()?.route === `${base}:n202` && latest().marker === "n202" && requestsFor(202) === 1, "next branch from what the player fetched ahead");
    switchTo(404);
    await waitFor(() => latest()?.route === `${base}:n404` && latest().marker === "n404" && requestsFor(404) === 1 && !apiRequests.some((url) => url.includes("/x/web-interface/view")), "branch nobody fetched yet: asked for by its own CID");
    switchTo(FIRST);
    await waitFor(() => latest()?.route === base && latest().marker === `n${FIRST}`, "back to the first branch");
    clearInterval(interval);
    report(true);
  })();
})(globalThis);
