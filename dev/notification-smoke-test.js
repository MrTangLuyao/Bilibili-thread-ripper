"use strict";
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const manifest = require("../manifest.json");

function mockChrome() {
  const listeners = [];
  const read = name => JSON.parse(localStorage.getItem(`test-chrome-${name}`) || (name === "local" ? '{"btrOnboardingRevision":"native-progressive-mse-v1"}' : "{}"));
  const save = (name, next, callback) => {
    const previous = read(name), changes = {};
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changes[key] = { oldValue: previous[key], newValue: next[key] };
    localStorage.setItem(`test-chrome-${name}`, JSON.stringify(next));
    queueMicrotask(() => { if (Object.keys(changes).length) listeners.forEach(fn => fn(changes, name)); callback?.(); });
    return Promise.resolve();
  };
  const area = name => ({
    get(defaults, callback) { const result = { ...(defaults || {}), ...read(name) }; if (callback) queueMicrotask(() => callback(result)); else return Promise.resolve(result); },
    set(update, callback) { return save(name, { ...read(name), ...update }, callback); },
    remove(keys, callback) { const next = read(name); for (const key of [].concat(keys)) delete next[key]; return save(name, next, callback); }
  });
  addEventListener("storage", event => {
    if (!event.key?.startsWith("test-chrome-")) return;
    const previous = JSON.parse(event.oldValue || "{}"), next = JSON.parse(event.newValue || "{}"), changes = {};
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changes[key] = { oldValue: previous[key], newValue: next[key] };
    listeners.forEach(fn => fn(changes, event.key.replace("test-chrome-", "")));
  });
  window.chrome = {
    storage: { sync: area("sync"), local: area("local"), onChanged: { addListener(fn) { listeners.push(fn); } } },
    runtime: { lastError: null, onMessage: { addListener() {} }, sendMessage() { return Promise.resolve({}); } },
    tabs: { query() { return Promise.resolve([{ id: 1 }]); }, sendMessage() { return Promise.resolve({ stats: { activeThreads: 3 } }); } }
  };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.BTR_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling"] });
  const passed = [], errors = [];
  const mark = name => { passed.push(name); console.log("PASS " + name); };
  const origin = "http://127.0.0.1:18763";
  const activeSelector = "#__btr_notification_stack__ .debug:not(.leaving)";
  // The settings panel opens inside a bilibili page. This tab is one without a video; the
  // page reports 3 threads in use.
  const openSettings = async (tab, navigate = true) => {
    if (navigate) await tab.goto(origin + "/dev/notification-home-test.html");
    await tab.evaluate(() => {
      window.postMessage({ channel: "__BILI_RANGE_ACCELERATOR_V1__", type: "stats", payload: { activeThreads: 3 } }, "*");
      setTimeout(() => document.dispatchEvent(new CustomEvent("btr-userscript-open-settings")), 50);
    });
    await tab.locator("#__bilibili_thread_ripper_settings__ .btr-popup").waitFor();
  };
  try {
    assert.deepEqual(manifest.content_scripts.find(item => item.world === "ISOLATED").matches, ["https://*.bilibili.com/*"]);
    assert.deepEqual(manifest.content_scripts.find(item => item.world === "MAIN").matches, ["https://www.bilibili.com/*", "https://m.bilibili.com/*"]);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(mockChrome);
    const page = await context.newPage(), popup = await context.newPage(), home = await context.newPage();
    await popup.setViewportSize({ width: 410, height: 900 });
    for (const tab of [page, popup, home]) tab.on("pageerror", error => errors.push(error.message));
    const url = origin + "/dev/notification-test.html";
    const mode = page.locator("#__btr_notification_stack__ .mode:not(.leaving)").last();
    const bubbles = page.locator(activeSelector);
    await home.goto(origin + "/dev/notification-home-test.html");
    await home.evaluate(() => chrome.storage.sync.set({ statusNotice: true }));
    await page.goto(url);
    await openSettings(popup);
    await page.waitForFunction(() => __biliThreadRipperDebug.getPlayer());
    await page.waitForTimeout(1100);
    assert.equal(await mode.count(), 0);
    assert.equal(await bubbles.count(), 0);
    assert.equal(await page.evaluate(() => __noticeTest.messages.length), 0);
    assert.equal(await popup.locator("#status-notice, .monitor, #thread-list, #total-speed, #last-error").count(), 0);
    assert.equal(await popup.locator("#debug-notices").isChecked(), false);
    assert.equal(await popup.locator("#active-count").innerText(), "3");
    assert.equal(await page.evaluate(async () => "statusNotice" in await chrome.storage.sync.get(null)), false);
    assert.equal(await page.locator("#__bilibili_thread_ripper_watermark__").count(), 0);
    mark("移除旧开关与监控面板，迁移不擅自开启 Debug");

    // Red messages are off by default since 0.9.1.2. The rest of this test covers them too.
    assert.equal(await popup.locator("#error-notices").isChecked(), false);
    await popup.locator("#error-notices").check();
    await popup.locator("#debug-notices").check();
    await mode.waitFor({ state: "visible" });
    await page.waitForFunction(() => [...document.getElementById("__btr_notification_stack__")?.shadowRoot.querySelectorAll(".mode:not(.leaving) .detail") || []].at(-1)?.textContent.includes("视频还没播放"));
    assert.equal(await mode.locator(".heading").innerText(), "BTR Debug");
    assert((await mode.innerText()).includes("如果视频正在播放，请刷新网页。"));
    assert.equal(await page.evaluate(() => __noticeTest.calls.length), 1);
    await home.locator("#__btr_notification_stack__ .mode").waitFor({ state: "visible" });
    assert((await home.locator("#__btr_notification_stack__ .mode").innerText()).includes("Debug 模式已开启"));
    mark("一个 Debug 开关同时显示接管状态与日志，无视频页面也常驻");

    await page.evaluate(() => __noticeTest.play());
    await page.waitForFunction(() => __biliThreadRipperDebug.getPlayer().video.currentTime > 1);
    await page.waitForFunction(() => __noticeTest.messages.filter(item => item.type === "playback-notice").at(-1)?.payload.playing === true);
    await page.evaluate(() => {
      __biliThreadRipperDebug.getPlayer().video.pause();
      const options = __noticeTest.calls.at(-1).options;
      const id = options.onTransfer({ phase: "start", kind: "video", url: "https://example.bilivideo.com/video.m4s?token=DO_NOT_SHOW", totalBytes: 65536 });
      for (let i = 0; i < 1000; i++) options.onTransfer({ phase: "progress", id, bytes: 64 });
      options.onTransfer({ phase: "done", id });
      options.onSegment({ kind: "video", bytes: 64000, pieces: 32 });
    });
    await page.waitForTimeout(500);
    const messages = await page.evaluate(() => __noticeTest.messages.filter(item => item.type === "debug-notices").flatMap(item => item.payload));
    assert(!JSON.stringify(messages).includes("DO_NOT_SHOW"));
    assert(messages.some(item => item.title === "正在接收视频数据" && item.count === 1000));
    assert(messages.some(item => item.title === "视频已暂停"));
    assert((await bubbles.count()) <= 6);
    mark("真实视频播放与暂停状态正确，1000 次下载进度合并且不暴露签名 URL");

    // No player on this page: isolate animation measurements from media logs.
    await home.waitForTimeout(400);
    const homeMode = home.locator("#__btr_notification_stack__ .mode:not(.leaving)").last();
    const before = await homeMode.boundingBox();
    const arrival = await home.evaluate(() => {
      __BTR_NOTIFICATION_VIEW__.logs([{ key: "animation", title: "动画测试", detail: "新的消息从左侧出现。", level: "info" }]);
      const shadow = document.getElementById("__btr_notification_stack__").shadowRoot;
      const node = shadow.querySelector(".debug");
      return { keyframes: node.getAnimations()[0].effect.getKeyframes(), duration: node.getAnimations()[0].effect.getTiming().duration, moves: shadow.querySelector(".mode").parentElement.getAnimations()[0].effect.getKeyframes() };
    });
    assert.equal(arrival.duration, 600);
    assert.equal(arrival.keyframes[0].transform, "translateX(-32px)");
    assert.equal(arrival.keyframes[0].opacity, "0");
    assert(parseFloat(arrival.moves[0].transform.match(/[-\d.]+/)[0]) > parseFloat(arrival.moves.at(-1).transform.match(/[-\d.]+/)[0]));
    await home.waitForTimeout(100);
    const opacity = await home.locator(activeSelector).evaluate(node => Number(getComputedStyle(node).opacity));
    assert(opacity > 0 && opacity < 1);
    await home.waitForTimeout(650);
    assert((await homeMode.boundingBox()).y < before.y - 30);
    const departing = await home.locator(activeSelector).evaluate(node => {
      node.click();
      return { leaving: node.classList.contains("leaving"), frames: node.getAnimations()[0].effect.getKeyframes(), duration: node.getAnimations()[0].effect.getTiming().duration };
    });
    assert.equal(departing.leaving, true);
    assert.equal(departing.duration, 480);
    assert.equal(departing.frames.at(-1).opacity, "0");
    assert.equal(departing.frames.at(-1).transform, "translateX(-28px)");
    await home.waitForTimeout(650);
    assert.equal(await home.locator("#__btr_notification_stack__ .debug").count(), 0);
    assert((await homeMode.boundingBox()).y < before.y - 30);
    mark("滑入与淡出放慢，旧消息只向上推动，删除新消息不会使旧消息向下补位");

    await home.evaluate(() => {
      const dot = String.fromCharCode(183);
      __BTR_NOTIFICATION_VIEW__.logs([
        { key: "green", title: "视频已经接管成功", detail: "现在使用多线程加速下载。", level: "success" },
        { key: "yellow", title: "正在等视频加载", detail: "正在补充缓冲，请稍等。", level: "info" },
        { key: "red", title: "这一小段没能下载下来", detail: `网络连接中断${dot}正在重试。`, level: "error" }
      ]);
    });
    await home.waitForTimeout(750);
    const colors = await home.locator(activeSelector).evaluateAll(nodes => nodes.map(node => ({ level: node.dataset.level, title: node.querySelector(".heading").textContent, color: getComputedStyle(node.querySelector(".heading")).color, background: getComputedStyle(node).backgroundColor, text: node.textContent })));
    for (const [level, color] of Object.entries({ success: "rgb(162, 217, 131)", info: "rgb(240, 214, 107)", error: "rgb(242, 139, 133)" })) assert(colors.some(card => card.level === level && card.color === color));
    assert(colors.every(card => card.title === "BTR Debug" && card.background === "rgba(8, 8, 10, 0.78)" && !/[\u00b7\u2022\u2027\u2219\u22c5]/.test(card.text)));
    await home.screenshot({ path: "dist/notification-preview.png", animations: "disabled" });
    await popup.screenshot({ path: "dist/notification-popup-preview.png" });
    mark("复古半透明外观保留，绿黄红三级颜色与标题正确，没有间隔点");

    await home.evaluate(() => window.postMessage({ channel: "__BILI_RANGE_ACCELERATOR_V1__", type: "stats", payload: { playerState: "error", takeoverError: { id: "overlap-test", at: Date.now(), route: "test:p1", stage: "playinfo", message: "测试错误", retryCount: 1 } } }, "*"));
    await home.waitForTimeout(1000);
    const errorNotice = home.locator("#__bilibili_thread_ripper_error_notice__");
    const errorBounds = await errorNotice.boundingBox();
    const raisedStack = await home.locator("#__btr_notification_stack__").boundingBox();
    assert(raisedStack.y + raisedStack.height <= errorBounds.y - 6);
    assert.equal(await errorNotice.locator(".btr-error-title").innerText(), "BTR 提示");
    await home.reload();
    await homeMode.waitFor({ state: "visible" });
    await popup.reload();
    await openSettings(popup, false);
    await popup.waitForFunction(() => document.getElementById("__bilibili_thread_ripper_settings__")?.shadowRoot?.getElementById("debug-notices")?.checked);
    mark("避让原有错误提示框，页面重载与设置面板重开保留 Debug 设置");

    await page.evaluate(() => {
      window.oldNoticeVideo = __biliThreadRipperDebug.getPlayer().video;
      history.pushState(null, "", "/video/BV1noticeB002");
      oldNoticeVideo.dispatchEvent(new Event("playing"));
    });
    await page.waitForFunction(() => __noticeTest.calls.length === 2);
    assert.equal(await page.evaluate(() => __noticeTest.calls[0].destroyed), true);
    await page.evaluate(() => oldNoticeVideo.dispatchEvent(new Event("playing")));
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => __noticeTest.messages.filter(item => item.type === "playback-notice").at(-1).payload.playing), false);
    assert.equal(await page.evaluate(() => __noticeTest.messages.filter(item => item.type === "playback-notice").at(-1).payload.route), "bv1noticeb002:p1");
    mark("切换视频解绑旧事件，旧视频迟到事件不污染新视频状态");

    await home.setViewportSize({ width: 360, height: 420 });
    const burst = await home.evaluate(() => {
      for (let i = 0; i < 100; i++) __BTR_NOTIFICATION_VIEW__.logs([{ key: "burst" + i, title: "日志 " + i, detail: "边界测试" }]);
      const shadow = document.getElementById("__btr_notification_stack__").shadowRoot;
      return { active: shadow.querySelectorAll(".debug:not(.leaving)").length, leaving: shadow.querySelectorAll(".leaving").length, total: shadow.querySelectorAll(".entry").length };
    });
    assert(burst.active <= 6 && burst.leaving <= 6 && burst.total <= 13);
    await home.waitForTimeout(800);
    const newest = await home.locator(activeSelector).last().boundingBox();
    assert(newest.x >= 0 && newest.y >= 0 && newest.x + newest.width <= 360 && newest.y + newest.height <= 420);
    assert((await home.locator(activeSelector).last().innerText()).includes("日志 99"));
    await home.waitForTimeout(7500);
    assert.equal(await home.locator("#__btr_notification_stack__ .debug").count(), 0);
    const idle = await homeMode.boundingBox();
    assert(idle.x === 16 && Math.abs(idle.y + idle.height - 404) < 1);
    await home.waitForTimeout(1000);
    assert.equal(await homeMode.count(), 1);
    mark("高频日志数量受控，小窗口保留最新消息，过期后在底部新建常驻气泡");

    await home.emulateMedia({ reducedMotion: "reduce" });
    const animations = await home.evaluate(() => {
      __BTR_NOTIFICATION_VIEW__.logs([{ key: "reduced", title: "减少动态效果测试" }]);
      const shadow = document.getElementById("__btr_notification_stack__").shadowRoot;
      return [...shadow.querySelectorAll(".entry, .bubble")].flatMap(node => node.getAnimations()).length;
    });
    assert.equal(animations, 0);
    await home.locator(activeSelector).click();
    assert.equal(await home.locator("#__btr_notification_stack__ .debug").count(), 0);
    await home.emulateMedia({ reducedMotion: "no-preference" });
    await home.evaluate(() => chrome.storage.sync.set({ enabled: false }));
    await home.waitForTimeout(700);
    assert((await homeMode.innerText()).includes("视频加速目前已关闭"));
    const messageCount = await page.evaluate(() => __noticeTest.messages.length);
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => __noticeTest.messages.length), messageCount);
    await popup.locator("#debug-notices").uncheck();
    await homeMode.waitFor({ state: "detached" });
    await mode.waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
    mark("减少动态效果生效，停用加速停止日志，关闭 Debug 清空全部气泡，无 JS 异常");
    console.log(JSON.stringify({ passed, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
