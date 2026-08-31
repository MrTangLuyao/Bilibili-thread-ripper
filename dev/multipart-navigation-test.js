(function installMultipartNavigationTest(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const BVID = "BV1multiPart1";
  const CIDS = [101, 202, 303];
  const calls = [];
  const nativeVideo = document.querySelector("video");
  const pod = document.createElement("div");
  const items = CIDS.map((cid, index) => {
    const item = document.createElement("div");
    item.className = `video-pod__item${index === 0 ? " active" : ""}`;
    item.dataset.key = String(cid);
    item.innerHTML = `<span>P${index + 1}</span>`;
    item.addEventListener("click", () => {
      for (const candidate of items) candidate.classList.remove("active");
      item.classList.add("active");
      history.pushState(null, "", `/video/${BVID}?p=${index + 1}`);
    });
    return item;
  });
  pod.append(...items);
  document.body.append(pod);

  history.replaceState(null, "", `/video/${BVID}?p=1`);
  root.__INITIAL_STATE__ = {
    videoData: { bvid: BVID, cid: CIDS[0], pages: CIDS.map((cid) => ({ cid })) }
  };
  root.__playinfo__ = { data: { dash: { duration: 100, video: [], audio: [] }, marker: "p1" } };
  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      return { enabled: value?.enabled !== false, mode: value?.mode || "mainland", concurrency: 32 };
    }
  };
  root.__BILI_THREAD_RIPPER_EARLY_MASK__ = { arm() {}, release() {} };
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = {
    createNativePlayer(options) {
      const record = {
        route: options.identity.key,
        marker: options.playinfo?.data?.marker || "",
        updates: [],
        destroyed: false,
        resumeNative: null
      };
      calls.push(record);
      return {
        applySettings() {},
        async updatePlayinfo(playinfo) {
          const marker = playinfo?.data?.marker || "";
          record.marker = marker || record.marker;
          record.updates.push(marker);
        },
        destroy({ resumeNative }) {
          record.destroyed = true;
          record.resumeNative = resumeNative;
        },
        video: nativeVideo
      };
    }
  };

  root.fetch = async function fakeFetch(input, options = {}) {
    const url = new URL(String(input), location.href);
    const signal = options.signal;
    const delay = async (milliseconds) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason || new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    };
    if (url.pathname === "/x/web-interface/view") {
      await delay(5);
      return new Response(JSON.stringify({
        code: 0,
        data: { aid: 1, bvid: BVID, cid: CIDS[0], pages: CIDS.map((cid) => ({ cid })) }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (/\/x\/player\/(?:wbi\/)?playurl/.test(url.pathname)) {
      const cid = Number(url.searchParams.get("cid"));
      if (url.searchParams.get("late") === "1") await delay(cid === 202 ? 140 : 10);
      else await delay(5);
      return new Response(JSON.stringify({
        code: 0,
        data: { dash: { duration: 100 + cid, video: [], audio: [] }, marker: `p${CIDS.indexOf(cid) + 1}` }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = document.getElementById("multipart-navigation-result");
  root.__multipartNavigationTest = { calls };
  setInterval(() => {
    const finalCall = [...calls].reverse().find((item) => item.route === `${BVID.toLowerCase()}:p3`);
    const output = {
      calls,
      finalRoute: finalCall?.route || "",
      finalMarker: finalCall?.marker || "",
      finalUpdates: finalCall?.updates || [],
      stalePartRejected: Boolean(finalCall && !finalCall.updates.includes("p2")),
      activePart: items.findIndex((item) => item.classList.contains("active")) + 1,
      href: location.href
    };
    output.pass = output.finalRoute.endsWith(":p3")
      && output.finalMarker === "p3"
      && output.stalePartRejected
      && output.activePart === 3;
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  }, 50);

  setTimeout(() => root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 32 } }, "*"), 0);
  const switchTimer = setInterval(() => {
    if (!calls.some((item) => item.route.endsWith(":p1"))) return;
    clearInterval(switchTimer);
    items[1].querySelector("span")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    setTimeout(() => items[2].querySelector("span")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })), 25);
    setTimeout(() => {
      root.fetch(`/x/player/playurl?bvid=${BVID}&cid=202&late=1`).catch(() => {});
      root.fetch(`/x/player/playurl?bvid=${BVID}&cid=303&late=1`).catch(() => {});
    }, 900);
  }, 25);
})(globalThis);
