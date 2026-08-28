(function installBilibiliDanmaku(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const MAX_XML_BYTES = 20 * 1024 * 1024;
  const MAX_DANMAKU = 50000;
  const MIXIN_KEY_ENC_TAB = Object.freeze([
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
  ]);
  let mixinCache = null;

  function notice(getArt, message) {
    const art = getArt?.();
    if (art?.notice) art.notice.show = String(message).slice(0, 160);
  }

  function currentVideoKey() {
    const match = /\/video\/(BV[0-9A-Za-z]+|av\d+)/i.exec(root.location.pathname);
    if (!match) return {};
    return /^BV/i.test(match[1])
      ? { bvid: match[1] }
      : { aid: Number(match[1].slice(2)) || 0 };
  }

  function currentPartIndex() {
    const part = Number(new URLSearchParams(root.location.search).get("p"));
    return Number.isInteger(part) && part > 0 ? part - 1 : 0;
  }

  function identityFromInitialState() {
    try {
      const state = root.__INITIAL_STATE__;
      const videoData = state?.videoData || state?.videoInfo || state?.ugcSeason?.sections?.[0]?.episodes?.[0];
      if (!videoData) return null;
      const pages = Array.isArray(videoData.pages) ? videoData.pages : [];
      const page = pages[currentPartIndex()] || pages[0];
      const cid = Number(page?.cid || videoData.cid);
      const aid = Number(videoData.aid || videoData.id);
      const bvid = String(videoData.bvid || currentVideoKey().bvid || "");
      return Number.isSafeInteger(cid) && cid > 0 ? { aid, bvid, cid } : null;
    } catch (_error) {
      return null;
    }
  }

  async function resolveIdentity(nativeFetch) {
    const initial = identityFromInitialState();
    if (initial) return initial;
    const key = currentVideoKey();
    const query = key.bvid ? `bvid=${encodeURIComponent(key.bvid)}` : `aid=${encodeURIComponent(key.aid || "")}`;
    const response = await nativeFetch(`https://api.bilibili.com/x/web-interface/view?${query}`, {
      credentials: "include",
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`视频信息请求失败：HTTP ${response.status}`);
    const body = await response.json();
    if (Number(body?.code) !== 0 || !body?.data) throw new Error(body?.message || "无法读取视频信息");
    const data = body.data;
    const pages = Array.isArray(data.pages) ? data.pages : [];
    const page = pages[currentPartIndex()] || pages[0];
    const cid = Number(page?.cid || data.cid);
    if (!Number.isSafeInteger(cid) || cid <= 0) throw new Error("视频信息缺少 cid");
    return { aid: Number(data.aid) || 0, bvid: String(data.bvid || key.bvid || ""), cid };
  }

  function requestDanmakuXml(cid) {
    const numericCid = Number(cid);
    if (!Number.isSafeInteger(numericCid) || numericCid <= 0) return Promise.reject(new Error("无效的弹幕 cid"));
    const requestId = root.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("弹幕服务器响应超时"));
      }, 15000);
      const onMessage = (event) => {
        if (event.source !== root || event.data?.channel !== CHANNEL || event.data?.type !== "danmaku-response") return;
        if (event.data.requestId !== requestId) return;
        cleanup();
        const payload = event.data.payload;
        if (!payload?.ok) reject(new Error(payload?.error || "弹幕加载失败"));
        else if (typeof payload.xml !== "string" || payload.xml.length > MAX_XML_BYTES) reject(new Error("弹幕数据格式或大小异常"));
        else resolve(payload.xml);
      };
      const cleanup = () => {
        clearTimeout(timer);
        root.removeEventListener("message", onMessage);
      };
      root.addEventListener("message", onMessage);
      root.postMessage({ channel: CHANNEL, type: "danmaku-request", requestId, cid: numericCid }, "*");
    });
  }

  function decimalColor(value) {
    const number = Math.max(0, Math.min(0xffffff, Number(value) || 0xffffff));
    return `#${Math.trunc(number).toString(16).padStart(6, "0")}`;
  }

  function parseDanmakuXml(xml) {
    const documentXml = new DOMParser().parseFromString(xml, "text/xml");
    if (documentXml.querySelector("parsererror")) throw new Error("弹幕 XML 解析失败");
    const output = [];
    for (const node of documentXml.querySelectorAll("d")) {
      if (output.length >= MAX_DANMAKU) break;
      const fields = String(node.getAttribute("p") || "").split(",");
      const biliMode = Number(fields[1]);
      if ([7, 8, 9].includes(biliMode)) continue;
      const text = String(node.textContent || "").trim();
      if (!text) continue;
      output.push({
        text: text.slice(0, 1000),
        time: Math.max(0, Number(fields[0]) || 0),
        mode: biliMode === 5 ? 1 : biliMode === 4 ? 2 : 0,
        color: decimalColor(fields[3])
      });
    }
    return output;
  }

  function cookieValue(name) {
    const prefix = `${name}=`;
    for (const part of String(document.cookie || "").split(/;\s*/)) {
      if (part.startsWith(prefix)) return decodeURIComponent(part.slice(prefix.length));
    }
    return "";
  }

  function rotateLeft(value, shift) {
    return (value << shift) | (value >>> (32 - shift));
  }

  function md5(input) {
    const bytes = new TextEncoder().encode(String(input));
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const bitLength = bytes.length * 8;
    for (let index = 0; index < 8; index += 1) padded[paddedLength - 8 + index] = Math.floor(bitLength / (2 ** (8 * index))) & 0xff;
    const shifts = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    const constants = Array.from({ length: 64 }, (_value, index) => Math.floor(Math.abs(Math.sin(index + 1)) * (2 ** 32)) | 0);
    let a0 = 0x67452301 | 0;
    let b0 = 0xefcdab89 | 0;
    let c0 = 0x98badcfe | 0;
    let d0 = 0x10325476 | 0;
    for (let offset = 0; offset < padded.length; offset += 64) {
      const words = new Int32Array(16);
      for (let index = 0; index < 16; index += 1) {
        const start = offset + index * 4;
        words[index] = padded[start] | (padded[start + 1] << 8) | (padded[start + 2] << 16) | (padded[start + 3] << 24);
      }
      let a = a0;
      let b = b0;
      let c = c0;
      let d = d0;
      for (let index = 0; index < 64; index += 1) {
        let f;
        let g;
        if (index < 16) { f = (b & c) | (~b & d); g = index; }
        else if (index < 32) { f = (d & b) | (~d & c); g = (5 * index + 1) % 16; }
        else if (index < 48) { f = b ^ c ^ d; g = (3 * index + 5) % 16; }
        else { f = c ^ (b | ~d); g = (7 * index) % 16; }
        const previousD = d;
        d = c;
        c = b;
        b = (b + rotateLeft((a + f + constants[index] + words[g]) | 0, shifts[index])) | 0;
        a = previousD;
      }
      a0 = (a0 + a) | 0;
      b0 = (b0 + b) | 0;
      c0 = (c0 + c) | 0;
      d0 = (d0 + d) | 0;
    }
    return [a0, b0, c0, d0].map((word) => {
      const value = word >>> 0;
      return [0, 8, 16, 24].map((shift) => ((value >>> shift) & 0xff).toString(16).padStart(2, "0")).join("");
    }).join("");
  }

  function filenameKey(value) {
    try { return new URL(value).pathname.split("/").pop().split(".")[0]; }
    catch (_error) { return ""; }
  }

  async function getMixinKey(nativeFetch) {
    if (mixinCache && mixinCache.expiresAt > Date.now()) return mixinCache.key;
    const response = await nativeFetch("https://api.bilibili.com/x/web-interface/nav", {
      credentials: "include",
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`登录信息请求失败：HTTP ${response.status}`);
    const body = await response.json();
    if (Number(body?.code) !== 0) throw new Error(body?.message || "无法读取 WBI 密钥");
    const raw = `${filenameKey(body?.data?.wbi_img?.img_url)}${filenameKey(body?.data?.wbi_img?.sub_url)}`;
    const key = MIXIN_KEY_ENC_TAB.map((index) => raw[index] || "").join("").slice(0, 32);
    if (key.length !== 32) throw new Error("WBI 密钥格式异常");
    mixinCache = { key, expiresAt: Date.now() + 10 * 60 * 1000 };
    return key;
  }

  async function signedQuery(nativeFetch, parameters) {
    const mixinKey = await getMixinKey(nativeFetch);
    const clean = Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, String(value).replace(/[!'()*]/g, "")]));
    clean.wts = String(Math.floor(Date.now() / 1000));
    const query = Object.keys(clean).sort().map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(clean[key])}`).join("&");
    return `${query}&w_rid=${md5(query + mixinKey)}`;
  }

  function modeForBilibili(mode) {
    return Number(mode) === 1 ? 5 : Number(mode) === 2 ? 4 : 1;
  }

  async function sendDanmaku(nativeFetch, identity, art, danmu) {
    const csrf = cookieValue("bili_jct");
    if (!csrf) throw new Error("请先登录 Bilibili 后再发送弹幕");
    const text = String(danmu?.text || "").trim();
    if (!text) throw new Error("弹幕内容不能为空");
    if (text.length > 100) throw new Error("Bilibili 普通弹幕不能超过 100 个字符");
    const query = await signedQuery(nativeFetch, { csrf, web_location: 1315873 });
    const body = new URLSearchParams({
      type: "1",
      oid: String(identity.cid),
      msg: text,
      progress: String(Math.max(0, Math.round((Number(art?.currentTime) || 0) * 1000))),
      color: String(parseInt(String(danmu?.color || "#ffffff").replace("#", ""), 16) || 0xffffff),
      fontsize: "25",
      pool: "0",
      mode: String(modeForBilibili(danmu?.mode)),
      rnd: `${Date.now()}${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`,
      plat: "1",
      csrf,
      csrf_token: csrf
    });
    if (identity.bvid) body.set("bvid", identity.bvid);
    else body.set("aid", String(identity.aid));
    const response = await nativeFetch(`https://api.bilibili.com/x/v2/dm/post?${query}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: body.toString()
    });
    if (!response.ok) throw new Error(`弹幕发送失败：HTTP ${response.status}`);
    const result = await response.json();
    if (Number(result?.code) !== 0) throw new Error(result?.message || `弹幕接口错误 ${result?.code}`);
    return result;
  }

  function createPlugin(options) {
    const nativeFetch = options.nativeFetch || root.fetch.bind(root);
    const getArt = options.getArt;
    const initialFontSize = Math.max(12, Math.min(64, Math.round(Number(options.fontSize) || 25)));
    const identityPromise = resolveIdentity(nativeFetch);
    const pluginFactory = root.artplayerPluginDanmuku({
      danmuku: async () => {
        try {
          const identity = await identityPromise;
          const xml = await requestDanmakuXml(identity.cid);
          const entries = parseDanmakuXml(xml);
          if (!entries.length) notice(getArt, "当前分 P 暂无普通弹幕");
          return entries;
        } catch (error) {
          notice(getArt, `弹幕加载失败：${error?.message || error}`);
          return [];
        }
      },
      speed: 5,
      margin: ["8%", "18%"],
      opacity: 0.9,
      mode: 0,
      modes: [0, 1, 2],
      fontSize: initialFontSize,
      FONT_SIZE: { min: 12, max: 64 },
      antiOverlap: true,
      synchronousPlayback: true,
      visible: true,
      emitter: true,
      maxLength: 100,
      lockTime: 3,
      beforeEmit: async (danmu) => {
        try {
          const identity = await identityPromise;
          await sendDanmaku(nativeFetch, identity, getArt?.(), danmu);
          notice(getArt, "弹幕发送成功");
          return true;
        } catch (error) {
          notice(getArt, `弹幕发送失败：${error?.message || error}`);
          return false;
        }
      }
    });
    return (art) => {
      let initialized = false;
      let lastFontSize = initialFontSize;
      art.on("artplayerPluginDanmuku:config", (config) => {
        const fontSize = Math.max(12, Math.min(64, Math.round(Number(config?.fontSize) || 25)));
        if (initialized && fontSize !== lastFontSize) options.onFontSizeChange?.(fontSize);
        lastFontSize = fontSize;
      });
      const plugin = pluginFactory(art);
      initialized = true;
      return plugin;
    };
  }

  root.__BILI_DANMAKU_FACTORY__ = Object.freeze({
    createPlugin,
    md5,
    parseDanmakuXml,
    resolveIdentity
  });
})(globalThis);
