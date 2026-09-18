(function installIdmDownloader(root) {
  "use strict";

  const core = root.__BILI_RANGE_CORE__;
  if (!core) return;

  const PIECE_ROUNDS = 3;
  const PIECE_RETRY_WINDOW_MS = 25000;
  const DUPLICATE_CANCELED = "并发副本已取消";
  const NO_ADDRESS = "没有可用 CDN";

  function abortError(reason) {
    if (reason instanceof Error || reason instanceof DOMException) return reason;
    return new DOMException("播放器任务已取消", "AbortError");
  }

  class Semaphore {
    constructor(limit) {
      this.limit = limit;
      this.active = 0;
      this.queue = [];
    }

    setLimit(limit) {
      this.limit = Math.max(1, Math.min(512, Math.trunc(limit) || 1));
      this.drain();
    }

    // A priority can be a function: the second copy of a piece only becomes urgent once that
    // piece is what the player is waiting for, which can happen while it is still queued.
    drain() {
      while (this.active < this.limit && this.queue.length) {
        let best = 0;
        for (let index = 1; index < this.queue.length; index += 1) {
          if (this.queue[index].priority() > this.queue[best].priority()) best = index;
        }
        const entry = this.queue.splice(best, 1)[0];
        entry.signal?.removeEventListener("abort", entry.canceled);
        this.active += 1;
        entry.resolve(() => {
          if (entry.released) return;
          entry.released = true;
          this.active = Math.max(0, this.active - 1);
          this.drain();
        });
      }
    }

    acquire(signal, priority = 0) {
      if (signal?.aborted) return Promise.reject(abortError(signal.reason));
      return new Promise((resolve, reject) => {
        const entry = {
          reject,
          resolve,
          signal,
          released: false,
          priority: typeof priority === "function" ? priority : () => Number(priority) || 0,
          canceled: () => {
            const at = this.queue.indexOf(entry);
            if (at >= 0) this.queue.splice(at, 1);
            reject(abortError(signal.reason));
          }
        };
        signal?.addEventListener("abort", entry.canceled, { once: true });
        this.queue.push(entry);
        this.drain();
      });
    }
  }

  function createDownloader(options) {
    const nativeFetch = options.nativeFetch || root.fetch.bind(root);
    const getSettings = options.getSettings;
    const onTransfer = typeof options.onTransfer === "function" ? options.onTransfer : () => null;
    const semaphore = new Semaphore(core.normalizeSettings(getSettings()).concurrency);
    // duplicateBytes is what arrived on a second copy of a piece before the other copy won.
    const counters = { requests: 0, copies: 0, bytes: 0, duplicateBytes: 0 };
    // The last requests, for the diagnostic report: when, which node, how long until the first
    // byte and until the end, and how it ended.
    const recent = [];
    function remember(entry) {
      recent.push(entry);
      if (recent.length > 400) recent.shift();
    }

    async function readBody(response, controller, transferId, settings, received) {
      if (!response.body?.getReader) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        received.bytes += bytes.byteLength;
        onTransfer({ phase: "progress", id: transferId, bytes: bytes.byteLength });
        return bytes;
      }
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      let stallTimer = null;
      const armStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => controller.abort(new DOMException("CDN 子块停止传输", "TimeoutError")), settings.stallTimeoutMs);
      };
      armStall();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          armStall();
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          chunks.push(chunk);
          total += chunk.byteLength;
          received.bytes += chunk.byteLength;
          received.lastByteAt = performance.now();
          onTransfer({ phase: "progress", id: transferId, bytes: chunk.byteLength });
        }
      } finally {
        clearTimeout(stallTimer);
        reader.releaseLock?.();
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }

    // `choose` names the address only once a thread is free. More is known about the nodes by
    // then than when the piece joined the queue, and a fast node ends up with more pieces.
    async function attempt(piece, choose, signal, kind, resolver, priority = 0, watch = null) {
      const settings = core.normalizeSettings(getSettings());
      const release = await semaphore.acquire(signal, priority);
      const url = choose();
      if (!url) {
        release();
        throw new Error(NO_ADDRESS);
      }
      const nodes = resolver.nodes || null;
      let receiving = false;
      nodes?.begin(url);
      counters.requests += 1;
      const controller = new AbortController();
      const cancel = () => controller.abort(abortError(signal?.reason));
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
      const firstByteTimer = setTimeout(() => controller.abort(new DOMException("CDN 首字节超时", "TimeoutError")), settings.firstByteTimeoutMs);
      const totalTimer = setTimeout(() => controller.abort(new DOMException("CDN 子块总耗时超限", "TimeoutError")), settings.attemptTimeoutMs);
      const transferId = onTransfer({ phase: "start", kind, totalBytes: piece.length, url });
      const startedAt = performance.now();
      const received = watch || { bytes: 0 };
      received.url = url;
      received.startedAt = startedAt;
      try {
        const response = await nativeFetch(url, {
          method: "GET",
          headers: { Range: `bytes=${piece.start}-${piece.end}` },
          credentials: "omit",
          cache: "no-store",
          mode: "cors",
          referrer: root.location?.href,
          referrerPolicy: "strict-origin-when-cross-origin",
          signal: controller.signal
        });
        clearTimeout(firstByteTimer);
        const firstByteAt = performance.now();
        receiving = true;
        received.firstByteAt = received.lastByteAt = firstByteAt;
        nodes?.firstByte(url, firstByteAt - startedAt);
        const contentRange = core.parseContentRange(response.headers.get("content-range"));
        if (response.status !== 206 || !contentRange || contentRange.start !== piece.start || contentRange.end !== piece.end) {
          // The status tells a refused signed address (4xx) apart from a node that is down.
          throw Object.assign(new Error(`Range 校验失败：HTTP ${response.status}`), { status: response.status });
        }
        const bytes = await readBody(response, controller, transferId, settings, received);
        if (bytes.byteLength !== piece.length) throw new Error(`子块长度不符：${bytes.byteLength}/${piece.length}`);
        const seconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
        nodes?.body(url, bytes.byteLength, performance.now() - firstByteAt);
        resolver.success(url, bytes.byteLength / seconds);
        counters.bytes += bytes.byteLength;
        remember({ at: Math.round(startedAt), kind, node: new URL(url).hostname, bytes: piece.length, firstByteMs: Math.round(firstByteAt - startedAt), ms: Math.round(performance.now() - startedAt), end: "ok" });
        onTransfer({ phase: "done", id: transferId });
        return { bytes, total: contentRange.total, url };
      } catch (error) {
        const outrun = controller.signal.reason?.message === DUPLICATE_CANCELED;
        const silent = !receiving && error?.name === "TimeoutError";
        const busy = silent && Boolean(nodes?.busy(url));
        if (silent) nodes?.silent(url, performance.now() - startedAt);
        if (outrun) counters.duplicateBytes += received.bytes;
        if (outrun && !receiving) nodes?.outrun?.(url, performance.now() - startedAt);
        if (outrun && receiving) nodes?.crawl?.(url, received.bytes, performance.now() - received.firstByteAt);
        remember({ at: Math.round(startedAt), kind, node: new URL(url).hostname, bytes: piece.length, firstByteMs: received.firstByteAt ? Math.round(received.firstByteAt - startedAt) : null, ms: Math.round(performance.now() - startedAt), end: outrun ? "other copy won" : String(error?.message || error).slice(0, 60) });
        // Received bytes tell a dead node (0 KiB) apart from a transfer that stalled midway.
        resolver.failure(url, error, received.bytes, busy);
        const canceled = error?.name === "AbortError";
        onTransfer({ phase: canceled ? "cancel" : "error", id: transferId, error });
        received.failed = true;
        received.wake?.();
        throw error;
      } finally {
        clearTimeout(firstByteTimer);
        clearTimeout(totalTimer);
        signal?.removeEventListener("abort", cancel);
        nodes?.end(url, receiving);
        release();
      }
    }

    function pause(delayMs, signal) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(done, delayMs);
        function done() {
          signal?.removeEventListener("abort", canceled);
          resolve();
        }
        function canceled() {
          clearTimeout(timer);
          reject(abortError(signal.reason));
        }
        if (signal?.aborted) canceled();
        else signal?.addEventListener("abort", canceled, { once: true });
      });
    }

    function pieceCandidates(piece, resolver, preferredUrls, round) {
      const preferred = Array.isArray(preferredUrls) ? preferredUrls : [];
      const preferredOffset = preferred.length ? (piece.index + round) % preferred.length : 0;
      const rotatedPreferred = preferred.slice(preferredOffset).concat(preferred.slice(0, preferredOffset));
      const rescue = (typeof resolver.rescueCandidates === "function" ? resolver.rescueCandidates() : resolver.ordered(piece.index))
        .filter((url) => !rotatedPreferred.includes(url));
      const candidates = [];
      const width = Math.max(rotatedPreferred.length, rescue.length);
      for (let index = 0; index < width; index += 1) {
        if (rotatedPreferred[index]) candidates.push(rotatedPreferred[index]);
        if (rescue[index]) candidates.push(rescue[index]);
      }
      for (const url of resolver.ordered(piece.index)) {
        if (!candidates.includes(url)) candidates.push(url);
      }
      return candidates;
    }

    // Settles once a second copy of the piece is worth its bandwidth: the first byte is
    // taking far longer than this node usually needs, the transfer has stopped, or it is
    // heading for several times the expected duration. A fixed delay copied every piece
    // that was merely not finished yet, and the copies took the bandwidth it was short of.
    function overdue(watch, piece, resolver, settings, startup, signal) {
      return new Promise((resolve) => {
        const nodes = resolver.nodes || null;
        let timer = setTimeout(check, 150);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        function check() {
          timer = setTimeout(check, 150);
          if (!watch.startedAt) return;
          const now = performance.now();
          const elapsed = now - watch.startedAt;
          if (!watch.firstByteAt) {
            const usual = nodes?.ttfbMs(watch.url) || 0;
            // With next to nothing buffered a second copy costs less than the wait: a node can
            // take seconds over a part of the file it has not served lately.
            const budget = startup
              ? (usual ? Math.min(600, Math.max(250, usual * 2)) : 250)
              : usual ? Math.min(3000, Math.max(600, usual * 3)) : settings.hedgeDelayMs;
            if (elapsed >= budget) done();
            return;
          }
          if (now - watch.lastByteAt >= (startup ? 1000 : 1500)) return done();
          const expected = nodes?.expectedMs(watch.url, piece.length) || settings.hedgeDelayMs;
          const allowed = startup ? Math.max(400, expected * 2) : Math.max(settings.hedgeDelayMs, expected * 3);
          if (elapsed >= allowed && watch.bytes < piece.length * 0.75) done();
        }
        watch.wake = done;
        if (signal.aborted) done();
        else signal.addEventListener("abort", done, { once: true });
      });
    }

    // `urgent` tells whether the player is waiting for this very piece. Only then may its
    // second copy go ahead of pieces that have not been asked for at all.
    async function downloadPiece(piece, resolver, signal, kind, preferredUrls, startupMode = false, priority = 0, urgent = null) {
      const settings = core.normalizeSettings(getSettings());
      const allowed = (url) => typeof resolver.allows !== "function" || resolver.allows(url);
      const startup = startupMode === true || startupMode === "probe";
      const startedAt = performance.now();
      let lastError = null;

      // Failing a piece ends acceleration for the whole video, and the list can be as short as
      // one working address. One slow reply must not decide that, so the list is walked again
      // after a pause; node health and bans have changed by then, so it is rebuilt each time.
      for (let round = 0; round < PIECE_ROUNDS; round += 1) {
        if (round) {
          if (performance.now() - startedAt > PIECE_RETRY_WINDOW_MS) break;
          await pause(Math.min(2000, 500 * (2 ** (round - 1))), signal);
        }
        const candidates = pieceCandidates(piece, resolver, preferredUrls, round);
        const limit = Math.min(8, candidates.length);
        const tried = new Set();
        // A node banned while this piece was waiting is skipped, unless only banned nodes are left.
        const choose = () => {
          if (tried.size >= limit) return null;
          const untried = candidates.filter((url) => !tried.has(url));
          const url = typeof resolver.pick === "function"
            ? resolver.pick(candidates, tried, piece.length, startup)
            : untried.find(allowed) || untried[0];
          if (url) tried.add(url);
          return url || null;
        };
        // With nothing known about any node yet, the first piece of a video is asked of all
        // of them at once: the fastest answer starts playback and every node gets measured.
        const race = startupMode === "probe" && !candidates.some((url) => resolver.nodes?.known(url));
        while (tried.size < limit) {
          if (signal?.aborted) throw abortError(signal.reason);
          const before = tried.size;
          const controllers = Array.from({ length: race ? limit : startup ? 3 : 2 }, () => new AbortController());
          const cancelAll = () => controllers.forEach((controller) => controller.abort(abortError(signal?.reason)));
          if (signal?.aborted) cancelAll();
          else signal?.addEventListener("abort", cancelAll, { once: true });
          // Each copy is watched by the next one: with little buffered, a second copy that
          // trickles like the first gets a third.
          const watches = controllers.map(() => ({ bytes: 0 }));
          const attempts = controllers.map((controller, copy) => (async () => {
            if (copy && !race) {
              await overdue(watches[copy - 1], piece, resolver, settings, startup, controller.signal);
              if (controller.signal.aborted) throw abortError(controller.signal.reason);
              if (!watches[copy - 1].failed) counters.copies += 1;
            }
            const copyPriority = copy && !race ? () => (startup || !urgent || urgent() ? priority + 20 : priority - 100) : priority;
            return attempt(piece, choose, controller.signal, kind, resolver, copyPriority, race ? null : watches[copy]);
          })());
          const cancelCopies = () => {
            signal?.removeEventListener("abort", cancelAll);
            controllers.forEach((controller) => {
              if (!controller.signal.aborted) controller.abort(new DOMException(DUPLICATE_CANCELED, "AbortError"));
            });
          };
          try {
            const winner = await Promise.any(attempts);
            // The other nodes of that first race get a moment to finish their 64 KiB, so that
            // each of them has been measured once. Nodes are not raced again on this page.
            if (race) setTimeout(cancelCopies, 1500);
            else cancelCopies();
            return winner;
          } catch (aggregate) {
            const errors = aggregate?.errors || [aggregate];
            lastError = errors.find((error) => error?.message !== NO_ADDRESS) || errors.at(-1);
            signal?.removeEventListener("abort", cancelAll);
            if (signal?.aborted) throw abortError(signal.reason);
          }
          if (tried.size === before) break;
        }
      }
      throw lastError || new Error(NO_ADDRESS);
    }

    async function delayedAttempt(piece, url, delayMs, signal, kind, resolver, controller, priority = 0) {
      if (delayMs > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          const canceled = () => {
            clearTimeout(timer);
            reject(abortError(controller.signal.reason));
          };
          if (controller.signal.aborted) canceled();
          else controller.signal.addEventListener("abort", canceled, { once: true });
        });
      }
      if (signal?.aborted) throw abortError(signal.reason);
      return attempt(piece, () => url, controller.signal, kind, resolver, priority);
    }

    async function startupAttempt(piece, candidates, resolver, options) {
      const controllers = candidates.map(() => new AbortController());
      const cancelAll = () => controllers.forEach((controller) => {
        if (!controller.signal.aborted) controller.abort(abortError(options.signal?.reason));
      });
      if (options.signal?.aborted) cancelAll();
      else options.signal?.addEventListener("abort", cancelAll, { once: true });
      try {
        let winner;
        try {
          // The copies used to follow after 120 and 300 ms whatever the node. A node that
          // usually needs longer than that for its first byte got all three every time.
          const step = Math.min(600, Math.max(120, (resolver.nodes?.ttfbMs(candidates[0]) || 0) * 1.5));
          winner = await Promise.any(candidates.map((url, index) => delayedAttempt(
            piece,
            url,
            index === 0 ? 0 : index === 1 ? step : step * 2.5,
            options.signal,
            options.kind || "meta",
            resolver,
            controllers[index],
            220
          )));
        } catch (aggregate) {
          if (options.signal?.aborted) throw abortError(options.signal.reason);
          throw aggregate?.errors?.at?.(-1) || aggregate;
        }
        controllers.forEach((controller) => {
          if (!controller.signal.aborted) controller.abort(new DOMException("并发副本已取消", "AbortError"));
        });
        return winner;
      } finally {
        options.signal?.removeEventListener("abort", cancelAll);
      }
    }

    async function downloadStartupRange(range, resolver, options) {
      semaphore.setLimit(core.normalizeSettings(getSettings()).concurrency);
      const piece = { index: 0, start: range.start, end: range.end, length: range.length };
      const startedAt = performance.now();
      let lastError = null;
      // The addresses that just failed are backing off by the next round, so each round
      // moves on to the next three.
      for (let round = 0; round < PIECE_ROUNDS; round += 1) {
        if (round) {
          if (performance.now() - startedAt > PIECE_RETRY_WINDOW_MS) break;
          await pause(Math.min(2000, 500 * (2 ** (round - 1))), options.signal);
        }
        let candidates = (typeof resolver.startupCandidates === "function" ? resolver.startupCandidates() : resolver.urls())
          .filter((url, index, all) => all.indexOf(url) === index);
        if (typeof resolver.pick === "function") {
          const chosen = new Set();
          while (chosen.size < 3) {
            const url = resolver.pick(candidates, chosen, piece.length);
            if (!url) break;
            chosen.add(url);
          }
          candidates = [...chosen];
        } else candidates = candidates.slice(0, 3);
        if (!candidates.length && round) candidates = resolver.ordered(round).slice(0, 3);
        if (!candidates.length) break;
        try {
          const winner = await startupAttempt(piece, candidates, resolver, options);
          return {
            bytes: winner.bytes,
            pieceCount: 1,
            total: winner.total || null,
            hosts: [new URL(winner.url).hostname]
          };
        } catch (error) {
          if (options.signal?.aborted) throw abortError(options.signal.reason);
          lastError = error;
        }
      }
      throw lastError || new Error("没有可用 CDN");
    }

    // The second copy of a piece is urgent when that piece is the one holding up the append,
    // or one of the last few its range is waiting for.
    function trackPieces(count) {
      const finished = new Array(count).fill(false);
      let first = 0;
      let left = count;
      return {
        finish(index) {
          if (finished[index]) return;
          finished[index] = true;
          left -= 1;
          while (finished[first]) first += 1;
        },
        urgent: (index) => index <= first || left <= Math.max(2, count >> 3)
      };
    }

    async function downloadStartupMediaRange(range, resolver, options, settings) {
      const effectiveConcurrency = settings.concurrency;
      semaphore.setLimit(effectiveConcurrency);
      const candidateUrls = (typeof resolver.rangeCandidates === "function" ? resolver.rangeCandidates() : resolver.urls())
        .filter((url, index, all) => all.indexOf(url) === index);
      const headLength = Math.min(range.length, Math.max(64 * 1024, settings.minChunkBytes));
      const head = {
        index: 0,
        start: range.start,
        end: range.start + headLength - 1,
        length: headLength
      };
      // The head goes first and alone so that every node is raced once. With the nodes known
      // already it is only one more round trip before the rest may start, so it is left out.
      const warm = candidateUrls.some((url) => resolver.nodes?.known(url));
      const headResult = warm ? null : await downloadPiece(
        head,
        resolver,
        options.signal,
        options.kind || "media",
        candidateUrls,
        "probe",
        220
      );
      if (headResult) await options.onOrderedChunk(headResult.bytes, head);
      if (headResult && head.end >= range.end) {
        options.onStartupScheduled?.();
        return {
          bytes: null,
          byteLength: range.length,
          pieceCount: 1,
          streamed: true,
          total: headResult.total || null,
          hosts: [new URL(headResult.url).hostname]
        };
      }

      const rescueReserve = Math.max(1, Math.min(16, Math.ceil(effectiveConcurrency / 8)));
      const mediaBudget = Math.max(1, effectiveConcurrency - rescueReserve);
      const audioBudget = Math.max(1, Math.min(mediaBudget, Math.ceil(effectiveConcurrency / 8)));
      const pieceBudget = options.kind === "audio"
        ? audioBudget
        : Math.max(1, mediaBudget - audioBudget);
      const pieces = core.splitRange(
        headResult ? head.end + 1 : range.start,
        range.end,
        pieceBudget,
        settings.minChunkBytes
      ).map((piece, index) => ({ ...piece, index: index + (headResult ? 1 : 0) }));
      const ordered = new Array(pieces.length);
      const progress = trackPieces(pieces.length);
      let nextOrderedIndex = 0;
      let flushOperation = Promise.resolve();
      const flushOrdered = () => {
        flushOperation = flushOperation.then(async () => {
          while (ordered[nextOrderedIndex]) {
            const item = ordered[nextOrderedIndex];
            ordered[nextOrderedIndex] = null;
            await options.onOrderedChunk(item.bytes, pieces[nextOrderedIndex]);
            nextOrderedIndex += 1;
          }
        });
        return flushOperation;
      };
      const pendingPieces = pieces.map(async (piece, orderedIndex) => {
        const result = await downloadPiece(
          piece,
          resolver,
          options.signal,
          options.kind || "media",
          headResult ? [headResult.url] : candidateUrls,
          true,
          120 - Math.min(30, piece.index),
          () => progress.urgent(orderedIndex)
        );
        progress.finish(orderedIndex);
        ordered[orderedIndex] = result;
        await flushOrdered();
        return result;
      });
      options.onStartupScheduled?.();
      const results = await Promise.all(pendingPieces);
      await flushOperation;
      const parts = [headResult, ...results].filter(Boolean);
      const totals = parts.map((item) => item.total).filter(Number.isSafeInteger);
      if (totals.length && totals.some((value) => value !== totals[0])) throw new Error("不同 CDN 返回的文件总长度不一致");
      return {
        bytes: null,
        byteLength: range.length,
        pieceCount: parts.length,
        streamed: true,
        total: totals[0] || null,
        hosts: [...new Set(parts.map((item) => new URL(item.url).hostname))]
      };
    }

    async function downloadRange(range, resolver, options = {}) {
      const settings = core.normalizeSettings(getSettings());
      if (options.kind === "meta") return downloadStartupRange(range, resolver, options);
      const parallel = options.parallel !== false;
      if (options.startup === true && parallel && typeof options.onOrderedChunk === "function") {
        return downloadStartupMediaRange(range, resolver, options, settings);
      }
      const preferredUrls = parallel && typeof resolver.rangeCandidates === "function"
        ? resolver.rangeCandidates()
        : resolver.urls();
      const globalConcurrency = parallel ? settings.concurrency : 1;
      const requestedConcurrency = Number.isFinite(Number(options.maxConcurrency))
        ? Math.max(1, Math.trunc(Number(options.maxConcurrency)))
        : globalConcurrency;
      const effectiveConcurrency = parallel ? Math.min(globalConcurrency, requestedConcurrency) : 1;
      // 后台预取可以限制自己的子块数，但不能降低全局信号量上限；
      // 否则一个低优先级预取会把后续播放器的紧急请求也锁在低并发上。
      semaphore.setLimit(globalConcurrency);
      const basePriority = Number.isFinite(Number(options.priority)) ? Number(options.priority) : 50;
      const rescueReserve = parallel && effectiveConcurrency >= 8
        ? Math.min(8, Math.max(1, Math.ceil(effectiveConcurrency / 8)))
        : 0;
      const pieceConcurrency = options.startup === true
        ? Math.max(1, Math.min(22, effectiveConcurrency))
        : Math.max(1, effectiveConcurrency - rescueReserve);
      const pieces = core.splitRange(
        range.start,
        range.end,
        pieceConcurrency,
        // Right after a seek every node is slow over a part of the file it has not served
        // lately, each in its own way: one takes a second or more for the first byte, another
        // answers at once and then trickles. Many small requests get through that best. Once a
        // few segments are buffered, larger pieces save round trips and requests.
        !parallel ? Number.MAX_SAFE_INTEGER
          : options.hurry === true ? settings.minChunkBytes
            : resolver.pieceBytes?.(settings.minChunkBytes) || settings.minChunkBytes
      );
      const progressive = typeof options.onOrderedChunk === "function";
      const progress = trackPieces(pieces.length);
      const ordered = new Array(pieces.length);
      let nextOrderedIndex = 0;
      let flushOperation = Promise.resolve();
      const flushOrdered = () => {
        flushOperation = flushOperation.then(async () => {
          while (ordered[nextOrderedIndex]) {
            const item = ordered[nextOrderedIndex];
            ordered[nextOrderedIndex] = null;
            await options.onOrderedChunk(item.bytes, pieces[nextOrderedIndex]);
            nextOrderedIndex += 1;
          }
        });
        return flushOperation;
      };
      const results = await Promise.all(pieces.map(async (piece) => {
        const result = await downloadPiece(
          piece,
          resolver,
          options.signal,
          options.kind || "media",
          preferredUrls,
          options.startup === true || options.hurry === true,
          basePriority - Math.min(20, piece.index),
          () => progress.urgent(piece.index)
        );
        progress.finish(piece.index);
        if (progressive) {
          ordered[piece.index] = result;
          await flushOrdered();
        }
        return result;
      }));
      if (progressive) await flushOperation;
      const totals = results.map((item) => item.total).filter(Number.isSafeInteger);
      if (totals.length && totals.some((value) => value !== totals[0])) throw new Error("不同 CDN 返回的文件总长度不一致");
      return {
        bytes: progressive ? null : core.concatChunks(results.map((item) => item.bytes), range.length),
        byteLength: range.length,
        pieceCount: pieces.length,
        streamed: progressive,
        total: totals[0] || null,
        hosts: [...new Set(results.map((item) => new URL(item.url).hostname))]
      };
    }

    return Object.freeze({ downloadRange, stats: () => ({ ...counters }), recent: () => recent.slice() });
  }

  root.__BILI_IDM_DOWNLOADER_FACTORY__ = Object.freeze({ createDownloader });
})(globalThis);
