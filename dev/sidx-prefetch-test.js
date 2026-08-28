(async function runSidxPrefetchTest(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const test = root.__btrSidxTest;
  const resultNode = document.getElementById("sidx-prefetch-result");
  root.postMessage({ channel: CHANNEL, type: "settings", payload: { enabled: true, mode: "mainland", concurrency: 32 } }, "*");
  await new Promise((resolve) => setTimeout(resolve, 50));

  const indexEnd = test.indexStart + test.sidxLength - 1;
  const indexResponse = await fetch(test.mediaUrl, { headers: { Range: `bytes=${test.indexStart}-${indexEnd}` } });
  await indexResponse.arrayBuffer();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const afterIndex = root.__biliThreadRipperDebug.getStats();

  function validSegment(bytes, start) {
    const positions = [0, 1, Math.floor(bytes.length / 2), bytes.length - 1];
    return positions.every((offset) => bytes[offset] === (start + offset) % 251);
  }

  const served = [];
  for (let index = 0; index < 3; index += 1) {
    const start = test.firstSegmentStart + index * test.segmentLength;
    const end = start + test.segmentLength - 1;
    const response = await fetch(test.mediaUrl, { headers: { Range: `bytes=${start}-${end}` } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    served.push({ index, length: bytes.byteLength, valid: validSegment(bytes, start) });
  }

  const video = document.querySelector("video");
  const seekStart = test.firstSegmentStart + 6 * test.segmentLength;
  const seekEnd = seekStart + 2 * test.segmentLength - 1;
  test.probe.slowUntil = Date.now() + 3300;
  video.dispatchEvent(new Event("seeking", { bubbles: true }));
  const seekStartedAt = performance.now();
  const seekResponsePromise = fetch(test.mediaUrl, { headers: { Range: `bytes=${seekStart}-${seekEnd}` } });
  await new Promise((resolve) => setTimeout(resolve, 3075));
  const seekNotice = document.getElementById("__bilibili_thread_ripper_slow_start_notice__")?.textContent || "";
  const seekResponse = await seekResponsePromise;
  const seekBytes = new Uint8Array(await seekResponse.arrayBuffer());
  const seekElapsed = Math.round(performance.now() - seekStartedAt);
  video.dispatchEvent(new Event("canplay", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const seekNoticeCleared = !document.getElementById("__bilibili_thread_ripper_slow_start_notice__");

  await new Promise((resolve) => setTimeout(resolve, 150));
  const debug = root.__biliThreadRipperDebug.getStats();
  const output = {
    architecture: debug.architecture,
    served,
    seek: {
      elapsed: seekElapsed,
      length: seekBytes.byteLength,
      valid: validSegment(seekBytes, seekStart),
      notice: seekNotice,
      noticeCleared: seekNoticeCleared
    },
    networkRequests: test.probe.requests,
    maximumNetworkConcurrency: test.probe.maxActive,
    nativeRangeRequests: debug.nativeRangeRequests,
    prefetchedAfterIndex: afterIndex.prefetchedSegments,
    acceleratedRequests: debug.acceleratedRequests,
    parallelSubrequests: debug.parallelSubrequests,
    nativeRaceWins: debug.nativeRaceWins,
    parallelRaceWins: debug.parallelRaceWins,
    prefetchedSegments: debug.prefetchedSegments,
    prefetchHits: debug.prefetchHits,
    prefetchMisses: debug.prefetchMisses,
    cachedBytes: debug.cachedBytes,
    lastError: debug.lastError
  };
  output.pass = served.length === 3
    && output.architecture === "bilibili-native-player-idm-sidx-prefetch"
    && served.every((item) => item.length === test.segmentLength && item.valid)
    // SIDX 索引本身由原生请求直通并旁路解析，因此只统计 4 个大媒体 Range。
    && output.nativeRangeRequests === 4
    && output.prefetchedAfterIndex === 0
    && output.maximumNetworkConcurrency <= 32
    && output.maximumNetworkConcurrency >= 16
    && output.parallelSubrequests >= 40
    && output.nativeRaceWins + output.parallelRaceWins >= 1
    && output.prefetchedSegments >= 3
    && output.prefetchHits + output.prefetchMisses === 4
    && output.cachedBytes >= test.segmentLength
    && output.seek.elapsed >= 3000
    && output.seek.length === 2 * test.segmentLength
    && output.seek.valid
    && output.seek.notice.includes("正在重新建立跳转位置")
    && output.seek.noticeCleared
    && !output.lastError;
  resultNode.textContent = JSON.stringify(output);
  resultNode.dataset.pass = String(output.pass);
})(globalThis);
