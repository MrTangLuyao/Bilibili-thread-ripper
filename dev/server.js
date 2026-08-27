const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const port = 18763;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".md": "text/plain; charset=utf-8" };
const testBvid = String(process.env.BTR_TEST_BVID || "").trim();
const testCid = Number(process.env.BTR_TEST_CID);

function testConfig() {
  if (!/^BV[0-9A-Za-z]{10}$/.test(testBvid) || !Number.isSafeInteger(testCid) || testCid <= 0) {
    throw new Error("请先设置 BTR_TEST_BVID 和 BTR_TEST_CID 环境变量");
  }
  return { bvid: testBvid, cid: testCid, referer: `https://www.bilibili.com/video/${testBvid}/` };
}

async function proxyJson(url, response) {
  const upstream = await fetch(url, { headers: { Referer: testConfig().referer } });
  response.writeHead(upstream.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(await upstream.text());
}

http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname === "/config") {
      const config = testConfig();
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ bvid: config.bvid, cid: config.cid }));
      return;
    }
    if (url.pathname === "/playinfo") {
      const config = testConfig();
      return proxyJson(`https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(config.bvid)}&cid=${config.cid}&fnval=4048&fnver=0&fourk=1&qn=80`, response);
    }
    if (url.pathname === "/danmaku") {
      const cid = Number(url.searchParams.get("cid"));
      if (!Number.isSafeInteger(cid) || cid <= 0) throw new Error("invalid cid");
      const upstream = await fetch(`https://comment.bilibili.com/${cid}.xml`);
      response.writeHead(upstream.status, { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" });
      response.end(await upstream.text());
      return;
    }
    if (url.pathname === "/media") {
      const targetUrl = new URL(url.searchParams.get("url"));
      if (!/(?:^|\.)(?:bilivideo\.(?:com|cn|net)|akamaized\.net)$/i.test(targetUrl.hostname)) throw new Error("invalid media host");
      const headers = { Referer: testConfig().referer };
      if (request.headers.range) headers.Range = request.headers.range;
      const upstream = await fetch(targetUrl, { headers });
      const outputHeaders = { "Content-Type": upstream.headers.get("content-type") || "application/octet-stream", "Cache-Control": "no-store" };
      for (const name of ["content-range", "content-length", "accept-ranges"]) {
        const value = upstream.headers.get(name);
        if (value) outputHeaders[name] = value;
      }
      response.writeHead(upstream.status, outputHeaders);
      response.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    const relative = url.pathname === "/" ? "dev/harness.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const target = path.resolve(root, relative);
    if (!target.startsWith(`${root}${path.sep}`) || !fs.statSync(target).isFile()) throw new Error("not found");
    response.writeHead(200, { "Content-Type": types[path.extname(target)] || "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(target).pipe(response);
  } catch (error) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(String(error?.message || error));
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`BTR harness http://127.0.0.1:${port}/`);
  if (!testBvid || !Number.isSafeInteger(testCid)) console.log("请先设置 BTR_TEST_BVID 和 BTR_TEST_CID，再打开测试页。");
});
