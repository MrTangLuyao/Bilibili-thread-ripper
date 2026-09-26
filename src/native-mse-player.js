(function installNativeMsePlayer(root) {
  "use strict";

  const core = root.__BILI_RANGE_CORE__;
  const sidxTools = root.__BILI_SIDX__;
  const resolverFactory = root.__BILI_CDN_RESOLVER_FACTORY__;
  const downloaderFactory = root.__BILI_IDM_DOWNLOADER_FACTORY__;
  if (!core || !sidxTools || !resolverFactory || !downloaderFactory || !root.MediaSource) return;

  const STARTUP_BUFFER_MIN_SECONDS = 2.5;
  const STARTUP_BUFFER_MAX_SECONDS = 10;
  const STARTUP_RECOVERY_SECONDS = 6;
  const STARTUP_PROTECTION_MS = 20000;
  // When the browser's buffer quota is hit: the forward buffer is never brought below the
  // floor, and a full buffer with less than this ahead is a failure, not something to wait out.
  const QUOTA_AHEAD_FLOOR_SECONDS = 8;
  const QUOTA_FATAL_AHEAD_SECONDS = 10;
  // A video whose buffer stays full through this many waits is given up after all.
  const QUOTA_MAX_WAITS = 8;

  function playbackDeadlineAt(segmentStart, currentTime, playbackRate, now = performance.now()) {
    const rate = Math.max(0.25, Math.abs(Number(playbackRate) || 1));
    return now + Math.max(0, (Number(segmentStart) - Number(currentTime)) * 1000 / rate);
  }

  // Bilibili's core keeps the position it saved when it last reloaded its own source (a
  // quality switch, or the retry it makes once BTR replaced the source) and seeks back to
  // it every time the element reports new metadata, until the video ends or the page
  // moves on. Every BTR session starts with new metadata, so after one such reload every
  // drag of the progress bar and every quality switch ended up back at that old position.
  // The moment of its last reload is known here, so its seek can be told from a viewer's
  // and undone. Kept across players: the retake after a fallback is a new player.
  let nativeRestore = { key: "", time: 0 };
  function rememberNativeRestore(key, time) {
    if (Number(time) >= 1) nativeRestore = { key, time: Number(time) };
  }
  const QUALITY_NAMES = Object.freeze({
    127: "8K", 126: "杜比视界", 125: "HDR", 120: "4K", 116: "1080P 60帧",
    112: "1080P 高码率", 80: "1080P", 74: "720P 60帧", 64: "720P",
    32: "480P", 16: "360P", 6: "240P"
  });

  function dashBody(playinfo) {
    return playinfo?.data?.dash ? playinfo.data : playinfo?.result?.dash ? playinfo.result : playinfo;
  }

  function dashData(playinfo) {
    return dashBody(playinfo)?.dash || null;
  }

  function mimeFor(representation, fallbackKind) {
    const mime = representation?.mimeType || representation?.mime_type || `${fallbackKind}/mp4`;
    const codecs = representation?.codecs || representation?.codec;
    return codecs ? `${mime}; codecs="${codecs}"` : mime;
  }

  function frameRate(representation) {
    const raw = String(representation?.frameRate || representation?.frame_rate || "0");
    if (!raw.includes("/")) return Number(raw) || 0;
    const [top, bottom] = raw.split("/").map(Number);
    return bottom ? top / bottom : 0;
  }

  function codecFamily(representation) {
    const codec = String(representation?.codecs || representation?.codec || "").toLowerCase();
    const codecId = Number(representation?.codecid || representation?.codec_id);
    if (codec.startsWith("av01") || codecId === 13) return "av1";
    if (codec.startsWith("hev1") || codec.startsWith("hvc1") || codecId === 12) return "hevc";
    if (codec.startsWith("avc1") || codecId === 7) return "avc";
    return "other";
  }

  function normalizeCodec(value) {
    return ["av1", "hevc", "avc"].includes(value) ? value : "";
  }

  // The audio picked in the player: 0 the ordinary track, 1 杜比全景声, 2 Hi-Res 无损
  // (Bilibili's own numbering, the newA of player.getQuality()).
  function normalizeAudio(value) {
    const audio = Math.trunc(Number(value)) || 0;
    return audio === 1 || audio === 2 ? audio : 0;
  }

  // "默认" in the player's 播放策略 menu keeps AV1 > HEVC > AVC. A codec picked there comes
  // first; a quality that does not have it falls back to that order.
  function codecPriority(representation, preferredCodec = "") {
    const family = codecFamily(representation);
    if (preferredCodec && family === preferredCodec) return 4;
    return { av1: 3, hevc: 2, avc: 1, other: 0 }[family] || 0;
  }

  function qualityLabel(representation) {
    const id = Number(representation?.id);
    const fps = frameRate(representation);
    if (QUALITY_NAMES[id]) {
      const label = QUALITY_NAMES[id];
      return fps >= 50 && !label.includes("60帧") && [120, 80, 64, 32, 16].includes(id)
        ? `${label} ${Math.round(fps)}帧`
        : label;
    }
    const height = Number(representation?.height) || 0;
    const label = height >= 2160 ? "4K" : height ? `${height}P` : `清晰度 ${id || "?"}`;
    return fps >= 50 ? `${label} ${Math.round(fps)}帧` : label;
  }

  function supported(representation, kind) {
    try { return MediaSource.isTypeSupported(mimeFor(representation, kind)); }
    catch (_error) { return false; }
  }

  // preferredQuality is the quality chosen in the native menu; 0 is "auto" and keeps the
  // quality the playinfo itself asks for. preferredCodec is the codec chosen there, "" for
  // "默认". preferredAudio is the audio chosen there (see normalizeAudio).
  function selectRepresentations(playinfo, preferredQuality = 0, preferredCodec = "", preferredAudio = 0) {
    const body = dashBody(playinfo);
    const dash = body?.dash;
    if (!dash) throw new Error("页面没有 DASH 播放清单");
    const codec = normalizeCodec(preferredCodec);
    const byQuality = new Map();
    for (const representation of (dash.video || []).filter((item) => supported(item, "video"))) {
      const key = Number(representation.id) || `${Number(representation.height) || 0}-${Math.round(frameRate(representation))}`;
      const existing = byQuality.get(key);
      if (!existing || codecPriority(representation, codec) > codecPriority(existing, codec) ||
          (codecPriority(representation, codec) === codecPriority(existing, codec) && (Number(representation.bandwidth) || 0) > (Number(existing.bandwidth) || 0))) {
        byQuality.set(key, representation);
      }
    }
    const videos = Array.from(byQuality.values()).sort((a, b) =>
      (Number(b.height) || 0) - (Number(a.height) || 0) || frameRate(b) - frameRate(a) ||
      (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0));
    // Dolby and Hi-Res sources keep their tracks in dash.dolby.audio / dash.flac.audio;
    // some of them have nothing in dash.audio at all, which used to fail the takeover.
    // The track picked in the player comes first when this browser can play it; otherwise
    // the ordinary track, like the native player's default.
    const audioOf = (list) => [].concat(list || []).filter((item) => supported(item, "audio"))
      .sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0))[0];
    const picked = { 1: dash.dolby?.audio, 2: dash.flac?.audio }[normalizeAudio(preferredAudio)];
    const audio = audioOf(picked) || audioOf(dash.audio) || audioOf(dash.flac?.audio) || audioOf(dash.dolby?.audio);
    if (!videos.length || !audio) throw new Error("浏览器不支持清单中的视频或音频编码");
    const requestedQuality = Number(body?.quality || body?.qn) || 0;
    const preferred = [Number(preferredQuality) || 0, requestedQuality]
      .map((quality) => quality && videos.find((item) => Number(item.id) === quality))
      .find(Boolean)
      || videos.find((item) => (Number(item.height) || 0) <= 2160)
      || videos[0];
    return { audio, dash, preferred, videos };
  }

  function representationUrl(representation) {
    return String(representation?.baseUrl || representation?.base_url || "");
  }

  // The file without its node and signature: a refreshed playinfo names the same file again.
  function representationPath(representation) {
    try { return new URL(representationUrl(representation)).pathname; }
    catch (_error) { return representationUrl(representation); }
  }

  function sameRepresentation(left, right) {
    return Number(left?.id) === Number(right?.id)
      && codecFamily(left) === codecFamily(right)
      && representationPath(left) === representationPath(right);
  }

  function segmentBase(representation) {
    const base = representation?.segment_base || representation?.segmentBase || representation?.SegmentBase || {};
    const init = core.parseByteRange(base.initialization || base.Initialization || base.initialization_range);
    const index = core.parseByteRange(base.index_range || base.indexRange || base.IndexRange);
    if (!init || !index) throw new Error("播放清单缺少初始化或 SIDX 字节范围");
    return { init, index };
  }

  function waitEvent(target, successName, errorName = "error", signal = null) {
    return new Promise((resolve, reject) => {
      const abortReason = () => signal?.reason instanceof Error
        ? signal.reason
        : new DOMException("播放任务已取消", "AbortError");
      const success = () => { cleanup(); resolve(); };
      const failure = () => { cleanup(); reject(new Error(`${successName} 失败`)); };
      const aborted = () => { cleanup(); reject(abortReason()); };
      const cleanup = () => {
        target.removeEventListener(successName, success);
        target.removeEventListener(errorName, failure);
        signal?.removeEventListener("abort", aborted);
      };
      if (signal?.aborted) {
        reject(abortReason());
        return;
      }
      target.addEventListener(successName, success, { once: true });
      target.addEventListener(errorName, failure, { once: true });
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  function isBufferedAt(sourceBuffer, time) {
    let ranges;
    try { ranges = sourceBuffer?.buffered; }
    catch (_error) { return false; }
    if (!ranges) return false;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) <= time + 0.25 && ranges.end(index) >= time - 0.25) return true;
    }
    return false;
  }

  function bufferedEndAt(sourceBuffer, time) {
    let ranges;
    try { ranges = sourceBuffer?.buffered; }
    catch (_error) { return time; }
    if (!ranges) return time;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) <= time + 0.25 && ranges.end(index) >= time - 0.25) return ranges.end(index);
    }
    return time;
  }

  function bufferedStart(sourceBuffer, fallback) {
    try { return sourceBuffer.buffered.length ? sourceBuffer.buffered.start(0) : fallback; }
    catch (_error) { return fallback; }
  }

  function mediaBytesPerSecond(track) {
    const segment = track?.sidx?.segments?.[track.startupIndex];
    if (segment?.durationSeconds > 0 && segment?.length > 0) return segment.length / segment.durationSeconds;
    return Math.max(0, Number(track?.representation?.bandwidth) || 0) / 8;
  }

  // While BTR plays the video, Bilibili's own core keeps timers that read its SourceBuffers,
  // which detached from their MediaSource when the takeover replaced the element's source.
  // HDR and 8K sources poll especially often, and every read throws InvalidStateError into
  // the page's error reporting. While a takeover is active, such a read answers with an
  // empty range instead; without one the browser behaves as before.
  let bufferedShimInstalled = false;
  const ownSourceBuffers = new WeakSet();
  function installBufferedShim() {
    if (bufferedShimInstalled || !root.SourceBuffer) return;
    const descriptor = Object.getOwnPropertyDescriptor(root.SourceBuffer.prototype, "buffered");
    if (!descriptor?.get || !descriptor.configurable) return;
    bufferedShimInstalled = true;
    const emptyRanges = Object.freeze({
      length: 0,
      start() { throw new DOMException("空的缓冲区间", "IndexSizeError"); },
      end() { throw new DOMException("空的缓冲区间", "IndexSizeError"); }
    });
    Object.defineProperty(root.SourceBuffer.prototype, "buffered", {
      ...descriptor,
      get() {
        try {
          return descriptor.get.call(this);
        } catch (error) {
          if (error?.name === "InvalidStateError" && !ownSourceBuffers.has(this) && document.querySelector('[data-btr-mse-active="true"]')) return emptyRanges;
          throw error;
        }
      }
    });
  }

  // Bilibili's core keeps its own element listeners while BTR plays, and they run against
  // state it never finished initializing: its seek handler reads DVRWindow off a
  // representation info it only fills once its own stream starts, and its buffer checks read
  // 'updating' off a SourceBuffer that left its MediaSource. Both throw into the page on every
  // drag, where its own error reporter picks them up. While a takeover is active these two are
  // swallowed and counted for the diagnostic report; every other error, and every error while
  // Bilibili itself plays, is left untouched.
  const nativeLeftovers = { suppressed: 0, last: "" };
  const NATIVE_LEFTOVER_RE = /DVRWindow|reading '?updating'?/;
  let leftoverGuardInstalled = false;
  function installNativeErrorGuard() {
    if (leftoverGuardInstalled || typeof root.addEventListener !== "function") return;
    leftoverGuardInstalled = true;
    root.addEventListener("error", (event) => {
      if (!NATIVE_LEFTOVER_RE.test(String(event.message || ""))) return;
      let source = null;
      try { source = new URL(String(event.filename || "")); } catch (_error) { return; }
      if (!/(^|\.)hdslb\.com$/i.test(source.hostname) || !/\/player\//i.test(source.pathname)) return;
      if (!document.querySelector('[data-btr-mse-active="true"]')) return;
      nativeLeftovers.suppressed += 1;
      nativeLeftovers.last = String(event.message || "").slice(0, 120);
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  // Bilibili's player attaches its own MediaSource to the element and creates its source
  // buffers a moment after it opens. A takeover that replaced the element's source in
  // between closed that MediaSource under it, so its addSourceBuffer threw, and Bilibili took
  // that for "this browser cannot play the codec" (#29): it stopped using HEVC in the whole
  // tab, so 杜比视界 and HDR vanished from the quality menu, it stopped offering Hi-Res and
  // Dolby audio on the page, and it restarted at a lower quality. The page's MediaSources
  // are remembered by their object URL, and a takeover waits while the element holds one
  // that is open without its buffers.
  const pageMediaSources = new Map();
  const ownMediaSources = new WeakSet();
  const NATIVE_SOURCE_WAIT_MS = 1000;
  let mediaSourceWatchInstalled = false;
  function installMediaSourceWatch() {
    if (mediaSourceWatchInstalled || typeof root.URL?.createObjectURL !== "function") return;
    mediaSourceWatchInstalled = true;
    const createObjectURL = root.URL.createObjectURL;
    root.URL.createObjectURL = function (object) {
      const url = createObjectURL.apply(this, arguments);
      if (object instanceof root.MediaSource) {
        pageMediaSources.set(url, object);
        if (pageMediaSources.size > 16) pageMediaSources.delete(pageMediaSources.keys().next().value);
      }
      return url;
    };
  }

  // Resolves once Bilibili's MediaSource on the element has its buffers, has closed, or after
  // a second at most. null when there is nothing to wait for.
  function nativeSourceSettled(video) {
    const source = (video.srcObject instanceof root.MediaSource ? video.srcObject : null)
      || pageMediaSources.get(video.src) || pageMediaSources.get(video.currentSrc);
    if (!source || ownMediaSources.has(source) || source.readyState !== "open" || source.sourceBuffers.length >= 2) return null;
    return new Promise((resolve) => {
      let grace = null;
      const done = () => {
        clearTimeout(limit);
        clearTimeout(grace);
        source.sourceBuffers.removeEventListener("addsourcebuffer", added);
        source.removeEventListener("sourceclose", done);
        source.removeEventListener("sourceended", done);
        resolve();
      };
      // Video and audio are added one right after the other; a source with a single track
      // only costs the short grace period.
      const added = () => {
        if (source.sourceBuffers.length >= 2) done();
        else if (!grace) grace = setTimeout(done, 150);
      };
      const limit = setTimeout(done, NATIVE_SOURCE_WAIT_MS);
      source.sourceBuffers.addEventListener("addsourcebuffer", added);
      source.addEventListener("sourceclose", done);
      source.addEventListener("sourceended", done);
    });
  }

  // Should Bilibili still record a codec failure while BTR plays, the failure is about BTR's
  // takeover and not about the browser, yet it would keep HEVC and the Hi-Res / Dolby tracks
  // off for the rest of the tab (sessionStorage) or, when its server asks for it, for days
  // (localStorage). While a takeover is active those records are not written.
  const CODEC_FAILURE_KEYS = new Set(["enableHEVCError", "enableAV1Error", "decodeHEVCError", "decodeAV1Error", "bilibili_decode_error_obj"]);
  const codecFailures = { blocked: 0, last: "" };
  let codecFailureGuardInstalled = false;
  function installCodecFailureGuard() {
    const storage = root.Storage?.prototype;
    if (codecFailureGuardInstalled || typeof storage?.setItem !== "function") return;
    codecFailureGuardInstalled = true;
    const setItem = storage.setItem;
    storage.setItem = function (key, value) {
      if (CODEC_FAILURE_KEYS.has(String(key)) && document.querySelector('[data-btr-mse-active="true"]')) {
        codecFailures.blocked += 1;
        codecFailures.last = String(key);
        return;
      }
      return setItem.apply(this, arguments);
    };
    // Versions up to 0.9.4.2 could leave such records behind; they are cleared once.
    try {
      if (root.localStorage.getItem("BTR.codecFailuresCleared") !== "1") {
        for (const key of CODEC_FAILURE_KEYS) {
          root.localStorage.removeItem(key);
          root.sessionStorage.removeItem(key);
        }
        setItem.call(root.localStorage, "BTR.codecFailuresCleared", "1");
      }
    } catch (_error) {}
  }

  function createNativePlayer(options) {
    const getSettings = options.getSettings;
    const video = options.container.querySelector("video");
    if (!video) throw new Error("没有找到 B 站原生 video 元素");
    let currentPlayinfo = options.playinfo;
    let preferredQuality = Math.max(0, Math.trunc(Number(options.preferredQuality)) || 0);
    let preferredCodec = normalizeCodec(options.preferredCodec);
    const preferredAudio = normalizeAudio(options.preferredAudio);
    let selection = selectRepresentations(currentPlayinfo, preferredQuality, preferredCodec, preferredAudio);
    let selectedVideo = selection.preferred;
    // The two representation objects the running session downloads from. Its resolvers keep
    // reading them, so fresh addresses always go into these two and never into a newer
    // selection's copies.
    let selectedAudio = selection.audio;
    let sessionStarts = 0;
    let sessionRequests = 0;
    let session = null;
    let destroyed = false;
    let generationSequence = 0;
    let seekTimer = null;
    let seekReloads = 0;
    let seekRequestedAt = 0;
    let nativeRestoresUndone = 0;
    const restoreKey = options.identity?.key || representationPath(selection.preferred) || "";
    if (nativeRestore.key !== restoreKey) nativeRestore = { key: restoreKey, time: 0 };
    let seekStartedAt = 0;
    let seekSettledAt = 0;
    let lastSeekMs = 0;
    let stallsAfterSeek = 0;
    let endedAt = 0;
    // The initialization segment and the index of a representation never change, and a seek
    // outside the buffer starts a new session for the same one. Asking for them again cost
    // every such seek a round trip to the CDN before any media could be requested.
    const trackHeaders = new Map();
    const timeline = [];
    function note(what, detail = "") {
      timeline.push({ at: Math.round(performance.now()), time: Math.round((Number(video.currentTime) || 0) * 10) / 10, what, detail: String(detail) });
      if (timeline.length > 120) timeline.shift();
    }
    const eventController = new AbortController();
    const sourceObserver = new MutationObserver(() => {
      const candidate = session;
      if (destroyed || !candidate || candidate.disposed || video.src === candidate.objectUrl) return;
      if (candidate.externalSourceDetected) return;
      candidate.externalSourceDetected = true;
      rememberNativeRestore(restoreKey, video.currentTime);
      candidate.controller.abort(new DOMException("B站原生播放器正在切换媒体源", "AbortError"));
      clearInterval(candidate.timer);
      clearTimeout(candidate.endRetryTimer);
      sourceObserver.disconnect();
      options.onNativeSourceChange?.({ src: video.currentSrc || video.src || "" });
    });
    const original = {
      src: video.currentSrc || video.src || "",
      srcAttribute: video.getAttribute("src"),
      volume: video.volume,
      muted: video.muted,
      playbackRate: video.playbackRate,
      currentTime: Number(video.currentTime) || 0,
      wasPaused: video.paused
    };
    const downloader = downloaderFactory.createDownloader({
      getSettings,
      nativeFetch: options.nativeFetch,
      onTransfer: options.onTransfer
    });

    function sessionIsCurrent(candidate) {
      return !destroyed && session === candidate && !candidate.disposed && !candidate.externalSourceDetected;
    }

    function publishState(extra = {}) {
      const resolvers = session ? [session.videoResolver, session.audioResolver] : [];
      const health = resolvers.flatMap((resolver) => resolver.status());
      const current = Number(video.currentTime) || 0;
      options.onState?.({
        mode: core.normalizeSettings(getSettings()).mode,
        playerState: session?.fatal ? "error" : video.ended ? "ended" : session?.recovering ? "buffering" : session?.playbackActivated ? "ready" : "loading",
        quality: qualityLabel(selectedVideo),
        codec: codecFamily(selectedVideo),
        bufferedAhead: session?.tracks?.length
          ? Math.max(0, Math.min(...session.tracks.map((track) => bufferedEndAt(track.sourceBuffer, current))) - current)
          : 0,
        startupTargetSeconds: session?.startupTargetSeconds || 0,
        startupThroughputBps: session?.startupThroughputBps || 0,
        mediaBytesPerSecond: session?.mediaBytesPerSecond || 0,
        startupWaitingEvents: session?.startupWaitingEvents || 0,
        cdnHosts: health,
        ...extra
      });
    }

    async function queuedSourceOperation(candidate, track, operation) {
      const next = track.operation.catch(() => {}).then(async () => {
        if (!sessionIsCurrent(candidate)) return;
        if (track.sourceBuffer.updating) await waitEvent(track.sourceBuffer, "updateend", "error", candidate.controller.signal);
        if (!sessionIsCurrent(candidate)) return;
        return operation();
      });
      track.operation = next;
      return next;
    }

    function append(candidate, track, bytes, generation) {
      return queuedSourceOperation(candidate, track, async () => {
        if (!sessionIsCurrent(candidate) || generation !== candidate.generation) return;
        try {
          track.sourceBuffer.appendBuffer(bytes);
        } catch (error) {
          // The browser caps how much a SourceBuffer holds (about 150 MB of video in
          // Chromium), which a 4K video reaches within the 45 second window. Freeing
          // played data and asking for less ahead keeps the video playing; failing the
          // append here would hand the whole video back to Bilibili.
          if (error?.name !== "QuotaExceededError") throw error;
          const current = Number(video.currentTime) || 0;
          const ahead = Math.max(0, bufferedEndAt(track.sourceBuffer, current) - current);
          candidate.bufferAheadLimit = Math.max(QUOTA_AHEAD_FLOOR_SECONDS, Math.min(candidate.bufferAheadLimit || Infinity, ahead * 0.75));
          note("buffer quota hit", `${track.kind} keeps ${candidate.bufferAheadLimit.toFixed(0)}s ahead`);
          options.onLog?.("浏览器缓冲区满了", `已释放播放过的数据，这个视频接下来最多提前缓冲 ${candidate.bufferAheadLimit.toFixed(0)} 秒。`, "info", "buffer");
          const behindEnd = Math.max(0, current - 5);
          if (behindEnd > 0 && bufferedStart(track.sourceBuffer, behindEnd) < behindEnd) {
            track.sourceBuffer.remove(0, behindEnd);
            await waitEvent(track.sourceBuffer, "updateend", "error", candidate.controller.signal);
          }
          if (!sessionIsCurrent(candidate) || generation !== candidate.generation) return;
          try {
            track.sourceBuffer.appendBuffer(bytes);
          } catch (again) {
            if (again?.name !== "QuotaExceededError") throw again;
            // Nothing played is left to free: what is buffered ahead fills the quota by
            // itself. This write ends here so the buffer's queue stays free; the caller
            // keeps the bytes and writes them once playback has used up some of the buffer.
            throw Object.assign(again, { bufferFull: true, aheadSeconds: ahead });
          }
        }
        await waitEvent(track.sourceBuffer, "updateend", "error", candidate.controller.signal);
      });
    }

    function removeRange(candidate, track, start, end) {
      if (end <= start || candidate.mediaSource.readyState !== "open") return Promise.resolve();
      return queuedSourceOperation(candidate, track, async () => {
        if (!sessionIsCurrent(candidate) || candidate.mediaSource.readyState !== "open") return;
        track.sourceBuffer.remove(start, end);
        await waitEvent(track.sourceBuffer, "updateend", "error", candidate.controller.signal);
      });
    }

    async function loadTrack(candidate, kind, representation, resolver, sourceBuffer, startTime) {
      const headerKey = `${kind}:${Number(representation?.id) || 0}:${codecFamily(representation)}:${representationPath(representation)}`;
      let header = trackHeaders.get(headerKey);
      note(header ? "headers kept" : "headers requested", kind);
      if (!header) {
        const ranges = segmentBase(representation);
        const [initialization, indexBytes] = await Promise.all([
          downloader.downloadRange(ranges.init, resolver, { signal: candidate.controller.signal, parallel: false, kind: "meta" }),
          downloader.downloadRange(ranges.index, resolver, { signal: candidate.controller.signal, parallel: false, kind: "meta" })
        ]);
        if (!sessionIsCurrent(candidate)) throw new DOMException("播放任务已取消", "AbortError");
        const parsed = sidxTools.parseSidx(indexBytes.bytes, ranges.index.start);
        if (!parsed?.segments?.length) throw new Error(`${kind === "video" ? "视频" : "音频"} SIDX 解析失败`);
        options.onLog?.("已经确认数据的下载位置", `找到了 ${parsed.segments.length} 段${kind === "audio" ? "声音" : "画面"}数据。`, "success", "download");
        header = { initialization: initialization.bytes, sidx: parsed };
        trackHeaders.set(headerKey, header);
      }
      const { sidx } = header;
      const startupIndex = sidxTools.segmentIndexAt(sidx.segments, startTime);
      const track = {
        kind, representation, resolver, sourceBuffer, sidx,
        nextIndex: startupIndex,
        startupIndex,
        complete: false,
        // The generation whose fill loop holds this track, 0 when no loop runs.
        filling: 0,
        started: false,
        startupComplete: false,
        startupScheduled: false,
        followupScheduled: false,
        prefetches: new Map(),
        operation: Promise.resolve()
      };
      await append(candidate, track, header.initialization, candidate.generation);
      return track;
    }

    // Each generation of a session downloads under its own signal, chained to the session's:
    // a seek inside the session cancels the segments of the position left behind without
    // ending the session itself.
    function openGeneration(candidate) {
      candidate.generation = ++generationSequence;
      candidate.generationController = new AbortController();
      const reason = () => candidate.controller.signal.reason || new DOMException("播放任务已取消", "AbortError");
      if (candidate.controller.signal.aborted) candidate.generationController.abort(reason());
      else if (!candidate.generationLinked) {
        // One listener for the session, cancelling whichever generation is current: a session
        // with many seeks must not pile up listeners on its own signal.
        candidate.generationLinked = true;
        candidate.controller.signal.addEventListener("abort", () => candidate.generationController?.abort(reason()), { once: true });
      }
      return candidate.generationController;
    }

    function generationSignal(candidate) {
      return (candidate.generationController || candidate.controller).signal;
    }

    function segmentDownload(candidate, track, segment, index, downloadOptions = {}) {
      // Read again at every check of the downloader: a new playback rate, or the playhead
      // standing still during a stall, moves the deadline of pieces already on their way.
      const deadlineAt = Number.isFinite(Number(downloadOptions.deadlineAt))
        ? Number(downloadOptions.deadlineAt)
        : () => playbackDeadlineAt(segment.startTime, Number(video.currentTime) || candidate.startTime, video.playbackRate);
      return downloader.downloadRange(segment, track.resolver, {
        signal: generationSignal(candidate),
        parallel: true,
        kind: track.kind,
        priority: downloadOptions.priority,
        hurry: downloadOptions.hurry === true,
        deadlineAt,
        startup: downloadOptions.startup === true,
        onStartupScheduled: downloadOptions.onStartupScheduled,
        onOrderedChunk: downloadOptions.onOrderedChunk || null
      }).then(
        (result) => ({ index, result }),
        (error) => ({ error, index })
      );
    }

    // Measured once, when the first segments are in. It used to be measured again on every
    // check with the same bytes over a longer time, so the longer the player waited for its
    // target, the slower the network looked and the further the target moved away.
    function updateStartupProfile(candidate) {
      if (candidate.startupProfiled) return candidate.startupTargetSeconds;
      candidate.startupProfiled = candidate.tracks.length > 0 && candidate.tracks.every((track) => track.startupComplete);
      const elapsedSeconds = Math.max(0.25, (performance.now() - candidate.startupStartedAt) / 1000);
      const throughput = candidate.startupCompletedBytes / elapsedSeconds;
      const required = candidate.tracks.reduce((sum, track) => sum + mediaBytesPerSecond(track), 0);
      const ratio = required > 0 ? throughput / required : 0;
      let target = ratio >= 3 ? STARTUP_BUFFER_MIN_SECONDS : ratio >= 1.8 ? 4 : ratio >= 1.25 ? 6 : ratio > 0 ? 8 : 6;
      if ((Number(selectedVideo?.height) || 0) >= 2160 && ratio < 1.8) target = Math.max(target, 8);
      candidate.startupThroughputBps = throughput;
      candidate.mediaBytesPerSecond = required;
      candidate.startupTargetSeconds = Math.max(STARTUP_BUFFER_MIN_SECONDS, Math.min(STARTUP_BUFFER_MAX_SECONDS, target));
      return candidate.startupTargetSeconds;
    }

    function maybeStartStartupPrefetch(candidate) {
      if (candidate.startupPrefetchLaunched || !sessionIsCurrent(candidate) || !candidate.tracks.length) return;
      if (!candidate.tracks.every((track) => track.startupScheduled)) return;
      candidate.startupPrefetchLaunched = true;
      for (const track of candidate.tracks) {
        const index = track.startupIndex + 1;
        track.followupScheduled = true;
        const segment = track.sidx.segments[index];
        if (segment) track.prefetches.set(index, segmentDownload(candidate, track, segment, index, {
          priority: 70,
          hurry: true
        }));
      }
      ensureBuffer(candidate);
    }

    // How far ahead this session may buffer: the setting, brought down each time the
    // browser's own buffer quota was hit.
    function aheadTarget(candidate) {
      return Math.min(core.normalizeSettings(getSettings()).bufferAheadSeconds, candidate.bufferAheadLimit || Infinity);
    }

    // The buffer a start or a recovery waits for must be one the tracks can still reach: with
    // the limit brought down to eight seconds, waiting for ten would never end.
    function reachableSeconds(candidate, seconds) {
      return Math.min(seconds, Math.max(0.5, aheadTarget(candidate) - 2));
    }

    async function fillTrack(candidate, track) {
      // The lock carries its generation: a loop cancelled by a seek must not unlock the loop
      // that replaced it, which would leave two loops downloading the same segments.
      if (track.filling === candidate.generation || track.complete || !sessionIsCurrent(candidate) || candidate.fatal) return;
      const generation = candidate.generation;
      track.filling = generation;
      const signal = generationSignal(candidate);
      try {
        while (sessionIsCurrent(candidate) && generation === candidate.generation && !signal.aborted) {
          const current = Number(video.currentTime) || candidate.startTime;
          if (track.nextIndex >= track.sidx.segments.length) {
            track.complete = true;
            break;
          }
          if (bufferedEndAt(track.sourceBuffer, current) - current >= aheadTarget(candidate)) break;
          // A sliding window: the next segment starts as soon as one has been appended. Waiting
          // for a whole batch left the connections idle until its slowest segment arrived.
          const windowSize = track.started ? (track.kind === "video" ? 3 : 4) : 1;
          let projectedEnd = bufferedEndAt(track.sourceBuffer, current);
          for (let offset = 0; offset < windowSize; offset += 1) {
            const index = track.nextIndex + offset;
            const segment = track.sidx.segments[index];
            if (!segment || projectedEnd - current >= aheadTarget(candidate)) break;
            projectedEnd = segment.endTime;
            if (track.prefetches.has(index) || track.held?.index === index) continue;
            const startup = !track.startupComplete && index === track.startupIndex;
            track.prefetches.set(index, segmentDownload(candidate, track, segment, index, {
              priority: startup ? 120 : Math.max(30, 55 - offset * 5),
              // With under ten seconds buffered a late segment is a stall, so the downloader
              // spreads its pieces and copies a slow one sooner.
              hurry: segment.startTime - current < 10,
              startup,
              onStartupScheduled: startup ? () => {
                track.startupScheduled = true;
                maybeStartStartupPrefetch(candidate);
              } : null,
              // The first segment is written piece by piece as it arrives. A full buffer here,
              // with next to nothing buffered yet, ends the download and the takeover as it
              // always did; only whole segments further on are kept and written later.
              onOrderedChunk: startup ? async (bytes) => {
                if (!sessionIsCurrent(candidate) || generation !== candidate.generation || signal.aborted) return;
                candidate.progressiveAppends += 1;
                await append(candidate, track, bytes, generation);
                ensureBuffer(candidate);
              } : null
            }));
          }
          // A segment the buffer had no room for comes first. The check at the top of this
          // loop let it through, so playback has used up a quarter of what was buffered since.
          const pending = track.held ? null : track.prefetches.get(track.nextIndex);
          if (!track.held && !pending) break;
          const settled = track.held || await pending;
          if (!track.held) track.prefetches.delete(settled.index);
          if (settled.error) throw settled.error;
          if (!sessionIsCurrent(candidate) || generation !== candidate.generation || signal.aborted) break;
          if (!settled.result.streamed) {
            try {
              await append(candidate, track, settled.result.bytes, generation);
              if (!sessionIsCurrent(candidate) || generation !== candidate.generation || signal.aborted) break;
              track.held = null;
            } catch (error) {
              // With this little buffered there is nothing left to give up, and waiting
              // would only stall the video: that stays a failure, as it always was.
              if (!sessionIsCurrent(candidate) || generation !== candidate.generation || signal.aborted) break;
              if (!error?.bufferFull || error.aheadSeconds < QUOTA_FATAL_AHEAD_SECONDS) throw error;
              candidate.quotaWaits += 1;
              if (candidate.quotaWaits > QUOTA_MAX_WAITS) throw error;
              track.held = settled;
              break;
            }
          }
          if (!sessionIsCurrent(candidate) || generation !== candidate.generation || signal.aborted) break;
          if (!track.startupComplete && settled.index === track.startupIndex) {
            note("first segment in", `${track.kind} ${Math.round(settled.result.byteLength / 1024)} KiB in ${settled.result.pieceCount} pieces`);
            track.startupComplete = true;
            candidate.startupCompletedBytes += settled.result.byteLength;
            updateStartupProfile(candidate);
          }
          track.nextIndex = settled.index + 1;
          track.started = true;
          options.onSegment?.({ kind: track.kind, bytes: settled.result.byteLength, pieces: settled.result.pieceCount, hosts: settled.result.hosts });
          ensureBuffer(candidate);
        }
      } catch (error) {
        if (!signal.aborted && sessionIsCurrent(candidate)) fatal(candidate, error);
      } finally {
        if (track.filling === generation) track.filling = 0;
        maybeEndStream(candidate);
      }
    }

    function maybeEndStream(candidate = session) {
      if (!candidate || !sessionIsCurrent(candidate) || candidate.fatal || candidate.streamEnded || candidate.ending) return;
      if (!candidate.tracks.length || !candidate.tracks.every((track) => track.complete)) return;
      candidate.ending = true;
      const generation = candidate.generation;
      // A seek inside the session opens a new generation whose tracks are not complete: an
      // end prepared by the old one is dropped.
      const stillWanted = () => generation === candidate.generation && candidate.tracks.every((track) => track.complete);
      Promise.all(candidate.tracks.map((track) => track.operation.catch(() => {}))).then(() => {
        if (!stillWanted()) return;
        if (!sessionIsCurrent(candidate) || candidate.fatal || candidate.streamEnded || candidate.mediaSource.readyState !== "open") return;
        if (candidate.tracks.some((track) => track.sourceBuffer.updating)) {
          candidate.ending = false;
          candidate.endRetryTimer = setTimeout(() => maybeEndStream(candidate), 50);
          return;
        }
        // endOfStream() itself trims the duration to the end of the buffered media. Setting a
        // shorter duration from the SIDX first is refused once coded frames run past it (HEVC
        // frames often end a few milliseconds after the SIDX total), which kept the stream open
        // and left the player buffering at the end forever.
        candidate.mediaSource.endOfStream();
        candidate.streamEnded = true;
        publishState();
      }).catch((error) => {
        if (!stillWanted()) return;
        candidate.ending = false;
        if (sessionIsCurrent(candidate) && error?.name !== "InvalidStateError") fatal(candidate, error);
        else if (sessionIsCurrent(candidate)) {
          // A buffer that just started updating is retried. Say so if it keeps failing.
          candidate.endAttempts = (candidate.endAttempts || 0) + 1;
          if (candidate.endAttempts === 40) options.onLog?.("视频结尾没能正常收尾", `结束媒体流一直失败，播放器可能停在结尾。\n原因：${String(error?.message || error).slice(0, 160)}`, "error", "playback");
          candidate.endRetryTimer = setTimeout(() => maybeEndStream(candidate), 50);
        }
      });
    }

    function setCurrentTimeInternal(candidate, target) {
      candidate.internalSeekTarget = Number(target) || 0;
      try { video.currentTime = target; }
      catch (_error) { candidate.internalSeekTarget = null; }
      setTimeout(() => {
        if (sessionIsCurrent(candidate) && candidate.internalSeekTarget === (Number(target) || 0)) candidate.internalSeekTarget = null;
      }, 300);
    }

    // Bilibili's own player core downloads nothing while BTR plays, so it may report errors
    // about that. The stylesheet hides its error panels only while BTR is active; what they
    // said goes to the Debug log instead of being lost.
    let reportedNativeError = "";
    function clearNativeErrorOverlay() {
      for (const node of options.container.querySelectorAll(".bpx-player-error-wrap,.bpx-player-error-panel")) {
        const text = String(node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
        if (!text || text === reportedNativeError) continue;
        reportedNativeError = text;
        options.onLog?.("B 站原生播放器报错", `线程撕裂者接管时，B 站自己的播放内核不再下载视频，这类报错通常可以忽略。\n原文：${text}`, "info", "playback");
      }
    }

    function attemptAutoplay(candidate) {
      if (candidate.playAttempted || !candidate.resumeWanted || !sessionIsCurrent(candidate)) return;
      candidate.playAttempted = true;
      video.play().then(clearNativeErrorOverlay).catch(() => {});
    }

    function activateWhenReady(candidate) {
      if (candidate.playbackActivated || !sessionIsCurrent(candidate) || !candidate.tracks.length) return;
      if (!candidate.tracks.every((track) => track.startupComplete && track.followupScheduled)) return;
      // Bilibili may call video.play() as soon as the first appended ranges are
      // decodable, before our larger startup buffer is complete. Treat that
      // visible progress as the new handoff point: activation may seek forward
      // to the captured start time, but must never rewind frames already shown.
      const liveTime = Math.max(0, Number(video.currentTime) || 0);
      const target = Math.max(candidate.startTime, liveTime);
      candidate.startTime = target;
      if (!candidate.tracks.every((track) => isBufferedAt(track.sourceBuffer, target))) return;
      const ends = candidate.tracks.map((track) => bufferedEndAt(track.sourceBuffer, target));
      const required = reachableSeconds(candidate, updateStartupProfile(candidate));
      const remaining = Math.max(0.5, (Number(candidate.mediaSource.duration) || target + required) - target);
      if (Math.min(...ends) - target < Math.max(0.5, Math.min(required, remaining))) return;
      candidate.playbackActivated = true;
      note("ready to play", `needed ${required.toFixed(1)} s buffered`);
      if (seekStartedAt) {
        lastSeekMs = performance.now() - seekStartedAt;
        seekStartedAt = 0;
        seekSettledAt = performance.now();
        stallsAfterSeek = 0;
        options.onLog?.("跳转后的数据准备好了", `从点击进度条到可以继续播放用了 ${Math.round(lastSeekMs)} 毫秒。`, "success", "buffer");
      }
      options.onLog?.("开播需要的缓冲已经够了", `从 ${target.toFixed(2)} 秒开始播放，这次需要先缓冲 ${required.toFixed(1)} 秒。`, "success", "buffer");
      candidate.playbackActivatedAt = performance.now();
      if (target - (Number(video.currentTime) || 0) > 0.05) setCurrentTimeInternal(candidate, target);
      video.volume = candidate.volume;
      video.muted = candidate.muted;
      video.playbackRate = candidate.playbackRate;
      clearNativeErrorOverlay();
      attemptAutoplay(candidate);
    }

    function ensureBuffer(candidate = session) {
      if (!candidate || !sessionIsCurrent(candidate) || candidate.fatal || !candidate.tracks.length) return;
      for (const track of candidate.tracks) fillTrack(candidate, track);
      activateWhenReady(candidate);
      const current = Number(video.currentTime) || candidate.startTime;
      const ready = candidate.tracks.every((track) => isBufferedAt(track.sourceBuffer, current));
      const ahead = ready ? Math.max(0, Math.min(...candidate.tracks.map((track) => bufferedEndAt(track.sourceBuffer, current))) - current) : 0;
      if (candidate.recovering && ready) {
        const remaining = Math.max(0.5, (Number(candidate.mediaSource.duration) || current + candidate.recoveryTargetSeconds) - current);
        if (ahead >= Math.min(reachableSeconds(candidate, candidate.recoveryTargetSeconds), remaining)) {
          candidate.recovering = false;
          // A seek inside the session waits here instead of in activateWhenReady, so this is
          // where the panel's "how long did the jump take" is measured.
          if (candidate.seekPending) {
            candidate.seekPending = false;
            if (seekStartedAt) {
              lastSeekMs = performance.now() - seekStartedAt;
              seekStartedAt = 0;
              seekSettledAt = performance.now();
              stallsAfterSeek = 0;
              options.onLog?.("跳转后的数据准备好了", `从点击进度条到可以继续播放用了 ${Math.round(lastSeekMs)} 毫秒。`, "success", "buffer");
            }
          }
          options.onLog?.("缓冲补好了，可以继续播放", `已经备好接下来 ${ahead.toFixed(1)} 秒的数据。`, "success", "buffer");
          candidate.playAttempted = false;
          attemptAutoplay(candidate);
        }
      }
      publishState();
    }

    function prune(candidate = session) {
      if (!candidate || !sessionIsCurrent(candidate) || candidate.fatal || video.currentTime < 75) return;
      const end = video.currentTime - 30;
      for (const track of candidate.tracks) {
        // A removal waits in the same queue as the appends. Asking for one on every tick put a
        // buffer operation there every 750 ms, so it waits until ten seconds can go at once.
        if (end - bufferedStart(track.sourceBuffer, end) < 10) continue;
        removeRange(candidate, track, 0, end).catch(() => {});
      }
    }

    function disposeSession(candidate, detach = true) {
      if (!candidate || candidate.disposed) return;
      candidate.disposed = true;
      candidate.generation = ++generationSequence;
      candidate.controller.abort(new DOMException("播放任务已取消", "AbortError"));
      clearInterval(candidate.timer);
      clearTimeout(candidate.endRetryTimer);
      if (detach && video.src === candidate.objectUrl) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      URL.revokeObjectURL(candidate.objectUrl);
    }

    function fatal(candidate, error) {
      if (!sessionIsCurrent(candidate) || candidate.fatal || error?.name === "AbortError") return;
      candidate.fatal = true;
      candidate.controller.abort(new DOMException("播放内核发生错误", "AbortError"));
      const message = String(error?.message || error).slice(0, 160);
      publishState({ playerState: "error", lastError: message });
      options.onFatal?.(error);
    }

    async function startSession(representation, playbackState) {

      downloaderFactory.autoConcurrency?.newSession();
      if (destroyed) return;
      const request = ++sessionRequests;
      const settling = nativeSourceSettled(video);
      if (settling) {
        const waitedFrom = performance.now();
        await settling;
        note("waited for Bilibili's source buffers", `${Math.round(performance.now() - waitedFrom)} ms`);
        // A later start replaced this one meanwhile.
        if (destroyed || request !== sessionRequests) return;
      }
      options.onLog?.("正在准备播放器", `使用 ${qualityLabel(representation)} 清晰度，从 ${Number(playbackState.time || 0).toFixed(2)} 秒开始。`, "info", "takeover");
      const previous = session;
      // Read once: selection can be replaced by a new playinfo while this session starts.
      const audio = selection.audio;
      selectedVideo = representation;
      selectedAudio = audio;
      sessionStarts += 1;
      note("session", `${qualityLabel(representation)} ${codecFamily(representation)} from ${Number(playbackState.time || 0).toFixed(1)}`);
      const mediaSource = new MediaSource();
      ownMediaSources.add(mediaSource);
      const objectUrl = URL.createObjectURL(mediaSource);
      const candidate = {
        disposed: false, fatal: false, externalSourceDetected: false, generation: 0,
        generationController: null, generationLinked: false, seekPending: false,
        controller: new AbortController(), mediaSource, objectUrl,
        timer: null, endRetryTimer: null, tracks: [], ending: false, streamEnded: false,
        playAttempted: false, playbackActivated: false, playbackActivatedAt: 0,
        recovering: false, recoveryTargetSeconds: STARTUP_RECOVERY_SECONDS, bufferAheadLimit: 0, quotaWaits: 0,
        startupCompletedBytes: 0, startupPrefetchLaunched: false, startupStartedAt: performance.now(),
        progressiveAppends: 0,
        startupTargetSeconds: 6, startupThroughputBps: 0, mediaBytesPerSecond: 0,
        startupWaitingEvents: 0, resumeWanted: playbackState.resume,
        volume: playbackState.volume, muted: playbackState.muted, playbackRate: playbackState.playbackRate,
        startTime: Math.max(0, Number(playbackState.time) || 0),
        forceStartTime: Boolean(playbackState.forceTime),
        internalSeekTarget: null, metadataAt: 0, restoreUndoneAt: 0,
        // One ban list per video, shared by every quality and by the audio track.
        videoResolver: resolverFactory.createResolver(representation, () => core.normalizeSettings(getSettings()).mode, options.cdnBans, () => core.normalizeSettings(getSettings()).customHosts),
        audioResolver: resolverFactory.createResolver(audio, () => core.normalizeSettings(getSettings()).mode, options.cdnBans, () => core.normalizeSettings(getSettings()).customHosts)
      };
      openGeneration(candidate);
      session = candidate;
      if (previous) disposeSession(previous, false);
      video.pause();
      video.src = objectUrl;
      video.load();
      video.volume = candidate.volume;
      video.muted = candidate.muted;
      video.playbackRate = candidate.playbackRate;
      video.dataset.btrMediaEngine = "progressive-mse-0.8-core";
      options.container.dataset.btrMseActive = "true";
      publishState({ playerState: "loading", quality: qualityLabel(selectedVideo), lastError: "" });
      try {
        if (mediaSource.readyState !== "open") await waitEvent(mediaSource, "sourceopen", "error", candidate.controller.signal);
        if (!sessionIsCurrent(candidate)) return;
        const videoBuffer = mediaSource.addSourceBuffer(mimeFor(representation, "video"));
        const audioBuffer = mediaSource.addSourceBuffer(mimeFor(audio, "audio"));
        ownSourceBuffers.add(videoBuffer);
        ownSourceBuffers.add(audioBuffer);
        const [videoTrack, audioTrack] = await Promise.all([
          loadTrack(candidate, "video", representation, candidate.videoResolver, videoBuffer, candidate.startTime),
          loadTrack(candidate, "audio", audio, candidate.audioResolver, audioBuffer, candidate.startTime)
        ]);
        if (!sessionIsCurrent(candidate)) return;
        candidate.tracks = [videoTrack, audioTrack];
        // A seek made while this session was starting only moves the element's start
        // position and fires no "seeking" event. Only the indexes are loaded so far, so the
        // tracks can simply start from there.
        const requested = Number(video.currentTime) || 0;
        if (!candidate.forceStartTime && requested > 0 && Math.abs(requested - candidate.startTime) > 0.5) {
          candidate.startTime = requested;
          for (const track of candidate.tracks) track.startupIndex = track.nextIndex = sidxTools.segmentIndexAt(track.sidx.segments, requested);
        }
        const duration = Math.max(
          Number(selection.dash.duration) || 0,
          videoTrack.sidx.segments.at(-1)?.endTime || 0,
          audioTrack.sidx.segments.at(-1)?.endTime || 0
        );
        if (duration > 0) mediaSource.duration = duration;
        if ((candidate.forceStartTime || candidate.startTime > 0) && Number.isFinite(mediaSource.duration)) {
          setCurrentTimeInternal(candidate, Math.min(candidate.startTime, Math.max(0, mediaSource.duration - 0.1)));
        }
        candidate.startupStartedAt = performance.now();
        candidate.timer = setInterval(() => { ensureBuffer(candidate); prune(candidate); }, 750);
        ensureBuffer(candidate);
      } catch (error) {
        if (sessionIsCurrent(candidate)) fatal(candidate, error);
      }
    }

    // Seeking inside the running session: the tracks move to the target's segment and the
    // element keeps its MediaSource. Rebuilding the session for every seek reset the element
    // to zero first (video.src + load()) and only then restored the position, so anything
    // else watching the same element — Bilibili's own core, another user script — could catch
    // it at zero and put its own position back. Nothing writes currentTime here at all.
    async function seekWithinSession(candidate, target) {
      const previousGeneration = candidate.generationController;
      openGeneration(candidate);
      // 自动线程数 judges the buffer ahead of the playhead: the new position starts that watch afresh.
      downloaderFactory.autoConcurrency?.newSession();
      // The segments of the position left behind are no longer wanted.
      previousGeneration?.abort(new DOMException("已经跳到新的位置", "AbortError"));
      candidate.startTime = target;
      candidate.streamEnded = false;
      candidate.ending = false;
      clearTimeout(candidate.endRetryTimer);
      candidate.quotaWaits = 0;
      for (const track of candidate.tracks) {
        // Queued, so it runs after whatever write is in progress and before the new
        // position's first one: the parser forgets any half-written segment.
        queuedSourceOperation(candidate, track, async () => {
          if (candidate.mediaSource.readyState === "open") track.sourceBuffer.abort();
        }).catch(() => {});
        track.prefetches.clear();
        track.held = null;
        track.complete = false;
        track.started = false;
        track.nextIndex = track.startupIndex = sidxTools.segmentIndexAt(track.sidx.segments, target);
      }
      // Media buffered far from the target only takes room the new position needs.
      const duration = Number(candidate.mediaSource.duration);
      if (Number.isFinite(duration)) {
        for (const track of candidate.tracks) {
          removeRange(candidate, track, 0, Math.max(0, target - 5)).catch(() => {});
          removeRange(candidate, track, target + aheadTarget(candidate) + 30, duration).catch(() => {});
        }
      }
      candidate.resumeWanted = wantsToPlay();
      // Once playing, the wait for the new position is the same wait as a rebuffer.
      if (candidate.playbackActivated) {
        candidate.recovering = true;
        candidate.recoveryTargetSeconds = Math.max(STARTUP_RECOVERY_SECONDS, candidate.startupTargetSeconds);
        candidate.playAttempted = false;
        candidate.seekPending = true;
        video.pause();
      }
      ensureBuffer(candidate);
      publishState();
    }

    async function seek() {
      const candidate = session;
      if (!candidate || !sessionIsCurrent(candidate) || !candidate.tracks.length) return;
      const target = Number(video.currentTime) || 0;
      if (candidate.internalSeekTarget !== null && Math.abs(target - candidate.internalSeekTarget) < 0.25) {
        candidate.internalSeekTarget = null;
        return;
      }
      if (candidate.tracks.every((track) => isBufferedAt(track.sourceBuffer, target))) {
        options.onLog?.("你跳到的位置已经有缓冲", `可以直接从 ${target.toFixed(2)} 秒继续播放。`, "success", "buffer");
        ensureBuffer(candidate);
        return;
      }
      seekReloads += 1;
      seekStartedAt = seekRequestedAt || performance.now();
      note("seek outside the buffer", target.toFixed(1));
      options.onLog?.("你跳到的位置还需要加载", `正在为 ${target.toFixed(2)} 秒的位置重新准备数据。`, "info", "buffer");
      // A video sent back to its start right after it ended is the player's 单集循环 or its
      // replay button, which mean to play it again. The video is paused at that moment, so
      // without this the next round would stop at the first frame (issue #17); that case keeps
      // the full restart, which owns the intent to play again.
      const restarting = target < 1 && (video.ended || performance.now() - endedAt < 2000);
      if (!restarting && candidate.mediaSource.readyState !== "closed") {
        await seekWithinSession(candidate, target);
        return;
      }
      await startSession(selectedVideo, {
        time: target,
        resume: wantsToPlay() || restarting,
        volume: video.volume,
        muted: video.muted,
        playbackRate: video.playbackRate
      });
    }

    function scheduleSeek() {
      const candidate = session;
      const target = Number(video.currentTime) || 0;
      if (candidate && sessionIsCurrent(candidate) && !candidate.playbackActivated && candidate.metadataAt
        && performance.now() - candidate.metadataAt < 250 && candidate.restoreUndoneAt !== candidate.metadataAt
        && nativeRestore.time && Math.abs(target - nativeRestore.time) < 1 && Math.abs(target - candidate.startTime) >= 0.5) {
        // The core restores once per metadata; a second seek to that position is the viewer's.
        candidate.restoreUndoneAt = candidate.metadataAt;
        nativeRestoresUndone += 1;
        note("native restore undone", `${target.toFixed(1)} -> ${candidate.startTime.toFixed(1)}`);
        options.onLog?.("挡住了 B 站播放器的回跳", `B 站的播放内核想跳回 ${target.toFixed(1)} 秒，保持在你选的 ${candidate.startTime.toFixed(1)} 秒。`, "info", "buffer");
        setCurrentTimeInternal(candidate, candidate.startTime);
        // Its restore also plays or pauses as things were back then; the viewer's intent wins.
        if (!candidate.resumeWanted && !video.paused) video.pause();
        return;
      }
      seekRequestedAt = performance.now();
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => {
        seekTimer = null;
        seek().catch((error) => { if (session && sessionIsCurrent(session)) fatal(session, error); });
      }, 140);
    }

    video.addEventListener("loadedmetadata", () => { if (session) session.metadataAt = performance.now(); }, { signal: eventController.signal });
    video.addEventListener("seeking", scheduleSeek, { signal: eventController.signal });
    video.addEventListener("timeupdate", () => {
      ensureBuffer();
      // 自动线程数 watches the buffer ahead of the playhead while playing.
      const candidate = session;
      if (candidate && sessionIsCurrent(candidate) && candidate.playbackActivated && candidate.tracks.length && core.normalizeSettings(getSettings()).autoConcurrency) {
        const current = Number(video.currentTime) || 0;
        const ahead = Math.max(0, Math.min(...candidate.tracks.map((track) => bufferedEndAt(track.sourceBuffer, current))) - current);
        downloaderFactory.autoConcurrency?.buffer(ahead, !video.paused && !video.seeking);
      }
    }, { signal: eventController.signal });
    video.addEventListener("waiting", () => {
      const candidate = session;
      note("waiting", candidate?.playbackActivated ? "after start" : "before start");
      if (candidate && sessionIsCurrent(candidate) && candidate.playbackActivated) {
        candidate.startupWaitingEvents += 1;
        if (!video.seeking && !video.paused && core.normalizeSettings(getSettings()).autoConcurrency) downloaderFactory.autoConcurrency?.stall("播放卡了一下");
        if (seekSettledAt && performance.now() - seekSettledAt < 15000 && !video.seeking) stallsAfterSeek += 1;
        if (performance.now() - candidate.playbackActivatedAt <= STARTUP_PROTECTION_MS && !candidate.recovering && !video.seeking) {
          candidate.recovering = true;
          candidate.resumeWanted = true;
          candidate.playAttempted = false;
          candidate.recoveryTargetSeconds = Math.min(STARTUP_BUFFER_MAX_SECONDS, Math.max(STARTUP_RECOVERY_SECONDS, candidate.startupTargetSeconds + 2));
          video.pause();
        }
        ensureBuffer(candidate);
      }
    }, { signal: eventController.signal });
    video.addEventListener("playing", clearNativeErrorOverlay, { signal: eventController.signal });
    video.addEventListener("playing", () => note("playing"), { signal: eventController.signal });
    video.addEventListener("ended", () => {
      endedAt = performance.now();
      publishState({ playerState: "ended", bufferedAhead: 0 });
    }, { signal: eventController.signal });

    // Whether the viewer means the video to play. While a session is still loading, or while
    // we paused it ourselves to rebuffer, the element is paused whatever the viewer wants and
    // the session remembers the intent. Reading video.paused then made a second drag of the
    // progress bar, or a quality change during loading, leave the video paused for good.
    function wantsToPlay() {
      const candidate = session;
      if (candidate && sessionIsCurrent(candidate) && (!candidate.playbackActivated || candidate.recovering)) return Boolean(candidate.resumeWanted);
      return !video.paused;
    }

    function playbackState() {
      return {
        time: Number(video.currentTime) || 0,
        resume: wantsToPlay() || Number(video.currentTime) < 1,
        volume: video.volume,
        muted: video.muted,
        playbackRate: video.playbackRate || 1
      };
    }

    // A refreshed playinfo names the same files with fresh signatures. The resolvers of a
    // running session keep reading their representation objects, so those objects receive
    // the new addresses; nothing else about the session changes.
    function deadlineOf(representation) {
      try { return Number(new URL(representationUrl(representation)).searchParams.get("deadline")) || 0; }
      catch (_error) { return 0; }
    }

    // Whether a playinfo names, for any file already known, an address that expires sooner.
    function namesOlderAddresses(playinfo) {
      const listed = (item) => {
        const dash = dashBody(item)?.dash;
        return [...(dash?.video || []), ...(dash?.audio || []), ...[].concat(dash?.dolby?.audio || [], dash?.flac?.audio || [])];
      };
      const known = [...listed(currentPlayinfo), selectedVideo, selectedAudio].filter(Boolean);
      return listed(playinfo).some((item) => {
        const deadline = deadlineOf(item);
        return deadline > 0 && known.some((other) => sameRepresentation(other, item) && deadline < deadlineOf(other));
      });
    }

    function refreshRepresentationUrls(target, source) {
      if (!target || !source || target === source) return;
      // Bilibili's page and the timed refresh both bring addresses, and the answer that
      // arrives last is not always the newer one.
      if (deadlineOf(source) < deadlineOf(target)) return;
      for (const key of ["baseUrl", "base_url", "backupUrl", "backup_url", "backup_url_list"]) {
        if (source[key] !== undefined) target[key] = source[key];
      }
    }

    // When the earliest signed address of the playing tracks expires, in seconds since the
    // epoch. 0 when no address carries a deadline.
    function urlDeadlineSeconds() {
      let earliest = 0;
      for (const representation of [selectedVideo, selectedAudio]) {
        const deadline = deadlineOf(representation);
        if (deadline > 0 && (!earliest || deadline < earliest)) earliest = deadline;
      }
      return earliest;
    }

    async function updatePlayinfo(playinfo) {
      if (destroyed) return;
      const next = selectRepresentations(playinfo, preferredQuality, preferredCodec, preferredAudio);
      // Bilibili's page and the timed refresh both bring playinfos, and the one that arrives
      // last is not always the newer one. An older one is dropped whole: kept as the current
      // playinfo it would hand its addresses to the next session, after a seek or a quality
      // change, although the running session was protected from them. Every file the two
      // name in common counts, not only the quality that is playing.
      if (playinfo !== currentPlayinfo && namesOlderAddresses(playinfo)) return;
      currentPlayinfo = playinfo;
      const nextVideo = next.preferred;
      const audioChanged = !sameRepresentation(selectedAudio, next.audio);
      selection = next;
      if (!audioChanged && sameRepresentation(selectedVideo, nextVideo)) {
        refreshRepresentationUrls(selectedVideo, nextVideo);
        refreshRepresentationUrls(selectedAudio, next.audio);
        return;
      }
      await startSession(nextVideo, playbackState());
    }

    // The native quality menu switches between qualities already in the playinfo without
    // asking for a new one, so the page tells us what was chosen. Choosing the quality that
    // is already playing does not restart anything.
    async function setQuality(quality) {
      const wanted = Math.max(0, Math.trunc(Number(quality)) || 0);
      if (destroyed || wanted === preferredQuality) return;
      preferredQuality = wanted;
      await updatePlayinfo(currentPlayinfo);
    }

    // The same for the codec picked in the 播放策略 menu.
    async function setCodec(codec) {
      const wanted = normalizeCodec(codec);
      if (destroyed || wanted === preferredCodec) return;
      preferredCodec = wanted;
      await updatePlayinfo(currentPlayinfo);
    }

    function destroy({ resumeNative = true } = {}) {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(seekTimer);
      eventController.abort();
      sourceObserver.disconnect();
      const state = playbackState();
      if (session) disposeSession(session, true);
      delete video.dataset.btrMediaEngine;
      delete options.container.dataset.btrMseActive;
      if (resumeNative && original.src) {
        // Bilibili's core reloads from here and remembers this position (see nativeRestore).
        rememberNativeRestore(restoreKey, state.time || original.currentTime);
        video.src = original.src;
        video.volume = original.volume;
        video.muted = original.muted;
        video.playbackRate = original.playbackRate;
        video.load();
        try { video.currentTime = state.time || original.currentTime; } catch (_error) {}
        if (!state.resume && original.wasPaused) return;
        video.play().catch(() => {});
      } else if (resumeNative && original.srcAttribute !== null) {
        video.setAttribute("src", original.srcAttribute);
        video.load();
      }
    }

    if (!document.getElementById("__btr_native_mse_style__")) {
      const style = document.createElement("style");
      style.id = "__btr_native_mse_style__";
      style.textContent = `
        [data-btr-mse-active="true"] .bpx-player-error-wrap,
        [data-btr-mse-active="true"] .bpx-player-error-panel{display:none!important}
      `;
      (document.head || document.documentElement).append(style);
    }
    sourceObserver.observe(video, { attributes: true, attributeFilter: ["src"] });
    const hasInitialTime = options.initialTime !== undefined && Number.isFinite(Number(options.initialTime));
    const initialTime = hasInitialTime
      ? Math.max(0, Number(options.initialTime))
      : original.currentTime;
    // A video that has not started yet only starts by itself when the player's "自动开播" is on
    // (issue #13); the page passes that setting as options.autoplay.
    const initialResume = options.initialResume !== undefined
      ? Boolean(options.initialResume)
      : !original.wasPaused || (original.currentTime < 1 && options.autoplay !== false);
    startSession(selectedVideo, {
      // The native player may already have rendered its first frames before the
      // accelerated MediaSource is ready. Preserve that exact position: forcing
      // every handoff below two seconds back to zero produces a visible replay.
      time: initialTime,
      forceTime: hasInitialTime,
      resume: initialResume,
      volume: original.volume,
      muted: original.muted,
      playbackRate: original.playbackRate || 1
    }).catch((error) => { if (session) fatal(session, error); });

    return Object.freeze({
      applySettings() { ensureBuffer(); },
      wantsToPlay,
      destroy,
      setCodec,
      setQuality,
      updatePlayinfo,
      urlDeadlineSeconds,
      video,
      getDebug: () => ({
        version: "__BTR_VERSION__",
        architecture: "bilibili-native-ui-progressive-mse-0.8-core",
        quality: qualityLabel(selectedVideo),
        qualityId: Number(selectedVideo?.id) || 0,
        preferredQuality,
        preferredCodec,
        preferredAudio,
        codecFailuresBlocked: codecFailures.blocked,
        sessionStarts,
        codec: codecFamily(selectedVideo),
        width: Number(selectedVideo?.width) || 0,
        height: Number(selectedVideo?.height) || 0,
        frameRate: frameRate(selectedVideo),
        videoType: mimeFor(selectedVideo, "video"),
        audioType: mimeFor(selection.audio, "audio"),
        videoBandwidth: Number(selectedVideo?.bandwidth) || 0,
        audioBandwidth: Number(selection.audio?.bandwidth) || 0,
        currentTime: Number(video.currentTime) || 0,
        mediaSourceState: session?.mediaSource?.readyState || "closed",
        playbackActivated: Boolean(session?.playbackActivated),
        resumeWanted: Boolean(session?.resumeWanted),
        sessionStartTime: session?.startTime || 0,
        startupBufferSeconds: session?.startupTargetSeconds || 0,
        startupWaitingEvents: session?.startupWaitingEvents || 0,
        bufferAheadLimit: session?.bufferAheadLimit || 0,
        urlDeadline: urlDeadlineSeconds(),
        // Errors from Bilibili's idle core that were kept out of the page's console.
        nativeLeftoversSuppressed: nativeLeftovers.suppressed,
        lastNativeLeftover: nativeLeftovers.last,
        progressiveAppends: session?.progressiveAppends || 0,
        seekReloads,
        nativeRestoresUndone,
        lastSeekMs: Math.round(lastSeekMs),
        stallsAfterSeek,
        timeline: timeline.slice(),
        tracks: (session?.tracks || []).map((track) => ({ kind: track.kind, nextIndex: track.nextIndex, segments: track.sidx.segments.length }))
      })
    });
  }

  installBufferedShim();
  installNativeErrorGuard();
  installMediaSourceWatch();
  installCodecFailureGuard();
  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = Object.freeze({ createNativePlayer, playbackDeadlineAt, qualityLabel, selectRepresentations });
})(globalThis);
