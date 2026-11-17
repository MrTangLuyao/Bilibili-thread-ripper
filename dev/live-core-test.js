"use strict";
// The live module's logic layer: playlist parsing, P2P URL handling
// and the host pool.
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const SOURCE=path.join(__dirname,"../src");
function load(){
  const context=vm.createContext({URL,console});
  context.globalThis=context;
  context.__now=1e12;
  vm.runInContext("Date.now=()=>globalThis.__now;",context);
  vm.runInContext(fs.readFileSync(path.join(SOURCE,"live-core.js"),"utf8"),context,{filename:"live-core.js"});
  return {live:context.__BILI_LIVE_CORE__,advance:ms=>{context.__now+=ms;}};
}

test("live URL classification and P2P handling",()=>{
  const {live}=load();
  const seg="https://d1--ov-gotcha207.bilivideo.com/live-bvc/123/live_1234_5678/122742541.m4s";
  assert.equal(live.isLiveSegmentUrl(seg),true);
  assert.equal(live.isLiveSegmentUrl("https://example.com/live-bvc/1/a.m4s"),false,"only bilivideo hosts");
  assert.equal(live.isLiveSegmentUrl("https://d1--ov-gotcha207.bilivideo.com/upgcxcode/1/1-1-30080.m4s"),false,"VOD paths are not live segments");
  assert.equal(live.isLivePlaylistUrl("https://d1--ov-gotcha207.bilivideo.com/live-bvc/123/live_1234_5678/index.m3u8?expires=1&len=0"),true);
  assert.equal(live.isP2pUrl("https://xy1x2x3x4xy.mcdn.bilivideo.cn:4483/v1/resource/x.m4s"),true);
  assert.equal(live.isP2pUrl("https://a-b-302ppio.example.com/x"),true);
  assert.equal(live.isP2pUrl(seg),false);
  assert.equal(
    live.unwrapProxyUrl("https://cache.smtcdns.net/d1--cn-gotcha204.bilivideo.com/live-bvc/1/live_1_2/3.m4s?a=1"),
    "https://d1--cn-gotcha204.bilivideo.com/live-bvc/1/live_1_2/3.m4s?a=1"
  );
  assert.equal(live.unwrapProxyUrl(seg),"","ordinary URLs stay untouched");
});

test("live playlist parsing: map, segments, numbers, resolution against the playlist URL",()=>{
  const {live}=load();
  const text=[
    "#EXTM3U","#EXT-X-VERSION:7","#EXT-X-TARGETDURATION:1",
    '#EXT-X-MAP:URI="h1789460289.m4s"',
    "#EXTINF:1.00,","122742541.m4s",
    "#EXTINF:1.00,","122742542.m4s",
    "#EXTINF:0.98,","122742543.m4s",""
  ].join("\n");
  const playlistUrl="https://d1--ov-gotcha207.bilivideo.com/live-bvc/123/live_1_2/index.m3u8?expires=9&sig=a";
  const parsed=live.parseM3u8(text,playlistUrl);
  assert.equal(parsed.mapUrl,"https://d1--ov-gotcha207.bilivideo.com/live-bvc/123/live_1_2/h1789460289.m4s");
  assert.equal(parsed.segments.length,3);
  assert.equal(parsed.segments[0].url,"https://d1--ov-gotcha207.bilivideo.com/live-bvc/123/live_1_2/122742541.m4s");
  assert.equal(parsed.segments[2].duration,0.98);
  assert.equal(parsed.lastNum,122742543);
  assert.equal(live.segmentNumber("122742543.m4s"),122742543);
  assert.equal(live.segmentNumber("h1789460289.m4s"),1789460289);
});

test("the host pool ranks by proof and first-byte time, blocks failures, bans silent nodes",()=>{
  const {live,advance}=load();
  const banned=[];
  const pool=live.createHostPool({onBan:host=>banned.push(host)});
  pool.add("origin.bilivideo.com",true);
  pool.add("cand-a.bilivideo.com");
  pool.add("cand-b.bilivideo.com");
  assert.deepEqual(Array.from(pool.pick(1)),["origin.bilivideo.com"],"the proven origin leads before any measurement");
  assert.deepEqual(Array.from(pool.unproven()).sort(),["cand-a.bilivideo.com","cand-b.bilivideo.com"]);
  // A fast probe on cand-a beats the slower origin.
  pool.success("cand-a.bilivideo.com",80,4e6);
  pool.success("origin.bilivideo.com",900,1e6);
  assert.deepEqual(Array.from(pool.pick(2)),["cand-a.bilivideo.com","origin.bilivideo.com"]);
  // A failure blocks briefly; the pool falls back to the others.
  pool.failure("cand-a.bilivideo.com",1024);
  assert.deepEqual(Array.from(pool.pick(1)),["origin.bilivideo.com"]);
  advance(30000);
  assert.deepEqual(Array.from(pool.pick(1)),["cand-a.bilivideo.com"],"the block expires");
  // Two empty replies ban a node for the stream.
  pool.failure("cand-b.bilivideo.com",0);
  assert.deepEqual(Array.from(banned),[]);
  pool.failure("cand-b.bilivideo.com",0);
  assert.deepEqual(Array.from(banned),["cand-b.bilivideo.com"]);
  advance(60000);
  assert.ok(!pool.pick(3).includes("cand-b.bilivideo.com"),"a banned node stays out even after the block window");
  assert.equal(pool.status().find(s=>s.host==="cand-b.bilivideo.com").state,"banned");
  // A success on a previously banned node lifts the ban (the node recovered).
  pool.success("cand-b.bilivideo.com",50,5e6);
  assert.ok(pool.pick(3).includes("cand-b.bilivideo.com"));
});
