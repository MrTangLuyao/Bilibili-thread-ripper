"use strict";
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.BTR_CHROME_PATH || undefined, headless: true, args: ["--disable-background-timer-throttling"] });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 900 } });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("http://127.0.0.1:18763/dev/notification-flow-test.html");
    await page.evaluate(() => {
      const last = new Map();
      window.flowAudit = { frames: 0, checked: 0, failures: [], step: "initial", seen: [], stopped: false };
      function inspect() {
        if (flowAudit.stopped) return;
        flowAudit.frames++;
        for (const node of document.getElementById("__btr_notification_stack__")?.shadowRoot.querySelectorAll(".entry") || []) {
          const id = node.dataset.id, top = node.getBoundingClientRect().top, text = node.textContent;
          const previous = last.get(id);
          if (previous) {
            flowAudit.checked++;
            if (top > previous.top + .6) flowAudit.failures.push({ step: flowAudit.step, id, reason: "moved down", before: previous.top, after: top });
            if (text !== previous.text) flowAudit.failures.push({ step: flowAudit.step, id, reason: "message rewritten", before: previous.text, after: text });
          } else flowAudit.seen.push(id);
          last.set(id, { top, text });
        }
        requestAnimationFrame(inspect);
      }
      requestAnimationFrame(inspect);
      __BTR_NOTIFICATION_VIEW__.configure({ enabled: true, debugNotices: true });
    });
    await page.waitForTimeout(700);
    const idleBefore = await page.locator(".mode").evaluate(node => ({ id: node.parentElement.dataset.id, top: node.getBoundingClientRect().top }));
    await page.evaluate(() => {
      flowAudit.step = "repeat key and different message heights";
      __BTR_NOTIFICATION_VIEW__.logs([{ key: "same-group", title: "第一条消息", detail: "这条内容保持原样。\n旧消息只能向上走。", count: 4 }]);
    });
    await page.waitForTimeout(250);
    await page.evaluate(() => __BTR_NOTIFICATION_VIEW__.logs([{ key: "same-group", title: "第二条消息", detail: "这是另一条独立消息。", count: 8 }]));
    await page.waitForTimeout(200);
    await page.evaluate(() => __BTR_NOTIFICATION_VIEW__.logs([{ key: "same-group", title: "第三条消息", detail: "内容更短。" }]));
    await page.waitForTimeout(800);
    assert.equal(await page.locator(".debug:not(.leaving)").count(), 3);
    const repeated = await page.locator(".debug:not(.leaving)").allTextContents();
    assert(repeated[0].includes("第一条消息") && repeated[0].includes("4 条") && !repeated[0].includes("8 条"));
    assert(repeated[1].includes("第二条消息") && repeated[2].includes("第三条消息"));
    console.log("PASS 重复 key 生成独立消息，文字和计数不改写旧消息");

    await page.evaluate(() => { flowAudit.step = "remove newest and middle"; });
    await page.locator(".debug:not(.leaving)").last().click();
    await page.waitForTimeout(750);
    await page.locator(".debug:not(.leaving)").last().click();
    await page.waitForTimeout(750);
    const idleAfter = await page.locator(".mode").evaluate(node => ({ id: node.parentElement.dataset.id, top: node.getBoundingClientRect().top }));
    assert.equal(idleAfter.id, idleBefore.id);
    assert(idleAfter.top < idleBefore.top - 100);
    console.log("PASS 删除底部与中间消息，上方消息不会向下补位");

    await page.evaluate(() => {
      flowAudit.step = "playback state snapshots";
      __BTR_NOTIFICATION_VIEW__.playback({ attached: true, playing: false, route: "video:p1", session: 1 });
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => __BTR_NOTIFICATION_VIEW__.playback({ attached: true, playing: true, route: "video:p1", session: 1 }));
    await page.waitForTimeout(700);
    const stateMessages = await page.locator(".mode:not(.leaving)").allTextContents();
    assert(stateMessages.some(text => text.includes("视频还没播放")) && stateMessages.some(text => text.includes("视频正在播放。")));
    const stateCount = await page.locator(".entry").count();
    await page.evaluate(() => { for (let i = 0; i < 20; i++) __BTR_NOTIFICATION_VIEW__.playback({ attached: true, playing: true, route: "video:p1", session: 1 }); });
    assert.equal(await page.locator(".entry").count(), stateCount);
    console.log("PASS 状态变化新增快照，重复心跳不改写也不增加消息");

    await page.evaluate(() => {
      flowAudit.step = "error panel appears";
      const error = document.createElement("div");
      error.id = "__bilibili_thread_ripper_error_notice__";
      error.style.cssText = "position:fixed;bottom:14px;left:14px;width:280px;height:150px";
      document.body.append(error);
    });
    await page.waitForTimeout(1000);
    await page.evaluate(() => { flowAudit.step = "error panel disappears"; document.getElementById("__bilibili_thread_ripper_error_notice__").remove(); });
    await page.waitForTimeout(800);
    await page.evaluate(() => { flowAudit.step = "smaller viewport"; });
    await page.setViewportSize({ width: 360, height: 550 });
    await page.waitForTimeout(750);
    await page.evaluate(() => { flowAudit.step = "larger viewport"; });
    await page.setViewportSize({ width: 640, height: 900 });
    await page.waitForTimeout(750);
    console.log("PASS 错误框消失和窗口变大也不会把旧消息拉下来");

    await page.evaluate(async () => {
      flowAudit.step = "rapid interrupted upward animations";
      for (let i = 0; i < 20; i++) {
        __BTR_NOTIFICATION_VIEW__.logs([{ key: "rapid", title: "连续新消息 " + i, detail: "每条都有自己固定的内容。" }]);
        await new Promise(resolve => setTimeout(resolve, 45));
      }
    });
    await page.waitForTimeout(900);
    const newest = await page.locator(".debug:not(.leaving)").last().boundingBox();
    assert(newest.x >= 0 && newest.y > 0 && newest.y + newest.height <= 900);
    assert((await page.locator(".debug:not(.leaving)").last().innerText()).includes("连续新消息 19"));
    const oldIds = await page.locator(".entry").evaluateAll(nodes => nodes.map(node => node.dataset.id));
    await page.evaluate(() => { flowAudit.step = "expiry and fresh idle message"; });
    await page.waitForTimeout(8000);
    assert.equal(await page.locator(".debug").count(), 0);
    assert.equal(await page.locator(".mode").count(), 1);
    const idleNew = await page.locator(".mode").evaluate(node => ({ id: node.parentElement.dataset.id, bottom: node.getBoundingClientRect().bottom }));
    assert(!oldIds.includes(idleNew.id));
    assert(Math.abs(idleNew.bottom - 884) < 1);
    await page.waitForTimeout(1000);
    assert.equal(await page.locator(".mode").evaluate(node => node.parentElement.dataset.id), idleNew.id);
    console.log("PASS 日志过期后在底部创建新常驻消息，不复用或下移旧消息");

    const audit = await page.evaluate(() => { flowAudit.stopped = true; return flowAudit; });
    assert(audit.frames > 100 && audit.checked > 500);
    assert.deepEqual(audit.failures, []);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ frames: audit.frames, messageChecks: audit.checked, distinctMessages: audit.seen.length, downwardMoves: audit.failures.length, errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
