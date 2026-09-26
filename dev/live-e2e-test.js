"use strict";
// End-to-end: runs a build of the userscript in Chrome (in every frame, at document start,
// as a script manager would), opens a real live room on live.bilibili.com and checks that
// the live module takes over inside the player frame (many rooms embed the player in a
// live.bilibili.com/blanc iframe). Needs network; not part of the default regression run.
//   BTR_CHROME_PATH  browser executable (default: Chrome)
//   BTR_E2E_ROOM     room id (default: picked from the recommend API)
//   BTR_E2E_SECONDS  observation window (default 25)
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36", "Referer": "https://live.bilibili.com/" };

async function pickRoom() {
  if (process.env.BTR_E2E_ROOM) return Number(process.env.BTR_E2E_ROOM);
  const payload = await fetch("https://api.live.bilibili.com/room/v1/room/get_user_recommend?page=1&page_size=6", { headers: HEADERS }).then((r) => r.json());
  const room = (payload.data || [])[0];
  if (!room?.roomid) throw new Error("no live room from the recommend API");
  return room.roomid;
}

(async () => {
  const roomid = await pickRoom();
  const seconds = Number(process.env.BTR_E2E_SECONDS) || 25;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "btr-e2e-"));
  const { buildUserscript, latestTag } = await import(pathToFileURL(path.join(root, "scripts/build.mjs")).href);
  const browser = await chromium.launchPersistentContext(userDataDir, {
    executablePath: process.env.BTR_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"]
  });
  const script = buildUserscript(latestTag());
  await browser.addInitScript({ content: script });
  // addInitScript does not reach the live.bilibili.com/blanc player iframe, where a script
  // manager does run the script. Those frames get it as soon as they have navigated, which
  // is a little later than a manager would start it.
  browser.on("page", (tab) => tab.on("framenavigated", (frame) => {
    if (frame === tab.mainFrame() || !frame.url().startsWith("https://live.bilibili.com/")) return;
    frame.evaluate((source) => {
      if (!document.documentElement?.hasAttribute("data-btr-userscript")) (0, eval)(source);
    }, script).catch(() => {});
  }));
  try {
    const page = await browser.newPage();
    console.log(`opening room ${roomid}`);
    await page.goto(`https://live.bilibili.com/${roomid}`, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Find the frame in which the live module took over (top page or the blanc iframe).
    const readDebug = async () => {
      for (const frame of page.frames()) {
        if (!frame.url().includes("live.bilibili.com")) continue;
        try {
          const debug = await frame.evaluate(() => {
            const api = window.__biliThreadRipperLiveDebug;
            const video = document.querySelector("video");
            return api ? {
              context: api.getContext(),
              stats: api.getStats(),
              hasVideo: Boolean(video),
              currentTime: video ? video.currentTime : -1,
              isBlanc: window.top !== window
            } : null;
          });
          if (debug?.context) return { frameUrl: frame.url(), ...debug };
        } catch (_error) {}
      }
      return null;
    };

    let first = null;
    const findDeadline = Date.now() + 60000;
    while (Date.now() < findDeadline && !first) {
      first = await readDebug();
      if (!first) await page.waitForTimeout(1000);
    }
    assert.ok(first, "the live module never took over any frame (no context observed)");
    console.log(`taken over in ${first.isBlanc ? "blanc iframe" : "top page"}: ${first.frameUrl.slice(0, 80)}`);
    console.log(`initial: cached=${first.context.cached} lastNum=${first.context.lastNum} requests=${first.stats.acceleratedRequests}`);

    // Skip the startup buffering, then measure steady playback.
    await page.waitForTimeout(10000);
    const mid = await readDebug();
    assert.ok(mid, "the live module context disappeared during startup");
    await page.waitForTimeout(seconds * 1000);
    const last = await readDebug();
    assert.ok(last, "the live module context disappeared during playback");
    const served = last.stats.acceleratedRequests - first.stats.acceleratedRequests;
    const advanced = last.currentTime - mid.currentTime;
    console.log(`after ${seconds + 10}s: cached=${last.context.cached} requests=${last.stats.acceleratedRequests} (+${served}) bytes=${(last.stats.acceleratedBytes / 1048576).toFixed(1)}MB`);
    console.log(`steady playback advanced ${advanced.toFixed(1)}s in ${seconds}s; lastError=${JSON.stringify(last.stats.lastError)}`);
    console.log("pool:", last.context.hosts.map((h) => `${h.host.split(".")[0]}=${h.state}`).join(" "));

    assert.ok(last.hasVideo, "no <video> in the taken-over frame");
    assert.ok(served >= Math.min(8, seconds / 2), `too few segments served by the module: ${served}`);
    assert.ok(advanced >= seconds * 0.75, `playback stalled: advanced ${advanced.toFixed(1)}s of ${seconds}s steady window`);
    assert.ok(last.context.hosts.some((h) => h.state === "healthy"), "no healthy host in the pool");
    console.log("PASS live end-to-end: module active in the player frame, segments served, playback smooth");
  } finally {
    await browser.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error("FAIL", error); process.exitCode = 1; });
