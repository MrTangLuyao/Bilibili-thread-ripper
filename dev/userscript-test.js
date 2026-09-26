"use strict";
// Needs dev/server.js. Builds the userscript from the current source files into
// dist/userscript-test.user.js and runs that in dev/userscript-test.html; the published
// user_scripts/bilibili-thread-ripper.user.js only changes when a version is released.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const meta = JSON.parse(fs.readFileSync(path.join(root, "user_scripts/adapter/meta.json"), "utf8"));
// The published file carries the version of the newest release in CHANGELOG.md; the test
// build uses the same one.
const version = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8").match(/^## \[(\d+\.\d+\.\d+\.\d+)\]/m)[1];
const published = fs.readFileSync(path.join(root, "user_scripts/bilibili-thread-ripper.user.js"), "utf8");
let script = "";
const scriptUrl = "https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper/main/user_scripts/bilibili-thread-ripper.user.js";
const source = file => fs.readFileSync(path.join(root, file), "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trimEnd().split("__BTR_VERSION__").join(version);

function checkPublished() {
  const header = published.slice(0, published.indexOf("// ==/UserScript=="));
  const values = name => [...header.matchAll(new RegExp(`^// @${name}\\s+(.+)$`, "gm"))].map(match => match[1].trim());
  assert.deepEqual(values("version"), [version], "the published script is not the newest release in CHANGELOG.md");
  assert.deepEqual(values("updateURL"), [scriptUrl]);
}

function checkFile() {
  assert.ok(script.startsWith("// ==UserScript==\n"), "Tampermonkey needs the header on the first line");
  const header = script.slice(0, script.indexOf("// ==/UserScript=="));
  const values = name => [...header.matchAll(new RegExp(`^// @${name}\\s+(.+)$`, "gm"))].map(match => match[1].trim());
  assert.deepEqual(values("version"), [version]);
  assert.equal(script.includes("__BTR_VERSION__"), false, "the version placeholder was left in the built file");
  assert.deepEqual(values("updateURL"), [scriptUrl]);
  assert.deepEqual(values("downloadURL"), [scriptUrl]);
  // Every bilibili.com page: the settings panel opens everywhere, the video and live
  // modules keep to their own hostnames in the page code.
  assert.deepEqual(values("match"), ["https://*.bilibili.com/*"]);
  assert.deepEqual(values("run-at"), ["document-start"]);
  assert.deepEqual(values("grant").sort(), ["GM.getValue", "GM.setValue", "GM_addElement", "GM_addValueChangeListener", "GM_registerMenuCommand", "unsafeWindow"]);
  // Live players sit in live.bilibili.com iframes, so the script must run in frames; the
  // page code itself keeps other sites' iframes out.
  assert.doesNotMatch(header, /^\/\/ @noframes$/m);
  assert.match(script, /window\.top !== window && !\/\^live/);
  new vm.Script(script, { filename: "bilibili-thread-ripper.user.js" });
  // The page files, settings panel included, are there unchanged (apart from the version)
  // and in the order meta.json gives; each appears once.
  const files = [...meta.pageFiles, meta.loader];
  let position = 0;
  for (const file of files) {
    const part = `/* ${file} */\n${source(file)}\n`;
    const at = script.indexOf(part, position);
    assert.ok(at >= position, `${file} missing, changed or out of order`);
    assert.equal(script.indexOf(`/* ${file} */\n`, at + 1), -1, `${file} is included twice`);
    position = at;
  }
  assert.ok(files.includes("src/settings-panel.js"));
  console.log("PASS 油猴脚本头部、自动更新地址和打包内容正确");
}

const settingsHost = "#__bilibili_thread_ripper_settings__";
const openSettings = page => page.evaluate(() => document.dispatchEvent(new CustomEvent("btr-userscript-open-settings")));
const settingsOf = page => page.evaluate(() => __biliThreadRipperDebug.getSettings());

(async () => {
  checkPublished();
  const { buildUserscript } = await import(pathToFileURL(path.join(root, "scripts/build.mjs")).href);
  script = buildUserscript(version);
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist/userscript-test.user.js"), script);
  checkFile();
  const browser = await chromium.launch({ executablePath: process.env.BTR_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true });
  const origin = "http://127.0.0.1:18763/dev/userscript-test.html";
  const errors = [];
  const red = '.bubble[data-level="error"]:not(.leaving)';
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    const stored = (target = page) => target.evaluate(() => JSON.parse(localStorage.getItem("BTR_Userscript.sync") || "{}"));

    // No welcome panel any more: in the userscript its "seen" flag lived in each bilibili
    // domain's own localStorage, so it came back on every domain (issue #26). The settings
    // are simply the defaults until something changes them.
    await page.waitForFunction(() => window.__biliThreadRipperDebug?.getSettings().concurrency === 8);
    assert.equal(await page.locator("#__bilibili_thread_ripper_onboarding__").count(), 0);
    const settings = await settingsOf(page);
    assert.deepEqual([settings.enabled, settings.mode, settings.concurrency, settings.autoConcurrency, settings.errorNotices, settings.debugNotices], [true, "mainland", 8, true, false, false]);
    // The button in the page corner opens the panel, and closes it again.
    const launcherButton = page.locator("#__bilibili_thread_ripper_launcher__ .btr-launcher");
    await launcherButton.waitFor();
    await launcherButton.click();
    await page.locator(`${settingsHost} .btr-popup`).waitFor();
    assert.equal(await launcherButton.count(), 0, "悬浮按钮 steps aside while the panel is open");
    await page.keyboard.press("Escape");
    await page.locator(settingsHost).waitFor({ state: "detached" });
    await launcherButton.waitFor();
    assert.equal(await page.evaluate(() => window.chrome?.storage), undefined, "the page's own chrome object must stay untouched");
    // The player menu keeps only what the extension puts there.
    const menu = page.locator("#__bilibili_thread_ripper_native_settings__");
    await menu.waitFor({ state: "attached" });
    assert.deepEqual(await menu.locator(".btr-native-setting-title").allTextContents(), ["线程撕裂者 CDN", "并发线程"]);
    assert.deepEqual(await menu.locator('input[name="btr-native-mode"]').evaluateAll(nodes => nodes.map(node => node.value)), ["mainland", "overseas", "custom"]);
    console.log("PASS 不再弹欢迎设置；页面角落的悬浮按钮能打开设置；播放器菜单里的设置项齐全");

    // The menu command opens the settings panel inside the bilibili page, the same one the
    // extension's toolbar icon opens.
    await openSettings(page);
    const panel = page.locator(`${settingsHost} .btr-popup`);
    await panel.waitFor();
    assert.equal(await panel.locator("h1").textContent(), "线程撕裂者");
    assert.equal(await panel.locator("#enabled").isChecked(), true);
    assert.equal(await panel.locator('input[name="mode"][value="mainland"]').isChecked(), true);
    assert.equal(await panel.locator('input[name="mode"]').count(), 3);
    assert.equal(await panel.locator("#custom-hosts").isVisible(), false);
    // The takeover switch sits where the old compatibility modes were, full takeover by
    // default, with the note for Safari users under it.
    assert.equal(await panel.locator('input[name="takeover"][value="full"]').isChecked(), true);
    assert.match(await panel.locator(".takeover-note").textContent(), /Safari 用户建议使用兼容模式/);
    await panel.locator('input[name="takeover"][value="compat"]').check({ force: true });
    await page.waitForFunction(() => __biliThreadRipperDebug.getSettings().takeover === "compat");
    await panel.locator('input[name="takeover"][value="full"]').check({ force: true });
    await page.waitForFunction(() => __biliThreadRipperDebug.getSettings().takeover === "full");
    assert.equal(await panel.locator("#thread-value").textContent(), "8");
    assert.equal(await panel.locator("#error-notices").isChecked(), false);
    assert.equal(await panel.locator("#debug-filters").isVisible(), false);
    await page.waitForFunction(() => __userscriptTest.statusRequests > 0);
    assert.match(await panel.locator("#active-count").textContent(), /^\d+$/);
    await page.evaluate(() => __BTR_RUNTIME_NOTICES__.log("默认不显示的错误", "显示错误关闭", "error"));
    await page.waitForTimeout(600);
    assert.equal(await page.locator(".bubble").count(), 0);
    await panel.locator("#error-notices").check();
    await page.waitForFunction(() => __biliThreadRipperDebug.getSettings().errorNotices === true);
    await page.evaluate(() => __BTR_RUNTIME_NOTICES__.log("打开后显示的错误", "这一小段没能下载下来", "error"));
    await page.locator(red).first().waitFor();
    // The slider only counts once the automatic mode is switched off.
    assert.equal(await panel.locator("#auto-concurrency").isChecked(), true);
    assert.equal(await panel.locator("#concurrency").isDisabled(), true);
    await panel.locator("#auto-concurrency").uncheck({ force: true });
    await page.waitForFunction(() => __biliThreadRipperDebug.getSettings().autoConcurrency === false);
    await panel.locator("#concurrency").fill("2");
    await page.waitForFunction(() => __biliThreadRipperDebug.getSettings().concurrency === 16);
    assert.equal(await panel.locator("#thread-value").textContent(), "16");
    await panel.locator("#debug-notices").check();
    await panel.locator("#debug-filters").waitFor();
    assert.equal(await panel.locator("[data-debug-category]:checked").count(), 6);
    await page.locator(".mode").first().waitFor();
    console.log("PASS 设置面板：开关、线程、Debug 分类和实时线程数都能用");

    // Closing stops the status polling; opening again starts clean.
    await page.keyboard.press("Escape");
    await page.locator(settingsHost).waitFor({ state: "detached" });
    const requests = await page.evaluate(() => __userscriptTest.statusRequests);
    await page.waitForTimeout(1000);
    assert.equal(await page.evaluate(() => __userscriptTest.statusRequests), requests, "no polling after close");
    await openSettings(page);
    await panel.waitFor();
    assert.equal(await panel.locator("#error-notices").isChecked(), true);
    assert.equal(await panel.locator("#thread-value").textContent(), "16");
    await openSettings(page);
    await page.locator(settingsHost).waitFor({ state: "detached" });
    await openSettings(page);
    await page.locator(`${settingsHost} .btr-backdrop`).click({ position: { x: 20, y: 20 } });
    await page.locator(settingsHost).waitFor({ state: "detached" });
    console.log("PASS 菜单再点一次、Esc、点空白处都能关闭，关闭后不再轮询");

    // Issue #8: the page's own top layer (an open popover, or a modal dialog of the page)
    // must not cover the settings or take the click on "关闭". The button also stays in
    // reach when the window is too short for the whole panel.
    const clickClose = async (target) => {
      const box = await target.locator(`${settingsHost} .btr-close`).boundingBox();
      await target.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await target.locator(settingsHost).waitFor({ state: "detached", timeout: 3000 });
    };
    for (const cover of ["popover", "dialog"]) {
      await page.evaluate((kind) => {
        window.__coverClicks = 0;
        const node = document.createElement(kind === "dialog" ? "dialog" : "div");
        node.id = "page-cover";
        node.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:rgba(0,128,255,.05)";
        node.addEventListener("click", () => { window.__coverClicks += 1; });
        document.body.append(node);
        if (kind === "dialog") node.showModal();
        else { node.popover = "manual"; node.showPopover(); }
      }, cover);
      await openSettings(page);
      await page.locator(`${settingsHost} .btr-popup`).waitFor();
      await clickClose(page);
      assert.equal(await page.evaluate(() => window.__coverClicks), 0, `the page's ${cover} took the click`);
      await page.evaluate(() => { const node = document.getElementById("page-cover"); if (node.open) node.close(); else node.hidePopover?.(); node.remove(); });
    }
    await page.setViewportSize({ width: 1100, height: 480 });
    await openSettings(page);
    await page.locator(`${settingsHost} .btr-popup`).waitFor();
    const shortBox = await page.locator(`${settingsHost} .btr-close`).boundingBox();
    assert.ok(shortBox.y + shortBox.height <= 480, "关闭 is below the bottom of a short window");
    await clickClose(page);
    await page.setViewportSize({ width: 1100, height: 900 });
    console.log("PASS 页面自己的弹层或模态框开着时设置页仍在最上层，窗口很矮时“关闭”也点得到");

    // A second tab follows changes and a reload keeps them.
    const second = await context.newPage();
    second.on("pageerror", error => errors.push(error.message));
    await second.goto(origin);
    await second.waitForFunction(() => window.__biliThreadRipperDebug?.getSettings().concurrency === 16);
    await openSettings(second);
    const secondPanel = second.locator(`${settingsHost} .btr-popup`);
    await secondPanel.waitFor();
    await secondPanel.locator('input[name="mode"][value="overseas"]').check({ force: true });
    await page.waitForFunction(() => __biliThreadRipperDebug.getSettings().mode === "overseas");
    await page.goto(origin);
    await page.waitForFunction(() => window.__biliThreadRipperDebug?.getSettings().mode === "overseas");
    assert.deepEqual(await settingsOf(page).then(value => [value.concurrency, value.errorNotices, value.debugNotices]), [16, true, true]);
    console.log("PASS 另一个标签页同步设置，刷新后设置保留");

    // "自定义" in the gear menu opens the panel on the custom servers. Known servers are
    // ticked, others typed in; only Bilibili's video servers are taken, and what is typed
    // there does not reach the player's keyboard shortcuts.
    await page.evaluate(() => { window.__pageKeys = 0; document.addEventListener("keydown", () => { window.__pageKeys += 1; }); });
    await page.locator('#__bilibili_thread_ripper_native_settings__ input[name="btr-native-mode"][value="custom"]').check({ force: true });
    await panel.waitFor();
    await page.waitForFunction(() => __biliThreadRipperDebug.getSettings().mode === "custom");
    await panel.locator("#custom-hosts").waitFor();
    assert.equal(await panel.locator("#custom-count").textContent(), "0");
    assert.equal(await panel.locator("#custom-empty").isVisible(), true);
    await panel.locator('#known-hosts input[value="upos-sz-mirrorcos.bilivideo.com"]').check();
    await page.waitForFunction(() => __biliThreadRipperDebug.getSettings().customHosts.join() === "upos-sz-mirrorcos.bilivideo.com");
    await panel.locator("#host-input").pressSequentially("example.com");
    await panel.locator("#host-input").press("Enter");
    assert.match(await panel.locator("#host-error").textContent(), /不是 B 站/);
    await panel.locator("#host-input").fill("");
    await panel.locator("#host-input").pressSequentially("https://CN-GDFS-CT-01-01.bilivideo.com:4483/x");
    await panel.locator("#host-form button").click();
    await page.waitForFunction(() => __biliThreadRipperDebug.getSettings().customHosts.join() === "upos-sz-mirrorcos.bilivideo.com,cn-gdfs-ct-01-01.bilivideo.com");
    assert.equal(await panel.locator("#custom-count").textContent(), "2");
    assert.equal(await panel.locator(".manual-host span").textContent(), "cn-gdfs-ct-01-01.bilivideo.com");
    assert.equal(await page.evaluate(() => window.__pageKeys), 0, "keys typed into the panel reached the page");
    await panel.locator(".manual-host button").click();
    await page.waitForFunction(() => __biliThreadRipperDebug.getSettings().customHosts.join() === "upos-sz-mirrorcos.bilivideo.com");
    await page.keyboard.press("Escape");
    await page.locator(settingsHost).waitFor({ state: "detached" });
    console.log("PASS 自定义服务器：齿轮菜单打开设置，勾选已知服务器、手动添加和删除，只收 B 站视频服务器，输入不触发播放器快捷键");

    // A manager that runs the script outside the page: the accelerator is injected into the
    // page once and the manager's menu entry opens the same settings page.
    const isolated = await (await browser.newContext()).newPage();
    isolated.on("pageerror", error => errors.push(error.message));
    await isolated.goto(`${origin}?mode=sandbox`);
    await isolated.waitForFunction(() => window.__biliThreadRipperDebug && document.documentElement.hasAttribute("data-btr-userscript"));
    assert.deepEqual(await isolated.evaluate(() => [__userscriptTest.injected, __userscriptTest.menus.map(item => item.name)]), [1, ["线程撕裂者设置"]]);
    await isolated.evaluate(() => __userscriptTest.menus[0].callback());
    await isolated.locator(`${settingsHost} .btr-popup`).waitFor();
    await isolated.evaluate(() => __userscriptTest.menus[0].callback());
    await isolated.locator(settingsHost).waitFor({ state: "detached" });
    assert.equal(await isolated.locator("#__btr_notification_stack__").count() <= 1, true);
    console.log("PASS 油猴在独立环境运行时：核心只注入页面一次，油猴菜单“线程撕裂者设置”能打开和关闭设置页");

    // Settings in the manager's storage, shared by every bilibili subdomain. Separate browser
    // contexts stand in for subdomains: each has its own localStorage, all share the store.
    const gmStore = new Map();
    const gmPages = new Set();
    const managerTab = async (seed) => {
      const context = await browser.newContext();
      if (seed) await context.addInitScript(value => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("BTR_Userscript.sync", value); sessionStorage.setItem("seeded", "1"); } }, JSON.stringify(seed));
      await context.exposeBinding("__gmCall", async (source, op, key, value) => {
        if (op === "get") return gmStore.get(key);
        const old = gmStore.get(key);
        gmStore.set(key, value);
        for (const other of gmPages) {
          if (other === source.page || other.isClosed()) continue;
          await other.evaluate(([name, before, after]) => __gmListeners.filter(item => item.key === name).forEach(item => item.callback(name, before, after, true)), [key, old, value]).catch(() => {});
        }
      });
      const tab = await context.newPage();
      tab.on("pageerror", error => errors.push(error.message));
      gmPages.add(tab);
      return tab;
    };
    const modeOf = (target, mode) => target.waitForFunction(value => window.__biliThreadRipperDebug?.getSettings().mode === value, mode);
    // What an earlier subdomain kept is taken over the first time, and stays where it was.
    const space = await managerTab({ mode: "overseas", autoConcurrency: false, concurrency: 16 });
    await space.goto(`${origin}?gm=live`);
    await modeOf(space, "overseas");
    assert.equal(JSON.parse(gmStore.get("sync")).mode, "overseas");
    assert.equal(JSON.parse(await space.evaluate(() => localStorage.getItem("BTR_Userscript.sync"))).mode, "overseas");
    // Another subdomain, with nothing in its own localStorage, reads the same settings.
    const video = await managerTab();
    await video.goto(`${origin}?gm=live`);
    await modeOf(video, "overseas");
    assert.deepEqual(await settingsOf(video).then(value => [value.autoConcurrency, value.concurrency]), [false, 16]);
    // A change on one shows on the other at once, is stored for both, and nothing lands in
    // that subdomain's own localStorage. A reload keeps it.
    await openSettings(space);
    const spacePanel = space.locator(`${settingsHost} .btr-popup`);
    await spacePanel.waitFor();
    await spacePanel.locator('input[name="mode"][value="mainland"]').check({ force: true });
    await modeOf(video, "mainland");
    assert.equal(JSON.parse(gmStore.get("sync")).mode, "mainland");
    assert.equal(await video.evaluate(() => localStorage.getItem("BTR_Userscript.sync")), null);
    await video.goto(`${origin}?gm=live`);
    await modeOf(video, "mainland");
    // A manager that does not report other tabs' changes: the tab reads the storage again
    // when it comes back.
    const plain = await managerTab();
    await plain.goto(`${origin}?gm=plain`);
    await modeOf(plain, "mainland");
    await spacePanel.locator('input[name="mode"][value="overseas"]').check({ force: true });
    await modeOf(video, "overseas");
    assert.equal(await settingsOf(plain).then(value => value.mode), "mainland");
    await plain.evaluate(() => dispatchEvent(new Event("focus")));
    await modeOf(plain, "overseas");
    // The same when the manager runs the script outside the page and injects it.
    const injectedTab = await managerTab();
    await injectedTab.goto(`${origin}?mode=sandbox&gm=live`);
    await modeOf(injectedTab, "overseas");
    await spacePanel.locator('input[name="mode"][value="mainland"]').check({ force: true });
    await modeOf(injectedTab, "mainland");
    // A manager whose storage never answers must not keep the settings, and so the takeover,
    // from loading: after three seconds this site's localStorage is used as before.
    const silentContext = await browser.newContext();
    await silentContext.addInitScript(() => localStorage.setItem("BTR_Userscript.sync", JSON.stringify({ mode: "overseas" })));
    const silent = await silentContext.newPage();
    silent.on("pageerror", error => errors.push(error.message));
    const silentStarted = Date.now();
    await silent.goto(`${origin}?gm=silent`);
    await silent.waitForFunction(() => window.__biliThreadRipperDebug?.getSettings().mode === "overseas", null, { timeout: 8000 });
    assert.ok(Date.now() - silentStarted < 6000);
    console.log("PASS 设置存在脚本管理器里：各子域共用一份，第一次会导入这个子域原来的设置，其他标签页马上同步（不报告变化的管理器在切回标签页时同步），管理器的存储不回应时退回本站 localStorage");

    assert.deepEqual(errors, []);
    console.log("PASS 没有脚本错误");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
