// From the machine this runs on: do Bilibili's APIs answer, and how fast do its video nodes
// serve the first megabyte of a real video? Prints hosts and numbers only, no signed addresses.
// With GITHUB_ENV set (in a workflow) it also hands BTR_TEST_BVID and BTR_TEST_CID to the steps
// after it, for dev/native-mse-end-test.js. Usage: `node dev/network-probe.mjs` (BTR_TEST_BVID).
import { appendFileSync } from "node:fs";

const bvid = process.env.BTR_TEST_BVID || "BV1T1NZ6xEZZ";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const referer = `https://www.bilibili.com/video/${bvid}/`;
const MAINLAND = ["upos-sz-mirrorali.bilivideo.com", "upos-sz-mirrorhw.bilivideo.com", "upos-sz-mirrorbos.bilivideo.com", "upos-sz-mirror08c.bilivideo.com", "upos-sz-mirrorbd.bilivideo.com", "upos-sz-mirror14b.bilivideo.com", "upos-sz-estgoss.bilivideo.com", "upos-sz-mirrorcos.bilivideo.com", "upos-sz-mirrorcoso1.bilivideo.com"];
const OVERSEAS = ["upos-sz-mirrorcosov.bilivideo.com", "upos-sz-mirroraliov.bilivideo.com", "cn-hk-eq-01-01.bilivideo.com", "cn-hk-eq-01-03.bilivideo.com"];

async function get(url, extraHeaders = {}) {
  const started = performance.now();
  try {
    const response = await fetch(url, { headers: { "User-Agent": UA, Referer: referer, ...extraHeaders }, signal: AbortSignal.timeout(20000) });
    const firstByte = performance.now() - started;
    const body = Buffer.from(await response.arrayBuffer());
    return { status: response.status, firstByteMs: Math.round(firstByte), ms: Math.round(performance.now() - started), body, headers: response.headers };
  } catch (error) {
    return { error: String(error?.cause?.code || error?.name || error), ms: Math.round(performance.now() - started) };
  }
}
const json = (result) => { try { return JSON.parse(result.body.toString("utf8")); } catch (_error) { return null; } };
const line = (...parts) => console.log(parts.join("  "));

const ip = json(await get("https://ipinfo.io/json")) || {};
line("这台机器", [ip.city, ip.region, ip.country, ip.org].filter(Boolean).join(" / ") || "未知");

// The video-info API answers 412 to scripts without a logged-in session, even at home; the
// page list does not, and it carries the cid.
const pages = await get(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`);
const pagesData = json(pages);
line("分 P 列表接口", `HTTP ${pages.status ?? pages.error}`, `code=${pagesData?.code}`, `${pages.ms}ms`);
const cid = pagesData?.data?.[0]?.cid;
if (cid && process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `BTR_TEST_CID=${cid}\nBTR_TEST_BVID=${bvid}\n`);

if (cid) {
  const playurl = await get(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=4048&fnver=0&fourk=1&qn=80`);
  const playData = json(playurl);
  const dash = playData?.data?.dash;
  line("播放地址接口", `HTTP ${playurl.status ?? playurl.error}`, `code=${playData?.code}`, `${playurl.ms}ms`, `给到的清晰度=${playData?.data?.quality}`);
  if (dash) {
    const videos = dash.video || [];
    line("视频轨", videos.map((item) => `${item.id}:${String(item.codecs).split(".")[0]}`).join(" "));
    line("音频轨", (dash.audio || []).map((item) => `${item.id}:${item.codecs}`).join(" "));
    const sample = videos[0];
    const original = [sample.baseUrl || sample.base_url, ...(sample.backupUrl || sample.backup_url || [])];
    line("B 站给的节点", [...new Set(original.map((url) => new URL(url).hostname))].join(" "));
    // Bilibili's own addresses are tried as given (an akamaized.net address carries its own
    // signature); the other nodes get an ordinary address moved onto them, as BTR does.
    const donor = new URL(original.find((url) => !/akamaized|mcdn|mountaintoys/.test(url)) || original[0]);
    const moved = (host) => { const url = new URL(donor); url.hostname = host; return url; };
    const targets = [
      ...original.map((url) => ["B站给的", new URL(url)]),
      ...MAINLAND.map((host) => ["大陆", moved(host)]),
      ...OVERSEAS.map((host) => ["海外", moved(host)])
    ];
    for (const [group, url] of targets) {
      const host = url.hostname;
      const result = await get(url, { Range: "bytes=0-1048575" });
      const mbps = result.body && result.ms ? (result.body.length * 8 / 1e6 / (result.ms / 1000)).toFixed(1) : "-";
      line(`  ${group}`.padEnd(6), host.padEnd(36), result.error ? `出错 ${result.error}` : `HTTP ${result.status}`, `首字节 ${result.firstByteMs ?? "-"}ms`, `1MB 用时 ${result.ms}ms`, `${mbps} Mbps`);
    }
  }
}

