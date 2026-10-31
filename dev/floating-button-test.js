// The button in the page corner: it opens the settings panel, hides while the panel is open
// and while the video fills the screen, follows its own switch, and the removed first-run
// guide never shows up again (issue #26).
(async () => {
  "use strict";
  const root = globalThis;

  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const launcher = () => document.getElementById("__bilibili_thread_ripper_launcher__");
  const button = () => launcher()?.shadowRoot?.querySelector(".btr-launcher") || null;
  const panel = () => document.getElementById("__bilibili_thread_ripper_settings_dialog__");
  const player = document.querySelector(".bpx-player-container");
  const resultNode = document.getElementById("result");

  // This page is not on .bilibili.com, where the guide's cookie lives.
  let guideCookie = false;
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => (guideCookie ? "BTR.guideDone=1" : ""),
    set: (value) => { guideCookie = value.startsWith("BTR.guideDone=1"); }
  });
  await wait(600);
  // The first-run guide: the screen goes dark and an arrow points at the button. Nothing is
  // recorded until it is answered.
  const guideHost = () => document.getElementById("__bilibili_thread_ripper_guide__");
  const guideRoot = () => guideHost()?.shadowRoot;
  const arrowEnd = () => {
    const parts = (guideRoot()?.querySelector("path")?.getAttribute("d") || "").match(/-?[\d.]+/g)?.map(Number) || [];
    return parts.length >= 6 ? { x: parts[4], y: parts[5] } : null;
  };
  const nearButton = () => {
    const box = button()?.getBoundingClientRect(), end = arrowEnd();
    return Boolean(box && end) && Math.hypot(end.x - (box.left + box.width / 2), end.y - (box.top + box.height / 2)) < 60;
  };
  const guideShown = Boolean(guideHost());
  const guideText = guideRoot()?.querySelector("p")?.textContent === "点这里打开全新 线程撕裂者 设置";
  const guideBold = guideRoot()?.querySelector("b")?.textContent === "线程撕裂者";
  const arrowOnButton = nearButton();
  const unanswered = globalThis.__btrTestStorage.syncState.guideDone !== true;
  // It follows the button in real time.
  button().style.top = "120px"; button().style.left = "60px"; button().style.right = "auto";
  await wait(120);
  const arrowFollows = nearButton();
  guideRoot()?.querySelector(".btr-guide")?.click();
  await wait(200);
  const guideGone = !guideHost();
  const guideOpenedPanel = Boolean(panel());
  const guideSaved = globalThis.__btrTestStorage.syncState.guideDone === true && guideCookie;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(300);
  const guideStaysAway = !guideHost();
  // Answered in another subdomain whose record is only the cookie: not shown either, and the
  // stored settings catch up.
  globalThis.__btrTestStorage.syncState.guideDone = false;
  root.postMessage({ channel: "__BILI_RANGE_ACCELERATOR_V1__", type: "settings", payload: { guideDone: false } }, "*");
  await wait(200);
  const markIsEnough = !guideHost() && globalThis.__btrTestStorage.syncState.guideDone === true;
  // 恢复默认设置 asks once in place, closes the panel and goes back to first use, the guide
  // included: its record is gone from everywhere, so it stays until it is answered again.
  globalThis.__btrTestStorage.syncState.concurrency = 32;
  globalThis.__btrTestStorage.syncState.mode = "overseas";
  button().click();
  await wait(200);
  const resetButton = () => document.getElementById("__bilibili_thread_ripper_settings__")?.shadowRoot?.getElementById("reset-settings");
  const resetLabel = resetButton()?.textContent === "恢复默认设置";
  resetButton()?.click();
  const resetAsks = resetButton()?.textContent === "确认？" && globalThis.__btrTestStorage.syncState.concurrency === 32;
  resetButton()?.dispatchEvent(new FocusEvent("blur"));
  const resetTakenBack = resetButton()?.textContent === "恢复默认设置";
  resetButton()?.click();
  resetButton()?.click();
  await wait(200);
  const resetDone = !panel() && globalThis.__btrTestStorage.syncState.concurrency === 8 && globalThis.__btrTestStorage.syncState.mode === "mainland";
  const resetBringsGuide = Boolean(guideHost()) && globalThis.__btrTestStorage.syncState.guideDone === false && !guideCookie;
  guideRoot()?.querySelector(".btr-guide")?.click();
  await wait(200);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(300);
  const answeredAgain = !guideHost() && globalThis.__btrTestStorage.syncState.guideDone === true && guideCookie;
  button().style.top = ""; button().style.left = ""; button().style.right = "";
  root.dispatchEvent(new Event("resize"));
  await wait(100);
  const shownByDefault = Boolean(button());
  const label = button()?.textContent || "";
  // Never dragged: it sits near the bottom right, clear of Bilibili's own row of buttons.
  const startBox = button()?.getBoundingClientRect();
  const defaultSpot = Boolean(startBox) && startBox.top > root.innerHeight / 2
    && root.innerWidth - startBox.right > 40 && root.innerWidth - startBox.right < 120;

  // Clicking it opens the panel; the button steps aside while the panel is open.
  button()?.click();
  await wait(200);
  const panelOpened = Boolean(panel());
  const hiddenWhilePanelOpen = !button();

  // The switch inside the panel turns it off and on again.
  const switchInput = panel()?.querySelector(`#${"__bilibili_thread_ripper_settings__"}`)
    ?.shadowRoot?.getElementById("floating-button");
  const switchWasOn = switchInput?.checked === true;
  if (switchInput) {
    switchInput.checked = false;
    switchInput.dispatchEvent(new Event("change", { bubbles: true }));
  }
  await wait(300);
  const savedOff = globalThis.__btrTestStorage.syncState.floatingButton === false;
  // Close the panel: with the switch off the button must stay away.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(300);
  const hiddenWhenSwitchedOff = !button();

  // Back on through the stored settings, the way another tab would change them.
  globalThis.chrome.storage.sync.set({ floatingButton: true }, () => {});
  await wait(400);
  const backAfterSwitchedOn = Boolean(button());

  // 网页全屏 keeps the browser out of it: the picture simply fills the window. The button
  // goes away for any video that covers the window, however it got there.
  const video = player.querySelector("video");
  video.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;";
  root.dispatchEvent(new Event("resize"));
  await wait(200);
  const hiddenInWebFullscreen = !button();
  video.style.cssText = "width:320px;height:180px;";
  root.dispatchEvent(new Event("resize"));
  await wait(200);
  const backAfterFullscreen = Boolean(button());

  // Dragging: pick it up, move it, let go. Dropped in the middle it stays put; dropped near
  // an edge it snaps flush to it. Dragging never counts as a click.
  const opacity = Number(getComputedStyle(button()).opacity);
  const drag = (toX, toY) => {
    const box = button().getBoundingClientRect();
    const at = (type, x, y) => button().dispatchEvent(new PointerEvent(type, { pointerId: 7, clientX: x, clientY: y, bubbles: true, button: 0 }));
    at("pointerdown", box.left + 20, box.top + 20);
    at("pointermove", toX + 20, toY + 20);
    at("pointerup", toX + 20, toY + 20);
  };
  // Well away from both edges: it stays exactly there.
  const middle = Math.round(root.innerWidth / 2);
  drag(middle, 240);
  await wait(200);
  const afterFreeDrag = button().getBoundingClientRect();
  const stayedWhereDropped = Math.abs(afterFreeDrag.left - middle) < 8 && Math.abs(afterFreeDrag.top - 240) < 24;
  const panelStayedClosed = !panel();
  const savedFreeSpot = Math.abs(Number(globalThis.__btrTestStorage.syncState.floatingButtonLeft) - middle / root.innerWidth) < 0.04
    && Math.abs(Number(globalThis.__btrTestStorage.syncState.floatingButtonTop) - 240 / root.innerHeight) < 0.06;
  // Close to the left edge: it snaps flush to it.
  drag(40, 260);
  await wait(200);
  const afterDrag = button().getBoundingClientRect();
  const snappedLeft = afterDrag.left <= 16 && Math.abs(afterDrag.top - 260) < 24;
  const savedLeftEdge = Number(globalThis.__btrTestStorage.syncState.floatingButtonLeft) === 0;
  // Close to the right edge: flush to that one.
  drag(root.innerWidth - 70, 300);
  await wait(200);
  const snappedRight = button().getBoundingClientRect().right >= root.innerWidth - 20;
  const savedRightEdge = Number(globalThis.__btrTestStorage.syncState.floatingButtonLeft) === 1;

  const noOnboarding = !document.getElementById("__bilibili_thread_ripper_onboarding__");

  const result = {
    shownByDefault,
    label,
    panelOpened,
    hiddenWhilePanelOpen,
    switchWasOn,
    savedOff,
    hiddenWhenSwitchedOff,
    backAfterSwitchedOn,
    hiddenInWebFullscreen,
    backAfterFullscreen,
    noOnboarding,
    guideShown, guideText, guideBold, arrowOnButton, unanswered, arrowFollows, guideGone, guideOpenedPanel, guideSaved, guideStaysAway, markIsEnough, resetLabel, resetAsks, resetTakenBack, resetDone, resetBringsGuide, answeredAgain,
    defaultSpot,
    faintUntilHovered: opacity >= 0.5 && opacity <= 0.7,
    stayedWhereDropped,
    savedFreeSpot,
    snappedLeft,
    savedLeftEdge,
    snappedRight,
    savedRightEdge,
    panelStayedClosed,
    errors: []
  };
  result.pass = Object.entries(result).every(([key, value]) => ["errors", "label"].includes(key) ? true : value === true)
    && result.label === "BTR" && result.errors.length === 0;
  resultNode.textContent = JSON.stringify(result, null, 2);
  resultNode.dataset.pass = String(result.pass);
})();
