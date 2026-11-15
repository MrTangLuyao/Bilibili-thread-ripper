(function installStatsPanel(root) {
  "use strict";

  // BTR 统计信息: BTR's own statistics panel. It lies over the video the way the player's own
  // 视频统计信息 does, shows what BTR is doing with the video in numbers and small graphs, and
  // has nothing to do with BTR's settings. "BTR 统计信息" in the menu of a right click on the
  // player opens and closes it; 运行状态 in the settings panel opens it too. It reads BTR's
  // numbers once a second while it is open, and costs nothing while it is closed.
  // Of Bilibili's page it knows the player's container and the menu of the right click.
  // Where that menu is gone the entry is not there, and nothing else is affected.
  const HOST_ID = "__bilibili_thread_ripper_stats__";
  const NAME = "BTR 统计信息";
  // The graphs go back a minute. A node's speed is what it brought in ten seconds.
  const HISTORY = 60;
  const NODE_WINDOW = 10;
  const NODE_ROWS = 16;
  const WIDTH = 180;
  const HEIGHT = 14;
  const CODECS = [[/^av01|^av1/i, "AV1"], [/^hev1|^hvc1|^hevc/i, "HEVC"], [/^avc/i, "AVC"]];
  // The rows from top to bottom, and the drawing in front of the value of some.
  const ROWS = [["接管方式"], ["画面"], ["平均码率"], ["当前码率"], ["分段", "meter"], ["丢帧"], ["卡顿"], ["加速"], ["失败"], ["二级缓冲"], ["下载速度", "graph"], ["缓冲", "graph"], ["线程", "cells"]];

  // The look is that of the player's own 视频统计信息 panel, as measured on the page: its
  // surface, its distance from the corner, its title bar, its rows of 12 px text with a column
  // of names 100 px wide. Everything has a fixed width and every row a fixed height, so a
  // number that changes moves nothing. The pink is BTR's.
  const CSS = `
    .layer { width: 100%; height: 100%; container-type: size; }
    .panel { position: absolute; top: 10px; left: 10px; box-sizing: border-box; width: 596px; max-width: calc(100% - 20px); max-height: calc(100% - 80px); overflow: auto; padding-bottom: 15px; border-radius: 4px; background: rgba(33, 33, 33, .9); color: #fff; font: 12px/18px -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; text-align: left; pointer-events: auto; user-select: none; -webkit-user-select: none; scrollbar-width: thin; }
    /* No room for it in the mini player. */
    @container (max-width: 480px) or (max-height: 260px) { .panel { display: none; } }
    h2 { margin: 0; border-bottom: 1px solid rgba(255, 255, 255, .1); font-size: 16px; font-weight: 400; line-height: 40px; text-align: center; }
    .close { position: absolute; top: 10px; right: 10px; width: 22px; height: 22px; padding: 5px; border: 0; background: transparent; color: #fff; cursor: pointer; }
    .close svg { display: block; width: 12px; height: 12px; }
    .rows { padding: 15px 26px 0; }
    .row { display: flex; align-items: center; height: 18px; }
    [hidden] { display: none !important; }
    .name { flex: none; width: 100px; margin-right: 10px; font-weight: 500; text-align: right; }
    .text, .node { overflow: hidden; color: #999; white-space: nowrap; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
    .graph, .meter, .cells { flex: none; width: ${WIDTH}px; margin-right: 10px; }
    /* The nodes side by side in two columns, which keeps the panel a rectangle like the
       player's own. */
    .nodes { align-items: flex-start; height: auto; }
    .grid { display: grid; grid-template-columns: repeat(2, 210px); column-gap: 14px; }
    .grid div { display: flex; align-items: center; height: 18px; }
    .node { flex: none; width: 100px; margin-right: 6px; }
    .node + .meter { width: 40px; margin-right: 6px; }
    .graph { height: ${HEIGHT}px; overflow: visible; }
    .graph line { stroke: rgba(255, 255, 255, .6); }
    .graph polyline { fill: none; stroke: #fb7299; stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; }
    /* A meter fills from the left, the cell of a thread from the bottom. */
    .meter, .cells i { position: relative; overflow: hidden; background: rgba(255, 255, 255, .16); }
    .meter::after, .cells i::after { content: ""; position: absolute; bottom: 0; left: 0; background: #fb7299; }
    .meter { height: 4px; border-radius: 2px; }
    .meter::after { width: calc(100% * var(--at, 0)); height: 100%; }
    .cells { display: flex; gap: 1px; height: 12px; overflow: hidden; }
    .cells.many { gap: 0; }
    .cells i { flex: 1 1 0; max-width: 4px; height: 100%; }
    .cells i::after { width: 100%; height: calc(100% * var(--at, 0)); }
  `;

  const speedText = (bytes) => root.__BILI_RANGE_CORE__.formatSpeed(bytes);
  const megabits = (bits) => `${(bits / 1e6).toFixed(1)} Mbps`;
  const element = (tag, className, ...children) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.append(...children);
    return node;
  };
  const drawn = (tag, attributes, ...children) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    node.append(...children);
    return node;
  };
  // What only changes when it differs: a text, how far a meter or a cell is filled.
  const say = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const fill = (node, share) => node.style.setProperty("--at", Math.max(0, Math.min(1, share || 0)).toFixed(3));
  // As many children as there are items, each written by `write`.
  function each(parent, items, create, write) {
    while (parent.children.length > items.length) parent.lastElementChild.remove();
    while (parent.children.length < items.length) parent.append(create());
    items.forEach((item, index) => write(parent.children[index], item, index));
  }
  // The last minute as a line over its baseline.
  function draw(graph, values, floor) {
    const top = Math.max(floor, ...values);
    graph.lastChild.setAttribute("points", values.map((value, index) => `${(WIDTH - (values.length - 1 - index) * WIDTH / (HISTORY - 1)).toFixed(1)},${(HEIGHT - 1 - value / top * (HEIGHT - 2)).toFixed(1)}`).join(" "));
  }

  let read = null, host = null, rows = null, timer = 0;
  let speeds = [], buffers = [], recent = [], order = [], seen = null, lookedAt = 0, route = null;
  const playerOf = (node) => (node instanceof Element && node.closest(".bpx-player-container")) || document.querySelector(".bpx-player-container");

  function close() {
    clearInterval(timer);
    host?.remove();
    host = null;
  }

  // Opens over the player of the page. False where there is none, or BTR is switched off.
  function open(container = playerOf()) {
    if (!container || !read?.()) return false;
    close();
    host = document.createElement("div");
    host.id = HOST_ID;
    // Where the player's own panel is: over the video and what lies on it, under the menu of
    // a right click. The panel leaves the controls at the bottom free.
    host.style.cssText = "all:initial!important;position:absolute!important;inset:0!important;z-index:80!important;pointer-events:none!important;";
    const shut = element("button", "close", drawn("svg", { viewBox: "0 0 12 12", "aria-hidden": "true" }, drawn("path", { d: "M1 1l10 10M11 1L1 11", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round" })));
    shut.type = "button";
    shut.setAttribute("aria-label", "关闭");
    shut.addEventListener("click", close);
    rows = { list: element("div", "rows"), idle: element("div", "text", "这个视频现在由 B 站自己的播放器播放。"), nodes: element("div", "grid") };
    for (const [name, kind] of ROWS) {
      const part = kind === "graph" ? drawn("svg", { class: "graph" }, drawn("line", { x1: 0, x2: WIDTH, y1: HEIGHT - .5, y2: HEIGHT - .5 }), drawn("polyline", {}))
        : kind ? element(kind === "meter" ? "i" : "span", kind) : null;
      const text = element("span", "text");
      rows[name] = { line: element("div", "row", element("span", "name", `${name}:`), ...(part ? [part] : []), text), part, text };
      rows.list.append(rows[name].line);
    }
    rows.list.append(element("div", "row nodes", element("span", "name", "节点:"), rows.nodes));
    const panel = element("section", "panel", element("h2", "", NAME), shut, element("div", "rows", rows.idle), rows.list);
    panel.setAttribute("aria-label", NAME);
    rows.idle.parentElement.hidden = true;
    host.attachShadow({ mode: "open" }).append(element("style", "", CSS), element("div", "layer", panel));
    seen = null;
    route = null;
    (container.querySelector(".bpx-player-video-area") || container).append(host);
    look();
    timer = setInterval(look, 1000);
    return true;
  }

  // One look at BTR's numbers. Only what has changed is written.
  function look() {
    const data = host?.isConnected ? read() : null;
    if (!data) { close(); return; }
    const { stats, settings, debug } = data;
    const now = performance.now();
    // Another video (and the first look): its minute and its nodes start anew.
    if (data.route !== route) {
      route = data.route;
      speeds = [];
      buffers = [];
      recent = [];
      order = [];
    }
    // What every node brought since the last look: together, the download speed. The first
    // look only notes where the counters stand.
    if (seen) {
      const fresh = [...data.received].map(([name, total]) => [name, total - (seen.get(name) || 0)]).filter(([, bytes]) => bytes > 0);
      const elapsed = Math.max(.25, (now - lookedAt) / 1000);
      speeds = speeds.concat(fresh.reduce((sum, [, bytes]) => sum + bytes, 0) / elapsed).slice(-HISTORY);
      buffers = buffers.concat(Math.max(0, Number(stats.bufferedAhead) || 0)).slice(-HISTORY);
      recent = recent.concat({ elapsed, fresh }).slice(-NODE_WINDOW);
    }
    seen = new Map(data.received);
    lookedAt = now;
    rows.idle.parentElement.hidden = data.playing;
    rows.list.hidden = !data.playing;
    if (!data.playing) return;

    // A row is there while it has a value.
    const write = (name, text) => {
      rows[name].line.hidden = text === undefined;
      if (text !== undefined) say(rows[name].text, text);
    };
    const full = data.takeover === "full";
    const codec = CODECS.find(([pattern]) => pattern.test(String(debug.codec || "")))?.[1];
    const track = (debug.tracks || []).find((item) => item.kind === "video");
    write("接管方式", full ? "全接管" : "兼容模式");
    write("画面", debug.width && debug.height ? `${debug.width} x ${debug.height}${debug.frameRate ? `@${Number(Number(debug.frameRate).toFixed(3))}` : ""}${codec ? ` [${codec}]` : ""}` : undefined);
    // The average of the whole video, and the half minute that is about to be played.
    write("平均码率", debug.videoBandwidth ? megabits(debug.videoBandwidth) : undefined);
    write("当前码率", debug.videoKbpsAhead ? megabits(debug.videoKbpsAhead * 1000) : undefined);
    write("分段", track?.segments ? `${track.nextIndex} / ${track.segments}` : undefined);
    if (track?.segments) fill(rows["分段"].part, track.nextIndex / track.segments);
    write("丢帧", data.frames ? `${data.frames.droppedVideoFrames} / ${data.frames.totalVideoFrames}` : undefined);
    write("卡顿", full ? `${Number(debug.underflowRebuffers) || 0} 次` : undefined);
    write("加速", full ? undefined : `${Number(debug.acceleratedRanges) || 0} 次`);
    write("失败", full ? undefined : `${Number(debug.failedRanges) || 0} 次`);
    write("二级缓冲", settings.secondaryBuffer && debug.reserve ? `${Math.round(debug.reserve.seconds)} 秒 [${Math.round(debug.reserve.bytes / 1048576)} MB]` : undefined);
    write("下载速度", speedText(speeds.at(-1) ?? stats.totalSpeedBps));
    draw(rows["下载速度"].part, speeds, 1);
    // The compatibility mode leaves how far to buffer to Bilibili's player.
    const target = full ? Number(debug.bufferAheadLimit) || Number(settings.bufferAheadSeconds) || 0 : 0;
    write("缓冲", `${Math.round(Number(stats.bufferedAhead) || 0)}${target ? ` / ${target}` : ""} 秒`);
    draw(rows["缓冲"].part, buffers, Math.max(1, target));
    const threads = (stats.threadSpeeds || []).filter((item) => item.state === "active" && item.kind !== "meta");
    const limit = settings.autoConcurrency ? Number(stats.autoThreads) || 0 : Number(settings.concurrency) || 0;
    write("线程", `${threads.length}${limit ? ` / ${limit}` : ""}`);
    rows["线程"].part.classList.toggle("many", threads.length > 36);
    each(rows["线程"].part, threads, () => element("i", ""), (cell, item) => fill(cell, item.totalBytes > 0 ? item.loaded / item.totalBytes : 0));

    // The nodes, each in the place it first took, so that no row moves: the ones BTR knows
    // for this video, then any other that brought something. One that is neither any more
    // (the video before this one had it) leaves the list.
    const brought = new Map();
    for (const item of recent) for (const [name, bytes] of item.fresh) brought.set(name, (brought.get(name) || 0) + bytes);
    const span = recent.reduce((sum, item) => sum + item.elapsed, 0);
    const refused = new Set((stats.cdnHosts || []).filter((item) => ["blocked", "banned"].includes(item.state)).map((item) => item.host));
    const known = (stats.cdnHosts || []).map((item) => item.host);
    order = order.filter((name) => known.includes(name) || brought.has(name));
    for (const name of [...known, ...brought.keys()]) if (!order.includes(name)) order.push(name);
    const most = Math.max(1, ...brought.values());
    rows.nodes.parentElement.hidden = !order.length;
    each(rows.nodes, order.slice(0, NODE_ROWS), () => element("div", "", element("span", "node"), element("i", "meter"), element("span", "text")), (cell, name) => {
      say(cell.children[0], name.split(".")[0].replace(/^upos-/, ""));
      cell.children[0].title = name;
      fill(cell.children[1], (brought.get(name) || 0) / most);
      say(cell.children[2], refused.has(name) && !brought.get(name) ? "已屏蔽" : speedText(span ? (brought.get(name) || 0) / span : 0));
    });
  }

  function install(nextRead) {
    read = nextRead;
    // Bilibili's player builds the menu of a right click anew every time; the entry is added
    // once it has, and a menu the entry pushes out of the player is moved up.
    document.addEventListener("contextmenu", (event) => {
      const container = event.target instanceof Element ? event.target.closest(".bpx-player-container") : null;
      if (!container || !read()) return;
      const add = () => {
        const menu = container.querySelector(".bpx-player-contextmenu");
        if (!menu?.children.length || menu.querySelector("[data-btr-stats]")) return;
        const entry = element("li", "", NAME);
        entry.dataset.btrStats = "";
        // On the press, not on the click: the player takes its menu away a moment after the
        // press, and a button held a little longer is released on the video. No click then.
        entry.addEventListener("mousedown", (pressed) => {
          if (pressed.button !== 0) return;
          if (host?.isConnected) close();
          else open(container);
        });
        menu.append(entry);
        const over = menu.getBoundingClientRect().bottom - container.getBoundingClientRect().bottom;
        if (over > 0 && menu.style.top.endsWith("px")) menu.style.top = `${parseFloat(menu.style.top) - over}px`;
      };
      setTimeout(add, 0);
      setTimeout(add, 80);
    }, true);
  }

  root.__BILI_STATS_PANEL__ = Object.freeze({ install, open, close, available: () => Boolean(read && playerOf()) });
})(globalThis);
