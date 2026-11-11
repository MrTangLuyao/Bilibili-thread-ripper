(async function runNativeMseQualityTest(root) {
  "use strict";
  // Real media through dev/server.js. Switches quality the way the page hook does after a
  // choice in Bilibili's quality menu, then checks what is actually played and downloaded.
  const resultNode = document.getElementById("native-mse-result");
  const video = document.querySelector("video");
  const settings = { enabled: true, mode: "mainland", concurrency: 32 };
  const errors = [];
  const transfers = [];
  const playinfo = await fetch("/playinfo").then((response) => response.json());
  const factory = root.__BILI_NATIVE_MSE_PLAYER_FACTORY__;
  const fileOf = (url) => (/-(\d{5,6})\.m4s/.exec(String(url)) || [])[1] || "";
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (check, timeout) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      if (check()) return true;
      if (errors.length) return false;
      await wait(100);
    }
    return false;
  };
  const nativeFetch = (input, init) => {
    const value = String(input instanceof Request ? input.url : input);
    return /(?:bilivideo\.(?:com|cn|net)|akamaized\.net)/i.test(value)
      ? fetch(`/media?url=${encodeURIComponent(value)}`, init)
      : fetch(input, init);
  };

  const selection = factory.selectRepresentations(playinfo);
  const standard = selection.preferred;
  const lower = selection.videos.find((item) => Number(item.id) !== Number(standard.id));
  const output = { standard: Number(standard.id), lower: Number(lower?.id) || 0, steps: {}, errors };
  const finish = () => {
    output.pass = Boolean(lower)
      && Object.values(output.steps).length === 7
      && Object.values(output.steps).every((step) => step.ok)
      && errors.length === 0;
    output.summary = `${output.standard} → ${output.lower} → ${output.standard}，切换中拖动进度，重复选择和改回自动都不重建`;
    resultNode.textContent = JSON.stringify(output);
    resultNode.dataset.pass = String(output.pass);
  };
  if (!lower) { errors.push("测试视频至少要有两档清晰度"); finish(); return; }

  const player = factory.createNativePlayer({
    container: document.querySelector(".bpx-player-container"),
    identity: { bvid: "quality-test", part: 1 },
    playinfo,
    initialTime: 0,
    initialResume: true,
    getSettings: () => settings,
    nativeFetch,
    onTransfer(event) {
      if (event.phase === "start") transfers.push({ at: performance.now(), file: fileOf(event.url) });
      return transfers.length;
    },
    onFatal(error) { errors.push(String(error?.message || error)); }
  });
  const debug = () => player.getDebug();
  const ready = (quality) => debug().qualityId === quality && debug().playbackActivated;

  // 1. Starts at the playinfo's quality and plays.
  let ok = await waitFor(() => ready(output.standard), 30000);
  video.muted = true;
  video.play().catch(() => {});
  ok = ok && await waitFor(() => video.currentTime > 2, 20000);
  output.steps.start = { ok, quality: debug().qualityId, sessions: debug().sessionStarts };

  // 2. A lower quality: one new session, no jump backwards, only the new file downloaded.
  const before = { time: video.currentTime, sessions: debug().sessionStarts };
  await player.setQuality(output.lower);
  ok = await waitFor(() => ready(output.lower), 30000);
  const settledAt = performance.now();
  await wait(4000);
  const files = [...new Set(transfers.filter((item) => item.at > settledAt + 500).map((item) => item.file))];
  output.steps.lower = {
    ok: ok && debug().sessionStarts === before.sessions + 1 && video.currentTime >= before.time - 0.5
      && !files.includes(fileOf(standard.baseUrl || standard.base_url)),
    quality: debug().qualityId, sessions: debug().sessionStarts - before.sessions,
    timeBefore: +before.time.toFixed(2), timeAfter: +video.currentTime.toFixed(2), filesAfter: files
  };

  // 3. Picking the same quality again changes nothing.
  let sessions = debug().sessionStarts;
  await player.setQuality(output.lower);
  await wait(1500);
  output.steps.sameAgain = { ok: debug().sessionStarts === sessions && debug().qualityId === output.lower };

  // 4. Back up, with a seek while the new session is still starting.
  const seekTarget = Math.min(Math.max(0, video.duration - 40), video.currentTime + 60);
  player.setQuality(output.standard).catch((error) => errors.push(String(error?.message || error)));
  await wait(150);
  video.currentTime = seekTarget;
  ok = await waitFor(() => ready(output.standard) && Math.abs(video.currentTime - seekTarget) < 3, 30000);
  output.steps.upWithSeek = { ok, quality: debug().qualityId, seekTarget: +seekTarget.toFixed(2), time: +video.currentTime.toFixed(2) };

  // 5. "Auto" plays the playinfo's quality, which is already playing.
  sessions = debug().sessionStarts;
  await player.setQuality(0);
  await wait(1500);
  output.steps.auto = { ok: debug().sessionStarts === sessions && debug().qualityId === output.standard && debug().preferredQuality === 0 };

  // 6. A quality picked by hand that is not the playinfo's own, then "auto": the menu shows
  //    that quality in 自动, the page passes it on, and it goes on playing (#69).
  await player.setQuality(output.lower);
  ok = await waitFor(() => ready(output.lower), 30000);
  sessions = debug().sessionStarts;
  await player.setAutoQuality(output.lower);
  await player.setQuality(0);
  await wait(1500);
  output.steps.autoKeepsHandPick = { ok: ok && debug().sessionStarts === sessions && debug().qualityId === output.lower && debug().preferredQuality === 0, quality: debug().qualityId };

  // 7. Playback continues after all of this.
  const playingFrom = video.currentTime;
  video.play().catch(() => {});
  ok = await waitFor(() => video.currentTime > playingFrom + 2, 20000);
  output.steps.keepsPlaying = { ok, time: +video.currentTime.toFixed(2) };
  player.destroy({ resumeNative: false });
  finish();
})(globalThis);
