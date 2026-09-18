"use strict";
// A stand-in for the CDN, used by shared-core-test.js. Every node has a first-byte delay, a
// speed per connection, a total it cannot exceed and, for HTTP/1.1 nodes, a number of sockets
// beyond which requests wait. A node with coldTtfbMs answers slowly for a part of the file it
// has not served yet (the first MiB counts as served). All transfers share one client link.
// Nothing here is measured from a real network: it only has to be the same network for every
// scheduler it is given.
function createNetwork({ nodes, linkBps = Infinity, tickMs = 10 }) {
  const active = new Set();
  const waiting = new Map();
  const stats = { requests: 0, sentBytes: 0, canceledBytes: 0, lengths: [], byHost: {} };
  const hostStats = (host) => (stats.byHost[host] ||= { requests: 0, bytes: 0, busy: 0, peak: 0 });
  let last = performance.now();

  const ticker = setInterval(() => {
    const now = performance.now();
    const seconds = (now - last) / 1000;
    last = now;
    const perNode = new Map();
    for (const item of active) perNode.set(item.host, (perNode.get(item.host) || 0) + 1);
    // Max-min share of the client link among transfers that are each capped by their node.
    const limits = [...active].map((item) => ({ item, cap: Math.min(item.node.connBps, (item.node.totalBps || Infinity) / perNode.get(item.host)) }))
      .sort((a, b) => a.cap - b.cap);
    let left = linkBps;
    limits.forEach((entry, index) => {
      entry.rate = Math.min(entry.cap, left / (limits.length - index));
      left -= entry.rate;
    });
    for (const { item, rate } of limits) {
      item.credit += rate * seconds;
      const size = Math.min(item.remaining, Math.floor(item.credit));
      if (size <= 0) continue;
      item.credit -= size;
      const chunk = new Uint8Array(size);
      for (let index = 0; index < size; index += 1) chunk[index] = (item.offset + index) % 251;
      item.offset += size;
      item.remaining -= size;
      item.sent += size;
      stats.sentBytes += size;
      hostStats(item.host).bytes += size;
      item.controller.enqueue(chunk);
      if (!item.remaining) {
        item.controller.close();
        item.finish();
      }
    }
  }, tickMs);

  function socket(host, node, signal) {
    const host_ = hostStats(host);
    const take = () => {
      host_.busy += 1;
      host_.peak = Math.max(host_.peak, host_.busy);
      return () => {
        host_.busy -= 1;
        const next = (waiting.get(host) || []).shift();
        if (next) next();
      };
    };
    if (host_.busy < (node.sockets || Infinity)) return Promise.resolve(take());
    return new Promise((resolve, reject) => {
      const queue = waiting.get(host) || waiting.set(host, []).get(host);
      const enter = () => {
        signal?.removeEventListener("abort", leave);
        resolve(take());
      };
      const leave = () => {
        queue.splice(queue.indexOf(enter), 1);
        reject(signal.reason);
      };
      queue.push(enter);
      signal?.addEventListener("abort", leave, { once: true });
    });
  }

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", leave);
        resolve();
      }, ms);
      const leave = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      if (signal?.aborted) leave();
      else signal?.addEventListener("abort", leave, { once: true });
    });
  }

  async function fetch(url, init = {}) {
    const host = new URL(url).hostname;
    const node = nodes[host];
    const signal = init.signal;
    stats.requests += 1;
    hostStats(host).requests += 1;
    if (signal?.aborted) throw signal.reason;
    if (!node) return new Response("", { status: 503 });
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range).map(Number);
    const blocks = [];
    for (let block = start >> 20; block <= end >> 20; block += 1) blocks.push(block);
    const served = node.served ||= new Set([0]);
    const cold = node.coldTtfbMs && blocks.some((block) => !served.has(block));
    const release = await socket(host, node, signal);
    try {
      await delay(cold ? node.coldTtfbMs : node.ttfbMs, signal);
    } catch (error) {
      release();
      throw error;
    }
    for (const block of blocks) served.add(block);
    stats.lengths.push(end - start + 1);
    let item;
    const body = new ReadableStream({
      start(controller) {
        item = { host, node, controller, offset: start, remaining: end - start + 1, sent: 0, credit: 0, finish: null };
        item.finish = () => {
          active.delete(item);
          signal?.removeEventListener("abort", item.abort);
          release();
        };
        item.abort = () => {
          if (!active.has(item)) return;
          stats.canceledBytes += item.sent;
          item.finish();
          try { controller.error(signal.reason); } catch (_error) {}
        };
        active.add(item);
        signal?.addEventListener("abort", item.abort, { once: true });
      }
    });
    return new Response(body, { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${node.fileBytes || 2 ** 31}` } });
  }

  return { fetch, stats, stop: () => clearInterval(ticker) };
}

// Plays the part of the player: the two index downloads, a startup segment that is appended
// as it arrives, then a window of three segments at a time.
async function watchVideo({ cdn, idm }, network, { representation, mode = "overseas", concurrency = 32, segments = 10, firstSegment = 0, segmentBytes = 3 * 1024 * 1024, nodeStats, bans = cdn.createBanList() }) {
  const resolver = cdn.createResolver(representation, () => mode, bans, nodeStats);
  const downloader = idm.createDownloader({ getSettings: () => ({ concurrency, mode }), nativeFetch: network.fetch });
  const startedAt = performance.now();
  await Promise.all([
    downloader.downloadRange({ start: 0, end: 999, length: 1000 }, resolver, { parallel: false, kind: "meta" }),
    downloader.downloadRange({ start: 1000, end: 4999, length: 4000 }, resolver, { parallel: false, kind: "meta" })
  ]);
  const range = (index) => ({ start: 5000 + (firstSegment + index) * segmentBytes, end: 5000 + (firstSegment + index + 1) * segmentBytes - 1, length: segmentBytes });
  const check = (bytes, start) => {
    for (let index = 0; index < bytes.length; index += 4099) if (bytes[index] !== (start + index) % 251) throw new Error("wrong bytes");
  };
  let appended = 0;
  await downloader.downloadRange(range(0), resolver, {
    parallel: true, kind: "video", startup: true, priority: 120,
    onOrderedChunk: async (bytes, piece) => { check(bytes, piece.start); appended += bytes.length; }
  });
  if (appended !== segmentBytes) throw new Error(`startup segment appended ${appended}/${segmentBytes}`);
  const startupMs = performance.now() - startedAt;
  let next = 1;
  const worker = async () => {
    while (next < segments) {
      const index = next++;
      // Like the player, which hurries until it has a few segments buffered.
      const result = await downloader.downloadRange(range(index), resolver, { parallel: true, kind: "video", priority: 55, hurry: index < 3 });
      check(result.bytes, range(index).start);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return { startupMs, totalMs: performance.now() - startedAt, bans, downloader: downloader.stats?.() || null };
}

module.exports = { createNetwork, watchVideo };
