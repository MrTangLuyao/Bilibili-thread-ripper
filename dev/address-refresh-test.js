(function installAddressRefreshTest(root) {
  "use strict";

  // The page hook asks Bilibili for new download addresses shortly before the playing ones
  // expire. This drives the real page-hook.js with a fake player and a fake Bilibili API:
  // one request at a time, given up after its timeout, longer pauses after failures, and
  // nothing of an old video reaches the player of the next one.
  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const FIRST = "BV1refresh001";
  const NEXT = "BV1refresh002";
  const realNow = Date.now.bind(Date);
  let clockOffset = 0;
  Date.now = () => realNow() + clockOffset;
  // The hook gives a request fifteen seconds; the test does not wait that long.
  const realSetTimeout = root.setTimeout.bind(root);
  root.setTimeout = (callback, delay, ...rest) => realSetTimeout(callback, delay === 15000 ? 400 : delay, ...rest);

  const players = [];
  const requests = [];
  let apiMode = "ok";

  history.replaceState(null, "", `/video/${FIRST}`);
  root.__INITIAL_STATE__ = { videoData: { bvid: FIRST, cid: 101 } };
  root.__playinfo__ = { data: { dash: { duration: 100, video: [], audio: [] }, marker: "embedded" } };
  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      return { enabled: value?.enabled !== false, mode: value?.mode || "mainland", customHosts: [], concurrency: 32 };
    }
  };
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = {
    createNativePlayer(options) {
      const record = { route: location.pathname, deadline: realNow() / 1000 + 7200, updates: [], destroyed: false };
      players.push(record);
      return {
        applySettings() {},
        async setQuality() {},
        async updatePlayinfo(playinfo) {
          record.updates.push(playinfo?.data?.marker || "");
          if (playinfo?.data?.deadline) record.deadline = playinfo.data.deadline;
        },
        urlDeadlineSeconds: () => record.deadline,
        destroy() { record.destroyed = true; },
        video: { isConnected: true, paused: false }
      };
    }
  };
  root.fetch = function fakeFetch(input, init = {}) {
    const url = new URL(String(input), location.href);
    const request = { path: url.pathname, bvid: url.searchParams.get("bvid") || "", mode: apiMode, aborted: false };
    requests.push(request);
    init.signal?.addEventListener("abort", () => { request.aborted = true; }, { once: true });
    const json = (data) => new Response(JSON.stringify({ code: 0, data }), { status: 200, headers: { "content-type": "application/json" } });
    const cid = request.bvid === NEXT ? 202 : 101;
    if (url.pathname === "/x/web-interface/view") return Promise.resolve(json({ aid: cid, bvid: request.bvid, cid, pages: [{ cid }] }));
    if (url.pathname !== "/x/player/playurl") return Promise.reject(new Error(`unexpected request: ${url}`));
    const answer = () => json({ dash: { duration: 100, video: [], audio: [] }, marker: `fresh-${requests.length}`, deadline: Date.now() / 1000 + 7200 });
    const canceled = () => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal.reason || new DOMException("aborted", "AbortError")), { once: true });
    });
    if (request.mode === "hang") return canceled();
    if (request.mode === "slow") return Promise.race([canceled(), new Promise((resolve) => realSetTimeout(() => resolve(answer()), 1500))]);
    return Promise.resolve(answer());
  };

  const result = document.getElementById("address-refresh-result");
  const wait = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));
  const until = async (condition, ms) => {
    const end = performance.now() + ms;
    while (performance.now() < end && !condition()) await wait(25);
    return Boolean(condition());
  };
  const playurl = () => requests.filter((item) => item.path === "/x/player/playurl");
  // The page events of the diagnostic copy: how many of one kind there were.
  const pageEvents = () => JSON.parse(root.__biliThreadRipperDebug.report()).page;
  const recorded = (what) => pageEvents().filter((event) => event.what === what).reduce((sum, event) => sum + (event.count || 1), 0);
  const output = { steps: {} };

  document.addEventListener("DOMContentLoaded", () => {
    root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 32 } }, "*");
  }, { once: true });

  (async () => {
    await until(() => players.length === 1, 5000);
    const first = players[0];
    const steps = output.steps;
    const fetchedAtStart = recorded("playinfo fetched");

    // Addresses that are good for two more hours are left alone.
    await wait(1300);
    steps.leftAloneWhileValid = requests.length === 0;

    // One minute left, and Bilibili does not answer: one request, not one per second, given
    // up after the timeout, and nothing handed to the player.
    apiMode = "hang";
    first.deadline = Date.now() / 1000 + 60;
    await until(() => playurl().length === 1, 3000);
    await wait(2300);
    steps.oneRequestAtATime = playurl().length === 1;
    steps.givenUpAfterTimeout = playurl()[0]?.aborted === true;
    steps.nothingHandedOver = first.updates.length === 0;
    steps.videoInfoNotAskedAgain = !requests.some((item) => item.path === "/x/web-interface/view");

    // After one failure the next try waits 90 seconds.
    clockOffset += 60000;
    await wait(1300);
    steps.waitsLongerAfterFailure = playurl().length === 1;
    apiMode = "ok";
    clockOffset += 31000;
    await until(() => first.updates.length === 1, 3000);
    steps.refreshed = first.updates.length === 1 && playurl().length === 2;
    await wait(1300);
    steps.noRequestOnceRenewed = playurl().length === 2;
    // Recorded as a refresh, not as the address fetch of a takeover.
    steps.recordedAsRefresh = recorded("playinfo refresh") > 0 && recorded("playinfo fetched") === fetchedAtStart;

    // The video changes while a refresh is under way: the request ends there, and the next
    // video's player never sees the old video's addresses.
    apiMode = "slow";
    clockOffset += 46000; // two refreshes of one video are at least 45 seconds apart
    first.deadline = Date.now() / 1000 + 60;
    await until(() => playurl().length === 3, 3000);
    const late = playurl()[2];
    apiMode = "ok";
    root.__INITIAL_STATE__ = { videoData: { bvid: NEXT, cid: 202 } };
    history.pushState(null, "", `/video/${NEXT}`);
    await until(() => players.length === 2, 5000);
    await wait(2000);
    steps.requestEndedWithItsVideo = late?.aborted === true;
    steps.oldPlayerLeftAlone = first.updates.length === 1;
    steps.nextVideoUntouched = players.length === 2 && players[1].updates.length === 0;

    output.requests = requests.map((item) => `${item.path.split("/").at(-1)} ${item.bvid} ${item.mode}${item.aborted ? " aborted" : ""}`);
    output.page = pageEvents().map((event) => event.what);
    output.pass = Object.values(steps).every(Boolean);
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
    result.dataset.done = "true";
  })().catch((error) => {
    result.textContent = JSON.stringify({ pass: false, crashed: String(error?.stack || error), steps: output.steps });
    result.dataset.done = "true";
  });
})(globalThis);
