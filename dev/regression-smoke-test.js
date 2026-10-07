"use strict";
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.BTR_CHROME_PATH || undefined, headless: true });
  const tests = [
    ["navigation-test.html", "navigation-result"],
    ["multipart-navigation-test.html", "multipart-navigation-result"],
    ["interactive-navigation-test.html", "interactive-navigation-result"],
    ["takeover-error-test.html", "takeover-error-result"],
    ["floating-button-test.html", "result"],
    ["mse-abort-test.html", "mse-abort-result"],
    ["quality-sync-test.html", "quality-sync-result"],
    ["info-panel-test.html", "info-panel-result"],
    ["fast-takeover-test.html", "fast-takeover-result"],
    ["buffer-window-test.html", "buffer-window-result"],
    ["autoplay-choice-test.html", "autoplay-choice-result"],
    ["codec-choice-test.html", "codec-choice-result"],
    ["takeover-mode-test.html", "takeover-mode-result"],
    // Several scenarios that wait for buffer checks and rebuffering, hence the longer limit.
    ["quota-refresh-test.html", "quota-refresh-result", 90000],
    ["address-refresh-test.html", "address-refresh-result", 40000],
    ["live-hook-test.html", "live-hook-result"],
    ["buffered-shim-test.html", "buffered-shim-result"]
  ];
  try {
    for (let offset = 0; offset < tests.length; offset += 3) {
      const results = await Promise.allSettled(tests.slice(offset, offset + 3).map(async ([file, id, timeout = 20000]) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        if (file === "mse-abort-test.html") {
          // Cancellation happens before sourceopen. Supply only a valid manifest;
          // no actual media response or network success is faked in this test.
          const representation = (mimeType, codecs) => ({ id: 80, mimeType, codecs, baseUrl: "https://test.bilivideo.com/abort.m4s", segment_base: { initialization: "0-1", index_range: "2-3" } });
          await page.route("**/playinfo", route => route.fulfill({ json: { data: { dash: { duration: 10, video: [representation("video/mp4", "avc1.640028")], audio: [representation("audio/mp4", "mp4a.40.2")] } } } }));
        }
        try {
          await page.goto(`http://127.0.0.1:18763/dev/${file}`);
          await page.waitForFunction(id => document.getElementById(id)?.dataset.pass === "true", id, { timeout });
          // The navigation fixtures emit early snapshots: wait past stale callbacks.
          await page.waitForTimeout(1200);
          const result = JSON.parse(await page.locator(`#${id}`).innerText());
          assert.equal(result.pass, true, JSON.stringify(result));
          assert.deepEqual(errors, []);
          console.log(`PASS ${file}`);
        } catch (error) {
          console.error(file, await page.locator(`#${id}`).textContent().catch(() => "missing result"), errors);
          throw error;
        } finally { await context.close(); }
      }));
      for (const result of results) if (result.status === "rejected") throw result.reason;
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
