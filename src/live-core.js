(function installLiveCore(root) {
  "use strict";

  // The parts of the live module that carry logic: playlist parsing, P2P/proxy URL handling
  // and the host pool, plus a room playinfo parser that only the tests use. No DOM and no
  // timers, so dev tests can run all of it in Node.

  // fMP4 HLS nodes that accept each other's signatures, verified by probing real streams
  // (2026-09): a segment signed for one of them downloads from all of them with HTTP 206,
  // while FLV-line (ov-gotcha07) and TS-line (gotcha105) nodes answer 403. The live module
  // probes each candidate before trusting it, again with later playlists until it passes or
  // is banned.
  const KNOWN_FMP4_HOSTS = Object.freeze([
    "d1--cn-gotcha204.bilivideo.com",
    "d1--cn-gotcha208.bilivideo.com",
    "d1--ov-gotcha208.bilivideo.com",
    "d1--ov-gotcha208b.bilivideo.com"
  ]);

  const LIVE_HOST_RE = /(?:^|\.)bilivideo\.(?:com|cn|net)$/i;
  const P2P_HOST_RE = /(?:^|\.)(?:mcdn\.bilivideo\.(?:com|cn|net)|szbdyd\.com|nexusedgeio\.com|ahdohpiechei\.com)$/i;
  // A stream URL wrapped in a commercial relay: https://xxx.smtcdns.net/d1--yy.bilivideo.com/...
  const PROXY_WRAP_RE = /^(https?:)\/\/[\w.-]+\.smtcdns\.(?:net|com)\/([\w-]+\.bilivideo\.(?:com|cn|net))(\/.*)$/i;

  function hostnameOf(value) {
    try { return new URL(value).hostname.toLowerCase(); }
    catch (_error) { return ""; }
  }

  function isLiveSegmentUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && LIVE_HOST_RE.test(url.hostname) && /\/live-bvc\//.test(url.pathname) && /\.m4s$/i.test(url.pathname);
    } catch (_error) { return false; }
  }

  function isLivePlaylistUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && LIVE_HOST_RE.test(url.hostname) && /\.m3u8$/i.test(url.pathname);
    } catch (_error) { return false; }
  }

  function isP2pUrl(value) {
    const host = hostnameOf(value);
    if (!host) return false;
    return P2P_HOST_RE.test(host) || host.split(".")[0].includes("302");
  }

  // A smtcdns-wrapped URL unwraps to the official node it relays for; anything else
  // returns "" and stays untouched.
  function unwrapProxyUrl(value) {
    const match = PROXY_WRAP_RE.exec(String(value || ""));
    return match ? `${match[1]}//${match[2]}${match[3]}` : "";
  }

  // The playurl of getRoomPlayInfo, flattened to one entry per protocol/format/codec.
  function parseRoomPlayInfo(payload) {
    const playurl = payload?.data?.playurl_info?.playurl
      || payload?.result?.playurl_info?.playurl
      || payload?.playurl_info?.playurl;
    const out = [];
    for (const stream of playurl?.stream || []) {
      for (const format of stream.format || []) {
        for (const codec of format.codec || []) {
          const urls = (codec.url_info || [])
            .map((info) => ({ host: String(info?.host || ""), extra: String(info?.extra || "") }))
            .filter((info) => info.host && !isP2pUrl(info.host));
          if (!urls.length || !codec.base_url) continue;
          out.push({
            protocol: String(stream.protocol_name || ""),
            format: String(format.format_name || ""),
            codec: String(codec.codec_name || ""),
            qn: Number(codec.current_qn) || 0,
            acceptQn: Array.isArray(codec.accept_qn) ? codec.accept_qn.map(Number) : [],
            baseUrl: String(codec.base_url),
            urls
          });
        }
      }
    }
    return out;
  }

  function segmentNumber(name) {
    const match = /(\d+)\.m4s$/i.exec(String(name || ""));
    return match ? Number(match[1]) : 0;
  }

  // A live media playlist. Segment URLs resolve against the playlist URL, so a playlist
  // fetched from any node names segments on that same node.
  function parseM3u8(text, playlistUrl) {
    const lines = String(text || "").split(/\r?\n/);
    const segments = [];
    let mapUrl = "";
    let duration = 0;
    for (const line of lines) {
      if (line.startsWith("#EXT-X-MAP")) {
        const uri = /URI="([^"]+)"/.exec(line)?.[1];
        if (uri) try { mapUrl = new URL(uri, playlistUrl).href; } catch (_error) {}
        continue;
      }
      if (line.startsWith("#EXTINF")) {
        duration = Number(/#EXTINF:([\d.]+)/.exec(line)?.[1]) || 0;
        continue;
      }
      if (!line || line.startsWith("#")) continue;
      try {
        segments.push({ name: line.trim(), url: new URL(line.trim(), playlistUrl).href, num: segmentNumber(line), duration });
      } catch (_error) {}
      duration = 0;
    }
    return { mapUrl, segments, lastNum: segments.at(-1)?.num || 0 };
  }

  // Node health for one live stream. Live pieces are one second long, so the pool acts
  // fast: it ranks by first-byte time, blocks a failing node briefly, and bans one that
  // twice sent nothing. Proven nodes rank first; unproven candidates follow them until a
  // probe or a download proves them.
  function createHostPool(options = {}) {
    const health = new Map(); // host -> {fbMs, bps, failures, blockedUntil, proven, emptyReplies, banned}
    const now = () => (options.now ? options.now() : Date.now());

    function entry(host) {
      if (!health.has(host)) health.set(host, { fbMs: 0, bps: 0, failures: 0, blockedUntil: 0, proven: false, emptyReplies: 0, banned: false });
      return health.get(host);
    }

    return Object.freeze({
      add(host, proven = false) {
        const item = entry(String(host || "").toLowerCase());
        if (proven) item.proven = true;
      },
      success(host, fbMs, bps) {
        const item = entry(host);
        item.proven = true;
        item.banned = false;
        item.emptyReplies = 0;
        item.failures = 0;
        item.blockedUntil = 0;
        if (Number(fbMs) > 0) item.fbMs = item.fbMs ? item.fbMs * 0.6 + fbMs * 0.4 : fbMs;
        if (Number(bps) > 0) item.bps = item.bps ? item.bps * 0.6 + bps * 0.4 : bps;
      },
      failure(host, receivedBytes = 0) {
        const item = entry(host);
        item.failures += 1;
        item.blockedUntil = now() + Math.min(20000, 1500 * (2 ** Math.min(item.failures, 3)));
        if (Number(receivedBytes) <= 0) {
          item.emptyReplies += 1;
          if (item.emptyReplies >= 2 && !item.banned) {
            item.banned = true;
            try { options.onBan?.(host); } catch (_error) {}
          }
        }
      },
      // Ranked hosts: proven ones by first-byte speed, then unproven candidates. Blocked
      // and banned hosts drop out unless nothing else is left.
      pick(count = 3) {
        const time = now();
        const all = [...health.entries()];
        const open = all.filter(([, item]) => !item.banned && item.blockedUntil <= time);
        const unbanned = all.filter(([, item]) => !item.banned);
        const pool = open.length ? open : unbanned.length ? unbanned : all;
        const ranked = pool.sort(([, a], [, b]) =>
          Number(b.proven) - Number(a.proven)
          || (a.fbMs || 9e9) - (b.fbMs || 9e9)
          || (b.bps || 0) - (a.bps || 0));
        return ranked.slice(0, Math.max(1, count)).map(([host]) => host);
      },
      unproven() {
        return [...health.entries()].filter(([, item]) => !item.proven && !item.banned).map(([host]) => host);
      },
      status() {
        const time = now();
        return [...health.entries()].map(([host, item]) => ({
          host,
          state: item.banned ? "banned" : item.blockedUntil > time ? "blocked" : item.proven ? "healthy" : "untested",
          bps: Math.round(item.bps || 0)
        }));
      }
    });
  }

  root.__BILI_LIVE_CORE__ = Object.freeze({
    KNOWN_FMP4_HOSTS,
    createHostPool,
    isLivePlaylistUrl,
    isLiveSegmentUrl,
    isP2pUrl,
    parseM3u8,
    parseRoomPlayInfo,
    segmentNumber,
    unwrapProxyUrl
  });
})(globalThis);
