(function installBilibiliSubtitle(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;
  const ALLOWED_HOST_RE = /(?:^|\.)(?:bilibili\.com|hdslb\.com|bilivideo\.com)$/i;
  const OFF_VALUE = "off";
  const OFF_VTT = "WEBVTT\n\n";
  const CC_ICON = '<span class="btr-cc-icon" aria-hidden="true">CC</span>';

  function normalizeSubtitlePreference(value) {
    const text = String(value || OFF_VALUE).trim().slice(0, 48);
    return /^[\w-]+$/i.test(text) ? text : OFF_VALUE;
  }

  function normalizeLastSubtitlePreference(value) {
    const text = String(value || "").trim().slice(0, 48);
    return text && text.toLowerCase() !== OFF_VALUE && /^[\w-]+$/i.test(text) ? text : "";
  }

  function normalizeUrl(value) {
    try {
      const raw = String(value || "").trim();
      const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw, "https://api.bilibili.com/");
      if (url.protocol !== "https:" || !ALLOWED_HOST_RE.test(url.hostname)) return "";
      return url.href;
    } catch (_error) {
      return "";
    }
  }

  function isAiTrack(track) {
    return Number(track?.ai_type) > 0 || /^ai-/i.test(String(track?.lan || "")) || /自动生成|auto[- ]?generated/i.test(String(track?.lan_doc || ""));
  }

  function fallbackLanguageName(lan) {
    const code = String(lan || "").toLowerCase();
    if (/^(?:ai-)?zh(?:-|$)/.test(code)) return "中文";
    if (/^en(?:-|$)/.test(code)) return "英语";
    if (/^ja(?:-|$)/.test(code)) return "日语";
    if (/^ko(?:-|$)/.test(code)) return "韩语";
    return lan || "字幕";
  }

  function subtitleLabel(track) {
    const ai = isAiTrack(track);
    let label = String(track?.lan_doc || "").trim() || fallbackLanguageName(track?.lan);
    if (ai && !/自动生成|auto[- ]?generated/i.test(label)) label += "（自动生成）";
    return label.slice(0, 80);
  }

  function normalizeTracks(input) {
    const tracks = Array.isArray(input) ? input : [];
    const seen = new Set();
    const output = [];
    for (let index = 0; index < tracks.length; index += 1) {
      const source = tracks[index] || {};
      const url = normalizeUrl(source.subtitle_url || source.url);
      if (!url) continue;
      const lan = normalizeSubtitlePreference(source.lan || `track-${index + 1}`);
      const id = String(source.id_str || source.id || `${lan}-${index + 1}`).slice(0, 80);
      const dedupeKey = `${id}\n${url}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      output.push(Object.freeze({
        id,
        lan,
        label: subtitleLabel(source),
        url,
        aiGenerated: isAiTrack(source),
        aiStatus: Number(source.ai_status) || 0,
        type: Number(source.type) || 0
      }));
    }
    return output;
  }

  function vttTimestamp(value) {
    const milliseconds = Math.max(0, Math.round((Number(value) || 0) * 1000));
    const hours = Math.floor(milliseconds / 3600000);
    const minutes = Math.floor(milliseconds % 3600000 / 60000);
    const seconds = Math.floor(milliseconds % 60000 / 1000);
    const millis = milliseconds % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  }

  function normalizeCueContent(value) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[\u2028\u2029]/g, "\n")
      .replace(/\\[Nn]/g, "\n")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/(?:&#10;|&#x0*A;|&NewLine;)/gi, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/-->/g, "→")
      .trim();
  }

  function subtitleJsonToVtt(payload) {
    const entries = Array.isArray(payload?.body) ? payload.body : [];
    const cues = [];
    for (const entry of entries) {
      const from = Number(entry?.from);
      const to = Number(entry?.to);
      const content = normalizeCueContent(entry?.content);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || !content) continue;
      cues.push(`${vttTimestamp(from)} --> ${vttTimestamp(to)}\n${content}`);
    }
    return `${OFF_VTT}${cues.join("\n\n")}${cues.length ? "\n" : ""}`;
  }

  function requestSubtitleText(url, signal) {
    const requestId = root.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason || new DOMException("字幕任务已取消", "AbortError"));
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("字幕服务器响应超时"));
      }, 30000);
      const onAbort = () => {
        cleanup();
        reject(signal.reason || new DOMException("字幕任务已取消", "AbortError"));
      };
      const onMessage = (event) => {
        if (event.source !== root || event.data?.channel !== CHANNEL || event.data?.type !== "subtitle-response") return;
        if (event.data.requestId !== requestId) return;
        cleanup();
        const payload = event.data.payload;
        if (!payload?.ok) reject(new Error(payload?.error || "字幕下载失败"));
        else if (typeof payload.text !== "string" || payload.text.length > MAX_SUBTITLE_BYTES) reject(new Error("字幕数据格式或大小异常"));
        else resolve(payload.text);
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        root.removeEventListener("message", onMessage);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      root.addEventListener("message", onMessage);
      root.postMessage({ channel: CHANNEL, type: "subtitle-request", requestId, url }, "*");
    });
  }

  async function resolveSubtitleTracks(nativeFetch, signal, expectedIdentity, identityPromise, onIdentity) {
    const danmakuFactory = root.__BILI_DANMAKU_FACTORY__;
    if (!danmakuFactory?.resolveIdentity) return [];
    const identity = identityPromise
      ? await identityPromise
      : await danmakuFactory.resolveIdentity(nativeFetch, expectedIdentity, signal);
    if (signal?.aborted) throw signal.reason || new DOMException("字幕任务已取消", "AbortError");
    onIdentity?.(identity);
    const query = new URLSearchParams({ cid: String(identity.cid) });
    if (identity.bvid) query.set("bvid", identity.bvid);
    if (identity.aid) query.set("aid", String(identity.aid));
    const response = await nativeFetch(`https://api.bilibili.com/x/player/v2?${query}`, {
      credentials: "include",
      cache: "no-store",
      signal
    });
    if (!response.ok) throw new Error(`字幕列表请求失败：HTTP ${response.status}`);
    const payload = await response.json();
    if (Number(payload?.code) !== 0) throw new Error(payload?.message || "字幕列表请求失败");
    const responseBvid = String(payload?.data?.bvid || "");
    const responseAid = Number(payload?.data?.aid) || 0;
    const responseCid = Number(payload?.data?.cid) || 0;
    if (identity.bvid && responseBvid.toLowerCase() !== identity.bvid.toLowerCase()) throw new Error("字幕身份校验失败（BVID 不一致）");
    if (identity.aid && responseAid !== Number(identity.aid)) throw new Error("字幕身份校验失败（AID 不一致）");
    if (responseCid !== Number(identity.cid)) throw new Error("字幕身份校验失败（CID 不一致）");
    return normalizeTracks(payload?.data?.subtitle?.subtitles);
  }

  async function fetchSubtitleVtt(track, signal) {
    const text = await requestSubtitleText(track.url, signal);
    let payload;
    try { payload = JSON.parse(text); }
    catch (_error) { throw new Error("字幕文件格式异常"); }
    return subtitleJsonToVtt(payload);
  }

  function attach(options) {
    const art = options.art;
    const nativeFetch = options.nativeFetch || root.fetch.bind(root);
    const controller = new AbortController();
    let disposed = false;
    let activeUrl = "";
    let preference = normalizeSubtitlePreference(options.preference);
    let lastPreference = normalizeLastSubtitlePreference(options.lastPreference);
    if (preference !== OFF_VALUE) lastPreference = preference;
    let tracks = [];
    let resolvedIdentity = null;
    const vttCache = new Map();
    let selectionGeneration = 0;
    let switchQueue = Promise.resolve();

    function routeStillMatches() {
      const expected = options.identity;
      if (!expected?.bvid && !expected?.aid) return true;
      const match = /\/video\/(BV[0-9A-Za-z]+|av\d+)/i.exec(root.location.pathname);
      if (!match) return false;
      const routeId = match[1];
      if (expected.bvid && routeId.toLowerCase() !== String(expected.bvid).toLowerCase()) return false;
      if (!expected.bvid && expected.aid && Number(routeId.slice(2)) !== Number(expected.aid)) return false;
      const part = Math.max(1, Number(new URLSearchParams(root.location.search).get("p")) || 1);
      return part === Math.max(1, Number(expected.part) || 1);
    }

    function updateSelectorCurrent(value) {
      const control = art?.template?.$controlsRight?.querySelector?.(".art-control-btr-subtitle");
      control?.classList.toggle("btr-subtitle-off", value === OFF_VALUE);
      control?.setAttribute("aria-label", value === OFF_VALUE ? "开启字幕" : "关闭字幕");
      control?.setAttribute("aria-pressed", value === OFF_VALUE ? "false" : "true");
      for (const item of control?.querySelectorAll?.(".art-selector-item") || []) {
        item.classList.toggle("art-current", item.dataset.value === value);
      }
    }

    function revokeActiveUrl() {
      if (activeUrl) URL.revokeObjectURL(activeUrl);
      activeUrl = "";
    }

    function switchVtt(vtt, name, generation) {
      const task = switchQueue.catch(() => {}).then(async () => {
        if (disposed || generation !== selectionGeneration || !routeStillMatches()) return;
        const nextUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt;charset=utf-8" }));
        const previous = activeUrl;
        activeUrl = nextUrl;
        try {
          await art.subtitle.switch(nextUrl, {
            type: "vtt",
            name,
            escape: true,
            encoding: "utf-8",
            style: { color: "#fff", textShadow: "0 1px 3px rgba(0,0,0,.95)" }
          });
        } catch (error) {
          if (activeUrl === nextUrl) activeUrl = "";
          URL.revokeObjectURL(nextUrl);
          throw error;
        } finally {
          if (previous) URL.revokeObjectURL(previous);
        }
      });
      switchQueue = task;
      return task;
    }

    async function select(value, persist = true) {
      if (disposed || !routeStillMatches()) return;
      const generation = ++selectionGeneration;
      const requested = normalizeSubtitlePreference(value);
      preference = requested;
      if (requested !== OFF_VALUE) lastPreference = requested;
      updateSelectorCurrent(requested);
      if (persist) options.onPreferenceChange?.(requested, lastPreference);
      if (requested === OFF_VALUE) {
        await switchVtt(OFF_VTT, "关闭", generation);
        return;
      }
      const track = tracks.find((item) => item.lan === requested);
      if (!track) {
        await switchVtt(OFF_VTT, "关闭", generation);
        return;
      }
      let vtt = vttCache.get(track.url);
      if (!vtt) {
        vtt = await fetchSubtitleVtt(track, controller.signal);
        if (disposed || generation !== selectionGeneration || !routeStillMatches()) return;
        vttCache.set(track.url, vtt);
      }
      if (generation !== selectionGeneration) return;
      await switchVtt(vtt, track.label, generation);
    }

    async function toggle() {
      if (!tracks.length) return;
      if (preference !== OFF_VALUE) {
        await select(OFF_VALUE);
        return;
      }
      const remembered = tracks.find((item) => item.lan === lastPreference);
      await select((remembered || tracks[0]).lan);
    }

    const ready = (async () => {
      try {
        tracks = await resolveSubtitleTracks(nativeFetch, controller.signal, options.identity, options.identityPromise, (identity) => {
          resolvedIdentity = { aid: Number(identity.aid) || 0, bvid: String(identity.bvid || ""), cid: Number(identity.cid) || 0 };
        });
        if (disposed || !routeStillMatches() || !tracks.length) return [];
        const selected = tracks.find((item) => item.lan === preference) || null;
        art.controls.add({
          name: "btr-subtitle",
          position: "right",
          index: 14,
          html: CC_ICON,
          selector: [
            { html: "关闭", value: OFF_VALUE, default: !selected },
            ...tracks.map((track) => ({ html: track.label, value: track.lan, default: track === selected }))
          ],
          click(_controls, event) {
            if (event?.target?.closest?.(".art-selector-list")) return;
            toggle().catch((error) => {
              if (art?.notice) art.notice.show = `字幕切换失败：${error?.message || error}`;
            });
          },
          onSelect(item) {
            select(item.value).catch((error) => {
              if (art?.notice) art.notice.show = `字幕切换失败：${error?.message || error}`;
            });
            return CC_ICON;
          }
        });
        updateSelectorCurrent(selected?.lan || OFF_VALUE);
        if (selected) {
          await select(selected.lan, false).catch((error) => {
            if (art?.notice) art.notice.show = `字幕加载失败：${error?.message || error}`;
          });
        }
        return tracks;
      } catch (error) {
        if (error?.name !== "AbortError" && !disposed) console.warn("[Bilibili 线程撕裂者] 字幕不可用", error);
        return [];
      }
    })();

    return Object.freeze({
      destroy() {
        disposed = true;
        selectionGeneration += 1;
        controller.abort(new DOMException("字幕任务已取消", "AbortError"));
        revokeActiveUrl();
      },
      getDebug: () => ({ count: tracks.length, preference, lastPreference, enabled: preference !== OFF_VALUE, identity: resolvedIdentity, labels: tracks.map((track) => track.label) }),
      ready,
      select,
      setLastPreference(value) {
        const normalized = normalizeLastSubtitlePreference(value);
        if (normalized) lastPreference = normalized;
      },
      toggle
    });
  }

  root.__BILI_SUBTITLE_FACTORY__ = Object.freeze({
    OFF_VALUE,
    attach,
    isAiTrack,
    normalizeLastSubtitlePreference,
    normalizeCueContent,
    normalizeSubtitlePreference,
    normalizeTracks,
    resolveSubtitleTracks,
    subtitleJsonToVtt,
    subtitleLabel
  });
})(globalThis);
