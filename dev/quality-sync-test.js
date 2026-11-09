(function installQualitySyncTest(root) {
  "use strict";

  // Bilibili's quality menu switches between qualities that are already in the playinfo
  // without a new playurl request. The page hook has to read the choice from the native
  // player and pass it on; the same choice twice must not be passed again. In 自动 the menu
  // shows the quality the native player picked itself (realQ), and that is what plays (#69).
  // ?auto starts in 自动.
  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const BVID = "BV1quality001";
  const startsInAuto = new URLSearchParams(location.search).has("auto");
  let nativeQuality = startsInAuto ? 0 : 64;
  const created = [];
  const qualityCalls = [];
  const autoCalls = [];
  // Both kinds of call, in order.
  const calls = [];
  // The native player's own pick. Like Bilibili's core, a quality picked by hand becomes its
  // pick at once (dash.js sets the index), and with BTR playing nothing moves it after that.
  let realQuality = startsInAuto ? 80 : 16;

  history.replaceState(null, "", `/video/${BVID}`);
  root.__INITIAL_STATE__ = { videoData: { bvid: BVID, cid: 101 } };
  root.__playinfo__ = { data: { quality: 64, dash: { duration: 100, video: [], audio: [] } } };
  root.__BILI_RANGE_CORE__ = {
    normalizeSettings(value) {
      return { enabled: value?.enabled !== false, mode: value?.mode || "mainland", concurrency: 32 };
    }
  };
  // The native player: its menu sets newQ, like Bilibili's own click handler. Its core
  // keeps a pending switch that waits for the "rendered" confirmation.
  let pendingSwitch = null;
  const resolvedSwitches = [];
  // The real core also has fire(), getQualityChangedData() and the currentQualityIndex its
  // own qualityChangeRendered handler keeps. The first switch below runs without them.
  let realCore = null;
  root.player = {
    getQuality: () => ({ nowQ: 0, newQ: nativeQuality, realQ: realQuality }),
    __core: () => ({ ...realCore, qnSwitchingInfo: { video: pendingSwitch } })
  };
  for (const item of document.querySelectorAll(".bpx-player-ctrl-quality-menu-item")) {
    item.addEventListener("click", () => {
      nativeQuality = Number(item.dataset.value);
      if (nativeQuality) realQuality = nativeQuality;
    });
  }
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = {
    createNativePlayer(options) {
      created.push({ preferredQuality: options.preferredQuality, autoQuality: options.autoQuality });
      setTimeout(() => options.onState?.({ playerState: "ready", quality: "480P", bufferedAhead: 10, cdnHosts: [] }), 0);
      return {
        applySettings() {},
        async setQuality(quality) { qualityCalls.push({ quality, at: performance.now() }); calls.push(`quality ${quality}`); },
        async setAutoQuality(quality) { autoCalls.push(quality); calls.push(`auto ${quality}`); },
        async updatePlayinfo() {},
        destroy() {},
        getDebug: () => ({ qualityId: nativeQuality, autoQuality: options.autoQuality }),
        video: { isConnected: true, paused: false }
      };
    }
  };
  root.fetch = async function fakeFetch(input) {
    throw new Error(`unexpected request: ${input}`);
  };

  const result = document.getElementById("quality-sync-result");
  const click = (value) => document.querySelector(`.bpx-player-ctrl-quality-menu-item[data-value="${value}"] span`)
    .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const output = { created, qualityCalls, autoCalls, calls, steps: {} };
  const render = () => { result.textContent = JSON.stringify(output); };

  document.addEventListener("DOMContentLoaded", () => {
    root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 32 } }, "*");
  }, { once: true });

  (async () => {
    const startedAt = performance.now();
    while (!created.length && performance.now() - startedAt < 5000) await wait(25);
    if (startsInAuto) {
      // Taken over in 自动: the quality the menu shows goes to the new player, and nothing
      // is asked for again while it stays.
      output.steps.startsWithShown = created[0]?.preferredQuality === 0 && created[0]?.autoQuality === 80;
      await wait(1300);
      output.steps.noCallWhileShownStays = calls.length === 0;
      output.pass = output.steps.startsWithShown && output.steps.noCallWhileShownStays && created.length === 1;
      render();
      result.dataset.pass = String(output.pass);
      return;
    }
    // The quality chosen before takeover goes straight to the new player.
    output.steps.initial = created[0]?.preferredQuality;
    await wait(1200);
    output.steps.noCallWhileUnchanged = qualityCalls.length === 0;

    let clickedAt = performance.now();
    click(32);
    await wait(150);
    output.steps.clickFollowedQuickly = qualityCalls.at(-1)?.quality === 32 && qualityCalls.at(-1).at - clickedAt < 150;

    click(32);
    await wait(1300);
    output.steps.sameChoiceNotRepeated = qualityCalls.length === 1;

    // A change the menu did not make (keyboard shortcut, Bilibili itself) is still picked up.
    nativeQuality = 16;
    realQuality = 16;
    await wait(1300);
    output.steps.changeWithoutClick = qualityCalls.at(-1)?.quality === 16 && qualityCalls.length === 2;

    // Bilibili's core waits for the "rendered" confirmation of the switch to 16. The
    // takeover already plays that quality, so the pending switch is resolved for it
    // within the next sync tick, and the same pending object only once.
    pendingSwitch = {
      switching: true, oQn: 32, qn: 16,
      resolve(payload) { resolvedSwitches.push(payload); pendingSwitch.switching = false; },
      reject() {}, listener() {}
    };
    await wait(2400);
    output.steps.switchConfirmed = resolvedSwitches.length === 1
      && resolvedSwitches[0]?.type === "qualityChangeRendered"
      && resolvedSwitches[0]?.newQuality === 16;
    pendingSwitch.switching = true;
    await wait(1300);
    output.steps.samePendingNotRepeated = resolvedSwitches.length === 1;
    pendingSwitch = null;

    // With a core like the real one, the switch is confirmed through its own rendered path:
    // the wrapper records the new index (or the next switch back is refused as the same
    // quality, 切换失败) and the listener clears the switch and its timeout. The listener
    // works with indexes; index 0 is 16 here.
    const qualityByIndex = [16, 32, 64];
    const fired = [], heard = [];
    const state = { currentQualityIndex: { video: 1 } };
    realCore = {
      state,
      getQualityChangedData: (event) => ({ ...event, newQualityNumber: qualityByIndex[event.newQuality], oldQualityNumber: qualityByIndex[event.oldQuality] }),
      fire(name, data) { fired.push({ name, data }); if (name === "qualityChangeRendered") state.currentQualityIndex[data.mediaType] = data.newQuality; }
    };
    const resolvedBefore = resolvedSwitches.length;
    pendingSwitch = {
      switching: true, oQn: 16, qn: 0,
      resolve(payload) { resolvedSwitches.push(payload); },
      reject() {},
      listener(event) { heard.push(event); pendingSwitch = {}; }
    };
    await wait(2400);
    output.steps.renderedThroughCore = heard.length === 1 && heard[0].newQuality === 0 && heard[0].oldQuality === 1
      && fired.length === 1 && fired[0].name === "qualityChangeRendered" && fired[0].data.newQualityNumber === 16
      && state.currentQualityIndex.video === 0 && resolvedSwitches.length === resolvedBefore;

    // A pending index that is not the quality being played is never handed to the listener
    // (it would refuse the switch); resolve() still settles it.
    pendingSwitch = {
      switching: true, oQn: 16, qn: 2,
      resolve(payload) { resolvedSwitches.push(payload); pendingSwitch.switching = false; },
      reject() {},
      listener(event) { heard.push(event); }
    };
    await wait(2400);
    output.steps.mismatchFallsBack = heard.length === 1 && fired.length === 1
      && resolvedSwitches.length === resolvedBefore + 1 && resolvedSwitches.at(-1)?.newQuality === 16;
    pendingSwitch = null;
    realCore = null;

    clickedAt = performance.now();
    click(0);
    await wait(150);
    output.steps.backToAuto = qualityCalls.at(-1)?.quality === 0 && qualityCalls.length === 3;
    // Back in 自动 right after a quality picked by hand, what 自动 reports is that quality, not a
    // pick of its own; with no earlier pick of 自动 known, the video's default quality plays, as
    // before (no setAutoQuality).
    output.steps.handPickNotTakenForAuto = autoCalls.length === 0;

    // The native player's own pick changes (known only after an early takeover, or after it
    // is reloaded): it is followed once, a pick not known yet changes nothing.
    realQuality = 64;
    await wait(1300);
    output.steps.autoFollowsPick = autoCalls.length === 1 && autoCalls[0] === 64;
    realQuality = NaN;
    await wait(1300);
    realQuality = 64;
    await wait(1300);
    output.steps.unknownPickIgnored = autoCalls.length === 1 && qualityCalls.length === 3;

    // A quality chosen by hand wins; the native player's pick is not followed then.
    click(32);
    await wait(1300);
    output.steps.manualIgnoresPick = qualityCalls.at(-1)?.quality === 32 && autoCalls.length === 1;

    // Back to 自动 again: the pick 自动 had before the dip to 32 plays, set before 自动 itself so
    // that the player restarts at most once.
    const before = calls.length;
    click(0);
    await wait(150);
    output.steps.backToEarlierAutoPick = JSON.stringify(calls.slice(before)) === JSON.stringify(["auto 64", "quality 0"]);

    output.steps.onePlayer = created.length === 1;
    output.pass = output.steps.initial === 64 && created[0]?.autoQuality === 0
      && output.steps.noCallWhileUnchanged
      && output.steps.clickFollowedQuickly
      && output.steps.sameChoiceNotRepeated
      && output.steps.changeWithoutClick
      && output.steps.switchConfirmed
      && output.steps.samePendingNotRepeated
      && output.steps.renderedThroughCore
      && output.steps.mismatchFallsBack
      && output.steps.backToAuto
      && output.steps.handPickNotTakenForAuto
      && output.steps.autoFollowsPick
      && output.steps.unknownPickIgnored
      && output.steps.manualIgnoresPick
      && output.steps.backToEarlierAutoPick
      && output.steps.onePlayer
      && root.__biliThreadRipperDebug?.version === "__BTR_VERSION__";
    render();
    result.dataset.pass = String(output.pass);
  })();
})(globalThis);
