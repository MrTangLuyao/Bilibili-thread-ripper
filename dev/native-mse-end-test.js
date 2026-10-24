"use strict";
// Needs dev/server.js started with BTR_TEST_BVID and BTR_TEST_CID (real bilibili media).
// Runs native-mse-test.html with each video codec (startup, seek, playing to the end) and
// native-mse-quality-test.html (following the quality chosen in Bilibili's menu).
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const cases = [
  "",
  "?codec=hevc",
  "?codec=avc",
  "?codec=av1",
  // Browsers refuse a shorter duration once HEVC frames run past it. The end must not depend on it.
  "?codec=hevc&strictDuration=1",
  "?codec=av1&strictDuration=1",
  "native-mse-quality-test.html"
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.BTR_CHROME_PATH || undefined, headless: true });
  let failed = false;
  try {
    // A browser without an HEVC decoder (a machine without a GPU, most Linux builds) cannot
    // play those cases at all: they are skipped instead of timing out.
    const probe = await browser.newPage();
    const hevc = await probe.evaluate(() => MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L150.90"'));
    await probe.close();
    const runnable = cases.filter((query) => hevc || !query.includes("codec=hevc"));
    for (const query of cases) if (!runnable.includes(query)) console.log(`SKIP ${query}：这个浏览器放不了 HEVC`);
    for (let offset = 0; offset < runnable.length; offset += 3) {
      const results = await Promise.allSettled(runnable.slice(offset, offset + 3).map(async (query) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(`http://127.0.0.1:18763/dev/${query.endsWith(".html") ? query : `native-mse-test.html${query}`}`);
          const result = page.locator("#native-mse-result");
          await page.waitForFunction(() => document.getElementById("native-mse-result")?.dataset.pass, null, { timeout: 90000 });
          const output = JSON.parse(await result.innerText());
          assert.equal(output.pass, true, JSON.stringify(output));
          assert.deepEqual(errors, []);
          if (output.summary) return `PASS ${query}：${output.summary}`;
          return `PASS ${query || "(默认编码)"}：${output.codec}，从 ${output.endTarget.toFixed(1)} 秒播到结尾 ${output.endDuration.toFixed(3)} 秒并正常结束`;
        } finally {
          await context.close();
        }
      }));
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") console.log(result.value);
        else { failed = true; console.error(`FAIL ${runnable[offset + index] || "(默认编码)"}\n${result.reason?.message || result.reason}`); }
      }
    }
  } finally {
    await browser.close();
  }
  if (failed) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
