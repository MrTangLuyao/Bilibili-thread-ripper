(async function runErrorNoticeTest(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  let retryObserved = false;
  root.addEventListener("message", (event) => {
    if (event.source === root && event.data?.channel === CHANNEL && event.data.type === "retry-takeover") retryObserved = true;
  });
  await wait(50);
  root.postMessage({
    channel: CHANNEL,
    type: "stats",
    payload: {
      version: "0.9.1.0",
      playerState: "error",
      takeoverError: { id: 1, at: Date.now(), route: "bv1errorroute:p1", stage: "playinfo", message: "读取视频信息失败（HTTP 404）", retryCount: 2 }
    }
  }, "*");
  await wait(50);
  const notice = document.getElementById("__bilibili_thread_ripper_error_notice__");
  notice?.querySelector(".btr-error-toggle")?.click();
  notice?.querySelector(".btr-error-retry")?.click();
  await wait(50);
  const logText = notice?.querySelector(".btr-error-log")?.textContent || "";
  root.postMessage({ channel: CHANNEL, type: "stats", payload: { version: "0.9.1.0", playerState: "ready", takeoverError: null } }, "*");
  await wait(50);
  const output = {
    title: notice?.querySelector(".btr-error-title")?.textContent || "",
    expanded: notice?.dataset.expanded || "",
    logText,
    retryObserved,
    removedWhenReady: !document.getElementById("__bilibili_thread_ripper_error_notice__")
  };
  output.pass = output.title === "Bilibili 线程撕裂者错误"
    && output.expanded === "true"
    && /HTTP 404/.test(output.logText)
    && /playinfo/.test(output.logText)
    && output.retryObserved
    && output.removedWhenReady;
  const result = document.getElementById("error-notice-result");
  result.textContent = JSON.stringify(output);
  result.dataset.pass = String(output.pass);
})(globalThis);
