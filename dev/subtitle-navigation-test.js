(async function runSubtitleNavigationTest(root) {
  "use strict";

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const OLD_BVID = "BV1oldRoute01";
  const NEW_BVID = "BV1newRoute02";
  const result = document.getElementById("subtitle-navigation-result");
  const viewRequests = [];

  function makeArt(label) {
    const controlsRight = document.createElement("div");
    document.body.append(controlsRight);
    const switches = [];
    return {
      label,
      switches,
      template: { $controlsRight: controlsRight },
      notice: { show: "" },
      controls: {
        add(option) {
          const control = document.createElement("div");
          control.className = `art-control-btr-${option.name.replace(/^btr-/, "")}`;
          control.innerHTML = `<div class="art-selector-value">${option.html}</div><div class="art-selector-list">${option.selector.map((item) => `<div class="art-selector-item" data-value="${item.value}">${item.html}</div>`).join("")}</div>`;
          controlsRight.append(control);
        }
      },
      subtitle: {
        async switch(url) {
          switches.push({ route: location.pathname, vtt: await fetch(url).then((response) => response.text()) });
        }
      }
    };
  }

  root.addEventListener("message", (event) => {
    if (event.source !== root || event.data?.channel !== CHANNEL || event.data?.type !== "subtitle-request") return;
    const match = /(101|202)-(zh|en)\.json/.exec(String(event.data.url));
    const cid = match?.[1] || "unknown";
    const language = String(match?.[2] || "unknown").toUpperCase();
    root.postMessage({
      channel: CHANNEL,
      type: "subtitle-response",
      requestId: event.data.requestId,
      payload: { ok: true, text: JSON.stringify({ body: [{ from: 0, to: 5, content: `CID-${cid}-${language}` }] }) }
    }, "*");
  });

  async function nativeFetch(input) {
    const url = new URL(String(input), location.href);
    if (url.pathname === "/x/web-interface/view") {
      const bvid = url.searchParams.get("bvid") || "";
      viewRequests.push(bvid);
      if (bvid === OLD_BVID) await new Promise((resolve) => setTimeout(resolve, 120));
      const cid = bvid === OLD_BVID ? 101 : 202;
      return new Response(JSON.stringify({ code: 0, data: { aid: cid, bvid, cid, pages: [{ cid }] } }), { status: 200 });
    }
    if (url.pathname === "/x/player/v2") {
      const cid = Number(url.searchParams.get("cid"));
      const bvid = cid === 101 ? OLD_BVID : NEW_BVID;
      return new Response(JSON.stringify({ code: 0, data: { aid: cid, bvid, cid, subtitle: { subtitles: [
        { id: `${cid}-zh`, lan: "zh-Hans", lan_doc: "中文（简体）", subtitle_url: `https://aisubtitle.hdslb.com/${cid}-zh.json` },
        { id: `${cid}-en`, lan: "en-US", lan_doc: "英语（美国）", subtitle_url: `https://aisubtitle.hdslb.com/${cid}-en.json` }
      ] } } }), { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  }

  history.replaceState(null, "", `/video/${OLD_BVID}`);
  root.__INITIAL_STATE__ = { videoData: { bvid: OLD_BVID, cid: 101 } };
  const oldArt = makeArt("old");
  const oldController = root.__BILI_SUBTITLE_FACTORY__.attach({
    art: oldArt,
    nativeFetch,
    identity: { bvid: OLD_BVID, part: 1 },
    preference: "zh-Hans"
  });

  await new Promise((resolve) => setTimeout(resolve, 15));
  history.pushState(null, "", `/video/${NEW_BVID}`);
  root.__INITIAL_STATE__.videoData.bvid = NEW_BVID;
  root.__INITIAL_STATE__.videoData.cid = 101;
  await oldController.ready;

  const newArt = makeArt("new");
  const newController = root.__BILI_SUBTITLE_FACTORY__.attach({
    art: newArt,
    nativeFetch,
    identity: { bvid: NEW_BVID, part: 1 },
    preference: "zh-Hans"
  });
  await newController.ready;
  newArt.switches.length = 0;
  await Promise.all([
    newController.select("zh-Hans", false),
    newController.select("en-US", false)
  ]);

  const mismatchArt = makeArt("mismatch");
  const mismatchController = root.__BILI_SUBTITLE_FACTORY__.attach({
    art: mismatchArt,
    identity: { bvid: NEW_BVID, part: 1 },
    preference: "zh-Hans",
    nativeFetch: async (input, init) => {
      const url = new URL(String(input), location.href);
      if (url.pathname !== "/x/player/v2") return nativeFetch(input, init);
      return new Response(JSON.stringify({ code: 0, data: {
        aid: 101,
        bvid: OLD_BVID,
        cid: 101,
        subtitle: { subtitles: [{
          id: "stale",
          lan: "zh-Hans",
          lan_doc: "上一条视频的字幕",
          subtitle_url: "https://aisubtitle.hdslb.com/101-zh.json"
        }] }
      } }), { status: 200 });
    }
  });
  await mismatchController.ready;

  const output = {
    oldSwitches: oldArt.switches,
    newSwitches: newArt.switches,
    mismatchSwitches: mismatchArt.switches,
    viewRequests,
    mixedGlobalState: { bvid: root.__INITIAL_STATE__.videoData.bvid, cid: root.__INITIAL_STATE__.videoData.cid },
    normalizedBreaks: root.__BILI_SUBTITLE_FACTORY__.subtitleJsonToVtt({ body: [
      { from: 0, to: 1, content: "第一行\\NSecond line" },
      { from: 1, to: 2, content: "第三行<br>Fourth line" }
    ] })
  };
  output.pass = oldArt.switches.length === 0
    && newArt.switches.length === 1
    && mismatchArt.switches.length === 0
    && newArt.switches[0].vtt.includes("CID-202-EN")
    && !newArt.switches[0].vtt.includes("CID-101");
  output.pass = output.pass
    && output.normalizedBreaks.includes("第一行\nSecond line")
    && output.normalizedBreaks.includes("第三行\nFourth line");
  result.textContent = JSON.stringify(output);
  oldController.destroy();
  newController.destroy();
  mismatchController.destroy();
})(globalThis);
