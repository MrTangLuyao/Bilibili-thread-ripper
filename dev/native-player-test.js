(async function runNativePlayerTest(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const resultNode = document.getElementById("native-player-result");
  const mediaUrl = "https://upos-sz-mirrorali.bilivideo.com/test/video-100029.m4s";
  let echoedSettings = { enabled: true, mode: "mainland", concurrency: 32 };
  root.addEventListener("message", (event) => {
    if (event.source !== root || event.data?.channel !== CHANNEL || event.data?.type !== "settings-update") return;
    echoedSettings = { ...echoedSettings, ...event.data.payload };
    root.postMessage({ channel: CHANNEL, type: "settings", payload: echoedSettings }, "*");
  });
  root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 32 } }, "*");
  await new Promise((resolve) => setTimeout(resolve, 50));

  function validBytes(bytes, start) {
    if (!(bytes instanceof Uint8Array) || !bytes.length) return false;
    const positions = [0, 1, Math.floor(bytes.length / 2), bytes.length - 1];
    return positions.every((index) => bytes[index] === (start + index) % 251);
  }

  const fetchStart = 0;
  const fetchEnd = 1024 * 1024 - 1;
  const fetchResponse = await fetch(mediaUrl, { headers: { Range: `bytes=${fetchStart}-${fetchEnd}` } });
  const fetchBytes = new Uint8Array(await fetchResponse.arrayBuffer());

  const xhrStart = 1024 * 1024;
  const xhrEnd = 9 * 1024 * 1024 - 1;
  const xhrEvents = [];
  const xhrResult = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    for (const event of ["loadstart", "readystatechange", "progress", "load", "loadend", "error", "timeout", "abort"]) {
      xhr.addEventListener(event, () => xhrEvents.push(`${event}:${xhr.readyState}`));
    }
    xhr.open("GET", mediaUrl, true);
    xhr.responseType = "arraybuffer";
    xhr.setRequestHeader("Range", `bytes=${xhrStart}-${xhrEnd}`);
    xhr.onload = () => resolve({
      bytes: new Uint8Array(xhr.response),
      contentRange: xhr.getResponseHeader("content-range"),
      responseURL: xhr.responseURL,
      status: xhr.status,
      statusText: xhr.statusText
    });
    xhr.onerror = () => reject(new Error("accelerated XHR failed"));
    xhr.send();
  });

  const fastMediaUrl = "https://upos-sz-mirrorali.bilivideo.com/test/fast-video-100030.m4s";
  const fastRanges = [];
  for (let index = 0; index < 2; index += 1) {
    const start = index * 8 * 1024 * 1024;
    const end = start + 8 * 1024 * 1024 - 1;
    const response = await fetch(fastMediaUrl, { headers: { Range: `bytes=${start}-${end}` } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    fastRanges.push({ length: bytes.byteLength, valid: validBytes(bytes, start) });
  }

  const nativeFetchResponse = await fetch("/config");
  const nativeFetchPayload = await nativeFetchResponse.json();
  const nativeXhrResult = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "/config", true);
    xhr.responseType = "json";
    xhr.onload = () => resolve({ status: xhr.status, payload: xhr.response });
    xhr.onerror = () => reject(new Error("native XHR passthrough failed"));
    xhr.send();
  });

  // 普通缓冲 waiting 不得伪装成“用户跳转”。只有真实 seeking 才能显示
  // 跳转重建提示，这是本轮线上回归的直接覆盖。
  const nativeVideo = document.querySelector("#bilibili-player video");
  nativeVideo.dispatchEvent(new Event("playing", { bubbles: true }));
  nativeVideo.dispatchEvent(new Event("waiting", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 3100));
  const waitingNotice = document.getElementById("__bilibili_thread_ripper_slow_start_notice__")?.textContent || "";

  await new Promise((resolve) => setTimeout(resolve, 200));
  document.querySelector('#__bilibili_thread_ripper_native_settings__ input[name="btr-native-mode"][value="overseas"]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const modeInputs = [...document.querySelectorAll('#__bilibili_thread_ripper_native_settings__ input[name="btr-native-mode"]')];
  const concurrencyInputs = [...document.querySelectorAll('#__bilibili_thread_ripper_native_settings__ input[name="btr-native-concurrency"]')];
  const debug = root.__biliThreadRipperDebug.getStats();
  const output = {
    architecture: debug.architecture,
    fetch: {
      status: fetchResponse.status,
      contentRange: fetchResponse.headers.get("content-range"),
      length: fetchBytes.byteLength,
      valid: validBytes(fetchBytes, fetchStart)
    },
    xhr: {
      status: xhrResult.status,
      statusText: xhrResult.statusText,
      contentRange: xhrResult.contentRange,
      length: xhrResult.bytes.byteLength,
      valid: validBytes(xhrResult.bytes, xhrStart),
      responseURL: xhrResult.responseURL,
      events: xhrEvents
    },
    passthrough: {
      fetchStatus: nativeFetchResponse.status,
      fetchBvid: nativeFetchPayload.bvid,
      xhrStatus: nativeXhrResult.status,
      xhrBvid: nativeXhrResult.payload?.bvid
    },
    waitingNotice,
    fastNativePolicy: fastRanges,
    officialUi: {
      customPlayerCount: document.querySelectorAll("#__bilibili_thread_ripper_player__").length,
      nativeVideoVisibility: getComputedStyle(document.querySelector("#bilibili-player video")).visibility,
      settingsPanel: Boolean(document.getElementById("__bilibili_thread_ripper_native_settings__")),
      effectiveMode: root.__biliThreadRipperDebug.getSettings().mode,
      modeOptions: modeInputs.map((input) => ({ value: input.value, checked: input.checked })),
      concurrencyOptions: concurrencyInputs.map((input) => ({ value: input.value, checked: input.checked }))
    },
    stats: {
      acceleratedRequests: debug.acceleratedRequests,
      acceleratedBytes: debug.acceleratedBytes,
      parallelSubrequests: debug.parallelSubrequests,
      activeThreads: debug.activeThreads,
      nativePassThroughs: debug.nativePassThroughs,
      nativeRaceWins: debug.nativeRaceWins,
      parallelRaceWins: debug.parallelRaceWins
    }
  };
  output.pass = output.fetch.status === 206
    && output.fetch.contentRange === `bytes ${fetchStart}-${fetchEnd}/${24 * 1024 * 1024}`
    && output.fetch.length === fetchEnd - fetchStart + 1
    && output.fetch.valid
    && output.xhr.status === 206
    && output.xhr.contentRange === `bytes ${xhrStart}-${xhrEnd}/${24 * 1024 * 1024}`
    && output.xhr.length === xhrEnd - xhrStart + 1
    && output.xhr.valid
    && output.xhr.events.some((event) => event === "load:4")
    && output.passthrough.fetchStatus === 200
    && output.passthrough.xhrStatus === 200
    && output.passthrough.fetchBvid === output.passthrough.xhrBvid
    && output.waitingNotice === ""
    && output.fastNativePolicy.length === 2
    && output.fastNativePolicy.every((item) => item.length === 8 * 1024 * 1024 && item.valid)
    && output.officialUi.customPlayerCount === 0
    && output.officialUi.nativeVideoVisibility === "visible"
    && output.officialUi.settingsPanel
    && output.officialUi.effectiveMode === "overseas"
    && output.officialUi.modeOptions.find((item) => item.value === "overseas")?.checked === true
    && output.officialUi.modeOptions.length === 2
    && output.officialUi.concurrencyOptions.length === 6
    && output.stats.nativePassThroughs >= 1
    && output.stats.parallelRaceWins === 1
    && output.stats.nativeRaceWins === 1
    && output.stats.acceleratedRequests === 1
    && output.stats.parallelSubrequests >= 16;
  resultNode.textContent = JSON.stringify(output);
})(globalThis);
