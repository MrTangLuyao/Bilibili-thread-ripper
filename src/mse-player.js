(function installMsePlayer(root) {
  "use strict";

  const core = root.__BILI_RANGE_CORE__;
  const sidxTools = root.__BILI_SIDX__;
  const resolverFactory = root.__BILI_CDN_RESOLVER_FACTORY__;
  const downloaderFactory = root.__BILI_IDM_DOWNLOADER_FACTORY__;
  const danmakuFactory = root.__BILI_DANMAKU_FACTORY__;
  const subtitleFactory = root.__BILI_SUBTITLE_FACTORY__;
  if (!core || !sidxTools || !resolverFactory || !downloaderFactory || !root.MediaSource || !root.Artplayer) return;

  const PLAYER_ID = "__bilibili_thread_ripper_player__";
  const STARTUP_BUFFER_MIN_SECONDS = 2.5;
  const STARTUP_BUFFER_MAX_SECONDS = 10;
  const STARTUP_RECOVERY_SECONDS = 6;
  const STARTUP_PROTECTION_MS = 20000;
  const THREAD_OPTIONS = Object.freeze([4, 8, 16, 32, 64, 128]);
  const QUALITY_NAMES = Object.freeze({
    127: "8K",
    126: "杜比视界",
    125: "HDR",
    120: "4K",
    116: "1080P 60帧",
    112: "1080P 高码率",
    80: "1080P",
    74: "720P 60帧",
    64: "720P",
    32: "480P",
    16: "360P",
    6: "240P"
  });

  function dashData(playinfo) {
    return (playinfo?.data || playinfo)?.dash || null;
  }

  function mimeFor(representation, fallbackKind) {
    const mime = representation?.mimeType || representation?.mime_type || `${fallbackKind}/mp4`;
    const codecs = representation?.codecs || representation?.codec;
    return codecs ? `${mime}; codecs="${codecs}"` : mime;
  }

  function frameRate(representation) {
    const raw = String(representation?.frameRate || representation?.frame_rate || "0");
    if (raw.includes("/")) {
      const [top, bottom] = raw.split("/").map(Number);
      return bottom ? top / bottom : 0;
    }
    return Number(raw) || 0;
  }

  function qualityLabel(representation) {
    const id = Number(representation?.id);
    const fps = frameRate(representation);
    if (QUALITY_NAMES[id]) {
      const named = QUALITY_NAMES[id];
      return fps >= 50 && !named.includes("60帧") && [120, 80, 64, 32, 16].includes(id)
        ? `${named} ${Math.round(fps)}帧`
        : named;
    }
    const height = Number(representation?.height) || 0;
    const base = height >= 2160 ? "4K" : height ? `${height}P` : `清晰度 ${id || "?"}`;
    return fps >= 50 ? `${base} ${Math.round(fps)}帧` : base;
  }

  function supported(representation, kind) {
    try { return MediaSource.isTypeSupported(mimeFor(representation, kind)); }
    catch (_error) { return false; }
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

  function selectRepresentations(playinfo) {
    const dash = dashData(playinfo);
    if (!dash) throw new Error("页面没有 DASH 播放清单");
    const supportedVideo = (dash.video || []).filter((item) => supported(item, "video"));
    const byQuality = new Map();
    for (const representation of supportedVideo) {
      const key = Number(representation.id) || `${Number(representation.height) || 0}-${Math.round(frameRate(representation))}`;
      const existing = byQuality.get(key);
      if (!existing ||
          codecPriority(representation) > codecPriority(existing) ||
          (codecPriority(representation) === codecPriority(existing) && (Number(representation.bandwidth) || 0) > (Number(existing.bandwidth) || 0))) {
        byQuality.set(key, representation);
      }
    }
    const videos = Array.from(byQuality.values()).sort((a, b) =>
      (Number(b.height) || 0) - (Number(a.height) || 0) ||
      frameRate(b) - frameRate(a) ||
      (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0)
    );
    const audio = (dash.audio || []).filter((item) => supported(item, "audio"))
      .sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0))[0];
    if (!videos.length || !audio) throw new Error("浏览器不支持清单中的视频或音频编码");
    const preferred = videos.find((item) => (Number(item.height) || 0) <= 2160) || videos[0];
    return { audio, dash, preferred, video: preferred, videos };
  }

  function segmentBase(representation) {
    const base = representation?.segment_base || representation?.segmentBase || representation?.SegmentBase || {};
    const initialization = base.initialization || base.Initialization || base.initialization_range;
    const indexRange = base.index_range || base.indexRange || base.IndexRange;
    const init = core.parseByteRange(initialization);
    const index = core.parseByteRange(indexRange);
    if (!init || !index) throw new Error("播放清单缺少初始化或 SIDX 字节范围");
    return { index, init };
  }

  function waitEvent(target, successName, errorName = "error") {
    return new Promise((resolve, reject) => {
      const success = () => { cleanup(); resolve(); };
      const failure = () => { cleanup(); reject(new Error(`${successName} 失败`)); };
      const cleanup = () => {
        target.removeEventListener(successName, success);
        target.removeEventListener(errorName, failure);
      };
      target.addEventListener(successName, success, { once: true });
      target.addEventListener(errorName, failure, { once: true });
    });
  }

  function isBufferedAt(sourceBuffer, time) {
    for (let index = 0; index < sourceBuffer.buffered.length; index += 1) {
      if (sourceBuffer.buffered.start(index) <= time + 0.25 && sourceBuffer.buffered.end(index) >= time - 0.25) return true;
    }
    return false;
  }

  function bufferedEndAt(sourceBuffer, time) {
    for (let index = 0; index < sourceBuffer.buffered.length; index += 1) {
      if (sourceBuffer.buffered.start(index) <= time + 0.25 && sourceBuffer.buffered.end(index) >= time - 0.25) return sourceBuffer.buffered.end(index);
    }
    return time;
  }

  function mediaBytesPerSecond(track) {
    const segment = track?.sidx?.segments?.[track.startupIndex];
    if (segment?.durationSeconds > 0 && segment?.length > 0) return segment.length / segment.durationSeconds;
    return Math.max(0, Number(track?.representation?.bandwidth) || 0) / 8;
  }

  function createOverlay(container, settings) {
    const overlay = document.createElement("div");
    overlay.id = PLAYER_ID;
    overlay.dataset.version = "0.8.9";
    overlay.dataset.mode = settings.mode;
    overlay.dataset.handoff = "true";
    overlay.dataset.error = "false";
    overlay.innerHTML = `
      <div class="btr-art-mount"></div>
      <div class="btr-loader" role="status" aria-label="正在加载">
        <svg viewBox="0 0 50 50" aria-hidden="true">
          <circle cx="25" cy="25" r="20"></circle>
        </svg>
      </div>
      <div class="btr-status" role="alert"></div>
    `;
    const style = document.createElement("style");
    style.dataset.btrPlayerStyle = "0.8.9";
    style.textContent = `
      #${PLAYER_ID}{position:absolute!important;inset:0!important;z-index:2147483000!important;background:#000!important;display:block!important;overflow:hidden!important}
      #${PLAYER_ID} .btr-art-mount{width:100%!important;height:100%!important;background:#000!important}
      #${PLAYER_ID} .btr-loader{position:absolute;left:50%;top:50%;width:48px;height:48px;transform:translate(-50%,-50%);color:rgba(255,255,255,.9);pointer-events:none;z-index:20}
      #${PLAYER_ID} .btr-loader svg{display:block;width:100%;height:100%;animation:btr-material-rotate 1.4s linear infinite}
      #${PLAYER_ID} .btr-loader circle{fill:none;stroke:currentColor;stroke-width:4;stroke-linecap:round;stroke-dasharray:24,126;stroke-dashoffset:0;animation:btr-material-dash 1.4s ease-in-out infinite}
      #${PLAYER_ID}[data-ready="true"] .btr-loader,#${PLAYER_ID}[data-error="true"] .btr-loader{display:none}
      #${PLAYER_ID} .btr-status{display:none;position:absolute;left:50%;top:50%;max-width:min(560px,80%);transform:translate(-50%,-50%);padding:9px 13px;background:rgba(23,25,31,.94);color:#fff;font:13px/1.45 "Microsoft YaHei",sans-serif;border-radius:4px;pointer-events:none;z-index:21}
      #${PLAYER_ID}[data-error="true"] .btr-status{display:block}
      #${PLAYER_ID} .art-loading{display:none!important}
      @keyframes btr-material-rotate{to{transform:rotate(360deg)}}
      @keyframes btr-material-dash{0%{stroke-dasharray:24,126;stroke-dashoffset:0}50%{stroke-dasharray:90,126;stroke-dashoffset:-35px}100%{stroke-dasharray:24,126;stroke-dashoffset:-124px}}
      @media (prefers-reduced-motion:reduce){#${PLAYER_ID} .btr-loader svg{animation-duration:2.2s}#${PLAYER_ID} .btr-loader circle{animation:none;stroke-dasharray:82,126}}
      #${PLAYER_ID} .art-video-player{--art-theme:#fb7299!important;font-family:"Microsoft YaHei",sans-serif!important;container-type:inline-size!important}
      #${PLAYER_ID} .art-bottom:before{background:rgba(0,0,0,.72)!important}
      #${PLAYER_ID} .art-settings,#${PLAYER_ID} .art-selector-list{box-shadow:none!important}
      #${PLAYER_ID} .art-control-btr-quality{min-width:58px!important;text-align:center!important}
      #${PLAYER_ID} .art-control-btr-subtitle{width:40px!important;min-width:40px!important;color:#fff!important}
      #${PLAYER_ID} .art-control-btr-subtitle .art-selector-value{display:flex!important;align-items:center!important;justify-content:center!important;height:100%!important;line-height:1!important}
      #${PLAYER_ID} .btr-cc-icon{position:relative!important;display:inline-flex!important;box-sizing:border-box!important;width:24px!important;height:18px!important;align-items:center!important;justify-content:center!important;overflow:visible!important;border:1.7px solid currentColor!important;border-radius:3px!important;color:#fff!important;background:transparent!important;font:700 10px/1 Arial,sans-serif!important;letter-spacing:-.35px!important;text-shadow:none!important}
      #${PLAYER_ID} .btr-subtitle-off .btr-cc-icon:after{content:""!important;position:absolute!important;left:-2px!important;top:50%!important;width:28px!important;height:2px!important;border-radius:2px!important;background:#fff!important;box-shadow:0 0 0 1px rgba(0,0,0,.88)!important;transform:translateY(-50%) rotate(-45deg)!important;transform-origin:center!important;pointer-events:none!important}
      #${PLAYER_ID} .art-subtitle{bottom:74px!important;padding:0 7%!important;font-size:clamp(18px,2.2vw,34px)!important;line-height:1.38!important;pointer-events:none!important}
      #${PLAYER_ID} .art-subtitle-line{display:inline-block!important;max-width:100%!important;margin:2px auto!important;padding:2px 7px!important;border-radius:2px!important;background:rgba(0,0,0,.56)!important;box-decoration-break:clone!important;-webkit-box-decoration-break:clone!important}
      @container (max-width:620px){
        #${PLAYER_ID} .art-controls{padding:0 6px!important}
        #${PLAYER_ID} .art-control{padding-left:5px!important;padding-right:5px!important}
        #${PLAYER_ID} .art-controls-center{flex:0 0 auto!important;min-width:0!important}
        #${PLAYER_ID} .art-controls-center .artplayer-plugin-danmuku{width:auto!important;min-width:0!important;gap:6px!important}
        #${PLAYER_ID} .art-controls-center .apd-emitter{display:none!important}
        #${PLAYER_ID} .art-control-pip{display:none!important}
        #${PLAYER_ID} .art-control-btr-quality{min-width:46px!important;font-size:12px!important}
        #${PLAYER_ID} .art-subtitle{bottom:56px!important;padding:0 4%!important;font-size:clamp(15px,4.2vw,22px)!important}
      }
      @container (max-width:470px){
        #${PLAYER_ID} .art-controls{padding:0 3px!important}
        #${PLAYER_ID} .art-control{padding-left:3px!important;padding-right:3px!important}
        #${PLAYER_ID} .art-control-playAndPause,#${PLAYER_ID} .art-control-volume,#${PLAYER_ID} .art-control-setting,#${PLAYER_ID} .art-control-fullscreen{width:36px!important;min-width:36px!important}
        #${PLAYER_ID} .art-control-volume .art-volume-panel{display:none!important}
        #${PLAYER_ID} .art-control-time{width:46px!important;min-width:46px!important;max-width:46px!important;overflow:hidden!important;white-space:nowrap!important}
        #${PLAYER_ID} .art-control-btr-quality{min-width:40px!important;max-width:50px!important;overflow:hidden!important;white-space:nowrap!important}
        #${PLAYER_ID} .art-control-btr-subtitle{width:32px!important;min-width:32px!important}
        #${PLAYER_ID} .btr-cc-icon{width:22px!important;height:17px!important;font-size:9px!important}
        #${PLAYER_ID} .btr-subtitle-off .btr-cc-icon:after{left:-2px!important;width:26px!important}
        #${PLAYER_ID} .art-controls-center .artplayer-plugin-danmuku{gap:0!important;padding-left:0!important;padding-right:0!important}
        #${PLAYER_ID} .art-controls-center .apd-icon{width:22px!important;height:22px!important}
      }
      @container (max-width:370px){
        #${PLAYER_ID} .art-control-btr-quality{display:none!important}
        #${PLAYER_ID} .art-control-time{font-size:12px!important}
      }
    `;
    document.documentElement.append(style);
    const oldPosition = container.style.position;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    container.append(overlay);
    return {
      mount: overlay.querySelector(".btr-art-mount"),
      overlay,
      style,
      clearError() {
        overlay.dataset.error = "false";
        const status = overlay.querySelector(".btr-status");
        if (status) status.textContent = "";
      },
      setError(text) {
        overlay.dataset.error = "true";
        const status = overlay.querySelector(".btr-status");
        if (status) status.textContent = String(text).slice(0, 160);
      },
      restoreContainer() { container.style.position = oldPosition; }
    };
  }

  function createPlayer(options) {
    const getSettings = options.getSettings;
    const initialSettings = core.normalizeSettings(getSettings());
    const selection = selectRepresentations(options.playinfo);
    const downloader = downloaderFactory.createDownloader({
      getSettings,
      nativeFetch: options.nativeFetch,
      onTransfer: options.onTransfer
    });
    const nativeVideos = Array.from(options.container.querySelectorAll("video")).map((nativeVideo) => ({
      video: nativeVideo,
      visibility: nativeVideo.style.visibility,
      pointerEvents: nativeVideo.style.pointerEvents,
      muted: nativeVideo.muted,
      volume: nativeVideo.volume,
      playbackRate: nativeVideo.playbackRate,
      currentTime: Number(nativeVideo.currentTime) || 0,
      wasPaused: nativeVideo.paused
    }));
    const firstNative = nativeVideos[0];
    const initialVolume = initialSettings.volume;
    const capturedNativeTime = Number(firstNative?.currentTime) || 0;
    const initialTime = capturedNativeTime >= 2 ? capturedNativeTime : 0;
    const initialPlaybackRate = firstNative?.playbackRate || 1;
    const shouldAutoplay = capturedNativeTime < 1 || nativeVideos.some((entry) => !entry.wasPaused);

    const ui = createOverlay(options.container, initialSettings);
    let art = null;
    let video = null;
    let session = null;
    let selectedVideo = selection.preferred;
    let destroyed = false;
    let generationSequence = 0;
    let videoEventsBound = false;
    let nativeTakenOver = true;
    let seekReloads = 0;
    let seekTimer = null;
    let volumeSaveTimer = null;
    let subtitleController = null;
    for (const entry of nativeVideos) {
      if (!entry.video.paused) entry.video.pause();
      entry.video.muted = true;
      entry.video.style.visibility = "hidden";
      entry.video.style.pointerEvents = "none";
    }

    function modeText(mode) {
      return mode === "overseas" ? "海外 CDN" : "大陆 CDN";
    }

    function modeSetting(current) {
      return {
        name: "btr-cdn-mode",
        html: "CDN 模式",
        tooltip: modeText(current.mode),
        selector: [
          { name: "btr-cdn-mainland", html: "大陆 CDN", value: "mainland", default: current.mode === "mainland" },
          { name: "btr-cdn-overseas", html: "海外 CDN", value: "overseas", default: current.mode === "overseas" }
        ],
        onSelect(item) {
          options.onSettingsChange?.({ mode: item.value });
          return item.html;
        }
      };
    }

    function concurrencySetting(current) {
      const index = Math.max(0, THREAD_OPTIONS.indexOf(current.concurrency));
      const text = `${THREAD_OPTIONS[index]} 线程`;
      const valueAt = (item) => THREAD_OPTIONS[Math.max(0, Math.min(THREAD_OPTIONS.length - 1, Math.round(item.range[0])))] || 32;
      return {
        name: "btr-concurrency",
        html: "线程加载数",
        tooltip: text,
        range: [index, 0, THREAD_OPTIONS.length - 1, 1],
        onChange(item) {
          return `${valueAt(item)} 线程`;
        },
        onRange(item) {
          const concurrency = valueAt(item);
          options.onSettingsChange?.({ concurrency });
          return `${concurrency} 线程`;
        }
      };
    }

    function volumeSetting(current) {
      const percent = Math.round(Math.max(0, Math.min(1, Number(current.volume) || 0)) * 100);
      const percentAt = (item) => Math.max(0, Math.min(100, Math.round(Number(item.range[0]) || 0)));
      return {
        name: "btr-volume",
        html: "音量",
        tooltip: `${percent}%`,
        range: [percent, 0, 100, 1],
        onChange(item) {
          return `${percentAt(item)}%`;
        },
        onRange(item) {
          const volume = percentAt(item) / 100;
          if (video) {
            video.volume = volume;
            video.muted = volume <= 0;
          }
          if (session) session.resumeMuted = volume <= 0;
          options.onSettingsChange?.({ volume });
          return `${Math.round(volume * 100)}%`;
        }
      };
    }

    function currentQuality() {
      return qualityLabel(selectedVideo);
    }

    function publishState(extra = {}) {
      const resolvers = session ? [session.videoResolver, session.audioResolver] : [];
      const health = resolvers.flatMap((resolver) => resolver.status());
      const currentTime = Number(video?.currentTime) || 0;
      options.onState?.({
        mode: core.normalizeSettings(getSettings()).mode,
        playerState: session?.fatal ? "error" : video?.ended ? "ended" : session?.recovering ? "buffering" : ui.overlay.dataset.ready === "true" ? "ready" : "loading",
        quality: currentQuality(),
        codec: codecFamily(selectedVideo),
        bufferedAhead: session?.tracks?.length
          ? Math.max(0, Math.min(...session.tracks.map((track) => bufferedEndAt(track.sourceBuffer, currentTime))) - currentTime)
          : 0,
        startupTargetSeconds: session?.startupTargetSeconds || 0,
        startupThroughputBps: session?.startupThroughputBps || 0,
        mediaBytesPerSecond: session?.mediaBytesPerSecond || 0,
        startupWaitingEvents: session?.startupWaitingEvents || 0,
        cdnHosts: health,
        ...extra
      });
    }

    function sessionIsCurrent(candidate) {
      return !destroyed && session === candidate && !candidate.disposed;
    }

    async function queuedSourceOperation(candidate, track, operation) {
      const next = track.operation.catch(() => {}).then(async () => {
        if (!sessionIsCurrent(candidate)) return;
        if (track.sourceBuffer.updating) await waitEvent(track.sourceBuffer, "updateend");
        if (!sessionIsCurrent(candidate)) return;
        return operation();
      });
      track.operation = next;
      return next;
    }

    async function append(candidate, track, bytes, generation) {
      return queuedSourceOperation(candidate, track, async () => {
        if (!sessionIsCurrent(candidate) || generation !== candidate.generation) return;
        track.sourceBuffer.appendBuffer(bytes);
        await waitEvent(track.sourceBuffer, "updateend");
      });
    }

    async function removeRange(candidate, track, start, end) {
      if (end <= start || candidate.mediaSource.readyState !== "open") return;
      return queuedSourceOperation(candidate, track, async () => {
        if (!sessionIsCurrent(candidate) || candidate.mediaSource.readyState !== "open") return;
        track.sourceBuffer.remove(start, end);
        await waitEvent(track.sourceBuffer, "updateend");
      });
    }

    async function loadTrack(candidate, kind, representation, resolver, sourceBuffer, startTime) {
      const ranges = segmentBase(representation);
      const [initialization, indexBytes] = await Promise.all([
        downloader.downloadRange(ranges.init, resolver, { signal: candidate.controller.signal, parallel: false, kind: "meta" }),
        downloader.downloadRange(ranges.index, resolver, { signal: candidate.controller.signal, parallel: false, kind: "meta" })
      ]);
      if (!sessionIsCurrent(candidate)) throw new DOMException("播放器任务已取消", "AbortError");
      const sidx = sidxTools.parseSidx(indexBytes.bytes, ranges.index.start);
      if (!sidx) throw new Error(`${kind === "video" ? "视频" : "音频"} SIDX 解析失败`);
      const track = {
        kind,
        representation,
        resolver,
        sourceBuffer,
        sidx,
        nextIndex: sidxTools.segmentIndexAt(sidx.segments, startTime),
        complete: false,
        filling: false,
        started: false,
        startupComplete: false,
        startupScheduled: false,
        followupScheduled: false,
        startupIndex: sidxTools.segmentIndexAt(sidx.segments, startTime),
        prefetches: new Map(),
        operation: Promise.resolve()
      };
      await append(candidate, track, initialization.bytes, candidate.generation);
      return track;
    }

    function segmentDownload(candidate, track, segment, index, options = {}) {
      return downloader.downloadRange(segment, track.resolver, {
        signal: candidate.controller.signal,
        parallel: true,
        kind: track.kind,
        priority: options.priority,
        startup: options.startup === true,
        onStartupScheduled: options.onStartupScheduled,
        onOrderedChunk: options.onOrderedChunk || null
      }).then(
        (result) => ({ index, result }),
        (error) => ({ error, index })
      );
    }

    function maybeStartStartupPrefetch(candidate) {
      if (candidate.startupPrefetchLaunched || !sessionIsCurrent(candidate) || !candidate.tracks.length) return;
      if (!candidate.tracks.every((track) => track.startupScheduled)) return;
      candidate.startupPrefetchLaunched = true;
      for (const track of candidate.tracks) {
        const index = track.startupIndex + 1;
        const segment = track.sidx.segments[index];
        track.followupScheduled = true;
        if (!segment) continue;
        track.prefetches.set(index, segmentDownload(candidate, track, segment, index, { priority: 70 }));
      }
      ensureBuffer(candidate);
    }

    function updateStartupProfile(candidate) {
      const elapsedSeconds = Math.max(0.25, (performance.now() - candidate.startupStartedAt) / 1000);
      const throughput = candidate.startupCompletedBytes / elapsedSeconds;
      const required = candidate.tracks.reduce((sum, track) => sum + mediaBytesPerSecond(track), 0);
      const ratio = required > 0 ? throughput / required : 0;
      let target = 6;
      if (ratio >= 3) target = STARTUP_BUFFER_MIN_SECONDS;
      else if (ratio >= 1.8) target = 4;
      else if (ratio >= 1.25) target = 6;
      else if (ratio > 0) target = 8;
      if ((Number(selectedVideo?.height) || 0) >= 2160 && ratio < 1.8) target = Math.max(target, 8);
      target = Math.max(STARTUP_BUFFER_MIN_SECONDS, Math.min(STARTUP_BUFFER_MAX_SECONDS, target));
      candidate.startupThroughputBps = throughput;
      candidate.mediaBytesPerSecond = required;
      candidate.startupTargetSeconds = target;
      return { ratio, required, target, throughput };
    }

    async function fillTrack(candidate, track) {
      if (track.filling || track.complete || !sessionIsCurrent(candidate) || candidate.fatal) return;
      track.filling = true;
      const generation = candidate.generation;
      const signal = candidate.controller.signal;
      try {
        while (sessionIsCurrent(candidate) && generation === candidate.generation && !signal.aborted) {
          const current = Number(video.currentTime) || 0;
          if (track.nextIndex >= track.sidx.segments.length) {
            track.complete = true;
            break;
          }
          const ahead = bufferedEndAt(track.sourceBuffer, current) - current;
          if (ahead >= core.normalizeSettings(getSettings()).bufferAheadSeconds) break;
          const batchSize = track.started ? (track.kind === "video" ? 3 : 4) : 1;
          const batch = [];
          let projectedEnd = bufferedEndAt(track.sourceBuffer, current);
          for (let offset = 0; offset < batchSize; offset += 1) {
            const index = track.nextIndex + offset;
            const segment = track.sidx.segments[index];
            if (!segment || projectedEnd - current >= core.normalizeSettings(getSettings()).bufferAheadSeconds) break;
            const startup = !track.startupComplete && index === track.startupIndex;
            const prefetched = track.prefetches.get(index);
            batch.push(prefetched || segmentDownload(candidate, track, segment, index, {
              priority: startup ? 120 : Math.max(30, 55 - offset * 5),
              startup,
              onStartupScheduled: startup ? () => {
                track.startupScheduled = true;
                maybeStartStartupPrefetch(candidate);
              } : null,
              onOrderedChunk: startup ? async (bytes) => {
                if (!sessionIsCurrent(candidate) || generation !== candidate.generation || signal.aborted) return;
                await append(candidate, track, bytes, generation);
                ensureBuffer(candidate);
              } : null
            }));
            projectedEnd = segment.endTime;
          }
          if (!batch.length) break;
          for (const pending of batch) {
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
            options.onSegment?.({
              kind: track.kind,
              bytes: settled.result.byteLength,
              pieces: settled.result.pieceCount,
              hosts: settled.result.hosts
            });
            ensureBuffer(candidate);
          }
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
        if (!sessionIsCurrent(candidate) || candidate.fatal || candidate.streamEnded) return;
        if (candidate.mediaSource.readyState === "ended") {
          candidate.streamEnded = true;
          publishState();
          return;
        }
        if (candidate.mediaSource.readyState !== "open") return;
        if (candidate.tracks.some((track) => track.sourceBuffer.updating)) {
          candidate.ending = false;
          candidate.endRetryTimer = setTimeout(() => maybeEndStream(candidate), 50);
          return;
        }
        const trackEnds = candidate.tracks
          .map((track) => track.sidx.segments.at(-1)?.endTime)
          .filter((value) => Number.isFinite(value) && value > 0);
        const playableEnd = trackEnds.length ? Math.min(...trackEnds) : 0;
        if (!candidate.finalDurationAdjusted && playableEnd > 0) {
          candidate.finalDurationAdjusted = true;
          if (Math.abs(candidate.mediaSource.duration - playableEnd) > 0.01) {
            candidate.mediaSource.duration = playableEnd;
          }
          if (candidate.tracks.some((track) => track.sourceBuffer.updating)) {
            candidate.ending = false;
            candidate.endRetryTimer = setTimeout(() => maybeEndStream(candidate), 50);
            return;
          }
        }
        candidate.mediaSource.endOfStream();
        candidate.streamEnded = true;
        publishState();
      }).catch((error) => {
        if (!sessionIsCurrent(candidate)) return;
        if (error?.name === "InvalidStateError") {
          candidate.ending = false;
          candidate.endRetryTimer = setTimeout(() => maybeEndStream(candidate), 50);
          return;
        }
        fatal(candidate, error);
      }).finally(() => {
        if (sessionIsCurrent(candidate) && !candidate.streamEnded) candidate.ending = false;
      });
    }

    function pauseNativeVideos() {
      for (const entry of nativeVideos) {
        if (!entry.video.paused) entry.video.pause();
      }
    }

    function setCurrentTimeInternal(candidate, target) {
      candidate.suppressSeek = true;
      try { video.currentTime = target; }
      catch (_error) { candidate.suppressSeek = false; }
      setTimeout(() => {
        if (sessionIsCurrent(candidate)) candidate.suppressSeek = false;
      }, 300);
    }

    function performHandoff(candidate) {
      if (candidate.playbackActivated || !sessionIsCurrent(candidate) || !candidate.tracks.length) return;
      if (!candidate.tracks.every((track) => track.startupComplete && track.followupScheduled)) return;
      const nativeVideo = firstNative?.video;
      const target = Math.max(0, Number(video?.currentTime) || candidate.startTime || initialTime);
      const ends = candidate.tracks.map((track) => bufferedEndAt(track.sourceBuffer, target));
      const ready = candidate.tracks.every((track) => isBufferedAt(track.sourceBuffer, target));
      const profile = updateStartupProfile(candidate);
      const remaining = Math.max(0.5, (Number(candidate.mediaSource.duration) || target + profile.target) - target);
      const requiredAhead = Math.max(0.5, Math.min(profile.target, remaining));
      if (!ready || Math.min(...ends) - target < requiredAhead) return;

      const handoffVolume = core.normalizeSettings(getSettings()).volume;
      const handoffRate = Number(nativeVideo?.playbackRate) || initialPlaybackRate;
      candidate.playAttempted = false;
      candidate.playbackActivated = true;
      candidate.playbackActivatedAt = performance.now();
      setCurrentTimeInternal(candidate, target);
      video.volume = handoffVolume;
      video.muted = candidate.resumeMuted || handoffVolume <= 0;
      video.playbackRate = handoffRate;
      pauseNativeVideos();
      for (const entry of nativeVideos) {
        entry.video.muted = true;
        entry.video.style.visibility = "hidden";
        entry.video.style.pointerEvents = "none";
      }
      ui.overlay.dataset.handoff = "true";
      ui.overlay.dataset.ready = "true";
      attemptAutoplay(candidate);
    }

    function attemptAutoplay(candidate) {
      if (candidate.playAttempted || !candidate.resumeWanted || !sessionIsCurrent(candidate)) return;
      candidate.playAttempted = true;
      video.play().catch(() => {
        if (!sessionIsCurrent(candidate)) return;
        art.notice.show = "浏览器阻止了有声自动播放，请点击播放";
      });
    }

    function ensureBuffer(candidate = session) {
      if (!candidate || !sessionIsCurrent(candidate) || candidate.fatal || !candidate.tracks.length) return;
      if (nativeTakenOver) pauseNativeVideos();
      for (const track of candidate.tracks) fillTrack(candidate, track);
      performHandoff(candidate);
      const current = Number(video.currentTime) || 0;
      const ready = candidate.playbackActivated && candidate.tracks.every((track) => isBufferedAt(track.sourceBuffer, current));
      const ahead = ready ? Math.max(0, Math.min(...candidate.tracks.map((track) => bufferedEndAt(track.sourceBuffer, current))) - current) : 0;
      if (candidate.recovering) {
        const remaining = Math.max(0.5, (Number(candidate.mediaSource.duration) || current + candidate.recoveryTargetSeconds) - current);
        const recoveryTarget = Math.min(candidate.recoveryTargetSeconds, remaining);
        if (ready && ahead >= recoveryTarget) {
          candidate.recovering = false;
          candidate.playAttempted = false;
          ui.overlay.dataset.ready = "true";
          attemptAutoplay(candidate);
        } else {
          ui.overlay.dataset.ready = "false";
        }
      } else if (ready) {
        ui.overlay.dataset.ready = "true";
        attemptAutoplay(candidate);
      }
      publishState();
    }

    async function prune(candidate = session) {
      if (!candidate || !sessionIsCurrent(candidate) || candidate.fatal || video.currentTime < 75) return;
      const end = video.currentTime - 30;
      await Promise.all(candidate.tracks.map((track) => removeRange(candidate, track, 0, end).catch(() => {})));
    }

    async function seek() {
      const candidate = session;
      if (!candidate || !sessionIsCurrent(candidate) || !candidate.tracks.length) return;
      if (candidate.suppressSeek) {
        candidate.suppressSeek = false;
        return;
      }
      const target = Number(video.currentTime) || 0;
      if (candidate.tracks.every((track) => isBufferedAt(track.sourceBuffer, target))) {
        ensureBuffer(candidate);
        return;
      }
      seekReloads += 1;
      ui.overlay.dataset.ready = "false";
      ui.clearError();
      await startSession(selectedVideo, {
        time: target,
        resume: !video.paused,
        volume: Number(video.volume) || initialVolume,
        muted: Boolean(video.muted),
        playbackRate: Number(video.playbackRate) || 1
      });
    }

    function scheduleSeek() {
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => {
        seekTimer = null;
        seek().catch((error) => {
          const candidate = session;
          if (candidate && sessionIsCurrent(candidate)) fatal(candidate, error);
        });
      }, 140);
    }

    function bindVideoEvents() {
      if (videoEventsBound || !video) return;
      videoEventsBound = true;
      video.addEventListener("seeking", scheduleSeek);
      video.addEventListener("volumechange", () => {
        if (session) session.resumeMuted = Boolean(video.muted);
        clearTimeout(volumeSaveTimer);
        if (video.muted) return;
        volumeSaveTimer = setTimeout(() => {
          volumeSaveTimer = null;
          const volume = Math.round(Math.max(0, Math.min(1, Number(video.volume) || 0)) * 100) / 100;
          if (Math.abs(core.normalizeSettings(getSettings()).volume - volume) > 0.001) options.onSettingsChange?.({ volume });
        }, 160);
      });
      video.addEventListener("timeupdate", () => ensureBuffer());
      video.addEventListener("playing", () => {
        const candidate = session;
        if (candidate && sessionIsCurrent(candidate) && candidate.playbackActivated) candidate.hasPlayed = true;
      });
      video.addEventListener("waiting", () => {
        const candidate = session;
        if (candidate && sessionIsCurrent(candidate) && candidate.playbackActivated && candidate.hasPlayed) {
          candidate.startupWaitingEvents += 1;
          const startupAge = performance.now() - candidate.playbackActivatedAt;
          if (startupAge <= STARTUP_PROTECTION_MS && !candidate.recovering && !video.seeking) {
            candidate.recovering = true;
            candidate.resumeWanted = true;
            candidate.playAttempted = false;
            candidate.recoveryTargetSeconds = Math.min(
              STARTUP_BUFFER_MAX_SECONDS,
              Math.max(STARTUP_RECOVERY_SECONDS, candidate.startupTargetSeconds + 2)
            );
            video.pause();
            ui.overlay.dataset.ready = "false";
            ui.clearError();
          }
        }
        ensureBuffer(candidate);
      });
      video.addEventListener("ended", () => {
        ui.overlay.dataset.ready = "true";
        if (art?.notice) art.notice.show = "播放结束";
        publishState({ playerState: "ended", bufferedAhead: 0 });
      });
    }

    function disposeSession(candidate) {
      if (!candidate || candidate.disposed) return;
      candidate.disposed = true;
      candidate.generation = ++generationSequence;
      candidate.controller.abort(new DOMException("播放器任务已取消", "AbortError"));
      clearInterval(candidate.timer);
      clearTimeout(candidate.endRetryTimer);
      if (video && video.src === candidate.objectUrl) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      URL.revokeObjectURL(candidate.objectUrl);
    }

    function fatal(candidate, error) {
      if (!sessionIsCurrent(candidate) || candidate.fatal || error?.name === "AbortError") return;
      candidate.fatal = true;
      candidate.controller.abort(new DOMException("播放器发生错误", "AbortError"));
      ui.overlay.dataset.ready = "false";
      const message = String(error?.message || error).slice(0, 140);
      ui.setError(`多线程播放器失败：${message}`);
      if (art?.notice) art.notice.show = `播放失败：${message}`;
      publishState({ playerState: "error", lastError: message });
      options.onFatal?.(error);
    }

    async function startSession(representation, playbackState) {
      if (destroyed) return;
      if (session) disposeSession(session);
      selectedVideo = representation;
      ui.overlay.dataset.ready = "false";
      ui.clearError();
      const mediaSource = new MediaSource();
      const objectUrl = URL.createObjectURL(mediaSource);
      const candidate = {
        disposed: false,
        fatal: false,
        generation: ++generationSequence,
        controller: new AbortController(),
        mediaSource,
        objectUrl,
        timer: null,
        endRetryTimer: null,
        tracks: [],
        ending: false,
        streamEnded: false,
        finalDurationAdjusted: false,
        playAttempted: false,
        playbackActivated: false,
        playbackActivatedAt: 0,
        hasPlayed: false,
        recovering: false,
        recoveryTargetSeconds: STARTUP_RECOVERY_SECONDS,
        startupCompletedBytes: 0,
        startupPrefetchLaunched: false,
        startupStartedAt: performance.now(),
        startupTargetSeconds: 6,
        startupThroughputBps: 0,
        mediaBytesPerSecond: 0,
        startupWaitingEvents: 0,
        resumeWanted: playbackState.resume,
        resumeMuted: Boolean(playbackState.muted),
        startTime: Math.max(0, Number(playbackState.time) || 0),
        suppressSeek: false,
        videoResolver: resolverFactory.createResolver(representation, () => core.normalizeSettings(getSettings()).mode),
        audioResolver: resolverFactory.createResolver(selection.audio, () => core.normalizeSettings(getSettings()).mode)
      };
      session = candidate;
      video.src = objectUrl;
      video.volume = playbackState.volume;
      video.muted = playbackState.muted;
      video.playbackRate = playbackState.playbackRate;
      publishState({ playerState: "loading", quality: currentQuality(), lastError: "" });
      try {
        if (mediaSource.readyState !== "open") await waitEvent(mediaSource, "sourceopen");
        if (!sessionIsCurrent(candidate)) return;
        const videoBuffer = mediaSource.addSourceBuffer(mimeFor(representation, "video"));
        const audioBuffer = mediaSource.addSourceBuffer(mimeFor(selection.audio, "audio"));
        const startTime = Math.max(0, Number(playbackState.time) || 0);
        const [videoTrack, audioTrack] = await Promise.all([
          loadTrack(candidate, "video", representation, candidate.videoResolver, videoBuffer, startTime),
          loadTrack(candidate, "audio", selection.audio, candidate.audioResolver, audioBuffer, startTime)
        ]);
        if (!sessionIsCurrent(candidate)) return;
        candidate.tracks = [videoTrack, audioTrack];
        const parsedDuration = Math.max(
          Number(selection.dash.duration) || 0,
          videoTrack.sidx.segments.at(-1)?.endTime || 0,
          audioTrack.sidx.segments.at(-1)?.endTime || 0
        );
        if (parsedDuration > 0) mediaSource.duration = parsedDuration;
        if (startTime > 0 && Number.isFinite(mediaSource.duration)) {
          setCurrentTimeInternal(candidate, Math.min(startTime, Math.max(0, mediaSource.duration - 0.1)));
        }
        candidate.startupStartedAt = performance.now();
        candidate.timer = setInterval(() => {
          ensureBuffer(candidate);
          prune(candidate);
        }, 750);
        ensureBuffer(candidate);
      } catch (error) {
        if (sessionIsCurrent(candidate)) fatal(candidate, error);
      }
    }

    async function switchRepresentation(representation) {
      if (destroyed || representation === selectedVideo) return;
      const previousLabel = currentQuality();
      const nextLabel = qualityLabel(representation);
      const playbackState = {
        time: Number(video?.currentTime) || 0,
        resume: video ? !video.paused : shouldAutoplay,
        volume: Number(video?.volume) || initialVolume,
        muted: Boolean(video?.muted),
        playbackRate: Number(video?.playbackRate) || 1
      };
      art.notice.show = `正在切换到 ${nextLabel}`;
      await startSession(representation, playbackState);
      if (!session?.fatal) art.notice.show = `${previousLabel} → ${nextLabel}`;
    }

    const qualityItems = selection.videos.map((representation) => ({
      default: representation === selection.preferred,
      html: qualityLabel(representation),
      representation
    }));
    const plugins = [];
    if (danmakuFactory && typeof root.artplayerPluginDanmuku === "function") {
      plugins.push(danmakuFactory.createPlugin({
        nativeFetch: options.nativeFetch,
        identity: options.identity,
        getArt: () => art,
        settings: initialSettings.danmaku,
        onSettingsChange(danmaku) {
          const current = core.normalizeSettings(getSettings());
          if (JSON.stringify(current.danmaku) !== JSON.stringify(danmaku)) {
            options.onSettingsChange?.({ ...current, danmaku });
          }
        }
      }));
    }

    art = new root.Artplayer({
      id: `btr-${root.location.pathname}`,
      container: ui.mount,
      url: "btr://local/current.btr",
      type: "btr",
      poster: options.poster || "",
      theme: "#fb7299",
      lang: "zh-cn",
      volume: initialVolume,
      muted: false,
      autoplay: false,
      autoPlayback: false,
      playsInline: true,
      setting: true,
      playbackRate: true,
      aspectRatio: true,
      pip: true,
      hotkey: true,
      fullscreen: true,
      fullscreenWeb: false,
      miniProgressBar: true,
      mutex: true,
      plugins,
      settings: [modeSetting(initialSettings), concurrencySetting(initialSettings), volumeSetting(initialSettings)],
      controls: [{
        name: "btr-quality",
        position: "right",
        index: 15,
        html: currentQuality(),
        selector: qualityItems,
        onSelect(item) {
          switchRepresentation(item.representation).catch((error) => {
            if (art?.notice) art.notice.show = `清晰度切换失败：${error?.message || error}`;
          });
          return item.html;
        }
      }],
      customType: {
        btr(playerVideo, _url, instance) {
          art = instance;
          video = playerVideo;
          video.volume = initialVolume;
          video.muted = true;
          video.playbackRate = initialPlaybackRate;
          bindVideoEvents();
          return startSession(selectedVideo, {
            time: initialTime,
            resume: shouldAutoplay,
            volume: initialVolume,
            muted: initialVolume <= 0,
            playbackRate: initialPlaybackRate
          });
        }
      }
    });

    if (subtitleFactory?.attach) {
      subtitleController = subtitleFactory.attach({
        art,
        nativeFetch: options.nativeFetch,
        identity: options.identity,
        preference: initialSettings.subtitleLanguage,
        lastPreference: initialSettings.subtitleLastLanguage,
        onPreferenceChange(subtitleLanguage, subtitleLastLanguage) {
          const current = core.normalizeSettings(getSettings());
          if (current.subtitleLanguage !== subtitleLanguage || current.subtitleLastLanguage !== subtitleLastLanguage) {
            options.onSettingsChange?.({ subtitleLanguage, subtitleLastLanguage });
          }
        }
      });
    }

    function destroy({ resumeNative = true } = {}) {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(seekTimer);
      clearTimeout(volumeSaveTimer);
      const customTime = Number(video?.currentTime) || 0;
      const customWasPlaying = video ? !video.paused : false;
      if (session) disposeSession(session);
      subtitleController?.destroy?.();
      try { art?.destroy(true); } catch (_error) {}
      ui.overlay.remove();
      ui.style.remove();
      ui.restoreContainer();
      for (const entry of nativeVideos) {
        entry.video.style.visibility = entry.visibility;
        entry.video.style.pointerEvents = entry.pointerEvents;
        entry.video.muted = entry.muted;
        entry.video.volume = entry.volume;
        entry.video.playbackRate = entry.playbackRate;
        if (resumeNative && customTime > 0) {
          try { entry.video.currentTime = customTime; } catch (_error) {}
        }
        if (resumeNative && (customWasPlaying || !entry.wasPaused)) entry.video.play().catch(() => {});
      }
    }

    function applySettings(nextSettings) {
      const current = core.normalizeSettings(nextSettings);
      ui.overlay.dataset.mode = current.mode;
      if (!art?.setting) return;
      art.setting.update(modeSetting(current));
      art.setting.update(concurrencySetting(current));
      art.setting.update(volumeSetting(current));
      if (video && Math.abs(video.volume - current.volume) > 0.001) {
        video.volume = current.volume;
        if (current.volume <= 0) video.muted = true;
      }
      if (subtitleController) {
        subtitleController.setLastPreference?.(current.subtitleLastLanguage);
        if (subtitleController.getDebug().preference !== current.subtitleLanguage) {
          subtitleController.ready.then(() => subtitleController?.select(current.subtitleLanguage, false)).catch(() => {});
        }
      }
      const danmaku = art.plugins?.artplayerPluginDanmuku;
      if (danmaku) {
        const desired = danmakuFactory.settingsToConfig(current.danmaku);
        const actual = danmakuFactory.configToSettings(danmaku.option);
        if (JSON.stringify(actual) !== JSON.stringify(current.danmaku)) danmaku.config(desired);
      }
    }

    return Object.freeze({
      art,
      applySettings,
      destroy,
      getDebug: () => ({
        version: "0.8.9",
        artPlayerVersion: root.Artplayer.version,
        mode: core.normalizeSettings(getSettings()).mode,
        playerState: session?.fatal ? "error" : video?.ended ? "ended" : ui.overlay.dataset.ready === "true" ? "ready" : "loading",
        quality: currentQuality(),
        qualityId: Number(selectedVideo?.id) || 0,
        codec: selectedVideo.codecs,
        codecFamily: codecFamily(selectedVideo),
        currentTime: Number(video?.currentTime) || 0,
        muted: Boolean(video?.muted),
        volume: Number(video?.volume) || 0,
        nativeTakenOver,
        playbackActivated: Boolean(session?.playbackActivated),
        startupBufferSeconds: session?.startupTargetSeconds || 0,
        startupThroughputBps: session?.startupThroughputBps || 0,
        mediaBytesPerSecond: session?.mediaBytesPerSecond || 0,
        startupWaitingEvents: session?.startupWaitingEvents || 0,
        recovering: Boolean(session?.recovering),
        seekReloads,
        ended: Boolean(video?.ended),
        mediaSourceState: session?.mediaSource?.readyState || "closed",
        streamEnded: Boolean(session?.streamEnded),
        danmaku: Boolean(art?.plugins?.artplayerPluginDanmuku),
        danmakuSettings: danmakuFactory?.configToSettings?.(art?.plugins?.artplayerPluginDanmuku?.option) || null,
        subtitle: subtitleController?.getDebug?.() || null,
        tracks: (session?.tracks || []).map((track) => ({ kind: track.kind, complete: track.complete, nextIndex: track.nextIndex, segments: track.sidx.segments.length }))
      }),
      switchRepresentation,
      video: art.video
    });
  }

  root.__BILI_MSE_PLAYER_FACTORY__ = Object.freeze({ createPlayer, qualityLabel, selectRepresentations });
})(globalThis);
