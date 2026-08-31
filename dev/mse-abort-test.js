(async function runMseAbortTest(root) {
  "use strict";

  const result = document.getElementById("mse-abort-result");
  const container = document.querySelector(".bpx-player-container");
  const video = container.querySelector("video");
  const playinfo = await fetch("/playinfo").then((response) => response.json());
  const failures = [];
  const unhandled = [];
  root.addEventListener("unhandledrejection", (event) => unhandled.push(String(event.reason?.message || event.reason)));
  root.addEventListener("error", (event) => unhandled.push(String(event.error?.message || event.message)));
  const settings = { enabled: true, mode: "mainland", concurrency: 32, bufferAheadSeconds: 24 };

  for (let index = 0; index < 60; index += 1) {
    const player = root.__BILI_NATIVE_MSE_PLAYER_FACTORY__.createNativePlayer({
      container,
      identity: { bvid: "BV1abortTest1", part: 1 },
      playinfo,
      initialTime: 0,
      initialResume: false,
      getSettings: () => settings,
      nativeFetch: root.fetch.bind(root),
      onFatal(error) { failures.push(String(error?.message || error)); }
    });
    player.destroy({ resumeNative: false });
  }

  await new Promise((resolve) => setTimeout(resolve, 750));
  const output = {
    iterations: 60,
    failures,
    unhandled,
    activeEngine: video.dataset.btrMediaEngine || "",
    activeContainer: container.dataset.btrMseActive || "",
    currentSource: video.currentSrc || video.src || ""
  };
  output.pass = output.failures.length === 0
    && output.unhandled.length === 0
    && !output.activeEngine
    && !output.activeContainer
    && !output.currentSource;
  result.textContent = JSON.stringify(output);
  result.dataset.pass = String(output.pass);
})(globalThis);
