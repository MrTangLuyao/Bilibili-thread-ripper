(async () => {
  "use strict";

  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const resultNode = document.getElementById("result");
  await wait(5000);

  const firstPanel = document.getElementById("__bilibili_thread_ripper_onboarding__");
  const initialMode = firstPanel?.querySelector('input[name="btr-onboarding-mode"]:checked')?.value || "";
  const initialThreads = firstPanel?.querySelector('input[type="range"]')?.value || "";
  const overseas = firstPanel?.querySelector('input[name="btr-onboarding-mode"][value="overseas"]');
  const range = firstPanel?.querySelector('input[type="range"]');
  if (overseas) overseas.checked = true;
  if (range) {
    range.value = "4";
    range.dispatchEvent(new Event("input", { bubbles: true }));
  }
  firstPanel?.querySelector(".btr-onboarding-save")?.click();
  await wait(50);

  const afterSavePanel = document.getElementById("__bilibili_thread_ripper_onboarding__");
  const secondBridge = document.createElement("script");
  secondBridge.src = `/src/bridge.js?second=${Date.now()}`;
  document.body.append(secondBridge);
  await new Promise((resolve) => secondBridge.addEventListener("load", resolve, { once: true }));
  await wait(500);
  const repeatedPanel = document.getElementById("__bilibili_thread_ripper_onboarding__");

  const result = {
    firstPanelVisible: Boolean(firstPanel),
    version: firstPanel?.dataset.version || "",
    defaultMode: initialMode,
    defaultThreadIndex: initialThreads,
    savedMode: globalThis.__btrTestStorage.syncState.mode,
    savedConcurrency: globalThis.__btrTestStorage.syncState.concurrency,
    savedEnabled: globalThis.__btrTestStorage.syncState.enabled,
    completedRevision: globalThis.__btrTestStorage.localState.btrOnboardingRevision,
    removedAfterSave: !afterSavePanel,
    hiddenOnSecondLoad: !repeatedPanel
  };
  result.pass = result.firstPanelVisible
    && result.version === "0.9.0"
    && result.defaultMode === "mainland"
    && result.defaultThreadIndex === "3"
    && result.savedMode === "overseas"
    && result.savedConcurrency === 64
    && result.savedEnabled === true
    && result.completedRevision === "native-player-v1"
    && result.removedAfterSave
    && result.hiddenOnSecondLoad;
  resultNode.textContent = JSON.stringify(result, null, 2);
  resultNode.dataset.pass = String(result.pass);
})();
