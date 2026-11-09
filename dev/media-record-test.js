"use strict";
// Needs dev/server.js. The element's own events that runtime-notices.js records for the
// diagnostic copy (history()), with a <video> that really plays: whether the picture moves,
// a stall that fires no event, and an old element after a switch of video.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

// The storage bridge.js reads the settings from, kept in localStorage.
function mockChrome() {
  const listeners = [];
  const read = () => JSON.parse(localStorage.getItem("media-record-sync") || "{}");
  const save = (next, callback) => {
    const previous = read(), changes = {};
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changes[key] = { oldValue: previous[key], newValue: next[key] };
    localStorage.setItem("media-record-sync", JSON.stringify(next));
    queueMicrotask(() => { if (Object.keys(changes).length) listeners.forEach(fn => fn(changes, "sync")); callback?.(); });
    return Promise.resolve();
  };
  const sync = {
    get(defaults, callback) { const value = { ...(defaults || {}), ...read() }; if (callback) queueMicrotask(() => callback(value)); else return Promise.resolve(value); },
    set(update, callback) { return save({ ...read(), ...update }, callback); },
    remove(keys, callback) { const next = read(); for (const key of [].concat(keys)) delete next[key]; return save(next, callback); }
  };
  window.chrome = { storage: { sync, onChanged: { addListener(fn) { listeners.push(fn); } } }, runtime: { lastError: null } };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.BTR_CHROME_PATH || undefined, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling"] });
  const errors = [];
  try {
    const context = await browser.newContext();
    await context.addInitScript(mockChrome);
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("http://127.0.0.1:18763/dev/media-record-test.html");
    await page.waitForFunction(() => __biliThreadRipperDebug.getPlayer() && __biliThreadRipperDebug.getStats().playerState === "ready");
    const history = () => page.evaluate(() => __BTR_RUNTIME_NOTICES__.history());
    // Waits for an event recorded at or after the given place in the record.
    const recorded = (name, detail, from = 0) => page.waitForFunction(([name, detail, from]) => __BTR_RUNTIME_NOTICES__.history()
      .slice(from).some(event => event.name === name && event.detail === detail), [name, detail, from]);

    await page.evaluate(() => __mediaTest.play());
    await page.waitForFunction(() => __biliThreadRipperDebug.getPlayer().video.currentTime > 1);
    await recorded("progress", "advancing");
    assert.ok((await history()).some(event => event.name === "playing"));
    console.log("PASS 真实播放时记下 playing 和 progress: advancing");

    // A picture that stops without an event: the time stands still and no timeupdate arrives.
    const before = (await history()).length;
    await page.evaluate(() => {
      const video = __biliThreadRipperDebug.getPlayer().video;
      const frozen = video.currentTime;
      Object.defineProperty(video, "currentTime", { configurable: true, get: () => frozen });
      window.__blockTimeupdate = event => event.stopPropagation();
      window.addEventListener("timeupdate", __blockTimeupdate, true);
    });
    await recorded("progress", "not advancing", before);
    await page.evaluate(() => {
      window.removeEventListener("timeupdate", __blockTimeupdate, true);
      delete __biliThreadRipperDebug.getPlayer().video.currentTime;
    });
    console.log("PASS 画面卡住又没有任何事件时，也记下 progress: not advancing");

    // After a switch of video, late events of the old element leave the record alone; the new
    // element's are recorded.
    await page.evaluate(() => {
      window.oldVideo = __biliThreadRipperDebug.getPlayer().video;
      history.pushState(null, "", "/video/BV1recordB002");
    });
    await page.waitForFunction(() => __mediaTest.calls.length === 2 && __biliThreadRipperDebug.getPlayer()?.video === __mediaTest.calls[1].video
      && __biliThreadRipperDebug.getStats().playerState === "ready");
    assert.equal(await page.evaluate(() => __mediaTest.calls[0].destroyed), true);
    await page.waitForTimeout(600);
    const settled = await history();
    await page.evaluate(() => { for (const name of ["playing", "waiting", "error", "pause"]) oldVideo.dispatchEvent(new Event(name)); });
    await page.waitForTimeout(600);
    assert.deepEqual(await history(), settled);
    await page.evaluate(() => __biliThreadRipperDebug.getPlayer().video.dispatchEvent(new Event("waiting")));
    assert.deepEqual((await history()).slice(settled.length).map(event => event.name), ["waiting"]);
    console.log("PASS 切换视频后，旧视频迟到的事件不进记录，新视频的事件照常记下");

    assert.deepEqual(errors, []);
    console.log("PASS 没有脚本错误");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
