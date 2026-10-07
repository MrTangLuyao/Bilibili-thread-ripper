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
    assert.equal(await popup.locator("#error-notices").isChecked(), false);
    assert.equal(await popup.locator("#debug-notices").isChecked(), false);
    assert.equal(await popup.locator("#debug-filters").isVisible(), false);
    assert.equal(await popup.locator("[data-debug-category]:checked").count(), 6);
    assert.equal(await popup.locator("#thread-value").textContent(), "自动");
    assert.equal(await page.evaluate(() => __biliThreadRipperDebug.getSettings().errorNotices), false);
    assert.equal(await page.evaluate(() => __biliThreadRipperDebug.getSettings().concurrency), 8);
    // Red errors stay hidden until the user turns the switch on.
    await page.evaluate(() => __BTR_RUNTIME_NOTICES__.log("默认不显示的错误", "显示错误默认关闭", "error"));
    await page.waitForTimeout(600);
    assert.equal(await page.locator(".bubble").count(), 0);
    assert.equal(await page.evaluate(() => __noticeTest.messages.filter(item => item.type === "debug-notices").length), 0);
    console.log("PASS 显示错误默认关闭，线程数默认 8，红色错误不显示");
    await popup.locator("#error-notices").check();
    await page.waitForFunction(() => __biliThreadRipperDebug.getSettings().errorNotices === true);
    await page.evaluate(() => {
      __BTR_RUNTIME_NOTICES__.log("需要保留的错误", "测试普通信息不会淹没错误。", "error");
      for (let i = 0; i < 100; i++) __BTR_RUNTIME_NOTICES__.log("普通信息 " + i, "不应在非 Debug 模式显示");
      const options = __noticeTest.calls.at(-1).options;
      const id = options.onTransfer({ phase: "start", kind: "video", url: "https://example.bilivideo.com/v.m4s?token=PRIVATE", totalBytes: 65536 });
      options.onTransfer({ phase: "error", id, error: new Error("下载失败") });
      const video = __biliThreadRipperDebug.getPlayer().video;
      video.src = "data:video/mp4;base64,AA==";
      video.load();
    });
    await page.waitForFunction(() => __noticeTest.messages.filter(item => item.type === "debug-notices").flatMap(item => item.payload).some(item => item.title === "视频播放出错了"));
    await page.waitForTimeout(750);
    const delivered = await page.evaluate(() => __noticeTest.messages.filter(item => item.type === "debug-notices").flatMap(item => item.payload));
    assert(delivered.every(item => item.level === "error"));
    assert(delivered.some(item => item.title === "这一小段没能下载下来"));
    assert(delivered.some(item => item.title === "需要保留的错误"));
    assert(!JSON.stringify(delivered).includes("PRIVATE"));
    assert((await page.locator(red).count()) >= 1);
    assert((await page.locator(red + " .heading").allTextContents()).every(title => title === "BTR 提示"));
    assert.equal(await page.locator(".mode").count(), 0);
    console.log("PASS 打开显示错误后，Debug 关闭时仍捕获真实媒体错误与 Range 下载错误，仅显示红色");

    await popup.locator("#error-notices").uncheck();
    await page.waitForTimeout(800);
    assert.equal(await page.locator(".bubble").count(), 0, JSON.stringify(await page.evaluate(() => ({ settings: __biliThreadRipperDebug.getSettings(), stored: localStorage.getItem("errors-sync"), bubbles: [...document.getElementById("__btr_notification_stack__")?.shadowRoot.querySelectorAll(".bubble") || []].map(node => ({ text: node.textContent, class: node.className })) }))) + JSON.stringify(errors));
    await popup.locator("#debug-notices").check();
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      __BTR_RUNTIME_NOTICES__.log("隐藏错误测试", "不应显示", "error");
      __BTR_RUNTIME_NOTICES__.log("允许的普通信息", "Debug 正常开启", "success");
      window.postMessage({ channel: "__BILI_RANGE_ACCELERATOR_V1__", type: "debug-notices", payload: [{ key: "late-error", level: "error", title: "迟到的错误也不应显示" }] }, "*");
    });
    await page.waitForTimeout(750);
    assert.equal(await page.locator(red).count(), 0);
    assert((await page.locator('.bubble[data-level="success"]').count()) >= 1);
    assert.equal(await page.evaluate(() => __noticeTest.calls.length), 1);
    assert.equal(await page.evaluate(() => __biliThreadRipperDebug.getSettings().errorNotices), false);
    console.log("PASS 显示错误独立关闭，即使 Debug 开启也过滤红色及迟到消息，切换开关不重新接管视频");

    await home.goto(origin + "/dev/notification-home-test.html");
    await home.evaluate(() => window.postMessage({ channel: "__BILI_RANGE_ACCELERATOR_V1__", type: "stats", payload: { playerState: "error", takeoverError: { id: "test-error-switch", at: Date.now(), message: "失败测试", stage: "playinfo", retryCount: 1 } } }, "*"));
    await home.waitForTimeout(250);
    assert.equal(await home.locator("#__bilibili_thread_ripper_error_notice__").count(), 0);
    await popup.locator("#error-notices").check();
    await home.locator("#__bilibili_thread_ripper_error_notice__").waitFor({ state: "visible" });
    await popup.locator("#error-notices").uncheck();
    await home.locator("#__bilibili_thread_ripper_error_notice__").waitFor({ state: "detached" });
    await page.goto(origin + "/dev/notification-test.html");
    await popup.reload();
    await openSettings(popup, false);
    await page.waitForFunction(() => __biliThreadRipperDebug.getPlayer());
    assert.equal(await popup.locator("#error-notices").isChecked(), false);
    assert.equal(await page.evaluate(() => __biliThreadRipperDebug.getSettings().errorNotices), false);
    await popup.locator("#error-notices").check();
    await popup.locator("#debug-notices").uncheck();
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      __BTR_RUNTIME_NOTICES__.log("切换后仍显示错误", "独立开关生效", "error");
      __BTR_RUNTIME_NOTICES__.log("普通日志不可显示", "", "info");
    });
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.bubble:not([data-level="error"])').count(), 0);
    assert.equal(await page.locator(red).count(), 1);
    await popup.screenshot({ path: "dist/error-switch-preview.png" });
    console.log("PASS 原有接管错误框受同一开关控制，刷新与重开设置面板保存设置，Debug 开关互不干扰");

    await popup.locator("#debug-notices").check();
    assert.equal(await popup.locator("#debug-filters").isVisible(), true);
    assert.equal(await popup.locator("[data-debug-category]:checked").count(), 6);
    const categories = ["takeover", "playback", "download", "buffer", "settings", "other"];
    for (const category of categories) {
      await popup.locator("#debug-select-none").click();
      await popup.locator(`[data-debug-category="${category}"]`).check();
      await page.waitForFunction(category => {
        const values = __biliThreadRipperDebug.getSettings().debugCategories;
        return values[category] && Object.values(values).filter(Boolean).length === 1;
      }, category);
      await page.waitForTimeout(250);
      await page.evaluate(categories => {
        __noticeTest.messages.length = 0;
        for (const category of categories) __BTR_RUNTIME_NOTICES__.log(`分类测试 ${category}`, "仅勾选的分类可以显示", "info", "", "", category);
      }, categories);
      await page.waitForTimeout(300);
      const shown = await page.evaluate(() => __noticeTest.messages.filter(item => item.type === "debug-notices").flatMap(item => item.payload).filter(item => item.title.startsWith("分类测试")));
      assert.deepEqual(shown.map(item => item.category), [category]);
      if (category === "download") {
        await page.evaluate(() => {
          const options = __noticeTest.calls.at(-1).options;
          const id = options.onTransfer({ phase: "start", kind: "video", url: "https://example.bilivideo.com/d.m4s", totalBytes: 100 });
          options.onTransfer({ phase: "progress", id, bytes: 50 });
          options.onTransfer({ phase: "done", id });
        });
        await page.waitForTimeout(300);
        const transfers = await page.evaluate(() => __noticeTest.messages.filter(item => item.type === "debug-notices").flatMap(item => item.payload).filter(item => item.title.includes("下载") || item.title.includes("接收视频")));
        assert(transfers.length >= 3 && transfers.every(item => item.category === "download"));
      }
    }
    console.log("PASS Debug 展开六项且默认全选，逐项勾选只显示对应分类，下载线程实际回调分类正确");
    await popup.locator("#debug-select-none").click();
    await page.waitForFunction(() => Object.values(__biliThreadRipperDebug.getSettings().debugCategories).every(value => !value));
    await page.waitForTimeout(750);
    await page.evaluate(() => {
      __noticeTest.messages.length = 0;
      __BTR_RUNTIME_NOTICES__.log("取消全部分类仍显示错误", "错误由独立开关控制", "error", "", "", "download");
      __BTR_RUNTIME_NOTICES__.log("全不选时不能显示普通消息", "", "info", "", "", "download");
      window.postMessage({ channel: "__BILI_RANGE_ACCELERATOR_V1__", type: "debug-notices", payload: [{ category: "download", title: "已经取消的迟到日志", level: "info" }] }, "*");
    });
    await page.waitForTimeout(750);
    const filtered = await page.evaluate(() => __noticeTest.messages.filter(item => item.type === "debug-notices").flatMap(item => item.payload).filter(item => item.title !== "已经取消的迟到日志"));
    assert(filtered.length === 1 && filtered[0].level === "error");
    assert.equal(await page.locator('.debug:not(.leaving):not([data-level="error"])').count(), 0);
    await popup.locator('[data-debug-category="buffer"]').check();
    await page.waitForFunction(() => __biliThreadRipperDebug.getSettings().debugCategories.buffer === true);
    await popup.locator("#debug-notices").uncheck();
    assert.equal(await popup.locator("#debug-filters").isVisible(), false);
    await popup.reload();
    await openSettings(popup, false);
    await popup.locator("#debug-notices").check();
    assert.equal(await popup.locator("[data-debug-category]:checked").count(), 1);
    assert.equal(await popup.locator('[data-debug-category="buffer"]').isChecked(), true);
    await page.goto(origin + "/dev/notification-test.html");
    await page.waitForFunction(() => __biliThreadRipperDebug.getPlayer());
    assert.equal(await page.evaluate(() => __biliThreadRipperDebug.getSettings().debugCategories.buffer), true);
    assert.equal(await page.evaluate(() => Object.values(__biliThreadRipperDebug.getSettings().debugCategories).filter(Boolean).length), 1);
    await popup.waitForTimeout(250);
    assert.equal(await popup.locator("#debug-notices").isChecked(), true);
    await popup.screenshot({ path: "dist/debug-filters-preview.png" });
    await popup.locator("#debug-select-all").click();
    assert.equal(await popup.locator("[data-debug-category]:checked").count(), 6);
    console.log("PASS 全不选不会关闭红色错误，迟到日志再次过滤，Debug 关闭再开启及页面重载保留分类选择");

    const priority = await context.newPage();
    priority.on("pageerror", error => errors.push(error.message));
    await priority.goto(origin + "/dev/notification-flow-test.html");
    const bornAt = Date.now();
    await priority.evaluate(() => {
      __BTR_NOTIFICATION_VIEW__.configure({ enabled: true, debugNotices: true, errorNotices: true });
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
