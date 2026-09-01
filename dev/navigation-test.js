(function installNavigationTest(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const OLD_BVID = "BV1oldRoute01";
  const MIDDLE_BVID = "BV1midRoute03";
  const NEW_BVID = "BV1newRoute02";
  const calls = [];
  const apiRequests = [];
  let resolvedIdentity = null;
  let identityError = "";
  let mixedStateCid = 0;
  const nativeVideo = document.querySelector("video");
  const pod = document.createElement("div");
  const oldItem = document.createElement("div");
  const middleItem = document.createElement("div");
  const newItem = document.createElement("div");
  oldItem.className = "video-pod__item";
  oldItem.dataset.key = OLD_BVID;
  oldItem.innerHTML = '<div class="simple-base-item active"><span>旧视频</span></div>';
  middleItem.className = "video-pod__item";
  middleItem.dataset.key = MIDDLE_BVID;
  middleItem.innerHTML = '<div class="simple-base-item"><span>中间视频</span></div>';
  newItem.className = "video-pod__item";
  newItem.dataset.key = NEW_BVID;
  newItem.innerHTML = '<div class="simple-base-item"><span>新视频</span></div>';
  pod.append(oldItem, middleItem, newItem);
  document.body.append(pod);

  history.replaceState(null, "", `/video/${OLD_BVID}`);
  root.__INITIAL_STATE__ = { videoData: { bvid: OLD_BVID, cid: 101 } };
  root.__playinfo__ = { data: { dash: { duration: 100, video: [], audio: [] }, marker: OLD_BVID } };
  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      return { enabled: value?.enabled !== false, mode: value?.mode || "mainland", concurrency: 32 };
    }
  };
  root.__BILI_THREAD_RIPPER_EARLY_MASK__ = { arm() {}, release() {} };
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = {
    createNativePlayer(options) {
      const marker = options.playinfo?.data?.marker || "";
      const record = {
        destroyed: false,
        marker,
        identity: options.identity || null,
        initialTime: options.initialTime,
        initialResume: options.initialResume,
        resumeNative: null,
        route: location.pathname
      };
      calls.push(record);
      if (marker === OLD_BVID) {
        setTimeout(() => options.onNativeSourceChange?.({ src: "blob:stale-old-source" }), 900);
        setTimeout(() => options.onFatal?.(new Error("stale old-player failure")), 925);
      }
      return {
        applySettings() {},
        async updatePlayinfo(playinfo) { record.marker = playinfo?.data?.marker || record.marker; },
        destroy({ resumeNative }) {
          record.destroyed = true;
          record.resumeNative = resumeNative;
        },
        video: { isConnected: true, paused: false }
      };
    }
  };

  root.fetch = async function fakeFetch(input) {
    const url = new URL(String(input), location.href);
    const bvid = url.searchParams.get("bvid") || "";
    if (url.pathname === "/x/web-interface/view") {
      apiRequests.push(url.href);
      if (url.origin !== "https://api.bilibili.com") return new Response("not found", { status: 404 });
      const cid = bvid === MIDDLE_BVID ? 202 : bvid === NEW_BVID ? 303 : 101;
      return new Response(JSON.stringify({ code: 0, data: { aid: cid, bvid, cid, pages: [{ cid }] } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.pathname === "/x/player/playurl") {
      apiRequests.push(url.href);
      if (url.origin !== "https://api.bilibili.com") return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ code: 0, data: { dash: { duration: 200, video: [], audio: [] }, marker: bvid } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  function activate(item, bvid) {
    for (const candidate of [oldItem, middleItem, newItem]) candidate.querySelector(".simple-base-item")?.classList.remove("active");
    item.querySelector(".simple-base-item")?.classList.add("active");
    // 合集切换不会立刻修改地址栏，但活动项和播放清单已经换成新 BVID。
    root.__INITIAL_STATE__.videoData.bvid = bvid;
  }

  middleItem.addEventListener("click", () => activate(middleItem, MIDDLE_BVID));
  newItem.addEventListener("click", () => {
    activate(newItem, NEW_BVID);
    mixedStateCid = Number(root.__INITIAL_STATE__.videoData.cid);
    root.__BILI_DANMAKU_FACTORY__.resolveIdentity(root.fetch, { bvid: NEW_BVID, part: 1 }).then(
      (identity) => { resolvedIdentity = identity; },
      (error) => { identityError = String(error?.message || error); }
    );
  });

  root.__navigationTest = { calls, apiRequests, OLD_BVID, MIDDLE_BVID, NEW_BVID, get resolvedIdentity() { return resolvedIdentity; }, get identityError() { return identityError; }, get mixedStateCid() { return mixedStateCid; } };
  const result = document.getElementById("navigation-result");
  setInterval(() => {
    const oldCall = calls.find((item) => item.marker === OLD_BVID);
    const newCall = calls.find((item) => item.marker === NEW_BVID);
    const output = {
      calls,
      resolvedIdentity,
      identityError,
      mixedStateCid,
      apiRequests,
      apiFallbackUsedCorrectOrigin: apiRequests.some((url) => url.includes("/x/web-interface/view"))
        && apiRequests.some((url) => url.includes("/x/player/playurl"))
        && apiRequests.every((url) => new URL(url).origin === "https://api.bilibili.com"),
      playlistReleasedBeforeSwitch: Boolean(oldCall?.destroyed && oldCall.resumeNative === false),
      intermediateNotAttached: !calls.some((item) => item.marker === MIDDLE_BVID),
      playlistReattached: Boolean(newCall && newCall.identity?.bvid === NEW_BVID),
      newPlayerSurvivedStaleCallbacks: Boolean(newCall && !newCall.destroyed),
      playlistRestartedAtZero: newCall?.initialTime === 0,
      playlistKeptPlaying: newCall?.initialResume === true,
      activePodKey: document.querySelector(".video-pod__item .simple-base-item.active")?.closest(".video-pod__item")?.dataset.key || "",
      debugVersion: root.__biliThreadRipperDebug?.version || "",
      settingsPanelCount: document.querySelectorAll("#__bilibili_thread_ripper_native_settings__").length,
      settingsStrategy: document.getElementById("__bilibili_thread_ripper_native_settings__")?.dataset.btrStrategy || "",
      compatibilityOptions: Array.from(document.querySelectorAll('input[name="btr-native-compatibility"]')).map((input) => input.value),
      href: location.href
    };
    output.pass = output.playlistReleasedBeforeSwitch
      && output.playlistReattached
      && output.intermediateNotAttached
      && output.newPlayerSurvivedStaleCallbacks
      && output.playlistRestartedAtZero
      && output.playlistKeptPlaying
      && output.apiFallbackUsedCorrectOrigin
      && output.activePodKey === NEW_BVID
      && output.resolvedIdentity?.bvid === NEW_BVID
      && output.resolvedIdentity?.cid === 303
      && output.debugVersion === "0.9.1.0"
      && output.settingsPanelCount === 1
      && output.settingsStrategy === "native-ui-progressive-mse-0.8-core"
      && output.compatibilityOptions.join(",") === "off,a,b"
      && !output.identityError;
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  }, 50);
  setTimeout(() => {
    root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 32 } }, "*");
  }, 0);
  const switchTimer = setInterval(() => {
    if (!calls.some((item) => item.marker === OLD_BVID)) return;
    clearInterval(switchTimer);
    middleItem.querySelector("span")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    setTimeout(() => {
      newItem.querySelector("span")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }, 25);
  }, 25);
})(globalThis);
