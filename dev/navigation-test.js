(function installNavigationTest(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const OLD_BVID = "BV1oldRoute01";
  const NEW_BVID = "BV1newRoute02";
  const calls = [];
  let resolvedIdentity = null;
  let identityError = "";
  let mixedStateCid = 0;
  const nativeVideo = document.querySelector("video");
  const pod = document.createElement("div");
  const oldItem = document.createElement("div");
  const newItem = document.createElement("div");
  oldItem.className = "video-pod__item";
  oldItem.dataset.key = OLD_BVID;
  oldItem.innerHTML = '<div class="simple-base-item active"><span>旧视频</span></div>';
  newItem.className = "video-pod__item";
  newItem.dataset.key = NEW_BVID;
  newItem.innerHTML = '<div class="simple-base-item"><span>新视频</span></div>';
  pod.append(oldItem, newItem);
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
      return new Response(JSON.stringify({ code: 0, data: { aid: 202, bvid, cid: 202, pages: [{ cid: 202 }] } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.pathname === "/x/player/playurl") {
      return new Response(JSON.stringify({ code: 0, data: { dash: { duration: 200, video: [], audio: [] }, marker: bvid } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  newItem.addEventListener("click", () => {
    oldItem.querySelector(".simple-base-item")?.classList.remove("active");
    newItem.querySelector(".simple-base-item")?.classList.add("active");
    // 合集切换不会立刻修改地址栏，但活动项和播放清单已经换成新 BVID。
    root.__INITIAL_STATE__.videoData.bvid = NEW_BVID;
    mixedStateCid = Number(root.__INITIAL_STATE__.videoData.cid);
    root.__BILI_DANMAKU_FACTORY__.resolveIdentity(root.fetch, { bvid: NEW_BVID, part: 1 }).then(
      (identity) => { resolvedIdentity = identity; },
      (error) => { identityError = String(error?.message || error); }
    );
  });

  root.__navigationTest = { calls, OLD_BVID, NEW_BVID, get resolvedIdentity() { return resolvedIdentity; }, get identityError() { return identityError; }, get mixedStateCid() { return mixedStateCid; } };
  const result = document.getElementById("navigation-result");
  setInterval(() => {
    const oldCall = calls.find((item) => item.marker === OLD_BVID);
    const newCall = calls.find((item) => item.marker === NEW_BVID);
    const output = {
      calls,
      resolvedIdentity,
      identityError,
      mixedStateCid,
      playlistReleasedBeforeSwitch: Boolean(oldCall?.destroyed && oldCall.resumeNative === true),
      playlistReattached: Boolean(newCall && newCall.identity?.bvid === NEW_BVID),
      playlistRestartedAtZero: newCall?.initialTime === 0,
      playlistKeptPlaying: newCall?.initialResume === true,
      activePodKey: document.querySelector(".video-pod__item .simple-base-item.active")?.closest(".video-pod__item")?.dataset.key || "",
      debugVersion: root.__biliThreadRipperDebug?.version || "",
      settingsPanelCount: document.querySelectorAll("#__bilibili_thread_ripper_native_settings__").length,
      settingsStrategy: document.getElementById("__bilibili_thread_ripper_native_settings__")?.dataset.btrStrategy || "",
      href: location.href
    };
    output.pass = output.playlistReleasedBeforeSwitch
      && output.playlistReattached
      && output.playlistRestartedAtZero
      && output.playlistKeptPlaying
      && output.activePodKey === NEW_BVID
      && output.resolvedIdentity?.bvid === NEW_BVID
      && output.resolvedIdentity?.cid === 202
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
    newItem.querySelector("span")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }, 25);
})(globalThis);
