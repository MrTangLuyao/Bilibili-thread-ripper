// The diagnostic report that 复制诊断信息 copies, format 1. settings-panel.js only collects a
// snapshot of what each part of BTR knows at that moment; this file turns it into plain English
// ASCII text in one fixed layout, for the `text` field of an issue. It touches no DOM, so the
// same code runs in the page and under Node (dev/diagnostic-report-test.js).
//
// The layout keeps a few rules so that a report reads at a glance and two reports diff line by
// line: one clock (T+s.mmm, seconds since the top document loaded), one fact per line, every key
// printed in the same order (n/a when its source is absent, none for an empty list, - for a
// table cell with nothing measured), fixed units (B/KiB/MiB, Mbit/s, ms or s) and no raw floats.
// BTR's own Chinese messages become English through translate(); text it does not know
// (Bilibili's own messages) is replaced, and a last pass over every line takes the query off any
// address, drops cookie and signature fields and turns whatever is still not ASCII into "?".
(function installDiagnosticReport(root) {
  "use strict";

  const FORMAT = "1";
  const LINE_LIMIT = 200;
  // GitHub takes 65 536 characters in an issue body; the rest is left for the form's own text
  // and what the viewer writes.
  const CHAR_LIMIT = 48000;
  const EVENT_LIMIT = 400;
  const NODE_LIMIT = 40;
  const LIVE_LIMIT = 4;
  const LIVE_NODE_LIMIT = 16;
  // Adjacent repeats of one event within this time are printed once, with a count.
  const FOLD_MS = 10000;

  // bridge.js DEFAULTS, the stored settings before anything is changed: Settings marks every
  // value that differs with *. dev/diagnostic-report-test.js checks that the two stay equal.
  const DEFAULTS = Object.freeze({ enabled: true, liveEnabled: false, episodeEnabled: true, blockInternational: false, bufferAheadSeconds: 45, secondaryBuffer: false, audioAcceleration: true, autoQualityMax: 0, theme: "auto", concurrency: 8, autoConcurrency: true, takeover: "full", mode: "mainland", customHosts: Object.freeze([]), floatingButton: true, floatingButtonLeft: null, floatingButtonTop: null, guideDone: false });

  // English names of Bilibili's quality ids; the player's own labels are Chinese (1080P 60帧).
  const QUALITY_LABELS = Object.freeze({ 127: "8K", 126: "Dolby Vision", 125: "HDR", 120: "4K", 116: "1080P60", 112: "1080P+", 80: "1080P", 74: "720P60", 64: "720P", 32: "480P", 16: "360P", 6: "240P" });
  const READY_STATES = ["HAVE_NOTHING", "HAVE_METADATA", "HAVE_CURRENT_DATA", "HAVE_FUTURE_DATA", "HAVE_ENOUGH_DATA"];
  const NETWORK_STATES = ["EMPTY", "IDLE", "LOADING", "NO_SOURCE"];
  const MEDIA_ERRORS = Object.freeze({ 1: "MEDIA_ERR_ABORTED", 2: "MEDIA_ERR_NETWORK", 3: "MEDIA_ERR_DECODE", 4: "MEDIA_ERR_SRC_NOT_SUPPORTED" });

  // ---- translation ----

  // Every message BTR itself writes in Chinese: what its errors are thrown with (the cancel
  // reasons among them), what 自动线程数 gives as its reason, and the few Chinese words older
  // builds left in their English records. The patterns also match inside a longer text, as in
  // "range failed: video <host> after 0 KiB: 并发副本已取消", and keep the numbers and hosts
  // around them. A message that wraps another comes first, and each message before the shorter
  // ones it ends with (并发副本已取消 before 已取消, 媒体 Range 校验失败 before Range 校验失败).
  const DICTIONARY = [
    [/原生播放器接口发生变化，?已停止加速：?\s*/g, "native player API changed, acceleration stopped: "],
    // Downloads: idm-downloader.js and range-core.js.
    [/并发副本已取消/g, "hedge lost"],
    [/播放器任务已取消/g, "player task cancelled"],
    [/播放任务已取消/g, "session cancelled"],
    [/播放清单请求已取消/g, "playlist request cancelled"],
    [/已经跳到新的位置/g, "seeked elsewhere"],
    [/播放内核发生错误/g, "player core failed"],
    [/B ?站原生播放器正在切换媒体源/g, "Bilibili's player is switching sources"],
    [/CDN ?首字节超时/g, "CDN first byte timed out"],
    [/CDN ?子块停止传输/g, "CDN piece stalled"],
    [/CDN ?子块总耗时超限/g, "CDN piece took too long"],
    [/媒体 ?Range ?校验失败/g, "media range check failed"],
    [/媒体 ?Range ?长度不符/g, "media range length mismatch"],
    [/Range ?校验失败：?\s*/g, "range check failed: "],
    [/子块长度不符：?\s*/g, "piece length mismatch: "],
    [/子区间超出目标长度/g, "sub-range past the target length"],
    [/子区间长度不符：?\s*/g, "sub-range length mismatch: "],
    [/没有可用 ?CDN/g, "no usable CDN"],
    [/不同 ?CDN ?返回的文件总长度不一致/g, "CDNs disagree on the file size"],
    // The full takeover: native-mse-player.js.
    [/页面没有 ?DASH ?播放清单/g, "page has no DASH playlist"],
    [/新视频没有 ?DASH ?播放清单/g, "new video has no DASH playlist"],
    [/这一集没有 ?DASH ?播放清单/g, "episode has no DASH playlist"],
    [/浏览器不支持清单中的视频或音频编码/g, "browser supports none of the playlist's codecs"],
    [/播放清单缺少初始化或 ?SIDX ?字节范围/g, "playlist lacks init or SIDX ranges"],
    [/空的缓冲区间/g, "empty buffered range"],
    [/没有找到 ?B ?站原生 ?video ?元素/g, "Bilibili's video element not found"],
    [/(?:(视频|音频)\s*)?SIDX ?解析失败/g, (_match, kind) => `${kind === "视频" ? "video " : kind === "音频" ? "audio " : ""}SIDX parse failed`],
    // waitEvent: `${successName} 失败`, the name of the event that never came.
    [/([\w-]+) 失败/g, "$1 failed"],
    // The compatibility mode: native-range-transport.js.
    [/原生播放器接口不兼容/g, "native player API incompatible"],
    [/原生缓冲接口不兼容/g, "native buffer API incompatible"],
    [/原生调度接口不兼容/g, "native scheduler API incompatible"],
    [/原生内核未恢复/g, "native core not restored"],
    [/加速任务已停止/g, "transport stopped"],
    [/其他服务器没有这个文件/g, "the other servers do not have this file"],
    // The page: page-hook.js.
    [/视频已经换了/g, "video changed"],
    [/B ?站 ?15 ?秒内没有回应/g, "Bilibili did not answer within 15 s"],
    [/读取视频信息失败/g, "video info request failed"],
    [/新视频缺少 ?CID/g, "new video has no CID"],
    [/读取播放清单失败/g, "playlist request failed"],
    [/未知接管错误/g, "unknown takeover error"],
    [/\s*[（(]兼容模式[)）]/g, " (compat)"],
    [/兼容模式/g, "compat"],
    [/全接管/g, "full"],
    // Live: live-hook.js.
    [/直播已切换或加速已关闭/g, "live stream changed or acceleration off"],
    [/直播节点探测超时/g, "live node probe timed out"],
    [/直播分片响应异常：?\s*/g, "live segment failed: "],
    [/直播分片只返回了一部分/g, "live segment came back partial"],
    [/直播分片首字节超时/g, "live segment first byte timed out"],
    [/直播分片为空/g, "live segment empty"],
    [/直播分片长度不对：?\s*收到\s*([^，,]*?)\s*[，,]\s*应为\s*/g, "live segment length wrong: got $1, expected "],
    [/没有可用直播节点/g, "no usable live node"],
    [/直播分片总超时/g, "live segment timed out"],
    [/直播/g, "live"],
    // 自动线程数: idm-downloader.js, and the stalls native-mse-player.js reports to it.
    [/开头已经跟上，?\s*线程数降到\s*(\d+)/g, "start caught up, down to $1"],
    [/开头先用\s*(\d+)\s*线程/g, "start with $1 threads"],
    [/(\d+)\s*线程没有比\s*(\d+)\s*线程更快/g, "$1 threads were not faster than $2"],
    [/服务器返回\s*(\d+)/g, "server returned HTTP $1"],
    [/播放卡了一下/g, "playback stalled"],
    [/前方缓冲快用完了/g, "buffer nearly empty"],
    [/缓冲跟不上播放/g, "buffer not keeping up"],
    [/连接排队等太久/g, "connections queued too long"],
    [/起步/g, "initial"],
    // The player's quality labels, which older builds wrote into their timelines.
    [/杜比视界/g, "Dolby Vision"],
    [/(\d+P) ?(\d+)帧/g, "$1$2"],
    [/(\d+P) ?高码率/g, "$1+"],
    [/(\d+)帧/g, "$1 fps"],
    [/清晰度 ?/g, "qn "],
    [/已取消/g, "cancelled"]
  ];
  const PUNCTUATION = [
    [/：/g, ": "], [/[，、]/g, ", "], [/；/g, "; "], [/。/g, ". "], [/（/g, " ("], [/）/g, ")"],
    [/！/g, "! "], [/？/g, "? "], [/[“”「」『』]/g, "\""], [/[‘’]/g, "'"], [/[—–―]/g, "-"],
    [/…/g, "..."], [/→/g, "->"], [/←/g, "<-"], [/×/g, "x"], [/[·•‧∙⋅]/g, ", "], [/[\u00a0\u3000]/g, " "]
  ];
  const CJK_RUN = /[\u2e80-\u2fff\u3000-\u303f\u3040-\u31ff\u3200-\u9fff\ua000-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]+/g;
  const UNKNOWN = "[non-English text]";

  // Any text BTR may print, as English ASCII. ASCII comes back as it was; anything Chinese the
  // dictionary does not know, such as Bilibili's own API messages, becomes [non-English text],
  // and the numbers and codes around it stay.
  function translate(value) {
    let out = typeof value === "string" ? value
      : typeof value === "number" || typeof value === "boolean" ? String(value)
        : value && typeof value === "object" && typeof value.message === "string" ? value.message : "";
    if (!/[^\x00-\x7f]/.test(out)) return out;
    for (const [pattern, english] of DICTIONARY) out = out.replace(pattern, english);
    for (const [pattern, ascii] of PUNCTUATION) out = out.replace(pattern, ascii);
    try { out = out.normalize("NFKC"); } catch (_error) {}
    // One marker per stretch of unknown text, so "请求错误 请稍后再试" is one placeholder.
    out = out.replace(CJK_RUN, "\ue000").replace(/\ue000(?:[\s,.;:!?'"-]*\ue000)*/g, UNKNOWN);
    return out.replace(/[^\x00-\x7f]/g, "?").replace(/ {2,}/g, " ").replace(/ +([,.;:)])/g, "$1").trim();
  }

  // ---- reading the snapshot ----

  // The snapshot comes from several sources that may be missing, older, or broken; each value
  // is read as the type it should have, or as nothing.
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  const list = (value) => Array.isArray(value) ? value : [];
  const num = (value) => {
    const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    return Number.isFinite(number) ? number : null;
  };
  const bool = (value) => typeof value === "boolean" ? value : null;
  const text = (value) => typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";

  // ---- units ----

  const yesNo = (value) => value === true ? "yes" : value === false ? "no" : "n/a";
  const count = (value) => { const n = num(value); return n === null ? "n/a" : String(Math.round(n)); };
  const plural = (value, one, many = `${one}s`) => { const n = num(value); return n === null ? `n/a ${many}` : `${Math.round(n)} ${Math.round(n) === 1 ? one : many}`; };
  const fixed = (value, digits) => { const n = num(value); return n === null ? "n/a" : (Math.abs(n) < 0.5 / 10 ** digits ? 0 : n).toFixed(digits); };
  // Media positions: 3 decimals in sections, 1 in the event list.
  const position = (value) => fixed(value, 3);
  const secondsAmount = (value) => num(value) === null ? "n/a" : `${fixed(value, 1)} s`;
  function size(value) {
    const bytes = num(value);
    if (bytes === null || bytes < 0) return "n/a";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const kib = bytes / 1024;
    if (kib < 10) return `${kib.toFixed(1)} KiB`;
    if (Math.round(kib) < 1024) return `${Math.round(kib)} KiB`;
    return `${(bytes / 1048576).toFixed(2)} MiB`;
  }
  // DASH bandwidth is bits per second already; the downloader's speeds are bytes per second
  // and are multiplied by 8 where they are read.
  const mbit = (bitsPerSecond) => num(bitsPerSecond) === null ? "n/a" : `${(num(bitsPerSecond) / 1e6).toFixed(2)} Mbit/s`;
  function duration(value) {
    const ms = num(value);
    if (ms === null) return "n/a";
    if (Math.abs(ms) < 10000) return `${Math.round(ms)} ms`;
    if (Math.abs(ms) < 600000) return `${(ms / 1000).toFixed(1)} s`;
    return `${(ms / 60000).toFixed(1)} min`;
  }
  const fps = (value) => Math.abs(value - Math.round(value)) < 0.01 ? String(Math.round(value)) : value.toFixed(2);
  function qn(value) {
    const id = Math.round(num(value) || 0);
    return QUALITY_LABELS[id] ? `qn ${id} (${QUALITY_LABELS[id]})` : `qn ${id}`;
  }
  function iso(ms, seconds = false) {
    const at = num(ms);
    if (at === null || Math.abs(at) > 8.64e15) return "n/a";
    const out = new Date(at).toISOString();
    return seconds ? out.replace(/\.\d{3}Z$/, "Z") : out;
  }
  // T+s.mmm on the top document's clock; the T column of the events holds the bare number.
  const seconds = (ms) => (Math.abs(ms) < 0.5 ? 0 : ms / 1000).toFixed(3);
  const stamp = (ms) => ms === null || ms === undefined ? "n/a" : `T${ms < 0 ? "-" : "+"}${seconds(Math.abs(ms))}`;

  // A short token from the data, such as a state, a mode or a codec.
  const word = (value, fallback = "n/a") => translate(text(value)).replace(/[^\w .:/+,()#-]/g, "").trim().slice(0, 60) || fallback;
  // Free text from the data, on one line, cut with "..." when it is too long for its place.
  function sentence(value, limit = 160) {
    const out = translate(value).replace(/\s+/g, " ").trim();
    return out.length > limit ? `${out.slice(0, limit - 3).trimEnd()}...` : out;
  }
  // A CDN host name, and nothing that could follow it in an address.
  const hostName = (value) => text(value).toLowerCase().replace(/^[a-z][\w+.-]*:\/\//, "").split(/[/?#\s]/)[0].replace(/[^a-z0-9.:[\]-]/g, "").slice(0, 64);
  // Numbers somebody printed with all their digits; not the ones inside a codec or a version
  // (avc1.640033). No lookbehind: the userscript bundle has to parse in older Safari too.
  const tidyNumbers = (value) => value.replace(/(^|[^\w.])(-?\d+\.\d{4,})(?![\w.])/g, (_match, before, number) => `${before}${Number(number).toFixed(3)}`);

  // An event's detail, which is mostly a string but may be a number, a flag or a small record.
  function detailText(value, depth = 0) {
    if (value === null || value === undefined || value === "") return "";
    if (typeof value === "number") return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "";
    if (typeof value === "boolean") return value ? "yes" : "no";
    if (depth > 1) return "";
    if (Array.isArray(value)) return value.slice(0, 8).map((item) => detailText(item, depth + 1)).filter(Boolean).join(", ");
    if (typeof value === "object") {
      if ("code" in value || "message" in value) return mediaError(value);
      return Object.entries(value).slice(0, 8).map(([key, item]) => `${word(key, "")} ${detailText(item, depth + 1)}`.trim()).filter(Boolean).join(", ");
    }
    return tidyNumbers(sentence(value, 200));
  }
  function mediaError(error) {
    const code = Math.round(num(error?.code) || 0);
    const message = sentence(error?.message);
    return `${code}${MEDIA_ERRORS[code] ? ` ${MEDIA_ERRORS[code]}` : ""}${message ? `: ${message}` : ""}`;
  }
  const codecsOf = (type) => (/codecs\s*=\s*"?([^";]+)"?/i.exec(text(type)) || [])[1]?.replace(/[^\w.,+-]/g, "").slice(0, 40) || "";
  const rangesOf = (value) => Array.isArray(value)
    ? value.slice(0, 8).map((range) => list(range).map(num)).filter(([start, end]) => start !== null && end !== null && end >= start)
    : null;

  // ---- the privacy pass ----

  // Signed media addresses carry their signature and expiry in the query, and a cookie string
  // that ended up in some message would carry the session. Every line goes through this, the
  // fixed text included, so nothing depends on each source having cleaned its own text.
  const URL_QUERY = /((?:https?:)?\/\/[^\s"'<>?#]+|\b[a-z0-9.-]+\.[a-z]{2,}\/[^\s"'<>?#]*)[?#][^\s"'<>]*/gi;
  const COOKIE_STRING = /(?:[\w.-]+=[^;\s]*;\s*){2,}[\w.-]+=[^;\s]*/g;
  const SECRET_NAMES = /\b(?:SESSDATA|bili_jct|DedeUserID(?:__ckMd5)?|buvid[\w-]*|upsig|uparams)\b(?:\s*[=:]\s*[^\s;&,"']*)?/gi;
  const SECRET_FIELDS = /\b(?:deadline|access_key|auth_key|csrf|token|sign|w_rid|wts|mid|uid)=[^\s;&,"']*/gi;
  const scrub = (line) => line.replace(URL_QUERY, "$1").replace(COOKIE_STRING, "[cookies removed]").replace(SECRET_NAMES, "[removed]").replace(SECRET_FIELDS, "[removed]");

  // One finished line: on one line, private fields out, ASCII, no trailing space, cut to fit.
  function clean(line) {
    let out = scrub(String(line ?? "").replace(/\r\n?|\n|\t/g, " ")).replace(/[^\x20-\x7e]/g, "?").trimEnd();
    if (out.length > LINE_LIMIT) out = `${out.slice(0, LINE_LIMIT - 3).trimEnd()}...`;
    return out;
  }

  // ---- layout ----

  // Key/value lines, the keys padded to the section's longest key + 2.
  function pairs(rows) {
    const width = Math.max(0, ...rows.map(([key]) => key.length)) + 2;
    return rows.map(([key, value]) => `${key.padEnd(width)}${value === "" || value === null || value === undefined ? "n/a" : value}`);
  }
  // A table: text columns left-aligned, numbers right-aligned, two spaces between columns.
  function table(header, rows, align) {
    const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)));
    const line = (cells) => cells.map((cell, index) => align[index] === "r" ? cell.padStart(widths[index]) : cell.padEnd(widths[index])).join("  ").trimEnd();
    return [line(header), ...rows.map(line)];
  }
  const heading = (block) => `== ${block.title} ==${block.note ? `  ${block.note}` : ""}`;

  // ---- the facts every section shares ----

  function facts(snapshot) {
    const capturedAt = num(snapshot.capturedAt), now = num(snapshot.now), origin = num(snapshot.timeOrigin);
    const video = object(snapshot.video);
    // page-hook.js runs in the top document, but its report says where its own clock starts.
    const ownOrigin = num(video?.timeOrigin);
    const videoDelta = ownOrigin !== null && origin !== null && Math.abs(ownOrigin - origin) < 864e5 ? ownOrigin - origin : 0;
    const clock = {
      capturedAt, now, origin,
      // performance.now() of a realm whose clock starts `delta` ms after the top document's.
      perf: (ms, delta = 0) => num(ms) === null ? null : num(ms) + (num(delta) || 0),
      // Date.now(), counted back from the capture: a clock change since the page loaded (a
      // sleep, a time sync) then does not move it.
      epoch: (ms) => {
        const at = num(ms);
        if (at === null || at <= 0) return null;
        if (capturedAt !== null && now !== null) return at - capturedAt + now;
        return origin !== null ? at - origin : null;
      }
    };
    return {
      snapshot, clock, video, videoDelta,
      player: object(video?.player),
      playback: object(video?.playback),
      downloads: object(video?.downloads),
      // A page without a video (home, search) has no engine to speak of; reports from before
      // videoPage existed count as video pages.
      engine: video?.videoPage !== false && ["full", "compat", "native"].includes(video?.actualTakeover) ? video.actualTakeover : null,
      settings: object(snapshot.settings),
      stats: object(snapshot.stats),
      auto: object(snapshot.autoThreads),
      site: object(snapshot.site),
      btr: object(snapshot.btr),
      env: object(snapshot.env),
      live: list(snapshot.live).slice(0, LIVE_LIMIT).map((module, index) => ({ ...(object(module) || {}), index }))
    };
  }

  // One row per CDN host: the node list of the player (video and audio already merged by host,
  // page-hook.js) together with the hosts the downloads went to, which can include hosts only
  // the start used or that a previous player listed.
  const STATE_ORDER = ["banned", "blocked", "healthy", "untested", "unlisted"];
  function nodeRows(c) {
    if (c.nodeRows !== undefined) return c.nodeRows;
    if (!c.video || !(Array.isArray(c.video.nodes) || Array.isArray(c.video.bannedNodes) || object(c.downloads?.hosts))) return (c.nodeRows = null);
    const byHost = new Map();
    for (const raw of list(c.video.nodes)) {
      const node = object(raw), host = hostName(node?.host);
      if (!host) continue;
      const state = STATE_ORDER.includes(node.state) ? node.state : word(node.state, "unknown").toLowerCase().replace(/\s+/g, "-");
      const known = byHost.get(host);
      if (!known || rank(state) < rank(known.state)) byHost.set(host, { host, state, bps: num(node.bps), traffic: null });
    }
    for (const raw of list(c.video.bannedNodes)) {
      const host = hostName(raw);
      if (host && !byHost.has(host)) byHost.set(host, { host, state: "banned", bps: null, traffic: null });
    }
    for (const [raw, traffic] of Object.entries(object(c.downloads?.hosts) || {})) {
      const host = hostName(raw);
      if (!host) continue;
      const row = byHost.get(host) || { host, state: "unlisted", bps: null, traffic: null };
      row.traffic = object(traffic) || {};
      byHost.set(host, row);
    }
    return (c.nodeRows = [...byHost.values()].sort((a, b) => rank(a.state) - rank(b.state)
      || (a.state === "healthy" ? (b.bps || 0) - (a.bps || 0) : 0) || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0)));
  }
  const rank = (state) => { const index = STATE_ORDER.indexOf(state); return index < 0 ? STATE_ORDER.length : index; };

  function nodeCounts(rows) {
    if (!rows) return "n/a";
    if (!rows.length) return "none";
    const counts = new Map();
    for (const row of rows) counts.set(row.state, (counts.get(row.state) || 0) + 1);
    const order = ["healthy", "untested", "blocked", "banned", "unlisted"];
    return [...counts].sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)).map(([state, n]) => `${n} ${state}`).join(", ");
  }

  // Requests per kind since the page loaded, and their sum.
  function kindTotals(downloads) {
    const byKind = object(downloads?.byKind);
    if (!byKind) return null;
    const totals = { started: 0, ok: 0, failed: 0, cancelled: 0, bytes: 0 };
    for (const kind of Object.values(byKind)) for (const key of Object.keys(totals)) totals[key] += num(object(kind)?.[key]) || 0;
    return totals;
  }
  function failedHosts(c) {
    return Object.values(object(c.downloads?.hosts) || {}).filter((host) => (num(object(host)?.failed) || 0) > 0).length;
  }

  const sessionEvents = (c) => list(c.video?.page).map(object).filter((event) => event?.what === "Bilibili replaced the video source");

  // ---- sections ----

  function header(c) {
    const btr = c.btr;
    return [
      `BTR diagnostics (format ${FORMAT}) | BTR ${btr ? `${word(btr.version)} ${word(btr.channel)}` : "n/a"} | captured ${iso(c.clock.capturedAt)}`,
      `Clock: T = seconds since page load at ${iso(c.clock.origin)}; captured at ${c.clock.now === null ? "n/a" : stamp(c.clock.now)}`
    ];
  }

  function summary(c) {
    const { video, player, playback, settings } = c;
    const setting = word(settings?.takeover ?? object(video?.settings)?.takeover);
    const frame = object(playback?.lastPresentedFrame), frames = object(playback?.frames);
    const picture = playback && `${frame ? `last frame at ${stamp(c.clock.perf(frame.observedAtMs, c.videoDelta))} (media ${position(frame.mediaTime)} s)` : "last frame n/a"}, ${count(frames?.total)} total, ${count(frames?.dropped)} dropped`;
    const playing = c.engine === "full" ? num(player?.qualityId) : c.engine === "compat" ? num(player?.downloadedQualityId) || num(player?.qualityId) : null;
    const quality = video && `playing ${playing > 0 ? qn(playing) : "n/a"}, menu ${menuQuality(object(video.nativeQuality))}`;
    const totals = kindTotals(c.downloads), active = num(c.downloads?.active);
    const requests = totals && `${Math.round(totals.started)}: ${Math.round(totals.ok)} ok, ${Math.round(totals.failed)} failed, ${Math.round(totals.cancelled)} cancelled${active > 0 ? `, ${Math.round(active)} active` : ""}`;
    return pairs([
      ["state", video ? word(video.state) : "n/a"],
      ["engine", `${c.engine || "n/a"} (setting ${setting})`],
      ["position", playback ? `${position(playback.currentTime)} / ${position(playback.duration)} s` : "n/a"],
      ["paused", playback ? `page ${yesNo(bool(playback.paused))}, element ${yesNo(elementPaused(c))}` : "n/a"],
      ["picture", picture],
      ["quality", quality],
      ["video", track(c, "video")],
      ["audio", track(c, "audio")],
      ["buffer ahead", bufferAhead(c)],
      ["threads", threads(c)],
      ["requests", requests],
      ["nodes", nodeCounts(nodeRows(c))],
      ["last error", video ? (text(video.lastError) ? sentence(video.lastError) : "none") : "n/a"]
    ]);
  }
  // BTR's player patches video.paused (what the page sees); the element's own state is read
  // through HTMLMediaElement.prototype, and the two disagreeing is a finding of its own (#65).
  const elementPaused = (c) => bool(c.playback?.elementPaused) ?? bool(c.player?.elementPaused);
  function menuQuality(menu) {
    if (!menu) return "n/a";
    if (num(menu.newQ) > 0) return qn(menu.newQ);
    return `auto (shows ${num(menu.realQ) > 0 ? `qn ${Math.round(menu.realQ)}` : "n/a"})`;
  }
  function track(c, kind) {
    const player = c.player;
    if (!player || !Object.keys(player).length) return "n/a";
    const video = kind === "video";
    const parts = [codecsOf(video ? player.videoType : player.audioType) || (video ? word(player.codec, "") : "")];
    if (video && num(player.width) > 0 && num(player.height) > 0) parts.push(`${Math.round(player.width)}x${Math.round(player.height)}`);
    if (video && num(player.frameRate) > 0) parts.push(`${fps(num(player.frameRate))} fps`);
    const bandwidth = num(video ? player.videoBandwidth : player.audioBandwidth);
    if (bandwidth > 0) parts.push(mbit(bandwidth));
    return parts.filter(Boolean).join(" ") || "n/a";
  }
  // From the element's buffered ranges at the capture; the player's last published value only
  // when an older build sent no ranges.
  function bufferAhead(c) {
    const ranges = rangesOf(c.playback?.buffered), time = num(c.playback?.currentTime);
    if (ranges && time !== null) {
      const around = ranges.find(([start, end]) => start <= time + 0.1 && time <= end);
      return `${fixed(around ? Math.max(0, around[1] - time) : 0, 1)} s`;
    }
    return c.video ? secondsAmount(c.stats?.bufferedAhead) : "n/a";
  }
  function threads(c) {
    const settings = c.settings;
    if (!settings) return "n/a";
    if (settings.autoConcurrency === true) {
      const current = num(c.auto?.threads) || num(c.stats?.autoThreads);
      return `${current ? Math.round(current) : "n/a"} (auto)`;
    }
    return settings.autoConcurrency === false ? `${count(settings.concurrency)} (manual)` : "n/a";
  }

  // Findings that restate facts from the sections below, most severe first. No guesses: each
  // rule names one condition on the data. The id column fits the longest id in the catalog, so
  // it lines up the same whichever checks fire.
  const CHECK_IDS = ["takeover-failed", "player-error", "media-error", "node-banned", "address-banned", "range-failures", "quality-mismatch", "settings-not-loaded", "other-build", "site-international", "site-gave-up", "live-error", "redirects-blocked", "source-replaced", "engine-differs", "tab-hidden"];
  const CHECK_WIDTH = Math.max(...CHECK_IDS.map((id) => id.length)) + 2;
  function checks(c) {
    const found = [];
    const add = (level, id, message) => found.push({ level, id, message });
    const { video, playback, settings, site, btr } = c;
    const takeoverError = object(c.stats?.takeoverError) || object(video?.takeoverError);
    if (takeoverError) {
      const at = c.clock.epoch(takeoverError.at);
      add("ERROR", "takeover-failed", `${word(takeoverError.stage, "unknown")}: ${sentence(takeoverError.message) || "no message"} (attempt ${count(takeoverError.retryCount)}${at === null ? "" : `, at ${stamp(at)}`})`);
    }
    if (video?.state === "error" && !(takeoverError && text(takeoverError.message) === text(video.lastError))) add("ERROR", "player-error", `state error: ${sentence(video.lastError) || "no message"}`);
    const mediaFailure = object(playback?.mediaError);
    if (mediaFailure) add("ERROR", "media-error", mediaError(mediaFailure));
    const bans = list(video?.bans).map(object).filter(Boolean);
    for (const ban of bans.filter((item) => item.kind !== "address")) {
      add("WARN", "node-banned", `${hostName(ban.host) || "n/a"}: ${plural(ban.count, "failure")} with no data${text(ban.error) ? ` (${sentence(ban.error, 80)})` : ""}`);
    }
    if (!Array.isArray(video?.bans)) for (const host of list(video?.bannedNodes).map(hostName).filter(Boolean)) add("WARN", "node-banned", `${host}: banned for this video`);
    for (const ban of bans.filter((item) => item.kind === "address")) {
      add("WARN", "address-banned", `a download address refused by the nodes, ${plural(ban.count, "failure")}, last on ${hostName(ban.host) || "n/a"}${text(ban.error) ? ` (${sentence(ban.error, 80)})` : ""}`);
    }
    const totals = kindTotals(c.downloads);
    if (totals?.failed > 0) {
      const hosts = failedHosts(c);
      add("WARN", "range-failures", `${plural(totals.failed, "failed request")}${hosts ? ` on ${plural(hosts, "node")}` : ""}`);
    }
    const menu = object(video?.nativeQuality), wanted = num(menu?.newQ), offered = list(c.player?.qualities ?? video?.qualities).map(num);
    if (c.engine === "full" && wanted > 0 && offered.includes(wanted) && num(c.player?.qualityId) !== wanted) {
      add("WARN", "quality-mismatch", `menu ${qn(wanted)}, playing ${num(c.player?.qualityId) > 0 ? qn(c.player.qualityId) : "n/a"}`);
    }
    if (!settings) add("WARN", "settings-not-loaded", "the stored settings had not reached the page at capture");
    if (text(btr?.otherBuild)) add("WARN", "other-build", `the ${word(btr.otherBuild)} build is enabled too and is not running on this page`);
    if (site?.international === true && settings?.blockInternational === true) add("WARN", "site-international", "international page while block international is on");
    if (site?.gaveUp === true) add("WARN", "site-gave-up", "BTR stopped sending this tab back to the domestic site");
    for (const module of c.live) {
      const error = text(object(module.stats)?.lastError);
      if (error) add("WARN", "live-error", `${liveName(module)}: ${sentence(error)}`);
    }
    if (num(site?.redirectsBlocked) > 0) add("INFO", "redirects-blocked", `${plural(site.redirectsBlocked, "redirect")} to the international site blocked`);
    const replaced = sessionEvents(c);
    if (replaced.length) {
      const times = replaced.reduce((sum, event) => sum + Math.max(1, Math.round(num(event.count) || 1)), 0);
      const last = c.clock.perf(replaced.at(-1).at, c.videoDelta);
      add("INFO", "source-replaced", `Bilibili replaced the video source ${plural(times, "time")}${last === null ? "" : ` (last at ${stamp(last)})`}`);
    }
    const setting = settings?.takeover ?? object(video?.settings)?.takeover;
    if (c.engine && settings?.enabled !== false && ["full", "compat"].includes(setting) && c.engine !== setting) add("INFO", "engine-differs", `setting ${setting}, running ${c.engine}`);
    if (playback?.visibility === "hidden") add("INFO", "tab-hidden", "the tab was hidden at capture");
    const order = ["ERROR", "WARN", "INFO"];
    found.sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level) || CHECK_IDS.indexOf(a.id) - CHECK_IDS.indexOf(b.id));
    return found.length ? found.map((item) => `${item.level.padEnd(6)}${item.id.padEnd(CHECK_WIDTH)}${item.message}`) : ["none"];
  }

  const PAGE_ID = /^(https?:\/\/(?:space\.bilibili\.com\/(?:[a-z-]+\/)?|m\.bilibili\.com\/space\/|(?:www\.|m\.)?bilibili\.com\/(?:[a-z-]+\/)?(?:list\/(?:ml)?|medialist\/(?:play|detail)\/(?:ml)?)))\d+/i;
  function environment(c) {
    const { btr, env } = c;
    const other = word(btr?.otherBuild, "");
    const manager = sentence(btr?.scriptManager, 80);
    // One line each, so a long first one cannot cut off the rest.
    const errors = Array.isArray(c.snapshot.readErrors) ? c.snapshot.readErrors.map((item) => sentence(item, 160)).filter(Boolean) : null;
    const errorRows = errors === null ? [["read errors", "n/a"]] : errors.length ? errors.map((item) => ["read error", item]) : [["read errors", "none"]];
    const viewport = text(env?.viewport);
    return pairs([
      ["btr", btr ? `${word(btr.version)} ${word(btr.channel)} (${word(btr.host)})` : "n/a"],
      ["other build", btr ? other ? `${other} (enabled, not running)` : "none" : "n/a"],
      ["manager", btr ? manager || (btr.host === "desktop" ? "none" : "n/a") : "n/a"],
      ["browser", sentence(env?.userAgent, 400) || "n/a"],
      ["language", word(env?.language)],
      ["viewport", /^\d{1,5}x\d{1,5}$/.test(viewport) ? viewport : "n/a"],
      // Origin and path only. A space page's path is someone's account number, and a
      // favourites list's is the number of someone's folder: both are left out.
      ["page", sentence(env?.page, 400).replace(PAGE_ID, "$1{id}") || "n/a"],
      ["route", word(c.video?.route)],
      ...errorRows
    ]);
  }

  // Which site Bilibili shows and why (#68). Cookies only as what they mean, never their value
  // (lang is a language code); signed in is only yes or no.
  function site(c) {
    const s = c.site;
    const userSite = !s ? "n/a" : s.userSite === "CN" || s.userSite === "OVERSEAS" ? s.userSite : text(s.userSite) ? "other" : "none";
    const accounts = Array.isArray(s?.accountSites) && s.accountSites.length ? s.accountSites : null;
    const account = !accounts ? "n/a" : accounts.includes("CN") ? "domestic allowed" : accounts.every((item) => item === "OVERSEAS") ? "international only" : "other";
    const lang = !s ? "n/a" : !text(s.lang) ? "none" : /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/.test(s.lang) ? s.lang : "other";
    return pairs([
      ["site", typeof s?.international === "boolean" ? s.international ? "international" : "domestic" : "n/a"],
      ["signed in", yesNo(bool(s?.signedIn))],
      ["user_site", userSite],
      ["account", account],
      ["lang cookie", lang],
      ["guard", ["on", "off", "unsupported"].includes(s?.guard) ? s.guard : "n/a"],
      ["blocked", s && num(s.redirectsBlocked) !== null ? plural(s.redirectsBlocked, "redirect") : "n/a"],
      ["gave up", yesNo(bool(s?.gaveUp))]
    ]);
  }

  // Only settings that matter for a report. The theme, the floating button, the guide and the
  // fixed download constants (implied by the version) are left out on purpose.
  function settingsSection(c) {
    const s = c.settings;
    // A value the snapshot does not have is unknown, not changed.
    const same = (key) => s[key] === undefined || JSON.stringify(s[key]) === JSON.stringify(DEFAULTS[key]);
    const mark = (value, ...keys) => `${value}${s && !keys.every(same) ? " *" : ""}`;
    const flag = (key) => s ? mark(yesNo(bool(s[key])), key) : "n/a";
    const hosts = s && (Array.isArray(s.customHosts) ? s.customHosts.map(hostName).filter(Boolean) : []);
    return pairs([
      ["enabled", flag("enabled")],
      ["takeover", s ? mark(word(s.takeover), "takeover") : "n/a"],
      ["cdn", s ? mark(word(s.mode), "mode") : "n/a"],
      ["custom hosts", s ? mark(hosts.length ? hosts.join(", ") : "none", "customHosts") : "n/a"],
      ["threads", !s ? "n/a" : s.autoConcurrency === true ? mark("auto", "autoConcurrency") : s.autoConcurrency === false ? mark(count(s.concurrency), "autoConcurrency", "concurrency") : "n/a"],
      ["buffer ahead", s ? mark(num(s.bufferAheadSeconds) === null ? "n/a" : `${count(s.bufferAheadSeconds)} s`, "bufferAheadSeconds") : "n/a"],
      ["secondary buffer", flag("secondaryBuffer")],
      ["audio acceleration", flag("audioAcceleration")],
      ["auto quality limit", !s || num(s.autoQualityMax) === null ? "n/a" : mark(s.autoQualityMax ? QUALITY_LABELS[s.autoQualityMax] || count(s.autoQualityMax) : "none", "autoQualityMax")],
      ["episodes", flag("episodeEnabled")],
      ["live", flag("liveEnabled")],
      ["block international", flag("blockInternational")]
    ]);
  }

  // Bilibili's quality menu as its player reports it (getQuality): the same words in every mode.
  const menuState = (value) => { const menu = object(value); return `menu ${menu ? `now ${count(menu.nowQ)} new ${count(menu.newQ)} real ${count(menu.realQ)}` : "n/a"}`; };

  function elementRows(c) {
    const playback = c.playback;
    const state = (value, names) => { const n = num(value); return n === null ? "n/a" : `${Math.round(n)}${names[Math.round(n)] ? ` ${names[Math.round(n)]}` : ""}`; };
    const ranges = rangesOf(playback?.buffered);
    return [
      ["ready state", state(playback?.readyState, READY_STATES)],
      ["network state", state(playback?.networkState, NETWORK_STATES)],
      ["buffered", !ranges ? "n/a" : ranges.length ? ranges.map(([start, end]) => `${fixed(start, 1)}-${fixed(end, 1)}`).join(", ") : "none"]
    ];
  }

  // The full takeover in detail; for the compatibility mode the transport's own counters; for
  // Bilibili's own playback only the element.
  function playback(c) {
    const { video, player, settings } = c;
    if (!video) return ["n/a"];
    const p = player || {};
    if (c.engine === "compat") {
      const downloaded = num(p.downloadedQualityId);
      return pairs([
        ["transport", `revision ${count(p.transportRevision)}, quality guard ${yesNo(bool(p.nativeQualityGuard))} (revision ${count(p.qualityGuardRevision)})`],
        ["ranges", `${count(p.acceleratedRanges)} served, ${count(p.failedRanges)} failed, ${count(p.activeRequests)} active`],
        ["switch requests", count(p.nativeSwitchRequests)],
        ["switch pending", yesNo(bool(p.nativeSwitchPending))],
        ["quality pick", `downloaded ${downloaded > 0 ? qn(downloaded) : "n/a"}, ${menuState(video.nativeQuality)}, core now/target/rendered ${word(p.nativeQuality)}`],
        ...elementRows(c)
      ]);
    }
    if (c.engine !== "full") return pairs(elementRows(c));
    const session = list(video.timeline).map(object).filter((event) => event?.what === "session").at(-1);
    const sessionAt = session ? c.clock.perf(session.at, c.videoDelta) : null;
    const tracks = list(p.tracks).map(object).filter(Boolean);
    const segments = ["video", "audio"].map((kind) => tracks.find((item) => item.kind === kind)).filter(Boolean)
      .map((item) => `${item.kind} ${count(item.nextIndex)}/${count(item.segments)}`).join(", ");
    const menu = object(video.nativeQuality);
    const preferred = num(p.preferredQuality), auto = num(p.autoQuality);
    const qualities = p.qualities ?? video.qualities;
    const deadline = num(p.urlDeadline);
    const left = deadline > 0 && c.clock.capturedAt !== null ? deadline * 1000 - c.clock.capturedAt : null;
    const core = object(video.nativeCore), reserve = object(p.reserve);
    const lastSeek = num(p.lastSeekMs);
    return pairs([
      ["session", `started at ${position(p.sessionStartTime)} s${sessionAt === null ? "" : ` (${stamp(sessionAt)})`}`],
      ["media source", word(p.mediaSourceState)],
      ["activated", yesNo(bool(p.playbackActivated))],
      ["play wanted", yesNo(bool(p.resumeWanted))],
      ...elementRows(c),
      ["startup buffer", secondsAmount(p.startupBufferSeconds)],
      ["rebuffers", count(p.underflowRebuffers)],
      ["seek reloads", count(p.seekReloads)],
      ["last seek", lastSeek === null ? "n/a" : lastSeek > 0 ? `${duration(lastSeek)} to settle, ${plural(p.stallsAfterSeek, "stall")} after` : "none"],
      ["quality pick", `preferred ${preferred > 0 ? qn(preferred) : preferred === 0 ? "auto" : "n/a"}, auto ${auto > 0 ? qn(auto) : "n/a"}, ${menuState(menu)}`],
      ["qualities", !Array.isArray(qualities) ? "n/a" : qualities.map(num).filter((id) => id !== null).map(Math.round).join(", ") || "none"],
      ["codec pick", text(p.preferredCodec) ? word(p.preferredCodec) : "default"],
      ["segments", segments || "none"],
      ["urls expire", deadline > 0 ? `${iso(deadline * 1000, true)}${left === null ? "" : left >= 0 ? ` (in ${duration(left)})` : ` (expired ${duration(-left)} ago)`}` : "n/a"],
      ["native core", `${plural(core?.buffersLocked, "buffer")} locked, ${plural(core?.mediaRequests, "media request")}, ${plural(p.nativeLeftoversSuppressed, "hidden console error")}, ${plural(p.codecFailuresBlocked, "codec-failure write")} blocked`],
      ["second buffer", !settings ? "n/a" : settings.secondaryBuffer !== true ? "off" : reserve ? `on, ${secondsAmount(reserve.seconds)} held, ${size(reserve.bytes)} of ${size(reserve.limitBytes)}` : "on"]
    ]);
  }

  function downloads(c) {
    const d = c.downloads, byKind = object(d?.byKind), auto = c.auto, now = c.clock.now;
    const kind = (name) => {
      if (!d) return "n/a";
      const item = object(byKind?.[name]) || {};
      const n = (key) => Math.round(num(item[key]) || 0);
      return `${n("started")} started, ${n("ok")} ok, ${n("failed")} failed, ${n("cancelled")} cancelled, ${size(num(item.bytes) || 0)}`;
    };
    // Cancel reasons as the error they were thrown with, in English, as one token each.
    const reasons = new Map();
    for (const [reason, n] of Object.entries(object(d?.cancelReasons) || {})) {
      if (!(num(n) > 0)) continue;
      const token = scrub(translate(reason)).toLowerCase().replace(/\[removed\]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "unknown";
      reasons.set(token, (reasons.get(token) || 0) + num(n));
    }
    const sorted = [...reasons].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const cancelled = !d ? "n/a" : sorted.length ? [...sorted.slice(0, 8).map(([reason, n]) => `${Math.round(n)} ${reason}`), ...(sorted.length > 8 ? [`${sorted.length - 8} more`] : [])].join(", ") : "none";
    const lastBytes = num(d?.lastBytesAt);
    const at = (ms) => now === null || num(ms) === null ? "n/a" : stamp(now + num(ms));
    let threadsLine = "n/a";
    if (c.settings?.autoConcurrency === false) threadsLine = `off (manual ${count(c.settings.concurrency)})`;
    else if (auto) {
      const steps = num(auto.steps) || 0;
      threadsLine = `${count(auto.threads)}, level ${count(auto.level)}, ${plural(steps, "step")}${steps > 0 ? `, last change ${stamp(c.clock.perf(auto.changedAt))} (${sentence(auto.reason, 80) || "n/a"})` : ""}`;
    }
    const trial = object(auto?.trial), startup = object(auto?.startup);
    const resting = list(auto?.resting).map(object).filter(Boolean)
      .map((rest) => `${count(rest.threads)} threads until ${at(rest.forMs)} (${rest.hard === true ? "server refused" : "no gain"})`).join(", ");
    return pairs([
      ["video", kind("video")],
      ["audio", kind("audio")],
      ["meta", kind("meta")],
      ["active", d ? count(d.active ?? 0) : "n/a"],
      ["cancelled", cancelled],
      ["throughput", auto && num(auto.throughputBps) !== null ? mbit(num(auto.throughputBps) * 8) : "n/a"],
      ["last data", !d ? "n/a" : lastBytes > 0 ? stamp(c.clock.perf(lastBytes, c.videoDelta)) : "none"],
      ["auto threads", threadsLine],
      ["trial", !auto ? "n/a" : trial ? `${count(trial.from)} -> ${count(trial.level)} threads since ${at(-(num(trial.ageMs) || 0))}, baseline ${mbit((num(trial.baselineBps) || 0) * 8)}${trial.stalled === true ? ", stalled meanwhile" : ""}` : "none"],
      ["resting", !auto ? "n/a" : resting || "none"],
      ["startup", !auto ? "n/a" : startup ? `back to ${count(startup.base)} threads by ${at(startup.forMs)}` : "none"]
    ]);
  }

  function nodes(c) {
    if (!c.video) return ["n/a"];
    const rows = nodeRows(c);
    const lines = [];
    if (!rows) lines.push("n/a");
    else if (!rows.length) lines.push("none");
    else {
      const cell = (traffic, key) => traffic ? count(traffic[key] ?? 0) : "-";
      const shown = rows.slice(0, NODE_LIMIT).map((row) => [
        row.host, row.state, row.bps > 0 ? (row.bps * 8 / 1e6).toFixed(2) : "-",
        cell(row.traffic, "ok"), cell(row.traffic, "failed"), cell(row.traffic, "cancelled"),
        row.traffic ? size(num(row.traffic.bytes) || 0) : "-",
        row.traffic && text(row.traffic.lastError) ? sentence(row.traffic.lastError, 60) || "-" : "-"
      ]);
      lines.push(...table(["HOST", "STATE", "Mbit/s", "OK", "FAIL", "CXL", "DATA", "LAST ERROR"], shown, ["l", "l", "r", "r", "r", "r", "r", "l"]));
      if (rows.length > NODE_LIMIT) lines.push(`${rows.length - NODE_LIMIT} more`);
    }
    const addressBans = list(c.video.bans).map(object).filter((ban) => ban?.kind === "address");
    if (!Array.isArray(c.video.bans)) lines.push("address bans  n/a");
    else if (!addressBans.length) lines.push("address bans  none");
    else for (const ban of addressBans.slice(0, 20)) {
      const at = c.clock.perf(ban.at, c.videoDelta);
      lines.push(`address ban   ${hostName(ban.host) || "n/a"}: ${plural(ban.count, "failure")}${text(ban.error) ? ` (${sentence(ban.error, 80)})` : ""}${at === null ? "" : ` at ${stamp(at)}`}`);
    }
    return lines;
  }

  const liveName = (module) => word(module.frame, "") || `module ${module.index + 1}`;
  // The live module in each frame that has one: its stats and stream, on the top clock.
  function liveBlocks(c) {
    return c.live.map((module) => {
      const stats = object(module.stats), context = object(module.context), delta = num(module.timeOriginDelta) || 0;
      const hosts = list(context?.hosts ?? stats?.cdnHosts).map(object).filter((node) => hostName(node?.host));
      const errorAt = c.clock.perf(stats?.lastErrorAt, delta);
      const counts = new Map();
      for (const node of hosts) counts.set(word(node.state, "unknown"), (counts.get(word(node.state, "unknown")) || 0) + 1);
      const lines = pairs([
        ["state", stats ? word(stats.playerState) : "n/a"],
        ["stream", context ? word(context.key, "none") : "none"],
        ["last segment", context ? count(context.lastNum) : "n/a"],
        ["cached", context ? plural(context.cached, "segment") : "n/a"],
        ["requests", stats ? `${count(stats.acceleratedRequests)}, ${size(stats.acceleratedBytes)}` : "n/a"],
        ["active", stats ? count(stats.activeThreads) : "n/a"],
        ["speed", stats && num(stats.totalSpeedBps) !== null ? mbit(num(stats.totalSpeedBps) * 8) : "n/a"],
        ["nodes", hosts.length ? [...counts].map(([state, n]) => `${n} ${state}`).join(", ") : "none"],
        ["last error", !stats ? "n/a" : text(stats.lastError) ? `${sentence(stats.lastError)}${errorAt === null || !num(stats.lastErrorAt) ? "" : ` at ${stamp(errorAt)}`}` : "none"]
      ]);
      if (hosts.length) {
        const sorted = hosts.slice().sort((a, b) => rank(a.state) - rank(b.state) || (num(b.bps) || 0) - (num(a.bps) || 0));
        lines.push(...table(["HOST", "STATE", "Mbit/s"], sorted.slice(0, LIVE_NODE_LIMIT).map((node) => [hostName(node.host), word(node.state, "unknown"), num(node.bps) > 0 ? (node.bps * 8 / 1e6).toFixed(2) : "-"]), ["l", "l", "r"]));
        if (hosts.length > LIVE_NODE_LIMIT) lines.push(`${hosts.length - LIVE_NODE_LIMIT} more`);
      }
      return { title: `Live (${liveName(module)})`, note: "", lines };
    });
  }

  // ---- events ----

  const SOURCES = ["page", "player", "prev", "media", "live"];
  const LEVELS = Object.freeze({ debug: "DEBUG", info: "INFO", success: "INFO", warn: "WARN", warning: "WARN", error: "ERROR" });
  // Levels for records that carry none: older builds, the players' timelines and the element.
  const PAGE_LEVELS = Object.freeze({ "native buffer locked": "DEBUG", "native scheduler stopped": "DEBUG", "playback failed": "ERROR" });
  const PLAYER_LEVELS = Object.freeze({
    "headers requested": "DEBUG", "pause taken as the switch's": "DEBUG", "native future replacement resumed": "DEBUG",
    "native stopped scheduler resumed": "DEBUG", "native already-rendered quality confirmed": "DEBUG", "native range delivered": "DEBUG",
    "rebuffer before underflow": "WARN", "buffer quota hit": "WARN", "native range failed": "WARN",
    "native quality guard unavailable": "WARN", "native core transition: acceleration suspended": "WARN",
    "index parsed": "DEBUG", "seek inside buffer": "DEBUG", "autoplay refused": "WARN", "end of stream failed": "ERROR"
  });
  const MEDIA_LEVELS = Object.freeze({ error: "ERROR", stalled: "WARN", seeking: "DEBUG", seeked: "DEBUG", loadedmetadata: "DEBUG", canplay: "DEBUG" });
  const levelOf = (value) => LEVELS[text(value).toLowerCase()] || null;

  // Every record on one clock, in time order: page-hook's page events, the current and the
  // previous player's timelines, the element's events and the live modules' events.
  function collectEvents(c) {
    const events = [];
    const push = (source, entry, at, level, what, pos) => {
      const detail = detailText(entry.detail);
      events.push({ source, order: events.length, at, level, message: what ? detail ? `${what}: ${detail}` : what : detail || "-", pos: num(pos), count: Math.max(1, Math.round(num(entry.count) || 1)), until: null });
    };
    const records = (source, entries, levels, delta, prefix = "") => {
      for (const raw of list(entries)) {
        const entry = object(raw);
        if (!entry) continue;
        const what = sentence(entry.what ?? entry.name, 120);
        push(source, entry, c.clock.perf(entry.at, delta), levelOf(entry.level) || levels[text(entry.what ?? entry.name)] || "INFO", `${prefix}${what}`, entry.time);
      }
    };
    records("page", c.video?.page, PAGE_LEVELS, c.videoDelta);
    records("player", c.video?.timeline, PLAYER_LEVELS, c.videoDelta);
    records("prev", object(c.video?.previousPlayer)?.timeline, PLAYER_LEVELS, c.videoDelta);
    records("media", c.snapshot.media, MEDIA_LEVELS, 0);
    for (const module of c.live) records("live", module.events, {}, num(module.timeOriginDelta) || 0, c.live.length > 1 ? `[${liveName(module)}] ` : "");
    // Records without a time go last, in the order they came.
    return events.sort((a, b) => (a.at === null) - (b.at === null) || (a.at ?? 0) - (b.at ?? 0)
      || SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source) || a.order - b.order);
  }

  // Adjacent repeats of one record within 10 s of its first become one line with a count.
  function fold(events) {
    const folded = [];
    for (const event of events) {
      const last = folded.at(-1);
      if (last && last.source === event.source && last.message === event.message && last.level === event.level
        && last.at !== null && event.at !== null && event.at - last.at <= FOLD_MS) {
        last.count += event.count;
        last.until = event.at;
        continue;
      }
      folded.push({ ...event });
    }
    return folded;
  }

  function eventsBlock(c, budget) {
    const events = fold(collectEvents(c));
    if (!events.length) return { title: "Events", note: "0 shown, 0 omitted", lines: ["none"] };
    const timeWidth = Math.max(8, ...events.map((event) => event.at === null ? 1 : seconds(event.at).length));
    const posWidth = Math.max(5, ...events.map((event) => event.pos === null ? 1 : fixed(event.pos, 1).length));
    // A long message is cut before its repeat count, which always stays readable.
    const lineOf = (event) => {
      const tail = event.count > 1 ? event.until !== null && event.until !== event.at ? ` (x${event.count} until ${stamp(event.until)})` : ` (x${event.count})` : "";
      const line = clean(`${(event.at === null ? "-" : seconds(event.at)).padStart(timeWidth)}  ${event.level.padEnd(5)}  ${event.source.padEnd(6)}  ${(event.pos === null ? "-" : fixed(event.pos, 1)).padStart(posWidth)}  ${event.message}`);
      return line.length + tail.length <= LINE_LIMIT ? line + tail : `${line.slice(0, LINE_LIMIT - tail.length - 3).trimEnd()}...${tail}`;
    };
    const keep = events.map(() => true);
    // Over 400 lines: the oldest DEBUG lines go first, then the oldest INFO; WARN and ERROR stay.
    let excess = events.length - EVENT_LIMIT;
    for (const level of ["DEBUG", "INFO"]) {
      for (let index = 0; index < events.length && excess > 0; index += 1) if (keep[index] && events[index].level === level) { keep[index] = false; excess -= 1; }
    }
    const lines = events.map(lineOf);
    const header = `${"T".padStart(timeWidth)}  LEVEL  SOURCE  ${"POS".padEnd(posWidth)}  EVENT`;
    let used = header.length + 1 + lines.reduce((sum, line, index) => sum + (keep[index] ? line.length + 1 : 0), 0);
    // A paste over GitHub's limit is lost whole, so the character budget wins in the end: only
    // then do WARN and, last of all, ERROR lines go, again oldest first.
    for (const level of ["DEBUG", "INFO", "WARN", "ERROR"]) {
      for (let index = 0; index < events.length && used > budget; index += 1) if (keep[index] && events[index].level === level) { keep[index] = false; used -= lines[index].length + 1; }
    }
    const shown = lines.filter((_line, index) => keep[index]);
    return { title: "Events", note: `${shown.length} shown, ${events.length - shown.length} omitted`, lines: shown.length ? [header, ...shown] : ["none"] };
  }

  // ---- the whole report ----

  // The last line counts the lines and characters of the whole text, itself included, so a cut
  // paste shows.
  function finish(lines) {
    const body = [...lines.map(clean), ""];
    const base = body.join("\n").length + 1;
    let end = "";
    for (let pass = 0; pass < 4; pass += 1) {
      const next = `== End ==  ${body.length + 1} lines, ${base + end.length} chars`;
      if (next === end) break;
      end = next;
    }
    return `${body.join("\n")}\n${end}`;
  }

  function compose(snapshot) {
    const c = facts(snapshot);
    const blocks = [];
    const section = (title, note, build) => {
      let lines;
      try { lines = build(c); } catch (error) { lines = [`n/a (formatter failed: ${sentence(error, 120) || "unknown error"})`]; }
      blocks.push({ title, note, lines });
    };
    section("Summary", "", summary);
    section("Checks", "", checks);
    section("Environment", "", environment);
    section("Site", "", site);
    section("Settings", "(* = changed from default)", settingsSection);
    section("Playback", "", playback);
    section("Downloads", "(since page load)", downloads);
    section("CDN nodes", "", nodes);
    try { blocks.push(...liveBlocks(c)); } catch (error) { blocks.push({ title: "Live", note: "", lines: [`n/a (formatter failed: ${sentence(error, 120) || "unknown error"})`] }); }
    const fixedLines = [...header(c), ...blocks.flatMap((block) => ["", heading(block), ...block.lines])].map(clean);
    const used = fixedLines.reduce((sum, line) => sum + line.length + 1, 0);
    let events;
    // What follows the events: their heading, the blank line and the End line.
    try { events = eventsBlock(c, CHAR_LIMIT - used - 200); } catch (error) { events = { title: "Events", note: "", lines: [`n/a (formatter failed: ${sentence(error, 120) || "unknown error"})`] }; }
    return finish([...fixedLines, "", heading(events), ...events.lines]);
  }

  // Never throws: a report that says the formatter failed is still worth pasting.
  function render(snapshot) {
    try { return compose(object(snapshot) || {}); } catch (error) {
      try { return finish([`BTR diagnostics (format ${FORMAT}) | formatter failed: ${sentence(error, 120) || "unknown error"}`]); } catch (_error) {
        return `BTR diagnostics (format ${FORMAT}) | formatter failed`;
      }
    }
  }

  root.__BTR_DIAGNOSTIC_REPORT__ = Object.freeze({ FORMAT, DEFAULTS, render, translate });
})(globalThis);
