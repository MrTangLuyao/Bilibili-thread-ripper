"use strict";
// 阻止使用国际版 for a signed-in viewer (#68). Bilibili's page code decides the site of a
// signed-in viewer by the account (its default_sites cookie) and not by user_site: with
// ["OVERSEAS"] it sends a domestic page on to the same page on the international site once
// it knows who is signed in. BTR used to send it back, Bilibili sent it away again, and after
// two trips BTR gave up and the tab stayed international. Now that navigation is cancelled.
// Space pages have an international site too (space.bilibili.com/en/2) and are taken back.
//
// Nothing reaches Bilibili: every request to its hosts is answered here. The pages run
// bilibili-site.js and bridge.js from src/, and a small copy of Bilibili's own rule
// (video-page.js, Wn/Zn): signed in, default_sites ["OVERSEAS"], a domestic page → the same
// page under /en, a moment after the page loaded (its nav request).
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const source = (file) => fs.readFileSync(path.join(root, "src", file), "utf8");

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<script src="/__btr/bilibili-site.js"></script>
<script src="/__btr/bridge.js"></script>
<script>
  // Bilibili's rule for a signed-in viewer, after its nav request.
  setTimeout(() => {
    const raw = (document.cookie.match(/(?:^|;\\s*)default_sites=([^;]*)/) || [])[1];
    let sites = [];
    try { sites = JSON.parse(decodeURIComponent(raw || "")); } catch (_error) {}
    const international = /^\\/(en|zh-Hans|zh-Hant|ja)(\\/|$)/i.test(location.pathname);
    if (sites.includes("OVERSEAS") && !sites.includes("CN") && !international) location.href = "/en" + location.pathname + location.search;
    else window.__bilibiliDone = true;
  }, 300);
</script></head><body>page</body></html>`;

async function run(browser, { block, start, signedIn = true, settingsDelayMs = 0, copy = null }) {
  const context = await browser.newContext();
  try {
    await context.addInitScript(({ settings, delay, copy }) => {
      // This site's copy of the settings, which decides until the manager answers.
      if (copy) localStorage.setItem("BTR_Userscript.sync", JSON.stringify(copy));
      window.chrome = {
        storage: {
          sync: { get(_defaults, callback) { setTimeout(() => callback({ ...settings }), delay); }, set() {}, remove() {} },
          local: { get(_defaults, callback) { queueMicrotask(() => callback({})); }, set() {} },
          onChanged: { addListener() {} }
        },
        runtime: { lastError: null }
      };
    }, { settings: { enabled: true, blockInternational: block }, delay: settingsDelayMs, copy });
    await context.route(/^https:\/\/(www|space)\.bilibili\.com\//, (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/__btr/")) return route.fulfill({ contentType: "text/javascript", body: source(url.pathname.slice(7)) });
      if (route.request().resourceType() !== "document") return route.abort();
      return route.fulfill({ contentType: "text/html", body: PAGE });
    });
    await context.route(/^(?!https:\/\/(www|space)\.bilibili\.com\/)/, (route) => route.abort());
    if (signedIn) await context.addCookies([{ name: "default_sites", value: encodeURIComponent(JSON.stringify(["OVERSEAS"])), domain: ".bilibili.com", path: "/" }]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const visited = [];
    page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) visited.push(frame.url()); });
    await page.goto(start);
    // Long enough for Bilibili's rule and BTR's trips back, twice over.
    await page.waitForTimeout(2500);
    const state = await page.evaluate(() => ({ href: location.href, blocked: Number(document.documentElement.dataset.btrSiteRedirectsBlocked) || 0, gaveUp: document.documentElement.dataset.btrSiteGaveUp === "true" }));
    const cookies = await context.cookies("https://www.bilibili.com/");
    return { ...state, visited, errors, defaultSites: cookies.find((cookie) => cookie.name === "default_sites")?.value, userSite: cookies.find((cookie) => cookie.name === "user_site")?.value };
  } finally { await context.close(); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.BTR_CHROME_PATH || undefined, headless: true });
  try {
    const video = "https://www.bilibili.com/video/BV1site000001/";
    const stays = await run(browser, { block: true, start: video });
    assert.deepEqual(stays.errors, []);
    assert.equal(stays.href, video, JSON.stringify(stays));
    assert.equal(stays.blocked, 1);
    assert.equal(stays.gaveUp, false);
    assert.equal(stays.defaultSites, encodeURIComponent(JSON.stringify(["OVERSEAS"])), "Bilibili's account cookie is left as it was");
    console.log("PASS 已登录、账号只能用国际版：开着阻止使用国际版时，视频页不再被 B 站送去国际版，B 站的 cookie 没被改");

    const back = await run(browser, { block: true, start: "https://www.bilibili.com/en/video/BV1site000001/" });
    assert.equal(back.href, video, JSON.stringify(back));
    assert.equal(back.gaveUp, false);
    console.log("PASS 从国际版地址进来：回到国内版后就停在那里，不再来回跳");

    const space = await run(browser, { block: true, start: "https://space.bilibili.com/en/2" });
    assert.equal(space.href, "https://space.bilibili.com/2", JSON.stringify(space));
    assert.equal(space.gaveUp, false);
    console.log("PASS 个人空间的国际版地址也回到国内版");

    const off = await run(browser, { block: false, start: video });
    assert.equal(off.href, "https://www.bilibili.com/en/video/BV1site000001/", JSON.stringify(off));
    assert.equal(off.blocked, 0);
    console.log("PASS 关着阻止使用国际版：B 站照常决定");

    // The manager answers after Bilibili's redirect: this site's copy of the settings decides.
    const late = await run(browser, { block: true, start: video, settingsDelayMs: 1000, copy: { enabled: true, blockInternational: true } });
    assert.equal(late.href, video, JSON.stringify(late));
    assert.equal(late.blocked, 1);
    const lateOff = await run(browser, { block: false, start: video, settingsDelayMs: 1000, copy: { enabled: true, blockInternational: false } });
    assert.equal(lateOff.href, "https://www.bilibili.com/en/video/BV1site000001/", JSON.stringify(lateOff));
    console.log("PASS 设置还没读到时，按这个网站保存的设置副本决定");

    const signedOut = await run(browser, { block: true, start: "https://www.bilibili.com/en/video/BV1site000001/", signedIn: false });
    assert.equal(signedOut.href, video, JSON.stringify(signedOut));
    assert.equal(signedOut.userSite, "CN");
    console.log("PASS 没登录时和以前一样：回到国内版并记住 user_site=CN");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
