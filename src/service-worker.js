"use strict";

const BADGE_COLOR = "#fb7299";
const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;
const SUBTITLE_HOST_RE = /(?:^|\.)hdslb\.com$/i;

function subtitleUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && SUBTITLE_HOST_RE.test(url.hostname) && url.href.length <= 4096 ? url.href : "";
  } catch (_error) {
    return "";
  }
}

async function fetchSubtitleText(value) {
  const url = subtitleUrl(value);
  if (!url) throw new Error("无效的字幕地址");
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("字幕请求超时", "TimeoutError")), 8000);
    try {
      const response = await fetch(url, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) {
        const error = new Error(`字幕服务器 HTTP ${response.status}`);
        if (response.status < 500 && ![408, 425, 429].includes(response.status)) throw error;
        lastError = error;
      } else {
        const declaredLength = Number(response.headers.get("content-length")) || 0;
        if (declaredLength > MAX_SUBTITLE_BYTES) throw new Error("字幕文件超过 8 MiB 限制");
        const text = await response.text();
        if (text.length > MAX_SUBTITLE_BYTES) throw new Error("字幕文件超过 8 MiB 限制");
        return text;
      }
    } catch (error) {
      lastError = error;
      if (error?.message === "字幕文件超过 8 MiB 限制" || /HTTP 4\d\d/.test(String(error?.message)) && !/HTTP (?:408|425|429)/.test(String(error?.message))) throw error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 250 : 800));
  }
  throw lastError || new Error("字幕下载失败");
}

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
  if (message?.type === "fetchSubtitleText") {
    fetchSubtitleText(message.url)
      .then((text) => ({ ok: true, text }))
      .catch((error) => ({ ok: false, error: String(error?.message || error).slice(0, 180) }))
      .then(sendResponse);
    return true;
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
