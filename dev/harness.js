(async function runHarness() {
  const debug = document.getElementById("debug");
  const state = { active: 0, errors: [], last: null, maxActive: 0, transfers: 0 };
  const search = new URLSearchParams(location.search);
  const settings = {
    enabled: true,
    mode: "mainland",
    concurrency: 32,
    subtitleLanguage: String(search.get("subtitle") || "off"),
    subtitleLastLanguage: String(search.get("subtitleLast") || (search.get("subtitle") && search.get("subtitle") !== "off" ? search.get("subtitle") : ""))
  };
  const playerWidth = Math.max(320, Math.min(1280, Number(search.get("width")) || 960));
  const playerHeight = Math.max(180, Math.round(Number(search.get("height")) || playerWidth * 9 / 16));
  const playerElement = document.getElementById("player");
  playerElement.style.width = `${playerWidth}px`;
  playerElement.style.height = `${playerHeight}px`;
  debug.style.width = `${playerWidth}px`;
  const mockedInitialTime = Number(search.get("initial")) || 0;
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
  const subtitleBody = search.get("subtitleCase") === "wrap"
    ? [
        { from: 0.2, to: 30, content: "第一行\\NThisIsAnExtremelyLongUnbrokenEnglishSubtitleThatMustWrapInsideThePlayerWithoutOverflowing" },
        { from: 0.2, to: 30, content: "第三行<br>第四行" }
      ]
    : [
        { from: 0.2, to: 2.4, content: "字幕功能测试" },
        { from: 2.5, to: 4.8, content: "第二行字幕" }
      ];
  window.__INITIAL_STATE__ = { videoData: { aid: 0, bvid: config.bvid, cid: config.cid } };
  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.channel !== "__BILI_RANGE_ACCELERATOR_V1__") return;
    if (event.data.type === "danmaku-request") {
      const response = await fetch(`/danmaku?cid=${encodeURIComponent(event.data.cid)}`);
      const xml = await response.text();
      window.postMessage({
        channel: "__BILI_RANGE_ACCELERATOR_V1__",
        type: "danmaku-response",
        requestId: event.data.requestId,
        payload: { ok: response.ok, xml, error: response.ok ? "" : xml }
      }, "*");
    } else if (event.data.type === "subtitle-request") {
      window.postMessage({
        channel: "__BILI_RANGE_ACCELERATOR_V1__",
        type: "subtitle-response",
        requestId: event.data.requestId,
        payload: { ok: true, text: JSON.stringify({ body: subtitleBody }) }
      }, "*");
    }
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
      if (/\/x\/player\/v2\?/i.test(value)) {
        return Promise.resolve(new Response(JSON.stringify({
          code: 0,
          data: {
            aid: 0,
            bvid: config.bvid,
            cid: Number(config.cid),
            subtitle: {
              subtitles: [
                { id: 1, lan: "zh-Hans", lan_doc: "中文（简体）", ai_type: 0, subtitle_url: "https://aisubtitle.hdslb.com/mock-manual.json" },
                { id: 2, lan: "ai-zh", lan_doc: "中文", ai_type: 1, subtitle_url: "https://aisubtitle.hdslb.com/mock-ai.json" },
                { id: 3, lan: "en-US", lan_doc: "英语（美国）", ai_type: 0, subtitle_url: "https://aisubtitle.hdslb.com/mock-en.json" }
              ]
            }
          }
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (/^https:\/\/aisubtitle\.hdslb\.com\/mock-/i.test(value)) {
        return Promise.resolve(new Response(JSON.stringify({ body: subtitleBody }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
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
