"use strict";
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

function mockChrome() {
  const listeners = [];
  const read = name => JSON.parse(localStorage.getItem(`errors-${name}`) || (name === "local" ? '{"btrOnboardingRevision":"native-progressive-mse-v1"}' : "{}"));
  const publish = (previous, next, name) => {
    const changes = {};
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changes[key] = { oldValue: previous[key], newValue: next[key] };
    if (Object.keys(changes).length) listeners.forEach(fn => fn(changes, name));
  };
  const area = name => ({
    get(defaults, callback) { const value = { ...(defaults || {}), ...read(name) }; if (callback) queueMicrotask(() => callback(value)); else return Promise.resolve(value); },
    set(update, callback) { const previous = read(name), next = { ...previous, ...update }; localStorage.setItem(`errors-${name}`, JSON.stringify(next)); queueMicrotask(() => { publish(previous, next, name); callback?.(); }); return Promise.resolve(); },
    remove(keys) { const previous = read(name), next = { ...previous }; for (const key of [].concat(keys)) delete next[key]; localStorage.setItem(`errors-${name}`, JSON.stringify(next)); queueMicrotask(() => publish(previous, next, name)); return Promise.resolve(); }
  });
  addEventListener("storage", event => { if (event.key?.startsWith("errors-")) publish(JSON.parse(event.oldValue || "{}"), JSON.parse(event.newValue || "{}"), event.key.slice(7)); });
  window.chrome = {
    storage: { sync: area("sync"), local: area("local"), onChanged: { addListener(fn) { listeners.push(fn); } } },
    runtime: { lastError: null, onMessage: { addListener() {} }, sendMessage() { return Promise.resolve({}); } },
    tabs: { query() { return Promise.resolve([{ id: 1 }]); }, sendMessage() { return Promise.resolve({}); } }
  };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.BTR_CHROME_PATH || undefined, headless: true, args: ["--disable-background-timer-throttling"] });
  const errors = [];
  const origin = "http://127.0.0.1:18763";
  // The settings panel opens inside a bilibili page; this tab is one without a video.
  const openSettings = async (tab, navigate = true) => {
    if (navigate) await tab.goto(origin + "/dev/notification-home-test.html");
    await tab.evaluate(() => setTimeout(() => document.dispatchEvent(new CustomEvent("btr-userscript-open-settings")), 50));
    await tab.locator("#__bilibili_thread_ripper_settings__ .btr-popup").waitFor();
    // The settings these tests use are under 高级设置, a page of its own opened from the main one.
    const advanced = tab.locator("#__bilibili_thread_ripper_settings__ #advanced");
    if (!(await advanced.evaluate(node => node.open))) await advanced.locator("summary").click();
    // They are under its 功能 tab.
    await tab.locator('#__bilibili_thread_ripper_settings__ [role="tab"][data-tab="features"]').click();
  };
  const red = '.bubble[data-level="error"]:not(.leaving)';
  try {
    const context = await browser.newContext({ viewport: { width: 640, height: 900 } });
    await context.addInitScript(mockChrome);
    const page = await context.newPage(), popup = await context.newPage(), home = await context.newPage();
    for (const tab of [page, popup, home]) tab.on("pageerror", error => errors.push(error.message));
    await popup.setViewportSize({ width: 410, height: 900 });
    await page.goto(origin + "/dev/notification-test.html");
    await openSettings(popup);
    await page.waitForFunction(() => __biliThreadRipperDebug.getPlayer());
    // One switch is left, Debug 模式, off by default; 显示错误 and the message filters are gone,
    // and 复制诊断信息 is always there.
    assert.equal(await popup.locator("#debug-notices").isChecked(), false);
    assert.equal(await popup.locator("#error-notices, #debug-filters, [data-debug-category]").count(), 0);
    assert.equal(await popup.locator("#debug-copy").isVisible(), true);
    assert.equal(await popup.locator("#thread-value").textContent(), "自动");
    assert.equal(await page.evaluate(() => __biliThreadRipperDebug.getSettings().concurrency), 8);
    // Off, nothing shows on the screen, errors included; every message is still sent to the
    // page, for the diagnostic copy, and download addresses stay out of them.
    await page.evaluate(() => {
      __BTR_RUNTIME_NOTICES__.log("需要保留的错误", "测试普通信息不会淹没错误。", "error");
      for (let i = 0; i < 100; i++) __BTR_RUNTIME_NOTICES__.log("普通信息 " + i, "Debug 关闭时也要记下");
      const options = __noticeTest.calls.at(-1).options;
      const id = options.onTransfer({ phase: "start", kind: "video", url: "https://example.bilivideo.com/v.m4s?token=PRIVATE", totalBytes: 65536 });
      options.onTransfer({ phase: "error", id, error: new Error("下载失败") });
      const video = __biliThreadRipperDebug.getPlayer().video;
      video.src = "data:video/mp4;base64,AA==";
      video.load();
    });
    await page.waitForFunction(() => __noticeTest.messages.filter(item => item.type === "debug-notices").flatMap(item => item.payload).some(item => item.title === "视频播放出错了"));
    await page.waitForTimeout(750);
    const recorded = await page.evaluate(() => __noticeTest.messages.filter(item => item.type === "debug-notices").flatMap(item => item.payload));
    assert(recorded.some(item => item.title === "开始下载一小段数据" && item.category === "download"));
    assert(recorded.some(item => item.title === "这一小段没能下载下来" && item.level === "error"));
    assert(recorded.some(item => item.title === "需要保留的错误"));
    assert(recorded.some(item => item.level !== "error" && item.title.startsWith("普通信息")));
    assert(!JSON.stringify(recorded).includes("PRIVATE"));
    assert.equal(await page.locator(".bubble").count(), 0);
    assert.equal(await page.evaluate(() => __noticeTest.messages.filter(item => item.type === "playback-notice").length), 0);
    // The box of a failed takeover stays hidden too.
    await home.goto(origin + "/dev/notification-home-test.html");
    await home.evaluate(() => window.postMessage({ channel: "__BILI_RANGE_ACCELERATOR_V1__", type: "stats", payload: { playerState: "error", takeoverError: { id: "test-error-switch", at: Date.now(), message: "失败测试", stage: "playinfo", retryCount: 1 } } }, "*"));
    await home.waitForTimeout(250);
    assert.equal(await home.locator("#__bilibili_thread_ripper_error_notice__").count(), 0);
    console.log("PASS 只剩 Debug 模式一个开关，默认关闭；关着时屏幕上什么都不显示，消息照常记录");

    // On, every message shows, errors and all kinds included, with the playback state; the
    // switch does not take the video over again.
    await popup.locator("#debug-notices").check();
    await page.waitForFunction(() => __biliThreadRipperDebug.getSettings().debugNotices === true);
    await page.locator(".mode").first().waitFor();
    await page.waitForTimeout(500);
    await page.evaluate(() => __BTR_RUNTIME_NOTICES__.log("Debug 下的错误", "也要显示", "error", "", "", "download"));
    await page.waitForTimeout(500);
    assert((await page.locator(red).count()) >= 1);
    // Every kind of message shows; two at a time, as the stack only keeps what fits the window.
    const visibleTitles = async () => (await page.locator(".debug:not(.leaving) .detail").allTextContents()).map(text => text.split(String.fromCharCode(10))[0]);
    for (const pair of [["takeover", "playback"], ["download", "buffer"], ["settings", "other"]]) {
      await page.evaluate(pair => { for (const category of pair) __BTR_RUNTIME_NOTICES__.log("分类 " + category, "全部显示", "info", "", "", category); }, pair);
      await page.waitForTimeout(400);
      const titles = await visibleTitles();
      for (const category of pair) assert(titles.includes("分类 " + category), JSON.stringify(titles));
    }
    // The download threads never take more than two places, so the rest stays readable.
    await page.evaluate(() => { __BTR_RUNTIME_NOTICES__.log("接管消息", "不能被下载消息挤掉", "info", "", "", "takeover"); for (let i = 0; i < 12; i++) __BTR_RUNTIME_NOTICES__.log("下载流水 " + i, "", "info", "flood-" + i, "", "download"); });
    await page.waitForTimeout(500);
    const afterFlood = (await page.locator('.debug:not(.leaving):not([data-level="error"]) .detail').allTextContents()).map(text => text.split(String.fromCharCode(10))[0]);
    assert(afterFlood.includes("接管消息") && afterFlood.filter(title => title.startsWith("下载流水")).length <= 2, JSON.stringify(afterFlood));
    assert((await page.locator(".bubble:not(.leaving) .heading").allTextContents()).every(title => title === "BTR Debug"));
    assert.equal(await page.locator("#__btr_notification_stack__ .stack").evaluate(node => getComputedStyle(node).userSelect), "none");
    assert.equal(await page.evaluate(() => __noticeTest.calls.length), 1);
    console.log("PASS 打开 Debug 模式后所有消息都显示，错误也在内，切换开关不重新接管视频");

    // The box of a failed takeover shows with it.
    const takeoverNotice = home.locator("#__bilibili_thread_ripper_error_notice__");
    await takeoverNotice.waitFor({ state: "visible" });
    assert.equal(await takeoverNotice.locator(".btr-error-title").innerText(), "BTR 提示");
    await takeoverNotice.locator(".btr-error-toggle").click();
    assert.equal(await takeoverNotice.getAttribute("data-expanded"), "true");
    assert.match(await takeoverNotice.locator(".btr-error-log").textContent(), /失败测试/);
    assert.match(await takeoverNotice.locator(".btr-error-log").textContent(), /playinfo/);
    // The box cannot be selected as text, only its log, which is there to be copied.
    assert.deepEqual(await takeoverNotice.evaluate(node => [getComputedStyle(node).userSelect, getComputedStyle(node.querySelector(".btr-error-log")).userSelect]), ["none", "text"]);
    await home.evaluate(() => {
      window.__retryObserved = false;
      addEventListener("message", event => {
        if (event.source === window && event.data?.channel === "__BILI_RANGE_ACCELERATOR_V1__" && event.data.type === "retry-takeover") window.__retryObserved = true;
      });
    });
    await takeoverNotice.locator(".btr-error-retry").click();
    await home.waitForFunction(() => window.__retryObserved);
    await home.evaluate(() => window.postMessage({ channel: "__BILI_RANGE_ACCELERATOR_V1__", type: "stats", payload: { playerState: "ready", takeoverError: null } }, "*"));
    await takeoverNotice.waitFor({ state: "detached" });
    await home.evaluate(() => window.postMessage({ channel: "__BILI_RANGE_ACCELERATOR_V1__", type: "stats", payload: { playerState: "error", takeoverError: { id: "test-error-again", at: Date.now(), message: "失败测试", stage: "playinfo", retryCount: 1 } } }, "*"));
    await takeoverNotice.waitFor({ state: "visible" });

    // Off again, everything shown goes away, and late messages stay hidden.
    await popup.locator("#debug-notices").uncheck();
    await takeoverNotice.waitFor({ state: "detached" });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      __BTR_RUNTIME_NOTICES__.log("关闭后的错误", "不应显示", "error");
      window.postMessage({ channel: "__BILI_RANGE_ACCELERATOR_V1__", type: "debug-notices", payload: [{ key: "late-error", level: "error", title: "迟到的错误也不应显示" }] }, "*");
    });
    await page.waitForTimeout(800);
    assert.equal(await page.locator(".bubble:not(.leaving)").count(), 0, JSON.stringify(await page.evaluate(() => [...document.getElementById("__btr_notification_stack__")?.shadowRoot.querySelectorAll(".bubble") || []].map(node => ({ text: node.textContent, class: node.className })))));
    console.log("PASS 接管失败的提示框跟 Debug 模式一起显示和关闭，关闭后迟到的消息也不显示");

    // Kept across reloads; the settings of 显示错误 and of the filters left by earlier versions
    // are removed from the storage.
    await popup.locator("#debug-notices").check();
    await page.waitForFunction(() => __biliThreadRipperDebug.getSettings().debugNotices === true);
    await page.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem("errors-sync") || "{}");
      localStorage.setItem("errors-sync", JSON.stringify({ ...stored, errorNotices: true, debugCategories: { download: false } }));
    });
    await page.goto(origin + "/dev/notification-test.html");
    await page.waitForFunction(() => __biliThreadRipperDebug.getPlayer());
    await page.waitForFunction(() => { const stored = JSON.parse(localStorage.getItem("errors-sync") || "{}"); return !("errorNotices" in stored) && !("debugCategories" in stored) && stored.debugNotices === true; });
    assert.deepEqual(await page.evaluate(() => { const value = __biliThreadRipperDebug.getSettings(); return ["errorNotices" in value, "debugCategories" in value, value.debugNotices]; }), [false, false, true]);
    await popup.reload();
    await openSettings(popup, false);
    assert.equal(await popup.locator("#debug-notices").isChecked(), true);
    await popup.screenshot({ path: "dist/debug-switch-preview.png" });
    await popup.locator("#debug-notices").uncheck();
    console.log("PASS Debug 模式刷新后保留，旧版的显示错误和分类设置会从存储里删掉");

    const priority = await context.newPage();
    priority.on("pageerror", error => errors.push(error.message));
    await priority.goto(origin + "/dev/notification-flow-test.html");
    const bornAt = Date.now();
    await priority.evaluate(() => {
      __BTR_NOTIFICATION_VIEW__.configure({ enabled: true, debugNotices: true });
      __BTR_NOTIFICATION_VIEW__.logs([{ key: "sticky", title: "应保留二十秒的错误", detail: "新来的普通消息不能把它挤掉。", level: "error" }]);
      const node = document.getElementById("__btr_notification_stack__").shadowRoot.querySelector('[data-level="error"]');
      const originalText = node.textContent;
      window.errorAudit = { frames: 0, failures: [], id: node.parentElement.dataset.id, originalText };
      let last = node.getBoundingClientRect().top;
      function inspect() {
        if (!node.isConnected) return;
        errorAudit.frames++;
        const top = node.getBoundingClientRect().top;
        if (top > last + .6) errorAudit.failures.push("error moved down");
        if (node.textContent !== originalText) errorAudit.failures.push("error text changed");
        last = top;
        requestAnimationFrame(inspect);
      }
      requestAnimationFrame(inspect);
    });
    await priority.waitForTimeout(700);
    await priority.evaluate(async () => {
      for (let i = 0; i < 80; i++) {
        __BTR_NOTIFICATION_VIEW__.logs([{ key: "normal", title: "普通新消息 " + i, detail: "仅向上流动", level: "info" }]);
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    });
    await priority.waitForTimeout(800);
    assert.equal(await priority.locator(red).count(), 1);
    const protectedBox = await priority.locator(red).boundingBox();
    const ordinary = await priority.locator('.debug:not(.leaving):not([data-level="error"])').evaluateAll(nodes => nodes.filter(node => getComputedStyle(node.parentElement).visibility !== "hidden").map(node => node.getBoundingClientRect().top));
    assert(ordinary.length && ordinary.every(top => top >= protectedBox.y + protectedBox.height + 6));
    assert(protectedBox.y >= 14);
    await priority.screenshot({ path: "dist/protected-errors-preview.png" });
    await priority.waitForTimeout(7500);
    assert.equal(await priority.locator(red).count(), 1);
    assert.equal(await priority.locator(red).evaluate(node => node.parentElement.dataset.id), await priority.evaluate(() => errorAudit.id));
    console.log("PASS 80 条普通消息不能挤走顶部错误，普通消息过期后错误仍保留且没有下移或改写");
    await priority.waitForTimeout(Math.max(0, 21000 - (Date.now() - bornAt)));
    assert.equal(await priority.locator(red).count(), 0);
    const audit = await priority.evaluate(() => errorAudit);
    assert(audit.frames > 100);
    assert.deepEqual(audit.failures, []);
    console.log("PASS 红色消息实际保留二十秒后淡出，可用点击提前关闭");

    await priority.evaluate(() => {
      __BTR_NOTIFICATION_VIEW__.logs([{ key: "batch-red", title: "不能被同一批普通日志吞掉", level: "error" }, ...Array.from({ length: 100 }, (_, i) => ({ key: String(i), title: "普通信息 " + i }))]);
    });
    assert.equal(await priority.locator(red).count(), 1);
    await priority.locator(red).click();
    await priority.waitForTimeout(650);
    assert.equal(await priority.locator(red).count(), 0);
    await priority.setViewportSize({ width: 360, height: 420 });
    await priority.evaluate(() => { for (let i = 0; i < 50; i++) __BTR_NOTIFICATION_VIEW__.logs([{ title: "连续错误 " + i, detail: "这是需要显示的错误。".repeat(8), level: "error" }]); });
    await priority.waitForTimeout(800);
    const boxes = await priority.locator(red).evaluateAll(nodes => nodes.map(node => ({ top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom })));
    assert(boxes.length >= 1 && boxes.length <= 3 && boxes.every(box => box.top >= 0 && box.bottom <= 420));
    assert((await priority.locator(red).last().innerText()).includes("连续错误 49"));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ errorRetentionMs: 20000, downwardMoves: audit.failures.length, frameChecks: audit.frames, errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
