(function installFastTakeoverTest(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const OLD_BVID = "BV1fastOld001";
  const NEW_BVID = "BV1fastNew002";
  const OVERSEAS_HOSTS = ["overseas-a.bilivideo.com", "overseas-b.bilivideo.com"];
  const MAINLAND_HOSTS = ["mainland-a.bilivideo.com"];
  const SLOW_MS = 300;
  const calls = [];
  const ownPlayurlRequests = [];
  const statsMessages = [];
  let nativeAnsweredAt = 0;
  let overseasLinks = null;
  let mainlandLinks = null;
  let burst = null;

  history.replaceState(null, "", `/video/${OLD_BVID}`);
  root.__INITIAL_STATE__ = { videoData: { bvid: OLD_BVID, cid: 101 } };
  root.__playinfo__ = { data: { dash: { duration: 100, video: [], audio: [] }, marker: `page:${OLD_BVID}` } };
  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      return { enabled: value?.enabled !== false, mode: value?.mode || "mainland", compatibilityMode: "off", concurrency: 32 };
    }
  };
  root.__BILI_CDN_RESOLVER_FACTORY__ = { MAINLAND_HOSTS, OVERSEAS_HOSTS, createBanList: () => null };
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = {
    createNativePlayer(options) {
      const record = { at: performance.now(), marker: options.playinfo?.data?.marker || "", onTransfer: options.onTransfer };
      calls.push(record);
      return { applySettings() {}, async updatePlayinfo() {}, destroy() {}, video: { isConnected: true, paused: false } };
    }
  };

  function answer(body, delayMs, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })), delayMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    });
  }

  root.fetch = function fakeFetch(input, init) {
    const url = new URL(String(input), location.href);
    const bvid = url.searchParams.get("bvid") || "";
    if (url.pathname === "/x/web-interface/view") return answer({ code: 0, data: { aid: 303, bvid, cid: 303, pages: [{ cid: 303 }] } }, SLOW_MS, init?.signal);
    if (url.pathname === "/x/player/playurl") {
      ownPlayurlRequests.push(url.href);
      return answer({ code: 0, data: { dash: { duration: 200, video: [], audio: [] }, marker: `own:${bvid}` } }, SLOW_MS, init?.signal);
    }
    if (url.pathname === "/x/player/wbi/playurl") {
      return answer({ code: 0, data: { dash: { duration: 200, video: [], audio: [] }, marker: `native:${bvid}` } }, 30, init?.signal)
        .finally(() => { nativeAnsweredAt = performance.now(); });
    }
    return Promise.reject(new Error(`unexpected request: ${url}`));
  };

  const preconnectLinks = () => Array.from(document.querySelectorAll("link[rel=preconnect][data-btr-preconnect]"))
    .map((link) => ({ href: link.href, crossOrigin: link.crossOrigin }));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (test) => { while (!test()) await sleep(10); };
  const lastStats = () => statsMessages.at(-1) || {};

  root.addEventListener("message", (event) => {
    if (event.source === root && event.data?.channel === CHANNEL && event.data.type === "stats") statsMessages.push(event.data.payload);
  });

  const result = document.getElementById("fast-takeover-result");
  function render() {
    const newCall = calls.find((item) => item.marker.endsWith(NEW_BVID));
    const output = {
      markers: calls.map((item) => item.marker),
      ownPlayurlRequests,
      takeoverDelayMs: newCall && nativeAnsweredAt ? Math.round(newCall.at - nativeAnsweredAt) : null,
      overseasLinks,
      mainlandLinks,
      burst
    };
    const expectedLinks = (hosts) => JSON.stringify(hosts.map((host) => ({ href: `https://${host}/`, crossOrigin: "anonymous" })));
    output.usedNativeAnswer = newCall?.marker === `native:${NEW_BVID}`;
    output.skippedOwnPlayurl = ownPlayurlRequests.length === 0;
    output.tookOverAtOnce = output.takeoverDelayMs !== null && output.takeoverDelayMs < 150;
    output.preconnectedOverseas = JSON.stringify(overseasLinks) === expectedLinks(OVERSEAS_HOSTS);
    output.preconnectedMainland = JSON.stringify(mainlandLinks) === expectedLinks(MAINLAND_HOSTS);
    output.burstThrottled = Boolean(burst) && burst.messages <= 4;
    output.burstCounted = Boolean(burst) && burst.activeAfterStarts === 40 && burst.activeAfterDone === 0;
    output.pass = output.usedNativeAnswer && output.skippedOwnPlayurl && output.tookOverAtOnce
      && output.preconnectedOverseas && output.preconnectedMainland && output.burstThrottled && output.burstCounted;
    result.textContent = JSON.stringify(output);
    if (burst && mainlandLinks) result.dataset.pass = String(output.pass);
  }

  document.addEventListener("DOMContentLoaded", async () => {
    root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "overseas", concurrency: 32 } }, "*");
    await until(() => calls.length === 1);
    overseasLinks = preconnectLinks();

    // Bilibili's own playurl request for the next video answers long before BTR's own
    // view + playurl chain does.
    history.pushState(null, "", `/video/${NEW_BVID}`);
    await sleep(80);
    root.fetch(`https://api.bilibili.com/x/player/wbi/playurl?bvid=${NEW_BVID}&cid=303&qn=80`).catch(() => {});
    await until(() => calls.length === 2);
    await sleep(SLOW_MS * 2 + 200);

    const onTransfer = calls.at(-1).onTransfer;
    const before = statsMessages.length;
    const ids = Array.from({ length: 40 }, () => onTransfer({ phase: "start", kind: "video", totalBytes: 1024, url: "https://overseas-a.bilivideo.com/a.m4s" }));
    await sleep(250);
    const activeAfterStarts = lastStats().activeThreads;
    for (const id of ids) onTransfer({ phase: "done", id });
    await sleep(250);
    burst = { messages: statsMessages.length - before, activeAfterStarts, activeAfterDone: lastStats().activeThreads };

    root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 32 } }, "*");
    await until(() => calls.length === 3);
    mainlandLinks = preconnectLinks();
    render();
  }, { once: true });
  setInterval(render, 100);
})(globalThis);
