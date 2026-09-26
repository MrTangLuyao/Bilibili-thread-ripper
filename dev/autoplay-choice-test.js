(function installAutoplayChoiceTest(root) {
  "use strict";

  // Issue #13: with the player's "自动开播" off, a video must not start by itself. A retake of
  // a video that was playing goes on playing; one that was paused stays paused.
  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const BVID = "BV1autoplay01";
  const created = [];
  let playing = false;

  localStorage.setItem("bpx_player_profile", JSON.stringify({ media: { autoplay: false, quality: 0 } }));
  history.replaceState(null, "", `/video/${BVID}`);
  root.__INITIAL_STATE__ = { videoData: { bvid: BVID, cid: 101 } };
  root.__playinfo__ = { data: { dash: { duration: 100, video: [], audio: [] } } };
  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      return { enabled: value?.enabled !== false, mode: value?.mode || "mainland", concurrency: 32 };
    }
  };
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = {
    createNativePlayer(options) {
      created.push({ initialResume: options.initialResume, autoplay: options.autoplay });
      return {
        applySettings() {},
        async setQuality() {},
        async updatePlayinfo() {},
        destroy() {},
        video: { isConnected: true, get paused() { return !playing; } }
      };
    }
  };
  root.fetch = async function fakeFetch(input) {
    throw new Error(`unexpected request: ${input}`);
  };

  const result = document.getElementById("autoplay-choice-result");
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (count) => { const startedAt = performance.now(); while (created.length < count && performance.now() - startedAt < 5000) await wait(25); };
  const retake = () => root.postMessage({ channel: CHANNEL, type: "retry-takeover" }, "*");
  document.addEventListener("DOMContentLoaded", () => {
    root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 32 } }, "*");
  }, { once: true });

  (async () => {
    await waitFor(1);
    // A fresh page: the player's own setting decides, nothing is forced.
    const fresh = created[0];
    playing = true;
    retake();
    await waitFor(2);
    const afterPlaying = created[1];
    playing = false;
    retake();
    await waitFor(3);
    const afterPaused = created[2];
    localStorage.setItem("bpx_player_profile", JSON.stringify({ media: { autoplay: true } }));
    retake();
    await waitFor(4);
    const settingOn = created[3];
    const output = {
      created,
      checks: {
        freshFollowsSetting: fresh?.autoplay === false && fresh.initialResume === undefined,
        playingVideoGoesOn: afterPlaying?.initialResume === true,
        pausedVideoStaysPaused: afterPaused?.initialResume === undefined && afterPaused.autoplay === false,
        settingOnIsPassed: settingOn?.autoplay === true
      }
    };
    output.pass = Object.values(output.checks).every(Boolean) && root.__biliThreadRipperDebug?.version === "0.9.4.3";
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  })();
})(globalThis);
