"use strict";

const BADGE_COLOR = "#fb7299";

function enableActionSidePanel() {
  return chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error("无法启用侧边栏入口", error));
}

function setThreadBadge(tabId, enabled, activeThreads) {
  if (!Number.isInteger(tabId)) return Promise.resolve();
  const count = Math.max(0, Math.min(512, Math.trunc(Number(activeThreads) || 0)));
  const text = enabled ? String(count) : "";
  return Promise.all([
    chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }),
    chrome.action.setBadgeText({ tabId, text })
  ]).catch((error) => console.error("无法更新线程徽标", error));
}

enableActionSidePanel();
chrome.runtime.onInstalled.addListener(enableActionSidePanel);
chrome.runtime.onStartup.addListener(enableActionSidePanel);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "setThreadBadge") {
    setThreadBadge(sender.tab?.id, message.enabled === true, message.activeThreads);
    return false;
  }
  if (message?.type !== "fetchDanmakuXml") return false;
  const cid = Number(message.cid);
  if (!Number.isSafeInteger(cid) || cid <= 0) {
    sendResponse({ ok: false, error: "无效的弹幕 cid" });
    return false;
  }
  fetch(`https://comment.bilibili.com/${cid}.xml`, {
    method: "GET",
    credentials: "omit",
    cache: "no-store"
  }).then(async (response) => {
    if (!response.ok) throw new Error(`弹幕服务器 HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length")) || 0;
    if (declaredLength > 20 * 1024 * 1024) throw new Error("弹幕文件超过 20 MiB 限制");
    const xml = await response.text();
    if (xml.length > 20 * 1024 * 1024) throw new Error("弹幕文件超过 20 MiB 限制");
    return { ok: true, xml };
  }).catch((error) => ({ ok: false, error: String(error?.message || error).slice(0, 180) }))
    .then(sendResponse);
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") setThreadBadge(tabId, false, 0);
});
