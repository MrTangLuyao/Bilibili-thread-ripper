"use strict";

const THREAD_OPTIONS = [4, 8, 16, 32, 64, 128];
const enabled = document.getElementById("enabled");
const concurrency = document.getElementById("concurrency");
const threadValue = document.getElementById("thread-value");
const sliderFill = document.getElementById("slider-fill");
const activeCount = document.getElementById("active-count");
const totalSpeed = document.getElementById("total-speed");
const threadList = document.getElementById("thread-list");
const playerState = document.getElementById("player-state");
const quality = document.getElementById("quality");
const lastError = document.getElementById("last-error");
let timer = null;

function formatSpeed(value) {
  const bps = Math.max(0, Number(value) || 0);
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(bps >= 10 * 1024 * 1024 ? 0 : 1)} MiB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(bps >= 100 * 1024 ? 0 : 1)} KiB/s`;
  return `${Math.round(bps)} B/s`;
}

function shortHost(host) {
  const value = String(host || "").toLowerCase();
  if (value.includes("akamaized")) return "AKA";
  if (value.includes("mirrorali")) return "ALI";
  if (value.includes("mirrorcos")) return "COS";
  if (value.includes("mirrorhw")) return "HW";
  if (value.includes("cn-hk")) return "HK";
  return value ? value.split(".")[0].slice(-5).toUpperCase() : "CDN";
}

function stateText(value) {
  return ({
    waiting: "等待视频",
    loading: "正在建立加速连接",
    ready: "B站原生播放器加速中",
    ended: "播放结束",
    error: "加速连接发生错误",
    "native-fallback": "已使用 B站原始连接",
    disabled: "已关闭"
  })[value] || "等待视频";
}

function render(stats) {
  const threads = Array.isArray(stats?.threadSpeeds) ? stats.threadSpeeds : [];
  activeCount.textContent = String(Math.max(0, Number(stats?.activeThreads) || 0));
  totalSpeed.textContent = formatSpeed(stats?.totalSpeedBps);
  playerState.textContent = stateText(stats?.playerState);
  quality.textContent = stats?.quality || "";
  lastError.hidden = !stats?.lastError;
  lastError.textContent = stats?.lastError || "";
  threadList.replaceChildren();
  if (!threads.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "暂无线程";
    threadList.append(empty);
    return;
  }
  const max = Math.max(1, ...threads.map((item) => Number(item.bps) || 0));
  const fragment = document.createDocumentFragment();
  for (const item of threads) {
    const row = document.createElement("div");
    row.className = `thread-row ${item.state || "active"}`;
    const label = document.createElement("span");
    label.className = `thread-label ${item.kind || "video"}`;
    label.textContent = item.label || "V";
    const host = document.createElement("span");
    host.className = "thread-host";
    host.textContent = shortHost(item.host);
    host.title = item.host || "Bilibili CDN";
    const track = document.createElement("span");
    track.className = "speed-track";
    const bar = document.createElement("span");
    bar.className = "speed-bar";
    bar.style.width = `${Math.max(0, Math.min(100, (Number(item.bps) || 0) / max * 100))}%`;
    track.append(bar);
    const speed = document.createElement("span");
    speed.className = "thread-speed";
    speed.textContent = item.state === "error" ? "重试" : formatSpeed(item.bps);
    row.append(label, host, track, speed);
    fragment.append(row);
  }
  threadList.append(fragment);
}

async function refresh() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("没有活动标签页");
    const response = await chrome.tabs.sendMessage(tab.id, { type: "getStatus" });
    render(response?.stats || null);
  } catch (_error) {
    render(null);
  }
}

function setSlider(threads) {
  const index = THREAD_OPTIONS.indexOf(Number(threads));
  const safe = index < 0 ? 3 : index;
  concurrency.value = String(safe);
  threadValue.value = String(THREAD_OPTIONS[safe]);
  concurrency.setAttribute("aria-valuetext", String(THREAD_OPTIONS[safe]));
  sliderFill.style.width = `${safe / (THREAD_OPTIONS.length - 1) * 100}%`;
}

async function init() {
  const stored = await chrome.storage.sync.get({
    enabled: true,
    concurrency: 32,
    mode: "mainland",
    compatibilityMode: "off"
  });
  enabled.checked = stored.enabled !== false;
  setSlider(stored.concurrency);
  const chosen = document.querySelector(`input[name="mode"][value="${stored.mode === "overseas" ? "overseas" : "mainland"}"]`);
  const compatibilityValue = ["off", "a", "b"].includes(stored.compatibilityMode) ? stored.compatibilityMode : "off";
  const compatibilityChosen = document.querySelector(`input[name="compatibility-mode"][value="${compatibilityValue}"]`);
  chosen.checked = true;
  compatibilityChosen.checked = true;
  await chrome.storage.sync.set({
    enabled: enabled.checked,
    concurrency: THREAD_OPTIONS[Number(concurrency.value)],
    mode: chosen.value,
    compatibilityMode: compatibilityChosen.value
  });
  enabled.addEventListener("change", () => chrome.storage.sync.set({ enabled: enabled.checked }));
  concurrency.addEventListener("input", () => {
    const threads = THREAD_OPTIONS[Number(concurrency.value)];
    setSlider(threads);
    chrome.storage.sync.set({ concurrency: threads });
  });
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener("change", () => {
      if (radio.checked) chrome.storage.sync.set({ mode: radio.value });
    });
  }
  for (const radio of document.querySelectorAll('input[name="compatibility-mode"]')) {
    radio.addEventListener("change", () => {
      if (radio.checked) chrome.storage.sync.set({ compatibilityMode: radio.value });
    });
  }
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (changes.compatibilityMode) {
      const next = ["off", "a", "b"].includes(changes.compatibilityMode.newValue)
        ? changes.compatibilityMode.newValue
        : "off";
      const radio = document.querySelector(`input[name="compatibility-mode"][value="${next}"]`);
      if (radio) radio.checked = true;
    }
  });
  await refresh();
  timer = setInterval(refresh, 400);
}

init();
window.addEventListener("unload", () => clearInterval(timer));
