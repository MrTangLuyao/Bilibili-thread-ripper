(async function runHarness() {
  const debug = document.getElementById("debug");
  const state = { active: 0, errors: [], last: null, maxActive: 0, transfers: 0 };
  const settings = { enabled: true, mode: "mainland", concurrency: 32 };
  const mockedInitialTime = Number(new URLSearchParams(location.search).get("initial")) || 0;
  if (mockedInitialTime >= 2) {
    const nativeVideo = document.querySelector("#player > video");
    let nativeTime = mockedInitialTime;
    Object.defineProperty(nativeVideo, "currentTime", {
      configurable: true,
      get: () => nativeTime,
      set: (value) => { nativeTime = Number(value) || 0; }
    });
  }
  const config = await fetch("/config").then(async (response) => {
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  window.__INITIAL_STATE__ = { videoData: { aid: 0, bvid: config.bvid, cid: config.cid } };
  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.channel !== "__BILI_RANGE_ACCELERATOR_V1__" || event.data?.type !== "danmaku-request") return;
    const response = await fetch(`/danmaku?cid=${encodeURIComponent(event.data.cid)}`);
    const xml = await response.text();
    window.postMessage({
      channel: "__BILI_RANGE_ACCELERATOR_V1__",
      type: "danmaku-response",
      requestId: event.data.requestId,
      payload: { ok: response.ok, xml, error: response.ok ? "" : xml }
    }, "*");
  });
  const playinfo = await fetch("/playinfo").then((response) => response.json());
  const render = () => {
    const player = window.__harnessPlayer;
    debug.textContent = JSON.stringify({ ...state, debug: player?.getDebug?.() }, null, 2);
  };
  window.__harnessPlayer = window.__BILI_MSE_PLAYER_FACTORY__.createPlayer({
    container: document.getElementById("player"),
    getSettings: () => settings,
    nativeFetch(url, init) {
      const value = String(url);
      return /(?:bilivideo\.(?:com|cn|net)|akamaized\.net)/i.test(value)
        ? window.fetch(`/media?url=${encodeURIComponent(value)}`, init)
        : window.fetch(value, init);
    },
    playinfo,
    onSettingsChange(next) {
      Object.assign(settings, next);
      state.settings = { ...settings };
      window.__harnessPlayer?.applySettings?.(settings);
      render();
    },
    onTransfer(event) {
      if (event.phase === "start") {
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        state.transfers += 1;
        render();
        return state.transfers;
      }
      if (event.phase === "error") state.errors.push(String(event.error?.message || event.error));
      if (["done", "error", "cancel"].includes(event.phase)) state.active = Math.max(0, state.active - 1);
      render();
      return event.id;
    },
    onState(next) { state.last = next; render(); },
    onFatal(error) { state.errors.push(String(error?.message || error)); render(); }
  });
  render();
})();
