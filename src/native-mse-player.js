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

  function codecPriority(representation) {
    return { av1: 3, hevc: 2, avc: 1, other: 0 }[codecFamily(representation)] || 0;
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
  // quality the playinfo itself asks for.
  function selectRepresentations(playinfo, preferredQuality = 0) {
    const body = dashBody(playinfo);
    const dash = body?.dash;
    if (!dash) throw new Error("页面没有 DASH 播放清单");
    const byQuality = new Map();
    for (const representation of (dash.video || []).filter((item) => supported(item, "video"))) {
      const key = Number(representation.id) || `${Number(representation.height) || 0}-${Math.round(frameRate(representation))}`;
      const existing = byQuality.get(key);
      if (!existing || codecPriority(representation) > codecPriority(existing) ||
          (codecPriority(representation) === codecPriority(existing) && (Number(representation.bandwidth) || 0) > (Number(existing.bandwidth) || 0))) {
        byQuality.set(key, representation);
      }
    }
    const videos = Array.from(byQuality.values()).sort((a, b) =>
      (Number(b.height) || 0) - (Number(a.height) || 0) || frameRate(b) - frameRate(a) ||
      (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0));
    const audio = (dash.audio || []).filter((item) => supported(item, "audio"))
      .sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0))[0];
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

  function sameRepresentation(left, right) {
    const path = (representation) => {
      try { return new URL(representationUrl(representation)).pathname; }
      catch (_error) { return representationUrl(representation); }
    };
    return Number(left?.id) === Number(right?.id)
      && codecFamily(left) === codecFamily(right)
      && path(left) === path(right);
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

  function createNativePlayer(options) {
    const getSettings = options.getSettings;
    const video = options.container.querySelector("video");
    if (!video) throw new Error("没有找到 B 站原生 video 元素");
    let currentPlayinfo = options.playinfo;
    let preferredQuality = Math.max(0, Math.trunc(Number(options.preferredQuality)) || 0);
    let selection = selectRepresentations(currentPlayinfo, preferredQuality);
    let selectedVideo = selection.preferred;
    let sessionStarts = 0;
    let session = null;
    let destroyed = false;
    let generationSequence = 0;
    let seekTimer = null;
    let seekReloads = 0;
    const eventController = new AbortController();
    const sourceObserver = new MutationObserver(() => {
      const candidate = session;
      if (destroyed || !candidate || candidate.disposed || video.src === candidate.objectUrl) return;
      if (candidate.externalSourceDetected) return;
      candidate.externalSourceDetected = true;
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
        track.sourceBuffer.appendBuffer(bytes);
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
      const ranges = segmentBase(representation);
      const [initialization, indexBytes] = await Promise.all([
        downloader.downloadRange(ranges.init, resolver, { signal: candidate.controller.signal, parallel: false, kind: "meta" }),
        downloader.downloadRange(ranges.index, resolver, { signal: candidate.controller.signal, parallel: false, kind: "meta" })
      ]);
      if (!sessionIsCurrent(candidate)) throw new DOMException("播放任务已取消", "AbortError");
      const sidx = sidxTools.parseSidx(indexBytes.bytes, ranges.index.start);
      if (!sidx?.segments?.length) throw new Error(`${kind === "video" ? "视频" : "音频"} SIDX 解析失败`);
      options.onLog?.("已经确认数据的下载位置", `找到了 ${sidx.segments.length} 段${kind === "audio" ? "声音" : "画面"}数据。`, "success", "download");
      const startupIndex = sidxTools.segmentIndexAt(sidx.segments, startTime);
      const track = {
        kind, representation, resolver, sourceBuffer, sidx,
        nextIndex: startupIndex,
        startupIndex,
        complete: false,
        filling: false,
        started: false,
        startupComplete: false,
        startupScheduled: false,
        followupScheduled: false,
        prefetches: new Map(),
        operation: Promise.resolve()
      };
      await append(candidate, track, initialization.bytes, candidate.generation);
      return track;
    }

    function segmentDownload(candidate, track, segment, index, downloadOptions = {}) {
      return downloader.downloadRange(segment, track.resolver, {
        signal: candidate.controller.signal,
        parallel: true,
        kind: track.kind,
        priority: downloadOptions.priority,
        startup: downloadOptions.startup === true,
        onStartupScheduled: downloadOptions.onStartupScheduled,
        onOrderedChunk: downloadOptions.onOrderedChunk || null
      }).then(
        (result) => ({ index, result }),
        (error) => ({ error, index })
      );
    }

    function updateStartupProfile(candidate) {
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
        if (segment) track.prefetches.set(index, segmentDownload(candidate, track, segment, index, { priority: 70 }));
      }
      ensureBuffer(candidate);
    }

    async function fillTrack(candidate, track) {
      if (track.filling || track.complete || !sessionIsCurrent(candidate) || candidate.fatal) return;
      track.filling = true;
      const generation = candidate.generation;
      const signal = candidate.controller.signal;
      try {
        while (sessionIsCurrent(candidate) && generation === candidate.generation && !signal.aborted) {
          const current = Number(video.currentTime) || candidate.startTime;
          if (track.nextIndex >= track.sidx.segments.length) {
            track.complete = true;
            break;
          }
          if (bufferedEndAt(track.sourceBuffer, current) - current >= core.normalizeSettings(getSettings()).bufferAheadSeconds) break;
          // A sliding window: the next segment starts as soon as one has been appended. Waiting
          // for a whole batch left the connections idle until its slowest segment arrived.
          const windowSize = track.started ? (track.kind === "video" ? 3 : 4) : 1;
          let projectedEnd = bufferedEndAt(track.sourceBuffer, current);
          for (let offset = 0; offset < windowSize; offset += 1) {
            const index = track.nextIndex + offset;
            const segment = track.sidx.segments[index];
            if (!segment || projectedEnd - current >= core.normalizeSettings(getSettings()).bufferAheadSeconds) break;
            projectedEnd = segment.endTime;
            if (track.prefetches.has(index)) continue;
            const startup = !track.startupComplete && index === track.startupIndex;
            track.prefetches.set(index, segmentDownload(candidate, track, segment, index, {
              priority: startup ? 120 : Math.max(30, 55 - offset * 5),
              startup,
              onStartupScheduled: startup ? () => {
                track.startupScheduled = true;
                maybeStartStartupPrefetch(candidate);
              } : null,
              onOrderedChunk: startup ? async (bytes) => {
                if (!sessionIsCurrent(candidate) || generation !== candidate.generation || signal.aborted) return;
                candidate.progressiveAppends += 1;
                await append(candidate, track, bytes, generation);
                ensureBuffer(candidate);
              } : null
            }));
          }
          const pending = track.prefetches.get(track.nextIndex);
          if (!pending) break;
          const settled = await pending;
          track.prefetches.delete(settled.index);
          if (settled.error) throw settled.error;
          if (!sessionIsCurrent(candidate) || generation !== candidate.generation || signal.aborted) break;
          if (!settled.result.streamed) await append(candidate, track, settled.result.bytes, generation);
          if (!track.startupComplete && settled.index === track.startupIndex) {
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
        track.filling = false;
        maybeEndStream(candidate);
      }
    }

    function maybeEndStream(candidate = session) {
      if (!candidate || !sessionIsCurrent(candidate) || candidate.fatal || candidate.streamEnded || candidate.ending) return;
      if (!candidate.tracks.length || !candidate.tracks.every((track) => track.complete)) return;
      candidate.ending = true;
      Promise.all(candidate.tracks.map((track) => track.operation.catch(() => {}))).then(() => {
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
      const required = updateStartupProfile(candidate);
      const remaining = Math.max(0.5, (Number(candidate.mediaSource.duration) || target + required) - target);
      if (Math.min(...ends) - target < Math.max(0.5, Math.min(required, remaining))) return;
      candidate.playbackActivated = true;
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
        if (ahead >= Math.min(candidate.recoveryTargetSeconds, remaining)) {
          candidate.recovering = false;
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
      if (destroyed) return;
      options.onLog?.("正在准备播放器", `使用 ${qualityLabel(representation)} 清晰度，从 ${Number(playbackState.time || 0).toFixed(2)} 秒开始。`, "info", "takeover");
      const previous = session;
      selectedVideo = representation;
      sessionStarts += 1;
      const mediaSource = new MediaSource();
      const objectUrl = URL.createObjectURL(mediaSource);
      const candidate = {
        disposed: false, fatal: false, externalSourceDetected: false, generation: ++generationSequence,
        controller: new AbortController(), mediaSource, objectUrl,
        timer: null, endRetryTimer: null, tracks: [], ending: false, streamEnded: false,
        playAttempted: false, playbackActivated: false, playbackActivatedAt: 0,
        recovering: false, recoveryTargetSeconds: STARTUP_RECOVERY_SECONDS,
        startupCompletedBytes: 0, startupPrefetchLaunched: false, startupStartedAt: performance.now(),
        progressiveAppends: 0,
        startupTargetSeconds: 6, startupThroughputBps: 0, mediaBytesPerSecond: 0,
        startupWaitingEvents: 0, resumeWanted: playbackState.resume,
        volume: playbackState.volume, muted: playbackState.muted, playbackRate: playbackState.playbackRate,
        startTime: Math.max(0, Number(playbackState.time) || 0),
        forceStartTime: Boolean(playbackState.forceTime),
        internalSeekTarget: null,
        // One ban list per video, shared by every quality and by the audio track. What has been
        // measured about the nodes is kept for the whole page, so a seek does not start over.
        videoResolver: resolverFactory.createResolver(representation, () => core.normalizeSettings(getSettings()).mode, options.cdnBans, options.nodeStats || undefined),
        audioResolver: resolverFactory.createResolver(selection.audio, () => core.normalizeSettings(getSettings()).mode, options.cdnBans, options.nodeStats || undefined)
      };
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
        const audioBuffer = mediaSource.addSourceBuffer(mimeFor(selection.audio, "audio"));
        const [videoTrack, audioTrack] = await Promise.all([
          loadTrack(candidate, "video", representation, candidate.videoResolver, videoBuffer, candidate.startTime),
          loadTrack(candidate, "audio", selection.audio, candidate.audioResolver, audioBuffer, candidate.startTime)
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
      options.onLog?.("你跳到的位置还需要加载", `正在为 ${target.toFixed(2)} 秒的位置重新准备数据。`, "info", "buffer");
      await startSession(selectedVideo, {
        time: target,
        resume: !video.paused,
        volume: video.volume,
        muted: video.muted,
        playbackRate: video.playbackRate
      });
    }

    function scheduleSeek() {
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => {
        seekTimer = null;
        seek().catch((error) => { if (session && sessionIsCurrent(session)) fatal(session, error); });
      }, 140);
    }

    video.addEventListener("seeking", scheduleSeek, { signal: eventController.signal });
    video.addEventListener("timeupdate", () => ensureBuffer(), { signal: eventController.signal });
    video.addEventListener("waiting", () => {
      const candidate = session;
      if (candidate && sessionIsCurrent(candidate) && candidate.playbackActivated) {
        candidate.startupWaitingEvents += 1;
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
    video.addEventListener("ended", () => publishState({ playerState: "ended", bufferedAhead: 0 }), { signal: eventController.signal });

    function playbackState() {
      return {
        time: Number(video.currentTime) || 0,
        resume: !video.paused || Number(video.currentTime) < 1,
        volume: video.volume,
        muted: video.muted,
        playbackRate: video.playbackRate || 1
      };
    }

    async function updatePlayinfo(playinfo) {
      if (destroyed) return;
      const next = selectRepresentations(playinfo, preferredQuality);
      currentPlayinfo = playinfo;
      const nextVideo = next.preferred;
      const audioChanged = !sameRepresentation(selection.audio, next.audio);
      selection = next;
      if (!audioChanged && sameRepresentation(selectedVideo, nextVideo)) return;
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
    const initialResume = options.initialResume !== undefined
      ? Boolean(options.initialResume)
      : !original.wasPaused || original.currentTime < 1;
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
      destroy,
      setQuality,
      updatePlayinfo,
      video,
      getDebug: () => ({
        version: "0.9.1.4",
        architecture: "bilibili-native-ui-progressive-mse-0.8-core",
        quality: qualityLabel(selectedVideo),
        qualityId: Number(selectedVideo?.id) || 0,
        preferredQuality,
        sessionStarts,
        codec: codecFamily(selectedVideo),
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
        progressiveAppends: session?.progressiveAppends || 0,
        seekReloads,
        download: downloader.stats?.() || null,
        tracks: (session?.tracks || []).map((track) => ({ kind: track.kind, nextIndex: track.nextIndex, segments: track.sidx.segments.length }))
      })
    });
  }

  root.__BILI_NATIVE_MSE_PLAYER_FACTORY__ = Object.freeze({ createNativePlayer, qualityLabel, selectRepresentations });
})(globalThis);
